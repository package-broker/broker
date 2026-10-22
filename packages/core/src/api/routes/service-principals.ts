import type { SessionService } from '../../auth/session.js';
import type { OrgContext } from '../../db/port.js';
import { envelopeResponse } from '../../kernel/errors.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  requestHash,
  settleIdempotent,
  type IdempotencyRecord,
} from '../idempotency.js';
import type {
  ServicePrincipalService,
  ServicePrincipalStore,
  ServicePrincipalRecord,
} from '../../authz/service-principal-service.js';
import { isUlid } from '../../ids.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { SERVICE_ERROR_TABLE } from '../response.js';
import { apiRoute, type ApiOutcome, type RouteOutcome } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import {
  SERVICE_PRINCIPAL_ACTION_SPECS,
  createServicePrincipalSpec,
  listServicePrincipalsSpec,
  getServicePrincipalSpec,
  servicePrincipalResponse,
} from './service-principals-schemas.js';

export interface ServicePrincipalRouteDeps extends ApiRouteDeps {
  readonly servicePrincipals: ServicePrincipalService;
  readonly principals: Pick<ServicePrincipalStore, 'get'> & {
    list(
      ctx: OrgContext,
      input: {
        readonly limit: number;
        readonly after?: string;
        readonly projectId?: string;
        readonly includeProjects: boolean;
      },
    ): Promise<{ readonly items: readonly ServicePrincipalRecord[]; readonly next: string | null }>;
  };
  readonly sessions: Pick<SessionService, 'authenticate'>;
  readonly projects: {
    get(ctx: OrgContext, id: string): Promise<{ readonly status: 'active' | 'archived' } | null>;
  };
  readonly idempotency: {
    find(
      ctx: OrgContext,
      principalKey: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
}

export function servicePrincipalRoutes(
  deps: ServicePrincipalRouteDeps,
): readonly RouteDefinition[] {
  async function target(
    ctx: RequestContext,
    project: boolean,
    id: string,
    expected: Readonly<Record<string, number>>,
    action: 'permissions' | 'suspend' | 'restore',
    permissions: readonly string[] = [],
  ) {
    const context = project
      ? projectSessionCallContext(ctx, deps, expected)
      : { ...callContext(ctx, deps, expected), projectId: null };
    const principal = await deps.principals.get(context.org, id);
    if (principal === null) return null;
    if (project) return principal.projectId === context.projectId ? context : null;
    if (principal.projectId === null) return context;
    if (!context.actor.isOrganizationAdmin) return null;
    const narrowing =
      action === 'suspend' ||
      (action === 'permissions' &&
        permissions.every((name) => principal.permissions.includes(name)));
    return narrowing ? context : null;
  }

  const replayed = new WeakSet<RequestContext>();
  const create = apiRoute(createServicePrincipalSpec, async ({ ctx, body }) => {
    const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
    if (!key.ok || key.key === null) return { error: 'invalid_request' };
    const { org, actor, fence, call } = callContext(ctx, deps);
    const authenticated = await deps.sessions.authenticate(org, ctx.request);
    if (
      authenticated === null ||
      authenticated.session.id !== fence.sessionId ||
      authenticated.session.userId !== fence.userId
    ) {
      return { error: 'forbidden' };
    }
    const projectId = body.project ?? null;
    if (projectId !== null) {
      if (!actor.isOrganizationAdmin) return { error: 'not_found' };
      const project = await deps.projects.get(org, projectId);
      if (project?.status !== 'active') return { error: 'not_found' };
    }
    const principal = ctx.principal;
    if (principal === null) throw new TypeError('route requires a principal');
    const route = `POST ${createServicePrincipalSpec.path}`;
    const hash = await requestHash({ method: 'POST', route, params: {}, body });
    const now = deps.clock.now();
    const find = () =>
      deps.idempotency.find(org, principalKey(principal), key.key!, now.toISOString());
    const replay = (record: IdempotencyRecord): ApiOutcome => {
      const parsed = servicePrincipalResponse.safeParse(JSON.parse(record.responseJson) as unknown);
      if (!parsed.success) return { error: 'conflict' };
      replayed.add(ctx);
      return { status: 201, body: parsed.data, etag: parsed.data.revision };
    };
    const existing = await find();
    const decision = decideReplay(existing, hash, now);
    if (decision === 'mismatch') return { error: 'idempotency_mismatch' };
    if (decision === 'replay' && existing !== null) return replay(existing);
    const record = buildIdempotencyRecord({
      principal,
      key: key.key,
      route,
      hash,
      status: 201,
      response: {},
      now,
    });
    const settled = await settleIdempotent({
      record,
      hash,
      now,
      find,
      run: () =>
        deps.servicePrincipals.create(
          org,
          authenticated,
          actor,
          fence,
          { name: body.name, projectId, permissions: body.permissions },
          { ...call, idempotency: record },
        ),
      failed: (result) => !result.ok,
    });
    if (settled.kind === 'mismatch') return { error: 'idempotency_mismatch' };
    if (settled.kind === 'replay') return replay(settled.record);
    if (!settled.result.ok) return { serviceError: settled.result.error };
    return {
      status: 201,
      etag: 1,
      body: {
        id: settled.result.value.id,
        name: body.name,
        projectId,
        createdByUserId: actor.userId,
        status: 'active',
        revision: 1,
        permissions: settled.result.value.permissions,
      },
    };
  });

  const list = apiRoute(listServicePrincipalsSpec, async ({ ctx, query }) => {
    const { org, actor } = callContext(ctx, deps);
    if (query.project !== undefined) {
      if (!actor.isOrganizationAdmin) return { error: 'not_found' };
      const project = await deps.projects.get(org, query.project);
      if (project?.status !== 'active') return { error: 'not_found' };
    }
    const page = await deps.principals.list(org, {
      limit: query.limit === undefined ? 50 : Number(query.limit),
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.project === undefined ? {} : { projectId: query.project }),
      includeProjects: actor.isOrganizationAdmin,
    });
    return { status: 200, body: page };
  });

  const read = apiRoute(getServicePrincipalSpec, async ({ ctx, params }) => {
    const { org, actor } = callContext(ctx, deps);
    const principal = await deps.principals.get(org, params.principal);
    if (principal === null) return { error: 'not_found' };
    if (principal.projectId !== null) {
      if (!actor.isOrganizationAdmin) return { error: 'not_found' };
      const project = await deps.projects.get(org, principal.projectId);
      if (project?.status !== 'active') return { error: 'not_found' };
    }
    return { status: 200, body: principal, etag: principal.revision };
  });

  const actions = SERVICE_PRINCIPAL_ACTION_SPECS.map((spec) => {
    if (spec.method === 'PUT') {
      return apiRoute(
        spec,
        async ({ ctx, params, body, expectedRevision }): Promise<ApiOutcome> => {
          if (!isUlid(params.principal)) return { error: 'invalid_request' };
          const context = await target(
            ctx,
            spec.boundary === 'project',
            params.principal,
            { service_principal: expectedRevision! },
            'permissions',
            body.permissions,
          );
          if (context === null) return { error: 'not_found' };
          const result = await deps.servicePrincipals.setPermissions(
            context.org,
            context.actor,
            context.fence,
            params.principal,
            body.permissions,
            context.call,
          );
          return result.ok
            ? { status: 204 }
            : { error: SERVICE_ERROR_TABLE.ServicePrincipalError[result.error].code };
        },
      );
    }
    const restore = spec.path.endsWith('/restore');
    return apiRoute(
      spec,
      async ({ ctx, params, expectedRevision }): Promise<RouteOutcome<typeof spec>> => {
        if (!isUlid(params.principal)) return { error: 'invalid_request' };
        const context = await target(
          ctx,
          spec.boundary === 'project',
          params.principal,
          expectedRevision === null ? {} : { service_principal: expectedRevision },
          restore ? 'restore' : 'suspend',
        );
        if (context === null) return { error: 'not_found' };
        const result = await deps.servicePrincipals[restore ? 'restore' : 'suspend'](
          context.org,
          context.actor,
          context.fence,
          params.principal,
          context.call,
        );
        if (result.ok) return { status: 204 };
        return { serviceError: result.error };
      },
    );
  });
  return [...actions, create, list, read].map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      if (response.status === 404)
        return envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId);
      if (replayed.has(ctx)) response.headers.set('Idempotent-Replayed', 'true');
      return response;
    },
  }));
}
