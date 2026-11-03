import { auditEvent, type AuditAction, type AuditEvent } from '../audit/actions.js';
import {
  NOTIFICATION_HISTORY_MS,
  NOTIFICATION_RETENTION_PAGE,
  type NotificationDeliveryRecord,
  type NotificationRetentionRepository,
} from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import type { JobGuard } from '../platform/job-repository.js';
import { defineJob, JobError, type JobDefinition } from '../platform/jobs.js';
import { afterRetry } from './deliver.js';

export const NOTIFICATION_RETENTION_EVERY_SECONDS = 3600;
/** Prune pages one run handles before leaving the rest to the next hour. */
export const RETENTION_PAGES_PER_RUN = 10;
// Worst case: candidate read (1) + 20 orphan repairs with requeue (20 × 11)
// + redispatch read and writes (1 + 20 × 4) + ten guarded prunes (10 × 6)
// = 362 statements. Keep room below Workers' 500 for the job runner. Node uses the same bounds.
const REPAIR_LIMIT = 20;
const MAX_ATTEMPTS = 8;

export interface NotificationRetentionDeps {
  readonly retention: NotificationRetentionRepository;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  /** Best-effort wakeup of a job committed by this sweep. */
  readonly wake: (ctx: OrgContext, jobId: string) => Promise<void>;
}

function emptyPayload(input: unknown): Record<string, never> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 0
  )
    throw new JobError('invalid_payload');
  return {};
}

/**
 * The hourly notification sweep. It expires pending work past its 24-hour deadline, settles as
 * `unknown` an attempt whose job died while `sending`, cancels work its endpoint, project or source
 * admission refuses, gives dead delivery and dispatch jobs a new generation without touching
 * attempts or deadlines, then prunes history older than seven days. Pruned rows stay gone: only a
 * new domain commit creates notification work.
 */
export function createNotificationRetentionJob(
  deps: NotificationRetentionDeps,
): JobDefinition<Record<string, never>> {
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

  async function requeue(
    org: OrgContext,
    lease: JobGuard,
    delivery: Pick<NotificationDeliveryRecord, 'id' | 'revision'>,
  ): Promise<void> {
    const jobId = await deps.retention.requeue(org, lease, {
      deliveryId: delivery.id,
      expectedRevision: delivery.revision,
      jobId: deps.ids.ulid(),
    });
    if (jobId !== null) await deps.wake(org, jobId).catch(() => undefined);
  }

  async function repair(org: OrgContext, lease: JobGuard, signal: AbortSignal): Promise<void> {
    const now = deps.clock.now();
    const iso = now.toISOString();
    const candidates = await deps.retention.repairCandidates(org, iso, REPAIR_LIMIT);
    for (const candidate of candidates) {
      if (signal.aborted) throw new JobError('aborted');
      const delivery = candidate.delivery;
      switch (candidate.kind) {
        case 'expire': {
          const code = delivery.attempts >= MAX_ATTEMPTS ? 'attempt_limit' : 'expired';
          await deps.retention.expire(org, lease, {
            deliveryId: delivery.id,
            expectedRevision: delivery.revision,
            now: iso,
            code,
            event: audit('notification.delivery_finished', delivery, now, {
              outcome: 'failed',
              reason: code,
              delivery_state: 'failed',
            }),
          });
          break;
        }
        case 'orphan': {
          const after = afterRetry(delivery, delivery.attempts, iso, null);
          const reconciled = await deps.retention.reconcileOrphan(org, lease, {
            deliveryId: delivery.id,
            expectedRevision: delivery.revision,
            now: iso,
            delivery: after,
            event: audit('notification.delivery_finished', delivery, now, {
              attempt: delivery.attempts,
              outcome: 'unknown',
              reason: 'unknown',
              status: null,
              delivery_state: after.state,
            }),
          });
          if (reconciled && after.state === 'pending')
            await requeue(org, lease, { id: delivery.id, revision: delivery.revision + 1 });
          break;
        }
        case 'obsolete':
          await deps.retention.cancel(org, lease, {
            deliveryId: delivery.id,
            expectedRevision: delivery.revision,
            now: iso,
            code: candidate.code,
            event: audit('notification.delivery_cancelled', delivery, now, {
              reason: candidate.code,
            }),
          });
          break;
        case 'dead_job':
          await requeue(org, lease, delivery);
          break;
      }
    }
    const dispatched = await deps.retention.redispatch(org, lease, {
      now: iso,
      limit: REPAIR_LIMIT,
      jobId: () => deps.ids.ulid(),
    });
    for (const jobId of dispatched) await deps.wake(org, jobId).catch(() => undefined);
  }

  return defineJob({
    name: 'notification-retention',
    version: 1,
    schedule: { everySeconds: NOTIFICATION_RETENTION_EVERY_SECONDS },
    maxAttempts: 3,
    validate: emptyPayload,
    async handler(_payload, job) {
      const lease = jobLeaseOf(job);
      if (lease === null) throw new JobError('lease_lost');
      if (job.signal.aborted) throw new JobError('aborted');
      await repair(job.org, lease, job.signal);
      for (let page = 0; page < RETENTION_PAGES_PER_RUN; page += 1) {
        if (job.signal.aborted) throw new JobError('aborted');
        const now = deps.clock.now();
        const pruned = await deps.retention.prune(job.org, lease, {
          now: now.toISOString(),
          before: new Date(now.getTime() - NOTIFICATION_HISTORY_MS).toISOString(),
          limit: NOTIFICATION_RETENTION_PAGE,
        });
        if (Math.max(...Object.values(pruned)) < NOTIFICATION_RETENTION_PAGE) break;
      }
    },
  });
}
