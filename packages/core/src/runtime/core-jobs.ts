import { defineJob, type JobDefinition } from '../platform/jobs.js';
import type { RegisteredJob } from '../kernel/registry.js';

declare const coreJobBrand: unique symbol;

export interface RegisteredCoreJob extends RegisteredJob {
  readonly [coreJobBrand]: true;
}

const issuedCoreJobs = new WeakSet<RegisteredCoreJob>();

/** Runtime-only: `core` is rejected as a plugin id, so core job types are qualified here. */
export function registerCoreJob(definition: JobDefinition): RegisteredCoreJob {
  const frozen = defineJob(definition);
  const qualifiedName = `core:${frozen.name}:v${frozen.version}`;
  const job = Object.freeze({
    plugin: 'core',
    qualifiedName,
    definition: frozen,
  }) as RegisteredCoreJob;
  issuedCoreJobs.add(job);
  return job;
}

export function isRegisteredCoreJob(job: RegisteredCoreJob): boolean {
  return issuedCoreJobs.has(job);
}
