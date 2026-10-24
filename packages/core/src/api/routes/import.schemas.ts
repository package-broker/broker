import * as z from 'zod';
import type { ApiRouteSpec } from '../route.js';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const params = z.strictObject({ id });
const run = z.strictObject({
  id,
  state: z.enum([
    'planned',
    'applying',
    'failed',
    'applied',
    'verifying',
    'verified',
    'rolled_back',
    'cancelled',
  ]),
  planHash: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedByUserId: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  beforeImageExpiresAt: z.string().nullable(),
  credentialWindowUntil: z.string().nullable().optional(),
});
const runDetail = run.extend({
  credentials: z.array(z.strictObject({ sourceRef: z.string(), bound: z.boolean() })).optional(),
});
const base = { boundary: 'organization', permission: 'org:import:write' } as const;

export const IMPORT_CREATE_SPEC = {
  ...base,
  method: 'POST',
  path: '/_pb/import-runs',
  api: {
    operationId: 'createImportRun',
    summary: 'Plan an import',
    tags: ['imports'],
    body: z.unknown(),
    responses: { 201: z.strictObject({ id, planHash: z.string(), state: z.literal('planned') }) },
  },
} as const satisfies ApiRouteSpec;

export const IMPORT_LIST_SPEC = {
  ...base,
  method: 'GET',
  path: '/_pb/import-runs',
  api: {
    operationId: 'listImportRuns',
    summary: 'List import runs',
    tags: ['imports'],
    query: z.strictObject({
      cursor: z.string().min(1).max(4096).optional(),
      limit: z
        .string()
        .regex(/^([1-9][0-9]?|100)$/)
        .optional(),
    }),
    responses: { 200: z.strictObject({ items: z.array(run), next: z.string().nullable() }) },
  },
} as const satisfies ApiRouteSpec;

export const IMPORT_GET_SPEC = {
  ...base,
  method: 'GET',
  path: '/_pb/import-runs/:id',
  api: {
    operationId: 'getImportRun',
    summary: 'Read an import run',
    tags: ['imports'],
    params,
    responses: { 200: runDetail },
  },
} as const satisfies ApiRouteSpec;

export const IMPORT_ACTIONS = {
  verify: 'requestVerify',
  approve: 'approveRun',
  apply: 'requestApply',
  rollback: 'requestRollback',
  accept: 'acceptRun',
  cancel: 'cancelRun',
} as const;

export function importActionSpec(action: keyof typeof IMPORT_ACTIONS) {
  return {
    ...base,
    method: 'POST',
    path: `/_pb/import-runs/:id/${action}`,
    permission: action === 'verify' ? 'org:import:write' : 'org:import:approve',
    api: {
      operationId: `${action}ImportRun`,
      summary: `${action} an import run`,
      tags: ['imports'],
      params,
      ...(action === 'approve'
        ? { body: z.strictObject({ planHash: z.string().max(64).optional() }) }
        : {}),
      responses: { 204: null },
    },
  } as const satisfies ApiRouteSpec;
}

export const IMPORT_CREDENTIAL_SPEC = {
  ...base,
  method: 'PUT',
  path: '/_pb/import-runs/:id/credentials/:externalRef',
  api: {
    operationId: 'acceptImportCredential',
    summary: 'Bind an imported source credential',
    tags: ['imports'],
    params: z.strictObject({ id, externalRef: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/) }),
    body: z.strictObject({
      kind: z.enum([
        'http_basic',
        'bearer',
        'header',
        'query',
        'github_app',
        'npm_token',
        'ssh_key',
      ]),
      material: z.string().max(16384),
    }),
    responses: { 204: null },
  },
} as const satisfies ApiRouteSpec;
