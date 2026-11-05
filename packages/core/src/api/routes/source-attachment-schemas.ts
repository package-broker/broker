import { proxyClaimConflict } from './proxy-claims-schema.js';
import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const params = z.strictObject({ project: z.string().regex(PROJECT_SLUG_PATTERN), source: ulid });

export const SOURCE_ATTACHMENT_API_SPECS = [
  {
    method: 'PUT',
    path: '/_pb/projects/:project/sources/:source/attachment',
    boundary: 'project',
    permission: 'project:sources:write',
    service: 'VisibilityError',
    api: {
      operationId: 'attachSource',
      summary: 'Attach a source to a project',
      tags: ['sources'],
      params,
      body: z.strictObject({ precedence: z.number().int().min(0).max(10000).optional() }),
      responses: { 204: null, 409: proxyClaimConflict },
    },
  },
  {
    method: 'DELETE',
    path: '/_pb/projects/:project/sources/:source/attachment',
    boundary: 'project',
    permission: 'project:sources:write',
    service: 'VisibilityError',
    api: {
      operationId: 'detachSource',
      summary: 'Detach a source from a project',
      tags: ['sources'],
      params,
      responses: { 204: null },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
