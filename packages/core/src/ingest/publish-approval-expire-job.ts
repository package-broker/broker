import { auditEvent } from '../audit/actions.js';
import { PUBLISH_APPROVAL_EXPIRY_BATCH_SIZE, type PublishesRepository } from '../db/publishes.js';
import { jobLeaseOf } from '../platform/job-fences.js';
import { defineJob, JobError } from '../platform/jobs.js';

export function createPublishApprovalExpireJob(deps: { readonly publishes: PublishesRepository }) {
  return defineJob({
    name: 'publish-approval-expire',
    version: 1,
    schedule: { everySeconds: 3600 },
    validate(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        throw new JobError('invalid_payload');
      return {};
    },
    async handler(_input, job) {
      const lease = jobLeaseOf(job);
      if (!lease) throw new JobError('lease_lost');
      const now = job.ports.clock.now().toISOString();
      const page = await deps.publishes.listExpired(job.org, now);
      for (const item of page) {
        if (job.signal.aborted) return;
        const event = auditEvent({
          id: job.ports.ids.ulid(),
          now,
          action: 'publish.expire',
          actor: { type: 'system', id: null },
          target: { type: 'publish', id: item.id },
          changes: { package: { new: item.packageName }, version: { new: item.version } },
          context: {
            opId: job.ports.ids.ulid(),
            requestId: job.ports.ids.ulid(),
            sourceIp: null,
            tokenSelector: null,
          },
        });
        if (!event.ok) throw new JobError('handler_error');
        await deps.publishes.expire(job.org, job.fences!.verifier(), {
          id: item.id,
          expectedRevision: item.revision,
          expectedApprovalState: item.approvalState,
          expectedScanState: item.scanState,
          now,
          event: event.event,
        });
      }
      const last = page[PUBLISH_APPROVAL_EXPIRY_BATCH_SIZE - 1];
      if (last && !job.signal.aborted) {
        const jobs = job.ports.platform?.jobs;
        if (!jobs) throw new JobError('handler_error');
        await jobs.enqueue(
          job.org,
          'core:publish-approval-expire:v1',
          {},
          { idempotencyKey: `publish-expire:${last.id}:${last.revision}` },
        );
      }
    },
  });
}
