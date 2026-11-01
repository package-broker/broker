import { describe, expect, it, vi } from 'vitest';
import { createPublishScanJob, createPublishScanSweepJob } from './publish-scan-job.js';
import { jobFences } from '../platform/job-fences.js';
import { fixedClock, ulid } from '../ids.js';
import { orgContext } from '../db/port.js';
import type {
  PublishInspection,
  PublishScanTransition,
  PublishesRepository,
} from '../db/publishes.js';
import type { JobContext } from '../platform/jobs.js';
import type { PublishPolicyDefinition } from '../plugin.js';

function fixture(scanners: readonly PublishPolicyDefinition[]) {
  let item = {
    id: 'publish',
    packageName: 'widget',
    version: '1.0.0',
    versionId: 'version',
    revision: 1,
    scanState: 'queued',
    approvalState: 'not_required',
    scanAttempts: 0,
    requiredScanners: scanners.map((s) => s.id),
  } as unknown as PublishInspection;
  const scan = vi.fn(async (_ctx: unknown, _fence: unknown, input: PublishScanTransition) => {
    if (input.expectedRevision !== item.revision)
      return { changed: false, active: false, revision: item.revision };
    item = {
      ...item,
      scanState: input.scanState,
      revision: item.revision + 1,
      scanAttempts: item.scanAttempts + Number(input.scanState === 'running'),
      scanVerdicts: input.verdicts,
    };
    return { changed: true, active: input.scanState === 'allowed', revision: item.revision };
  });
  const publishes = {
    get: vi.fn(async () => item),
    scan,
    scanInput: vi.fn(async () => ({
      manifest: { name: 'widget' },
      integrity: 'sha512-test',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    })),
    listScanQueued: vi.fn(async () => [item]),
  } as unknown as PublishesRepository;
  const blob = {
    get: vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([42]));
          c.close();
        },
      }),
      info: {} as never,
    })),
  };
  const controller = new AbortController();
  const enqueue = vi.fn(async () => ({ id: 'job', created: true }));
  const context = {
    org: orgContext('org'),
    attempt: 1,
    jobId: 'job',
    signal: controller.signal,
    fences: jobFences({ id: 'job', owner: 'owner', fence: 1 }),
    ports: {
      clock: fixedClock('2026-10-31T00:00:00.000Z'),
      ids: { ulid },
      platform: { jobs: { enqueue } },
    },
  } as unknown as JobContext;
  return {
    job: createPublishScanJob({ publishes, scanners, blob }),
    publishes,
    scan,
    blob,
    context,
    controller,
    enqueue,
    item: () => item,
    set: (patch: Partial<PublishInspection>) => {
      item = { ...item, ...patch };
    },
  };
}

describe('publish scan job', () => {
  it('runs all scanners in order with separate tarball streams and activates after all allow', async () => {
    const order: string[] = [];
    const scanners = ['a', 'b', 'c'].map(
      (id) =>
        ({
          id,
          inspect: vi.fn(async (_ctx, input) => {
            expect(input.signal.aborted).toBe(false);
            const reader = (await input.openTarball()).getReader();
            expect((await reader.read()).value).toEqual(new Uint8Array([42]));
            reader.releaseLock();
            order.push(id);
            return { verdict: 'allow' as const };
          }),
        }) satisfies PublishPolicyDefinition,
    );
    const f = fixture(scanners);
    expect(f.job.maxAttempts).toBe(3);
    await f.job.handler({ id: 'publish' }, f.context);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(f.blob.get).toHaveBeenCalledTimes(3);
    expect(f.item()).toMatchObject({
      scanState: 'allowed',
      scanAttempts: 1,
      scanVerdicts: scanners.map(({ id }) => ({ plugin: id, verdict: 'allow' })),
    });
  });
  it('stops at the first denial and drops unsafe free text', async () => {
    const later = vi.fn();
    const f = fixture([
      { id: 'first', inspect: async () => ({ verdict: 'deny', reason: 'secret@example.test' }) },
      { id: 'later', inspect: later },
    ]);
    await f.job.handler({ id: 'publish' }, f.context);
    expect(later).not.toHaveBeenCalled();
    expect(f.item()).toMatchObject({
      scanState: 'denied',
      scanVerdicts: [{ plugin: 'first', verdict: 'deny' }],
    });
    expect(JSON.stringify(f.scan.mock.calls)).not.toContain('secret@example.test');
  });
  it('counts exceptions, retries twice, and fails closed on the third attempt', async () => {
    const f = fixture([
      {
        id: 'scanner',
        inspect: async () => {
          throw new Error('secret');
        },
      },
    ]);
    for (const attempt of [1, 2]) {
      await expect(f.job.handler({ id: 'publish' }, { ...f.context, attempt })).rejects.toThrow(
        'handler_error',
      );
      expect(f.item().scanState).toBe('queued');
    }
    await expect(f.job.handler({ id: 'publish' }, { ...f.context, attempt: 3 })).rejects.toThrow(
      'handler_error',
    );
    expect(f.item()).toMatchObject({ scanState: 'failed', scanAttempts: 3 });
    expect(JSON.stringify(f.scan.mock.calls)).not.toContain('secret');
  });
  it('aborts a hung scanner after sixty seconds and retries', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const f = fixture([
        {
          id: 'scanner',
          inspect: async (_ctx, input) => {
            signal = input.signal;
            return new Promise(() => {});
          },
        },
      ]);
      const run = expect(f.job.handler({ id: 'publish' }, f.context)).rejects.toThrow(
        'handler_error',
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(signal?.aborted).toBe(true);
      expect(f.item().scanState).toBe('queued');
    } finally {
      vi.useRealTimers();
    }
  });
  it('combines the job signal and never persists a verdict after cancellation', async () => {
    let signal: AbortSignal | undefined;
    const f = fixture([
      {
        id: 'scanner',
        inspect: async (_ctx, input) => {
          signal = input.signal;
          f.controller.abort();
          return new Promise(() => {});
        },
      },
    ]);
    await expect(f.job.handler({ id: 'publish' }, f.context)).rejects.toThrow('aborted');
    expect(signal?.aborted).toBe(true);
    expect(f.item().scanState).toBe('queued');
  });
  it('marks an aborted final attempt failed', async () => {
    const f = fixture([
      {
        id: 'scanner',
        inspect: async () => {
          f.controller.abort();
          return new Promise(() => {});
        },
      },
    ]);
    f.set({ scanAttempts: 2 });
    await expect(f.job.handler({ id: 'publish' }, { ...f.context, attempt: 3 })).rejects.toThrow(
      'aborted',
    );
    expect(f.item()).toMatchObject({ scanState: 'failed', scanAttempts: 3 });
  });
  it.each(['allow', 'deny'] as const)(
    'retries a lost final %s CAS without inspecting again',
    async (verdict) => {
      const inspect = vi.fn(async () => ({ verdict }));
      const f = fixture([{ id: 'scanner', inspect }]);
      const scan = f.scan.getMockImplementation()!;
      let lost = false;
      f.scan.mockImplementation(async (ctx, fence, input) => {
        if (!lost && ['allowed', 'denied'].includes(input.scanState)) {
          lost = true;
          f.set({ revision: f.item().revision + 1, approvalState: 'approved' });
          return { changed: false, active: false, revision: f.item().revision };
        }
        return scan(ctx, fence, input);
      });
      await f.job.handler({ id: 'publish' }, f.context);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(f.item()).toMatchObject({
        scanAttempts: 1,
        scanState: verdict === 'allow' ? 'allowed' : 'denied',
      });
    },
  );
  it('recovers a crashed final run through the sweeper', async () => {
    const f = fixture([]);
    f.set({ scanState: 'running', scanAttempts: 3 });
    await createPublishScanSweepJob(f).handler({}, f.context);
    expect(f.item().scanState).toBe('failed');
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('fails closed when multiple scanners match a snapshotted id', async () => {
    const inspect = vi.fn(async () => ({ verdict: 'allow' as const }));
    const f = fixture([
      { id: 'scanner', inspect },
      { id: 'scanner', inspect },
    ]);
    f.set({ requiredScanners: ['scanner'] });
    await f.job.handler({ id: 'publish' }, f.context);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.item().scanState).toBe('failed');
  });
  it('stops safely if the publish disappears on a re-read', async () => {
    const inspect = vi.fn(async () => ({ verdict: 'allow' as const }));
    const f = fixture([{ id: 'scanner', inspect }]);
    vi.mocked(f.publishes.get).mockResolvedValueOnce(f.item()).mockResolvedValue(null);
    await f.job.handler({ id: 'publish' }, f.context);
    expect(inspect).not.toHaveBeenCalled();
  });
  it('fails closed when a snapshotted scanner is absent', async () => {
    const f = fixture([]);
    f.set({ requiredScanners: ['missing'] });
    await f.job.handler({ id: 'publish' }, f.context);
    expect(f.item().scanState).toBe('failed');
  });
  it('recovers a running attempt after restart without exceeding three inspections', async () => {
    const inspect = vi.fn(async () => ({ verdict: 'allow' as const }));
    const f = fixture([{ id: 'scanner', inspect }]);
    f.set({ scanState: 'running', scanAttempts: 3 });
    await f.job.handler({ id: 'publish' }, f.context);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.item().scanState).toBe('failed');
  });
  it('refuses a missing lease and invalid payload before reading', async () => {
    const f = fixture([]);
    await expect(
      f.job.handler({ id: 'publish' }, { ...f.context, fences: undefined } as never),
    ).rejects.toThrow('lease_lost');
    expect(f.publishes.get).not.toHaveBeenCalled();
    for (const input of [null, [], {}, { id: '' }, { id: 'a', extra: true }])
      expect(() => f.job.validate(input)).toThrow('invalid_payload');
  });
  it.each([
    'empty snapshot',
    'too many scanners',
    'missing data',
    'invalid verdict',
    'missing blob',
  ] as const)('fails closed for %s', async (cause) => {
    const scanners: PublishPolicyDefinition[] = [
      {
        id: 'scanner',
        inspect: async (_ctx, input) => {
          if (cause === 'missing blob') await input.openTarball();
          return { verdict: cause === 'invalid verdict' ? ('unsafe' as 'allow') : 'allow' };
        },
      },
    ];
    if (cause === 'too many scanners')
      scanners.push(
        ...['b', 'c', 'd'].map((id) => ({
          id,
          inspect: async () => ({ verdict: 'allow' as const }),
        })),
      );
    const f = fixture(scanners);
    if (cause === 'empty snapshot') f.set({ requiredScanners: [] });
    if (cause === 'too many scanners') f.set({ requiredScanners: ['scanner', 'b', 'c', 'd'] });
    if (cause === 'missing data') vi.mocked(f.publishes.scanInput).mockResolvedValue(null);
    if (cause === 'missing blob') f.blob.get.mockResolvedValue(null as never);
    const run = f.job.handler({ id: 'publish' }, { ...f.context, attempt: 3 });
    if (['missing data', 'invalid verdict', 'missing blob'].includes(cause))
      await expect(run).rejects.toThrow('handler_error');
    else await run;
    expect(f.item().scanState).toBe('failed');
  });
  it('does not inspect after losing the running compare-and-set', async () => {
    const inspect = vi.fn(async () => ({ verdict: 'allow' as const }));
    const f = fixture([{ id: 'scanner', inspect }]);
    f.scan.mockResolvedValue({ changed: false, active: false, revision: 1 });
    await f.job.handler({ id: 'publish' }, f.context);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.publishes.scanInput).not.toHaveBeenCalled();
  });
  it('sweeper refuses a missing lease before reading and respects cancellation', async () => {
    const f = fixture([]);
    const sweep = createPublishScanSweepJob(f);
    await expect(sweep.handler({}, { ...f.context, fences: undefined } as never)).rejects.toThrow(
      'lease_lost',
    );
    expect(f.publishes.listScanQueued).not.toHaveBeenCalled();
    f.controller.abort();
    await sweep.handler({}, f.context);
    expect(f.enqueue).not.toHaveBeenCalled();
    for (const input of [null, [], { extra: true }])
      expect(() => sweep.validate(input)).toThrow('invalid_payload');
  });
  it('sweeps only old queued rows every five minutes with revision and ten-minute bucket keys', async () => {
    const f = fixture([]);
    const sweep = createPublishScanSweepJob(f);
    expect(sweep.schedule).toEqual({ everySeconds: 300 });
    await sweep.handler({}, f.context);
    expect(f.publishes.listScanQueued).toHaveBeenCalledWith(
      f.context.org,
      '2026-10-30T23:50:00.000Z',
      '2026-10-30T23:59:00.000Z',
    );
    expect(f.enqueue).toHaveBeenCalledWith(
      f.context.org,
      'core:publish-scan:v1',
      { id: 'publish' },
      {
        idempotencyKey: `publish-sweep:version:1:${Math.floor(Date.parse('2026-10-31T00:00:00.000Z') / 600_000)}`,
        resourceKey: 'publish:version',
      },
    );
  });
});
