import { JobError } from '@package-broker/core/platform/jobs';
import { sql, type RawBuilder } from 'kysely';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_CANCEL_CODES,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DELIVERY_CODES,
  NOTIFICATION_DISPATCH_JOB,
  NOTIFICATION_RETENTION_PAGE,
  deliverIdempotencyKey,
  deliverJobRow,
  dispatchJobRow,
  notificationDeliveryState,
  type NotificationCancelCode,
  type NotificationDeliveryRecord,
  type NotificationRepairCandidate,
  type NotificationRetentionRepository,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertCheck, compile, db } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { createJobRepository } from './job.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import {
  deliveryAudit,
  deliveryIdOf,
  fenced,
  instantOf,
  invalidInput,
  positive,
} from './notification-attempt.js';
import { failureStreakStatements } from './notification-settle.js';

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

function member<T extends string>(values: readonly T[], value: unknown): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : invalidInput();
}

function limitOf(value: unknown): number {
  return positive(value, NOTIFICATION_RETENTION_PAGE);
}

const NOTIFICATION_CREDENTIAL_KINDS = ['npm-notification', 'npm-notification-body'];

/** The job running a delivery is gone, dead or finished: nobody will settle or start it again. */
function jobGone(ctx: OrgContext, alias: string, jobId: RawBuilder<unknown>) {
  const job = sql.raw(alias);
  return sql<boolean>`not exists (select 1 from job as ${job}
    where ${job}.org_id = ${ctx.orgId} and ${job}.id = ${jobId}
      and ${job}.state in ('queued', 'running'))`;
}

/** Why the endpoint, project or source admission no longer accepts a pending delivery, or null. */
function obsoleteCode(ctx: OrgContext) {
  return sql<NotificationCancelCode | null>`(case
    when repair_endpoint.id is null or repair_endpoint.state = 'deleted' then 'deleted'
    when repair_endpoint.state <> 'enabled' then 'disabled'
    when repair_endpoint.revision <> repair_delivery.endpoint_revision then 'superseded'
    when repair_project.status is not 'active' then 'project_inactive'
    when not exists (select 1 from project_source as repair_ps
      join source as repair_source on repair_source.id = repair_ps.source_id
        and repair_source.org_id = ${ctx.orgId}
      where repair_ps.org_id = ${ctx.orgId} and repair_ps.project_id = repair_delivery.project_id
        and repair_ps.source_id = repair_event.source_id and repair_source.status = 'active'
        and (repair_source.project_id is null or repair_source.project_id = repair_ps.project_id))
      then 'admission_lost'
    else null end)`;
}

interface CandidateRow {
  kind: 'expire' | 'orphan' | 'obsolete' | 'dead_job';
  code: string | null;
  id: string;
  project_id: string;
  event_id: string;
  endpoint_id: string;
  endpoint_revision: number;
  configuration_credential_id: string;
  body_credential_id: string | null;
  state: string;
  attempts: number;
  job_generation: number;
  active_job_id: string | null;
  active_fence: number | null;
  revision: number;
  next_attempt_at: string;
  expires_at: string;
  created_at: string;
  last_finished_at: string | null;
}

function record(row: CandidateRow): NotificationDeliveryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    endpointRevision: row.endpoint_revision,
    configurationCredentialId: row.configuration_credential_id,
    bodyCredentialId: row.body_credential_id,
    state: notificationDeliveryState(row.state),
    attempts: row.attempts,
    jobGeneration: row.job_generation,
    activeJobId: row.active_job_id,
    activeFence: row.active_fence,
    revision: row.revision,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastFinishedAt: row.last_finished_at,
  };
}

/**
 * Hourly repair and retention under the sweep job's lease. Each delivery write compares the
 * revision the sweep read, so a delivery job that moved on in between wins; pruning keeps the
 * order attempts, deliveries, events, deleted endpoints, credentials, and never touches audit rows.
 */
export function createNotificationRetentionRepository(
  executor: SqlExecutor,
): NotificationRetentionRepository {
  const jobs = createJobRepository(executor);

  async function snapshotOf(ctx: OrgContext, deliveryId: string) {
    const [row] = await executor.all<{
      endpoint_id: string;
      project_id: string;
      endpoint_revision: number;
      job_generation: number;
    }>(
      raw(sql`select retained.endpoint_id, retained.project_id, retained.endpoint_revision,
          retained.job_generation
        from notification_delivery as retained
        where retained.org_id = ${ctx.orgId} and retained.id = ${deliveryId}`),
    );
    return row;
  }

  return {
    async repairCandidates(ctx, now, limit) {
      const at = instantOf(now);
      const page = limitOf(limit);
      const kind = sql`(case
        when repair_delivery.state = 'sending' then
          case when ${jobGone(ctx, 'repair_sending_job', sql`repair_delivery.active_job_id`)} then 'orphan' end
        when repair_delivery.expires_at <= ${at}
          or repair_delivery.attempts >= ${MAX_NOTIFICATION_ATTEMPTS} then 'expire'
        when ${obsoleteCode(ctx)} is not null then 'obsolete'
        when repair_delivery.active_job_id is not null
          and ${jobGone(ctx, 'repair_pending_job', sql`repair_delivery.active_job_id`)} then 'dead_job'
        end)`;
      const rows = await executor.all<CandidateRow>(
        raw(sql`select * from (select ${kind} as kind, ${obsoleteCode(ctx)} as code, repair_delivery.*,
            (select max(repair_attempt.finished_at) from notification_attempt as repair_attempt
              where repair_attempt.org_id = ${ctx.orgId}
                and repair_attempt.delivery_id = repair_delivery.id) as last_finished_at
          from notification_delivery as repair_delivery
          join notification_event as repair_event on repair_event.id = repair_delivery.event_id
            and repair_event.org_id = ${ctx.orgId}
          left join notification_endpoint as repair_endpoint on repair_endpoint.id = repair_delivery.endpoint_id
            and repair_endpoint.org_id = ${ctx.orgId}
          left join project as repair_project on repair_project.id = repair_delivery.project_id
            and repair_project.org_id = ${ctx.orgId}
          where repair_delivery.org_id = ${ctx.orgId}
            and repair_delivery.state in ('pending', 'sending'))
        where kind is not null
        order by created_at, id limit ${page}`),
      );
      return rows.map((row): NotificationRepairCandidate => {
        const delivery = record(row);
        return row.kind === 'obsolete'
          ? {
              kind: 'obsolete',
              delivery,
              code: member(NOTIFICATION_CANCEL_CODES, row.code),
            }
          : { kind: row.kind, delivery };
      });
    },

    async expire(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const code = member(['expired', 'attempt_limit'] as const, input.code);
      const event = deliveryAudit(input.event, 'notification.delivery_finished', deliveryId);
      const snapshot = await snapshotOf(ctx, deliveryId);
      if (snapshot === undefined) return false;
      const due =
        code === 'expired'
          ? sql`expiring.expires_at <= ${now}`
          : sql`expiring.attempts >= ${MAX_NOTIFICATION_ATTEMPTS}`;
      const payload = JSON.parse(event.payloadJson) as { op_id: string; request_id: string };
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as expiring
          where expiring.org_id = ${ctx.orgId} and expiring.id = ${deliveryId}
            and expiring.state = 'pending' and expiring.revision = ${expected} and ${due})`),
        raw(sql`update notification_delivery set state = 'failed', outcome_code = ${code},
            finished_at = ${now}, active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
        ...failureStreakStatements(ctx, {
          snapshot,
          disable: null,
          now,
          opId: payload.op_id,
          requestId: payload.request_id,
        }),
        auditPendingStatement(ctx, event),
      ]);
    },

    async reconcileOrphan(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const event = deliveryAudit(input.event, 'notification.delivery_finished', deliveryId);
      const after =
        input.delivery.state === 'pending'
          ? { state: 'pending', next: instantOf(input.delivery.nextAttemptAt), code: 'unknown' }
          : input.delivery.state === 'failed'
            ? {
                state: 'failed',
                next: null,
                code: member(NOTIFICATION_DELIVERY_CODES, input.delivery.code),
              }
            : invalidInput();
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as orphan
          where orphan.org_id = ${ctx.orgId} and orphan.id = ${deliveryId}
            and orphan.state = 'sending' and orphan.revision = ${expected}
            and ${jobGone(ctx, 'orphan_job', sql`orphan.active_job_id`)})`),
        raw(sql`update notification_attempt set outcome = 'unknown', outcome_code = 'unknown',
            finished_at = ${now}
          where org_id = ${ctx.orgId} and delivery_id = ${deliveryId} and outcome = 'started'`),
        raw(sql`update notification_delivery set state = ${after.state}, outcome_code = ${after.code},
            next_attempt_at = coalesce(${after.next}, next_attempt_at),
            finished_at = ${after.state === 'failed' ? now : null},
            active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
        auditPendingStatement(ctx, event),
      ]);
    },

    async cancel(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const code = member(NOTIFICATION_CANCEL_CODES, input.code);
      const event = deliveryAudit(input.event, 'notification.delivery_cancelled', deliveryId);
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as cancelling
          where cancelling.org_id = ${ctx.orgId} and cancelling.id = ${deliveryId}
            and cancelling.state = 'pending' and cancelling.revision = ${expected})`),
        raw(sql`update notification_delivery set state = 'cancelled', outcome_code = ${code},
            finished_at = ${now}, active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
        auditPendingStatement(ctx, event),
      ]);
    },

    async requeue(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const snapshot = await snapshotOf(ctx, deliveryId);
      if (snapshot === undefined) return null;
      const generation = snapshot.job_generation + 1;
      const row = deliverJobRow({
        jobId: input.jobId,
        deliveryId,
        endpointId: snapshot.endpoint_id,
        generation,
      });
      const ready = sql<boolean>`exists (select 1 from notification_delivery as requeued
        where requeued.org_id = ${ctx.orgId} and requeued.id = ${deliveryId}
          and requeued.state = 'pending' and requeued.revision = ${expected}
          and requeued.job_generation = ${snapshot.job_generation}
          and ${jobGone(ctx, 'requeued_job', sql`requeued.active_job_id`)})`;
      const ok = await fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(ready),
        ...jobs.enqueueStatements(ctx, row),
        raw(sql`update notification_delivery set job_generation = ${generation},
            active_job_id = (select requeue_job.id from job as requeue_job
              where requeue_job.org_id = ${ctx.orgId}
                and requeue_job.idempotency_key = ${deliverIdempotencyKey(deliveryId, generation)}
                and requeue_job.type = ${NOTIFICATION_DELIVER_JOB}),
            revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
      ]);
      if (!ok) return null;
      const [current] = await executor.all<{ active_job_id: string | null }>(
        raw(sql`select requeue_read.active_job_id from notification_delivery as requeue_read
          where requeue_read.org_id = ${ctx.orgId} and requeue_read.id = ${deliveryId}`),
      );
      return current?.active_job_id ?? null;
    },

    async redispatch(ctx, lease, input) {
      const now = instantOf(input.now);
      const page = limitOf(input.limit);
      const prefix = `${NOTIFICATION_DISPATCH_JOB}:dispatch:`;
      const stalled = await executor.all<{ operation_id: string; generation: number }>(
        raw(sql`select stalled_op.operation_id, stalled_op.generation from (
            select stalled.operation_id, max(stalled.dispatch_generation) as generation,
              min(stalled.occurred_at) as first_at
            from notification_event as stalled
            where stalled.org_id = ${ctx.orgId} and stalled.dispatched_at is null
              and stalled.occurred_at < ${now}
            group by stalled.operation_id) as stalled_op
          where not exists (select 1 from job as stalled_job
            where stalled_job.org_id = ${ctx.orgId}
              and stalled_job.idempotency_key = ${prefix} || stalled_op.operation_id || ':' || stalled_op.generation
              and stalled_job.state in ('queued', 'running'))
          order by stalled_op.first_at, stalled_op.operation_id limit ${page}`),
      );
      const created: string[] = [];
      for (const { operation_id: operationId, generation } of stalled) {
        const row = dispatchJobRow({
          jobId: input.jobId(),
          operationId,
          generation: generation + 1,
        });
        const ok = await fenced(executor, [
          ...jobLeaseGuard(ctx, lease),
          ...assertCheck(sql<boolean>`exists (select 1 from notification_event as restarting
            where restarting.org_id = ${ctx.orgId} and restarting.operation_id = ${operationId}
              and restarting.dispatched_at is null and restarting.dispatch_generation = ${generation})`),
          ...jobs.enqueueStatements(ctx, row),
          raw(sql`update notification_event set dispatch_generation = ${generation + 1}
            where org_id = ${ctx.orgId} and operation_id = ${operationId} and dispatched_at is null`),
        ]);
        if (ok) created.push(row.id);
      }
      return created;
    },

    async prune(ctx, lease, input) {
      const now = instantOf(input.now);
      const before = instantOf(input.before);
      if (before > now) invalidInput();
      const page = limitOf(input.limit);
      // The notification_delivery_finished check sets finished_at exactly for terminal states.
      const finished = sql`(select pruned.id from notification_delivery as pruned
        where pruned.org_id = ${ctx.orgId} and pruned.finished_at < ${before}
        order by pruned.finished_at, pruned.id limit ${page})`;
      const kinds = JSON.stringify(NOTIFICATION_CREDENTIAL_KINDS);
      let results;
      try {
        results = await executor.batch([
          ...jobLeaseGuard(ctx, lease),
          raw(sql`delete from notification_attempt where org_id = ${ctx.orgId}
          and delivery_id in ${finished} returning attempt`),
          raw(sql`delete from notification_delivery where org_id = ${ctx.orgId}
          and id in ${finished} returning id`),
          raw(sql`delete from notification_event where org_id = ${ctx.orgId} and id in (
            select emptied.id from notification_event as emptied
            where emptied.org_id = ${ctx.orgId} and emptied.occurred_at < ${before}
              and not exists (select 1 from notification_delivery as emptied_ref
                where emptied_ref.org_id = ${ctx.orgId} and emptied_ref.event_id = emptied.id)
            order by emptied.occurred_at, emptied.id limit ${page})
          returning id`),
          raw(sql`delete from notification_endpoint where org_id = ${ctx.orgId} and id in (
            select gone.id from notification_endpoint as gone
            where gone.org_id = ${ctx.orgId} and gone.state = 'deleted' and gone.updated_at < ${before}
              and not exists (select 1 from notification_delivery as gone_ref
                where gone_ref.org_id = ${ctx.orgId} and gone_ref.endpoint_id = gone.id)
            order by gone.updated_at, gone.id limit ${page})
          returning id`),
          raw(sql`delete from credential where org_id = ${ctx.orgId} and id in (
            select unused.id from credential as unused
            where unused.org_id = ${ctx.orgId}
              and unused.kind in (select value from json_each(${kinds}))
              and unused.created_at < ${before}
              and not exists (select 1 from notification_endpoint as unused_endpoint
                where unused_endpoint.org_id = ${ctx.orgId} and unused_endpoint.credential_id = unused.id)
              and not exists (select 1 from notification_delivery as unused_delivery
                where unused_delivery.org_id = ${ctx.orgId}
                  and (unused_delivery.configuration_credential_id = unused.id
                    or unused_delivery.body_credential_id = unused.id))
            order by unused.created_at, unused.id limit ${page})
          returning id`),
        ]);
      } catch (error) {
        if (error instanceof DbError && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT)
          throw new JobError('lease_lost');
        throw error;
      }
      const counts = results.slice(-5).map((result) => result.rows.length);
      return {
        attempts: counts[0]!,
        deliveries: counts[1]!,
        events: counts[2]!,
        endpoints: counts[3]!,
        credentials: counts[4]!,
      };
    },
  };
}
