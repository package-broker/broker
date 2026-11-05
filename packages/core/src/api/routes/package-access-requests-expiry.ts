import { auditEvent } from '../../audit/actions.js';
import type { PackageAccessRequestRepository } from '../../db/publishes.js';
import { jobPurgeFence } from '../../platform/job-fences.js';
import { defineJob, JobError, type JobDefinition } from '../../platform/jobs.js';

export function createPackageAccessExpiryJob(
  repository: PackageAccessRequestRepository,
): JobDefinition {
  return defineJob<unknown>({
    name: 'package-access-expire',
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
      if (job.signal.aborted) return;
      const rows = await repository.due(job.org);
      let changed = false;
      for (const row of rows) {
        if (job.signal.aborted) return;
        const now = job.ports.clock.now().toISOString();
        const event = auditEvent({
          id: job.ports.ids.ulid(),
          now,
          action: 'package.access_decide',
          actor: { type: 'system', id: 'package-access-expire' },
          context: {
            opId: job.ports.ids.ulid(),
            requestId: job.jobId,
            sourceIp: null,
            tokenSelector: null,
          },
          target: { type: 'package', id: row.packageId },
          projectId: row.projectId,
          changes: {
            package: { new: row.packageName },
            project_id: { new: row.projectId },
            state: { old: 'pending', new: 'expired' },
          },
        });
        if (!event.ok) throw new JobError('handler_error');
        const result = await repository.decide(job.org, fence, {
          id: row.id,
          expectedRevision: row.revision,
          state: 'expired',
          decidedByUserId: null,
          now,
          event: event.event,
        });
        changed ||= result.changed;
      }
      if (rows.length < 10 || !changed || job.signal.aborted) return;
      const jobs = job.ports.platform?.jobs;
      if (jobs === undefined) throw new JobError('handler_error');
      const last = rows.at(-1)!;
      await jobs.enqueue(
        job.org,
        'core:package-access-expire:v1',
        {},
        {
          idempotencyKey: `${job.jobId}:${last.id}:${last.revision}`,
        },
      );
    },
  });
}
