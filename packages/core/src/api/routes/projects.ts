import { accessContextOf } from '../../authz/access-context.js';
import { buildOrganizationActor, type ActorContext } from '../../authz/actor.js';
import type { ProjectActor } from '../../authz/project-actor.js';
import type { ProjectLister } from '../../authz/project-list.js';
import type { ProjectChanges, ProjectService } from '../../authz/project-service.js';
import type { OrgContext } from '../../db/port.js';
import { envelopeResponse } from '../../kernel/errors.js';
import { isUlid } from '../../ids.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import {
  buildIdempotencyRecord,
  parseIdempotencyKey,
  principalKey,
  requestHash,
  settleIdempotent,
  type IdempotencyRecord,
} from '../idempotency.js';
import { apiRoute, IF_MATCH, type ApiOutcome, type RouteOutcome } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { PROJECT_API_SPECS } from './projects-schemas.js';

export interface ProjectRouteDeps extends ApiRouteDeps {
  readonly lister: ProjectLister;
  readonly service: ProjectService;
  readonly projects: {
    get(ctx: OrgContext, id: string): Promise<ProjectView | null>;
    getBySlug(ctx: OrgContext, slug: string): Promise<ProjectView | null>;
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

export interface ProjectView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly tokenMaxScope: 'read' | 'write' | 'full';
  readonly requirePublishApproval: boolean;
  readonly revision: number;
}

function ifMatchRevision(
  ctx: RequestContext,
): number | 'precondition_required' | 'invalid_request' {
  const header = ctx.request.headers.get('if-match');
  if (header === null) return 'precondition_required';
  const match = IF_MATCH.exec(header);
  const revision = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : 'invalid_request';
}

function listActor(ctx: RequestContext): ActorContext | null {
  const access = accessContextOf(ctx);
  if (access === null) return null;
  if (access.actor !== null) return buildOrganizationActor('organization', access.actor);
  return null;
}

function projectActor(
  ctx: RequestContext,
  context: ReturnType<typeof projectSessionCallContext>,
): ProjectActor {
  const snapshot = accessContextOf(ctx)?.actor;
  if (snapshot === null || snapshot === undefined) {
    throw new TypeError('route requires a project session context');
  }
  const permissions = new Set([
    ...snapshot.organizationPermissions.filter((name) => name.startsWith('project:')),
    ...snapshot.projectPermissions,
  ]);
  return Object.freeze({
    kind: 'project',
    userId: context.actor.userId,
    orgId: context.org.orgId,
    projectId: context.projectId,
    permissions,
  });
}

function view(project: ProjectView) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    status: project.status,
    tokenMaxScope: project.tokenMaxScope,
    requirePublishApproval: project.requirePublishApproval,
    revision: project.revision,
  };
}

export function projectRoutes(deps: ProjectRouteDeps): readonly RouteDefinition[] {
  const replayed = new WeakSet<RequestContext>();
  const [listSpec, createSpec, getSpec, updateSpec, archiveSpec, restoreSpec] = PROJECT_API_SPECS;

  const list = apiRoute(listSpec, async ({ ctx, query }) => {
    const org = ctx.org;
    if (org === null) throw new TypeError('route requires an organization context');
    const actor = listActor(ctx);
    if (actor === null) return { status: 200, body: { items: [], next: null } };
    const result = await deps.lister.list(org, actor, {
      limit: query.limit === undefined ? 50 : Number(query.limit),
      status: query.status ?? 'active',
      ...(query.after === undefined ? {} : { afterId: query.after }),
    });
    if (!result.ok) return { serviceError: result.error };
    return { status: 200, body: { items: result.value.items, next: result.value.nextAfterId } };
  });

  const created = (
    result: Awaited<ReturnType<ProjectService['createProject']>>,
  ): RouteOutcome<typeof createSpec> =>
    result.ok
      ? { status: 201, body: { id: result.value.id, slug: result.value.slug } }
      : { serviceError: result.error };

  const create = apiRoute(
    createSpec,
    async ({ ctx, body }): Promise<RouteOutcome<typeof createSpec>> => {
      const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
      if (!key.ok) return { error: 'invalid_request' };
      const { org, actor, fence, call } = callContext(ctx, deps);
      const input = {
        slug: body.slug,
        name: body.name,
        ...(body.tokenMaxScope === undefined ? {} : { tokenMaxScope: body.tokenMaxScope }),
        ...(body.requirePublishApproval === undefined
          ? {}
          : { requirePublishApproval: body.requirePublishApproval }),
        ...(body.initialRoleId === undefined ? {} : { initialRoleId: body.initialRoleId }),
      };
      if (key.key === null) {
        return created(await deps.service.createProject(org, actor, fence, input, call));
      }
      const { principal } = ctx;
      if (principal === null) throw new TypeError('route requires a principal');
      const hash = await requestHash({
        method: createSpec.method,
        route: createSpec.path,
        params: {},
        body,
      });
      const now = deps.clock.now();
      const record = buildIdempotencyRecord({
        principal,
        key: key.key,
        route: createSpec.path,
        hash,
        status: 201,
        response: { slug: input.slug },
        now,
      });
      const settled = await settleIdempotent({
        record,
        hash,
        now,
        find: () =>
          deps.idempotency.find(org, principalKey(principal), key.key!, now.toISOString()),
        run: () =>
          deps.service.createProject(org, actor, fence, input, { ...call, idempotency: record }),
        failed: (result) => !result.ok,
      });
      if (settled.kind === 'mismatch') return { error: 'idempotency_mismatch' };
      if (settled.kind === 'result') return created(settled.result);
      const stored = JSON.parse(settled.record.responseJson) as { slug?: unknown };
      const winner =
        typeof stored.slug === 'string' ? await deps.projects.getBySlug(org, stored.slug) : null;
      if (winner === null) return { error: 'conflict' };
      replayed.add(ctx);
      return { status: 201, body: { id: winner.id, slug: winner.slug } };
    },
  );

  const get = apiRoute(getSpec, async ({ ctx }): Promise<ApiOutcome> => {
    const org = ctx.org;
    if (org === null || ctx.projectId === null) return { error: 'not_found' };
    const project = await deps.projects.get(org, ctx.projectId);
    if (project === null || project.status !== 'active') return { error: 'not_found' };
    return { status: 200, body: view(project), etag: project.revision };
  });

  const update = apiRoute(updateSpec, async ({ ctx, body, expectedRevision }) => {
    const changes: ProjectChanges = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.tokenMaxScope === undefined ? {} : { tokenMaxScope: body.tokenMaxScope }),
      ...(body.requirePublishApproval === undefined
        ? {}
        : { requirePublishApproval: body.requirePublishApproval }),
    };
    if (Object.keys(changes).length === 0) {
      return { error: 'invalid_request', details: [{ path: '/body', code: 'invalid' }] };
    }
    const context = projectSessionCallContext(ctx, deps, { project: expectedRevision! });
    const result = await deps.service.updateSettings(
      context.org,
      projectActor(ctx, context),
      context.fence,
      context.projectId,
      changes,
      context.call,
    );
    if (result.ok) return { status: 204 };
    return result.error === 'conflict'
      ? { error: 'precondition_failed' }
      : { serviceError: result.error };
  });

  const transition = (spec: typeof archiveSpec | typeof restoreSpec, restore: boolean) =>
    apiRoute(spec, async ({ ctx, params }): Promise<RouteOutcome<typeof spec>> => {
      const revision = ifMatchRevision(ctx);
      if (typeof revision === 'string') return { error: revision };
      const { org, actor, fence, call } = callContext(ctx, deps, { project: revision });
      const project = await deps.projects.getBySlug(org, params.project);
      if (project === null || !isUlid(project.id)) return { error: 'not_found' };
      const result = await deps.service[restore ? 'restoreProject' : 'archiveProject'](
        org,
        actor,
        fence,
        project.id,
        call,
      );
      if (result.ok) return { status: 204 };
      if (result.error === 'conflict') return { error: 'precondition_failed' };
      if (restore && result.error === 'forbidden') return { error: 'reauth_required' };
      return { serviceError: result.error };
    });

  const routes = [
    list,
    create,
    get,
    update,
    transition(archiveSpec, false),
    transition(restoreSpec, true),
  ];
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      if (response.status === 404) {
        return envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId);
      }
      if (replayed.has(ctx)) response.headers.set('Idempotent-Replayed', 'true');
      return response;
    },
  }));
}
