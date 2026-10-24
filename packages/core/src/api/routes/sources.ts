import type * as z from 'zod';
import type { SessionService } from '../../auth/session.js';
import {
  accessContextOf,
  organizationActorOf,
  projectActorOf,
} from '../../authz/access-context.js';
import type { Permission } from '../../authz/administration.js';
import type { OrgContext } from '../../db/port.js';
import type { SourceRepository } from '../../db/source.js';
import { isUlid } from '../../ids.js';
import { envelopeResponse } from '../../kernel/errors.js';
import { denialResponse } from '../../kernel/denial-page.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { CredentialError, parseCredentialMaterial } from '../../sources/credentials.js';
import type {
  SourceActor,
  SourceService,
  SourceServiceResult,
  SourceUpdateInput,
} from '../../sources/source-service.js';
import { apiRoute } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { ACCEPT_REMOVAL_API_SPEC, SOURCE_API_SPECS } from './sources-schemas.js';

export interface SourceRouteDeps extends ApiRouteDeps {
  readonly service: Omit<SourceService, 'acceptRemoval'> &
    Partial<Pick<SourceService, 'acceptRemoval'>>;
  readonly sources: Pick<SourceRepository, 'get'>;
  readonly projects: {
    get(
      ctx: OrgContext,
      id: string,
    ): Promise<{
      readonly status: 'active' | 'archived';
      readonly revision: number;
    } | null>;
  };
  readonly projectSources: {
    list(
      ctx: OrgContext,
      input: { readonly projectId: string },
    ): Promise<readonly { readonly sourceId: string; readonly precedence: number }[]>;
  };
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
}

type Changes = z.output<(typeof SOURCE_API_SPECS)[2]['api']['body']>;

function changes(body: Changes): SourceUpdateInput {
  const { config, ...rest } = body;
  return Object.fromEntries(
    Object.entries({
      ...rest,
      ...(config === undefined ? {} : { configJson: JSON.stringify(config) }),
    }).filter(([, value]) => value !== undefined),
  );
}

const problemPaths: Readonly<Record<string, string>> = {
  url: '/body/url',
  name: '/body/name',
  ecosystem: '/body/ecosystem',
  type: '/body/type',
  config: '/body/config',
  repository: '/body/config/repository',
  provider: '/body/config/provider',
  installationId: '/body/config/installationId',
  packageName: '/body/config/packageName',
  distHosts: '/body/config/distHosts',
  scopes: '/body/config/scopes',
  refs: '/body/config/refs',
  'refs.tags': '/body/config/refs/tags',
  'refs.branches': '/body/config/refs/branches',
  selection: '/body/config/selection',
  'selection.packages': '/body/config/selection/packages',
  'selection.patterns': '/body/config/selection/patterns',
  'selection.expandPatterns': '/body/config/selection/expandPatterns',
  mirrorsFallback: '/body/config/mirrorsFallback',
  githubToken: '/body/config/githubToken',
  userAgent: '/body/userAgent',
  pollIntervalSeconds: '/body/pollIntervalSeconds',
  removalPolicy: '/body/removalPolicy',
  retentionDaysOverride: '/body/retentionDaysOverride',
  defaultVisibleToNewProjects: '/body/defaultVisibleToNewProjects',
};

function failure(result: Extract<SourceServiceResult<unknown>, { ok: false }>) {
  if (result.error !== 'invalid_config') return { serviceError: result.error };
  return {
    error: 'invalid_request' as const,
    details: (result.problems ?? []).map(({ field }) => ({
      path: Object.hasOwn(problemPaths, field) ? problemPaths[field]! : '/body',
      code: 'invalid' as const,
    })),
  };
}

function writeContext(ctx: RequestContext, deps: ApiRouteDeps) {
  if (ctx.projectId === null) {
    const context = callContext(ctx, deps);
    return { ...context, actor: { kind: 'org', actor: context.actor } as const };
  }
  const context = projectSessionCallContext(ctx, deps);
  const actor = projectActorOf(ctx);
  if (actor === null) throw new TypeError('route requires a project session context');
  return { ...context, actor: { kind: 'project', actor } as const };
}

function reader(ctx: RequestContext): SourceActor {
  const actor = ctx.projectId === null ? organizationActorOf(ctx) : projectActorOf(ctx);
  if (actor?.kind === 'organization') return { kind: 'org', actor };
  if (actor?.kind === 'project') return { kind: 'project', actor };
  const access = accessContextOf(ctx);
  if (ctx.org === null || ctx.principal === null || access?.token == null) {
    throw new TypeError('route requires an authenticated access context');
  }
  // Source reads are authorized by the kernel; project visibility comes from its token snapshot.
  if (ctx.projectId === null)
    return {
      kind: 'org',
      ...(access.token.kind === 'pat' && access.token.projectMode !== 'all'
        ? { restrictTo: access.token.projectIds ?? [] }
        : {}),
      ...(access.token.kind === 'svc' && ctx.principal.kind === 'service'
        ? { servicePrincipalId: ctx.principal.id }
        : {}),
      actor: {
        kind: 'organization',
        userId: ctx.principal.id,
        isOrganizationAdmin:
          access.token.projectMode === 'all' && access.token.organizationAdmin === true,
        permissions: new Set<Permission>([
          'org:sources:read',
          ...(access.token.projectReadInherited === true ? (['project:read'] as const) : []),
        ]),
      },
    };
  return {
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

export function sourceRoutes(deps: SourceRouteDeps): readonly RouteDefinition[] {
  async function mutationPreflight(ctx: RequestContext, id: string) {
    if (ctx.org === null || !isUlid(id)) return { error: 'not_found' as const };
    if (ctx.projectId !== null) {
      const actor = projectActorOf(ctx);
      if (actor === null) throw new TypeError('route requires a project session context');
      const result = await deps.service.getVisible(
        ctx.org,
        { kind: 'project', actor },
        {
          projectId: ctx.projectId,
          sourceId: id,
        },
      );
      if (!result.ok) return failure(result);
      return result.value.projectId === ctx.projectId ? null : { error: 'forbidden' as const };
    }
    const source = await deps.sources.get(ctx.org, id);
    return source !== null && source.projectId === null ? null : { error: 'not_found' as const };
  }

  const [
    orgList,
    orgCreate,
    orgUpdate,
    orgPause,
    orgResume,
    orgCredential,
    orgSync,
    projectList,
    projectCreate,
    projectUpdate,
    projectPause,
    projectResume,
    projectCredential,
    projectSync,
  ] = SOURCE_API_SPECS;
  const groups = [
    [orgList, orgCreate, orgUpdate, orgPause, orgResume, orgCredential, orgSync],
    [
      projectList,
      projectCreate,
      projectUpdate,
      projectPause,
      projectResume,
      projectCredential,
      projectSync,
    ],
  ] as const;
  const routes = groups.flatMap(([list, create, update, pause, resume, credential, sync]) => {
    return [
      apiRoute(list, async ({ ctx, query }) => {
        const org = ctx.org;
        if (org === null) throw new TypeError('route requires an organization context');
        const project = ctx.projectId === null ? null : await deps.projects.get(org, ctx.projectId);
        if (ctx.projectId !== null && (project === null || project.status !== 'active'))
          return { error: 'not_found' };
        const result = await deps.service.list(org, reader(ctx), {
          ...(ctx.projectId === null ? {} : { projectId: ctx.projectId }),
          limit: query.limit === undefined ? 50 : Number(query.limit),
          cursor:
            query.after === undefined
              ? null
              : btoa(
                  encodeURIComponent(JSON.stringify([1, org.orgId, ctx.projectId, query.after])),
                ),
        });
        if (!result.ok) return failure(result);
        const next = result.value.next === null ? null : (result.value.items.at(-1)?.id ?? null);
        const attached =
          ctx.projectId === null
            ? null
            : new Map(
                (await deps.projectSources.list(org, { projectId: ctx.projectId })).map(
                  ({ sourceId, precedence }) => [sourceId, precedence],
                ),
              );
        const items =
          attached === null
            ? result.value.items
            : result.value.items.map((source) => {
                const precedence = attached.get(source.id);
                return {
                  ...source,
                  attached: precedence !== undefined,
                  ...(precedence === undefined ? {} : { precedence }),
                };
              });
        return {
          status: 200,
          body: { items, next },
          ...(project === null ? {} : { etag: project.revision }),
        };
      }),
      apiRoute(create, async ({ ctx, body }) => {
        const c = writeContext(ctx, deps);
        const result = await deps.service.create(c.org, c.actor, c.fence, {
          name: body.name,
          ecosystem: body.ecosystem,
          type: body.type,
          ...changes(body),
          projectId: ctx.projectId,
          url: body.url ?? null,
          configJson: JSON.stringify(body.config ?? {}),
        });
        return result.ok ? { status: 201, body: { id: result.value.id } } : failure(result);
      }),
      apiRoute(update, async ({ ctx, params, body }) => {
        const denied = await mutationPreflight(ctx, params.source);
        if (denied !== null) return denied;
        const c = writeContext(ctx, deps);
        const result = await deps.service.update(
          c.org,
          c.actor,
          c.fence,
          params.source,
          changes(body),
        );
        return result.ok ? { status: 204 } : failure(result);
      }),
      apiRoute(pause, async ({ ctx, params }) => {
        const denied = await mutationPreflight(ctx, params.source);
        if (denied !== null) return denied;
        const c = writeContext(ctx, deps);
        const result = await deps.service.pause(c.org, c.actor, c.fence, params.source, c.call);
        return result.ok ? { status: 204 } : failure(result);
      }),
      apiRoute(resume, async ({ ctx, params }) => {
        const denied = await mutationPreflight(ctx, params.source);
        if (denied !== null) return denied;
        const c = writeContext(ctx, deps);
        const result = await deps.service.resume(c.org, c.actor, c.fence, params.source);
        return result.ok ? { status: 204 } : failure(result);
      }),
      apiRoute(sync, async ({ ctx, params }) => {
        const denied = await mutationPreflight(ctx, params.source);
        if (denied !== null) return denied;
        const c = writeContext(ctx, deps);
        const result = await deps.service.syncNow(c.org, c.actor, c.fence, params.source, c.call);
        return result.ok ? { status: 202 } : failure(result);
      }),
      apiRoute(credential, async ({ ctx, params, body }) => {
        const denied = await mutationPreflight(ctx, params.source);
        if (denied !== null) return denied;
        const c = writeContext(ctx, deps);
        const authenticated = await deps.sessions.authenticate(c.org, ctx.request);
        if (
          authenticated === null ||
          authenticated.session.id !== c.fence.sessionId ||
          authenticated.session.userId !== c.fence.userId ||
          !deps.sessions.isReauthFresh(authenticated)
        ) {
          return { error: 'reauth_required' };
        }
        try {
          parseCredentialMaterial(body.kind, body.material);
        } catch (error) {
          if (!(error instanceof CredentialError)) throw error;
          return {
            error: 'invalid_request',
            details: [{ path: '/body/material', code: 'invalid' }],
          };
        }
        const result = await deps.service.update(c.org, c.actor, c.fence, params.source, {
          credential: { kind: body.kind, plaintext: body.material },
        });
        return result.ok ? { status: 204 } : failure(result);
      }),
    ];
  });
  const acceptRemoval = deps.service.acceptRemoval;
  if (acceptRemoval !== undefined) {
    routes.push(
      apiRoute(ACCEPT_REMOVAL_API_SPEC, async ({ ctx, params }) => {
        const c = callContext(ctx, deps);
        const result = await acceptRemoval(
          c.org,
          { kind: 'org', actor: c.actor },
          c.fence,
          params.source,
          c.call,
        );
        return result.ok ? { status: 204 } : failure(result);
      }),
    );
  }
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
