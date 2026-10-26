import { expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { RegisteredJob } from '@package-broker/core/kernel/registry';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { PluginPorts } from '@package-broker/core/plugin';
import type { JobClaim, JobRepository } from '@package-broker/core/platform/job-repository';
import { withJobSourceError } from '@package-broker/core/platform/job-source-error';
import { JobError } from '@package-broker/core/platform/jobs';
import { createQueueHandler, jobNotification } from './consumer.js';

it.each([true, false])(
  'passes a source failure code into settlement only for core jobs (core: %s)',
  async (core) => {
    const org = orgContext(ulid());
    const registered = registerCoreJob({
      name: 'package-sync',
      version: 1,
      validate: (input) => input,
      handler: async () => {
        throw withJobSourceError(new JobError('handler_error'), 'rate_limited');
      },
    });
    const job: RegisteredJob = core
      ? registered
      : { ...registered, plugin: 'fixture', qualifiedName: 'fixture:package-sync:v1' };
    const claim: JobClaim = {
      id: ulid(),
      owner: ulid(),
      fence: 1,
      type: job.qualifiedName,
      payloadJson: '{}',
      idempotencyKey: 'key',
      resourceKey: null,
      projectId: null,
      initiatorTokenId: null,
      attempt: 1,
      maxAttempts: 5,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const settle = vi.fn<JobRepository['settle']>().mockResolvedValue();
    const unexpected = async () => {
      throw new Error('unexpected repository call');
    };
    const repository: JobRepository = {
      enqueue: unexpected,
      status: unexpected,
      claim: async () => claim,
      heartbeat: unexpected,
      settle,
      reap: unexpected,
    };
    const observability = { log: () => {}, counter: () => {}, histogram: () => {} };
    const handle = createQueueHandler({
      repository,
      jobs: { jobs: [job] },
      observability,
      scope: () => ({ ports: {} as PluginPorts, observability }),
    });
    const ack = vi.fn();
    await handle({ messages: [{ body: jobNotification(org, claim.id), ack, retry: vi.fn() }] }, {});
    expect(settle).toHaveBeenCalledWith(org, expect.objectContaining({ id: claim.id }), {
      outcome: 'failed',
      errorCode: 'handler_error',
      permanent: false,
      ...(core ? { syncError: 'rate_limited' } : {}),
    });
    expect(ack).toHaveBeenCalledOnce();
  },
);
