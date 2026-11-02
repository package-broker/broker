import { POLICY_EXPIRY_PAGE, type RegistryPolicyExpiry } from '../../db/registry-policy.js';
import { jobPurgeFence } from '../../platform/job-fences.js';
import { defineJob, JobError, type JobDefinition } from '../../platform/jobs.js';

export const REGISTRY_POLICY_EXPIRE_JOB = 'core:registry-policy-expire:v1';
/** A full page was marked but no follow-up could be queued; the next hourly run continues. */
export const REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT = 'registry_policy.expiry_deferred';

/**
 * Records expiry evidence for one organization's rules. Serving decides expiry from the clock on
 * every request, so a late, repeated or missing run never changes what a rule restricted.
 */
export function createRegistryPolicyExpiryJob(expiry: RegistryPolicyExpiry): JobDefinition {
  return defineJob<unknown>({
    name: 'registry-policy-expire',
    version: 1,
    schedule: { everySeconds: 3600 },
    validate(input: unknown) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 0
      )
        throw new JobError('invalid_payload');
      return {};
    },
    async handler(_payload, job) {
      if (job.signal.aborted) return;
      const fence = jobPurgeFence(job);
      if (fence === null) throw new JobError('lease_lost');
      const rows = await expiry.due(job.org, POLICY_EXPIRY_PAGE);
      let marked = false;
      for (const row of rows) {
        if (job.signal.aborted) return;
        marked =
          (await expiry.mark(job.org, fence, {
            id: row.id,
            revision: row.revision,
            audit: {
              id: job.ports.ids.ulid(),
              occurredAt: job.ports.clock.now().toISOString(),
              context: {
                opId: job.ports.ids.ulid(),
                requestId: job.jobId,
                sourceIp: null,
                tokenSelector: null,
              },
            },
          })) || marked;
      }
      if (rows.length < POLICY_EXPIRY_PAGE || !marked || job.signal.aborted) return;
      const jobs = job.ports.platform?.jobs;
      if (jobs === undefined) {
        job.observability.log({ level: 'warn', event: REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT });
        return;
      }
      const last = rows.at(-1)!;
      await jobs.enqueue(
        job.org,
        REGISTRY_POLICY_EXPIRE_JOB,
        {},
        {
          idempotencyKey: `${job.jobId}:${last.id}:${String(last.revision)}`,
        },
      );
    },
  });
}
