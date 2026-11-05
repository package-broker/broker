import type { AuditEvent } from '../audit/actions.js';
import { FORBIDDEN_NAME_CHARACTERS } from '../catalogue/names.js';
import type { MutationFence } from '../authz/fence.js';
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '../notifications/events.js';
import type { JobGuard } from '../platform/job-repository.js';
import type { OrgContext, Statement } from './port.js';

export { NOTIFICATION_EVENT_TYPES, type NotificationEventType };
export {
  CAPTURE_STATEMENTS,
  MAX_BATCH_STATEMENTS,
  MAX_OPERATION_EVENTS,
  assertCaptureBudget,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DISPATCH_JOB,
  deliverIdempotencyKey,
  deliverJobRow,
  deliverPayload,
  dispatchJobRow,
  dispatchPayload,
  isNotificationDeliveryId,
  notificationCapturePlan,
  sourceOverflowAudit,
  type CaptureEventInput,
  type CapturePlanInput,
  type NotificationCapturePlan,
} from '../notifications/enqueue.js';

export const NOTIFICATION_METHODS = ['POST', 'PUT'] as const;
export type NotificationMethod = (typeof NOTIFICATION_METHODS)[number];

export const NOTIFICATION_ENDPOINT_STATES = ['enabled', 'disabled', 'deleted'] as const;
export type NotificationEndpointState = (typeof NOTIFICATION_ENDPOINT_STATES)[number];

export const NOTIFICATION_DISABLED_REASONS = [
  'manual',
  'configuration_changed',
  'failures',
  'credentials',
  'policy',
  'gone',
] as const;
export type NotificationDisabledReason = (typeof NOTIFICATION_DISABLED_REASONS)[number];

export const NOTIFICATION_DELIVERY_STATES = [
  'pending',
  'sending',
  'delivered',
  'failed',
  'cancelled',
] as const;
export type NotificationDeliveryState = (typeof NOTIFICATION_DELIVERY_STATES)[number];

export const NOTIFICATION_ATTEMPT_CODES = [
  'ok',
  'network',
  'timeout',
  'http_retry',
  'http_permanent',
  'redirect',
  'policy',
  'credentials',
  'template',
  'unknown',
] as const;
export type NotificationAttemptCode = (typeof NOTIFICATION_ATTEMPT_CODES)[number];

export const NOTIFICATION_DELIVERY_CODES = [
  ...NOTIFICATION_ATTEMPT_CODES,
  'expired',
  'attempt_limit',
  'disabled',
  'superseded',
  'project_inactive',
  'admission_lost',
  'deleted',
] as const;
export type NotificationDeliveryCode = (typeof NOTIFICATION_DELIVERY_CODES)[number];

export const NOTIFICATION_ATTEMPT_OUTCOMES = [
  'started',
  'delivered',
  'retry',
  'failed',
  'unknown',
] as const;
export type NotificationAttemptOutcome = (typeof NOTIFICATION_ATTEMPT_OUTCOMES)[number];

export const MAX_NOTIFICATION_ENDPOINTS = 20;
export const MAX_NOTIFICATION_ATTEMPTS = 8;
export const MAX_NOTIFICATION_PAGE = 50;
export const MAX_NOTIFICATION_NAME_LENGTH = 80;

/** Same printable-name rule as catalogue names: no control, format, separator or surrogate code points. */
export function isNotificationEndpointName(value: unknown): value is string {
  if (typeof value !== 'string' || FORBIDDEN_NAME_CHARACTERS.test(value)) return false;
  const length = [...value].length;
  return length >= 1 && length <= MAX_NOTIFICATION_NAME_LENGTH && value.trim() !== '';
}

export class NotificationRepositoryError extends Error {
  constructor(
    readonly code:
      'forbidden' | 'not_found' | 'conflict' | 'endpoint_limit' | 'invalid_request' | 'unavailable',
  ) {
    super(code);
    this.name = 'NotificationRepositoryError';
  }
}

function member<T extends string>(values: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    throw new NotificationRepositoryError('invalid_request');
  return value as T;
}

export const notificationEndpointState = (value: unknown): NotificationEndpointState =>
  member(NOTIFICATION_ENDPOINT_STATES, value);
export const notificationDeliveryState = (value: unknown): NotificationDeliveryState =>
  member(NOTIFICATION_DELIVERY_STATES, value);
export const notificationMethod = (value: unknown): NotificationMethod =>
  member(NOTIFICATION_METHODS, value);

/** A selection of one to five distinct event types, in canonical order. */
export function notificationEventSelection(value: unknown): readonly NotificationEventType[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOTIFICATION_EVENT_TYPES.length)
    throw new NotificationRepositoryError('invalid_request');
  const types = value.map((type) => member(NOTIFICATION_EVENT_TYPES, type));
  if (new Set(types).size !== types.length)
    throw new NotificationRepositoryError('invalid_request');
  return NOTIFICATION_EVENT_TYPES.filter((type) => types.includes(type));
}

/** Safe configuration summary: destination and signing key are always configured and never shown. */
export interface NotificationEndpointSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly method: NotificationMethod;
  readonly events: readonly NotificationEventType[];
  readonly packagePattern: string;
  readonly state: Exclude<NotificationEndpointState, 'deleted'>;
  readonly disabledReason: NotificationDisabledReason | null;
  readonly failureStreak: number;
  readonly revision: number;
  readonly destinationConfigured: true;
  readonly signingConfigured: true;
  readonly headersConfigured: boolean;
  readonly templateConfigured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationDeliverySummary {
  readonly id: string;
  readonly eventId: string;
  readonly endpointId: string;
  readonly eventType: NotificationEventType;
  readonly state: NotificationDeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastStatus: number | null;
  readonly outcomeCode: NotificationDeliveryCode | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface NotificationAttemptSummary {
  readonly attempt: number;
  readonly outcome: NotificationAttemptOutcome;
  readonly outcomeCode: NotificationAttemptCode | null;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface NotificationDeliveryDetail extends NotificationDeliverySummary {
  readonly history: readonly NotificationAttemptSummary[];
}

export interface NotificationPageQuery {
  readonly cursor?: string;
  readonly limit: number;
}

export interface NotificationDeliveryQuery extends NotificationPageQuery {
  readonly state?: NotificationDeliveryState;
}

export interface NotificationPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** Every read names the owning project; a foreign or missing identifier reads as absent. */
export interface NotificationReadRepository {
  listEndpoints(
    ctx: OrgContext,
    projectId: string,
    query: NotificationPageQuery,
  ): Promise<NotificationPage<NotificationEndpointSummary>>;
  getEndpoint(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
  ): Promise<NotificationEndpointSummary | null>;
  listDeliveries(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
    query: NotificationDeliveryQuery,
  ): Promise<NotificationPage<NotificationDeliverySummary>>;
  getDelivery(
    ctx: OrgContext,
    projectId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<NotificationDeliveryDetail | null>;
}

export interface NotificationPublicOptions {
  readonly name: string;
  readonly method: NotificationMethod;
  readonly events: readonly NotificationEventType[];
  readonly packagePattern: string;
}

/** A sealed configuration row prepared by the credential store for this endpoint and project. */
export interface NotificationSealedConfiguration {
  readonly credentialId: string;
  readonly statement: Statement;
  readonly headersConfigured: boolean;
  readonly templateConfigured: boolean;
}

interface NotificationChange {
  readonly projectId: string;
  readonly now: string;
  readonly event: AuditEvent;
}

export interface NotificationEndpointCreate extends NotificationChange {
  readonly id: string;
  readonly options: NotificationPublicOptions;
  readonly configuration: NotificationSealedConfiguration;
}

export interface NotificationEndpointUpdate extends NotificationChange {
  readonly id: string;
  readonly expectedRevision: number;
  readonly options?: NotificationPublicOptions;
  /** Present only when the destination, headers, signing key or template are replaced. */
  readonly configuration?: NotificationSealedConfiguration;
}

export interface NotificationEndpointTransition extends NotificationChange {
  readonly id: string;
  readonly expectedRevision: number;
}

export interface NotificationWriteResult {
  readonly changed: boolean;
  readonly revision: number;
}

/**
 * Configuration writes fence the human actor's session and `project:settings:write` at commit;
 * create, configuration replacement and delete also require a recent reauthentication.
 */
export interface NotificationWriteRepository {
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: NotificationEndpointCreate,
  ): Promise<NotificationWriteResult>;
  update(
    ctx: OrgContext,
    fence: MutationFence,
    input: NotificationEndpointUpdate,
  ): Promise<NotificationWriteResult>;
  enable(
    ctx: OrgContext,
    fence: MutationFence,
    input: NotificationEndpointTransition,
  ): Promise<NotificationWriteResult>;
  disable(
    ctx: OrgContext,
    fence: MutationFence,
    input: NotificationEndpointTransition,
  ): Promise<NotificationWriteResult>;
  delete(
    ctx: OrgContext,
    fence: MutationFence,
    input: NotificationEndpointTransition,
  ): Promise<NotificationWriteResult>;
}

/** A delivery as the dispatch and delivery jobs see it; carries no destination or secret. */
export interface NotificationDeliveryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly endpointId: string;
  readonly endpointRevision: number;
  readonly configurationCredentialId: string;
  readonly bodyCredentialId: string | null;
  readonly state: NotificationDeliveryState;
  readonly attempts: number;
  readonly jobGeneration: number;
  readonly activeJobId: string | null;
  readonly activeFence: number | null;
  readonly revision: number;
  readonly nextAttemptAt: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  /** When the latest finished attempt ended, for minimum retry spacing. */
  readonly lastFinishedAt: string | null;
}

export interface NotificationDispatchPage {
  /** Delivery jobs this page committed; wake them only after the commit. */
  readonly jobIds: readonly string[];
  /** No unscheduled recipient remains and the operation's events are marked dispatched. */
  readonly done: boolean;
}

export interface NotificationDispatchRepository {
  dispatchPage(
    ctx: OrgContext,
    lease: JobGuard,
    operationId: string,
  ): Promise<NotificationDispatchPage>;
}

export interface NotificationReserve {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly now: string;
  /** `notification.delivery_started` for attempt `attempts + 1`. */
  readonly event: AuditEvent;
}

export type NotificationReserveResult =
  | { readonly ok: true; readonly attempt: number; readonly revision: number }
  | { readonly ok: false };

export type NotificationDeliveryOutcome =
  | { readonly state: 'pending'; readonly nextAttemptAt: string }
  | {
      readonly state: 'delivered' | 'failed';
      readonly code: NotificationDeliveryCode;
    };

export interface NotificationSettle {
  readonly deliveryId: string;
  readonly attempt: number;
  readonly expectedRevision: number;
  readonly now: string;
  readonly outcome: Exclude<NotificationAttemptOutcome, 'started'>;
  readonly code: NotificationAttemptCode;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly delivery: NotificationDeliveryOutcome;
  /** Disables the endpoint now, whatever its failure streak. */
  readonly disable: Extract<NotificationDisabledReason, 'credentials' | 'policy' | 'gone'> | null;
  /** `notification.delivery_finished`; an auto-disable writes its own audit in the same batch. */
  readonly event: AuditEvent;
}

export interface NotificationReconcile {
  readonly deliveryId: string;
  readonly now: string;
  readonly delivery: NotificationDeliveryOutcome;
  /** `notification.delivery_finished` with outcome `unknown`. */
  readonly event: AuditEvent;
}

export const NOTIFICATION_FAILURE_LIMIT = 10;

/** Every write is fenced on the delivery job's live lease; a refused fence changes nothing. */
export interface NotificationAttemptRepository {
  load(ctx: OrgContext, deliveryId: string): Promise<NotificationDeliveryRecord | null>;
  reserve(
    ctx: OrgContext,
    lease: JobGuard,
    input: NotificationReserve,
  ): Promise<NotificationReserveResult>;
  settle(ctx: OrgContext, lease: JobGuard, input: NotificationSettle): Promise<boolean>;
  /** Turns an attempt a previous claim started and never settled into `unknown`. */
  reconcile(ctx: OrgContext, lease: JobGuard, input: NotificationReconcile): Promise<boolean>;
}

export const NOTIFICATION_CANCEL_CODES = [
  'disabled',
  'superseded',
  'project_inactive',
  'admission_lost',
  'deleted',
] as const;
export type NotificationCancelCode = (typeof NOTIFICATION_CANCEL_CODES)[number];

/** Terminal failures decided without a network attempt. */
export type NotificationFinishCode =
  'expired' | 'attempt_limit' | 'policy' | 'credentials' | 'template';

/** What one delivery attempt needs to decide, read org-scoped in one query. */
export interface NotificationDeliveryContext {
  readonly delivery: NotificationDeliveryRecord;
  /** The committed event envelope. */
  readonly payloadJson: string;
  /** Null when the endpoint row no longer exists. */
  readonly endpoint: {
    readonly state: NotificationEndpointState;
    readonly revision: number;
    readonly method: NotificationMethod;
  } | null;
  readonly projectActive: boolean;
  /** The event's source is still active and attached to the delivery's project. */
  readonly admitted: boolean;
}

export interface NotificationCancel {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly now: string;
  readonly code: NotificationCancelCode;
  /** `notification.delivery_cancelled`. */
  readonly event: AuditEvent;
}

export interface NotificationFinish {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly now: string;
  readonly code: NotificationFinishCode;
  readonly disable: Extract<NotificationDisabledReason, 'credentials' | 'policy'> | null;
  /** `notification.delivery_finished` with no attempt number change. */
  readonly event: AuditEvent;
}

export interface NotificationBodyAttach {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  /** A sealed `npm-notification-body` credential row prepared for this delivery and project. */
  readonly credentialId: string;
  readonly statement: Statement;
}

/**
 * Pending-delivery decisions the delivery job makes before any attempt; each write is fenced on
 * the job's lease, its claim on the delivery and the delivery revision.
 */
export interface NotificationPrepareRepository {
  context(ctx: OrgContext, deliveryId: string): Promise<NotificationDeliveryContext | null>;
  attachBody(ctx: OrgContext, lease: JobGuard, input: NotificationBodyAttach): Promise<boolean>;
  cancel(ctx: OrgContext, lease: JobGuard, input: NotificationCancel): Promise<boolean>;
  /** Fails without an attempt; template defects do not count toward the endpoint streak. */
  finish(ctx: OrgContext, lease: JobGuard, input: NotificationFinish): Promise<boolean>;
}

export const NOTIFICATION_RETENTION_PAGE = 100;
export const NOTIFICATION_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A delivery the hourly sweep must act on.
 * - `expire`: pending past `expires_at` (or out of attempts);
 * - `orphan`: `sending` while its job is dead, succeeded or gone;
 * - `obsolete`: pending while its endpoint, project or source admission no longer accepts it;
 * - `dead_job`: pending and in date while its job is dead, succeeded or gone.
 */
export type NotificationRepairCandidate =
  | {
      readonly kind: 'expire' | 'orphan' | 'dead_job';
      readonly delivery: NotificationDeliveryRecord;
    }
  | {
      readonly kind: 'obsolete';
      readonly delivery: NotificationDeliveryRecord;
      readonly code: NotificationCancelCode;
    };

export interface NotificationPruneResult {
  readonly attempts: number;
  readonly deliveries: number;
  readonly events: number;
  readonly endpoints: number;
  readonly credentials: number;
}

/**
 * Repair and retention writes for the hourly sweep job; every write runs under the sweep job's
 * lease guard and compares the delivery revision it read. Pages are at most
 * NOTIFICATION_RETENTION_PAGE rows.
 */
export interface NotificationRetentionRepository {
  repairCandidates(
    ctx: OrgContext,
    now: string,
    limit: number,
  ): Promise<readonly NotificationRepairCandidate[]>;
  /** Pending → failed `expired` or `attempt_limit`; counts toward the streak. */
  expire(
    ctx: OrgContext,
    lease: JobGuard,
    input: Omit<NotificationFinish, 'disable' | 'code'> & {
      readonly code: 'expired' | 'attempt_limit';
    },
  ): Promise<boolean>;
  /** Sending → the started attempt becomes `unknown`; the delivery takes `delivery`. Never counts. */
  reconcileOrphan(
    ctx: OrgContext,
    lease: JobGuard,
    input: NotificationReconcile & { readonly expectedRevision: number },
  ): Promise<boolean>;
  cancel(ctx: OrgContext, lease: JobGuard, input: NotificationCancel): Promise<boolean>;
  /**
   * Replaces the delivery's dead job with generation + 1 and records it as the active job; returns
   * the new job id, or null when the delivery changed. Attempts and deadline are untouched.
   */
  requeue(
    ctx: OrgContext,
    lease: JobGuard,
    input: {
      readonly deliveryId: string;
      readonly expectedRevision: number;
      readonly jobId: string;
    },
  ): Promise<string | null>;
  /** Undispatched operations whose dispatch job is dead or gone get generation + 1; job ids. */
  redispatch(
    ctx: OrgContext,
    lease: JobGuard,
    input: { readonly now: string; readonly limit: number; readonly jobId: () => string },
  ): Promise<readonly string[]>;
  /**
   * Deletes, in order and each bounded by `limit`: attempts and deliveries finished before
   * `before`, then events with no delivery left, deleted endpoints with no delivery left, and
   * notification credentials nothing references. Audit rows are never touched.
   */
  prune(
    ctx: OrgContext,
    lease: JobGuard,
    input: { readonly now: string; readonly before: string; readonly limit: number },
  ): Promise<NotificationPruneResult>;
}
