import { createSourcePollJob } from '../ingest/retention-jobs.js';
import { createSourceSyncJob, type SourceSyncDeps } from '../ingest/source-sync-job.js';
import type { Jobs } from '../platform/jobs.js';
import type { RouteDefinition } from '../plugin.js';
import { registerCoreJob, type RegisteredCoreJob } from '../runtime/core-jobs.js';
import { createWebhookIntake, type WebhookIntakeDeps } from '../sources/webhooks.js';

export interface RegistryJobsDeps {
  readonly sourceSync: SourceSyncDeps;
  readonly sourcePoll: Parameters<typeof createSourcePollJob>[0];
  readonly webhook: Omit<WebhookIntakeDeps, 'jobs'>;
}

export interface RegistryJobs {
  readonly coreJobs: readonly RegisteredCoreJob[];
  readonly coreRoutes: readonly RouteDefinition[];
}

export function createRegistryJobs(
  deps: RegistryJobsDeps,
  jobs: Pick<Jobs, 'enqueue'>,
): RegistryJobs {
  const sourceSync = createSourceSyncJob(deps.sourceSync);
  return Object.freeze({
    coreJobs: Object.freeze([
      registerCoreJob({
        ...sourceSync,
        async handler(input: unknown, context) {
          await sourceSync.handler(sourceSync.validate(input), context);
        },
      }),
      registerCoreJob(createSourcePollJob(deps.sourcePoll)),
    ]),
    coreRoutes: Object.freeze([createWebhookIntake({ ...deps.webhook, jobs })]),
  });
}
