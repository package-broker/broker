import { describe, expect, it } from 'vitest';
import type { SafeLogRecord, ObsRecord } from '@package-broker/core/platform/observability';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer } from './index.js';

describe('Node audit job registration', () => {
  it('registers the core schedules and runs the real repositories, detecting tampering', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const { executor } = database;
    const org = database.orgs!.a;
    const records: ObsRecord[] = [];
    const broker = createNodeServer([], {
      executor,
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
      expect(
        kernel.registration.jobs.map(({ qualifiedName, definition }) => [
          qualifiedName,
          definition.schedule,
        ]),
      ).toEqual([
        ['core:vulnerability-sync:v1', { everySeconds: 300 }],
        ['core:publish-approval-expire:v1', { everySeconds: 3600 }],
        ['core:audit-seal:v1', { everySeconds: 60 }],
        ['core:audit-verify:v1', { everySeconds: 86400 }],
      ]);
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
      await broker.close();
      await database.close();
    }
  });
});
