import { describe, expect, it, vi } from 'vitest';
import { createNpmVcsBuildJob, npmVcsBuildEnqueueInput } from './npm-vcs-build-job.js';
import { orgContext } from '../db/port.js';
import { jobFences } from '../platform/job-fences.js';
import type { JobContext } from '../platform/jobs.js';
const payload = { sourceId: 'S', packageId: 'P', versionId: 'V', version: '1.0.0' };
describe('npm VCS build job', () => {
  it('uses version identity as its lease resource', () => {
    expect(npmVcsBuildEnqueueInput(payload, 600_000)).toEqual({
      resourceKey: 'V',
      idempotencyKey: 'npm-vcs-build:V:1',
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
