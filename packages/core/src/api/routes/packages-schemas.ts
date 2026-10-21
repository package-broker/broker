import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const ecosystem = z.enum(['composer', 'npm']);
const status = z.enum(['active', 'quarantined', 'tombstoned', 'removed_upstream']);
const limit = z
  .string()
  .regex(/^(?:[1-9][0-9]?|100)$/)
  .optional();
const projectCursor = z
  .string()
  .max(437)
  .regex(/^(?:composer|npm):[\s\S]+$/);
const organizationCursor = z
  .string()
  .max(464)
  .regex(/^(?:composer|npm):[\s\S]+:[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const filters = {
  limit,
  status: status.optional(),
  source: ulid.optional(),
  ecosystem: ecosystem.optional(),
  q: z.string().min(1).max(100).optional(),
};
const packageItem = z.strictObject({
  id: ulid,
  ecosystem,
  name: z.string(),
  latestVersion: z.string().nullable(),
  status,
  source: z.strictObject({
    id: ulid,
    name: z.string(),
    type: z.enum([
      'vcs',
      'composer_repository',
      'npm_registry',
      'packagist_proxy',
      'npmjs_proxy',
      'hosted',
    ]),
    projectId: ulid.nullable(),
  }),
  versionCount: z.number().int().nonnegative(),
  lastSyncedAt: z.string().nullable(),
});
const versionItem = z.strictObject({
  id: ulid,
  version: z.string(),
  stability: z.enum(['dev', 'alpha', 'beta', 'RC', 'stable']),
  status: z.enum(['active', 'quarantined', 'tombstoned', 'removed_upstream', 'yanked']),
  publishedAt: z.string(),
  removedUpstreamAt: z.string().nullable(),
  tombstonedAt: z.string().nullable(),
  revision: z.number().int().positive(),
});

function scopeSpecs(boundary: 'project' | 'organization') {
  const scoped = boundary === 'project';
  const path = scoped ? '/_pb/projects/:project/packages' : '/_pb/packages';
  const permission = scoped ? 'project:packages:read' : 'org:sources:read';
  return [
    {
      method: 'GET',
      path,
      boundary,
      permission,
      api: {
        operationId: scoped ? 'listProjectPackages' : 'listPackages',
        summary: 'List packages',
        tags: ['packages'],
        ...(scoped ? { mcp: true } : {}),
        params: scoped ? z.strictObject({ project }) : z.strictObject({}),
        query: scoped
          ? z.strictObject({ ...filters, after: projectCursor.optional() })
          : z.strictObject({
              ...filters,
              after: organizationCursor.optional(),
              project: ulid.optional(),
            }),
        responses: {
          200: z.strictObject({
            items: z.array(packageItem),
            next: (scoped ? projectCursor : organizationCursor).nullable(),
          }),
        },
      },
    },
    {
      method: 'GET',
      path: `${path}/:package/versions`,
      boundary,
      permission,
      api: {
        operationId: scoped ? 'listProjectPackageVersions' : 'listPackageVersions',
        summary: 'List package versions',
        tags: ['packages'],
        ...(scoped ? { mcp: true } : {}),
        params: scoped
          ? z.strictObject({ project, package: z.string() })
          : z.strictObject({ package: z.string() }),
        query: z.strictObject({ limit, after: ulid.optional() }),
        responses: { 200: z.strictObject({ items: z.array(versionItem), next: ulid.nullable() }) },
      },
    },
  ] as const satisfies readonly ApiRouteSpec[];
}

export const PACKAGE_API_SPECS = [...scopeSpecs('project'), ...scopeSpecs('organization')] as const;
