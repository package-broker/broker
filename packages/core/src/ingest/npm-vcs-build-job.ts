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
}
export function npmVcsBuildEnqueueInput(payload: NpmVcsBuildPayload, now: number) {
  return {
    resourceKey: payload.versionId,
    idempotencyKey: `npm-vcs-build:${payload.versionId}:${Math.floor(now / 600_000)}`,
  };
}
export interface NpmVcsBuildTarget {
  readonly packageName: string;
  readonly version: string;
  readonly revision: number;
  readonly sourceRef: string;
}
export interface NpmVcsBuildDeps {
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
    Object.keys(value).sort().join(',') !== 'packageId,sourceId,version,versionId' ||
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
      const plan = await deps.plan(job, payload, lease);
      if (plan === null) return;
      await buildNpmVcsDist(plan.deps, job.org, plan.guard, plan.target);
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
