import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { blobStorageKey, parseSha256, type ByteStore, type PurgeGeneration } from './blob.js';
import { createBlobLifecycle } from './blob-lifecycle.js';

const ctx = orgContext('org-a');
const key = parseSha256('b'.repeat(64));
const generation = 'c'.repeat(32) as PurgeGeneration;
const input = { removedAt: '2026-10-17T00:00:00.000Z' };
const delegates = ['softDelete', 'claimPurge', 'markDeleted', 'cancelPurge', 'unschedule'] as const;
function fixture() {
  const metadata = {
    softDelete: vi.fn(async () => true),
    claimPurge: vi.fn(async (): Promise<PurgeGeneration | null> => generation),
    canStartRemove: vi.fn(async () => true),
    markDeleted: vi.fn(async () => true),
    cancelPurge: vi.fn(async () => true),
    unschedule: vi.fn(async () => true),
  };
  const remove = vi.fn<ByteStore['remove']>(async () => undefined);
  const store = { remove } as unknown as ByteStore;
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
it('removes once with the organization storage key and leaves markDeleted separate', async () => {
  await expect(f.service.recheckAndRemove(ctx, key, generation)).resolves.toBe(true);
  expect(f.metadata.canStartRemove).toHaveBeenCalledExactlyOnceWith(ctx, key, generation, 2000);
  expect(f.remove).toHaveBeenCalledExactlyOnceWith(blobStorageKey(ctx.orgId, key));
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
  f.remove.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 999)));
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
  expect(f.metadata.canStartRemove).toHaveBeenCalledExactlyOnceWith(other, key, generation, 2000);
  expect(f.remove).toHaveBeenCalledExactlyOnceWith(blobStorageKey(other.orgId, key));
});
