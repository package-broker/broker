import { describe, expect, it, vi } from 'vitest';
import { createNpmVcsBuildJob, npmVcsBuildEnqueueInput } from './npm-vcs-build-job.js';
import { orgContext } from '../db/port.js';
import { jobFences } from '../platform/job-fences.js';
import { JobError, type JobContext } from '../platform/jobs.js';
const payload = { sourceId: 'S', packageId: 'P', versionId: 'V', version: '1.0.0' };
describe('npm VCS build job', () => {
  it('uses version identity as its lease resource', () => {
    expect(npmVcsBuildEnqueueInput(payload, 600_000)).toEqual({
      resourceKey: 'V',
      idempotencyKey: 'npm-vcs-build:V:legacy:legacy:0:1',
    });
  });
  it.each([
    null,
    {},
    { ...payload, extra: true },
    { ...payload, versionId: '../V' },
    { ...payload, sourceId: 'a'.repeat(65) },
    { ...payload, version: '1.0.0+build' },
  ])('refuses invalid closed payloads', (input) => {
    expect(() => createNpmVcsBuildJob({} as never).validate(input)).toThrow('invalid_payload');
  });
  it('requires a job lease before reading any source or opening an archive', async () => {
    const plan = vi.fn();
    const job = createNpmVcsBuildJob({ plan } as never);
    await expect(
      job.handler(payload, { signal: new AbortController().signal } as JobContext),
    ).rejects.toThrow('lease_lost');
    expect(plan).not.toHaveBeenCalled();
  });
  it('passes the authenticated job lease to the build and stops when the target is gone', async () => {
    const plan = vi.fn().mockResolvedValue(null);
    const job = createNpmVcsBuildJob({ plan } as never);
    const lease = { id: 'J', owner: 'worker', fence: 2 };
    const context = {
      org: orgContext('org'),
      fences: jobFences(lease),
      signal: new AbortController().signal,
    } as JobContext;
    await job.handler(payload, context);
    expect(plan).toHaveBeenCalledWith(context, payload, lease);
  });
});

it.each([1, 3])('records exhausted failures only after attempt %s', async (attempt) => {
  const reportSkipped = vi.fn();
  const provider = { openDist: vi.fn().mockRejectedValue(new Error('opaque failure')) };
  const context = {
    org: orgContext('org'),
    attempt,
    fences: jobFences({ id: 'J', owner: 'worker', fence: 1 }),
    signal: new AbortController().signal,
  } as JobContext;
  const job = createNpmVcsBuildJob({
    plan: async () => ({
      deps: {
        source: { type: 'vcs', ecosystem: 'npm' },
        providerContext: { signal: context.signal },
        provider,
        reportSkipped,
      },
      target: { previousBlob: null, fetch: { sourceRef: 'a'.repeat(40) } },
      guard: [],
    }),
  } as never);
  if (attempt < 3) {
    await expect(job.handler(payload, context)).rejects.toThrow('opaque failure');
    expect(reportSkipped).not.toHaveBeenCalled();
  } else {
    await job.handler(payload, context);
    expect(reportSkipped).toHaveBeenCalledExactlyOnceWith('internal');
  }
});

it.each([1, 3])('records exhausted planning failures on attempt %s', async (attempt) => {
  const exhausted = vi.fn();
  const plan = vi.fn().mockRejectedValue(new Error('planning failed'));
  const context = {
    org: orgContext('org'),
    attempt,
    fences: jobFences({ id: 'J', owner: 'worker', fence: 1 }),
    signal: new AbortController().signal,
  } as JobContext;
  const job = createNpmVcsBuildJob({ plan, exhausted });
  if (attempt === 3) {
    await job.handler(payload, context);
    expect(exhausted).toHaveBeenCalledWith(context, payload, {
      id: 'J',
      owner: 'worker',
      fence: 1,
    });
  } else {
    await expect(job.handler(payload, context)).rejects.toThrow('planning failed');
    expect(exhausted).not.toHaveBeenCalled();
  }
});
it('does not record planning failures after a lost lease or cancellation', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const exhausted = vi.fn();
    const plan = vi.fn(async () => {
      if (cancelled) controller.abort();
      throw new JobError('lease_lost');
    });
    const context = {
      org: orgContext('org'),
      attempt: 3,
      fences: jobFences({ id: 'J', owner: 'worker', fence: 1 }),
      signal: controller.signal,
    } as JobContext;
    await expect(
      createNpmVcsBuildJob({ plan, exhausted }).handler(payload, context),
    ).rejects.toThrow('lease_lost');
    expect(exhausted).not.toHaveBeenCalled();
  }
});
