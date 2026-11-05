import * as z from 'zod';
import { MAX_NPM_NAME_LENGTH } from '../../catalogue/names.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { PATTERN_ALPHABET } from '../../catalogue/patterns.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const sourceParams = z.strictObject({ source: ulid });
const projectParams = z.strictObject({ project: z.string().regex(PROJECT_SLUG_PATTERN) });
const ecosystem = z.enum(['composer', 'npm']);
const registeredName = z.strictObject({ id: ulid, sourceId: ulid, ecosystem, pattern: z.string() });
const candidate = z.strictObject({
  sourceId: ulid,
  sourceName: z.string(),
  projectLevel: z.boolean(),
  eligible: z.boolean(),
});

export const SOURCE_NAMES_API_SPECS = [
  {
    method: 'GET',
    path: '/_pb/sources/:source/names',
    boundary: 'organization',
    permission: 'org:sources:read',
    service: 'SourceError',
    api: {
      operationId: 'listRegisteredNames',
      summary: 'List registered names',
      tags: ['sources'],
      params: sourceParams,
      query: z.strictObject({
        limit: z
          .string()
          .regex(/^(?:[1-9][0-9]?|100)$/)
          .optional(),
        after: ulid.optional(),
      }),
      responses: { 200: z.strictObject({ items: z.array(registeredName), next: ulid.nullable() }) },
    },
  },
  {
    method: 'POST',
    path: '/_pb/sources/:source/names',
    boundary: 'organization',
    permission: 'org:sources:write',
    service: 'SourceError',
    api: {
      operationId: 'addRegisteredName',
      summary: 'Register a name pattern',
      tags: ['sources'],
      params: sourceParams,
      body: z.strictObject({
        pattern: z
          .string()
          .max(MAX_NPM_NAME_LENGTH)
          .regex(PATTERN_ALPHABET)
          .describe(
            'For hosted npm sources, use an exact lowercase name or @scope/*. Scope claims hide public packages in the scope that are not yet cached.',
          ),
      }),
      responses: { 201: z.strictObject({ id: ulid }), 409: null },
    },
  },
  {
    method: 'DELETE',
    path: '/_pb/sources/:source/names/:name',
    boundary: 'organization',
    permission: 'org:sources:write',
    service: 'SourceError',
    api: {
      operationId: 'removeRegisteredName',
      summary: 'Remove a registered name',
      tags: ['sources'],
      params: z.strictObject({ source: ulid, name: ulid }),
      responses: { 204: null, 200: z.strictObject({ paused: z.literal(true) }) },
    },
  },
  {
    method: 'POST',
    path: '/_pb/sources/:source/enable',
    boundary: 'organization',
    permission: 'org:sources:write',
    service: 'SourceError',
    api: {
      operationId: 'enableSource',
      summary: 'Enable a source with registered names',
      tags: ['sources'],
      params: sourceParams,
      responses: { 204: null },
    },
  },
  {
    method: 'PUT',
    path: '/_pb/projects/:project/sources/order',
    boundary: 'project',
    permission: 'project:sources:write',
    service: 'VisibilityError',
    concurrency: 'if-match',
    api: {
      operationId: 'setSourceOrder',
      summary: 'Order all attached sources',
      tags: ['sources'],
      params: projectParams,
      body: z.strictObject({ sourceIds: z.array(ulid).min(1) }),
      responses: { 204: null },
    },
  },
  {
    method: 'GET',
    path: '/_pb/projects/:project/resolve',
    boundary: 'project',
    permission: 'project:sources:read',
    service: 'SourceError',
    api: {
      operationId: 'resolveName',
      summary: 'Preview source resolution for a package name',
      tags: ['sources'],
      params: projectParams,
      query: z.strictObject({ name: z.string().min(1).max(428) }),
      responses: {
        200: z.strictObject({
          name: z.string(),
          ecosystem,
          candidates: z.array(candidate),
          winner: ulid.nullable(),
        }),
      },
    },
  },
  {
    method: 'PATCH',
    path: '/_pb/sources/:source/names/:name',
    boundary: 'organization',
    permission: 'org:sources:write',
    service: 'SourceError',
    api: {
      operationId: 'updateRegisteredName',
      summary: 'Replace a hosted npm claim',
      tags: ['sources'],
      params: z.strictObject({ source: ulid, name: ulid }),
      body: z.strictObject({
        pattern: z
          .string()
          .max(MAX_NPM_NAME_LENGTH)
          .regex(PATTERN_ALPHABET)
          .describe(
            'For hosted npm sources, use an exact lowercase name or @scope/*. Scope claims hide public packages in the scope that are not yet cached.',
          ),
      }),
      responses: { 200: z.strictObject({ id: ulid }), 409: null },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
