import { auditEvent, type AuditEvent } from '../audit/actions.js';
import { isStoredKey } from '../catalogue/patterns.js';
import { isUlid } from '../ids.js';
import type { JobEnqueue } from '../platform/job-repository.js';
import { canonicalPayload, storedIdempotencyKey } from '../platform/jobs.js';
import {
  notificationEvent,
  type NotificationEvent,
  type NotificationEventData,
  type NotificationEventType,
} from './events.js';

export const NOTIFICATION_DISPATCH_JOB = 'core:notification-dispatch:v1';
export const NOTIFICATION_DELIVER_JOB = 'core:notification-deliver:v1';
export const NOTIFICATION_DISPATCH_MAX_ATTEMPTS = 10;
export const NOTIFICATION_DELIVER_MAX_ATTEMPTS = 10;
/** Events one package mutation may capture; a larger operation overflows with one audit record. */
export const MAX_OPERATION_EVENTS = 64;
/**
 * Statements a capture adds to its mutation batch: two prune-before-admit deletes, events,
 * deliveries, dispatch job, overflow audit.
 */
export const CAPTURE_STATEMENTS = 6;
export const MAX_BATCH_STATEMENTS = 40;
const MAX_OVERFLOW_COUNT = 10_000;

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class NotificationPlanError extends Error {
  constructor() {
    super('Invalid notification plan');
    this.name = 'NotificationPlanError';
  }
}

function fail(): never {
  throw new NotificationPlanError();
}

function exact(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== key) fail();
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : fail();
}

function ulidOf(value: unknown): string {
  return typeof value === 'string' && isUlid(value) ? value : fail();
}

export const isNotificationDeliveryId = (value: unknown): value is string =>
  typeof value === 'string' && DELIVERY_ID.test(value);

/** The dispatch job carries only the operation it fans out. */
export function dispatchPayload(value: unknown): { readonly operationId: string } {
  return { operationId: ulidOf(exact(value, 'operationId')) };
}

/** The delivery job carries only the delivery id; body, URL and credentials stay sealed in rows. */
export function deliverPayload(value: unknown): { readonly deliveryId: string } {
  const deliveryId = exact(value, 'deliveryId');
  return isNotificationDeliveryId(deliveryId) ? { deliveryId } : fail();
}

function generationOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail();
}

export function dispatchJobRow(input: {
  readonly jobId: string;
  readonly operationId: string;
  readonly generation: number;
}): JobEnqueue {
  const operationId = ulidOf(input.operationId);
  const generation = generationOf(input.generation);
  return {
    id: ulidOf(input.jobId),
    type: NOTIFICATION_DISPATCH_JOB,
    payloadJson: canonicalPayload(dispatchPayload({ operationId })),
    idempotencyKey: storedIdempotencyKey(
      NOTIFICATION_DISPATCH_JOB,
      `dispatch:${operationId}:${String(generation)}`,
    ),
    resourceKey: null,
    runAt: null,
    maxAttempts: NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
    projectId: null,
    initiatorTokenId: null,
  };
}

/** One send per endpoint at a time: the endpoint is the job's resource key. */
export function deliverJobRow(input: {
  readonly jobId: string;
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly generation: number;
}): JobEnqueue {
  const { deliveryId } = deliverPayload({ deliveryId: input.deliveryId });
  const generation = generationOf(input.generation);
  if (typeof input.endpointId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(input.endpointId))
    fail();
  return {
    id: ulidOf(input.jobId),
    type: NOTIFICATION_DELIVER_JOB,
    payloadJson: canonicalPayload({ deliveryId }),
    idempotencyKey: deliverIdempotencyKey(deliveryId, generation),
    resourceKey: `notification:${input.endpointId}`,
    runAt: null,
    maxAttempts: NOTIFICATION_DELIVER_MAX_ATTEMPTS,
    projectId: null,
    initiatorTokenId: null,
  };
}

export function deliverIdempotencyKey(deliveryId: string, generation: number): string {
  return storedIdempotencyKey(
    NOTIFICATION_DELIVER_JOB,
    `deliver:${deliverPayload({ deliveryId }).deliveryId}:${String(generationOf(generation))}`,
  );
}

export type CaptureEventInput = {
  [T in NotificationEventType]: {
    readonly type: T;
    readonly projectId: string;
    readonly sourceId: string;
    readonly packageKey: string;
    readonly packageName: string;
    readonly version: string | null;
    readonly data: NotificationEventData[T];
  };
}[NotificationEventType];

export interface CapturedEvent {
  readonly ordinal: number;
  readonly projectId: string;
  readonly sourceId: string;
  readonly packageKey: string;
  readonly event: NotificationEvent;
  readonly payloadJson: string;
}

export interface NotificationCapturePlan {
  readonly operationId: string;
  readonly occurredAt: string;
  readonly events: readonly CapturedEvent[];
  readonly dispatch: JobEnqueue;
  /** Written instead of the events when the organization has no capacity left. */
  readonly overflow: AuditEvent;
}

export interface CapturePlanInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly occurredAt: string;
  readonly events: readonly CaptureEventInput[];
  readonly ulid: () => string;
}

/**
 * Validated envelopes plus the guarded work that commits with the package mutation; null when the
 * mutation produced no event. An operation over the event cap still yields a plan whose events
 * are refused by capacity, so its loss is audited rather than silently split.
 */
export function notificationCapturePlan(input: CapturePlanInput): NotificationCapturePlan | null {
  if (input.events.length === 0) return null;
  const operationId = ulidOf(input.operationId);
  const events = input.events.map((item, ordinal): CapturedEvent => {
    if (!isStoredKey(item.packageKey)) fail();
    if (typeof item.sourceId !== 'string' || item.sourceId.length === 0) fail();
    let event: NotificationEvent;
    try {
      event = notificationEvent({
        schemaVersion: 1,
        id: input.ulid(),
        type: item.type,
        occurredAt: input.occurredAt,
        operationId,
        organizationId: input.organizationId,
        projectId: item.projectId,
        package: { ecosystem: 'npm', name: item.packageName, version: item.version },
        data: item.data,
      });
    } catch {
      return fail();
    }
    return {
      ordinal,
      projectId: event.projectId,
      sourceId: item.sourceId,
      packageKey: item.packageKey,
      event,
      payloadJson: JSON.stringify(event),
    };
  });
  const first = events[0]!;
  const overflow = auditEvent({
    id: ulidOf(input.ulid()),
    now: input.occurredAt,
    action: 'notification.overflow',
    actor: { type: 'system', id: null },
    context: { opId: operationId, requestId: operationId, sourceIp: null, tokenSelector: null },
    target: { type: 'notification_operation', id: operationId },
    projectId: first.projectId,
    changes: {
      operation_id: { new: operationId },
      event_type: { new: first.event.type },
      event_count: { new: events.length },
    },
  });
  if (!overflow.ok) fail();
  return {
    operationId,
    occurredAt: first.event.occurredAt,
    events,
    dispatch: dispatchJobRow({ jobId: input.ulid(), operationId, generation: 1 }),
    overflow: overflow.event,
  };
}

/**
 * The overflow audit of a fan-out that has no single originating project: attributed to the
 * source whose package changed.
 */
export function sourceOverflowAudit(input: {
  readonly operationId: string;
  readonly occurredAt: string;
  readonly sourceId: string;
  readonly eventType: NotificationEventType;
  readonly eventCount: number;
  readonly ulid: () => string;
}): AuditEvent {
  const operationId = ulidOf(input.operationId);
  if (typeof input.sourceId !== 'string' || input.sourceId.length === 0) fail();
  const overflow = auditEvent({
    id: ulidOf(input.ulid()),
    now: input.occurredAt,
    action: 'notification.overflow',
    actor: { type: 'system', id: null },
    context: { opId: operationId, requestId: operationId, sourceIp: null, tokenSelector: null },
    target: { type: 'source', id: input.sourceId },
    projectId: null,
    changes: {
      operation_id: { new: operationId },
      event_type: { new: input.eventType },
      event_count: { new: Math.min(input.eventCount, MAX_OVERFLOW_COUNT) },
    },
  });
  return overflow.ok ? overflow.event : fail();
}

/** Refuses a batch that would exceed the writer's statement budget once capture is added. */
export function assertCaptureBudget(
  statements: number,
  capture: number = CAPTURE_STATEMENTS,
  limit: number = MAX_BATCH_STATEMENTS,
): void {
  if (
    !Number.isSafeInteger(statements) ||
    !Number.isSafeInteger(capture) ||
    capture < 1 ||
    statements + capture > limit
  )
    fail();
}
