import { auditEvent, type AuditAction, type AuditEvent } from '../audit/actions.js';
import type {
  NotificationAttemptCode,
  NotificationAttemptRepository,
  NotificationDeliveryOutcome,
  NotificationDeliveryRecord,
  NotificationDisabledReason,
  NotificationPrepareRepository,
  NotificationSettle,
} from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { JobRelease } from '../platform/job-release.js';
import type { JobGuard } from '../platform/job-repository.js';
import { defineJob, JobError, type JobDefinition } from '../platform/jobs.js';
import { validateSigningKey } from './config.js';
import type { NotificationCredentials } from './credentials.js';
import { NOTIFICATION_DELIVER_MAX_ATTEMPTS, deliverPayload } from './enqueue.js';
import {
  isNotificationDeliveryError,
  prepareDelivery,
  type NotificationBodies,
} from './prepare-delivery.js';
import { MAX_RELEASE_SECONDS, canStartAttempt, nextAttemptAt, parseRetryAfter } from './retry.js';
import { notificationHeaders } from './signature.js';
import type { NotificationTransport, NotificationTransportResult } from './transport.js';

/** Release used when another delivery to the same endpoint is sending or the row moved. */
export const BUSY_RELEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;

export interface NotificationDeliverDeps {
  readonly attempts: NotificationAttemptRepository;
  readonly prepare: NotificationPrepareRepository;
  readonly credentials: Pick<NotificationCredentials, 'open'>;
  readonly bodies: NotificationBodies;
  readonly transport: NotificationTransport;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

interface Classified {
  readonly outcome: NotificationSettle['outcome'];
  readonly code: NotificationAttemptCode;
  readonly status: number | null;
  readonly retryAfter: number | null;
  readonly disable: NotificationSettle['disable'];
}

/** The fixed outcome of one attempt; receiver text never leaves this function. */
export function classifyAttempt(result: NotificationTransportResult, now: Date): Classified {
  const base = { status: null, retryAfter: null, disable: null };
  switch (result.kind) {
    case 'refused':
      return { ...base, outcome: 'failed', code: 'policy', disable: 'policy' };
    case 'network':
    case 'timeout':
      return { ...base, outcome: 'retry', code: result.kind };
    case 'aborted':
      return { ...base, outcome: 'unknown', code: 'unknown' };
    case 'response':
      break;
  }
  const status = result.status;
  if (status >= 200 && status <= 299) return { ...base, status, outcome: 'delivered', code: 'ok' };
  if (status >= 300 && status <= 399)
    return { ...base, status, outcome: 'failed', code: 'redirect' };
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return {
      ...base,
      status,
      outcome: 'retry',
      code: 'http_retry',
      retryAfter: parseRetryAfter(result.retryAfter, now),
    };
  const disable: NotificationSettle['disable'] =
    status === 401 || status === 403 ? 'credentials' : status === 410 ? 'gone' : null;
  return { ...base, status, outcome: 'failed', code: 'http_permanent', disable };
}

/** The delivery state after a retryable or unknown attempt: the next slot, or a terminal limit. */
export function afterRetry(
  delivery: Pick<NotificationDeliveryRecord, 'createdAt'>,
  completedAttempts: number,
  now: string,
  retryAfter: number | null,
): NotificationDeliveryOutcome {
  const next = nextAttemptAt({
    createdAt: delivery.createdAt,
    completedAttempts,
    lastFinishedAt: now,
    retryAfterSeconds: retryAfter,
  });
  if (next !== null) return { state: 'pending', nextAttemptAt: next };
  return {
    state: 'failed',
    code: completedAttempts >= MAX_ATTEMPTS ? 'attempt_limit' : 'expired',
  };
}

function releaseUntil(due: string, now: Date): JobRelease {
  const seconds = Math.ceil((Date.parse(due) - now.getTime()) / 1000);
  return new JobRelease(Math.min(MAX_RELEASE_SECONDS, Math.max(1, seconds)));
}

/**
 * Executes one delivery: recheck and seal (prepare), commit the started attempt and its audit,
 * send through the transport, settle under the same fence, and release until the persisted due
 * time. Nothing reaches the network before the start commits.
 */
export function createNotificationDeliverJob(
  deps: NotificationDeliverDeps,
): JobDefinition<{ readonly deliveryId: string }> {
  function audit(
    action: AuditAction,
    delivery: NotificationDeliveryRecord,
    now: Date,
    fields: Record<string, string | number | null>,
  ): AuditEvent {
    const result = auditEvent({
      id: deps.ids.ulid(),
      now: now.toISOString(),
      action,
      actor: { type: 'system', id: null },
      target: { type: 'notification_delivery', id: delivery.id },
      projectId: delivery.projectId,
      context: {
        opId: deps.ids.ulid(),
        requestId: deps.ids.ulid(),
        sourceIp: null,
        tokenSelector: null,
      },
      changes: Object.fromEntries(
        Object.entries({
          endpoint_id: delivery.endpointId,
          event_id: delivery.eventId,
          delivery_id: delivery.id,
          ...fields,
        }).map(([key, value]) => [key, { new: value }]),
      ),
    });
    if (!result.ok) throw new JobError('handler_error');
    return result.event;
  }

  async function reconcile(
    org: OrgContext,
    lease: JobGuard,
    delivery: NotificationDeliveryRecord,
  ): Promise<void> {
    const now = deps.clock.now();
    const after = afterRetry(delivery, delivery.attempts, now.toISOString(), null);
    const ok = await deps.attempts.reconcile(org, lease, {
      deliveryId: delivery.id,
      now: now.toISOString(),
      delivery: after,
      event: audit('notification.delivery_finished', delivery, now, {
        attempt: delivery.attempts,
        outcome: 'unknown',
        reason: 'unknown',
        status: null,
        delivery_state: after.state,
      }),
    });
    if (!ok) throw new JobError('lease_lost');
  }

  async function finishWithout(
    org: OrgContext,
    lease: JobGuard,
    delivery: NotificationDeliveryRecord,
    code: 'expired' | 'attempt_limit' | 'policy' | 'credentials' | 'template',
    disable: 'credentials' | 'policy' | null,
  ): Promise<void> {
    const now = deps.clock.now();
    const ok = await deps.prepare.finish(org, lease, {
      deliveryId: delivery.id,
      expectedRevision: delivery.revision,
      now: now.toISOString(),
      code,
      disable,
      event: audit('notification.delivery_finished', delivery, now, {
        outcome: 'failed',
        reason: code,
        delivery_state: 'failed',
      }),
    });
    if (!ok) throw new JobRelease(1);
  }

  return defineJob({
    name: 'notification-deliver',
    version: 1,
    maxAttempts: NOTIFICATION_DELIVER_MAX_ATTEMPTS,
    validate: deliverPayload,
    async handler(payload, job) {
      const lease = jobLeaseOf(job);
      if (lease === null) throw new JobError('lease_lost');
      const org = job.org;
      let context = await deps.prepare.context(org, payload.deliveryId);
      if (context === null || context.delivery.activeJobId !== lease.id) return;
      if (context.delivery.state === 'sending') {
        const fence = context.delivery.activeFence;
        if (fence === null || fence >= lease.fence) throw new JobError('lease_lost');
        await reconcile(org, lease, context.delivery);
        context = await deps.prepare.context(org, payload.deliveryId);
        if (context === null) return;
      }
      const delivery = context.delivery;
      if (delivery.state !== 'pending') return;

      const verdict = canStartAttempt({
        createdAt: delivery.createdAt,
        attempts: delivery.attempts,
        nextAttemptAt: delivery.nextAttemptAt,
        now: deps.clock.now(),
      });
      if (verdict === 'expired') {
        await finishWithout(
          org,
          lease,
          delivery,
          delivery.attempts >= MAX_ATTEMPTS ? 'attempt_limit' : 'expired',
          null,
        );
        return;
      }
      if (verdict !== 'start') throw new JobRelease(verdict.wait);

      const prepared = await prepareDelivery(
        { ...deps, repository: deps.prepare },
        org,
        lease,
        context,
      );
      if (prepared.kind === 'stale') throw new JobRelease(1);
      if (prepared.kind === 'cancel') {
        const now = deps.clock.now();
        const ok = await deps.prepare.cancel(org, lease, {
          deliveryId: delivery.id,
          expectedRevision: delivery.revision,
          now: now.toISOString(),
          code: prepared.code,
          event: audit('notification.delivery_cancelled', delivery, now, {
            reason: prepared.code,
          }),
        });
        if (!ok) throw new JobRelease(1);
        return;
      }
      if (prepared.kind === 'fail') {
        await finishWithout(org, lease, delivery, prepared.code, prepared.disable);
        return;
      }

      const startedAt = deps.clock.now();
      const reserved = await deps.attempts.reserve(org, lease, {
        deliveryId: delivery.id,
        expectedRevision: delivery.revision,
        now: startedAt.toISOString(),
        event: audit('notification.delivery_started', delivery, startedAt, {
          attempt: delivery.attempts + 1,
        }),
      });
      if (!reserved.ok) throw new JobRelease(BUSY_RELEASE_SECONDS);

      const { configuration, body, method, event } = prepared;
      let result: NotificationTransportResult | null;
      try {
        const signed = await notificationHeaders({
          key: validateSigningKey(configuration.signingKey),
          timestamp: Math.floor(deps.clock.now().getTime() / 1000),
          deliveryId: delivery.id,
          eventId: event.id,
          method,
          body,
        });
        result = await deps.transport.send({
          url: configuration.url,
          method,
          headers: configuration.headers,
          signed,
          body,
          signal: job.signal,
        });
      } catch (error) {
        if (!isNotificationDeliveryError(error)) throw error;
        result = null;
      }

      const now = deps.clock.now();
      const classified: Classified =
        result === null
          ? {
              outcome: 'failed',
              code: 'credentials',
              status: null,
              retryAfter: null,
              disable: 'credentials',
            }
          : classifyAttempt(result, now);
      const durationMs = result?.durationMs ?? 0;
      const after: NotificationDeliveryOutcome =
        classified.outcome === 'delivered'
          ? { state: 'delivered', code: 'ok' }
          : classified.outcome === 'failed'
            ? { state: 'failed', code: classified.code }
            : afterRetry(delivery, reserved.attempt, now.toISOString(), classified.retryAfter);
      const disable: Extract<NotificationDisabledReason, 'credentials' | 'policy' | 'gone'> | null =
        classified.outcome === 'failed' ? classified.disable : null;
      const settled = await deps.attempts.settle(org, lease, {
        deliveryId: delivery.id,
        attempt: reserved.attempt,
        expectedRevision: reserved.revision,
        now: now.toISOString(),
        outcome: classified.outcome,
        code: classified.code,
        status: classified.status,
        durationMs,
        delivery: after,
        disable,
        event: audit('notification.delivery_finished', delivery, now, {
          attempt: reserved.attempt,
          outcome: classified.outcome,
          reason: classified.code,
          status: classified.status,
          duration_ms: durationMs,
          delivery_state: after.state,
        }),
      });
      if (!settled) throw new JobError('lease_lost');
      if (after.state === 'pending') throw releaseUntil(after.nextAttemptAt, now);
    },
  });
}
