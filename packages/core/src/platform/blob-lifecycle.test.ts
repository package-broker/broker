import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import {
  blobStorageKey,
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
  type ByteStore,
  type PurgeGeneration,
  type Sha256,
} from './blob.js';
import { createBlobLifecycle } from './blob-lifecycle.js';
import { createBlobRemoveJob } from './blob-remove-job.js';
import { type JobContext, type CoreJobs as Jobs, validateIdempotencyKey } from './jobs.js';

const ctx = orgContext('org-a');
const key = parseSha256('b'.repeat(64));
const generation = 'c'.repeat(32) as PurgeGeneration;
const input = { removedAt: '2026-10-17T00:00:00.000Z' };
const delegates = ['softDelete', 'claimPurge', 'markDeleted', 'cancelPurge', 'unschedule'] as const;
function fixture() {
  const metadata = {
    inspect: vi.fn(async () => null),
    softDelete: vi.fn(async () => true),
    claimPurge: vi.fn(async (): Promise<PurgeGeneration | null> => generation),
    canStartRemove: vi.fn(async () => true),
    markDeleted: vi.fn(async () => true),
    cancelPurge: vi.fn(async () => true),
    unschedule: vi.fn(async () => true),
    scheduleOrphan: vi.fn(async () => true),
    listDue: vi.fn(async (): Promise<Sha256[]> => []),
  };
  const remove = vi.fn<ByteStore['remove']>(async () => undefined);
  const store = { remove, head: async () => null } as unknown as ByteStore;
  const observability = { counter: vi.fn(), histogram: vi.fn(), log: vi.fn() };
  const options = { metadata, store, observability, deleteTimeoutMs: 1000, leaseMs: 10000 };
  return { metadata, remove, observability, options, service: createBlobLifecycle(options) };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers();
  f = fixture();
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  expect(f.observability.log).not.toHaveBeenCalled();
  for (const [name, labels] of f.observability.counter.mock.calls) {
    expect(name).toBe('pb.blob.purge');
    expect(Object.keys(labels)).toEqual(['outcome']);
    expect(['removed', 'refused', 'stale', 'timeout', 'error']).toContain(labels.outcome);
    for (const value of Object.values(labels)) {
      expect(value).not.toMatch(/^[0-9a-f]{32}$|^[0-9a-f]{64}$/);
    }
  }
  for (const [name, elapsed, labels] of f.observability.histogram.mock.calls) {
    expect(name).toBe('pb.blob.purge_remove_ms');
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(labels ?? {}).toEqual({});
  }
  vi.useRealTimers();
});
it('removes both organization storage keys and leaves markDeleted separate', async () => {
  await expect(f.service.recheckAndRemove(ctx, key, generation)).resolves.toBe(true);
  expect(f.metadata.canStartRemove.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [ctx, key, generation, 2000]),
  );
  expect(f.remove.mock.calls).toEqual([
    [`npm-publish/${blobStorageKey(ctx.orgId, key)}`],
    [blobStorageKey(ctx.orgId, key)],
  ]);
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'removed' });
  expect(f.observability.histogram).toHaveBeenCalledTimes(1);
});
it('refuses without removing or distinguishing stale, short lease and referenced rows', async () => {
  f.metadata.canStartRemove.mockResolvedValue(false);
  await expect(f.service.recheckAndRemove(ctx, key, generation)).resolves.toBe(false);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'refused' });
});
it.each([999, 1001, 0, 1.5, NaN])('rejects deleteTimeoutMs %s', (deleteTimeoutMs) => {
  expect(() => createBlobLifecycle({ ...f.options, deleteTimeoutMs })).toThrow(TypeError);
  expect(() => createBlobLifecycle({ ...f.options, deleteTimeoutMs })).toThrow('deleteTimeoutMs');
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects leaseMs %s', (leaseMs) => {
  expect(() => createBlobLifecycle({ ...f.options, leaseMs })).toThrow(TypeError);
  expect(() => createBlobLifecycle({ ...f.options, leaseMs })).toThrow('leaseMs');
});
it.each(['never', 'resolve', 'reject'] as const)('bounds removal with late %s', async (late) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  f.remove.mockReturnValue(
    new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
  );
  const result = f.service.recheckAndRemove(ctx, key, generation);
  await vi.advanceTimersByTimeAsync(999);
  expect(f.observability.counter).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(false);
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'timeout' });
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  if (late === 'resolve') resolve();
  if (late === 'reject') reject(new Error('late storage failure'));
  await vi.advanceTimersByTimeAsync(0);
});
it('accepts removal one millisecond before the deadline', async () => {
  f.remove.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 999)));
  const result = f.service.recheckAndRemove(ctx, key, generation);
  await vi.advanceTimersByTimeAsync(999);
  await expect(result).resolves.toBe(true);
  expect(f.observability.histogram).toHaveBeenCalledWith('pb.blob.purge_remove_ms', 999);
});
it.each(['reject', 'throw'] as const)('swallows storage %s and counts error', async (mode) => {
  f.remove.mockImplementation(() => {
    if (mode === 'throw') throw new Error('private storage failure');
    return Promise.reject(new Error('private storage failure'));
  });
  await expect(f.service.recheckAndRemove(ctx, key, generation)).resolves.toBe(false);
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'error' });
});
it.each(delegates)(
  'delegates %s unchanged using org A context and org B digest',
  async (method) => {
    const args = method === 'softDelete' ? [input] : [generation];
    const call = f.service[method] as (...args: unknown[]) => Promise<unknown>;
    const expected = method === 'claimPurge' ? generation : true;
    const extra = method === 'claimPurge' || method === 'unschedule' ? [] : args;
    await expect(call(ctx, key, ...extra)).resolves.toBe(expected);
    expect(f.metadata[method]).toHaveBeenCalledExactlyOnceWith(ctx, key, ...extra);
  },
);
it.each([...delegates, 'recheckAndRemove'] as const)(
  'validates the key before %s',
  async (method) => {
    const call = f.service[method] as (...args: unknown[]) => unknown;
    await expect(async () => call(ctx, 'malformed', generation)).rejects.toThrow();
    for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it.each(['markDeleted', 'cancelPurge', 'recheckAndRemove'] as const)(
  'validates the generation before %s',
  async (method) => {
    await expect(async () => f.service[method](ctx, key, '' as PurgeGeneration)).rejects.toThrow();
    for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it.each(delegates)('preserves the absent or refused result from %s', async (method) => {
  if (method === 'claimPurge') {
    f.metadata.claimPurge.mockResolvedValue(null);
    await expect(f.service.claimPurge(ctx, key)).resolves.toBeNull();
  } else {
    f.metadata[method].mockResolvedValue(false);
    const call = f.service[method] as (...args: unknown[]) => Promise<boolean>;
    const extra = method === 'softDelete' ? [input] : method === 'unschedule' ? [] : [generation];
    await expect(call(ctx, key, ...extra)).resolves.toBe(false);
  }
  expect(f.remove).not.toHaveBeenCalled();
});
it.each(['A'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), '', null, 123])(
  'rejects malformed digest %s before any metadata call',
  async (invalid) => {
    for (const method of [...delegates, 'recheckAndRemove'] as const) {
      const call = f.service[method] as (...args: unknown[]) => unknown;
      await expect(async () => call(ctx, invalid, generation)).rejects.toThrow(
        'invalid blob input',
      );
    }
    for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it.each(['C'.repeat(32), 'c'.repeat(31), 'c'.repeat(33), null, 123])(
  'rejects malformed generation %s before any metadata call',
  async (invalid) => {
    for (const method of ['markDeleted', 'cancelPurge', 'recheckAndRemove'] as const) {
      await expect(async () =>
        f.service[method](ctx, key, invalid as PurgeGeneration),
      ).rejects.toThrow('invalid blob input');
    }
    for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it.each([1000, 2000])('accepts the timeout boundary %s', (deleteTimeoutMs) => {
  expect(() =>
    createBlobLifecycle({ ...f.options, leaseMs: 20000, deleteTimeoutMs }),
  ).not.toThrow();
});
it.each([Infinity, -1000])(
  'rejects deleteTimeoutMs %s without echoing its value',
  (deleteTimeoutMs) => {
    expect(() => createBlobLifecycle({ ...f.options, deleteTimeoutMs })).toThrow(
      new TypeError('invalid deleteTimeoutMs'),
    );
  },
);
it('uses each organization context unchanged for recheck and physical storage', async () => {
  const other = orgContext('org-b');
  await expect(f.service.recheckAndRemove(other, key, generation)).resolves.toBe(true);
  expect(f.metadata.canStartRemove.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [other, key, generation, 2000]),
  );
  expect(f.remove.mock.calls).toEqual([
    [`npm-publish/${blobStorageKey(other.orgId, key)}`],
    [blobStorageKey(other.orgId, key)],
  ]);
});

it.each([true, false])('queue admission %s avoids byte removal', async (eligible) => {
  const enqueue = vi.fn<Jobs['enqueue']>(async () => ({ id: 'job', created: true }));
  const service = createBlobLifecycle({
    ...f.options,
    jobs: {
      async enqueueStatements() {
        throw new Error('not_implemented');
      },
      enqueue,
      get: vi.fn(),
    },
  });
  f.metadata.canStartRemove.mockResolvedValue(eligible);
  for (const g of [generation, 'd'.repeat(32) as PurgeGeneration]) {
    await expect(service.removeBytes(ctx, key, g)).resolves.toBe(eligible ? 'queued' : 'refused');
    if (eligible)
      expect(enqueue).toHaveBeenLastCalledWith(
        ctx,
        'blob-remove',
        { sha256: key, generation: g },
        { idempotencyKey: `blob-remove:${key}:${g}`, resourceKey: key },
      );
  }
  expect(f.metadata.canStartRemove).toHaveBeenCalledWith(ctx, key, generation, 2000);
  expect(enqueue).toHaveBeenCalledTimes(eligible ? 2 : 0);
  for (const call of enqueue.mock.calls)
    expect(() => validateIdempotencyKey(call[3].idempotencyKey)).not.toThrow();
  expect(new Set(enqueue.mock.calls.map((call) => call[3].idempotencyKey)).size).toBe(
    eligible ? 2 : 0,
  );
  await expect(service.removeBytes(ctx, key, 'c'.repeat(33) as PurgeGeneration)).rejects.toThrow();
  expect(enqueue).toHaveBeenCalledTimes(eligible ? 2 : 0);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
});
it.each(['removed', 'timeout', 'refused', 'stale'] as const)(
  'synchronous removeBytes: %s',
  async (outcome) => {
    if (outcome === 'timeout') f.remove.mockReturnValue(new Promise(() => {}));
    if (outcome === 'refused') f.metadata.canStartRemove.mockResolvedValue(false);
    if (outcome === 'stale') f.metadata.markDeleted.mockResolvedValue(false);
    const result = f.service.removeBytes(ctx, key, generation);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(outcome === 'removed' ? 'removed' : 'refused');
    expect(f.metadata.markDeleted).toHaveBeenCalledTimes(
      outcome === 'removed' || outcome === 'stale' ? 1 : 0,
    );
  },
);
it.each(['live', 'aborted', 'refused', 'error', 'stale', 'foreign'] as const)(
  'blob removal job: %s',
  async (mode) => {
    const controller = new AbortController();
    if (mode === 'aborted') controller.abort();
    if (mode === 'refused' || mode === 'foreign')
      f.metadata.canStartRemove.mockResolvedValue(false);
    if (mode === 'error') f.remove.mockRejectedValue(new Error('storage failure'));
    if (mode === 'stale') f.metadata.markDeleted.mockResolvedValue(false);
    if (mode === 'live')
      f.metadata.canStartRemove
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);
    const org = mode === 'foreign' ? orgContext('org-b') : ctx;
    const job = createBlobRemoveJob(f.service);
    const context = { org, signal: controller.signal } as JobContext;
    const payload = job.validate({ sha256: key, generation });
    await expect(job.handler(payload, context)).resolves.toBeUndefined();
    if (mode === 'live') await job.handler(payload, context);
    expect(f.remove).toHaveBeenCalledTimes(
      mode === 'error' ? 1 : ['live', 'stale'].includes(mode) ? 2 : 0,
    );
    expect(f.metadata.markDeleted).toHaveBeenCalledTimes(['live', 'stale'].includes(mode) ? 1 : 0);
    if (mode === 'live')
      expect(f.metadata.markDeleted).toHaveBeenCalledExactlyOnceWith(ctx, key, generation);
    if (mode === 'aborted') expect(f.metadata.canStartRemove).not.toHaveBeenCalled();
    else expect(f.metadata.canStartRemove).toHaveBeenCalledWith(org, key, generation, 2000);
  },
);
it('delegates scheduleOrphan with the caller context and key', async () => {
  await expect(f.service.scheduleOrphan(ctx, key)).resolves.toBe(true);
  expect(f.metadata.scheduleOrphan).toHaveBeenCalledExactlyOnceWith(ctx, key);
  f.metadata.scheduleOrphan.mockResolvedValue(false);
  await expect(f.service.scheduleOrphan(ctx, key)).resolves.toBe(false);
});
it.each(['A'.repeat(64), 'b'.repeat(63), '', null, 123, 'malformed'])(
  'rejects malformed digest %s before scheduleOrphan reaches the port',
  async (invalid) => {
    await expect(async () => f.service.scheduleOrphan(ctx, invalid as never)).rejects.toThrow(
      'invalid blob input',
    );
    for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
  },
);
it('passes a retention override through softDelete and keeps the old input valid', async () => {
  await f.service.softDelete(ctx, key, { ...input, retentionDays: 90 });
  expect(f.metadata.softDelete).toHaveBeenLastCalledWith(ctx, key, { ...input, retentionDays: 90 });
  await f.service.softDelete(ctx, key, input);
  expect(f.metadata.softDelete).toHaveBeenLastCalledWith(ctx, key, input);
});
it.each([-1, 1.5, Number.NaN, Infinity, '5', null, 36_501])(
  'rejects retention override %s before softDelete reaches the port',
  async (retentionDays) => {
    await expect(
      f.service.softDelete(ctx, key, { ...input, retentionDays: retentionDays as number }),
    ).rejects.toThrow('invalid blob input');
    expect(f.metadata.softDelete).not.toHaveBeenCalled();
  },
);
it('delegates listDue with the caller context and page', async () => {
  f.metadata.listDue.mockResolvedValue([key]);
  await expect(f.service.listDue(ctx, { limit: 50, after: key })).resolves.toEqual([key]);
  expect(f.metadata.listDue).toHaveBeenCalledExactlyOnceWith(ctx, { limit: 50, after: key });
});
it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 5, after: 'A'.repeat(64) }])(
  'rejects page %j before listDue reaches the port',
  async (page) => {
    await expect(f.service.listDue(ctx, page as never)).rejects.toThrow('invalid blob input');
    expect(f.metadata.listDue).not.toHaveBeenCalled();
  },
);
it.each([
  ['removed', true, true, 'none', true, 'removed'],
  ['referenced or stale recheck', false, false, 'none', true, 'refused'],
  ['short lease', false, true, 'none', true, 'short-lease'],
  ['byte store throw', true, true, 'reject', true, 'error'],
  ['stale tombstone after removal', true, true, 'none', false, 'stale'],
] as const)('purgeBytes classifies %s', async (_name, recheck, probe, store, marked, expected) => {
  f.metadata.canStartRemove.mockResolvedValueOnce(recheck).mockResolvedValue(probe);
  if (store === 'reject') f.remove.mockRejectedValue(new Error('private storage failure'));
  f.metadata.markDeleted.mockResolvedValue(marked);
  await expect(f.service.purgeBytes(ctx, key, generation)).resolves.toBe(expected);
  expect(f.metadata.canStartRemove.mock.calls).toEqual(
    recheck
      ? Array.from({ length: store === 'reject' ? 2 : 3 }, () => [ctx, key, generation, 2000])
      : [
          [ctx, key, generation, 2000],
          [ctx, key, generation, 0],
        ],
  );
  expect(f.remove).toHaveBeenCalledTimes(recheck ? (store === 'reject' ? 1 : 2) : 0);
  expect(f.metadata.markDeleted).toHaveBeenCalledTimes(recheck && store === 'none' ? 1 : 0);
  expect(f.metadata.cancelPurge).not.toHaveBeenCalled();
});
it('purgeBytes reports a stalled removal as timeout and ignores its late completion', async () => {
  let finish!: () => void;
  f.remove.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const result = f.service.purgeBytes(ctx, key, generation);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe('timeout');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'timeout' });
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  expect(f.metadata.cancelPurge).not.toHaveBeenCalled();
  expect(f.metadata.canStartRemove).toHaveBeenCalledTimes(2);
});
it.each([
  [true, true, 'queued'],
  [false, true, 'short-lease'],
  [false, false, 'refused'],
] as const)(
  'purgeBytes with queue admission, recheck %s and probe %s: %s',
  async (recheck, probe, expected) => {
    const enqueue = vi.fn<Jobs['enqueue']>(async () => ({ id: 'job', created: true }));
    const service = createBlobLifecycle({
      ...f.options,
      jobs: {
        async enqueueStatements() {
          throw new Error('not_implemented');
        },
        enqueue,
        get: vi.fn(),
      },
    });
    f.metadata.canStartRemove.mockResolvedValueOnce(recheck).mockResolvedValue(probe);
    await expect(service.purgeBytes(ctx, key, generation)).resolves.toBe(expected);
    expect(enqueue).toHaveBeenCalledTimes(expected === 'queued' ? 1 : 0);
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it.each([
  ['malformed', generation],
  [key, '' as PurgeGeneration],
])('purgeBytes validates %s before any port call', async (digest, g) => {
  await expect(async () => f.service.purgeBytes(ctx, digest as Sha256, g)).rejects.toThrow(
    'invalid blob input',
  );
  for (const port of Object.values(f.metadata)) expect(port).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

it.each([true, false])(
  'Round 3 never starts a second deletion after a stalled remove times out, generation live=%s',
  async (live) => {
    let finish!: () => void;
    f.remove.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const result = f.service.purgeBytes(ctx, key, generation);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('timeout');
    f.metadata.canStartRemove.mockResolvedValue(live);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.metadata.markDeleted).not.toHaveBeenCalled();
  },
);
it('Round 3 rechecks the generation before the second deletion', async () => {
  f.remove.mockImplementationOnce(async () => {
    f.metadata.canStartRemove.mockResolvedValue(false);
  });
  expect(await f.service.purgeBytes(ctx, key, generation)).toBe('stale');
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
});
it('Round 3 deletes both keys without a HEAD', async () => {
  const head = vi.fn(async () => null);
  const service = createBlobLifecycle({ ...f.options, store: { ...f.options.store, head } });
  expect(await service.purgeBytes(ctx, key, generation)).toBe('removed');
  expect(head).not.toHaveBeenCalled();
  expect(f.remove.mock.calls).toEqual([
    [`npm-publish/${blobStorageKey(ctx.orgId, key)}`],
    [blobStorageKey(ctx.orgId, key)],
  ]);
});

it('Round 3 does not delete after a stalled lease recheck returns past the deadline', async () => {
  let finish!: (allowed: boolean) => void;
  f.metadata.canStartRemove.mockResolvedValueOnce(true).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const result = f.service.purgeBytes(ctx, key, generation);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe('timeout');
  finish(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.remove).not.toHaveBeenCalled();
});
it('Round 3 ignores a stalled HEAD while purging both keys', async () => {
  const head = vi.fn(() => new Promise<null>(() => {}));
  const service = createBlobLifecycle({ ...f.options, store: { ...f.options.store, head } });
  const result = service.purgeBytes(ctx, key, generation);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe('removed');
  expect(head).not.toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalledTimes(2);
});

it('Round 3 preserves a real re-publication while the old npm removal is stalled', async () => {
  const digest = parseSha256('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const canonical = blobStorageKey(ctx.orgId, digest);
  const npm = `npm-publish/${canonical}`;
  const objects = new Set([canonical, npm]);
  let finish!: () => void;
  let current = generation;
  let leaseExpired = false;
  let published = false;
  const info = () => ({
    generation: current,
    sha256: digest,
    size: 0,
    mediaType: 'application/zip',
    purgeAfter: null,
  });
  const bytes = {
    ...f.options.store,
    async remove(storageKey: string) {
      if (storageKey === npm)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      objects.delete(storageKey);
    },
    async putVerified(
      storageKey: string,
      body: ReadableStream<Uint8Array>,
      input: { size: number; mediaType: string },
    ) {
      await new Response(body).arrayBuffer();
      objects.add(storageKey);
      return input;
    },
    async head(storageKey: string) {
      return objects.has(storageKey) ? info() : null;
    },
  };
  f.metadata.canStartRemove.mockImplementation(async () => current === generation && !leaseExpired);
  const lifecycle = createBlobLifecycle({ ...f.options, store: bytes });
  const result = lifecycle.purgeBytes(ctx, digest, generation);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe('timeout');
  leaseExpired = true;
  const store = createBlobStore(
    bytes,
    {
      async reserve() {
        expect(leaseExpired).toBe(true);
        current = 'd'.repeat(32) as PurgeGeneration;
        return current;
      },
      async publish() {
        published = true;
        return info();
      },
      async find() {
        return published ? info() : null;
      },
      async inspect() {
        return published ? { info: info(), purging: false } : null;
      },
      async narrowRefetchable() {
        return null;
      },
    },
    { admission: createBlobUploadAdmission() },
  );
  await store.put(
    ctx,
    digest,
    new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    { size: 0, mediaType: 'application/zip', refetchable: true },
  );
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(await store.head(ctx, digest)).toEqual(info());
  expect(objects.has(canonical)).toBe(true);
  expect(f.metadata.markDeleted).not.toHaveBeenCalled();
});

it('Round 4 inner removal refusal emits the refused counter', async () => {
  f.metadata.canStartRemove.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.service.purgeBytes(ctx, key, generation)).toBe('stale');
  expect(f.observability.counter).toHaveBeenCalledWith('pb.blob.purge', { outcome: 'refused' });
  expect(f.remove).not.toHaveBeenCalled();
});
