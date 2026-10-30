import * as z from 'zod';
import { packageKey } from '../../catalogue/names.js';
const npmName = z
  .string()
  .min(1)
  .max(214)
  .refine((name) => {
    try {
      packageKey(name, { ecosystem: 'npm' });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid npm package name');
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const trustedPublisher = z.strictObject({
  id,
  packageName: z.string(),
  repositoryId: z.string(),
  repositoryOwnerId: z.string(),
  repository: z.string(),
  workflow: z.string(),
  environment: z.string(),
  refPattern: z.string().nullable(),
  servicePrincipalId: id,
  servicePrincipalName: z.string(),
  createdByUserId: id,
  createdByName: z.string(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revision: z.number().int().positive(),
});
export const NPM_IDENTITY_SCHEMAS = {
  NpmLoginStartBody: z
    .object({
      create: z.boolean().optional(),
      hostname: z
        .string()
        .max(253)
        .refine(
          (value) => new TextEncoder().encode(value).length <= 253,
          'Hostname exceeds 253 bytes',
        )
        .optional(),
    })
    .default({}),
  NpmLoginConfirmation: z.strictObject({
    project: z.strictObject({ id, name: z.string(), slug: z.string() }),
    cliHostname: z.string().nullable(),
    sourceIp: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  }),
  NpmLoginConfirmResponse: z.strictObject({ ok: z.literal(true) }),
  NpmLoginStart: z.strictObject({ loginUrl: z.string(), doneUrl: z.string() }),
  NpmLoginPending: z.strictObject({}),
  NpmLoginToken: z.strictObject({ token: z.string() }),
  NpmLoginApprovalBody: z.strictObject({ scope: z.enum(['read', 'write']) }),
  TrustedPublisher: trustedPublisher,
  TrustedPublisherCreateBody: z.strictObject({
    packageName: npmName,
    repository: z
      .string()
      .max(140)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/),
    workflow: z
      .string()
      .max(255)
      .regex(/^[^/\\\r\n]+\.ya?ml$/),
    environment: z.string().max(255),
    refPattern: z.string().max(255).optional(),
  }),
  TrustedPublisherList: z.strictObject({ items: z.array(trustedPublisher) }),
  NpmWorkloadToken: z.strictObject({
    token_type: z.literal('oidc'),
    token: z.string(),
    created: z.string(),
    expires: z.string(),
  }),
};
