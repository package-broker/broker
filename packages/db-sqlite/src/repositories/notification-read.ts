import type { Selectable } from 'kysely';
import {
  MAX_NOTIFICATION_PAGE,
  NotificationRepositoryError,
  notificationDeliveryState,
  notificationEventSelection,
  type NotificationAttemptSummary,
  type NotificationDeliveryQuery,
  type NotificationDeliverySummary,
  type NotificationEndpointSummary,
  type NotificationPageQuery,
  type NotificationReadRepository,
} from '@package-broker/core/db/notifications';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import type { NotificationDeliveryTable, NotificationEndpointTable } from '../schema.js';

const ID = /^[0-9A-Za-z_-]{1,64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL: ReadonlySet<string> = new Set(['delivered', 'failed', 'cancelled']);

type EndpointRow = Selectable<NotificationEndpointTable>;
type DeliveryRow = Selectable<NotificationDeliveryTable> & { event_type: string };

function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new NotificationRepositoryError('invalid_request');
  return value;
}

function limit(query: NotificationPageQuery): number {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_NOTIFICATION_PAGE)
    throw new NotificationRepositoryError('invalid_request');
  return query.limit;
}

/** Delivery cursor `<created_at>~<id>`; it positions within the asked endpoint only. */
function deliveryCursor(cursor: string): { readonly createdAt: string; readonly id: string } {
  const [createdAt, deliveryId, extra] = cursor.split('~');
  if (
    extra !== undefined ||
    createdAt === undefined ||
    !INSTANT.test(createdAt) ||
    deliveryId === undefined
  )
    throw new NotificationRepositoryError('invalid_request');
  return { createdAt, id: id(deliveryId) };
}

function endpoint(row: EndpointRow): NotificationEndpointSummary {
  let events;
  try {
    events = notificationEventSelection(JSON.parse(row.events_json));
  } catch {
    throw new NotificationRepositoryError('unavailable');
  }
  if (row.state === 'deleted') throw new NotificationRepositoryError('unavailable');
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    method: row.method,
    events,
    packagePattern: row.package_pattern,
    state: row.state,
    disabledReason: row.disabled_reason,
    failureStreak: row.failure_streak,
    revision: row.revision,
    destinationConfigured: true,
    signingConfigured: true,
    headersConfigured: row.headers_configured === 1,
    templateConfigured: row.template_configured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function delivery(row: DeliveryRow): NotificationDeliverySummary {
  let eventType;
  try {
    [eventType] = notificationEventSelection([row.event_type]);
  } catch {
    throw new NotificationRepositoryError('unavailable');
  }
  return {
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    eventType: eventType!,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: TERMINAL.has(row.state) ? null : row.next_attempt_at,
    lastStatus: row.last_status,
    outcomeCode: row.outcome_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function endpoints(ctx: OrgContext, projectId: string) {
  return db
    .selectFrom('notification_endpoint as ne')
    .selectAll('ne')
    .where('ne.org_id', '=', ctx.orgId)
    .where('ne.project_id', '=', projectId)
    .where('ne.state', '<>', 'deleted');
}

function deliveries(ctx: OrgContext, projectId: string, endpointId: string) {
  return db
    .selectFrom('notification_delivery as nd')
    .innerJoin('notification_event as nv', (join) =>
      join
        .onRef('nv.org_id', '=', 'nd.org_id')
        .onRef('nv.project_id', '=', 'nd.project_id')
        .onRef('nv.id', '=', 'nd.event_id'),
    )
    .selectAll('nd')
    .select('nv.event_type')
    .where('nd.org_id', '=', ctx.orgId)
    .where('nd.project_id', '=', projectId)
    .where('nd.endpoint_id', '=', endpointId);
}

export function createNotificationReadRepository(
  executor: SqlExecutor,
): NotificationReadRepository {
  return {
    async listEndpoints(ctx, projectId, query) {
      const size = limit(query);
      let q = endpoints(ctx, id(projectId))
        .orderBy('ne.id')
        .limit(size + 1);
      if (query.cursor !== undefined) q = q.where('ne.id', '>', id(query.cursor));
      const rows = await executor.all<EndpointRow>(compile(q));
      const items = rows.slice(0, size).map(endpoint);
      return { items, next: rows.length > size ? items.at(-1)!.id : null };
    },

    async getEndpoint(ctx, projectId, endpointId) {
      const [row] = await executor.all<EndpointRow>(
        compile(endpoints(ctx, id(projectId)).where('ne.id', '=', id(endpointId))),
      );
      return row === undefined ? null : endpoint(row);
    },

    async listDeliveries(ctx, projectId, endpointId, query: NotificationDeliveryQuery) {
      const size = limit(query);
      const [retained] = await executor.all<{ id: string }>(
        compile(
          db
            .selectFrom('notification_endpoint')
            .select('id')
            .where('org_id', '=', ctx.orgId)
            .where('project_id', '=', id(projectId))
            .where('id', '=', id(endpointId)),
        ),
      );
      if (retained === undefined) throw new NotificationRepositoryError('not_found');
      let q = deliveries(ctx, id(projectId), id(endpointId))
        .orderBy('nd.created_at', 'desc')
        .orderBy('nd.id', 'desc')
        .limit(size + 1);
      if (query.state !== undefined)
        q = q.where('nd.state', '=', notificationDeliveryState(query.state));
      if (query.cursor !== undefined) {
        const after = deliveryCursor(query.cursor);
        q = q.where((eb) =>
          eb.or([
            eb('nd.created_at', '<', after.createdAt),
            eb.and([eb('nd.created_at', '=', after.createdAt), eb('nd.id', '<', after.id)]),
          ]),
        );
      }
      const rows = await executor.all<DeliveryRow>(compile(q));
      const items = rows.slice(0, size).map(delivery);
      const last = items.at(-1);
      return {
        items,
        next: rows.length > size && last !== undefined ? `${last.createdAt}~${last.id}` : null,
      };
    },

    async getDelivery(ctx, projectId, endpointId, deliveryId) {
      const [row] = await executor.all<DeliveryRow>(
        compile(deliveries(ctx, id(projectId), id(endpointId)).where('nd.id', '=', id(deliveryId))),
      );
      if (row === undefined) return null;
      const attempts = await executor.all<{
        attempt: number;
        outcome: NotificationAttemptSummary['outcome'];
        outcome_code: NotificationAttemptSummary['outcomeCode'];
        status: number | null;
        duration_ms: number | null;
        started_at: string;
        finished_at: string | null;
      }>(
        compile(
          db
            .selectFrom('notification_attempt as na')
            .select([
              'na.attempt',
              'na.outcome',
              'na.outcome_code',
              'na.status',
              'na.duration_ms',
              'na.started_at',
              'na.finished_at',
            ])
            .where('na.org_id', '=', ctx.orgId)
            .where('na.project_id', '=', row.project_id)
            .where('na.delivery_id', '=', row.id)
            .orderBy('na.attempt')
            .limit(8),
        ),
      );
      return {
        ...delivery(row),
        history: attempts.map((attempt) => ({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          outcomeCode: attempt.outcome_code,
          status: attempt.status,
          durationMs: attempt.duration_ms,
          startedAt: attempt.started_at,
          finishedAt: attempt.finished_at,
        })),
      };
    },
  };
}
