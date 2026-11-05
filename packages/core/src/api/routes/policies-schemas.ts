import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import {
  MAX_POLICY_MEMBERS,
  POLICY_CLIENT_FAMILIES,
  POLICY_ECOSYSTEMS,
  POLICY_OVERRIDE_REASONS,
  POLICY_REASON_CODES,
  POLICY_RULE_KINDS,
} from '../../db/registry-policy.js';
import { MAX_MIN_AGE_DAYS } from '../../registry/policy/manage.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const limit = z
  .string()
  .regex(/^(?:[1-9][0-9]?|100)$/)
  .optional();
const ecosystem = z.enum(POLICY_ECOSYSTEMS);
const kind = z.enum(POLICY_RULE_KINDS);
const reasonCode = z.enum(POLICY_REASON_CODES);
const overrideReason = z.enum(POLICY_OVERRIDE_REASONS);
const clientFamily = z.enum(POLICY_CLIENT_FAMILIES);
const clientVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const minAgeDays = z.number().int().min(0).max(MAX_MIN_AGE_DAYS);
const member = z.string().min(1).max(255);
const packageName = z.string().min(1).max(512);
const denialReason = z.enum([
  'min_age',
  'blocked',
  'not_allowlisted',
  'quarantined',
  'client_floor',
  'restricted',
  'client_unsupported',
]);

export const policyRule = z.strictObject({
  id: ulid,
  scope: z.enum(['organization', 'project']),
  projectId: z.string().nullable(),
  ecosystem,
  package: z.string().nullable(),
  kind,
  minAgeDays: z.number().nonnegative().nullable(),
  clientFamily: clientFamily.nullable(),
  clientMinVersion: z.string().nullable(),
  denyUnknown: z.boolean(),
  reasonCode,
  incidentId: ulid.nullable(),
  expiresAt: z.string().nullable(),
  state: z.enum(['active', 'disabled']),
  disabledAt: z.string().nullable(),
  disabledReason: overrideReason.nullable(),
  memberCount: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const policyRuleDetail = policyRule.extend({ members: z.array(z.string()) });

export const policyRuleList = z.strictObject({
  items: z.array(policyRule),
  next: ulid.nullable(),
});

export const policyCreateBody = z.strictObject({
  ecosystem,
  package: packageName.nullable().optional(),
  kind,
  minAgeDays: minAgeDays.optional(),
  clientFamily: clientFamily.optional(),
  clientMinVersion: clientVersion.optional(),
  denyUnknown: z.boolean().optional(),
  reasonCode,
  incidentId: ulid.optional(),
  expiresAt: timestamp.nullable().optional(),
  members: z.array(member).max(MAX_POLICY_MEMBERS).optional(),
});

/** One change per request: field edits, a member set, or the disabled state. */
export const policyPatchBody = z.union([
  z.strictObject({
    members: z.array(member).max(MAX_POLICY_MEMBERS),
    overrideReason: overrideReason.optional(),
  }),
  z.strictObject({ state: z.literal('disabled'), reason: overrideReason }),
  z.strictObject({
    minAgeDays: minAgeDays.optional(),
    clientMinVersion: clientVersion.optional(),
    denyUnknown: z.boolean().optional(),
    reasonCode: reasonCode.optional(),
    incidentId: ulid.nullable().optional(),
    expiresAt: timestamp.nullable().optional(),
    overrideReason: overrideReason.optional(),
  }),
]);

export const policyInspection = z.strictObject({
  packageId: ulid,
  ecosystem: ecosystem.nullable(),
  package: z.string().nullable(),
  versions: z.array(
    z.strictObject({
      id: ulid,
      version: z.string(),
      revision: z.number().int().positive(),
      status: z.enum(['active', 'quarantined', 'tombstoned', 'removed_upstream', 'yanked']),
      ageBasis: z.enum(['published', 'imported', 'first_seen']).nullable(),
      effectiveAt: z.string().nullable(),
      permitted: z.boolean(),
      reasons: z.array(
        z.union([
          z.strictObject({
            ruleId: ulid,
            ruleRevision: z.number().int().positive(),
            reason: denialReason,
          }),
          z.strictObject({ reason: z.literal('organization_rule') }),
        ]),
      ),
    }),
  ),
  next: ulid.nullable(),
});

const listQuery = { limit, after: ulid.optional() };

function scopeSpecs(boundary: 'organization' | 'project') {
  const scoped = boundary === 'project';
  const base = scoped ? '/_pb/projects/:project/policies' : '/_pb/policies';
  const gate = scoped
    ? ({ boundary: 'project', permission: 'project:read', projectSession: true } as const)
    : ({ boundary: 'self', permission: null } as const);
  const params = scoped ? { project } : {};
  const prefix = scoped ? 'Project' : '';
  return [
    {
      method: 'GET',
      path: base,
      ...gate,
      api: {
        operationId: `list${prefix}Policies`,
        summary: 'List registry policy rules',
        tags: ['policies'],
        params: z.strictObject(params),
        query: scoped
          ? z.strictObject(listQuery)
          : z.strictObject({ ...listQuery, project: ulid.optional() }),
        responses: { 200: policyRuleList, 403: null },
      },
    },
    {
      method: 'POST',
      path: base,
      ...gate,
      api: {
        operationId: `create${prefix}Policy`,
        summary: 'Add a registry policy rule',
        tags: ['policies'],
        params: z.strictObject(params),
        body: policyCreateBody,
        responses: { 201: policyRule, 403: null, 409: null },
      },
    },
    {
      method: 'GET',
      path: `${base}/:policy`,
      ...gate,
      api: {
        operationId: `get${prefix}Policy`,
        summary: 'Read a registry policy rule and its members',
        tags: ['policies'],
        params: z.strictObject({ ...params, policy: ulid }),
        responses: { 200: policyRuleDetail, 403: null },
      },
    },
    {
      method: 'PATCH',
      path: `${base}/:policy`,
      ...gate,
      concurrency: 'if-match',
      api: {
        operationId: `update${prefix}Policy`,
        summary: 'Edit, replace the members of, disable or release a registry policy rule',
        tags: ['policies'],
        params: z.strictObject({ ...params, policy: ulid }),
        body: policyPatchBody,
        responses: { 200: policyRule, 403: null, 409: null },
      },
    },
    {
      method: 'GET',
      path: `${base}/packages/:package`,
      ...gate,
      api: {
        operationId: `inspect${prefix}PackagePolicy`,
        summary: 'Inspect how registry policy decides the versions of a package',
        tags: ['policies'],
        params: z.strictObject({ ...params, package: ulid }),
        query: z.strictObject(listQuery),
        responses: { 200: policyInspection, 403: null },
      },
    },
  ] as const satisfies readonly ApiRouteSpec[];
}

export const POLICY_API_SPECS = [...scopeSpecs('organization'), ...scopeSpecs('project')] as const;
