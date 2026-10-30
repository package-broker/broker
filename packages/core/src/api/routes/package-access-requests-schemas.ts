import * as z from 'zod';
import { decisionReason } from './publishes-schemas.js';
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const packageAccessRequest = z.strictObject({
  id,
  packageId: id,
  packageName: z.string(),
  requestedBy: z.strictObject({ type: z.literal('user'), name: z.string() }),
  decidedBy: z.strictObject({ name: z.string() }).nullable(),
  project: z.strictObject({ id, slug: z.string(), name: z.string() }).nullable(),
  projectId: id,
  state: z.enum(['pending', 'approved', 'rejected', 'expired']),
  requestedByUserId: id,
  reason: z.string().nullable(),
  decidedByUserId: id.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  expiresAt: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const PACKAGE_ACCESS_REQUEST_SCHEMAS = {
  PackageAccessRequest: packageAccessRequest,
  PackageAccessRequestBody: z.strictObject({
    packageId: id,
    reason: z.string().max(1000).optional(),
  }),
  PackageAccessApproveBody: z.strictObject({ reason: decisionReason.optional() }),
  PackageAccessRejectBody: z.strictObject({ reason: decisionReason.min(1) }),
  PackageAccessRequestListQuery: z.strictObject({
    state: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
    cursor: z.string().max(512).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  }),
  PackageAccessRequestList: z.strictObject({
    items: z.array(packageAccessRequest),
    next: z.string().nullable(),
  }),
  RequestablePackage: z.strictObject({
    id,
    name: z.string(),
    newProjectAccessMode: z.literal('request'),
  }),
};
