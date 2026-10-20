import * as z from 'zod';
import { MAX_PERSONAL_TOKEN_PROJECTS } from '../../authz/pat-service.js';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import { SCOPE_LEVELS } from '../../authz/scope.js';
import type { ApiRouteSpec } from '../route.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ulid = z.string().regex(ULID);
const timestamp = z.string();
const scope = z.enum(SCOPE_LEVELS);
const project = z.string().regex(PROJECT_SLUG_PATTERN);

const projectParams = z.strictObject({ project });
const tokenParams = z.strictObject({ token: ulid });
const projectTokenParams = z.strictObject({ project, token: ulid });

const expiry = {
  expiresAt: z.string().optional(),
  lifetimeDays: z.number().int().optional(),
};

const personalBody = z.strictObject({
  name: z.string(),
  scope,
  readOnly: z.boolean().optional(),
  ...expiry,
  projectMode: z.enum(['all', 'selected']),
  projectIds: z.array(z.string()).max(MAX_PERSONAL_TOKEN_PROJECTS),
});

const serviceBody = z.strictObject({
  servicePrincipalId: ulid,
  name: z.string(),
  scope,
  readOnly: z.boolean().optional(),
  ...expiry,
});

const issuedResponse = z.strictObject({ id: z.string(), token: z.string() });

const status = z.enum(['active', 'expired', 'revoked']);
const limit = z.string().regex(/^(?:[1-9][0-9]?|100)$/);
const listQuery = z.strictObject({
  limit: limit.optional(),
  after: ulid.optional(),
  status: status.optional(),
});
const organizationListQuery = z.strictObject({
  limit: limit.optional(),
  after: ulid.optional(),
  status: status.optional(),
  kind: z.enum(['pat', 'svc']).optional(),
});

const lifetimeKind = z.strictObject({ maxDays: z.number().int(), defaultDays: z.number().int() });
const tokenResponse = z.strictObject({
  id: z.string(),
  kind: z.enum(['pat', 'svc']),
  name: z.string(),
  scope,
  readOnly: z.boolean(),
  status,
  projectMode: z.enum(['all', 'selected']).nullable(),
  projectCount: z.number().int(),
  projectId: z.string().nullable(),
  userId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  servicePrincipalId: z.string().nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});

const listResponse = z.strictObject({
  items: z.array(tokenResponse),
  next: z.string().nullable(),
  lifetime: z.strictObject({ personal: lifetimeKind, service: lifetimeKind }),
});

export const createPersonalTokenSpec = {
  method: 'POST',
  path: '/_pb/me/tokens',
  boundary: 'self',
  permission: null,
  service: 'PersonalTokenError',
  api: {
    operationId: 'createPersonalToken',
    summary: 'Issue a personal access token',
    tags: ['tokens'],
    body: personalBody,
    responses: { 201: issuedResponse },
  },
} as const satisfies ApiRouteSpec;

export const createProjectTokenSpec = {
  method: 'POST',
  path: '/_pb/projects/:project/tokens',
  boundary: 'project',
  permission: 'project:tokens:create',
  service: 'ServiceTokenError',
  api: {
    operationId: 'createProjectToken',
    summary: 'Issue a project service token',
    tags: ['tokens'],
    params: projectParams,
    body: serviceBody,
    responses: { 201: issuedResponse },
  },
} as const satisfies ApiRouteSpec;

export const createOrganizationTokenSpec = {
  method: 'POST',
  path: '/_pb/tokens',
  boundary: 'organization',
  permission: 'org:service-principals:write',
  service: 'ServiceTokenError',
  api: {
    operationId: 'createOrganizationToken',
    summary: 'Issue an organization service token',
    tags: ['tokens'],
    body: serviceBody,
    responses: { 201: issuedResponse },
  },
} as const satisfies ApiRouteSpec;

export const listMyTokensSpec = {
  method: 'GET',
  path: '/_pb/me/tokens',
  boundary: 'self',
  permission: null,
  api: {
    operationId: 'listMyTokens',
    summary: 'List the caller personal access tokens',
    tags: ['tokens'],
    query: listQuery,
    responses: { 200: listResponse },
  },
} as const satisfies ApiRouteSpec;

export const listProjectTokensSpec = {
  method: 'GET',
  path: '/_pb/projects/:project/tokens',
  boundary: 'project',
  permission: 'project:tokens:read',
  api: {
    operationId: 'listProjectTokens',
    summary: 'List project tokens',
    tags: ['tokens'],
    params: projectParams,
    query: listQuery,
    responses: { 200: listResponse },
  },
} as const satisfies ApiRouteSpec;

export const listTokensSpec = {
  method: 'GET',
  path: '/_pb/tokens',
  boundary: 'organization',
  permission: 'org:tokens:read',
  api: {
    operationId: 'listTokens',
    summary: 'List organization tokens',
    tags: ['tokens'],
    query: organizationListQuery,
    responses: { 200: listResponse },
  },
} as const satisfies ApiRouteSpec;

export const revokeMyTokenSpec = {
  method: 'DELETE',
  path: '/_pb/me/tokens/:token',
  boundary: 'self',
  permission: null,
  service: 'TokenRevokeError',
  api: {
    operationId: 'revokeMyToken',
    summary: 'Revoke a personal access token',
    tags: ['tokens'],
    params: tokenParams,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

export const revokeProjectTokenSpec = {
  method: 'DELETE',
  path: '/_pb/projects/:project/tokens/:token',
  boundary: 'project',
  permission: 'project:tokens:revoke',
  service: 'TokenRevokeError',
  api: {
    operationId: 'revokeProjectToken',
    summary: 'Revoke a project token',
    tags: ['tokens'],
    params: projectTokenParams,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

export const revokeTokenSpec = {
  method: 'DELETE',
  path: '/_pb/tokens/:token',
  boundary: 'organization',
  permission: 'org:tokens:revoke',
  service: 'TokenRevokeError',
  api: {
    operationId: 'revokeToken',
    summary: 'Revoke an organization token',
    tags: ['tokens'],
    params: tokenParams,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

const rotateBody = z.strictObject({
  overlapDays: z.union([z.literal(0), z.literal(1), z.literal(7)]),
  name: z.string().optional(),
  ...expiry,
});
const rotatedResponse = z.strictObject({
  id: z.string(),
  token: z.string(),
  replacedTokenId: z.string(),
  replacedExpiresAt: timestamp,
});

export const getMyTokenSpec = {
  method: 'GET',
  path: '/_pb/me/tokens/:token',
  boundary: 'self',
  permission: null,
  api: {
    operationId: 'getMyToken',
    summary: 'Get a personal access token',
    tags: ['tokens'],
    params: tokenParams,
    responses: { 200: tokenResponse },
  },
} as const satisfies ApiRouteSpec;

export const getProjectTokenSpec = {
  method: 'GET',
  path: '/_pb/projects/:project/tokens/:token',
  boundary: 'project',
  permission: 'project:tokens:read',
  api: {
    operationId: 'getProjectToken',
    summary: 'Get a project token',
    tags: ['tokens'],
    params: projectTokenParams,
    responses: { 200: tokenResponse },
  },
} as const satisfies ApiRouteSpec;

export const getTokenSpec = {
  method: 'GET',
  path: '/_pb/tokens/:token',
  boundary: 'organization',
  permission: 'org:tokens:read',
  api: {
    operationId: 'getToken',
    summary: 'Get an organization token',
    tags: ['tokens'],
    params: tokenParams,
    responses: { 200: tokenResponse },
  },
} as const satisfies ApiRouteSpec;

export const rotateProjectTokenSpec = {
  method: 'POST',
  path: '/_pb/projects/:project/tokens/:token/rotate',
  boundary: 'project',
  permission: 'project:tokens:create',
  service: 'ServiceTokenError',
  api: {
    operationId: 'rotateProjectToken',
    summary: 'Rotate a project service token',
    tags: ['tokens'],
    params: projectTokenParams,
    body: rotateBody,
    responses: { 201: rotatedResponse, 409: null, 422: null },
  },
} as const satisfies ApiRouteSpec;

export const rotateTokenSpec = {
  method: 'POST',
  path: '/_pb/tokens/:token/rotate',
  boundary: 'organization',
  permission: 'org:service-principals:write',
  service: 'ServiceTokenError',
  api: {
    operationId: 'rotateToken',
    summary: 'Rotate an organization service token',
    tags: ['tokens'],
    params: tokenParams,
    body: rotateBody,
    responses: { 201: rotatedResponse, 409: null, 422: null },
  },
} as const satisfies ApiRouteSpec;

export const TOKEN_API_SPECS = [
  createPersonalTokenSpec,
  createProjectTokenSpec,
  createOrganizationTokenSpec,
  listMyTokensSpec,
  listProjectTokensSpec,
  listTokensSpec,
  revokeMyTokenSpec,
  revokeProjectTokenSpec,
  revokeTokenSpec,
] as const;

export const TOKEN_DETAIL_API_SPECS = [
  getMyTokenSpec,
  getProjectTokenSpec,
  getTokenSpec,
  rotateProjectTokenSpec,
  rotateTokenSpec,
] as const;
