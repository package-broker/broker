import { sql, type RawBuilder } from 'kysely';
import {
  validateAuditEvent,
  type AuditAction,
  type AuditEvent,
} from '@package-broker/core/audit/actions';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  NotificationRepositoryError,
  isNotificationDeliveryId,
  notificationDeliveryState,
  type NotificationAttemptRepository,
  type NotificationDeliveryRecord,
} from '@package-broker/core/db/notifications';
import type {
  OrgContext,
  SqlExecutor,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';
import { assertCheck, compile, db } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { createNotificationSettlement } from './notification-settle.js';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

export function invalidInput(): never {
  throw new NotificationRepositoryError('invalid_request');
}

export function deliveryIdOf(value: unknown): string {
  return isNotificationDeliveryId(value) ? value : invalidInput();
}

export function instantOf(value: unknown): string {
  return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value
    ? value
    : invalidInput();
}

export function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max
    ? (value as number)
    : invalidInput();
}

/** A system-actor delivery audit for this delivery; the repository never trusts its caller's shape. */
export function deliveryAudit(
  event: AuditEvent,
  action: AuditAction,
  deliveryId: string,
): AuditEvent {
  let checked: AuditEvent;
  try {
    checked = validateAuditEvent(event);
  } catch {
    return invalidInput();
  }
  if (
    checked.action !== action ||
    checked.actor.type !== 'system' ||
    checked.target.type !== 'notification_delivery' ||
    checked.target.id !== deliveryId
  )
    invalidInput();
  return checked;
}

/** The batch results, or null when a guard refused the batch. */
async function fencedResults(
  executor: SqlExecutor,
  statements: readonly Statement[],
): Promise<readonly StatementResult[] | null> {
  try {
    return await executor.batch(statements);
  } catch (error) {
    if (error instanceof DbError && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT)
      return null;
    throw error;
  }
}

export async function fenced(
  executor: SqlExecutor,
  statements: readonly Statement[],
): Promise<boolean> {
  return (await fencedResults(executor, statements)) !== null;
}

export interface DeliveryRow {
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

export function deliveryRecord(row: DeliveryRow): NotificationDeliveryRecord {
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
 * Reserves an attempt before any network call: counter, `started` row and audit commit together
 * under the delivery job's lease, and only while the endpoint still accepts this delivery.
 */
export function createNotificationAttemptRepository(
  executor: SqlExecutor,
): NotificationAttemptRepository {
  return {
    ...createNotificationSettlement(executor),

    async load(ctx: OrgContext, deliveryId: string): Promise<NotificationDeliveryRecord | null> {
      const id = deliveryIdOf(deliveryId);
      const [row] = await executor.all<DeliveryRow>(
        raw(sql`select load_delivery.*, (select max(load_attempt.finished_at) from notification_attempt as load_attempt
            where load_attempt.org_id = ${ctx.orgId} and load_attempt.delivery_id = load_delivery.id) as last_finished_at
          from notification_delivery as load_delivery
          where load_delivery.org_id = ${ctx.orgId} and load_delivery.id = ${id}`),
      );
      return row === undefined ? null : deliveryRecord(row);
    },

    async reserve(ctx, lease, input) {
      const deliveryId = deliveryIdOf(input.deliveryId);
      const expected = positive(input.expectedRevision);
      const now = instantOf(input.now);
      const event = deliveryAudit(input.event, 'notification.delivery_started', deliveryId);
      const ready = sql<boolean>`exists (select 1 from notification_delivery as reserve_delivery
        join notification_endpoint as reserve_endpoint on reserve_endpoint.id = reserve_delivery.endpoint_id
          and reserve_endpoint.org_id = ${ctx.orgId} and reserve_endpoint.project_id = reserve_delivery.project_id
        join project as reserve_project on reserve_project.id = reserve_delivery.project_id
          and reserve_project.org_id = ${ctx.orgId}
        where reserve_delivery.org_id = ${ctx.orgId} and reserve_delivery.id = ${deliveryId}
          and reserve_delivery.state = 'pending' and reserve_delivery.revision = ${expected}
          and reserve_delivery.active_job_id = ${lease.id}
          and reserve_delivery.attempts < ${MAX_NOTIFICATION_ATTEMPTS}
          and reserve_delivery.next_attempt_at <= ${now} and reserve_delivery.expires_at > ${now}
          and reserve_endpoint.state = 'enabled'
          and reserve_endpoint.revision = reserve_delivery.endpoint_revision
          and reserve_project.status = 'active'
          and exists (select 1 from notification_event as reserve_event
            join project_source as reserve_ps on reserve_ps.org_id = ${ctx.orgId}
              and reserve_ps.project_id = reserve_delivery.project_id
              and reserve_ps.source_id = reserve_event.source_id
            join source as reserve_source on reserve_source.org_id = ${ctx.orgId}
              and reserve_source.id = reserve_ps.source_id
            where reserve_event.org_id = ${ctx.orgId}
              and reserve_event.project_id = reserve_delivery.project_id
              and reserve_event.id = reserve_delivery.event_id
              and reserve_source.status = 'active'
              and (reserve_source.project_id is null or reserve_source.project_id = reserve_delivery.project_id))
          and not exists (select 1 from notification_delivery as reserve_busy
            where reserve_busy.org_id = ${ctx.orgId} and reserve_busy.endpoint_id = reserve_delivery.endpoint_id
              and reserve_busy.state = 'sending'))`;
      const head = [...jobLeaseGuard(ctx, lease), ...assertCheck(ready)];
      const results = await fencedResults(executor, [
        ...head,
        raw(sql`update notification_delivery set state = 'sending', attempts = attempts + 1,
            active_fence = ${lease.fence}, revision = revision + 1
          where org_id = ${ctx.orgId} and id = ${deliveryId} and revision = ${expected}
          returning attempts, revision`),
        raw(sql`insert into notification_attempt (org_id, project_id, delivery_id, attempt, job_id, fence, outcome, started_at)
          select started.org_id, started.project_id, started.id, started.attempts, ${lease.id}, ${lease.fence}, 'started', ${now}
          from notification_delivery as started where started.org_id = ${ctx.orgId} and started.id = ${deliveryId}`),
        ...assertCheck(sql<boolean>`(select audited.attempts from notification_delivery as audited
            where audited.org_id = ${ctx.orgId} and audited.id = ${deliveryId})
          = json_extract(${event.payloadJson}, '$.changes.attempt.new')`),
        auditPendingStatement(ctx, event),
      ]);
      const row = results?.[head.length]?.rows[0];
      return typeof row?.attempts === 'number' && typeof row.revision === 'number'
        ? { ok: true, attempt: row.attempts, revision: row.revision }
        : { ok: false };
    },
  };
}
