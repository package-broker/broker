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
] as const satisfies readonly ApiRouteSpec[];
