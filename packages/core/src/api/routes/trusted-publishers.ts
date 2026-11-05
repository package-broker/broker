import { auditEvent } from '../../audit/actions.js';
import type { OrgContext } from '../../db/port.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { callContext, type ApiRouteDeps } from './context.js';
import { trustedPublisherInput } from './trusted-publishers-input.js';
import { trustedPublisherPrincipalName } from './trusted-publishers-name.js';
import { TRUSTED_PUBLISHER_API_SPECS } from './trusted-publishers-schemas.js';
import {
  TrustedPublisherError,
  type RepositoryIdentity,
  type TrustedPublisherStore,
} from './trusted-publishers-store.js';

export interface TrustedPublisherRouteDeps extends ApiRouteDeps {
  readonly store: TrustedPublisherStore;
  readonly lookup: (
    org: OrgContext,
    repository: string,
    signal: AbortSignal,
  ) => Promise<RepositoryIdentity | null>;
}
export function trustedPublisherRoutes(
  deps: TrustedPublisherRouteDeps,
): readonly RouteDefinition[] {
  async function result(run: () => Promise<ApiOutcome>): Promise<ApiOutcome> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TrustedPublisherError) return { error: error.code };
      throw error;
    }
  }
  function event(
    ctx: RequestContext,
    action: 'trusted_publisher.create' | 'trusted_publisher.update' | 'trusted_publisher.disable',
    id: string,
    repository: string,
    workflow: string,
  ) {
    const c = callContext(ctx, deps);
    const built = auditEvent({
      id: deps.ids.ulid(),
      now: deps.clock.now().toISOString(),
      action,
      actor: { type: 'user', id: c.actor.userId },
      context: c.call.audit,
      target: { type: 'trusted_publisher', id },
      changes: { repository: { new: repository }, workflow: { new: workflow } },
    });
    if (!built.ok) throw new TrustedPublisherError('invalid_request');
    return built.event;
  }
  const [list, create, update, disable] = TRUSTED_PUBLISHER_API_SPECS;
  const routes = [
    apiRoute(list, async ({ ctx, query }) =>
      result(async () => {
        const c = callContext(ctx, deps);
        return {
          status: 200,
          body: await deps.store.list(c.org, {
            limit: Number(query.limit ?? 50),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        };
      }),
    ),
    ...[create, update].map((spec) =>
      apiRoute(spec, async ({ ctx, body, params, expectedRevision }) =>
        result(async () => {
          const c = callContext(ctx, deps);
          if (!c.actor.permissions.has('org:packages:publish')) return { error: 'forbidden' };
          let input;
          try {
            input = trustedPublisherInput(body);
            await trustedPublisherPrincipalName(
              input.repository,
              input.workflow,
              input.packageName,
              input.environment,
            );
          } catch {
            throw new TrustedPublisherError('invalid_request');
          }
          let identity;
          try {
            identity = await deps.lookup(c.org, input.repository, ctx.request.signal);
          } catch {
            return { error: 'bad_gateway' };
          }
          if (identity === null) return { error: 'github_credentials_required' };
          const creating = spec.method === 'POST';
          const id = creating ? deps.ids.ulid() : params['id']!;
          const write = {
            id,
            input,
            identity,
            now: deps.clock.now().toISOString(),
            event: event(
              ctx,
              creating ? 'trusted_publisher.create' : 'trusted_publisher.update',
              id,
              input.repository,
              input.workflow,
            ),
          };
          const item = creating
            ? await deps.store.create(c.org, c.fence, { ...write, principalId: deps.ids.ulid() })
            : await deps.store.update(c.org, c.fence, {
                ...write,
                expectedRevision: expectedRevision!,
              });
          return { status: creating ? 201 : 200, body: item, etag: item.revision };
        }),
      ),
    ),
    apiRoute(disable, async ({ ctx, params, expectedRevision }) =>
      result(async () => {
        const c = callContext(ctx, deps);
        if (!c.actor.permissions.has('org:packages:publish')) return { error: 'forbidden' };
        const item = await deps.store.get(c.org, params.id);
        if (item === null) return { error: 'not_found' };
        await deps.store.disable(c.org, c.fence, {
          id: params.id,
          expectedRevision: expectedRevision!,
          now: deps.clock.now().toISOString(),
          event: event(ctx, 'trusted_publisher.disable', params.id, item.repository, item.workflow),
        });
        return { status: 204 };
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
