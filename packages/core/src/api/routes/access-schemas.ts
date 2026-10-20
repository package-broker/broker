import * as z from 'zod';
import { ROLE_KEY_PATTERN } from '../../db/roles.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const permissionNames = z.array(z.string().max(100)).max(200);
const roleName = z.string().min(1).max(200);
const scope = z.enum(['organization', 'project']);
const page = {
  limit: z
    .string()
    .regex(/^([1-9][0-9]?|100)$/)
    .optional(),
  after: ulid.optional(),
};
const pageQuery = z.strictObject(page);

const subject = z.union([
  z.strictObject({ type: z.literal('email'), value: z.string().min(1).max(320) }),
  z.strictObject({
    type: z.literal('group'),
    provider: z.string().min(1).max(64),
    value: z.string().min(1).max(512),
  }),
]);

const listedSubject = z.union([
  z.strictObject({ type: z.literal('email') }),
  z.strictObject({
    type: z.literal('group'),
    provider: z.string(),
    value: z.string().optional(),
  }),
]);

const roleParams = z.strictObject({ role: ulid });
const grantParams = z.strictObject({ grant: ulid });
const created = z.strictObject({ id: ulid });

const roleItem = z.strictObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  scope,
  isSystem: z.boolean(),
  protectsLastHolder: z.boolean(),
  revision: z.number().int(),
  permissions: z.array(z.string()),
});
const grantItem = z.strictObject({
  id: z.string(),
  subject: listedSubject,
  roleId: z.string(),
  createdAt: z.string(),
  revision: z.number().int(),
});
const next = z.string().nullable();

const listRoles = {
  method: 'GET',
  path: '/_pb/roles',
  boundary: 'organization',
  permission: 'org:roles:read',
  service: 'AdminError',
  api: {
    operationId: 'listRoles',
    summary: 'List roles',
    tags: ['roles'],
    query: pageQuery,
    responses: { 200: z.strictObject({ items: z.array(roleItem), next }) },
  },
} as const satisfies ApiRouteSpec;

const createRole = {
  method: 'POST',
  path: '/_pb/roles',
  boundary: 'organization',
  permission: 'org:roles:write',
  service: 'AdminError',
  api: {
    operationId: 'createRole',
    summary: 'Add a role',
    tags: ['roles'],
    body: z.strictObject({
      key: z.string().regex(ROLE_KEY_PATTERN),
      name: roleName,
      scope,
      permissions: permissionNames,
    }),
    responses: { 201: created },
  },
} as const satisfies ApiRouteSpec;

const updateRole = {
  method: 'PATCH',
  path: '/_pb/roles/:role',
  boundary: 'organization',
  permission: 'org:roles:write',
  concurrency: 'if-match',
  service: 'AdminError',
  api: {
    operationId: 'updateRole',
    summary: 'Rename a role or replace its permissions',
    tags: ['roles'],
    params: roleParams,
    body: z.union([
      z.strictObject({ name: roleName }),
      z.strictObject({ permissions: permissionNames }),
    ]),
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

const deleteRole = {
  method: 'DELETE',
  path: '/_pb/roles/:role',
  boundary: 'organization',
  permission: 'org:roles:write',
  concurrency: 'if-match',
  service: 'AdminError',
  api: {
    operationId: 'deleteRole',
    summary: 'Remove a role',
    tags: ['roles'],
    params: roleParams,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

const listGrants = {
  method: 'GET',
  path: '/_pb/grants',
  boundary: 'organization',
  permission: 'org:grants:read',
  service: 'AdminError',
  api: {
    operationId: 'listGrants',
    summary: 'List organization grants',
    tags: ['grants'],
    query: pageQuery,
    responses: { 200: z.strictObject({ items: z.array(grantItem), next }) },
  },
} as const satisfies ApiRouteSpec;

const createGrant = {
  method: 'POST',
  path: '/_pb/grants',
  boundary: 'organization',
  permission: 'org:grants:write',
  service: 'AdminError',
  api: {
    operationId: 'createGrant',
    summary: 'Add an organization grant',
    tags: ['grants'],
    body: z.strictObject({ subject, roleId: ulid }),
    responses: { 201: created },
  },
} as const satisfies ApiRouteSpec;

const changeGrant = {
  method: 'PATCH',
  path: '/_pb/grants/:grant',
  boundary: 'organization',
  permission: 'org:grants:write',
  concurrency: 'if-match',
  service: 'AdminError',
  api: {
    operationId: 'changeGrant',
    summary: 'Change the role of a grant',
    tags: ['grants'],
    params: grantParams,
    body: z.strictObject({ roleId: ulid }),
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

const revokeGrant = {
  method: 'DELETE',
  path: '/_pb/grants/:grant',
  boundary: 'organization',
  permission: 'org:grants:write',
  concurrency: 'if-match',
  service: 'AdminError',
  api: {
    operationId: 'revokeGrant',
    summary: 'Revoke a grant',
    tags: ['grants'],
    params: grantParams,
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;

export const ACCESS_SPECS = {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listGrants,
  createGrant,
  changeGrant,
  revokeGrant,
} as const;

export const ACCESS_API_SPECS = Object.values(ACCESS_SPECS);
