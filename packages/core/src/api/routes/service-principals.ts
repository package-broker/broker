import type {
  ServicePrincipalService,
  ServicePrincipalStore,
} from '../../authz/service-principal-service.js';
import { isUlid } from '../../ids.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { SERVICE_ERROR_TABLE, type ApiErrorCode } from '../response.js';
import { apiRoute, IF_MATCH, type ApiOutcome } from '../route.js';
import { callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { SERVICE_PRINCIPAL_API_SPECS } from './service-principals-schemas.js';

export interface ServicePrincipalRouteDeps extends ApiRouteDeps {
  readonly servicePrincipals: ServicePrincipalService;
  readonly principals: Pick<ServicePrincipalStore, 'get'>;
}

function restoreRevision(ctx: RequestContext): number | ApiErrorCode {
  const header = ctx.request.headers.get('if-match');
  if (header === null) return 'precondition_required';
  const match = IF_MATCH.exec(header);
  const revision = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : 'invalid_request';
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

  return SERVICE_PRINCIPAL_API_SPECS.map((spec) => {
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
    return apiRoute(spec, async ({ ctx, params }): Promise<ApiOutcome> => {
      if (!isUlid(params.principal)) return { error: 'invalid_request' };
      const revision = restore ? restoreRevision(ctx) : null;
      if (typeof revision === 'string') return { error: revision };
      const context = await target(
        ctx,
        spec.boundary === 'project',
        params.principal,
        revision === null ? {} : { service_principal: revision },
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
      const error = SERVICE_ERROR_TABLE.ServicePrincipalError[result.error].code;
      return {
        error: restore && result.error === 'conflict' ? 'precondition_failed' : error,
      };
    });
  });
}
