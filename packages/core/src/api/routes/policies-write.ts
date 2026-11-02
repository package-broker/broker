import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type {
  PolicyCaller,
  PolicyIdempotency,
  PolicyManageOutcome,
  PolicyRuleView,
} from '../../registry/policy/manage.js';
import { parseIdempotencyKey, principalKey, requestHash } from '../idempotency.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import {
  noStore,
  paramOf,
  policyCaller,
  policyFailure,
  type PolicyRouteDeps,
} from './policies-read.js';
import { POLICY_API_SPECS } from './policies-schemas.js';

const UPDATE_FIELDS = [
  'minAgeDays',
  'clientMinVersion',
  'denyUnknown',
  'reasonCode',
  'incidentId',
  'expiresAt',
] as const;

function paramsOf(params: unknown): Readonly<Record<string, string>> {
  return params as Readonly<Record<string, string>>;
}

export function policyWriteRoutes(deps: PolicyRouteDeps): RouteDefinition[] {
  const replayed = new WeakSet<RequestContext>();

  async function idempotency(
    ctx: RequestContext,
    caller: PolicyCaller,
    method: string,
    path: string,
    params: Readonly<Record<string, string>>,
    body: unknown,
  ): Promise<PolicyIdempotency | null> {
    const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
    if (!key.ok || key.key === null) return null;
    const route = `${method} ${path}`;
    const hash = await requestHash({ method, route, params, body });
    const owner = principalKey(caller.principal);
    const token = key.key;
    return {
      key: token,
      route,
      hash,
      find: () => deps.idempotency.find(caller.org, owner, token, deps.clock.now().toISOString()),
    };
  }

  function answer(
    ctx: RequestContext,
    status: 200 | 201,
    outcome: PolicyManageOutcome<PolicyRuleView>,
  ): ApiOutcome {
    if (!outcome.ok) return policyFailure(outcome.error, outcome.field);
    if (outcome.replayed) replayed.add(ctx);
    return { status, body: outcome.value, etag: outcome.value.revision };
  }

  const routes: RouteDefinition[] = [];
  for (const spec of POLICY_API_SPECS) {
    if (spec.method === 'POST') {
      routes.push(
        apiRoute(spec, async ({ ctx, params, body }) => {
          const caller = policyCaller(ctx, deps);
          if (caller.fence === null) return { error: 'forbidden' };
          const key = await idempotency(
            ctx,
            caller,
            spec.method,
            spec.path,
            paramsOf(params),
            body,
          );
          if (key === null) return { error: 'invalid_request' };
          const outcome = await deps.manage.create(
            caller,
            {
              scope:
                caller.routeProjectId === null
                  ? { kind: 'organization' }
                  : { kind: 'project', projectId: caller.routeProjectId },
              ecosystem: body.ecosystem,
              package: body.package ?? null,
              kind: body.kind,
              minAgeDays: body.minAgeDays ?? null,
              clientFamily: body.clientFamily ?? null,
              clientMinVersion: body.clientMinVersion ?? null,
              denyUnknown: body.denyUnknown ?? false,
              reasonCode: body.reasonCode,
              incidentId: body.incidentId ?? null,
              expiresAt: body.expiresAt ?? null,
              members: body.members ?? [],
            },
            key,
          );
          return answer(ctx, 201, outcome);
        }),
      );
    } else if (spec.method === 'PATCH') {
      routes.push(
        apiRoute(spec, async ({ ctx, params, body, expectedRevision }) => {
          const caller = policyCaller(ctx, deps);
          if (caller.fence === null) return { error: 'forbidden' };
          const key = await idempotency(
            ctx,
            caller,
            spec.method,
            spec.path,
            paramsOf(params),
            body,
          );
          if (key === null) return { error: 'invalid_request' };
          const id = paramOf(params, 'policy');
          const revision = expectedRevision!;
          if ('members' in body) {
            return answer(
              ctx,
              200,
              await deps.members.replace(
                caller,
                id,
                revision,
                body.members,
                body.overrideReason,
                key,
              ),
            );
          }
          if ('state' in body) {
            const found = await deps.manage.managed(caller, id);
            if (!found.ok) return policyFailure(found.error, found.field);
            const outcome =
              found.rule.kind === 'quarantine'
                ? await deps.members.release(caller, id, revision, body.reason, key)
                : await deps.manage.disable(caller, id, revision, body.reason, key);
            return answer(ctx, 200, outcome);
          }
          if (!UPDATE_FIELDS.some((field) => body[field] !== undefined)) {
            return { error: 'invalid_request', details: [{ path: '/body', code: 'invalid' }] };
          }
          return answer(
            ctx,
            200,
            await deps.manage.update(
              caller,
              id,
              revision,
              {
                ...(body.minAgeDays === undefined ? {} : { minAgeDays: body.minAgeDays }),
                ...(body.clientMinVersion === undefined
                  ? {}
                  : { clientMinVersion: body.clientMinVersion }),
                ...(body.denyUnknown === undefined ? {} : { denyUnknown: body.denyUnknown }),
                ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
                ...(body.incidentId === undefined ? {} : { incidentId: body.incidentId }),
                ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
                ...(body.overrideReason === undefined
                  ? {}
                  : { overrideReason: body.overrideReason }),
              },
              key,
            ),
          );
        }),
      );
    }
  }
  return noStore(routes, replayed);
}
