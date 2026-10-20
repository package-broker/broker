import { accessContextOf } from '../../authz/access-context.js';
import type { Administration } from '../../authz/administration.js';
import type { TokenLifetimePolicy } from '../../authz/token-lifetime.js';
import type { OrganizationRepository } from '../../db/organization.js';
import type { UserRepository } from '../../db/users.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { callContext, type ApiRouteDeps } from './context.js';
import {
  getMeSpec,
  getOrganizationSpec,
  listUsersSpec,
  updateUserSpec,
} from './organization-schemas.js';

const DEFAULT_LIMIT = 50;

export interface OrganizationRouteDeps extends ApiRouteDeps {
  readonly organizations: Pick<OrganizationRepository, 'get'>;
  readonly users: Pick<UserRepository, 'list' | 'get'>;
  readonly administration: Pick<Administration, 'suspendUser' | 'reactivateUser'>;
  readonly lifetime: TokenLifetimePolicy;
}

export function organizationRoutes(deps: OrganizationRouteDeps): readonly RouteDefinition[] {
  return [
    apiRoute(getOrganizationSpec, async ({ ctx }): Promise<ApiOutcome> => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      const organization = await deps.organizations.get(ctx.org);
      if (organization === null) return { error: 'not_found' };
      const { settings } = organization;
      return {
        status: 200,
        body: {
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
          settings: {
            retentionRemovedUpstreamDays: settings.retentionRemovedUpstreamDays,
            tokenDefaultExpiryDays: settings.tokenDefaultExpiryDays,
            tokenMaxLifetimeDays: {
              personal: deps.lifetime.personal.maxDays,
              service: deps.lifetime.service.maxDays,
            },
          },
          createdAt: organization.createdAt,
          updatedAt: organization.updatedAt,
        },
      };
    }),

    apiRoute(listUsersSpec, async ({ ctx, query }): Promise<ApiOutcome> => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
      const rows = await deps.users.list(ctx.org, {
        afterId: query.after ?? null,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        status: 200,
        body: {
          items: page.map((user) => ({
            id: user.id,
            displayName: user.displayName,
            status: user.status,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
          })),
          next: rows.length > limit ? page[page.length - 1]!.id : null,
        },
      };
    }),

    apiRoute(updateUserSpec, async ({ ctx, params, body }) => {
      const context = callContext(ctx, deps);
      if (!context.actor.permissions.has('org:users:read')) return { error: 'not_found' };
      const args = [context.org, context.actor, context.fence, params.user, context.call] as const;
      const result =
        body.status === 'suspended'
          ? await deps.administration.suspendUser(...args)
          : await deps.administration.reactivateUser(...args);
      return result.ok ? { status: 204 } : { serviceError: result.error };
    }),

    apiRoute(getMeSpec, async ({ ctx }): Promise<ApiOutcome> => {
      const principal = accessContextOf(ctx)?.principal;
      if (ctx.org === null || principal === null || principal === undefined) {
        throw new TypeError('route requires an authenticated organization context');
      }
      const organization = await deps.organizations.get(ctx.org);
      if (organization === null) return { error: 'not_found' };
      const ownSession = accessContextOf(ctx)?.sessionId != null;
      const account =
        principal.kind === 'user' ? await deps.users.get(ctx.org, principal.id) : null;
      return {
        status: 200,
        body: {
          principal: { kind: principal.kind, id: principal.id },
          user:
            account === null
              ? null
              : {
                  id: account.id,
                  email: ownSession ? account.email : null,
                  displayName: account.displayName,
                },
          organization: { slug: organization.slug, name: organization.name },
        },
      };
    }),
  ];
}
