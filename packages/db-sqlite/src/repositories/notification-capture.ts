import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  MAX_NOTIFICATION_ENDPOINTS,
  MAX_OPERATION_EVENTS,
  notificationCapturePlan,
  sourceOverflowAudit,
  type CapturePlanInput,
  type NotificationEventType,
  type NotificationCapturePlan,
} from '@package-broker/core/db/notifications';
import { displayName } from '@package-broker/core/catalogue/names';
import { compile, db, newOpId } from '../kysely.js';
import { auditOperationStatement } from './audit-pending.js';
import { createJobRepository } from './job.js';
import { notificationFilterCondition } from './notification-filter.js';

export const MAX_RETAINED_EVENTS = 10_000;
export const MAX_RETAINED_DELIVERIES = 10_000;

const UUID = sql.raw(`lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
  || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1)
  || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`);

const unusedExecutor: SqlExecutor = {
  driver: 'none',
  all: () => Promise.reject(new Error('statement builder only')),
  batch: () => Promise.reject(new Error('statement builder only')),
};
const jobs = createJobRepository(unusedExecutor);

function raw(query: RawBuilder<unknown>): Statement {
  return compile({ compile: () => query.compile(db) });
}

const field = (path: string) => sql`json_extract(capture.value, ${`$.${path}`})`;

/** An enabled endpoint of the event's own active project selects the type and matches the stored key. */
function eligible(ctx: OrgContext): Expression<SqlBool> {
  return sql<SqlBool>`exists (select 1 from notification_endpoint as cap_ep
    join project as cap_project on cap_project.id = cap_ep.project_id and cap_project.org_id = ${ctx.orgId}
    where cap_ep.org_id = ${ctx.orgId} and cap_ep.project_id = ${field('projectId')}
      and cap_ep.state = 'enabled' and cap_project.status = 'active'
      and exists (select 1 from json_each(cap_ep.events_json) as cap_type where cap_type.value = ${field('type')})
      and ${notificationFilterCondition(sql`cap_ep.package_pattern`, field('key'))})
    and exists (select 1 from project_source as cap_ps
      join source as cap_source on cap_source.id = cap_ps.source_id and cap_source.org_id = ${ctx.orgId}
      where cap_ps.org_id = ${ctx.orgId} and cap_ps.project_id = ${field('projectId')}
        and cap_ps.source_id = ${field('sourceId')} and cap_source.status = 'active'
        and (cap_source.project_id is null or cap_source.project_id = cap_ps.project_id))`;
}

/** Oldest terminal deliveries (or emptied events) one capture removes when its organization is full. */
export const CAPTURE_PRUNE_LIMIT = MAX_OPERATION_EVENTS * MAX_NOTIFICATION_ENDPOINTS;

const needField = (path: string) => sql`json_extract(cap_need.value, ${`$.${path}`})`;

/** The deliveries this operation would insert: every eligible endpoint of every eligible event. */
function recipients(ctx: OrgContext, json: string): Expression<number> {
  return sql<number>`(select count(*) from json_each(${json}) as cap_need
    join notification_endpoint as cap_need_ep on cap_need_ep.project_id = ${needField('projectId')}
      and cap_need_ep.org_id = ${ctx.orgId}
    join project as cap_need_project on cap_need_project.id = cap_need_ep.project_id
      and cap_need_project.org_id = ${ctx.orgId}
    where cap_need_ep.state = 'enabled' and cap_need_project.status = 'active'
      and exists (select 1 from json_each(cap_need_ep.events_json) as cap_need_type where cap_need_type.value = ${needField('type')})
      and ${notificationFilterCondition(sql`cap_need_ep.package_pattern`, needField('key'))}
      and exists (select 1 from project_source as cap_need_ps
        join source as cap_need_source on cap_need_source.id = cap_need_ps.source_id and cap_need_source.org_id = ${ctx.orgId}
        where cap_need_ps.org_id = ${ctx.orgId} and cap_need_ps.project_id = cap_need_ep.project_id
          and cap_need_ps.source_id = ${needField('sourceId')} and cap_need_source.status = 'active'
          and (cap_need_source.project_id is null or cap_need_source.project_id = cap_need_ps.project_id)))`;
}

function orgRoom(ctx: OrgContext, events: Expression<number>, json: string): Expression<SqlBool> {
  return sql<SqlBool>`((select count(*) from notification_event as cap_events where cap_events.org_id = ${ctx.orgId}) + ${events} <= ${MAX_RETAINED_EVENTS}
    and (select count(*) from notification_delivery as cap_deliveries where cap_deliveries.org_id = ${ctx.orgId}) + ${recipients(ctx, json)} <= ${MAX_RETAINED_DELIVERIES})`;
}

/**
 * Prune-before-admit: while the organization lacks room for this operation, the oldest terminal
 * deliveries (their attempts cascade) and then the oldest events no delivery references go first.
 * The room checks are uncorrelated, so each delete decides once, before it removes anything.
 */
function pruneStatements(
  ctx: OrgContext,
  when: Expression<SqlBool>,
  full: Expression<SqlBool>,
): Statement[] {
  return [
    raw(sql`delete from notification_delivery where org_id = ${ctx.orgId} and id in (
        select cap_old_delivery.id from notification_delivery as cap_old_delivery
        where cap_old_delivery.org_id = ${ctx.orgId}
          and cap_old_delivery.state in ('delivered', 'failed', 'cancelled')
        order by cap_old_delivery.finished_at, cap_old_delivery.id limit ${CAPTURE_PRUNE_LIMIT})
      and (${when}) and ${full}`),
    raw(sql`delete from notification_event where org_id = ${ctx.orgId} and id in (
        select cap_old_event.id from notification_event as cap_old_event
        where cap_old_event.org_id = ${ctx.orgId}
          and not exists (select 1 from notification_delivery as cap_old_ref
            where cap_old_ref.org_id = ${ctx.orgId} and cap_old_ref.event_id = cap_old_event.id)
        order by cap_old_event.occurred_at, cap_old_event.id limit ${CAPTURE_PRUNE_LIMIT})
      and (${when}) and ${full}`),
  ];
}

/** The envelope name of a stored key; an undecodable key yields a name the event contract refuses. */
export function npmDisplayName(key: string): string {
  try {
    return displayName(key);
  } catch {
    return '';
  }
}

export type CaptureInput = Omit<CapturePlanInput, 'organizationId' | 'ulid'> & {
  readonly ulid?: () => string;
};

/** A plan the core contract refuses is a broker defect; the package mutation still commits. */
function planOf(ctx: OrgContext, input: CaptureInput): NotificationCapturePlan | null {
  try {
    return notificationCapturePlan({
      ...input,
      organizationId: ctx.orgId,
      ulid: input.ulid ?? newOpId,
    });
  } catch {
    return null;
  }
}

/**
 * Notification work committed with a package mutation: each event and its recipient snapshot are
 * inserted only when `when` (the mutation's own success condition, trusted repository SQL) holds;
 * an organization without capacity gets one overflow audit instead, never a failed mutation.
 */
export function notificationCaptureStatements(
  ctx: OrgContext,
  input: CaptureInput,
  when: Expression<SqlBool>,
  reserve: Statement = { sql: '0', params: [] },
): readonly Statement[] {
  const plan = planOf(ctx, input);
  if (plan === null) return [];
  const json = JSON.stringify(
    plan.events.map((event) => ({
      id: event.event.id,
      ordinal: event.ordinal,
      type: event.event.type,
      projectId: event.projectId,
      sourceId: event.sourceId,
      key: event.packageKey,
      payload: event.payloadJson,
    })),
  );
  const count = plan.events.length;
  const fits = count <= MAX_OPERATION_EVENTS;
  const fresh = sql<SqlBool>`not exists (select 1 from notification_event as cap_replay
    where cap_replay.org_id = ${ctx.orgId} and cap_replay.operation_id = ${plan.operationId})`;
  const demand = sql`(select count(*) as n from json_each(${json}) as capture where ${eligible(ctx)})`;
  const needed = sql<number>`cap_demand.n`;
  const full = sql<SqlBool>`${sql.lit(fits ? 1 : 0)} and ${fresh} and exists (select 1 from ${demand} as cap_demand
    where ${needed} > 0 and not ${orgRoom(ctx, needed, json)})`;
  const room = sql<SqlBool>`exists (select 1 from ${demand} as cap_demand where ${orgRoom(ctx, needed, json)})`;
  const events = raw(sql`insert into notification_event
      (org_id, project_id, id, operation_id, ordinal, event_type, source_id, package_key, payload_json, occurred_at)
    select ${ctx.orgId}, ${field('projectId')}, ${field('id')}, ${plan.operationId}, ${field('ordinal')},
      ${field('type')}, ${field('sourceId')}, ${field('key')}, ${field('payload')}, ${plan.occurredAt}
    from json_each(${json}) as capture
    where ${when} and ${fresh} and ${sql.lit(fits ? 1 : 0)} and ${room} and ${eligible(ctx)}
    on conflict do nothing`);
  const captured = sql`(select json_extract(value, '$.id') from json_each(${json}))`;
  const deliveries = raw(sql`insert into notification_delivery
      (org_id, project_id, id, event_id, endpoint_id, endpoint_revision, configuration_credential_id,
       next_attempt_at, expires_at, created_at)
    select cap_event.org_id, cap_event.project_id, ${UUID}, cap_event.id, cap_endpoint.id,
      cap_endpoint.revision, cap_endpoint.credential_id, cap_event.occurred_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', cap_event.occurred_at, '+24 hours'), cap_event.occurred_at
    from notification_event as cap_event
    join notification_endpoint as cap_endpoint on cap_endpoint.project_id = cap_event.project_id
      and cap_endpoint.org_id = ${ctx.orgId}
    where cap_event.org_id = ${ctx.orgId} and cap_event.operation_id = ${plan.operationId}
      and cap_event.id in ${captured} and cap_endpoint.state = 'enabled'
      and changes() = (select count(*) from notification_event as cap_fresh
        where cap_fresh.org_id = ${ctx.orgId} and cap_fresh.id in ${captured})
      and exists (select 1 from json_each(cap_endpoint.events_json) as cap_selected where cap_selected.value = cap_event.event_type)
      and ${notificationFilterCondition(sql`cap_endpoint.package_pattern`, sql`cap_event.package_key`)}
    on conflict do nothing`);
  const dispatch = jobs.enqueueStatements(
    ctx,
    plan.dispatch,
    sql`exists (select 1 from notification_delivery as cap_delivery
      where cap_delivery.org_id = ${ctx.orgId} and cap_delivery.event_id in ${captured})`,
  );
  const overflow = auditOperationStatement(
    ctx,
    plan.overflow,
    reserve,
    raw(sql`(${when}) and not exists (select 1 from notification_event as cap_kept
        where cap_kept.org_id = ${ctx.orgId} and cap_kept.operation_id = ${plan.operationId})
      and exists (select 1 from json_each(${json}) as capture where ${eligible(ctx)})`),
  );
  return [...pruneStatements(ctx, when, full), events, deliveries, ...dispatch, overflow];
}

/**
 * One overflow audit for a fan-out too large to capture, written when `when` holds and an enabled
 * endpoint of an active project attached to the source would have received one of the events.
 */
export function sourceOverflowStatements(
  ctx: OrgContext,
  input: {
    readonly operationId: string;
    readonly occurredAt: string;
    readonly sourceId: string;
    readonly packageKey: string;
    readonly eventTypes: readonly [NotificationEventType, ...NotificationEventType[]];
    readonly eventCount: number;
  },
  when: Expression<SqlBool>,
  reserve: Statement = { sql: '0', params: [] },
): readonly Statement[] {
  let audit;
  try {
    audit = sourceOverflowAudit({
      operationId: input.operationId,
      occurredAt: input.occurredAt,
      sourceId: input.sourceId,
      eventType: input.eventTypes[0],
      eventCount: input.eventCount,
      ulid: newOpId,
    });
  } catch {
    return [];
  }
  const types = JSON.stringify(input.eventTypes);
  return [
    auditOperationStatement(
      ctx,
      audit,
      reserve,
      raw(sql`(${when}) and exists (select 1 from notification_endpoint as over_ep
        join project as over_project on over_project.id = over_ep.project_id and over_project.org_id = ${ctx.orgId}
        join project_source as over_ps on over_ps.project_id = over_ep.project_id and over_ps.org_id = ${ctx.orgId}
        join source as over_source on over_source.id = over_ps.source_id and over_source.org_id = ${ctx.orgId}
        where over_ep.org_id = ${ctx.orgId} and over_ps.source_id = ${input.sourceId}
          and over_ep.state = 'enabled' and over_project.status = 'active' and over_source.status = 'active'
          and exists (select 1 from json_each(over_ep.events_json) as over_type
            where over_type.value in (select value from json_each(${types})))
          and ${notificationFilterCondition(sql`over_ep.package_pattern`, sql`${input.packageKey}`)})`),
    ),
  ];
}
