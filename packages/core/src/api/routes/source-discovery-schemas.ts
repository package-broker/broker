import * as z from 'zod';
import type { ApiRouteSpec } from '../route.js';

const common = {
  credentialId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  includeForks: z.boolean().optional(),
  ecosystem: z.enum(['composer', 'npm']).optional(),
};
const cursor = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$/)
  .nullable();
const reason = z.enum([
  'archived',
  'no_manifest',
  'invalid_name',
  'fork',
  'name_public',
  'name_public_unverified',
  'claim_overlap',
  'filtered_out',
  'error_451',
  'error_404',
  'unsupported_ecosystem',
]);
const entry = z.strictObject({
  repository: z.string(),
  ecosystem: z.enum(['composer', 'npm']).nullable(),
  packageName: z.string().nullable(),
  action: z.enum(['new', 'existing', 'skipped']),
  reason: reason.nullable(),
});
const base = { method: 'POST', boundary: 'organization', permission: 'org:sources:write' } as const;
export const SOURCE_DISCOVERY_API_SPECS = [
  {
    ...base,
    path: '/_pb/sources/discovery/plan',
    api: {
      operationId: 'planSourceDiscovery',
      summary: 'Discover configured organization repositories',
      tags: ['sources'],
      body: z.strictObject({
        ...common,
        pattern: z.string().regex(/^[A-Za-z0-9._*?-]{1,100}$/),
        cursor,
      }),
      responses: { 200: z.strictObject({ entries: z.array(entry), nextCursor: cursor }) },
    },
  },
  {
    ...base,
    path: '/_pb/sources/discovery/apply',
    api: {
      operationId: 'applySourceDiscovery',
      summary: 'Import a bounded page of organization repositories',
      tags: ['sources'],
      body: z.strictObject({
        ...common,
        repositories: z
          .array(z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/))
          .max(20),
        nextCursor: cursor.optional(),
      }),
      responses: {
        200: z.strictObject({
          created: z.number().int().nonnegative(),
          existing: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          results: z.array(
            z.strictObject({
              repository: z.string(),
              outcome: z.enum(['created', 'existing', 'skipped', 'failed']),
              error: z.string().optional(),
              reason: reason.optional(),
            }),
          ),
          remainingRepositories: z.array(z.string()),
          nextCursor: cursor,
        }),
      },
    },
  },
  {
    method: 'GET',
    boundary: 'organization',
    permission: 'org:sources:write',
    path: '/_pb/sources/discovery/connections',
    api: {
      operationId: 'listSourceDiscoveryConnections',
      summary: 'List organization GitHub App connections already used by sources',
      tags: ['sources'],
      responses: {
        200: z.strictObject({
          items: z
            .array(
              z.strictObject({
                credentialId: common.credentialId,
                installationId: common.installationId,
                sourceNames: z.array(z.string()).max(5),
                sourceCount: z.number().int().positive(),
              }),
            )
            .max(100),
        }),
      },
    },
  },
] as const satisfies readonly ApiRouteSpec[];

export const DISCOVERY_RULE_OPTIONS = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(80)
    // eslint-disable-next-line no-control-regex -- Rule names exclude controls in the API schema.
    .regex(/^[^\x00-\x1f\x7f-\x9f]*$/)
    .regex(/^\S(?:[\s\S]*\S)?$/),
  credentialId: common.credentialId,
  installationId: common.installationId,
  ecosystem: z.enum(['composer', 'npm', 'both']).default('both'),
  pattern: z.string().regex(/^[A-Za-z0-9._*?-]{1,100}$/),
  includeForks: z.boolean().default(false),
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(3600).max(2592000).default(86400),
});
const completedResult = z.strictObject({
  lastRunAt: z.string().nullable(),
  outcome: z.enum(['succeeded', 'failed']).nullable(),
  created: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skips: z.array(z.strictObject({ repository: z.string(), reason: z.string().nullable() })).max(50),
  failureReason: z.string().nullable().optional(),
});
const rule = z.strictObject({
  ...DISCOVERY_RULE_OPTIONS.shape,
  id: common.credentialId,
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable(),
  outcome: z.enum(['running', 'succeeded', 'failed', 'rate_limited']).nullable(),
  created: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skips: z.array(z.strictObject({ repository: z.string(), reason: z.string().nullable() })).max(50),
  completed: completedResult.nullable().optional(),
  pendingResults: z
    .array(
      z.strictObject({
        repository: z.string(),
        ecosystem: z.enum(['composer', 'npm']).nullable().optional(),
        outcome: z.enum(['created', 'existing', 'skipped', 'failed']),
        reason: reason.nullable().optional(),
        error: z.string().optional(),
        retryable: z.boolean().optional(),
      }),
    )
    .max(2)
    .optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  failureReason: z.string().nullable().optional(),

  cursor,
  remaining: z.array(z.string()).max(49),
  nextRunAt: z.string().nullable(),
});
const readerRule = rule.pick({
  id: true,
  name: true,
  ecosystem: true,
  pattern: true,
  includeForks: true,
  enabled: true,
  intervalSeconds: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  completed: true,
});
const visibleRule = z.union([rule, readerRule]);
const resultsProjection = completedResult;
const ruleBase = { boundary: 'organization', permission: 'org:sources:write' } as const;
const rulePath = '/_pb/sources/discovery/rules';
const params = z.strictObject({ id: common.credentialId });
const ack = z.strictObject({ id: common.credentialId });
export const DISCOVERY_RULE_API_SPECS = [
  {
    ...ruleBase,
    method: 'POST',
    path: rulePath,
    api: {
      operationId: 'createDiscoveryRule',
      summary: 'Add an organization discovery rule',
      tags: ['sources'],
      body: DISCOVERY_RULE_OPTIONS,
      responses: { 201: ack },
    },
  },
  {
    ...ruleBase,
    permission: 'org:sources:read',
    method: 'GET',
    path: rulePath,
    api: {
      operationId: 'listDiscoveryRules',
      summary: 'List organization discovery rules',
      tags: ['sources'],
      query: z.strictObject({
        after: common.credentialId.optional(),
        limit: z
          .string()
          .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
          .optional(),
      }),
      responses: {
        200: z.strictObject({ items: z.array(visibleRule), next: common.credentialId.nullable() }),
      },
    },
  },
  {
    ...ruleBase,
    permission: 'org:sources:read',
    method: 'GET',
    path: `${rulePath}/:id`,
    api: {
      operationId: 'getDiscoveryRule',
      summary: 'Read a discovery rule and its last run results',
      tags: ['sources'],
      params,
      responses: { 200: visibleRule },
    },
  },
  {
    ...ruleBase,
    method: 'PATCH',
    path: `${rulePath}/:id`,
    concurrency: 'if-match',
    api: {
      operationId: 'updateDiscoveryRule',
      summary: 'Change a discovery rule and invalidate its current run',
      tags: ['sources'],
      params,
      body: DISCOVERY_RULE_OPTIONS.omit({
        ecosystem: true,
        includeForks: true,
        enabled: true,
        intervalSeconds: true,
      })
        .extend({
          ecosystem: z.enum(['composer', 'npm', 'both']),
          includeForks: z.boolean(),
          enabled: z.boolean(),
          intervalSeconds: z.number().int().min(3600).max(2592000),
        })
        .partial(),
      responses: { 200: ack },
    },
  },
  {
    ...ruleBase,
    method: 'DELETE',
    path: `${rulePath}/:id`,
    concurrency: 'if-match',
    api: {
      operationId: 'deleteDiscoveryRule',
      summary: 'Remove a rule while preserving discovered sources',
      tags: ['sources'],
      params,
      responses: { 204: null },
    },
  },
  {
    ...ruleBase,
    method: 'POST',
    path: `${rulePath}/:id/run`,
    api: {
      operationId: 'runDiscoveryRule',
      summary: 'Request a scan on the next scheduler tick',
      tags: ['sources'],
      params,
      body: z.strictObject({}),
      responses: { 202: ack },
    },
  },
  {
    ...ruleBase,
    permission: 'org:sources:read',
    method: 'GET',
    path: `${rulePath}/:id/results`,
    api: {
      operationId: 'getDiscoveryRuleResults',
      summary: 'Read bounded last-run results and skip reasons',
      tags: ['sources'],
      params,
      responses: { 200: resultsProjection },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
