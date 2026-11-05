import type { SessionService } from '../../auth/session.js';
import { authenticatedActorOf } from '../../authz/access-context.js';
import {
  MAX_NOTIFICATION_PAGE,
  NotificationRepositoryError,
  type NotificationDeliveryDetail,
  type NotificationDeliverySummary,
  type NotificationEndpointSummary,
  type NotificationReadRepository,
} from '../../db/notifications.js';
import type { NotificationEndpointService } from '../../notifications/endpoints.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import type { ApiRouteDeps } from './context.js';
import { NOTIFICATION_API_SPECS } from './notifications-schemas.js';

export interface NotificationRouteDeps extends ApiRouteDeps {
  readonly reads: NotificationReadRepository;
  readonly service: Pick<
    NotificationEndpointService,
    'create' | 'update' | 'enable' | 'disable' | 'delete'
  >;
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
}

/** The safe summary the API shows: configured flags only, never a destination or secret. */
export function endpointBody(summary: NotificationEndpointSummary) {
  return {
    id: summary.id,
    name: summary.name,
    method: summary.method,
    events: [...summary.events],
    packagePattern: summary.packagePattern,
    state: summary.state,
    disabledReason: summary.disabledReason,
    failureStreak: summary.failureStreak,
    revision: summary.revision,
    destinationConfigured: true as const,
    signingConfigured: true as const,
    headersConfigured: summary.headersConfigured,
    templateConfigured: summary.templateConfigured,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

function deliveryBody(delivery: NotificationDeliverySummary) {
  return {
    id: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    state: delivery.state,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastStatus: delivery.lastStatus,
    outcomeCode: delivery.outcomeCode,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
  };
}

function deliveryDetailBody(detail: NotificationDeliveryDetail) {
  return {
    ...deliveryBody(detail),
    history: detail.history.map((attempt) => ({
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      outcomeCode: attempt.outcomeCode,
      status: attempt.status,
      durationMs: attempt.durationMs,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    })),
  };
}

/** Notification configuration is for human sessions only; tokens never read or change it. */
export function humanProject(ctx: RequestContext) {
  if (ctx.org === null || ctx.projectId === null || authenticatedActorOf(ctx) === null) return null;
  return { org: ctx.org, projectId: ctx.projectId };
}

export async function readOutcome(run: () => Promise<ApiOutcome>): Promise<ApiOutcome> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof NotificationRepositoryError)) throw error;
    switch (error.code) {
      case 'invalid_request':
        return { error: 'invalid_request' };
      case 'not_found':
        return { error: 'not_found' };
      case 'forbidden':
        return { error: 'forbidden' };
      default:
        return { error: 'unavailable' };
    }
  }
}

const pageSize = (value: string | undefined) =>
  value === undefined ? MAX_NOTIFICATION_PAGE : Number(value);

export function notificationReadRoutes(deps: NotificationRouteDeps): readonly RouteDefinition[] {
  const [list, , get, , , , , deliveries, delivery] = NOTIFICATION_API_SPECS;
  return [
    apiRoute(list, async ({ ctx, query }) => {
      const scope = humanProject(ctx);
      if (scope === null) return { error: 'forbidden' };
      return readOutcome(async () => {
        const page = await deps.reads.listEndpoints(scope.org, scope.projectId, {
          limit: pageSize(query.limit),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return { status: 200, body: { items: page.items.map(endpointBody), next: page.next } };
      });
    }),
    apiRoute(get, async ({ ctx, params }) => {
      const scope = humanProject(ctx);
      if (scope === null) return { error: 'forbidden' };
      return readOutcome(async () => {
        const found = await deps.reads.getEndpoint(scope.org, scope.projectId, params.id);
        return found === null
          ? { error: 'not_found' }
          : { status: 200, body: endpointBody(found), etag: found.revision };
      });
    }),
    apiRoute(deliveries, async ({ ctx, params, query }) => {
      const scope = humanProject(ctx);
      if (scope === null) return { error: 'forbidden' };
      return readOutcome(async () => {
        const page = await deps.reads.listDeliveries(scope.org, scope.projectId, params.id, {
          limit: pageSize(query.limit),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.state === undefined ? {} : { state: query.state }),
        });
        return { status: 200, body: { items: page.items.map(deliveryBody), next: page.next } };
      });
    }),
    apiRoute(delivery, async ({ ctx, params }) => {
      const scope = humanProject(ctx);
      if (scope === null) return { error: 'forbidden' };
      return readOutcome(async () => {
        const found = await deps.reads.getDelivery(
          scope.org,
          scope.projectId,
          params.id,
          params.delivery,
        );
        return found === null
          ? { error: 'not_found' }
          : { status: 200, body: deliveryDetailBody(found) };
      });
    }),
  ];
}
