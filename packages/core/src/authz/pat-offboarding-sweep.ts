import type { OrgContext } from '../db/port.js';
import { isoTimestamp, type Clock } from '../ids.js';
import { JobError, type Jobs } from '../platform/jobs.js';
import { registerCoreJob, type RegisteredCoreJob } from '../runtime/core-jobs.js';
import type { AdminLog } from './administration.js';
import { PAT_OFFBOARDING_JOB_TYPE } from './pat-offboarding.js';

export const PAT_OFFBOARDING_SWEEP_PAGE_SIZE = 100;
export const PAT_OFFBOARDING_SWEEP_MAX_PAGES = 20;

export interface PatOffboardingSweepStore {
  /** Ids above `afterId` ('' for the first page) of the organization's suspended users that still hold an unrevoked personal token, ordered by id. */
  suspendedUsersWithLivePats(
    ctx: OrgContext,
    afterId: string,
    limit: number,
  ): Promise<readonly string[]>;
}

export interface PatOffboardingSweepDeps {
  readonly store: PatOffboardingSweepStore;
  readonly jobs: Pick<Jobs, 'enqueue'>;
  readonly clock: Clock;
  readonly log: AdminLog;
}

function validate(input: unknown): Record<string, never> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new JobError('invalid_payload');
  }
  const proto = Object.getPrototypeOf(input) as unknown;
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(input).length !== 0) {
    throw new JobError('invalid_payload');
  }
  return {};
}

export function createPatOffboardingSweepJob(deps: PatOffboardingSweepDeps): RegisteredCoreJob {
  const { store, jobs, clock } = deps;

  return registerCoreJob({
    name: 'pat-offboarding-sweep',
    version: 1,
    schedule: { everySeconds: 86_400 },
    maxAttempts: 3,
    validate,
    async handler(_input, context) {
      const org = context.org;
      const cutoff = isoTimestamp(clock.now());
      const day = cutoff.slice(0, 10);

      let enqueued = 0;
      let afterId = '';
      for (let pageNumber = 0; pageNumber < PAT_OFFBOARDING_SWEEP_MAX_PAGES; pageNumber += 1) {
        if (context.signal.aborted) throw new JobError('aborted');
        const page = await store.suspendedUsersWithLivePats(
          org,
          afterId,
          PAT_OFFBOARDING_SWEEP_PAGE_SIZE,
        );
        for (const userId of page) {
          if (context.signal.aborted) throw new JobError('aborted');
          try {
            const result = await jobs.enqueue(
              org,
              PAT_OFFBOARDING_JOB_TYPE,
              { userId, cause: 'suspended', cutoff },
              {
                idempotencyKey: `pat-offboarding:${userId}:suspended:sweep:${day}`,
                resourceKey: `user:${userId}`,
              },
            );
            if (result.created) enqueued += 1;
          } catch (error) {
            // An earlier run of the day stored the same key with its own cutoff.
            if (!(error instanceof JobError) || error.code !== 'idempotency_conflict') throw error;
          }
          afterId = userId;
        }
        if (page.length < PAT_OFFBOARDING_SWEEP_PAGE_SIZE) break;
      }

      try {
        deps.log({ level: 'info', event: 'token.offboarding_sweep', orgId: org.orgId, enqueued });
      } catch {
        // The enqueues are stored; a failing sink must not turn them into a retry.
      }
    },
  });
}
