import {
  NotificationRepositoryError,
  type NotificationDispatchRepository,
} from '../db/notifications.js';
import type { OrgContext } from '../db/port.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { JobRelease } from '../platform/job-release.js';
import { defineJob, JobError, type JobDefinition } from '../platform/jobs.js';
import { NOTIFICATION_DISPATCH_MAX_ATTEMPTS, dispatchPayload } from './enqueue.js';

/** Pages one invocation dispatches before releasing itself, so a large fan-out never hogs a lease. */
export const DISPATCH_PAGES_PER_RUN = 8;

export interface NotificationDispatchDeps {
  readonly dispatch: NotificationDispatchRepository;
  /** Best-effort queue wakeup after commit; a lost wakeup leaves the durable job for polling. */
  readonly wake: (ctx: OrgContext, jobId: string) => Promise<void>;
}

/**
 * Fans out an operation's recipient snapshot: each page atomically enqueues delivery jobs and
 * records their ids, so a crashed or repeated run resumes from the rows, never from a fresh
 * recipient selection.
 */
export function createNotificationDispatchJob(
  deps: NotificationDispatchDeps,
): JobDefinition<{ readonly operationId: string }> {
  return defineJob({
    name: 'notification-dispatch',
    version: 1,
    maxAttempts: NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
    validate: dispatchPayload,
    async handler(payload, job) {
      const lease = jobLeaseOf(job);
      if (lease === null) throw new JobError('lease_lost');
      for (let page = 0; page < DISPATCH_PAGES_PER_RUN; page += 1) {
        if (job.signal.aborted) throw new JobError('aborted');
        let result;
        try {
          result = await deps.dispatch.dispatchPage(job.org, lease, payload.operationId);
        } catch (error) {
          throw new JobError(
            error instanceof NotificationRepositoryError && error.code === 'conflict'
              ? 'lease_lost'
              : 'handler_error',
          );
        }
        for (const jobId of result.jobIds) await deps.wake(job.org, jobId).catch(() => undefined);
        if (result.done) return;
      }
      throw new JobRelease(1);
    },
  });
}
