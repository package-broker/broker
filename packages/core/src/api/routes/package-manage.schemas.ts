import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { PackageVersionAction } from '../../catalogue/package-manage-service.js';
import type { ApiRouteSpec } from '../route.js';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const version = z.strictObject({
  id,
  status: z.enum(['active', 'removed_upstream', 'yanked', 'quarantined', 'tombstoned']),
});

export function packageManageSpec(
  action: PackageVersionAction | 'rebuild',
  boundary: 'organization' | 'project' = 'organization',
) {
  const scoped = boundary === 'project';
  return {
    method: 'POST',
    path: `${scoped ? '/_pb/projects/:project' : '/_pb'}/packages/:package/versions/:version/${action}`,
    boundary,
    permission: scoped ? 'project:packages:manage' : 'org:packages:manage',
    api: {
      operationId: `${action}${scoped ? 'Project' : ''}PackageVersion`,
      summary: `${action} a package version`,
      tags: ['packages'],
      params: scoped
        ? z.strictObject({ project, package: id, version: id })
        : z.strictObject({ package: id, version: id }),
      body:
        action === 'tombstone'
          ? z.strictObject({ reason: z.string().min(1).max(1000).optional() }).optional()
          : z.strictObject({}).optional(),
      responses: {
        200:
          action === 'rebuild'
            ? z.strictObject({ id, status: z.literal('rebuild_requested') })
            : version,
      },
    },
  } as const satisfies ApiRouteSpec;
}
