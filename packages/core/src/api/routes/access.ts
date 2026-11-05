import type { Administration, AdminResult } from '../../authz/administration.js';
import type { GrantRepository, OrganizationGrant } from '../../db/grants.js';
import type { Role } from '../../db/roles.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { callContext, revealsOrganizationGrantSubjects, type ApiRouteDeps } from './context.js';
import { ACCESS_SPECS } from './access-schemas.js';

export interface AccessRouteDeps extends ApiRouteDeps {
  readonly administration: Administration;
  readonly grants: Pick<GrantRepository, 'listOrganization'>;
}

const DEFAULT_LIMIT = 50;

function paged<T extends { readonly id: string }>(
  all: readonly T[],
  query: { readonly limit?: string | undefined; readonly after?: string | undefined },
) {
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const ordered = all
    .filter((item) => query.after === undefined || item.id > query.after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = ordered.slice(0, limit);
  return { items, next: ordered.length > limit ? items[limit - 1]!.id : null };
}

function listedSubject(subject: OrganizationGrant['subject'], reveal: boolean) {
  if (subject.type === 'email') {
    return reveal
      ? ({ type: 'email', value: subject.value, visibility: 'visible' } as const)
      : ({ type: 'email', visibility: 'redacted' } as const);
  }
  return reveal
    ? ({
        type: 'group',
        provider: subject.provider,
        value: subject.value,
        visibility: 'visible',
      } as const)
    : ({ type: 'group', provider: subject.provider, visibility: 'redacted' } as const);
}

function roleSummary(role: Role | undefined) {
  return role === undefined
    ? null
    : { id: role.id, name: role.name, permissions: [...role.permissions] };
}

function outcomeOf(result: AdminResult<unknown>) {
  return result.ok ? ({ status: 204 } as const) : ({ serviceError: result.error } as const);
}

export function accessRoutes(deps: AccessRouteDeps): readonly RouteDefinition[] {
  const { administration } = deps;
  return [
    apiRoute(ACCESS_SPECS.listRoles, async ({ ctx, query }) => {
      if (ctx.org === null) return { error: 'unavailable' };
      const roles = await administration.listRoles(ctx.org);
      return { status: 200, body: paged(roles, query) };
    }),
    apiRoute(ACCESS_SPECS.createRole, async ({ ctx, body }) => {
      const { org, actor, fence, call } = callContext(ctx, deps);
      const result = await administration.createRole(org, actor, fence, body, call);
      return result.ok
        ? { status: 201, body: { id: result.value.id } }
        : { serviceError: result.error };
    }),
    apiRoute(ACCESS_SPECS.updateRole, async ({ ctx, params, body, expectedRevision }) => {
      const { org, actor, fence, call } = callContext(ctx, deps, { role: expectedRevision! });
      const result =
        'name' in body
          ? await administration.renameRole(org, actor, fence, params.role, body.name, call)
          : await administration.setRolePermissions(
              org,
              actor,
              fence,
              params.role,
              body.permissions,
              call,
            );
      return outcomeOf(result);
    }),
    apiRoute(ACCESS_SPECS.deleteRole, async ({ ctx, params, expectedRevision }) => {
      const { org, actor, fence, call } = callContext(ctx, deps, { role: expectedRevision! });
      return outcomeOf(await administration.deleteRole(org, actor, fence, params.role, call));
    }),
    apiRoute(ACCESS_SPECS.listGrants, async ({ ctx, query }) => {
      if (ctx.org === null) return { error: 'unavailable' };
      const grants = await deps.grants.listOrganization(ctx.org);
      const { items, next } = paged(grants, query);
      const reveal = revealsOrganizationGrantSubjects(ctx);
      const roles = new Map(
        (await administration.listRoles(ctx.org))
          .filter((role) => role.scope === 'organization')
          .map((role) => [role.id, role]),
      );
      return {
        status: 200,
        body: {
          items: items.map(({ id, subject, roleId, createdAt, revision }) => ({
            id,
            subject: listedSubject(subject, reveal),
            roleId,
            role: roleSummary(roles.get(roleId)),
            createdAt,
            revision,
          })),
          next,
        },
      };
    }),
    apiRoute(ACCESS_SPECS.createGrant, async ({ ctx, body }) => {
      const { org, actor, fence, call } = callContext(ctx, deps);
      const result = await administration.grantOrganization(org, actor, fence, body, call);
      return result.ok
        ? { status: 201, body: { id: result.value.id } }
        : { serviceError: result.error };
    }),
    apiRoute(ACCESS_SPECS.changeGrant, async ({ ctx, params, body, expectedRevision }) => {
      const { org, actor, fence, call } = callContext(ctx, deps, { grant: expectedRevision! });
      return outcomeOf(
        await administration.changeGrantRole(org, actor, fence, params.grant, body.roleId, call),
      );
    }),
    apiRoute(ACCESS_SPECS.revokeGrant, async ({ ctx, params, expectedRevision }) => {
      const { org, actor, fence, call } = callContext(ctx, deps, { grant: expectedRevision! });
      return outcomeOf(
        await administration.revokeOrganizationGrant(org, actor, fence, params.grant, call),
      );
    }),
  ];
}
