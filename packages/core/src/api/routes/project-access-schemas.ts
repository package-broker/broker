import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ulid = z.string().regex(ULID_PATTERN);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const collectionParams = z.strictObject({ project });
const grantParams = z.strictObject({ project, grant: ulid });

const subject = z.union([
  z.strictObject({ type: z.literal('email'), value: z.string().min(1).max(320) }),
  z.strictObject({
    type: z.literal('group'),
    provider: z.string().min(1).max(64),
    value: z.string().min(1).max(256),
  }),
]);

const createBody = z.strictObject({ subject, roleId: ulid });
const changeBody = z.strictObject({ roleId: ulid });
const created = z.strictObject({ id: ulid });

export const PROJECT_ACCESS_API_SPECS = [
  {
    method: 'POST',
    path: '/_pb/projects/:project/grants',
    boundary: 'project',
    permission: 'project:grants:write',
    service: 'AdminError',
    api: {
      operationId: 'createProjectGrant',
      summary: 'Grant project access',
      tags: ['project-access'],
      params: collectionParams,
      body: createBody,
      responses: { 201: created },
    },
  },
  {
    method: 'PATCH',
    path: '/_pb/projects/:project/grants/:grant',
    boundary: 'project',
    permission: 'project:grants:write',
    concurrency: 'if-match',
    service: 'AdminError',
    api: {
      operationId: 'changeProjectGrant',
      summary: 'Change the role of a project grant',
      tags: ['project-access'],
      params: grantParams,
      body: changeBody,
      responses: { 204: null },
    },
  },
  {
    method: 'DELETE',
    path: '/_pb/projects/:project/grants/:grant',
    boundary: 'project',
    allowArchived: true,
    permission: 'project:grants:write',
    concurrency: 'if-match',
    service: 'AdminError',
    api: {
      operationId: 'revokeProjectGrant',
      summary: 'Revoke a project grant',
      tags: ['project-access'],
      params: grantParams,
      responses: { 204: null },
    },
  },
] as const satisfies readonly ApiRouteSpec[];

export const PROJECT_GRANTS_LIST_API_SPEC = {
  method: 'GET',
  path: '/_pb/projects/:project/grants',
  boundary: 'project',
  permission: 'project:grants:read',
  api: {
    operationId: 'listProjectGrants',
    summary: 'List project grants and their principals',
    tags: ['project-access'],
    params: collectionParams,
    query: z.strictObject({
      limit: z
        .string()
        .regex(/^(?:[1-9][0-9]?|100)$/)
        .optional(),
      after: ulid.optional(),
    }),
    responses: {
      200: z.strictObject({
        items: z.array(
          z.strictObject({
            id: ulid,
            revision: z.number().int().positive(),
            createdAt: z.string(),
            principal: z.strictObject({
              kind: z.enum(['user', 'email', 'group']),
              id: z.string(),
              displayName: z.string(),
              provider: z.string().optional(),
              email: z.string().optional(),
            }),
            role: z.strictObject({ id: ulid, name: z.string(), permissions: z.array(z.string()) }),
          }),
        ),
        next: ulid.nullable(),
      }),
    },
  },
} as const satisfies ApiRouteSpec;
