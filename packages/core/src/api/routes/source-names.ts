import {
  accessContextOf,
  organizationActorOf,
  projectActorOf,
} from '../../authz/access-context.js';
import type { VisibilityService } from '../../catalogue/visibility-service.js';
import type { OrgContext } from '../../db/port.js';
import type { RegisteredNameRepository, SourceRepository } from '../../db/source.js';
import { isUlid } from '../../ids.js';
import { denialResponse } from '../../kernel/denial-page.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type {
  SourceActor,
  SourceService,
  SourceServiceResult,
} from '../../sources/source-service.js';
import { apiRoute } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { SOURCE_NAMES_API_SPECS } from './source-names-schemas.js';

export interface SourceNameRouteDeps extends ApiRouteDeps {
  readonly service: SourceService;
  readonly sources: Pick<SourceRepository, 'get'>;
  readonly registeredNames: Pick<RegisteredNameRepository, 'owner'>;
  readonly visibility: Pick<VisibilityService, 'setOrder'>;
  readonly projectSources: {
    /** Complete attachment set; excludes unattached project-owned sources. */
    list(
      ctx: OrgContext,
      input: { readonly projectId: string },
    ): Promise<readonly { readonly sourceId: string }[]>;
  };
  readonly projects: {
    get(
      ctx: OrgContext,
      id: string,
    ): Promise<{ readonly status: 'active' | 'archived'; readonly revision: number } | null>;
  };
}

function reader(ctx: RequestContext): SourceActor {
  const orgActor = organizationActorOf(ctx);
  if (orgActor !== null) return { kind: 'org', actor: orgActor };
  const projectActor = projectActorOf(ctx);
  if (projectActor !== null) return { kind: 'project', actor: projectActor };
  const access = accessContextOf(ctx);
  if (ctx.org === null || ctx.principal === null || access?.token == null)
    throw new TypeError('route requires an authenticated access context');
  return ctx.projectId === null
    ? {
        kind: 'org',
        actor: {
          kind: 'organization',
          userId: ctx.principal.id,
          isOrganizationAdmin: false,
          permissions: new Set(['org:sources:read']),
        },
      }
    : {
        kind: 'project',
        actor: {
          kind: 'project',
          userId: ctx.principal.id,
          orgId: ctx.org.orgId,
          projectId: ctx.projectId,
          permissions: new Set(['project:sources:read']),
        },
      };
}

function failure(result: Extract<SourceServiceResult<unknown>, { ok: false }>) {
  if (result.error === 'invalid_pattern' || result.error === 'invalid_name')
    return {
      error: 'invalid_request' as const,
      details: [
        {
          path: result.error === 'invalid_pattern' ? '/body/pattern' : '/query/name',
          code: 'invalid' as const,
        },
      ],
    };
  return { serviceError: result.error };
}

export function sourceNameRoutes(deps: SourceNameRouteDeps): readonly RouteDefinition[] {
  const [list, add, remove, enable, order, resolve, update] = SOURCE_NAMES_API_SPECS;
  const org = (ctx: RequestContext) => {
    if (ctx.org === null) throw new TypeError('route requires an organization context');
    return ctx.org;
  };
  const project = async (ctx: RequestContext) => {
    if (ctx.projectId === null || !isUlid(ctx.projectId)) return null;
    const row = await deps.projects.get(org(ctx), ctx.projectId);
    return row?.status === 'active' ? ctx.projectId : null;
  };
  const sourceForWrite = async (c: ReturnType<typeof callContext>, sourceId: string) => {
    const source = await deps.sources.get(c.org, sourceId);
    if (source === null) return { ok: false as const, error: 'not_found' as const };
    const actor: SourceActor =
      source.projectId === null
        ? { kind: 'org', actor: c.actor }
        : {
            kind: 'project',
            actor: {
              kind: 'project',
              userId: c.actor.userId,
              orgId: c.org.orgId,
              projectId: source.projectId,
              permissions: new Set(['project:sources:write']),
            },
          };
    if (actor.kind === 'project') {
      const visible = await deps.service.getVisible(c.org, actor, {
        projectId: actor.actor.projectId,
        sourceId,
      });
      if (!visible.ok) return visible;
    }
    return { ok: true as const, value: actor };
  };
  const routes = [
    apiRoute(update, async ({ ctx, params, body }) => {
      const c = callContext(ctx, deps);
      const source = await sourceForWrite(c, params.source);
      if (!source.ok) return failure(source);
      const result = await deps.service.addRegisteredName(
        c.org,
        { kind: 'org', actor: c.actor },
        c.fence,
        { sourceId: params.source, id: params.name, pattern: body.pattern },
        c.call,
      );
      return result.ok ? { status: 200, body: result.value } : failure(result);
    }),
    apiRoute(list, async ({ ctx, params, query }) => {
      const result = await deps.service.listRegisteredNames(org(ctx), reader(ctx), {
        sourceId: params.source,
        limit: query.limit === undefined ? 50 : Number(query.limit),
        ...(query.after === undefined ? {} : { after: query.after }),
      });
      return result.ok ? { status: 200, body: result.value } : failure(result);
    }),
    apiRoute(add, async ({ ctx, params, body }) => {
      const c = callContext(ctx, deps);
      const source = await sourceForWrite(c, params.source);
      if (!source.ok) return failure(source);
      const result = await deps.service.addRegisteredName(
        c.org,
        { kind: 'org', actor: c.actor },
        c.fence,
        { sourceId: params.source, pattern: body.pattern },
        c.call,
      );
      return result.ok ? { status: 201, body: result.value } : failure(result);
    }),
    apiRoute(remove, async ({ ctx, params }) => {
      const c = callContext(ctx, deps);
      const source = await sourceForWrite(c, params.source);
      if (!source.ok) return failure(source);
      const owner = await deps.registeredNames.owner(c.org, params.name);
      if (owner?.sourceId !== params.source) return { error: 'not_found' };
      const result = await deps.service.removeRegisteredName(
        c.org,
        { kind: 'org', actor: c.actor },
        c.fence,
        params.name,
        c.call,
      );
      return result.ok
        ? result.value.paused
          ? { status: 200, body: { paused: true } }
          : { status: 204 }
        : failure(result);
    }),
    apiRoute(enable, async ({ ctx, params }) => {
      const c = callContext(ctx, deps);
      const source = await sourceForWrite(c, params.source);
      if (!source.ok) return failure(source);
      const actor = source.value;
      const result = await deps.service.enable(c.org, actor, c.fence, params.source, c.call);
      if (!result.ok && result.error === 'forbidden' && actor.kind === 'project')
        return { error: 'not_found' };
      return result.ok ? { status: 204 } : failure(result);
    }),
    apiRoute(order, async ({ ctx, body, expectedRevision }) => {
      const projectId = await project(ctx);
      if (projectId === null) return { error: 'not_found' };
      if (new Set(body.sourceIds).size !== body.sourceIds.length)
        return {
          error: 'invalid_request',
          details: [{ path: '/body/sourceIds', code: 'invalid' }],
        };
      const attached = await deps.projectSources.list(org(ctx), { projectId });
      const attachedIds = new Set(attached.map(({ sourceId }) => sourceId));
      if (
        body.sourceIds.length > attachedIds.size ||
        body.sourceIds.some((id) => !attachedIds.has(id))
      )
        return { error: 'not_found' };
      if (body.sourceIds.length !== attachedIds.size) return { serviceError: 'conflict' };
      const c = projectSessionCallContext(ctx, deps, { project: expectedRevision! });
      try {
        const result = await deps.visibility.setOrder(
          c.org,
          c.fence,
          { projectId, sourceIds: body.sourceIds },
          c.call,
        );
        if (!result.ok && result.error === 'conflict') return { error: 'precondition_failed' };
        return result.ok ? { status: 204 } : { serviceError: result.error };
      } catch (error) {
        if (error instanceof TypeError && error.message === 'invalid visibility order size')
          return { serviceError: 'conflict' };
        throw error;
      }
    }),
    apiRoute(resolve, async ({ ctx, query }) => {
      const projectId = await project(ctx);
      if (projectId === null) return { error: 'not_found' };
      const ecosystem =
        query.name.startsWith('@') || !query.name.includes('/') ? 'npm' : 'composer';
      const result = await deps.service.preview(org(ctx), reader(ctx), {
        projectId,
        ecosystem,
        name: query.name,
      });
      if (!result.ok) return failure(result);
      const candidates = [];
      for (const candidate of result.value.candidates) {
        const source = await deps.sources.get(org(ctx), candidate.sourceId);
        if (source === null || (source.projectId !== null && source.projectId !== projectId))
          continue;
        candidates.push({
          sourceId: candidate.sourceId,
          sourceName: source.name,
          projectLevel: candidate.projectLevel,
          eligible: candidate.eligible,
        });
      }
      return {
        status: 200,
        body: {
          name: query.name,
          ecosystem,
          candidates,
          winner: candidates.find((candidate) => candidate.eligible)?.sourceId ?? null,
        },
      };
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
