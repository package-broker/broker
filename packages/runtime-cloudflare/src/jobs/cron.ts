import type { OrgContext } from '@package-broker/core/db/port';
import {
  JOB_REAP_PAGE_LIMIT,
  type JobRepository,
} from '@package-broker/core/platform/job-repository';
import type { Observability } from '@package-broker/core/platform/observability';
import {
  JOB_UNREGISTERED_GRACE_SECONDS,
  type DueJobLister,
} from '@package-broker/db-sqlite/repositories/job';
import {
  JobScheduleTickError,
  type JobScheduleRepository,
  type ScheduleDefinition,
} from '@package-broker/db-sqlite/repositories/job-schedule';
import { reportJobEvent, type SendJobs } from './consumer.js';

export const CRON_DUE_PAGE_LIMIT = 50;
export const CRON_BURY_PAGE_LIMIT = 50;

export interface ScheduledHandlerDeps {
  readonly repository: JobRepository & DueJobLister;
  readonly schedule: JobScheduleRepository;
  readonly sendJobs: SendJobs;
  /** The deployment singleton organization; null before bootstrap. */
  readonly org: () => Promise<OrgContext | null>;
  readonly definitions: readonly ScheduleDefinition[];
  /** Qualified names of every registered job type. */
  readonly types: readonly string[];
  readonly observability: Observability;
}

export function createScheduledHandler(
  deps: ScheduledHandlerDeps,
): (event: unknown, env: unknown) => Promise<void> {
  const { observability } = deps;
  const types = [...deps.types];
  let synced: Promise<void> | undefined;

  function syncOnce(ctx: OrgContext): Promise<void> {
    synced ??= deps.schedule.sync(ctx, deps.definitions).catch((error: unknown) => {
      synced = undefined;
      throw error;
    });
    return synced;
  }

  async function tick(ctx: OrgContext): Promise<string[]> {
    try {
      await syncOnce(ctx);
    } catch (error) {
      reportJobEvent(observability, 'error', 'job.schedule_sync_failed', error);
      return [];
    }
    try {
      return (await deps.schedule.tick(ctx)).map((fired) => fired.jobId);
    } catch (error) {
      reportJobEvent(observability, 'error', 'job.schedule_tick_failed', error);
      return error instanceof JobScheduleTickError ? error.fired.map((fired) => fired.jobId) : [];
    }
  }

  return async () => {
    try {
      const ctx = await deps.org();
      if (ctx === null) return;

      const fired = await tick(ctx);

      try {
        await deps.repository.reap(ctx, JOB_REAP_PAGE_LIMIT);
      } catch (error) {
        reportJobEvent(observability, 'error', 'job.reap_failed', error);
      }

      if (types.length > 0) {
        try {
          const buried = await deps.repository.buryUnregistered(ctx, {
            types,
            graceSeconds: JOB_UNREGISTERED_GRACE_SECONDS,
            limit: CRON_BURY_PAGE_LIMIT,
          });
          if (buried > 0) {
            reportJobEvent(observability, 'warn', 'job.unregistered_buried', undefined, {
              reason_code: 'job.unregistered_type',
            });
          }
        } catch (error) {
          reportJobEvent(observability, 'error', 'job.bury_failed', error);
        }
      }

      let due: readonly string[] = [];
      try {
        due = await deps.repository.listDue(ctx, { types, limit: CRON_DUE_PAGE_LIMIT });
      } catch (error) {
        reportJobEvent(observability, 'error', 'job.due_scan_failed', error);
      }

      const page = [...new Set([...fired, ...due])].slice(0, CRON_DUE_PAGE_LIMIT);
      if (page.length === 0) return;
      try {
        await deps.sendJobs(ctx, page);
      } catch (error) {
        reportJobEvent(observability, 'error', 'job.notify_failed', error);
      }
    } catch (error) {
      reportJobEvent(observability, 'error', 'job.cron_failed', error);
    }
  };
}
