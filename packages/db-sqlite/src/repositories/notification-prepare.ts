import { sql, type RawBuilder } from 'kysely';
import {
  NOTIFICATION_CANCEL_CODES,
  notificationEndpointState,
  notificationMethod,
  type NotificationPrepareRepository,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertCheck, compile, db } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import {
  deliveryAudit,
  deliveryIdOf,
  deliveryRecord,
  fenced,
  instantOf,
  invalidInput,
  positive,
  type DeliveryRow,
} from './notification-attempt.js';
import { failureStreakStatements } from './notification-settle.js';

const CREDENTIAL_ID = /^[0-9A-Z]{26}$/;
const FINISH_CODES = ['expired', 'attempt_limit', 'policy', 'credentials', 'template'] as const;

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

function member<T extends string>(values: readonly T[], value: unknown): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : invalidInput();
}

interface ContextRow extends DeliveryRow {
  payload_json: string;
  endpoint_state: string | null;
  endpoint_current_revision: number | null;
  endpoint_method: string | null;
  project_active: number;
  admitted: number;
}

/** The delivery is still pending, claimed by this job and unchanged since it was read. */
function claimed(ctx: OrgContext, lease: { id: string }, deliveryId: string, revision: number) {
  return assertCheck(sql<boolean>`exists (select 1 from notification_delivery as claimed
    where claimed.org_id = ${ctx.orgId} and claimed.id = ${deliveryId}
      and claimed.state = 'pending' and claimed.active_job_id = ${lease.id}
      and claimed.revision = ${revision})`);
}

/** The validated audit names this code as its reason, so the stored audit matches the write. */
function names(payloadJson: string, code: string): boolean {
  return payloadJson.includes(`"reason":{"new":${JSON.stringify(code)}}`);
}

/**
 * Decisions the delivery job takes on a pending delivery before any attempt: the read that
 * rechecks endpoint, project and source admission, and the writes that seal the body once,
 * cancel or fail it without a network call.
 */
export function createNotificationPrepareRepository(
  executor: SqlExecutor,
): NotificationPrepareRepository {
  return {
    async context(ctx, deliveryId) {
      const id = deliveryIdOf(deliveryId);
      const [row] = await executor.all<ContextRow>(
        raw(sql`select prep_delivery.*,
            (select max(prep_attempt.finished_at) from notification_attempt as prep_attempt
              where prep_attempt.org_id = ${ctx.orgId} and prep_attempt.delivery_id = prep_delivery.id) as last_finished_at,
            prep_event.payload_json,
            prep_endpoint.state as endpoint_state, prep_endpoint.revision as endpoint_current_revision,
            prep_endpoint.method as endpoint_method,
            exists (select 1 from project as prep_project where prep_project.org_id = ${ctx.orgId}
              and prep_project.id = prep_delivery.project_id and prep_project.status = 'active') as project_active,
            exists (select 1 from project_source as prep_ps
              join source as prep_source on prep_source.id = prep_ps.source_id and prep_source.org_id = ${ctx.orgId}
              where prep_ps.org_id = ${ctx.orgId} and prep_ps.project_id = prep_delivery.project_id
                and prep_ps.source_id = prep_event.source_id and prep_source.status = 'active'
                and (prep_source.project_id is null or prep_source.project_id = prep_ps.project_id)) as admitted
          from notification_delivery as prep_delivery
          join notification_event as prep_event on prep_event.org_id = ${ctx.orgId}
            and prep_event.project_id = prep_delivery.project_id and prep_event.id = prep_delivery.event_id
          left join notification_endpoint as prep_endpoint on prep_endpoint.org_id = ${ctx.orgId}
            and prep_endpoint.project_id = prep_delivery.project_id and prep_endpoint.id = prep_delivery.endpoint_id
          where prep_delivery.org_id = ${ctx.orgId} and prep_delivery.id = ${id}`),
      );
      if (row === undefined) return null;
      return {
        delivery: deliveryRecord(row),
        payloadJson: row.payload_json,
        endpoint:
          row.endpoint_state === null
            ? null
            : {
                state: notificationEndpointState(row.endpoint_state),
                revision: Number(row.endpoint_current_revision),
                method: notificationMethod(row.endpoint_method),
              },
        projectActive: Number(row.project_active) === 1,
        admitted: Number(row.admitted) === 1,
      };
    },

    async attachBody(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const credentialId =
        typeof input.credentialId === 'string' && CREDENTIAL_ID.test(input.credentialId)
          ? input.credentialId
          : invalidInput();
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...claimed(ctx, lease, deliveryId, expected),
        ...assertCheck(sql<boolean>`exists (select 1 from notification_delivery as unsealed
          where unsealed.org_id = ${ctx.orgId} and unsealed.id = ${deliveryId}
            and unsealed.body_credential_id is null)`),
        input.statement,
        raw(sql`update notification_delivery set body_credential_id = ${credentialId}
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}
            and body_credential_id is null`),
      ]);
    },

    async cancel(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const code = member(NOTIFICATION_CANCEL_CODES, input.code);
      const event = deliveryAudit(input.event, 'notification.delivery_cancelled', deliveryId);
      if (!names(event.payloadJson, code)) invalidInput();
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...claimed(ctx, lease, deliveryId, expected),
        raw(sql`update notification_delivery set state = 'cancelled', outcome_code = ${code},
            finished_at = ${now}, active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
        auditPendingStatement(ctx, event),
      ]);
    },

    async finish(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const code = member(FINISH_CODES, input.code);
      const disable =
        input.disable === null ? null : member(['credentials', 'policy'] as const, input.disable);
      const event = deliveryAudit(input.event, 'notification.delivery_finished', deliveryId);
      if (!names(event.payloadJson, code)) invalidInput();
      const [snapshot] = await executor.all<{
        endpoint_id: string;
        project_id: string;
        endpoint_revision: number;
      }>(
        raw(sql`select finish_snapshot.endpoint_id, finish_snapshot.project_id, finish_snapshot.endpoint_revision
          from notification_delivery as finish_snapshot
          where finish_snapshot.org_id = ${ctx.orgId} and finish_snapshot.id = ${deliveryId}`),
      );
      if (snapshot === undefined) return false;
      const payload = JSON.parse(event.payloadJson) as { op_id: string; request_id: string };
      return fenced(executor, [
        ...jobLeaseGuard(ctx, lease),
        ...claimed(ctx, lease, deliveryId, expected),
        raw(sql`update notification_delivery set state = 'failed', outcome_code = ${code},
            finished_at = ${now}, active_fence = null, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}`),
        ...(code === 'template'
          ? []
          : failureStreakStatements(ctx, {
              snapshot,
              disable,
              now,
              opId: payload.op_id,
              requestId: payload.request_id,
            })),
        auditPendingStatement(ctx, event),
      ]);
    },
  };
}
