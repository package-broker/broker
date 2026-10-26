import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid, type Clock } from '@package-broker/core/ids';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import type { RegisteredCoreJob, RegisteredJob } from '@package-broker/core/kernel/registry';
import { isRegisteredCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { PluginPorts } from '@package-broker/core/plugin';
import {
  JOB_HANDLER_BUDGET_SECONDS,
  JOB_HEARTBEAT_SECONDS,
  JOB_LEASE_SECONDS,
  JOB_REAP_PAGE_LIMIT,
  StaleFenceError,
  type JobClaim,
  type JobGuard,
  type JobRepository,
  type JobSettle,
} from '@package-broker/core/platform/job-repository';
import { jobSourceError } from '@package-broker/core/platform/job-source-error';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { releaseDelayOf } from '@package-broker/core/platform/job-release';
import { JobError, jobErrorCode } from '@package-broker/core/platform/jobs';
import { safeErrorName, type Observability } from '@package-broker/core/platform/observability';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import {
  createJobScheduleRepository,
  type ScheduleDefinition,
} from '@package-broker/db-sqlite/repositories/job-schedule';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';

export const JOB_POLL_MS = 1000;
export const JOB_DRAIN_MS = 10_000;
export const DEFAULT_MAX_RUNNING = 2;
const SCHEDULE_TICK_MS = 60_000;

export const JOB_EVENTS = Object.freeze([
  'job.loop_failed',
  'job.schedule_sync_failed',
  'job.schedule_tick_failed',
  'job.reap_failed',
  'job.claim_failed',
  'job.handler_failed',
  'job.heartbeat_failed',
  'job.settle_failed',
] as const);

type JobEvent = (typeof JOB_EVENTS)[number];

class PollStageError extends Error {
  constructor(
    readonly event: JobEvent,
    readonly inner: unknown,
  ) {
    super(event);
  }
}

export interface JobLoopStop {
  readonly abandoned: number;
}

export interface JobLoop {
  start(): void;
  stop(): Promise<JobLoopStop>;
}

export type JobScope = (
  job: RegisteredJob,
  claim: { readonly jobId: string; readonly attempt: number },
) => { readonly ports: PluginPorts; readonly observability: Observability };

export type RunnerObservability = (claim: {
  readonly jobId: string;
  readonly attempt: number;
}) => Observability;

export interface JobLoopInput {
  readonly executor: SqlExecutor;
  readonly jobs: readonly RegisteredJob[];
  readonly scope: JobScope;
  readonly maxRunning?: number;
  readonly clock?: Clock;
  readonly observability: Observability;
  readonly runnerObservability?: RunnerObservability;
}

interface Active {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  abandon(): void;
}

function unref(handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export function createJobLoop(input: JobLoopInput): JobLoop {
  const maxRunning = input.maxRunning ?? DEFAULT_MAX_RUNNING;
  if (!Number.isSafeInteger(maxRunning) || maxRunning < 1) {
    throw new RangeError('maxRunning must be a positive integer');
  }
  const clock = input.clock ?? systemClock;
  const { observability } = input;
  const repository: JobRepository = createJobRepository(input.executor);
  const schedules = createJobScheduleRepository(input.executor);
  const resolveOrg = createOrgResolver(createOrganizationBootstrap(input.executor));
  const byType = new Map(input.jobs.map((job) => [job.qualifiedName, job]));
  const types = [...byType.keys()];
  const definitions: ScheduleDefinition[] = input.jobs.flatMap((job) =>
    job.definition.schedule === undefined
      ? []
      : [
          {
            name: job.qualifiedName,
            everySeconds: job.definition.schedule.everySeconds,
            ...(job.definition.maxAttempts === undefined
              ? {}
              : { maxAttempts: job.definition.maxAttempts }),
          },
        ],
  );
  const active = new Map<string, Active>();
  let started = false;
  let stopping = false;
  let synced = false;
  let lastTickMinute: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;

  const log = (
    level: 'warn' | 'error',
    event: JobEvent,
    error: unknown,
    jobId?: string,
    target: Observability = observability,
  ): void => {
    try {
      target.log({
        level,
        event,
        error_name: safeErrorName(error),
        ...(jobId === undefined ? {} : { job_id: jobId }),
      });
    } catch {
      return;
    }
  };

  function arm(ms: number): void {
    if (stopping) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (polling !== undefined) return;
      polling = poll()
        .catch((error: unknown) =>
          error instanceof PollStageError
            ? log('error', error.event, error.inner)
            : log('error', 'job.loop_failed', error),
        )
        .finally(() => {
          polling = undefined;
          arm(JOB_POLL_MS);
        });
    }, ms);
  }

  async function stage<T>(event: JobEvent, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      throw new PollStageError(event, error);
    }
  }

  async function poll(): Promise<void> {
    const org = await resolveOrg();
    if (!synced) {
      await stage('job.schedule_sync_failed', () => schedules.sync(org, definitions));
      synced = true;
    }
    const minute = Math.floor(clock.now().getTime() / SCHEDULE_TICK_MS);
    if (minute !== lastTickMinute) {
      lastTickMinute = minute;
      try {
        await schedules.tick(org);
      } catch (error) {
        log('error', 'job.schedule_tick_failed', error);
      }
    }
    await stage('job.reap_failed', () => repository.reap(org, JOB_REAP_PAGE_LIMIT));
    while (!stopping && active.size < maxRunning && types.length > 0) {
      const claim = await stage('job.claim_failed', () =>
        repository.claim(org, ulid(), { types, leaseSeconds: JOB_LEASE_SECONDS, maxRunning }),
      );
      if (claim === null) return;
      run(org, claim);
    }
  }

  async function settle(org: OrgContext, guard: JobGuard, outcome: JobSettle): Promise<void> {
    try {
      await repository.settle(org, guard, outcome);
    } catch (error) {
      if (outcome.outcome !== 'succeeded' || error instanceof StaleFenceError) throw error;
      await repository.settle(org, guard, outcome);
    }
  }

  function runnerFor(claim: JobClaim): Observability {
    try {
      return (
        input.runnerObservability?.({ jobId: claim.id, attempt: claim.attempt }) ?? observability
      );
    } catch (error) {
      log('warn', 'job.handler_failed', error, claim.id);
      return observability;
    }
  }

  function run(org: OrgContext, claim: JobClaim): void {
    const controller = new AbortController();
    const guard = { id: claim.id, owner: claim.owner, fence: claim.fence };
    const startedAt = clock.now().getTime();
    const budgetMs = JOB_HANDLER_BUDGET_SECONDS * 1000;
    let finished = false;
    let abandoned = false;
    let beat: ReturnType<typeof setTimeout> | undefined;
    const runner = runnerFor(claim);
    const budget = unref(setTimeout(() => controller.abort(new JobError('timeout')), budgetMs));
    const finish = (): void => {
      finished = true;
      clearTimeout(budget);
      if (beat !== undefined) clearTimeout(beat);
      beat = undefined;
    };

    const heartbeat = (): void => {
      if (finished) return;
      beat = unref(
        setTimeout(() => {
          beat = undefined;
          if (finished || controller.signal.aborted) return;
          if (clock.now().getTime() - startedAt >= budgetMs) return;
          repository.heartbeat(org, guard).then(heartbeat, (error: unknown) => {
            if (finished) return;
            log('warn', 'job.heartbeat_failed', error, claim.id, runner);
            if (error instanceof StaleFenceError) controller.abort(error);
            else heartbeat();
          });
        }, JOB_HEARTBEAT_SECONDS * 1000),
      );
    };

    const execute = async (): Promise<JobSettle> => {
      const job = byType.get(claim.type);
      if (stopping) return { outcome: 'released', delaySeconds: 0 };
      if (job === undefined) return { outcome: 'released', delaySeconds: JOB_LEASE_SECONDS };
      let payload: unknown;
      try {
        payload = job.definition.validate(JSON.parse(claim.payloadJson) as unknown);
      } catch {
        return { outcome: 'failed', errorCode: 'invalid_payload', permanent: true };
      }
      let scoped: ReturnType<JobScope>;
      try {
        scoped = input.scope(job, { jobId: claim.id, attempt: claim.attempt });
      } catch (error) {
        log('warn', 'job.handler_failed', error, claim.id, runner);
        return { outcome: 'failed', errorCode: 'handler_error', permanent: false };
      }
      heartbeat();
      try {
        await job.definition.handler(payload, {
          org,
          jobId: claim.id,
          idempotencyKey: claim.idempotencyKey,
          attempt: claim.attempt,
          fence: claim.fence,
          signal: controller.signal,
          ports: scoped.ports,
          observability: scoped.observability,
          ...(isRegisteredCoreJob(job as RegisteredCoreJob) ? { fences: jobFences(guard) } : {}),
        });
        return { outcome: 'succeeded' };
      } catch (error) {
        log('warn', 'job.handler_failed', error, claim.id, runner);
        if (stopping && controller.signal.aborted) return { outcome: 'released', delaySeconds: 0 };
        const delaySeconds = releaseDelayOf(error);
        if (
          delaySeconds !== null &&
          !controller.signal.aborted &&
          isRegisteredCoreJob(job as RegisteredCoreJob)
        ) {
          return { outcome: 'released', delaySeconds };
        }
        const errorCode = controller.signal.aborted
          ? jobErrorCode(controller.signal.reason)
          : jobErrorCode(error);
        return {
          outcome: 'failed',
          errorCode,
          permanent: errorCode === 'invalid_payload',
          ...(!controller.signal.aborted &&
          isRegisteredCoreJob(job as RegisteredCoreJob) &&
          jobSourceError(error) !== undefined
            ? { syncError: jobSourceError(error)! }
            : {}),
        };
      }
    };

    const done = execute()
      .then(async (outcome) => {
        finish();
        if (abandoned) return;
        try {
          await settle(org, guard, outcome);
          runner.counter('pb.jobs.settled', { outcome: outcome.outcome });
        } catch (error) {
          log('warn', 'job.settle_failed', error, claim.id, runner);
        }
      })
      .finally(() => {
        active.delete(claim.owner);
        if (!stopping && polling === undefined) arm(0);
      });
    active.set(claim.owner, {
      controller,
      done,
      abandon() {
        abandoned = true;
        finish();
      },
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    arm(0);
  }

  let stopped: Promise<JobLoopStop> | undefined;

  async function drain(): Promise<JobLoopStop> {
    stopping = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const task of active.values()) task.controller.abort(new JobError('aborted'));
    const drained = (async () => {
      if (polling !== undefined) await polling;
      await Promise.allSettled([...active.values()].map((task) => task.done));
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, JOB_DRAIN_MS);
      }),
    ]);
    clearTimeout(deadline);
    const abandoned = active.size;
    for (const task of active.values()) task.abandon();
    active.clear();
    return { abandoned };
  }

  function stop(): Promise<JobLoopStop> {
    stopped ??= drain();
    return stopped;
  }

  return Object.freeze({ start, stop });
}
