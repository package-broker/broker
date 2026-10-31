import * as sealModule from '@package-broker/db-sqlite/repositories/audit-seal';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { describe, expect, it, vi } from 'vitest';
import type { SafeLogRecord, ObsRecord } from '@package-broker/core/platform/observability';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createJobLoop } from './jobs/loop.js';
import { createNodeServer } from './index.js';

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
    const broker = createNodeServer([], {
      executor,
      audit: { capacity: { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES } },
      platformServices: {
        jobStore: createJobRepository(executor),
        blob: {
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
        ['core:audit-seal:v1', { everySeconds: 60 }],
        ['core:audit-verify:v1', { everySeconds: 86400, resourceKey: 'audit-verify' }],
        ['core:audit-maintain:v1', { everySeconds: 60, resourceKey: 'audit-maintain' }],
        ['core:audit-health-observe:v1', { everySeconds: 60, resourceKey: 'audit-health-observe' }],
        ['core:audit-frontier:v1', { everySeconds: 86400, resourceKey: 'audit-frontier' }],
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
        const scope = kernel.jobScope(job, { jobId: 'audit-test', attempt: 1 });
        await job.definition.handler(job.definition.validate({}), {
          ...scope,
          org,
          jobId: 'audit-test',
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
