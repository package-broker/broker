import { expect, it, vi } from 'vitest';
import { createOidcReplayExpiryJob } from './expiry.js';
import type { JobContext } from '../../../platform/jobs.js';
import { orgContext } from '../../../db/port.js';
it('defines hourly organization-scoped replay cleanup with a bounded repository call', async () => {
  const purge = vi.fn(async () => 0);
  const job = createOidcReplayExpiryJob({ purge });
  const org = orgContext('org');
  const ctx = {
    org,
    signal: new AbortController().signal,
    ports: { clock: { now: () => new Date('2026-10-31T00:00:00.000Z') } },
  } as JobContext;
  expect(job.name).toBe('oidc-replay-expire');
  expect(job.version).toBe(1);
  expect(job.schedule).toEqual({ everySeconds: 3600 });
  expect(job.validate({})).toEqual({});
  await job.handler({}, ctx);
  expect(purge).toHaveBeenCalledExactlyOnceWith(org, '2026-10-31T00:00:00.000Z');
});
it.each([null, [], { token: 'secret' }, 1])(
  'refuses nonempty or malformed expiry payloads',
  (input) => {
    const job = createOidcReplayExpiryJob({ purge: vi.fn() });
    expect(() => job.validate(input)).toThrow('invalid_payload');
  },
);
it('does not purge when the job is cancelled', async () => {
  const purge = vi.fn(async () => 0);
  const job = createOidcReplayExpiryJob({ purge });
  const controller = new AbortController();
  controller.abort();
  await job.handler({}, { signal: controller.signal } as JobContext);
  expect(purge).not.toHaveBeenCalled();
});

it('drains full chunks until a partial chunk', async () => {
  const purge = vi
    .fn()
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce(1);
  await createOidcReplayExpiryJob({ purge }).handler({}, {
    org: orgContext('org'),
    signal: new AbortController().signal,
    ports: { clock: { now: () => new Date('2026-10-31T00:00:00.000Z') } },
  } as JobContext);
  expect(purge).toHaveBeenCalledTimes(3);
});
it('caps cleanup at fifty chunks', async () => {
  const purge = vi.fn(async () => 100);
  await createOidcReplayExpiryJob({ purge }).handler({}, {
    org: orgContext('org'),
    signal: new AbortController().signal,
    ports: { clock: { now: () => new Date('2026-10-31T00:00:00.000Z') } },
  } as JobContext);
  expect(purge).toHaveBeenCalledTimes(50);
});
it('checks cancellation between chunks', async () => {
  const controller = new AbortController();
  const purge = vi.fn(async () => {
    controller.abort();
    return 100;
  });
  await createOidcReplayExpiryJob({ purge }).handler({}, {
    org: orgContext('org'),
    signal: controller.signal,
    ports: { clock: { now: () => new Date('2026-10-31T00:00:00.000Z') } },
  } as JobContext);
  expect(purge).toHaveBeenCalledTimes(1);
});
