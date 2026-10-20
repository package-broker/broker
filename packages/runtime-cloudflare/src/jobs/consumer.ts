import { orgContext, type OrgContext } from '@package-broker/core/db/port';
import { isUlid, ulid } from '@package-broker/core/ids';
import { reportableErrorName } from '@package-broker/core/kernel/error-name';
import type { RegisteredCoreJob, RegisteredJob } from '@package-broker/core/kernel/registry';
import { isRegisteredCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { PluginPorts } from '@package-broker/core/plugin';
import {
  JOB_HANDLER_BUDGET_SECONDS,
  JOB_HEARTBEAT_SECONDS,
  JOB_LEASE_SECONDS,
  type JobClaim,
  type JobEnqueue,
  type JobRepository,
  type JobSettle,
} from '@package-broker/core/platform/job-repository';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { releaseDelayOf } from '@package-broker/core/platform/job-release';
import { JobError, jobErrorCode } from '@package-broker/core/platform/jobs';
import type { Observability } from '@package-broker/core/platform/observability';

export const JOB_NOTIFICATION_VERSION = 1;
export const JOB_MAX_RUNNING = 2;
export const QUEUE_RETRY_DELAY_SECONDS = 30;
export const QUEUE_MAX_DELAY_SECONDS = 12 * 60 * 60;
export const QUEUE_MAX_BATCH_MESSAGES = 100;
export const SETTLE_RETRY_DELAY_MS = 250;
export const QUEUE_DELAY_SLACK_SECONDS = 2;

export const JOB_EVENTS = Object.freeze([
  'job.ack_failed',
  'job.batch_failed',
  'job.bury_failed',
  'job.claim_failed',
  'job.cron_failed',
  'job.delivery_failed',
  'job.due_scan_failed',
  'job.handler_failed',
  'job.heartbeat_failed',
  'job.lease_lost',
  'job.notification_rejected',
  'job.notify_failed',
  'job.observability_scope_failed',
  'job.reap_failed',
  'job.retry_failed',
  'job.schedule_sync_failed',
  'job.schedule_tick_failed',
  'job.settle_failed',
  'job.unregistered_buried',
] as const);

export type JobEvent = (typeof JOB_EVENTS)[number];

export const JOB_REASON_CODES = Object.freeze(['job.unregistered_type'] as const);

export type JobReasonCode = (typeof JOB_REASON_CODES)[number];

export interface JobNotification {
  readonly v: typeof JOB_NOTIFICATION_VERSION;
  readonly org: string;
  readonly job: string;
}

export interface QueueMessageLike {
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchLike {
  readonly messages: readonly QueueMessageLike[];
}

export interface QueueLike {
  send(body: JobNotification, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: readonly { body: JobNotification }[]): Promise<void>;
}

export interface JobRegistry {
  readonly jobs: readonly RegisteredJob[];
}

export interface QueueHandlerLimits {
  readonly budgetMs?: number;
  readonly heartbeatMs?: number;
  readonly maxRunning?: number;
  readonly settleRetryMs?: number;
}

export type JobScope = (
  job: RegisteredJob,
  claim: { readonly jobId: string; readonly attempt: number },
) => { readonly ports: PluginPorts; readonly observability: Observability };

export type RunnerObservability = (claim: {
  readonly jobId: string;
  readonly attempt: number;
}) => Observability;

export interface QueueHandlerDeps {
  readonly repository: JobRepository;
  readonly jobs: JobRegistry;
  readonly observability: Observability;
  readonly limits?: QueueHandlerLimits;
  readonly scope: JobScope;
  readonly runnerObservability?: RunnerObservability;
}

export type SendJob = (
  ctx: OrgContext,
  id: string,
  options?: { readonly delaySeconds?: number },
) => Promise<void>;

export type SendJobs = (ctx: OrgContext, ids: readonly string[]) => Promise<void>;

export function jobNotification(ctx: OrgContext, id: string): JobNotification {
  return { v: JOB_NOTIFICATION_VERSION, org: ctx.orgId, job: id };
}

export function createJobSender(queue: QueueLike): SendJob {
  return (ctx, id, options) =>
    options?.delaySeconds === undefined
      ? queue.send(jobNotification(ctx, id))
      : queue.send(jobNotification(ctx, id), { delaySeconds: options.delaySeconds });
}

export function createJobBatchSender(queue: QueueLike): SendJobs {
  return async (ctx, ids) => {
    for (let start = 0; start < ids.length; start += QUEUE_MAX_BATCH_MESSAGES) {
      const chunk = ids.slice(start, start + QUEUE_MAX_BATCH_MESSAGES);
      await queue.sendBatch(chunk.map((id) => ({ body: jobNotification(ctx, id) })));
    }
  };
}

function parseNotification(body: unknown): JobNotification | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  if (Object.keys(body).length !== 3) return null;
  const { v, org, job } = body as Record<string, unknown>;
  if (v !== JOB_NOTIFICATION_VERSION) return null;
  if (typeof org !== 'string' || !isUlid(org) || typeof job !== 'string' || !isUlid(job)) {
    return null;
  }
  return { v, org, job };
}

export function reportJobEvent(
  observability: Observability,
  level: 'info' | 'warn' | 'error',
  event: JobEvent,
  error?: unknown,
  fields: { job_id?: string; attempt?: number; reason_code?: JobReasonCode } = {},
): void {
  try {
    observability.log({
      level,
      event,
      ...(error === undefined ? {} : { error_name: reportableErrorName(error) }),
      ...fields,
    });
  } catch {
    /* observability must not break job delivery */
  }
}

function safely(observability: Observability, event: JobEvent, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    reportJobEvent(observability, 'error', event, error);
    return false;
  }
}

function count(observability: Observability, outcome: string): void {
  try {
    observability.counter('pb.jobs.notifications', { outcome });
  } catch {
    /* observability must not break job delivery */
  }
}

function notificationDelay(runAt: string | null): number | null {
  if (runAt === null) return 0;
  const seconds = Math.ceil((Date.parse(runAt) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const padded = seconds + QUEUE_DELAY_SLACK_SECONDS;
  return padded > QUEUE_MAX_DELAY_SECONDS ? null : padded;
}

/**
 * Commits the job to D1 first, then notifies; a failed send leaves a queued row that Cron recovers.
 * A `runAt` beyond the Queue delay limit is not sent: the row waits in SQL until Cron finds it due.
 */
export function enqueueAndNotify(deps: {
  readonly repository: JobRepository;
  readonly send: SendJob;
  readonly observability: Observability;
}): (
  ctx: OrgContext,
  row: JobEnqueue,
) => Promise<{ readonly id: string; readonly created: boolean }> {
  return async (ctx, row) => {
    const result = await deps.repository.enqueue(ctx, row);
    if (!result.created) return result;
    const delaySeconds = notificationDelay(row.runAt);
    if (delaySeconds === null) return result;
    try {
      await deps.send(ctx, result.id, delaySeconds > 0 ? { delaySeconds } : undefined);
    } catch (error) {
      reportJobEvent(deps.observability, 'warn', 'job.notify_failed', error, {
        job_id: result.id,
      });
    }
    return result;
  };
}

type Outcome = 'succeeded' | 'failed' | 'released' | 'lease_lost';

interface Execution {
  readonly settle: JobSettle | null;
  readonly outcome: Outcome;
}

function leaseDeadline(leaseUntil: string): number {
  const parsed = Date.parse(leaseUntil);
  return Number.isFinite(parsed) ? parsed : Date.now() + JOB_LEASE_SECONDS * 1000;
}

async function execute(
  deps: QueueHandlerDeps,
  ctx: OrgContext,
  claim: JobClaim,
  job: RegisteredJob,
  runner: Observability,
): Promise<Execution> {
  const { definition } = job;
  let payload: unknown;
  try {
    payload = definition.validate(JSON.parse(claim.payloadJson) as unknown);
  } catch (error) {
    const code = error instanceof JobError ? jobErrorCode(error) : 'invalid_payload';
    return {
      settle: { outcome: 'failed', errorCode: code, permanent: true },
      outcome: 'failed',
    };
  }

  let scoped: ReturnType<JobScope>;
  try {
    scoped = deps.scope(job, { jobId: claim.id, attempt: claim.attempt });
  } catch (error) {
    reportJobEvent(runner, 'warn', 'job.observability_scope_failed', error, {
      job_id: claim.id,
    });
    return {
      settle: { outcome: 'failed', errorCode: 'handler_error', permanent: false },
      outcome: 'failed',
    };
  }
  const observability = runner;

  const budgetMs = deps.limits?.budgetMs ?? JOB_HANDLER_BUDGET_SECONDS * 1000;
  const heartbeatMs = deps.limits?.heartbeatMs ?? JOB_HEARTBEAT_SECONDS * 1000;
  const controller = new AbortController();
  let stopReason: 'timeout' | 'lease_lost' | null = null;
  let stop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const halt = (reason: 'timeout' | 'lease_lost'): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    controller.abort(new JobError(reason));
    stop?.();
  };

  let deadline = leaseDeadline(claim.leaseUntil);
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const armLease = (): void => {
    if (leaseTimer !== undefined) clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => halt('lease_lost'), Math.max(0, deadline - Date.now()));
  };
  armLease();

  const budget = setTimeout(() => halt('timeout'), budgetMs);
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating || stopReason !== null) return;
    beating = true;
    const sentAt = Date.now();
    deps.repository
      .heartbeat(ctx, claim)
      .then(() => {
        if (stopReason !== null) return;
        deadline = Math.max(deadline, sentAt + JOB_LEASE_SECONDS * 1000);
        armLease();
      })
      .catch((error: unknown) => {
        if (jobErrorCode(error) === 'lease_lost') halt('lease_lost');
        else {
          reportJobEvent(observability, 'warn', 'job.heartbeat_failed', error, {
            job_id: claim.id,
          });
        }
      })
      .finally(() => {
        beating = false;
      });
  }, heartbeatMs);

  try {
    const run = Promise.resolve().then(() =>
      definition.handler(payload, {
        org: ctx,
        jobId: claim.id,
        idempotencyKey: claim.idempotencyKey,
        attempt: claim.attempt,
        fence: claim.fence,
        signal: controller.signal,
        ports: scoped.ports,
        observability: scoped.observability,
        ...(isRegisteredCoreJob(job as RegisteredCoreJob)
          ? { fences: jobFences({ id: claim.id, owner: claim.owner, fence: claim.fence }) }
          : {}),
      }),
    );
    run.catch(() => undefined);
    await Promise.race([run, stopped]);
    if (stopReason === 'lease_lost') return { settle: null, outcome: 'lease_lost' };
    if (stopReason === 'timeout') {
      return {
        settle: { outcome: 'failed', errorCode: 'timeout', permanent: false },
        outcome: 'failed',
      };
    }
    return { settle: { outcome: 'succeeded' }, outcome: 'succeeded' };
  } catch (error) {
    if (stopReason === 'lease_lost') return { settle: null, outcome: 'lease_lost' };
    reportJobEvent(observability, 'warn', 'job.handler_failed', error, {
      job_id: claim.id,
      attempt: claim.attempt,
    });
    const delaySeconds = releaseDelayOf(error);
    if (
      delaySeconds !== null &&
      stopReason === null &&
      isRegisteredCoreJob(job as RegisteredCoreJob)
    ) {
      return { settle: { outcome: 'released', delaySeconds }, outcome: 'released' };
    }
    return {
      settle: { outcome: 'failed', errorCode: jobErrorCode(error), permanent: false },
      outcome: 'failed',
    };
  } finally {
    clearTimeout(budget);
    clearInterval(heartbeat);
    if (leaseTimer !== undefined) clearTimeout(leaseTimer);
    if (stopReason === null) controller.abort(new JobError('aborted'));
  }
}

async function settleWithRetry(
  deps: QueueHandlerDeps,
  ctx: OrgContext,
  claim: JobClaim,
  settle: JobSettle,
  observability: Observability,
): Promise<void> {
  const fields = { job_id: claim.id, attempt: claim.attempt };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, deps.limits?.settleRetryMs ?? SETTLE_RETRY_DELAY_MS),
      );
    }
    try {
      await deps.repository.settle(ctx, claim, settle);
      return;
    } catch (error) {
      if (jobErrorCode(error) === 'lease_lost') {
        reportJobEvent(observability, 'warn', 'job.lease_lost', error, fields);
        return;
      }
      if (attempt > 0) reportJobEvent(observability, 'error', 'job.settle_failed', error, fields);
    }
  }
}

async function deliver(
  deps: QueueHandlerDeps,
  types: readonly string[],
  registered: ReadonlyMap<string, RegisteredJob>,
  message: QueueMessageLike,
): Promise<void> {
  const { observability } = deps;
  const ack = (outcome: string): void => {
    if (safely(observability, 'job.ack_failed', () => message.ack())) count(observability, outcome);
  };

  const notification = parseNotification(message.body);
  if (notification === null) {
    reportJobEvent(observability, 'warn', 'job.notification_rejected');
    ack('rejected');
    return;
  }

  let ctx: OrgContext;
  try {
    ctx = orgContext(notification.org);
  } catch (error) {
    reportJobEvent(observability, 'warn', 'job.notification_rejected', error);
    ack('rejected');
    return;
  }

  let claim: JobClaim | null;
  try {
    claim = await deps.repository.claim(ctx, ulid(), {
      id: notification.job,
      types,
      leaseSeconds: JOB_LEASE_SECONDS,
      maxRunning: deps.limits?.maxRunning ?? JOB_MAX_RUNNING,
    });
  } catch (error) {
    reportJobEvent(observability, 'warn', 'job.claim_failed', error, { job_id: notification.job });
    if (
      safely(observability, 'job.retry_failed', () => {
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
      })
    ) {
      count(observability, 'retried');
    }
    return;
  }

  if (claim === null) {
    ack('not_claimed');
    return;
  }

  const job = registered.get(claim.type);
  let runner = observability;
  try {
    runner =
      deps.runnerObservability?.({ jobId: claim.id, attempt: claim.attempt }) ?? observability;
  } catch (error) {
    reportJobEvent(observability, 'warn', 'job.observability_scope_failed', error, {
      job_id: claim.id,
    });
  }
  const execution: Execution =
    job === undefined
      ? {
          settle: { outcome: 'released', delaySeconds: QUEUE_RETRY_DELAY_SECONDS },
          outcome: 'released',
        }
      : await execute(deps, ctx, claim, job, runner);

  if (execution.settle === null) {
    reportJobEvent(runner, 'warn', 'job.lease_lost', undefined, {
      job_id: claim.id,
      attempt: claim.attempt,
    });
  } else {
    try {
      await settleWithRetry(deps, ctx, claim, execution.settle, runner);
    } catch (error) {
      reportJobEvent(runner, 'error', 'job.settle_failed', error, {
        job_id: claim.id,
        attempt: claim.attempt,
      });
    }
  }
  ack(execution.outcome);
}

export function createQueueHandler(
  deps: QueueHandlerDeps,
): (batch: QueueBatchLike, env: unknown) => Promise<void> {
  const registered = new Map<string, RegisteredJob>(
    deps.jobs.jobs.map((job) => [job.qualifiedName, job]),
  );
  const types = [...registered.keys()];

  return async (batch) => {
    try {
      const messages = Array.isArray(batch?.messages) ? batch.messages : [];
      for (const message of messages) {
        try {
          await deliver(deps, types, registered, message);
        } catch (error) {
          reportJobEvent(deps.observability, 'error', 'job.delivery_failed', error);
        }
      }
    } catch (error) {
      reportJobEvent(deps.observability, 'error', 'job.batch_failed', error);
    }
  };
}
