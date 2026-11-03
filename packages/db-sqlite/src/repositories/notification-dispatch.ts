import { sql, type RawBuilder } from 'kysely';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import {
  NotificationRepositoryError,
  deliverIdempotencyKey,
  deliverJobRow,
  dispatchPayload,
  type NotificationDispatchRepository,
} from '@package-broker/core/db/notifications';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db, newOpId } from '../kysely.js';
import { createJobRepository } from './job.js';
import { jobLeaseGuard } from './job-lease-guard.js';

/** Recipients scheduled per page: two statements each keeps a page far below the 40 budget. */
export const DISPATCH_PAGE_SIZE = 5;
const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

/**
 * Schedules the recipients snapshotted at capture: never selects endpoints again. A retried page
 * resumes from the job ids already stored on the deliveries, and job keys make a replay harmless.
 */
export function createNotificationDispatchRepository(
  executor: SqlExecutor,
): NotificationDispatchRepository {
  const jobs = createJobRepository(executor);
  return {
    async dispatchPage(ctx, lease, operationId) {
      const op = dispatchPayload({ operationId }).operationId;
      const pending = await executor.all<{
        id: string;
        endpoint_id: string;
        job_generation: number;
      }>(
        raw(sql`select dispatch_delivery.id, dispatch_delivery.endpoint_id, dispatch_delivery.job_generation
          from notification_delivery as dispatch_delivery
          join notification_event as dispatch_event on dispatch_event.id = dispatch_delivery.event_id
            and dispatch_event.org_id = ${ctx.orgId} and dispatch_event.project_id = dispatch_delivery.project_id
          where dispatch_delivery.org_id = ${ctx.orgId} and dispatch_event.operation_id = ${op}
            and dispatch_delivery.state = 'pending' and dispatch_delivery.active_job_id is null
          order by dispatch_delivery.id limit ${DISPATCH_PAGE_SIZE}`),
      );
      const statements: Statement[] = [...jobLeaseGuard(ctx, lease)];
      for (const delivery of pending) {
        const row = deliverJobRow({
          jobId: newOpId(),
          deliveryId: delivery.id,
          endpointId: delivery.endpoint_id,
          generation: delivery.job_generation,
        });
        const unscheduled = sql`exists (select 1 from notification_delivery as unscheduled
          where unscheduled.org_id = ${ctx.orgId} and unscheduled.id = ${delivery.id}
            and unscheduled.state = 'pending' and unscheduled.active_job_id is null)`;
        statements.push(
          ...jobs.enqueueStatements(ctx, row, unscheduled),
          raw(sql`update notification_delivery set active_job_id = (select scheduled.id from job as scheduled
              where scheduled.org_id = ${ctx.orgId}
                and scheduled.idempotency_key = ${deliverIdempotencyKey(delivery.id, delivery.job_generation)})
            where org_id = ${ctx.orgId} and id = ${delivery.id} and state = 'pending' and active_job_id is null`),
        );
      }
      statements.push(
        raw(sql`update notification_event set dispatched_at = ${NOW}
          where org_id = ${ctx.orgId} and operation_id = ${op} and dispatched_at is null
            and not exists (select 1 from notification_delivery as remaining
              join notification_event as remaining_event on remaining_event.id = remaining.event_id
                and remaining_event.org_id = ${ctx.orgId} and remaining_event.operation_id = ${op}
              where remaining.org_id = ${ctx.orgId} and remaining.state = 'pending'
                and remaining.active_job_id is null)`),
        raw(sql`select (select count(*) from notification_event as open_event
            where open_event.org_id = ${ctx.orgId} and open_event.operation_id = ${op}
              and open_event.dispatched_at is null) as open,
          (select json_group_array(recorded.active_job_id) from notification_delivery as recorded
            where recorded.org_id = ${ctx.orgId}
              and recorded.id in (select value from json_each(${JSON.stringify(pending.map((d) => d.id))}))) as jobs`),
      );
      let results;
      try {
        results = await executor.batch(statements);
      } catch (error) {
        if (error instanceof DbError && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT)
          throw new NotificationRepositoryError('conflict');
        throw error;
      }
      const summary = results.at(-1)?.rows[0] as { open: number; jobs: string } | undefined;
      if (summary === undefined) throw new NotificationRepositoryError('unavailable');
      const jobIds = (JSON.parse(summary.jobs) as (string | null)[]).filter(
        (id): id is string => typeof id === 'string',
      );
      return { jobIds, done: summary.open === 0 };
    },
  };
}
