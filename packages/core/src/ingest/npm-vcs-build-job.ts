import { validateVersion } from '../catalogue/versions.js';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import type { JobGuard } from '../platform/job-repository.js';
import { canonicalPayload, defineJob, JobError, type JobContext } from '../platform/jobs.js';
import { buildNpmVcsDist, type DistFetchDeps, type DistFetchTarget } from './dist-fetch.js';

export const NPM_VCS_BUILD_JOB_TYPE = 'core:npm-vcs-build:v1';
export interface NpmVcsBuildPayload {
  readonly sourceId: string;
  readonly packageId: string;
  readonly versionId: string;
  readonly version: string;
  readonly sourceRef?: string;
  readonly packingPolicy?: string;
  readonly retryGeneration?: number;
}
export function npmVcsBuildEnqueueInput(payload: NpmVcsBuildPayload, now: number) {
  return {
    resourceKey: payload.versionId,
    idempotencyKey: `npm-vcs-build:${payload.versionId}:${payload.sourceRef ?? 'legacy'}:${payload.packingPolicy ?? 'legacy'}:${payload.retryGeneration ?? 0}:${Math.floor(now / 600_000)}`,
  };
}
export interface NpmVcsBuildTarget {
  readonly packageName: string;
  readonly version: string;
  readonly revision: number;
  readonly sourceRef: string;
  readonly retryGeneration: number;
}
export interface NpmVcsBuildDeps {
  readonly exhausted?: (
    job: JobContext,
    payload: NpmVcsBuildPayload,
    lease: JobGuard,
  ) => Promise<void>;
  readonly plan: (
    job: JobContext,
    payload: NpmVcsBuildPayload,
    lease: JobGuard,
  ) => Promise<{
    readonly deps: DistFetchDeps;
    readonly target: DistFetchTarget;
    readonly guard: CatalogueWriteGuard;
  } | null>;
}
function validate(input: unknown): NpmVcsBuildPayload {
  const value = JSON.parse(canonicalPayload(input)) as Record<string, unknown> | null;
  if (
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'packageId',
          'sourceId',
          'version',
          'versionId',
          'sourceRef',
          'packingPolicy',
          'retryGeneration',
        ].includes(key),
    ) ||
    (value.sourceRef !== undefined &&
      (typeof value.sourceRef !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRef))) ||
    (value.packingPolicy !== undefined &&
      (typeof value.packingPolicy !== 'string' ||
        !/^[a-z0-9:-]{1,100}$/.test(value.packingPolicy))) ||
    (value.retryGeneration !== undefined &&
      (!Number.isSafeInteger(value.retryGeneration) || (value.retryGeneration as number) < 0)) ||
    ![value.sourceId, value.packageId, value.versionId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(id),
    ) ||
    typeof value.version !== 'string'
  )
    throw new JobError('invalid_payload');
  try {
    validateVersion({ ecosystem: 'npm', version: value.version, versionNormalized: value.version });
  } catch {
    throw new JobError('invalid_payload');
  }
  return value as unknown as NpmVcsBuildPayload;
}
export function createNpmVcsBuildJob(deps: NpmVcsBuildDeps) {
  return defineJob({
    ...npmVcsBuildJob,
    validate,
    async handler(payload, job) {
      job.signal.throwIfAborted();
      const lease = jobLeaseOf(job);
      if (lease === null) throw new JobError('lease_lost');
      let plan: Awaited<ReturnType<NpmVcsBuildDeps['plan']>> = null;
      try {
        plan = await deps.plan(job, payload, lease);
        if (plan === null) return;
        await buildNpmVcsDist(plan.deps, job.org, plan.guard, plan.target);
      } catch (error) {
        if (
          !job.signal.aborted &&
          job.attempt >= 3 &&
          !(error instanceof JobError && error.code === 'lease_lost')
        ) {
          if (plan?.deps.reportSkipped !== undefined) {
            await plan.deps.reportSkipped('internal');
            return;
          }
          if (deps.exhausted !== undefined) {
            await deps.exhausted(job, payload, lease);
            return;
          }
        }
        throw error;
      }
    },
  });
}

export const npmVcsBuildJob = defineJob<NpmVcsBuildPayload>({
  name: 'npm-vcs-build',
  version: 1,
  maxAttempts: 3,
  validate,
  async handler(_payload, context) {
    if (context.signal.aborted) return;
    throw new JobError('invalid_definition');
  },
});
