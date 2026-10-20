import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import type { PurgeGeneration, Sha256 } from '../platform/blob.js';
import { JobError, type JobContext } from '../platform/jobs.js';
import { registerCoreJob } from '../runtime/core-jobs.js';
import {
  blobPurgeJob,
  createBlobPurgeJob,
  createRetentionScanJob,
  createSourcePollJob,
  retentionScanJob,
  sourcePollJob,
} from './retention-jobs.js';

const org = orgContext('org-a');
const gen = 'c'.repeat(32) as PurgeGeneration;
const sha = (n: number) => String(n).padStart(64, '0') as Sha256;
const NOW = new Date('2026-10-20T10:00:00.000Z');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function context(over: Partial<JobContext> = {}) {
  const enqueue = vi.fn(async (...args: unknown[]) => {
    void args;
    return { id: 'j', created: true };
  });
  const job = {
    org,
    jobId: 'job-1',
    idempotencyKey: 'schedule:tick',
    attempt: 1,
    fence: 3,
    signal: new AbortController().signal,
    ports: { clock: { now: () => NOW }, platform: { jobs: { enqueue } } },
    observability: { counter: vi.fn(), histogram: vi.fn(), log: vi.fn() },
    ...over,
  } as unknown as JobContext;
  return { job, enqueue };
}

function candidate(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `id-${String(n)}`,
    sha256: sha(n),
    createdAt: `2020-01-01T00:00:0${String(n % 10)}.000Z`,
    orphan: false,
    retentionDaysOverride: null,
    ...over,
  };
}

function scanFixture() {
  const reader = {
    candidates: vi.fn(async (): Promise<ReturnType<typeof candidate>[]> => []),
    scheduledIneligible: vi.fn(
      async (): Promise<{ id: string; sha256: string; createdAt: string }[]> => [],
    ),
  };
  const lifecycle = {
    softDelete: vi.fn(async () => true),
    scheduleOrphan: vi.fn(async () => true),
    claimPurge: vi.fn(async (): Promise<PurgeGeneration | null> => gen),
    cancelPurge: vi.fn(async () => true),
    unschedule: vi.fn(async () => true),
    removeBytes: vi.fn(async (): Promise<'queued' | 'removed' | 'refused'> => 'queued'),
    listDue: vi.fn(async (): Promise<Sha256[]> => []),
  };
  return { reader, lifecycle, job: createRetentionScanJob({ reader, lifecycle }) };
}

describe('definitions', () => {
  it('register as version one core jobs with their cadence', () => {
    const f = scanFixture();
    const sources = { listDue: vi.fn(), deferPoll: vi.fn() };
    const poll = createSourcePollJob({ sources });
    const purge = createBlobPurgeJob({ lifecycle: f.lifecycle });
    expect(registerCoreJob(f.job).qualifiedName).toBe('core:retention-scan:v1');
    expect(registerCoreJob(purge).qualifiedName).toBe('core:blob-purge:v1');
    expect(registerCoreJob(poll).qualifiedName).toBe('core:source-poll:v1');
    expect([f.job.schedule, purge.schedule, poll.schedule]).toEqual([
      { everySeconds: 86400 },
      { everySeconds: 3600 },
      { everySeconds: 60 },
    ]);
  });

  it('refuses to run unbound', async () => {
    for (const unbound of [retentionScanJob, blobPurgeJob, sourcePollJob]) {
      await expect(unbound.handler({} as never, context().job)).rejects.toThrow(
        'invalid_definition',
      );
    }
  });

  it.each([
    [{ scan: { createdAt: 1, id: 'x' } }],
    [{ scan: { createdAt: 'a', id: 'x', extra: 1 } }],
    [{ other: null }],
    [[]],
    [null],
    [{ sweep: 'x' }],
  ])('rejects scan payload %j', (payload) => {
    expect(() => scanFixture().job.validate(payload)).toThrow(JobError);
  });

  it.each([[{ after: 'A'.repeat(64) }], [{ after: 'a'.repeat(63) }], [{ x: 1 }], [null]])(
    'rejects purge payload %j',
    (payload) => {
      expect(() =>
        createBlobPurgeJob({ lifecycle: scanFixture().lifecycle }).validate(payload),
      ).toThrow(JobError);
    },
  );

  it('accepts only an empty poll payload', () => {
    const poll = createSourcePollJob({ sources: { listDue: vi.fn(), deferPoll: vi.fn() } });
    expect(poll.validate({})).toEqual({});
    expect(() => poll.validate({ a: 1 })).toThrow(JobError);
  });
});

describe('retention scan', () => {
  it('soft-deletes a non-orphan with now as removedAt and the source override', async () => {
    const f = scanFixture();
    f.reader.candidates.mockResolvedValue([
      candidate(1),
      candidate(2, { retentionDaysOverride: 400 }),
    ]);
    const { job } = context();
    await f.job.handler(f.job.validate({}), job);
    expect(f.lifecycle.softDelete).toHaveBeenNthCalledWith(1, org, sha(1), {
      removedAt: NOW.toISOString(),
    });
    expect(f.lifecycle.softDelete).toHaveBeenNthCalledWith(2, org, sha(2), {
      removedAt: NOW.toISOString(),
      retentionDays: 400,
    });
    expect(f.lifecycle.scheduleOrphan).not.toHaveBeenCalled();
    expect(f.lifecycle.claimPurge).not.toHaveBeenCalled();
  });

  it('schedules an orphan and claims it right away, then removes the bytes', async () => {
    const f = scanFixture();
    f.reader.candidates.mockResolvedValue([candidate(1, { orphan: true })]);
    await f.job.handler(f.job.validate({}), context().job);
    expect(f.lifecycle.softDelete).not.toHaveBeenCalled();
    expect(f.lifecycle.scheduleOrphan).toHaveBeenCalledExactlyOnceWith(org, sha(1));
    expect(f.lifecycle.claimPurge).toHaveBeenCalledExactlyOnceWith(org, sha(1));
    expect(f.lifecycle.removeBytes).toHaveBeenCalledExactlyOnceWith(org, sha(1), gen);
    expect(f.lifecycle.cancelPurge).not.toHaveBeenCalled();
    const order = [
      f.lifecycle.scheduleOrphan.mock.invocationCallOrder[0],
      f.lifecycle.claimPurge.mock.invocationCallOrder[0],
      f.lifecycle.removeBytes.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((x, y) => (x ?? 0) - (y ?? 0)));
  });

  it('does not claim an orphan that was not scheduled', async () => {
    const f = scanFixture();
    f.reader.candidates.mockResolvedValue([candidate(1, { orphan: true })]);
    f.lifecycle.scheduleOrphan.mockResolvedValue(false);
    await f.job.handler(f.job.validate({}), context().job);
    expect(f.lifecycle.claimPurge).not.toHaveBeenCalled();
  });

  it('leaves a lost claim alone and cancels a refused removal with its generation', async () => {
    const f = scanFixture();
    f.reader.candidates.mockResolvedValue([
      candidate(1, { orphan: true }),
      candidate(2, { orphan: true }),
    ]);
    f.lifecycle.claimPurge.mockResolvedValueOnce(null);
    f.lifecycle.removeBytes.mockResolvedValue('refused');
    await f.job.handler(f.job.validate({}), context().job);
    expect(f.lifecycle.removeBytes).toHaveBeenCalledExactlyOnceWith(org, sha(2), gen);
    expect(f.lifecycle.cancelPurge).toHaveBeenCalledExactlyOnceWith(org, sha(2), gen);
  });

  it('unschedules every scheduled blob that is no longer eligible', async () => {
    const f = scanFixture();
    f.reader.scheduledIneligible.mockResolvedValue([
      { id: 'i1', sha256: sha(7), createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'i2', sha256: sha(8), createdAt: '2020-01-02T00:00:00.000Z' },
    ]);
    await f.job.handler(f.job.validate({}), context().job);
    expect(f.lifecycle.unschedule.mock.calls).toEqual([
      [org, sha(7)],
      [org, sha(8)],
    ]);
  });

  it('pages by 50 and re-enqueues only the phases that were full, with a stable key', async () => {
    const f = scanFixture();
    const full = Array.from({ length: 50 }, (_, i) => candidate(i + 1));
    f.reader.candidates.mockResolvedValue(full);
    const { job, enqueue } = context();
    await f.job.handler(f.job.validate({}), job);
    expect(f.reader.candidates).toHaveBeenCalledWith(org, { limit: 50, after: null });
    const last = full[49] as ReturnType<typeof candidate>;
    const next = { scan: { createdAt: last.createdAt, id: last.id } };
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(org, 'core:retention-scan:v1', next, {
      idempotencyKey: digest(['v1', 'retention-next', 'schedule:tick', next]),
    });
  });

  it('continues with the cursor from the payload and runs only the named phase', async () => {
    const f = scanFixture();
    const cursor = { createdAt: '2020-01-01T00:00:00.000Z', id: 'id-9' };
    await f.job.handler(f.job.validate({ sweep: cursor }), context().job);
    expect(f.reader.candidates).not.toHaveBeenCalled();
    expect(f.reader.scheduledIneligible).toHaveBeenCalledWith(org, { limit: 50, after: cursor });
  });

  it('stops mutating once aborted', async () => {
    const f = scanFixture();
    const controller = new AbortController();
    f.reader.candidates.mockResolvedValue([candidate(1), candidate(2)]);
    f.lifecycle.softDelete.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    await f.job.handler(f.job.validate({}), context({ signal: controller.signal }).job);
    expect(f.lifecycle.softDelete).toHaveBeenCalledOnce();
    expect(f.lifecycle.unschedule).not.toHaveBeenCalled();
  });
});

describe('blob purge', () => {
  it('claims each due key, removes with the generation and cancels a refusal', async () => {
    const f = scanFixture();
    f.lifecycle.listDue.mockResolvedValue([sha(1), sha(2), sha(3)]);
    f.lifecycle.claimPurge.mockResolvedValueOnce(null);
    f.lifecycle.removeBytes.mockResolvedValueOnce('removed').mockResolvedValueOnce('refused');
    const job = createBlobPurgeJob({ lifecycle: f.lifecycle });
    const { job: ctx, enqueue } = context();
    await job.handler(job.validate({}), ctx);
    expect(f.lifecycle.listDue).toHaveBeenCalledWith(org, { limit: 50, after: null });
    expect(f.lifecycle.removeBytes.mock.calls).toEqual([
      [org, sha(2), gen],
      [org, sha(3), gen],
    ]);
    expect(f.lifecycle.cancelPurge).toHaveBeenCalledExactlyOnceWith(org, sha(3), gen);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues the next page when full', async () => {
    const f = scanFixture();
    const keys = Array.from({ length: 50 }, (_, i) => sha(i + 1));
    f.lifecycle.listDue.mockResolvedValue(keys);
    const job = createBlobPurgeJob({ lifecycle: f.lifecycle });
    const { job: ctx, enqueue } = context();
    await job.handler(job.validate({}), ctx);
    const next = { after: sha(50) };
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(org, 'core:blob-purge:v1', next, {
      idempotencyKey: digest(['v1', 'purge-next', 'schedule:tick', next]),
    });
  });

  it('does nothing once aborted', async () => {
    const f = scanFixture();
    f.lifecycle.listDue.mockResolvedValue([sha(1)]);
    const controller = new AbortController();
    controller.abort();
    const job = createBlobPurgeJob({ lifecycle: f.lifecycle });
    await job.handler(job.validate({}), context({ signal: controller.signal }).job);
    expect(f.lifecycle.claimPurge).not.toHaveBeenCalled();
  });
});

describe('source poll', () => {
  const due = (id: string, nextPollAt: string | null): SourceRecord =>
    ({ id, nextPollAt }) as SourceRecord;

  it('enqueues one sync per due source keyed by source and next_poll_at', async () => {
    const sources = {
      deferPoll: vi.fn(async () => true),
      listDue: vi.fn(async () => [
        due('s1', '2026-10-20T09:59:00.000Z'),
        due('s2', '2026-10-20T09:58:00.000Z'),
      ]),
    };
    const poll = createSourcePollJob({ sources });
    const { job, enqueue } = context();
    await poll.handler(poll.validate({}), job);
    expect(sources.listDue).toHaveBeenCalledExactlyOnceWith(org, 50);
    expect(enqueue.mock.calls).toEqual([
      [
        org,
        'core:source-sync:v1',
        { sourceId: 's1', reason: 'poll' },
        {
          idempotencyKey: digest(['poll', 's1', '2026-10-20T09:59:00.000Z']),
          resourceKey: 'source:s1',
        },
      ],
      [
        org,
        'core:source-sync:v1',
        { sourceId: 's2', reason: 'poll' },
        {
          idempotencyKey: digest(['poll', 's2', '2026-10-20T09:58:00.000Z']),
          resourceKey: 'source:s2',
        },
      ],
    ]);
  });

  it('two ticks over the same due set produce identical idempotency keys', async () => {
    const sources = {
      deferPoll: vi.fn(async () => true),
      listDue: vi.fn(async () => [due('s1', '2026-10-20T09:59:00.000Z')]),
    };
    const poll = createSourcePollJob({ sources });
    const first = context();
    const second = context();
    await poll.handler(poll.validate({}), first.job);
    await poll.handler(poll.validate({}), second.job);
    expect(first.enqueue.mock.calls).toEqual(second.enqueue.mock.calls);
  });

  it('skips a source without next_poll_at and stops once aborted', async () => {
    const sources = {
      deferPoll: vi.fn(async () => true),
      listDue: vi.fn(async () => [due('s1', null), due('s2', 'x')]),
    };
    const poll = createSourcePollJob({ sources });
    const { job, enqueue } = context();
    await poll.handler(poll.validate({}), job);
    expect(enqueue).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    const aborted = context({ signal: controller.signal });
    await poll.handler(poll.validate({}), aborted.job);
    expect(aborted.enqueue).not.toHaveBeenCalled();
  });

  it('defers each polled source after its enqueue, compare-and-set on the listed next_poll_at', async () => {
    const calls: string[] = [];
    const sources = {
      listDue: vi.fn(async () => [due('s1', 'a'), due('s2', 'b')]),
      deferPoll: vi.fn(async (_ctx: unknown, id: string) => {
        calls.push(`defer:${id}`);
        return true;
      }),
    };
    const poll = createSourcePollJob({ sources });
    const { job, enqueue } = context();
    enqueue.mockImplementation(async (...args: unknown[]) => {
      const payload = args[2];
      calls.push(`enqueue:${(payload as { sourceId: string }).sourceId}`);
      return { id: 'j', created: true };
    });
    await poll.handler(poll.validate({}), job);
    expect(calls).toEqual(['enqueue:s1', 'defer:s1', 'enqueue:s2', 'defer:s2']);
    expect(sources.deferPoll.mock.calls).toEqual([
      [org, 's1', 'a'],
      [org, 's2', 'b'],
    ]);
  });

  it('does not defer a source whose enqueue failed', async () => {
    const sources = {
      listDue: vi.fn(async () => [due('s1', 'a')]),
      deferPoll: vi.fn(async () => true),
    };
    const poll = createSourcePollJob({ sources });
    const { job, enqueue } = context();
    enqueue.mockRejectedValue(new Error('down'));
    await expect(poll.handler(poll.validate({}), job)).rejects.toThrow('down');
    expect(sources.deferPoll).not.toHaveBeenCalled();
  });
});
