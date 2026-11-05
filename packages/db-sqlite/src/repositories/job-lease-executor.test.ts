import { expect, it } from 'vitest';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { jobLeaseExecutor } from './job-lease-executor.js';
import { createAuditSealRepository } from './audit-seal.js';
import { createAuditVerifyReader } from './audit-verify.js';

it.each(['seal', 'verify'] as const)(
  'rolls back %s when the lease expires between reading and committing',
  async (operation) => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const org = database.orgs!.a;
    const foreign = database.orgs!.b;
    const executor = database.executor;
    const id = ulid();
    try {
      await executor.batch([
        {
          sql: "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES (?, ?, ?, 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
          params: [id, org.orgId, `core:audit-${operation}:v1`],
        },
        {
          sql: "INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type) VALUES (?, ?, '2026-11-05T00:00:00.000Z', 'system', 'org.update', 'organization')",
          params: [ulid(), org.orgId],
        },
      ]);
      let expired = false;
      const racing: SqlExecutor = {
        ...executor,
        async batch(statements) {
          if (
            !expired &&
            statements.some((statement) => statement.sql.startsWith('UPDATE audit_chain'))
          ) {
            expired = true;
            await executor.batch([
              {
                sql: "UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
                params: [org.orgId, id],
              },
            ]);
          }
          return executor.batch(statements);
        },
      };
      const context = {
        org,
        signal: new AbortController().signal,
        fences: jobFences({ id, owner: 'worker', fence: 1 }),
      } as unknown as JobContext;
      const guarded = jobLeaseExecutor(racing, context);
      const reader = createAuditVerifyReader(guarded);
      const snapshot = await reader.snapshot(org);
      const action =
        operation === 'seal'
          ? createAuditSealRepository(guarded).seal(org)
          : reader.markVerified(
              org,
              new Date().toISOString(),
              { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
              snapshot,
            );
      await expect(action).rejects.toMatchObject({ code: 'lease_lost' });
      expect(expired).toBe(true);
      expect(
        await executor.all({
          sql: 'SELECT head_seq, verified_at FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ head_seq: 0, verified_at: null }]);
      expect(
        await executor.all({
          sql: 'SELECT count(*) AS count FROM audit_pending WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ count: 1 }]);
      expect(
        await executor.all({
          sql: 'SELECT count(*) AS count FROM audit_event WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ count: 0 }]);
      const foreignGuard = jobLeaseExecutor(executor, { ...context, org: foreign });
      await expect(
        foreignGuard.batch([
          { sql: 'UPDATE audit_chain SET head_seq = 10 WHERE org_id = ?', params: [foreign.orgId] },
        ]),
      ).rejects.toMatchObject({ code: 'lease_lost' });
    } finally {
      await database.close();
    }
  },
);
