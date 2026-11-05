import type { PluginDefinition } from '@package-broker/core/plugin';
const alertFetch = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 204 })));
vi.mock('./sources/guarded-fetch.js', async (original) => ({
  ...(await original<typeof import('./sources/guarded-fetch.js')>()),
  createAuditGuardedFetch: () => alertFetch,
}));
import { ulid } from '@package-broker/core/ids';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { createAuditStatusReader } from '@package-broker/db-sqlite/repositories/audit-status';
import { createAuditHealthService } from '@package-broker/core/audit/health';
import { createAuditHealthRepository } from '@package-broker/db-sqlite/repositories/audit-health';
import { noopObservability } from '@package-broker/core/platform/observability';
import * as sealModule from '@package-broker/db-sqlite/repositories/audit-seal';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { describe, expect, it, vi } from 'vitest';
import type { SafeLogRecord, ObsRecord } from '@package-broker/core/platform/observability';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createJobLoop } from './jobs/loop.js';
import { createNodeServer } from './index.js';

const inactiveSinks: PluginDefinition = {
  id: 'inactive-sinks',
  package: '@test/inactive-sinks',
  apiVersion: 4,
  platforms: ['node'],
  auditSinks: [
    {
      id: 'otlp',
      kind: 'otlp',
      activation: 'env',
      custody: 'delivery',
      sourceIp: 'omit',
      destination: { protocol: 'otlp-http-json' },
      create: () => {
        throw new Error('Inactive sink created');
      },
    },
    {
      id: 'webhook',
      kind: 'webhook',
      activation: 'env',
      custody: 'delivery',
      sourceIp: 'omit',
      destination: {
        protocol: 'https-json',
        urlEnv: 'PB_AUDIT_WEBHOOK_URL',
        headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS',
      },
      create: () => {
        throw new Error('Inactive sink created');
      },
    },
  ],
};

describe('Node audit job registration', () => {
  it('refuses required boot without a journal budget', () => {
    expect(() => createNodeServer([], { audit: { policy: 'required' } })).toThrow(
      expect.objectContaining({
        code: 'journal_budget_required',
        message: 'Invalid effective audit configuration',
      }),
    );
  });

  it('registers the core schedules and runs the real repositories, detecting tampering', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const { executor } = database;
    const org = database.orgs!.a;
    const records: ObsRecord[] = [];
    const seal = vi.spyOn(sealModule, 'createAuditSealRepository');
    const broker = createNodeServer([inactiveSinks], {
      executor,
      audit: {
        capacity: { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES },
        alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
      },
      auditEnv: { AUDIT_ALERT_URL: 'https://alerts.example.test' },
      platformServices: {
        jobStore: createJobRepository(executor),
        blob: {
          async stage() {
            throw new Error('not_implemented');
          },
          async openStaged() {
            throw new Error('not_implemented');
          },
          async promote() {
            throw new Error('not_implemented');
          },
          async discard() {
            throw new Error('not_implemented');
          },
          head: async () => null,
          get: async () => null,
          put: async () => {
            throw new Error('unused');
          },
        },
        cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      },
      observability: {
        sink: { emit: (record) => void records.push(record) },
        deploymentId: 'test',
        trustInboundTraceparent: false,
      },
    });
    try {
      const kernel = await broker.ready();
      expect(seal).toHaveBeenCalledWith(executor, { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES });
      expect(
        kernel.registration.jobs.map(({ qualifiedName, definition }) => [
          qualifiedName,
          definition.schedule,
        ]),
      ).toEqual([
        ['core:vulnerability-sync:v1', { everySeconds: 300 }],
        ['core:publish-scan:v1', undefined],
        ['core:publish-scan-sweep:v1', { everySeconds: 300 }],
        ['core:publish-approval-expire:v1', { everySeconds: 3600 }],
        ['core:package-access-expire:v1', { everySeconds: 3600 }],
        ['core:audit-seal:v1', { everySeconds: 60 }],
        ['core:audit-verify:v1', { everySeconds: 86400, resourceKey: 'audit-verify' }],
        ['core:audit-maintain:v1', { everySeconds: 60, resourceKey: 'audit-maintain' }],
        ['core:audit-health-observe:v1', { everySeconds: 60, resourceKey: 'audit-health-observe' }],
        ['core:audit-frontier:v1', { everySeconds: 86400, resourceKey: 'audit-frontier' }],
        ['core:audit-head:v1', { everySeconds: 86400, resourceKey: 'audit-head' }],
      ]);
      await executor.batch([
        {
          sql: `INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled)
          VALUES (?, 'core:audit-verify:v1', 86400, '2000-01-01T00:00:00.000Z', 1)`,
          params: [org.orgId],
        },
      ]);
      const loop = createJobLoop({
        executor,
        jobs: kernel.registration.jobs,
        scope: (job, claim) => kernel.jobScope(job, claim),
        observability: {
          log: () => undefined,
          counter: () => undefined,
          histogram: () => undefined,
        },
      });
      loop.start();
      try {
        await vi.waitFor(
          async () => {
            expect(
              await executor.all({
                sql: "SELECT resource_key FROM job WHERE org_id = ? AND type = 'core:audit-verify:v1' AND idempotency_key LIKE 'schedule:%'",
                params: [org.orgId],
              }),
            ).toEqual([{ resource_key: 'audit-verify' }]);
          },
          { timeout: 10_000 },
        );
      } finally {
        await loop.stop();
      }
      await executor.batch([
        {
          sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES ('node-audit', ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
          params: [org.orgId],
        },
      ]);
      const run = async (name: string) => {
        const job = kernel.registration.jobs.find((job) => job.qualifiedName === name)!;
        const id = ulid();
        await executor.batch([
          {
            sql: "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES (?, ?, ?, 'running', 'test', '2099-01-01T00:00:00.000Z', 1)",
            params: [id, org.orgId, name],
          },
        ]);
        const scope = kernel.jobScope(job, { jobId: id, attempt: 1 });
        await job.definition.handler(job.definition.validate({}), {
          ...scope,
          org,
          jobId: id,
          fences: jobFences({ id, owner: 'test', fence: 1 }),
          idempotencyKey: name,
          attempt: 1,
          fence: 1,
          signal: new AbortController().signal,
        });
      };
      const logs = (): SafeLogRecord[] =>
        records.flatMap((record) => (record.kind === 'log' ? [record.record] : []));
      await run('core:audit-seal:v1');
      await run('core:audit-verify:v1');
      expect(logs()).toContainEqual(expect.objectContaining({ event: 'audit.verified', rows: 1 }));
      records.length = 0;
      await executor.batch([
        {
          sql: "UPDATE audit_event SET action = 'org.delete' WHERE org_id = ? AND seq = 1",
          params: [org.orgId],
        },
      ]);
      await run('core:audit-verify:v1');
      expect(logs()).toContainEqual(
        expect.objectContaining({ event: 'audit.chain_broken', seq: 1, reason: 'hash' }),
      );
      expect((await createAuditStatusReader(executor).read(org)).verification).toBeNull();
      const health = createAuditHealthService({
        port: createAuditHealthRepository(executor),
        clock: { now: () => new Date() },
        observability: noopObservability,
      });
      expect(await health.read(org)).toMatchObject({
        status: 'degraded',
        codes: expect.arrayContaining(['audit.chain_integrity']),
      });
      await vi.waitFor(() =>
        expect(alertFetch).toHaveBeenCalledWith(
          'https://alerts.example.test',
          expect.objectContaining({ body: JSON.stringify({ code: 'audit.chain_integrity' }) }),
        ),
      );
      expect(records).toContainEqual({
        kind: 'counter',
        name: 'pb.audit.chain_broken',
        labels: {},
        value: 1,
      });
    } finally {
      seal.mockRestore();
      await broker.close();
      await database.close();
    }
  });
});
