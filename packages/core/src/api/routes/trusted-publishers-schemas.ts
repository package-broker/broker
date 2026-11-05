import * as z from 'zod';
import type { ApiRouteSpec } from '../route.js';
import { NPM_IDENTITY_SCHEMAS as schemas } from './npm-identity-schemas.js';
const params = z.strictObject({ id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) });
const base = { boundary: 'organization', permission: 'org:service-principals:write' } as const;
export const TRUSTED_PUBLISHER_API_SPECS = [
  {
    ...base,
    method: 'GET',
    path: '/_pb/trusted-publishers',
    api: {
      operationId: 'listTrustedPublishers',
      query: schemas.TrustedPublisherListQuery,
      summary: 'List trusted publishers for this organization',
      tags: ['tokens'],
      responses: { 200: schemas.TrustedPublisherList },
    },
  },
  {
    ...base,
    method: 'POST',
    path: '/_pb/trusted-publishers',
    api: {
      operationId: 'createTrustedPublisher',
      summary: 'Register a GitHub trusted publisher',
      tags: ['tokens'],
      body: schemas.TrustedPublisherCreateBody,
      responses: { 201: schemas.TrustedPublisher, 409: null },
    },
  },
  {
    ...base,
    method: 'PUT',
    path: '/_pb/trusted-publishers/:id',
    concurrency: 'if-match',
    api: {
      operationId: 'updateTrustedPublisher',
      summary: 'Edit a trusted publisher and invalidate pending exchanges',
      tags: ['tokens'],
      params,
      body: schemas.TrustedPublisherCreateBody,
      responses: { 200: schemas.TrustedPublisher, 409: null },
    },
  },
  {
    ...base,
    method: 'DELETE',
    path: '/_pb/trusted-publishers/:id',
    concurrency: 'if-match',
    api: {
      operationId: 'disableTrustedPublisher',
      summary: 'Disable a trusted publisher and revoke its workload tokens',
      tags: ['tokens'],
      params,
      responses: { 204: null, 409: null },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
