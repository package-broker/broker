import * as z from 'zod';
import {
  PROJECT_LIST_PREFIX_MAX_LENGTH,
  PROJECT_LIST_PREFIX_PATTERN,
} from '../../authz/project-list.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { TOKEN_MAX_SCOPES } from '../../authz/project-service.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const slug = z.string().regex(PROJECT_SLUG_PATTERN);
const projectParams = z.strictObject({ project: slug });
const tokenMaxScope = z.enum(TOKEN_MAX_SCOPES);
const status = z.enum(['active', 'archived']);

const listQuery = z.strictObject({
  q: z
    .string()
    .min(1)
    .max(PROJECT_LIST_PREFIX_MAX_LENGTH)
    .regex(PROJECT_LIST_PREFIX_PATTERN)
    .describe('Case-sensitive slug or name prefix; LIKE wildcards % and _ are refused.')
    .optional(),
  limit: z
    .string()
    .regex(/^([1-9][0-9]?|100)$/)
    .optional(),
  after: ulid.optional(),
  status: status.optional(),
});
const listResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      status,
      etag: z.string(),
    }),
  ),
  next: z.string().nullable(),
});
const createBody = z.strictObject({
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(1000),
  tokenMaxScope: tokenMaxScope.optional(),
  requirePublishApproval: z.boolean().optional(),
  initialRoleId: ulid.optional(),
});
const createResponse = z.strictObject({ id: z.string(), slug: z.string() });
const projectResponse = z.strictObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status,
  tokenMaxScope,
  requirePublishApproval: z.boolean(),
  revision: z.number().int(),
});
const updateBody = z.strictObject({
  name: z.string().min(1).max(1000).optional(),
  tokenMaxScope: tokenMaxScope.optional(),
  requirePublishApproval: z.boolean().optional(),
});

export const PROJECT_API_SPECS = [
  {
    method: 'GET',
    path: '/_pb/projects',
    permission: null,
    boundary: 'authenticated',
    service: 'ProjectListError',
    api: {
      operationId: 'listProjects',
      mcp: true,
      summary: 'List readable projects',
      tags: ['projects'],
      query: listQuery,
      responses: { 200: listResponse },
    },
  },
  {
    method: 'POST',
    path: '/_pb/projects',
    permission: 'org:projects:create',
    boundary: 'organization',
    service: 'ProjectError',
    api: {
      operationId: 'createProject',
      summary: 'Add a project',
      tags: ['projects'],
      body: createBody,
      responses: { 201: createResponse },
    },
  },
  {
    method: 'GET',
    path: '/_pb/projects/:project',
    permission: 'project:read',
    boundary: 'project',
    service: 'ProjectError',
    api: {
      operationId: 'getProject',
      mcp: true,
      summary: 'Read a project',
      tags: ['projects'],
      params: projectParams,
      responses: { 200: projectResponse },
    },
  },
  {
    method: 'PATCH',
    path: '/_pb/projects/:project',
    permission: 'project:settings:write',
    boundary: 'project',
    concurrency: 'if-match',
    service: 'ProjectError',
    api: {
      operationId: 'updateProject',
      summary: 'Change project settings',
      tags: ['projects'],
      params: projectParams,
      body: updateBody,
      responses: { 204: null },
    },
  },
  {
    method: 'POST',
    path: '/_pb/projects/:project/archive',
    permission: 'org:projects:archive',
    boundary: 'organization',
    concurrency: 'if-match',
    service: 'ProjectError',
    api: {
      operationId: 'archiveProject',
      summary: 'Archive a project',
      tags: ['projects'],
      params: projectParams,
      responses: { 204: null },
    },
  },
  {
    method: 'POST',
    path: '/_pb/projects/:project/restore',
    permission: 'org:projects:archive',
    boundary: 'organization',
    concurrency: 'if-match',
    service: 'ProjectError',
    api: {
      operationId: 'restoreProject',
      summary: 'Restore a project',
      tags: ['projects'],
      params: projectParams,
      responses: { 204: null },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
