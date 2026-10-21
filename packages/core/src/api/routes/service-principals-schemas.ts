import * as z from 'zod';
import { PERMISSIONS } from '../../authz/permissions.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const principal = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const organizationParams = z.strictObject({ principal });
const projectParams = z.strictObject({
  project: z.string().regex(PROJECT_SLUG_PATTERN),
  principal,
});
const permissionsBody = z.strictObject({
  permissions: z.array(z.enum(PERMISSIONS.map(({ name }) => name))),
});

function specs(project: boolean) {
  const path = `${project ? '/_pb/projects/:project' : '/_pb'}/service-principals/:principal`;
  const boundary = project ? 'project' : 'organization';
  const permission = project ? 'project:service-principals:write' : 'org:service-principals:write';
  const params = project ? projectParams : organizationParams;
  const subject = project ? 'ProjectServicePrincipal' : 'ServicePrincipal';
  return [
    {
      method: 'PUT',
      path: `${path}/permissions`,
      boundary,
      permission,
      concurrency: 'if-match',
      service: 'ServicePrincipalError',
      api: {
        operationId: `set${subject}Permissions`,
        summary: 'Set service principal permissions',
        tags: ['service-principals'],
        params,
        body: permissionsBody,
        responses: { 204: null },
      },
    },
    {
      method: 'POST',
      path: `${path}/suspend`,
      boundary,
      permission,
      service: 'ServicePrincipalError',
      api: {
        operationId: `suspend${subject}`,
        summary: 'Suspend service principal',
        tags: ['service-principals'],
        params,
        responses: { 204: null },
      },
    },
    {
      method: 'POST',
      path: `${path}/restore`,
      boundary,
      permission,
      concurrency: 'if-match',
      service: 'ServicePrincipalError',
      api: {
        operationId: `restore${subject}`,
        summary: 'Restore service principal',
        tags: ['service-principals'],
        params,
        responses: { 204: null },
      },
    },
  ] as const satisfies readonly ApiRouteSpec[];
}

export const SERVICE_PRINCIPAL_API_SPECS = [...specs(false), ...specs(true)] as const;
