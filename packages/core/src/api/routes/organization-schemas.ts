import * as z from 'zod';
import type { ApiRouteSpec } from '../route.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const timestamp = z.string();
const ulid = z.string().regex(ULID);

const organizationResponse = z.strictObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  settings: z.strictObject({
    retentionRemovedUpstreamDays: z.number().int(),
    tokenDefaultExpiryDays: z.number().int(),
    tokenMaxLifetimeDays: z.strictObject({
      personal: z.number().int(),
      service: z.number().int(),
    }),
  }),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const usersQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9][0-9]?|100)$/)
    .optional(),
  after: ulid.optional(),
});
const usersResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      displayName: z.string().nullable(),
      status: z.enum(['active', 'suspended']),
      lastLoginAt: timestamp.nullable(),
      createdAt: timestamp,
    }),
  ),
  next: z.string().nullable(),
});

const userParams = z.strictObject({ user: ulid });
const userBody = z.strictObject({ status: z.enum(['active', 'suspended']) });

const meResponse = z.strictObject({
  principal: z.strictObject({ kind: z.enum(['user', 'service', 'customer']), id: z.string() }),
  user: z
    .strictObject({
      id: z.string(),
      email: z.string().nullable(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  organization: z.strictObject({ slug: z.string(), name: z.string() }),
});

export const getOrganizationSpec = {
  method: 'GET',
  path: '/_pb/organization',
  boundary: 'organization',
  permission: 'org:read',
  api: {
    operationId: 'getOrganization',
    summary: 'Get the organization',
    tags: ['organization'],
    responses: { 200: organizationResponse },
  },
} as const satisfies ApiRouteSpec;

export const listUsersSpec = {
  method: 'GET',
  path: '/_pb/users',
  boundary: 'organization',
  permission: 'org:users:read',
  api: {
    operationId: 'listUsers',
    summary: 'List organization users',
    tags: ['users'],
    query: usersQuery,
    responses: { 200: usersResponse },
  },
} as const satisfies ApiRouteSpec;

export const updateUserSpec = {
  method: 'PATCH',
  path: '/_pb/users/:user',
  boundary: 'organization',
  permission: 'org:users:write',
  service: 'AdminError',
  api: {
    operationId: 'updateUser',
    summary: 'Suspend or reactivate a user',
    tags: ['users'],
    params: userParams,
    body: userBody,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

export const getMeSpec = {
  method: 'GET',
  path: '/_pb/me',
  boundary: 'authenticated',
  permission: null,
  api: {
    operationId: 'getMe',
    summary: 'Get the caller identity',
    tags: ['me'],
    responses: { 200: meResponse },
  },
} as const satisfies ApiRouteSpec;

export const ORGANIZATION_API_SPECS = [
  getOrganizationSpec,
  listUsersSpec,
  updateUserSpec,
  getMeSpec,
] as const;
