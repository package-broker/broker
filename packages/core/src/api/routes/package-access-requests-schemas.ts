import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { UTF8_REASON_CHECK } from '../utf8-reason.js';
import type { ApiRouteSpec } from '../route.js';
const accessReason = z
  .string()
  .max(1000)
  .regex(/^[\t\n\r\u0020-\u007e\u0080-\uffff]*$/)
  .check(UTF8_REASON_CHECK)
  .describe('At most 1000 UTF-8 bytes');
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const packageAccessRequest = z.strictObject({
  id,
  packageId: id,
  packageName: z.string(),
  requestedBy: z.strictObject({ type: z.literal('user'), name: z.string() }),
  decidedBy: z.strictObject({ name: z.string() }).nullable(),
  project: z.strictObject({ id, slug: z.string(), name: z.string() }),
  projectId: id,
  state: z.enum(['pending', 'approved', 'rejected', 'expired']),
  requestedByUserId: id,
  reason: z.string().nullable(),
  decidedByUserId: id.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  expiresAt: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const PACKAGE_ACCESS_REQUEST_SCHEMAS = {
  PackageAccessRequest: packageAccessRequest,
  PackageAccessRequestBody: z.strictObject({
    packageId: id,
    reason: accessReason.optional(),
  }),
  PackageAccessApproveBody: z.strictObject({ reason: accessReason.optional() }),
  PackageAccessRejectBody: z.strictObject({ reason: accessReason.min(1) }),
  PackageAccessRequestListQuery: z.strictObject({
    state: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
    cursor: z.string().max(512).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  }),
  PackageAccessRequestList: z.strictObject({
    items: z.array(packageAccessRequest),
    next: z.string().nullable(),
  }),
  RequestablePackage: z.strictObject({
    id,
    name: z.string(),
    newProjectAccessMode: z.literal('request'),
  }),
};

const schemas = PACKAGE_ACCESS_REQUEST_SCHEMAS;
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const requestableQuery = schemas.PackageAccessRequestListQuery.omit({ state: true });
function accessDecisionSpec(action: 'approve' | 'reject') {
  return {
    method: 'POST' as const,
    path: `/_pb/package-access-requests/:id/${action}`,
    boundary: 'organization' as const,
    permission: 'org:packages:manage',
    concurrency: 'if-match' as const,
    api: {
      operationId: `${action}PackageAccessRequest`,
      summary: `${action} a package access request`,
      tags: ['packages'],
      params: z.strictObject({ id }),
      body:
        action === 'approve' ? schemas.PackageAccessApproveBody : schemas.PackageAccessRejectBody,
      responses: { 200: packageAccessRequest },
    },
  } as const satisfies ApiRouteSpec;
}
export const PACKAGE_ACCESS_REQUEST_API_SPECS = [
  {
    method: 'POST',
    path: '/_pb/projects/:project/package-access-requests',
    boundary: 'project',
    permission: 'project:packages:manage',
    api: {
      operationId: 'requestPackageAccess',
      summary: 'Request package access; the hosted source must be attached to the project first',
      tags: ['packages'],
      params: z.strictObject({ project }),
      body: schemas.PackageAccessRequestBody,
      responses: { 201: packageAccessRequest, 409: null },
    },
  },
  {
    method: 'GET',
    path: '/_pb/package-access-requests',
    boundary: 'organization',
    permission: 'org:packages:read',
    api: {
      operationId: 'listPackageAccessRequests',
      summary: 'List package access requests',
      tags: ['packages'],
      query: schemas.PackageAccessRequestListQuery,
      responses: { 200: schemas.PackageAccessRequestList },
    },
  },
  accessDecisionSpec('approve'),
  accessDecisionSpec('reject'),
  {
    method: 'GET',
    path: '/_pb/projects/:project/requestable-packages',
    boundary: 'project',
    permission: 'project:packages:manage',
    api: {
      operationId: 'listRequestablePackages',
      summary: 'List requestable packages; the hosted source must be attached to the project first',
      tags: ['packages'],
      params: z.strictObject({ project }),
      query: requestableQuery,
      responses: {
        200: z.strictObject({
          items: z.array(schemas.RequestablePackage),
          next: z.string().nullable(),
        }),
      },
    },
  },
] as const satisfies readonly [
  ApiRouteSpec,
  ApiRouteSpec,
  ApiRouteSpec,
  ApiRouteSpec,
  ApiRouteSpec,
];
