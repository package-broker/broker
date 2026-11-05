import { sql, type RawBuilder } from 'kysely';
import { auditEvent } from '@package-broker/core/audit/actions';
import {
  NOTIFICATION_ATTEMPT_CODES,
  NOTIFICATION_DELIVERY_CODES,
  NOTIFICATION_FAILURE_LIMIT,
  MAX_NOTIFICATION_ATTEMPTS,
  type NotificationAttemptRepository,
  type NotificationDeliveryOutcome,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import {
  deliveryAudit,
  deliveryIdOf,
  fenced,
  instantOf,
  invalidInput,
  positive,
} from './notification-attempt.js';

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

function member<T extends string>(values: readonly T[], value: unknown): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : invalidInput();
}

function outcomeOf(delivery: NotificationDeliveryOutcome, now: string) {
  if (delivery.state === 'pending')
    return {
      state: 'pending',
      next: instantOf(delivery.nextAttemptAt),
      code: null,
      finished: null,
    };
  if (delivery.state !== 'delivered' && delivery.state !== 'failed') return invalidInput();
  return {
    state: delivery.state,
    next: null,
    code: member(NOTIFICATION_DELIVERY_CODES, delivery.code),
    finished: now,
  };
}

export interface StreakSnapshot {
  readonly endpoint_id: string;
  readonly project_id: string;
  readonly endpoint_revision: number;
}

/**
 * One terminal failure of a delivery snapshotted for `snapshot.endpoint_revision`: the streak moves
 * only while that revision is current, and the tenth failure or an immediate reason disables the
 * endpoint, cancels its waiting work and writes `notification.auto_disable` in the same batch.
 */
export function failureStreakStatements(
  ctx: OrgContext,
  input: {
    readonly snapshot: StreakSnapshot;
    readonly disable: 'credentials' | 'policy' | 'gone' | null;
    readonly now: string;
    readonly opId: string;
    readonly requestId: string;
  },
): Statement[] {
  const { snapshot, now } = input;
  const own = sql`org_id = ${ctx.orgId} and project_id = ${snapshot.project_id}
            and id = ${snapshot.endpoint_id} and revision = ${snapshot.endpoint_revision}`;
  const reason = input.disable ?? 'failures';
  const disabled = auditEvent({
    id: newOpId(),
    now,
    action: 'notification.auto_disable',
    actor: { type: 'system', id: null },
    target: { type: 'notification_endpoint', id: snapshot.endpoint_id },
    projectId: snapshot.project_id,
    context: {
      opId: input.opId,
      requestId: input.requestId,
      sourceIp: null,
      tokenSelector: null,
    },
    changes: {
      revision: { old: snapshot.endpoint_revision, new: snapshot.endpoint_revision + 1 },
      reason: { new: reason },
      failure_streak: { new: NOTIFICATION_FAILURE_LIMIT },
    },
  });
  if (!disabled.ok) invalidInput();
  const disabling = sql`state = 'enabled'
          and (${input.disable === null ? 0 : 1} = 1 or failure_streak + 1 >= ${NOTIFICATION_FAILURE_LIMIT})`;
  const marked = sql`exists (select 1 from notification_endpoint as marked
          where marked.org_id = ${ctx.orgId} and marked.id = ${snapshot.endpoint_id}
            and marked.last_op_id = ${disabled.event.id})`;
  return [
    raw(sql`update notification_endpoint set failure_streak = failure_streak + 1,
              state = case when ${disabling} then 'disabled' else state end,
              disabled_reason = case when ${disabling} then ${reason} else disabled_reason end,
              revision = case when ${disabling} then revision + 1 else revision end,
              updated_at = case when ${disabling} then ${now} else updated_at end,
              last_op_id = case when ${disabling} then ${disabled.event.id} else last_op_id end
            where ${own}`),
    raw(sql`update notification_delivery set state = 'cancelled', outcome_code = 'disabled',
              finished_at = ${now}, revision = revision + 1
            where org_id = ${ctx.orgId} and endpoint_id = ${snapshot.endpoint_id} and state = 'pending'
              and ${marked}`),
    auditPendingStatement(ctx, disabled.event, raw(marked), {
      path: '$.changes.failure_streak.new',
      value: raw(sql`select streak.failure_streak from notification_endpoint as streak
              where streak.org_id = ${ctx.orgId} and streak.id = ${snapshot.endpoint_id}`),
    }),
  ];
}

/**
 * Settles the attempt the current claim started. A stale lease or fence settles nothing; the
 * failure streak moves only for the endpoint revision the delivery was snapshotted for.
 */
export function createNotificationSettlement(
  executor: SqlExecutor,
): Pick<NotificationAttemptRepository, 'settle' | 'reconcile'> {
  return {
    async settle(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const attempt = positive(input.attempt, MAX_NOTIFICATION_ATTEMPTS);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const event = deliveryAudit(input.event, 'notification.delivery_finished', deliveryId);
      const outcome = member(['delivered', 'retry', 'failed', 'unknown'] as const, input.outcome);
      const code = member(NOTIFICATION_ATTEMPT_CODES, input.code);
      const status = input.status === null ? null : positive(input.status, 599);
      const duration = input.durationMs === null ? null : Math.max(0, Math.trunc(input.durationMs));
      const after = outcomeOf(input.delivery, now);
      const counts = after.state === 'failed' && outcome !== 'unknown';
      if (input.disable !== null) {
        member(['credentials', 'policy', 'gone'] as const, input.disable);
        if (after.state !== 'failed' || outcome !== 'failed') invalidInput();
      }
      const [snapshot] = await executor.all<{
        endpoint_id: string;
        project_id: string;
        endpoint_revision: number;
      }>(
        raw(sql`select snapshot.endpoint_id, snapshot.project_id, snapshot.endpoint_revision
          from notification_delivery as snapshot
          where snapshot.org_id = ${ctx.orgId} and snapshot.id = ${deliveryId}`),
      );
      const statements: Statement[] = [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as settling
          where settling.org_id = ${ctx.orgId} and settling.id = ${deliveryId}
            and settling.state = 'sending' and settling.active_job_id = ${lease.id}
            and settling.active_fence = ${lease.fence} and settling.attempts = ${attempt}
            and settling.revision = ${expected})`),
        raw(sql`update notification_attempt set outcome = ${outcome}, outcome_code = ${code},
            status = ${status}, duration_ms = ${duration}, finished_at = ${now}
          where org_id = ${ctx.orgId} and delivery_id = ${deliveryId} and attempt = ${attempt}
            and outcome = 'started'`),
        raw(sql`update notification_delivery set state = ${after.state}, outcome_code = ${after.code ?? code},
            last_status = coalesce(${status}, last_status),
            next_attempt_at = coalesce(${after.next}, next_attempt_at), finished_at = ${after.finished},
            active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
      ];
      const own = snapshot
        ? sql`org_id = ${ctx.orgId} and project_id = ${snapshot.project_id}
            and id = ${snapshot.endpoint_id} and revision = ${snapshot.endpoint_revision}`
        : undefined;
      if (snapshot && own && after.state === 'delivered')
        statements.push(raw(sql`update notification_endpoint set failure_streak = 0 where ${own}`));
      if (snapshot && counts) {
        const payload = JSON.parse(event.payloadJson) as { op_id: string; request_id: string };
        statements.push(
          ...failureStreakStatements(ctx, {
            snapshot,
            disable: input.disable,
            now,
            opId: payload.op_id,
            requestId: payload.request_id,
          }),
        );
      }
      statements.push(auditPendingStatement(ctx, event));
      return fenced(executor, statements);
    },

    async reconcile(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const now = instantOf(input.now);
      const event = deliveryAudit(input.event, 'notification.delivery_finished', deliveryId);
      const after = outcomeOf(input.delivery, now);
      if (after.state === 'delivered') invalidInput();
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as orphaned
          where orphaned.org_id = ${ctx.orgId} and orphaned.id = ${deliveryId}
            and orphaned.state = 'sending' and orphaned.active_job_id = ${lease.id}
            and orphaned.active_fence < ${lease.fence})`),
        raw(sql`update notification_attempt set outcome = 'unknown', outcome_code = 'unknown',
            finished_at = ${now}
          where org_id = ${ctx.orgId} and delivery_id = ${deliveryId} and outcome = 'started'`),
        raw(sql`update notification_delivery set state = ${after.state},
            outcome_code = ${after.code ?? 'unknown'},
            next_attempt_at = coalesce(${after.next}, next_attempt_at), finished_at = ${after.finished},
            active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and state = 'sending'`),
        auditPendingStatement(ctx, event),
      ]);
    },
  };
}
