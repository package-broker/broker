import { accessContextOf } from '../../authz/access-context.js';
import { isPermission } from '../../authz/permissions.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import {
  myPermissionsResponse,
  myProjectPermissionsResponse,
  projectPermissionsParams,
} from './permissions-schemas.js';

function permissionNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(isPermission))].sort();
}

export function myPermissionsRoute(): RouteDefinition {
  return apiRoute(
    {
      method: 'GET',
      path: '/_pb/me/permissions',
      boundary: 'authenticated',
      permission: null,
      api: {
        operationId: 'getMyPermissions',
        summary: 'Get caller organization permissions',
        tags: ['permissions'],
        responses: { 200: myPermissionsResponse },
      },
    },
    async ({ ctx }) => ({
      status: 200,
      body: {
        organization: permissionNames(accessContextOf(ctx)?.actor?.organizationPermissions ?? []),
      },
    }),
  );
}

export function myProjectPermissionsRoute(): RouteDefinition {
  return apiRoute(
    {
      method: 'GET',
      path: '/_pb/projects/:project/permissions',
      boundary: 'project',
      permission: 'project:read',
      api: {
        operationId: 'getMyProjectPermissions',
        summary: 'Get caller project permissions',
        tags: ['permissions'],
        params: projectPermissionsParams,
        responses: { 200: myProjectPermissionsResponse },
      },
    },
    async ({ ctx }) => {
      const actor = accessContextOf(ctx)?.actor;
      return {
        status: 200,
        body: {
          project: permissionNames([
            ...(actor?.projectPermissions ?? []),
            ...(actor?.organizationPermissions.filter((name) => name.startsWith('project:')) ?? []),
          ]),
        },
      };
    },
  );
}
