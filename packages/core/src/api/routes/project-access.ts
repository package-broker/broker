import { projectActorOf } from '../../authz/access-context.js';
import type { MutationFence } from '../../authz/fence.js';
import { accessGrantFenceKey, roleFenceKey, type ProjectActor } from '../../authz/project-actor.js';
import type { ProjectAdministration } from '../../authz/project-administration.js';
import type { OrgContext } from '../../db/port.js';
import type { RoleRepository } from '../../db/roles.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type { ApiCall } from '../idempotency.js';
import { apiRoute } from '../route.js';
import { projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { PROJECT_ACCESS_API_SPECS } from './project-access-schemas.js';

export interface ProjectAccessRouteDeps extends ApiRouteDeps {
  readonly projectAdministration: ProjectAdministration;
  readonly roles: Pick<RoleRepository, 'get'>;
}

interface ProjectGrantCall {
  readonly org: OrgContext;
  readonly projectId: string;
  readonly actor: ProjectActor;
  readonly fence: MutationFence;
  readonly call: ApiCall;
}

function projectGrantCall(
  ctx: RequestContext,
  deps: ApiRouteDeps,
  expected: Readonly<Record<string, number>>,
): ProjectGrantCall {
  const { org, projectId, fence, call } = projectSessionCallContext(ctx, deps, expected);
  const actor = projectActorOf(ctx);
  if (actor === null || actor.userId !== fence.userId || actor.projectId !== projectId) {
    throw new TypeError('route requires a project session context');
  }
  return { org, projectId, actor, fence, call };
}

export function projectAccessRoutes(deps: ProjectAccessRouteDeps): readonly RouteDefinition[] {
  const [create, change, revoke] = PROJECT_ACCESS_API_SPECS;
  const { projectAdministration: service } = deps;

  return [
    apiRoute(create, async ({ ctx, body }) => {
      const c = projectGrantCall(ctx, deps, {});
      const result = await service.grant(c.org, c.actor, c.fence, c.projectId, body, c.call);
      return result.ok
        ? { status: 201, body: { id: result.value.id } }
        : { serviceError: result.error };
    }),
    apiRoute(change, async ({ ctx, params, body, expectedRevision }) => {
      const grantKey = accessGrantFenceKey(params.grant);
      const pending = projectGrantCall(ctx, deps, { [grantKey]: expectedRevision! });
      const role = await deps.roles.get(pending.org, body.roleId);
      if (role === null) return { serviceError: 'role_scope_mismatch' };
      const c = projectGrantCall(ctx, deps, {
        [grantKey]: expectedRevision!,
        [roleFenceKey(body.roleId)]: role.revision,
      });
      const result = await service.changeRole(
        c.org,
        c.actor,
        c.fence,
        c.projectId,
        params.grant,
        body.roleId,
        c.call,
      );
      return result.ok ? { status: 204 } : { serviceError: result.error };
    }),
    apiRoute(revoke, async ({ ctx, params, expectedRevision }) => {
      const c = projectGrantCall(ctx, deps, {
        [accessGrantFenceKey(params.grant)]: expectedRevision!,
      });
      const result = await service.revoke(
        c.org,
        c.actor,
        c.fence,
        c.projectId,
        params.grant,
        c.call,
      );
      return result.ok ? { status: 204 } : { serviceError: result.error };
    }),
  ];
}
