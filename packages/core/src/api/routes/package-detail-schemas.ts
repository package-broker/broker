import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const PACKAGE_DETAIL_API_SPECS = [
  {
    method: 'GET',
    path: '/_pb/projects/:project/packages/:package/readme',
    boundary: 'package',
    permission: 'project:packages:read',
    api: {
      operationId: 'getProjectPackageReadme',
      summary: 'Read a visible package README',
      tags: ['packages'],
      params: z.strictObject({ project: z.string().regex(PROJECT_SLUG_PATTERN), package: id }),
      query: z.strictObject({ version: z.string().min(1).max(256).optional() }),
      responses: {
        200: z.strictObject({
          filename: z.string(),
          body: z.string().max(524288),
          contentType: z.string(),
          sizeBytes: z.number().int().nonnegative().max(524288),
        }),
      },
    },
  },
  {
    method: 'PATCH',
    path: '/_pb/packages/:package/access',
    boundary: 'self',
    permission: null,
    api: {
      operationId: 'updatePackageAccess',
      summary: 'Change package access for new projects',
      tags: ['packages'],
      params: z.strictObject({ package: id }),
      body: z.strictObject({
        visibleToNewProjects: z.boolean(),
        newProjectAccessMode: z.enum(['none', 'request']),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
      responses: {
        200: z.strictObject({
          visibleToNewProjects: z.boolean(),
          newProjectAccessMode: z.enum(['none', 'request']),
          revision: z.number().int().positive(),
        }),
        409: null,
      },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
