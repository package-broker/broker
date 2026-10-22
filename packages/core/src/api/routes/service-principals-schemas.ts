import * as z from 'zod';
import { PERMISSIONS } from '../../authz/permissions.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { SERVICE_PRINCIPAL_NAME_PATTERN } from '../../authz/service-principal-name.js';
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

export const SERVICE_PRINCIPAL_ACTION_SPECS = [...specs(false), ...specs(true)] as const;

export const servicePrincipalResponse = z.strictObject({
  id: principal,
  name: z.string(),
  projectId: principal.nullable(),
  createdByUserId: z.string(),
  status: z.enum(['active', 'suspended']),
  revision: z.number().int().min(1),
  permissions: z.array(z.string()),
});

export const createServicePrincipalSpec = {
  method: 'POST',
  path: '/_pb/service-principals',
  boundary: 'organization',
  permission: 'org:service-principals:write',
  service: 'ServicePrincipalError',
  api: {
    operationId: 'createServicePrincipal',
    summary: 'Add a service principal; requires Idempotency-Key and returns ETag',
    tags: ['service-principals'],
    body: z.strictObject({
      name: z.string().regex(SERVICE_PRINCIPAL_NAME_PATTERN),
      project: principal.optional(),
      permissions: permissionsBody.shape.permissions,
    }),
    responses: { 201: servicePrincipalResponse, 404: null, 409: null },
  },
} as const satisfies ApiRouteSpec;

export const listServicePrincipalsSpec = {
  method: 'GET',
  path: '/_pb/service-principals',
  boundary: 'organization',
  permission: 'org:service-principals:write',
  service: 'ServicePrincipalError',
  api: {
    operationId: 'listServicePrincipals',
    summary: 'List service principals',
    tags: ['service-principals'],
    query: z.strictObject({
      limit: z
        .string()
        .regex(/^([1-9][0-9]?|100)$/)
        .optional(),
      after: principal.optional(),
      project: principal.optional(),
    }),
    responses: {
      200: z.strictObject({ items: z.array(servicePrincipalResponse), next: principal.nullable() }),
      404: null,
    },
  },
} as const satisfies ApiRouteSpec;

export const getServicePrincipalSpec = {
  method: 'GET',
  path: '/_pb/service-principals/:principal',
  boundary: 'organization',
  permission: 'org:service-principals:write',
  service: 'ServicePrincipalError',
  api: {
    operationId: 'getServicePrincipal',
    summary: 'Read a service principal',
    tags: ['service-principals'],
    params: organizationParams,
    responses: { 200: servicePrincipalResponse },
  },
} as const satisfies ApiRouteSpec;

export const SERVICE_PRINCIPAL_API_SPECS = [
  ...SERVICE_PRINCIPAL_ACTION_SPECS,
  createServicePrincipalSpec,
  listServicePrincipalsSpec,
  getServicePrincipalSpec,
] as const;
