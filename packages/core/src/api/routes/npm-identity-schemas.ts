import * as z from 'zod';
import { NPM_HOSTNAME_CHECK, NPM_PACKAGE_NAME_CHECK } from '../npm-identity-checks.js';
import { MAX_NPM_NAME_LENGTH } from '../../catalogue/names.js';
const npmName = z.string().min(1).max(MAX_NPM_NAME_LENGTH).check(NPM_PACKAGE_NAME_CHECK);
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
    .strictObject({
      create: z.boolean().optional(),
      hostname: z.string().max(253).check(NPM_HOSTNAME_CHECK).optional(),
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
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/),
    workflow: z
      .string()
      .max(255)
      .regex(/^[^/@\r\n]+\.ya?ml$/),
    environment: z.string().max(255),
    refPattern: z.string().max(255).optional(),
  }),
  TrustedPublisherListQuery: z.strictObject({
    cursor: id.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  }),
  TrustedPublisherList: z.strictObject({ items: z.array(trustedPublisher), next: id.nullable() }),
  NpmWorkloadToken: z.strictObject({
    token_type: z.literal('oidc'),
    token: z.string(),
    created: z.string(),
    expires: z.string(),
  }),
};
