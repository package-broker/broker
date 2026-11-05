import { jobLeaseOf } from '@package-broker/core/platform/job-fences';
import { JobError, type JobContext } from '@package-broker/core/platform/jobs';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { jobLeaseGuard } from './job-lease-guard.js';

/** Every statement, including writes with RETURNING, shares a transaction with the live lease. */
export function jobLeaseExecutor(executor: SqlExecutor, context: JobContext): SqlExecutor {
  const lease = jobLeaseOf(context);
  if (lease === null) throw new JobError('lease_lost');
  const guard = jobLeaseGuard(context.org, lease);
  const batch: SqlExecutor['batch'] = async (statements) => {
    if (context.signal.aborted) throw new JobError('aborted');
    try {
      return (await executor.batch([...guard, ...statements])).slice(guard.length);
    } catch (error) {
      // A failed guard must not be mistaken for ordinary data contention by a repository.
      const live = await executor.all<{ live: number }>({
        sql: `SELECT 1 AS live FROM job WHERE org_id = ? AND id = ? AND lease_owner = ?
          AND fence = ? AND state = 'running'
          AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        params: [context.org.orgId, lease.id, lease.owner, lease.fence],
      });
      if (live.length === 0) throw new JobError('lease_lost');
      throw error;
    }
  };
  return {
    driver: executor.driver,
    batch,
    async all<R>(statement: Statement): Promise<R[]> {
      return (await batch([statement]))[0]!.rows as R[];
    },
  };
}
