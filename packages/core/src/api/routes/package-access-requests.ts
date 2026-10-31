import { auditEvent } from '../../audit/actions.js';
import {
  PackageAccessRequestError,
  type PackageAccessRequestRepository,
} from '../../db/publishes.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { PACKAGE_ACCESS_REQUEST_API_SPECS } from './package-access-requests-schemas.js';

export interface PackageAccessRequestRouteDeps extends ApiRouteDeps {
  readonly repository: PackageAccessRequestRepository;
}

async function result(run: () => Promise<ApiOutcome>): Promise<ApiOutcome> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof PackageAccessRequestError)) throw error;
    return { error: error.code };
  }
}

export function packageAccessRequestRoutes(
  deps: PackageAccessRequestRouteDeps,
): readonly RouteDefinition[] {
  const [create, list, approve, reject, requestable] = PACKAGE_ACCESS_REQUEST_API_SPECS;
  const routes = [
    apiRoute(create, async ({ ctx, body }) =>
      result(async () => {
        const c = projectSessionCallContext(ctx, deps);
        const now = deps.clock.now().toISOString();
        const event = auditEvent({
          id: deps.ids.ulid(),
          now,
          action: 'package.access_request',
          actor: { type: 'user', id: c.actor.userId },
          context: c.call.audit,
          target: { type: 'package', id: body.packageId },
          projectId: c.projectId,
          changes: {
            package: { new: body.packageId },
            project_id: { new: c.projectId },
            ...(body.reason === undefined ? {} : { reason: { new: body.reason } }),
          },
        });
        if (!event.ok) return { error: 'invalid_request' };
        const item = await deps.repository.request(c.org, c.fence, {
          id: deps.ids.ulid(),
          packageId: body.packageId,
          projectId: c.projectId,
          requestedByUserId: c.actor.userId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          now,
          expiresAt: new Date(Date.parse(now) + 30 * 86400_000).toISOString(),
          event: event.event,
        });
        return { status: 201, body: item, etag: item.revision };
      }),
    ),
    apiRoute(list, async ({ ctx, query }) =>
      result(async () => {
        if (ctx.org === null) return { error: 'not_found' };
        return {
          status: 200,
          body: await deps.repository.list(ctx.org, {
            limit: Number(query.limit ?? 50),
            ...(query.state === undefined ? {} : { state: query.state }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        };
      }),
    ),
    ...[approve, reject].map((spec, index) =>
      apiRoute(spec, async ({ ctx, params, body, expectedRevision }) =>
        result(async () => {
          const c = callContext(ctx, deps);
          const item = await deps.repository.get(c.org, params.id);
          if (item === null) return { error: 'not_found' };
          const state = index === 0 ? 'approved' : 'rejected';
          const now = deps.clock.now().toISOString();
          const event = auditEvent({
            id: deps.ids.ulid(),
            now,
            action: 'package.access_decide',
            actor: { type: 'user', id: c.actor.userId },
            context: c.call.audit,
            target: { type: 'package', id: item.packageId },
            projectId: item.projectId,
            changes: {
              package: { new: item.packageName },
              project_id: { new: item.projectId },
              state: { old: 'pending', new: state },
              ...(body.reason === undefined ? {} : { reason: { new: body.reason } }),
            },
          });
          if (!event.ok) return { error: 'invalid_request' };
          const decision = await deps.repository.decide(c.org, c.fence, {
            id: item.id,
            expectedRevision: expectedRevision!,
            state,
            decidedByUserId: c.actor.userId,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
            now,
            event: event.event,
          });
          if (!decision.changed) return { error: 'conflict' };
          const updated = await deps.repository.get(c.org, item.id);
          if (updated === null) return { error: 'unavailable' };
          return { status: 200, body: updated, etag: decision.revision };
        }),
      ),
    ),
    apiRoute(requestable, async ({ ctx, query }) =>
      result(async () => {
        if (ctx.org === null || ctx.projectId === null) return { error: 'not_found' };
        return {
          status: 200,
          body: await deps.repository.requestable(ctx.org, ctx.projectId, {
            limit: Number(query.limit ?? 50),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        };
      }),
    ),
  ];
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      response.headers.set('cache-control', 'no-store');
      return response;
    },
  }));
}
