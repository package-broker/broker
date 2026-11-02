import {
  accessContextOf,
  authenticatedActorOf,
  projectActorOf,
} from '../../authz/access-context.js';
import { mutationFence } from '../../authz/fence.js';
import type { OrgContext } from '../../db/port.js';
import type { PolicyInspectService } from '../../registry/policy/inspect.js';
import type {
  PolicyCaller,
  PolicyManageError,
  PolicyManageService,
} from '../../registry/policy/manage.js';
import type { PolicyMemberService } from '../../registry/policy/manage-members.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type { IdempotencyRecord } from '../idempotency.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import { POLICY_API_SPECS } from './policies-schemas.js';

export interface PolicyRouteDeps extends ApiRouteDeps {
  readonly manage: PolicyManageService;
  readonly members: PolicyMemberService;
  readonly inspect: PolicyInspectService;
  readonly idempotency: {
    find(
      ctx: OrgContext,
      principalKey: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
}

const EMPTY: ReadonlySet<string> = new Set();

/** Field names of the policy input errors as the request body names them. */
const BODY_FIELDS: Readonly<Record<string, string>> = {
  packageKey: 'package',
  minAgeSeconds: 'minAgeDays',
  expectedRevision: 'revision',
  patch: '',
  scope: '',
  projectId: '',
  id: '',
  now: '',
  audit: '',
};

/** The caller of a policy route; only a human session ever receives a fence. */
export function policyCaller(ctx: RequestContext, deps: ApiRouteDeps): PolicyCaller {
  const access = accessContextOf(ctx);
  if (ctx.org === null || ctx.principal === null || access === null) {
    throw new TypeError('route requires an organization context');
  }
  const project = access.boundary === 'project';
  if (project && ctx.projectId === null) throw new TypeError('route requires a project');
  const authenticated = authenticatedActorOf(ctx);
  return {
    org: ctx.org,
    routeProjectId: project ? ctx.projectId : null,
    fence: authenticated === null ? null : mutationFence(authenticated, {}),
    principal: ctx.principal,
    organizationPermissions:
      authenticated === null ? EMPTY : new Set(access.actor?.organizationPermissions ?? []),
    projectPermissions:
      authenticated === null || !project ? EMPTY : (projectActorOf(ctx)?.permissions ?? EMPTY),
    audit: auditCall(ctx, deps).audit,
  };
}

export function policyFailure(error: PolicyManageError, field?: string): ApiOutcome {
  switch (error) {
    case 'invalid_request': {
      const name = field === undefined ? '' : (BODY_FIELDS[field] ?? field);
      return name === ''
        ? { error: 'invalid_request' }
        : { error: 'invalid_request', details: [{ path: `/body/${name}`, code: 'invalid' }] };
    }
    case 'limit_exceeded':
      return { error: 'conflict' };
    default:
      return { error };
  }
}

/** Wraps policy routes: management answers are never cached. */
export function noStore(
  routes: readonly RouteDefinition[],
  replayed?: WeakSet<RequestContext>,
): RouteDefinition[] {
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      response.headers.set('cache-control', 'no-store');
      if (replayed?.has(ctx) === true) response.headers.set('Idempotent-Replayed', 'true');
      return response;
    },
  }));
}

/** Route parameters after schema validation; every policy path declares the one it reads. */
export function paramOf(params: unknown, name: 'policy' | 'package'): string {
  const value = (params as Readonly<Record<string, unknown>>)[name];
  if (typeof value !== 'string') throw new TypeError('route parameter is missing');
  return value;
}

function listQueryOf(query: unknown): {
  readonly limit?: string;
  readonly after?: string;
  readonly project?: string;
} {
  return (query ?? {}) as { limit?: string; after?: string; project?: string };
}

export function policyReadRoutes(deps: PolicyRouteDeps): RouteDefinition[] {
  const specs = POLICY_API_SPECS;
  const routes: RouteDefinition[] = [];
  for (const spec of specs) {
    if (spec.method !== 'GET') continue;
    if (spec.path.endsWith('/packages/:package')) {
      routes.push(
        apiRoute(spec, async ({ ctx, params, query: raw }) => {
          const caller = policyCaller(ctx, deps);
          const query = listQueryOf(raw);
          const outcome = await deps.inspect.inspect(caller, {
            packageId: paramOf(params, 'package'),
            limit: query.limit === undefined ? 50 : Number(query.limit),
            ...(query.after === undefined ? {} : { after: query.after }),
          });
          return outcome.ok
            ? { status: 200, body: outcome.value }
            : policyFailure(outcome.error, outcome.field);
        }),
      );
    } else if (spec.path.endsWith('/:policy')) {
      routes.push(
        apiRoute(spec, async ({ ctx, params }) => {
          const outcome = await deps.manage.get(policyCaller(ctx, deps), paramOf(params, 'policy'));
          return outcome.ok
            ? { status: 200, body: outcome.value, etag: outcome.value.revision }
            : policyFailure(outcome.error, outcome.field);
        }),
      );
    } else {
      routes.push(
        apiRoute(spec, async ({ ctx, query: raw }) => {
          const caller = policyCaller(ctx, deps);
          const query = listQueryOf(raw);
          const projectId = caller.routeProjectId ?? query.project ?? null;
          const outcome = await deps.manage.list(caller, {
            projectId,
            limit: query.limit === undefined ? 50 : Number(query.limit),
            ...(query.after === undefined ? {} : { after: query.after }),
          });
          return outcome.ok
            ? { status: 200, body: outcome.value }
            : policyFailure(outcome.error, outcome.field);
        }),
      );
    }
  }
  return noStore(routes);
}
