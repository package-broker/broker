import { jobFences } from '@package-broker/core/platform/job-fences';
import {
  DEFAULT_AUDIT_REJECTION_RETRIES,
  validateAuditSkipAfter,
} from '@package-broker/core/audit/export-state';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { describe, it, expect, vi } from 'vitest';
import type {
  AuditSinkContext,
  AuditSinkDefinition,
  PluginDefinition,
} from '@package-broker/core/plugin';
import { noopObservability } from '@package-broker/core/platform/observability';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer } from './index.js';
import { createNodeAudit } from './audit.js';

vi.mock('@package-broker/core/kernel/kernel', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/kernel')>();
  return {
    ...actual,
    createKernel: (options: Parameters<typeof actual.createKernel>[0]) =>
      actual.createKernel({
        ...options,
        ...(options.observability?.deploymentId === 'runtime-copy'
          ? {
              observability: { ...options.observability, deploymentId: 'kernel-owned' },
            }
          : {}),
      }),
  };
});
vi.mock('@package-broker/core/kernel/registry-audit', async (original) => ({
  ...(await original<typeof import('@package-broker/core/kernel/registry-audit')>()),
  AUDIT_SINKS_AVAILABLE: true,
}));
const seen: Array<
  Parameters<typeof import('@package-broker/core/audit/export').auditExportJob>[1]
> = [];
vi.mock('@package-broker/core/audit/export', async (original) => {
  const actual = await original<typeof import('@package-broker/core/audit/export')>();
  return {
    ...actual,
    auditExportJob: (...args: Parameters<typeof actual.auditExportJob>) => {
      seen.push(args[1]);
      return actual.auditExportJob(...args);
    },
  };
});
function plugin(
  create: (context: AuditSinkContext) => ReturnType<AuditSinkDefinition['create']>,
  destination: AuditSinkDefinition['destination'],
): PluginDefinition {
  return {
    id: 'sink',
    package: '@test/sink',
    apiVersion: 4,
    platforms: ['node'],
    auditSinks: [
      {
        id: 'archive',
        kind: 'custom',
        activation: 'env',
        custody: 'durable',
        sourceIp: 'omit',
        envNames: ['FORMAT'],
        destination,
        skipAfter: 7,
        create,
      },
    ],
  };
}
const env = {
  ARCHIVE_URL: 'https://archive.example.test',
  ARCHIVE_HEADERS: 'Authorization=fixture',
  FORMAT: 'json',
  PB_MASTER_KEY: 'must-stay-hidden',
};
describe('Node sink assembly behind the rollout gate', () => {
  it('creates sinks through the kernel registration and restricts their environment capability', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const create = vi.fn<AuditSinkDefinition['create']>(() => ({
      deliver: async () => ({ outcome: 'retry' as const, code: 'network' as const }),
      frontier: async () => null,
    }));
    const definition = plugin(create, {
      protocol: 'https-json',
      urlEnv: 'ARCHIVE_URL',
      headersEnv: 'ARCHIVE_HEADERS',
    });
    const broker = createNodeServer([definition], {
      executor: database.executor,
      auditEnv: env,
      log: () => {},
      observability: { deploymentId: 'runtime-copy', sink: { emit: () => {} } },
    });
    try {
      const kernel = await broker.ready();
      expect(kernel.registration.audit.sinks[0]!.definition.create).not.toBe(create);
      expect(create).toHaveBeenCalledTimes(1);
      const context = create.mock.calls[0]![0] as AuditSinkContext;
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.deploymentId).toBe('kernel-owned');
      expect(context.env('FORMAT')).toBe('json');
      expect(context.env('ARCHIVE_HEADERS')).toBeUndefined();
      expect(context.env('PB_MASTER_KEY')).toBeUndefined();
      expect(seen.at(-1)).toMatchObject({ rejectionRetries: 7, sourceIp: 'omit' });
    } finally {
      await broker.close();
      await database.close();
    }
  });
  it('requires a configured deployment id for an active sink', async () => {
    const definition = plugin(
      () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
      { protocol: 'https-json', urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
    );
    const broker = createNodeServer([definition], { auditEnv: env, log: () => {} });
    try {
      await expect(broker.ready()).rejects.toThrow(
        'Audit sinks require a configured deployment id',
      );
    } finally {
      await broker.close();
    }
  });
  it('uses the validated webhook rejection default when the definition omits skipAfter', async () => {
    const database = await openMigratedDatabase();
    const original = plugin(
      () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
      { protocol: 'https-json', urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
    );
    const definition = { ...original.auditSinks![0]! };
    delete definition.skipAfter;
    const configured: PluginDefinition = { ...original, auditSinks: [definition] };
    try {
      await createNodeAudit({
        config: { platform: 'node', plugins: [configured] },
        env: (name) => env[name as keyof typeof env],
        executor: database.executor,
        observability: noopObservability,
        deploymentId: 'test',
        generation: 0,
        maxJournalBytes: null,
        telemetryActive: false,
        registration: () => collectRegistrations([configured]),
      });
      expect(DEFAULT_AUDIT_REJECTION_RETRIES).toBe(3);
      expect(() => validateAuditSkipAfter()).not.toThrow();
      expect(seen.at(-1)!.rejectionRetries).toBe(DEFAULT_AUDIT_REJECTION_RETRIES);
    } finally {
      await database.close();
    }
  });
  it('chooses terminal rejection from the OTLP protocol even for a custom sink kind', async () => {
    const database = await openMigratedDatabase();
    const definition = plugin(
      () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
      { protocol: 'otlp-http-json', endpointEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
    );
    try {
      await createNodeAudit({
        config: { platform: 'node', plugins: [definition] },
        env: (name) => env[name as keyof typeof env],
        executor: database.executor,
        observability: noopObservability,
        deploymentId: 'sink-test',
        maxJournalBytes: 67108864,
        generation: 0,
        telemetryActive: false,
        registration: () => collectRegistrations([definition]),
      });
      expect(seen.at(-1)).toMatchObject({ rejectionRetries: 'terminal' });
    } finally {
      await database.close();
    }
  });
});

const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
async function fixture() {
  const database = await openMigratedDatabase({ d1PatternLimit: true });
  const id = ulid();
  await createOrganizationBootstrap(database.executor).bootstrap({
    id,
    slug: 'audit',
    name: 'Audit',
    now: new Date().toISOString(),
  });
  return { database, org: orgContext(id) };
}
describe('Node production audit budget', () => {
  it('constructs production prune from the seal budget and relieves required write refusal', async () => {
    const { database, org } = await fixture();
    const sink: PluginDefinition = {
      id: 'sink',
      package: '@test/sink',
      apiVersion: 4,
      platforms: ['node'],
      auditSinks: [
        {
          id: 'archive',
          kind: 'custom',
          activation: 'env',
          custody: 'durable',
          sourceIp: 'include',
          destination: {
            protocol: 'https-json',
            urlEnv: 'ARCHIVE_URL',
            headersEnv: 'ARCHIVE_HEADERS',
          },
          create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
        },
      ],
    };
    const broker = createNodeServer([sink], {
      executor: database.executor,
      audit: { capacity, alerts: { webhookEnv: 'ALERT_URL' } },
      auditEnv: {
        ALERT_URL: 'https://alerts.example.test',
        ARCHIVE_URL: 'https://archive.example.test',
        ARCHIVE_HEADERS: 'Authorization=fixture',
      },
      observability: { deploymentId: 'test', sink: { emit: () => {} } },
      platformServices: {
        jobStore: createJobRepository(database.executor),
        blob: {
          stage: async () => {
            throw new Error('unused');
          },
          openStaged: async () => {
            throw new Error('unused');
          },
          promote: async () => {
            throw new Error('unused');
          },
          discard: async () => {
            throw new Error('unused');
          },
          head: async () => null,
          get: async () => null,
          put: async () => {
            throw new Error('unused');
          },
        },
        cache: { get: async () => null, set: async () => {}, delete: async () => {} },
      },
      log: () => {},
    });
    try {
      const kernel = await broker.ready();
      const run = async (name: string) => {
        const job = kernel.registration.jobs.find(
          (entry) => entry.qualifiedName === `core:${name}:v1`,
        )!;
        const id = ulid();
        await database.executor.batch([
          {
            sql: "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES (?, ?, ?, 'running', 'test', '2099-01-01T00:00:00.000Z', 1)",
            params: [id, org.orgId, `core:${name}:v1`],
          },
        ]);
        await job.definition.handler(
          {},
          {
            ...kernel.jobScope(job, { jobId: id, attempt: 1 }),
            org,
            jobId: id,
            fences: jobFences({ id, owner: 'test', fence: 1 }),
            idempotencyKey: name,
            attempt: 1,
            fence: 1,
            signal: new AbortController().signal,
          },
        );
      };
      await database.executor.batch([
        {
          sql: `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < 16384)
          INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type, payload_json)
          SELECT printf('event-%d', n), ?, n, printf('%064x', n-1), printf('%064x', n), '2026-10-31T00:00:00.000Z', 'system', 'project.update', 'project', json_quote(printf('%04096d', n)) FROM numbers`,
          params: [org.orgId],
        },
        {
          sql: `UPDATE audit_chain SET policy = 'required', head_seq = 16384, head_hash = printf('%064x', 16384) WHERE org_id = ?`,
          params: [org.orgId],
        },
        {
          sql: `UPDATE audit_sink SET progress_seq = 16384, custody_seq = 16384, progress_hash = printf('%064x', 16384) WHERE org_id = ?`,
          params: [org.orgId],
        },
      ]);
      await run('audit-seal');
      expect(
        await database.executor.all({
          sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ capacity_state: 'refusing' }]);
      const event = {
        id: ulid(),
        occurredAt: new Date().toISOString(),
        actor: { type: 'system' as const, id: null },
        tokenSelector: null,
        sourceIp: null,
        action: 'project.update' as const,
        target: { type: 'project', id: null },
        projectId: null,
        payloadJson: '{}',
      };
      await expect(
        database.executor.batch([auditPendingStatement(org, event)]),
      ).rejects.toMatchObject({ kind: 'backlog_full' });
      for (let round = 0; round < 10; round++) await run('audit-maintain');
      const [state] = await database.executor.all<{
        capacity_state: string;
        journal_bytes: number;
        boundary_seq: number;
      }>({
        sql: 'SELECT capacity_state, journal_bytes, boundary_seq FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      });
      expect(state!.capacity_state).toBe('warning');
      expect(state!.journal_bytes).toBeLessThanOrEqual(
        capacity.maxJournalBytes - Math.ceil(capacity.maxJournalBytes / 20),
      );
      expect(state!.boundary_seq).toBeGreaterThan(1);
      await expect(
        database.executor.batch([auditPendingStatement(org, event)]),
      ).resolves.toBeDefined();
    } finally {
      await broker.close();
      await database.close();
    }
  });
});
