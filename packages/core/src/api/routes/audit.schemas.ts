import * as z from 'zod';

const filter = z.string().min(1).max(200);
const filters = {
  actor: filter.optional(),
  action: filter.optional(),
  after: filter.optional(),
  limit: z
    .string()
    .max(16)
    .regex(/^[0-9]+$/)
    .optional(),
};
export const auditQuery = z.strictObject({ ...filters, project: filter.optional() });
export const projectAuditQuery = z.strictObject(filters);
export const projectAuditParams = z.strictObject({ project: z.string().min(1).max(64) });
export const auditLimit = z.number().int().min(1).max(200);
const auditValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
const payload = z.strictObject({
  op_id: z.string().optional(),
  request_id: z.string().optional(),
  changes: z
    .record(z.string(), z.strictObject({ old: auditValue.optional(), new: auditValue.optional() }))
    .optional(),
});
const item = z.strictObject({
  id: z.string(),
  seq: z.number().int(),
  action: z.string(),
  actor: z.strictObject({ type: z.string(), id: z.string().nullable() }),
  targetType: z.string(),
  targetId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  payload,
});
export const auditListResponse = z.strictObject({
  items: z.array(item),
  next: z.string().nullable(),
});
export const auditHeadResponse = z.strictObject({
  seq: z.number().int(),
  hash: z.string(),
  pendingCount: z.number().int(),
  lastVerifiedAt: z.string().nullable(),
});
