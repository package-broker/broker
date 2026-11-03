import { describe, expect, it, vi } from 'vitest';
import { NotificationRepositoryError, type NotificationDispatchPage } from '../db/notifications.js';
import { orgContext } from '../db/port.js';
import { jobFences } from '../platform/job-fences.js';
import { JobRelease } from '../platform/job-release.js';
import { JobError, type JobContext } from '../platform/jobs.js';
import { DISPATCH_PAGES_PER_RUN, createNotificationDispatchJob } from './dispatch.js';

const ORG = orgContext('01J00000000000000000000A0A');
const OP = '01J0P0000000000000000000P1';
const LEASE = { id: 'job', owner: 'owner', fence: 2 };

function context(signal = new AbortController().signal, leased = true): JobContext {
  return {
    org: ORG,
    jobId: 'job',
    idempotencyKey: 'k',
    attempt: 1,
    fence: 2,
    signal,
    ports: {} as never,
    observability: {} as never,
    ...(leased ? { fences: jobFences(LEASE) } : {}),
  };
}

function pages(...results: NotificationDispatchPage[]) {
  const dispatchPage = vi.fn(async () => results.shift() ?? { jobIds: [], done: true });
  return { dispatchPage };
}

describe('notification dispatch job', () => {
  it('accepts only an operation id payload', () => {
    const job = createNotificationDispatchJob({ dispatch: pages(), wake: vi.fn() });
    expect(job.validate({ operationId: OP })).toEqual({ operationId: OP });
    expect(() => job.validate({ operationId: OP, url: 'https://x.example' })).toThrow();
    expect(job.name).toBe('notification-dispatch');
  });

  it('pages until no unscheduled recipient remains and wakes only committed jobs', async () => {
    const dispatch = pages({ jobIds: ['J1', 'J2'], done: false }, { jobIds: ['J3'], done: true });
    const wake = vi.fn(async () => undefined);
    await createNotificationDispatchJob({ dispatch, wake }).handler({ operationId: OP }, context());
    expect(dispatch.dispatchPage).toHaveBeenCalledTimes(2);
    expect(dispatch.dispatchPage).toHaveBeenCalledWith(ORG, LEASE, OP);
    expect(wake.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['J1', 'J2', 'J3']);
  });

  it('survives lost wakeups: the committed jobs stay for runtime polling', async () => {
    const dispatch = pages({ jobIds: ['J1'], done: true });
    const wake = vi.fn(async () => {
      throw new Error('queue down');
    });
    await expect(
      createNotificationDispatchJob({ dispatch, wake }).handler({ operationId: OP }, context()),
    ).resolves.toBeUndefined();
  });

  it('releases itself after a bounded number of pages instead of holding the lease', async () => {
    const dispatch = {
      dispatchPage: vi.fn(async () => ({ jobIds: ['J'], done: false })),
    };
    const error = await createNotificationDispatchJob({ dispatch, wake: vi.fn(async () => {}) })
      .handler({ operationId: OP }, context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobRelease);
    expect(dispatch.dispatchPage).toHaveBeenCalledTimes(DISPATCH_PAGES_PER_RUN);
  });

  it('refuses to run without a lease and maps a lost fence to lease_lost', async () => {
    const job = createNotificationDispatchJob({ dispatch: pages(), wake: vi.fn() });
    await expect(job.handler({ operationId: OP }, context(undefined, false))).rejects.toMatchObject(
      {
        code: 'lease_lost',
      },
    );
    const lost = createNotificationDispatchJob({
      dispatch: {
        dispatchPage: vi.fn(async () => {
          throw new NotificationRepositoryError('conflict');
        }),
      },
      wake: vi.fn(),
    });
    await expect(lost.handler({ operationId: OP }, context())).rejects.toMatchObject({
      code: 'lease_lost',
    });
    const broken = createNotificationDispatchJob({
      dispatch: {
        dispatchPage: vi.fn(async () => {
          throw new Error('SENTINEL');
        }),
      },
      wake: vi.fn(),
    });
    const error = await broken.handler({ operationId: OP }, context()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(String(error)).not.toMatch(/SENTINEL/);
  });

  it('stops when the job is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatch = pages({ jobIds: [], done: false });
    await expect(
      createNotificationDispatchJob({ dispatch, wake: vi.fn() }).handler(
        { operationId: OP },
        context(controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(dispatch.dispatchPage).not.toHaveBeenCalled();
  });
});
