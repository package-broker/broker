import * as z from 'zod';

import { PUBLISH_APPROVAL_STATES, PUBLISH_SCAN_STATES } from '../../db/publishes.js';

export const publishApprovalState = z.enum(PUBLISH_APPROVAL_STATES);
export const publishScanState = z.enum(PUBLISH_SCAN_STATES);
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const revision = z.number().int().positive();
export const decisionReason = z
  .string()
  .max(1000)
  .refine((value) => new TextEncoder().encode(value).length <= 1000, 'Reason exceeds 1000 bytes')
  .describe('At most 1000 UTF-8 bytes');
export const publishApproveBody = z.strictObject({ reason: decisionReason.optional() });
export const publishRejectBody = z.strictObject({ reason: decisionReason.min(1) });
export const publishListQuery = z.strictObject({
  state: publishApprovalState.optional(),
  cursor: z.string().max(512).optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .optional(),
});
export const npmPublishAccepted = z.union([
  z.strictObject({ ok: z.literal(true), id: z.string(), rev: revision }),
  z.strictObject({
    ok: z.literal(true),
    id: z.string(),
    held: z.strictObject({ approval: z.boolean(), scan: z.boolean() }),
    status: z.string(),
  }),
]);
export const publishApproval = z.strictObject({
  id,
  packageId: id,
  packageName: z.string(),
  version: z.string(),
  sourceName: z.string(),
  requestedBy: z.strictObject({ type: z.enum(['user', 'service']), name: z.string() }),
  decidedBy: z.strictObject({ name: z.string() }).nullable(),
  project: z.strictObject({ id, slug: z.string(), name: z.string() }).nullable(),
  versionId: id,
  sourceId: id,
  holdApproval: z.boolean(),
  holdScan: z.boolean(),
  approvalState: publishApprovalState,
  scanState: publishScanState,
  requiredScanners: z.array(z.string()),
  scanAttempts: z.number().int().nonnegative(),
  requestedByType: z.enum(['user', 'service']),
  requestedById: id,
  tokenId: id,
  routeProjectId: id.nullable(),
  distTags: z.record(z.string(), z.string()),
  readmePending: z.boolean(),
  decidedByUserId: id.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  scanVerdicts: z.array(
    z.strictObject({
      plugin: z.string(),
      verdict: z.enum(['allow', 'deny']),
      reason: z.string().optional(),
    }),
  ),
  expiresAt: z.string(),
  revision,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const publishList = z.strictObject({
  items: z.array(publishApproval),
  next: z.string().nullable(),
});
export const versionReadme = z.strictObject({ filename: z.string(), body: z.string() });

export const PUBLISH_SCHEMAS = {
  NpmPublishAccepted: npmPublishAccepted,
  PublishApproval: publishApproval,
  PublishApproveBody: publishApproveBody,
  PublishRejectBody: publishRejectBody,
  PublishListQuery: publishListQuery,
  PublishList: publishList,
  VersionReadme: versionReadme,
};
