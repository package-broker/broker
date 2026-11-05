import { accessContextOf } from '../../authz/access-context.js';
import { buildOrganizationActor } from '../../authz/actor.js';
import type { ProxyClaimDeps } from '../../sources/proxy-claims.js';
import { checkProxyClaims } from '../../sources/proxy-claims.js';
import type { VisibilityService } from '../../catalogue/visibility-service.js';
import type { OrgContext } from '../../db/port.js';
import type { SourceRepository } from '../../db/source.js';
import { isUlid } from '../../ids.js';
import { denialResponse } from '../../kernel/denial-page.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { SOURCE_ATTACHMENT_API_SPECS } from './source-attachment-schemas.js';

export interface SourceAttachmentRouteDeps extends ApiRouteDeps {
  readonly sources: Pick<SourceRepository, 'get'>;
  readonly proxyClaims?: ProxyClaimDeps;
  readonly visibility: Pick<VisibilityService, 'attachSource' | 'detachSource'>;
  readonly projectSources: {
    list(
      ctx: OrgContext,
      input: { readonly projectId: string },
    ): Promise<readonly { readonly sourceId: string }[]>;
  };
  readonly projects: {
    get(ctx: OrgContext, id: string): Promise<{ readonly status: 'active' | 'archived' } | null>;
  };
}

export function sourceAttachmentRoutes(
  deps: SourceAttachmentRouteDeps,
): readonly RouteDefinition[] {
  const [attach, detach] = SOURCE_ATTACHMENT_API_SPECS;
  const target = async (ctx: RequestContext, sourceId: string) => {
    if (ctx.org === null || ctx.projectId === null || !isUlid(ctx.projectId)) return null;
    const project = await deps.projects.get(ctx.org, ctx.projectId);
    if (project?.status !== 'active') return null;
    const source = await deps.sources.get(ctx.org, sourceId);
    if (source === null || (source.projectId !== null && source.projectId !== ctx.projectId))
      return null;
    return { projectId: ctx.projectId, source };
  };
  const routes = [
    apiRoute(attach, async ({ ctx, params, body }) => {
      const resolved = await target(ctx, params.source);
      if (resolved === null) return { error: 'not_found' };
      const { projectId, source } = resolved;
      const verifiedClaims: string[] = [];
      if (source.type === 'npmjs_proxy') {
        const actor = accessContextOf(ctx)?.actor;
        if (deps.proxyClaims === undefined) return { serviceError: 'conflict' };
        const conflictingClaims = await checkProxyClaims(
          deps.proxyClaims,
          ctx.org!,
          params.source,
          verifiedClaims,
        );
        if (conflictingClaims === null) return { serviceError: 'conflict' };
        if (conflictingClaims.length > 0)
          return actor != null &&
            buildOrganizationActor('organization', actor)?.permissions.has('org:sources:write')
            ? { error: 'conflict', conflictingClaims }
            : { serviceError: 'conflict' };
      }
      const c = projectSessionCallContext(ctx, deps);
      const result = await deps.visibility.attachSource(
        c.org,
        c.fence,
        {
          projectId,
          ...(source.type === 'npmjs_proxy' ? { verifiedClaims } : {}),
          sourceId: params.source,
          ...(body.precedence === undefined ? {} : { precedence: body.precedence }),
        },
        c.call,
      );
      return result.ok ? { status: 204 } : { serviceError: result.error };
    }),
    apiRoute(detach, async ({ ctx, params }) => {
      const resolved = await target(ctx, params.source);
      if (resolved === null) return { error: 'not_found' };
      const { projectId } = resolved;
      const attached = await deps.projectSources.list(ctx.org!, { projectId });
      if (!attached.some(({ sourceId }) => sourceId === params.source))
        return { error: 'not_found' };
      const c = projectSessionCallContext(ctx, deps);
      const result = await deps.visibility.detachSource(
        c.org,
        c.fence,
        { projectId, sourceId: params.source },
        c.call,
      );
      return result.ok ? { status: 204 } : { serviceError: result.error };
    }),
  ];
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      if (response.status === 403) {
        const body = (await response.clone().json()) as { error: { code: string } };
        if (body.error.code === 'forbidden') return denialResponse(ctx.request, ctx.requestId);
      }
      return response.status === 404
        ? envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId)
        : response;
    },
  }));
}
