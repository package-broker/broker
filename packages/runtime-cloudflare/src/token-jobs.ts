import {
  enqueuePatOffboarding,
  enqueueProjectRemovedPatOffboarding,
  createPatOffboardingJob,
} from '@package-broker/core/authz/pat-offboarding';
import { createPatOffboardingSweepJob } from '@package-broker/core/authz/pat-offboarding-sweep';
import type { ProjectAdministrationDeps } from '@package-broker/core/authz/project-administration';
import type { TokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { RegisteredCoreJob } from '@package-broker/core/kernel/registry';
import { JobError, type Jobs } from '@package-broker/core/platform/jobs';
import { createPatOffboardingRepository } from '@package-broker/db-sqlite/repositories/pat-offboarding';

export interface PatJobHolder {
  set(jobs: Jobs): void;
  get(): Jobs;
}

export function createPatJobHolder(): PatJobHolder {
  let current: Jobs | undefined;
  return {
    set(jobs) {
      if (current !== undefined) throw new Error('personal-token jobs are already set');
      current = jobs;
    },
    get() {
      if (current === undefined) throw new JobError('handler_error');
      return current;
    },
  };
}

function lazyJobs(holder: PatJobHolder): Pick<Jobs, 'enqueue'> {
  return {
    enqueue: (ctx, type, payload, input) => holder.get().enqueue(ctx, type, payload, input),
  };
}

export function patOffboardingRegistrations(
  executor: SqlExecutor,
  holder: PatJobHolder,
  log: KernelLog,
): readonly RegisteredCoreJob[] {
  const store = createPatOffboardingRepository(executor);
  return [
    createPatOffboardingJob({ store, clock: systemClock, ids: { ulid }, log }),
    createPatOffboardingSweepJob({ store, jobs: lazyJobs(holder), clock: systemClock, log }),
  ];
}

export interface TokenWiring {
  readonly lifetime: TokenLifetimePolicy;
  readonly offboarding: Pick<ProjectAdministrationDeps, 'onUserOffboarded' | 'onProjectAccessLost'>;
}

export function tokenWiring(
  lifetime: TokenLifetimePolicy,
  holder: PatJobHolder,
  jobsAvailable: boolean,
): TokenWiring {
  const jobs = lazyJobs(holder);
  return {
    lifetime,
    offboarding: jobsAvailable
      ? {
          onUserOffboarded: enqueuePatOffboarding(jobs),
          onProjectAccessLost: enqueueProjectRemovedPatOffboarding(jobs),
        }
      : {},
  };
}
