import { describe, expect, it, vi } from 'vitest';
import { createPublishApprovalExpireJob } from './publish-approval-expire-job.js';

describe('publish expiry job', () => {
  it('runs hourly with a bounded due-page reader', () => {
    const job = createPublishApprovalExpireJob({ publishes: {} as never });
    expect(job.name).toBe('publish-approval-expire');
    expect(job.version).toBe(1);
    expect(job.schedule).toEqual({ everySeconds: 3600 });
    expect(() => job.validate({ unexpected: true })).toThrow();
  });
  it('refuses to run without a job lease before reading', async () => {
    const listExpired = vi.fn(async () => []);
    const job = createPublishApprovalExpireJob({ publishes: { listExpired } as never });
    await expect(
      job.handler({}, {
        org: { orgId: 'org' },
        ports: { clock: { now: () => new Date() } },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('lease_lost');
    expect(listExpired).not.toHaveBeenCalled();
  });
});
