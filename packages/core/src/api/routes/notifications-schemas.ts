import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_ATTEMPT_CODES,
  NOTIFICATION_ATTEMPT_OUTCOMES,
  NOTIFICATION_DELIVERY_CODES,
  NOTIFICATION_DELIVERY_STATES,
  NOTIFICATION_DISABLED_REASONS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_METHODS,
} from '../../db/notifications.js';
import type { ApiRouteSpec } from '../route.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DELIVERY_CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ulid = z.string().regex(ULID);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const limit = z
  .string()
  .regex(/^([1-9]|[1-4][0-9]|50)$/)
  .optional();
const instant = z.string();
const event = z.enum(NOTIFICATION_EVENT_TYPES);
const method = z.enum(NOTIFICATION_METHODS);
const deliveryState = z.enum(NOTIFICATION_DELIVERY_STATES);

const endpointParams = z.strictObject({ project, id: ulid });
const deliveryParams = z.strictObject({
  project,
  id: ulid,
  delivery: z.string().regex(DELIVERY_ID),
});

const options = z.strictObject({
  name: z.string().min(1).max(160).describe('1 to 80 printable characters.'),
  method,
  events: z.array(event).min(1).max(NOTIFICATION_EVENT_TYPES.length),
  packagePattern: z
    .string()
    .min(1)
    .max(50)
    .describe('Stored package key glob; `*` matches any run of characters, including `/`.'),
});

/** Write-only: never echoed, logged or returned by any response. */
const secret = z.strictObject({
  url: z.string().min(1).max(2048).describe('HTTPS destination on port 443.'),
  headers: z
    .array(z.strictObject({ name: z.string().min(1).max(256), value: z.string().max(8192) }))
    .max(16)
    .optional(),
  signingKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .describe('Random 32-byte HMAC key, base64url without padding, shared with the receiver.'),
  template: z
    .string()
    .min(1)
    .max(8192)
    .nullable()
    .optional()
    .describe('json-v1 body template; omit or null for the canonical envelope.'),
});

const createBody = options.extend({ secret });
const updateBody = z
  .strictObject({ options: options.optional(), secret: secret.optional() })
  .describe('At least one of options and secret; an omitted secret keeps the sealed one.');

const endpoint = z.strictObject({
  id: z.string(),
  name: z.string(),
  method,
  events: z.array(event),
  packagePattern: z.string(),
  state: z.enum(['enabled', 'disabled']),
  disabledReason: z.enum(NOTIFICATION_DISABLED_REASONS).nullable(),
  failureStreak: z.number().int(),
  revision: z.number().int(),
  destinationConfigured: z.literal(true),
  signingConfigured: z.literal(true),
  headersConfigured: z.boolean(),
  templateConfigured: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});

const delivery = z.strictObject({
  id: z.string(),
  eventId: z.string(),
  eventType: event,
  state: deliveryState,
  attempts: z.number().int(),
  nextAttemptAt: instant.nullable(),
  lastStatus: z.number().int().nullable(),
  outcomeCode: z.enum(NOTIFICATION_DELIVERY_CODES).nullable(),
  createdAt: instant,
  finishedAt: instant.nullable(),
});

const attempt = z.strictObject({
  attempt: z.number().int(),
  outcome: z.enum(NOTIFICATION_ATTEMPT_OUTCOMES),
  outcomeCode: z.enum(NOTIFICATION_ATTEMPT_CODES).nullable(),
  status: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  startedAt: instant,
  finishedAt: instant.nullable(),
});

export const NOTIFICATION_SCHEMAS = {
  endpoint,
  delivery,
  attempt,
  createBody,
  updateBody,
  endpointList: z.strictObject({ items: z.array(endpoint), next: z.string().nullable() }),
  deliveryList: z.strictObject({ items: z.array(delivery), next: z.string().nullable() }),
  deliveryDetail: delivery.extend({ history: z.array(attempt).max(MAX_NOTIFICATION_ATTEMPTS) }),
} as const;

const base = {
  boundary: 'project',
  permission: 'project:settings:write',
  service: 'NotificationError',
} as const;
const tags = ['notifications'];

export const NOTIFICATION_API_SPECS = [
  {
    ...base,
    method: 'GET',
    path: '/_pb/projects/:project/notifications',
    api: {
      operationId: 'listNotificationEndpoints',
      summary: 'List notification endpoints of a project',
      tags,
      params: z.strictObject({ project }),
      query: z.strictObject({ cursor: ulid.optional(), limit }),
      responses: { 200: NOTIFICATION_SCHEMAS.endpointList },
    },
  },
  {
    ...base,
    method: 'POST',
    path: '/_pb/projects/:project/notifications',
    api: {
      operationId: 'createNotificationEndpoint',
      summary: 'Add a disabled notification endpoint (recent reauthentication required)',
      tags,
      params: z.strictObject({ project }),
      body: createBody,
      responses: { 201: endpoint, 409: null },
    },
  },
  {
    ...base,
    method: 'GET',
    path: '/_pb/projects/:project/notifications/:id',
    api: {
      operationId: 'getNotificationEndpoint',
      summary: 'Read a notification endpoint',
      tags,
      params: endpointParams,
      responses: { 200: endpoint },
    },
  },
  {
    ...base,
    method: 'PATCH',
    path: '/_pb/projects/:project/notifications/:id',
    concurrency: 'if-match',
    api: {
      operationId: 'updateNotificationEndpoint',
      summary:
        'Change a notification endpoint; replacing the destination settings needs recent reauthentication and disables it',
      tags,
      params: endpointParams,
      body: updateBody,
      responses: { 200: endpoint },
    },
  },
  {
    ...base,
    method: 'POST',
    path: '/_pb/projects/:project/notifications/:id/enable',
    concurrency: 'if-match',
    api: {
      operationId: 'enableNotificationEndpoint',
      summary: 'Enable a notification endpoint for new events',
      tags,
      params: endpointParams,
      responses: { 200: endpoint },
    },
  },
  {
    ...base,
    method: 'POST',
    path: '/_pb/projects/:project/notifications/:id/disable',
    concurrency: 'if-match',
    api: {
      operationId: 'disableNotificationEndpoint',
      summary: 'Disable a notification endpoint',
      tags,
      params: endpointParams,
      responses: { 200: endpoint },
    },
  },
  {
    ...base,
    method: 'DELETE',
    path: '/_pb/projects/:project/notifications/:id',
    concurrency: 'if-match',
    api: {
      operationId: 'deleteNotificationEndpoint',
      summary:
        'Remove a notification endpoint and cancel its waiting deliveries (recent reauthentication required)',
      tags,
      params: endpointParams,
      responses: { 204: null },
    },
  },
  {
    ...base,
    method: 'GET',
    path: '/_pb/projects/:project/notifications/:id/deliveries',
    api: {
      operationId: 'listNotificationDeliveries',
      summary: 'List recent deliveries of a notification endpoint',
      tags,
      params: endpointParams,
      query: z.strictObject({
        cursor: z.string().regex(DELIVERY_CURSOR).optional(),
        limit,
        state: deliveryState.optional(),
      }),
      responses: { 200: NOTIFICATION_SCHEMAS.deliveryList },
    },
  },
  {
    ...base,
    method: 'GET',
    path: '/_pb/projects/:project/notifications/:id/deliveries/:delivery',
    api: {
      operationId: 'getNotificationDelivery',
      summary: 'Read one delivery with its attempt history',
      tags,
      params: deliveryParams,
      responses: { 200: NOTIFICATION_SCHEMAS.deliveryDetail },
    },
  },
] as const satisfies readonly ApiRouteSpec[];
