import type { BoundCacheKey, CacheEnvelope } from '@package-broker/core/platform/cache';
import { orgContext } from '@package-broker/core/db/port';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLruCache } from './lru.js';

const ctx = orgContext('org-1');
const T0 = Date.parse('2026-10-16T10:00:00.000Z');

function keyOf(n: number | string): BoundCacheKey {
  return {
    projectId: 'proj-1',
    sourceId: 'src-1',
    kind: 'metadata',
    digest: String(n).padStart(64, '0'),
  };
}

function envelope(size: number, fill = 7, overrides: Partial<CacheEnvelope> = {}): CacheEnvelope {
  return {
    value: new Uint8Array(size).fill(fill),
    freshUntil: new Date(T0 + 300_000).toISOString(),
    staleUntil: new Date(T0 + 3_600_000).toISOString(),
    negative: false,
    insertedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('round trip', () => {
  it('returns null for a missing key', async () => {
    const cache = createLruCache();
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });

  it('returns a stored envelope byte-identical', async () => {
    const cache = createLruCache();
    const stored = envelope(64, 9);
    await cache.set(ctx, keyOf(1), stored);
    const hit = await cache.get(ctx, keyOf(1));
    expect(hit?.state).toBe('fresh');
    expect(hit?.entry).toEqual(stored);
    expect(Array.from(hit?.entry.value ?? [])).toEqual(Array.from(stored.value));
  });

  it('overwrites an existing key', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8, 1));
    await cache.set(ctx, keyOf(1), envelope(8, 2));
    expect((await cache.get(ctx, keyOf(1)))?.entry.value[0]).toBe(2);
  });

  it('deletes an entry and tolerates deleting a missing key', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8));
    await cache.delete(ctx, keyOf(1));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    await expect(cache.delete(ctx, keyOf(2))).resolves.toBeUndefined();
  });

  it('does not alias caller buffers', async () => {
    const cache = createLruCache();
    const stored = envelope(4, 5);
    await cache.set(ctx, keyOf(1), stored);
    stored.value.fill(0);
    const first = await cache.get(ctx, keyOf(1));
    expect(Array.from(first?.entry.value ?? [])).toEqual([5, 5, 5, 5]);
    first?.entry.value.fill(1);
    const second = await cache.get(ctx, keyOf(1));
    expect(Array.from(second?.entry.value ?? [])).toEqual([5, 5, 5, 5]);
  });

  it('reports stale once freshUntil has passed and misses nothing else', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8));
    vi.setSystemTime(T0 + 400_000);
    expect((await cache.get(ctx, keyOf(1)))?.state).toBe('stale');
  });
});

describe('isolation', () => {
  it('does not serve one organization an entry stored for another', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8));
    expect(await cache.get(orgContext('org-2'), keyOf(1))).toBeNull();
  });

  it('keeps entries with different digests separate', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8, 1));
    await cache.set(ctx, keyOf(2), envelope(8, 2));
    expect((await cache.get(ctx, keyOf(1)))?.entry.value[0]).toBe(1);
    expect((await cache.get(ctx, keyOf(2)))?.entry.value[0]).toBe(2);
  });
});

describe('entry cap', () => {
  it('evicts the least recently used entry when maxEntries is exceeded', async () => {
    const cache = createLruCache({ maxEntries: 3 });
    for (const n of [1, 2, 3]) await cache.set(ctx, keyOf(n), envelope(8, n));
    await cache.set(ctx, keyOf(4), envelope(8, 4));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    for (const n of [2, 3, 4]) {
      const hit = await cache.get(ctx, keyOf(n));
      expect(Array.from(hit?.entry.value ?? [])).toEqual(Array(8).fill(n));
    }
  });

  it('treats a get as a use', async () => {
    const cache = createLruCache({ maxEntries: 3 });
    for (const n of [1, 2, 3]) await cache.set(ctx, keyOf(n), envelope(8, n));
    await cache.get(ctx, keyOf(1));
    await cache.set(ctx, keyOf(4), envelope(8, 4));
    expect(await cache.get(ctx, keyOf(2))).toBeNull();
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
  });

  it('treats an overwrite as a use and does not grow the entry count', async () => {
    const cache = createLruCache({ maxEntries: 2 });
    await cache.set(ctx, keyOf(1), envelope(8, 1));
    await cache.set(ctx, keyOf(2), envelope(8, 2));
    await cache.set(ctx, keyOf(1), envelope(8, 3));
    await cache.set(ctx, keyOf(3), envelope(8, 4));
    expect(await cache.get(ctx, keyOf(2))).toBeNull();
    expect((await cache.get(ctx, keyOf(1)))?.entry.value[0]).toBe(3);
    expect(await cache.get(ctx, keyOf(3))).not.toBeNull();
  });

  it('defaults to 1,000 entries', async () => {
    const cache = createLruCache();
    for (let n = 0; n < 1001; n++) await cache.set(ctx, keyOf(n), envelope(1));
    expect(await cache.get(ctx, keyOf(0))).toBeNull();
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
    expect(await cache.get(ctx, keyOf(1000))).not.toBeNull();
  });
});

describe('byte cap', () => {
  it('evicts least recently used entries until the total fits', async () => {
    const cache = createLruCache({ maxBytes: 4_000, maxEntryBytes: 4_000 });
    for (const n of [1, 2, 3]) await cache.set(ctx, keyOf(n), envelope(1_000, n));
    await cache.set(ctx, keyOf(4), envelope(2_000, 4));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    expect(await cache.get(ctx, keyOf(2))).toBeNull();
    expect(Array.from((await cache.get(ctx, keyOf(3)))?.entry.value ?? [])).toEqual(
      Array(1_000).fill(3),
    );
    expect(Array.from((await cache.get(ctx, keyOf(4)))?.entry.value ?? [])).toEqual(
      Array(2_000).fill(4),
    );
  });

  it('accounts for a replaced entry size', async () => {
    const cache = createLruCache({ maxBytes: 3_000, maxEntryBytes: 3_000 });
    await cache.set(ctx, keyOf(1), envelope(1_000, 1));
    await cache.set(ctx, keyOf(2), envelope(1_000, 2));
    await cache.set(ctx, keyOf(1), envelope(100, 3));
    await cache.set(ctx, keyOf(3), envelope(1_000, 4));
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
    expect(await cache.get(ctx, keyOf(2))).not.toBeNull();
    expect(await cache.get(ctx, keyOf(3))).not.toBeNull();
  });

  it('frees bytes on delete', async () => {
    const cache = createLruCache({ maxBytes: 2_500, maxEntryBytes: 2_500 });
    await cache.set(ctx, keyOf(1), envelope(1_000, 1));
    await cache.set(ctx, keyOf(2), envelope(1_000, 2));
    await cache.delete(ctx, keyOf(1));
    await cache.set(ctx, keyOf(3), envelope(1_000, 3));
    expect(await cache.get(ctx, keyOf(2))).not.toBeNull();
    expect(await cache.get(ctx, keyOf(3))).not.toBeNull();
  });
});

const OVERHEAD = 'org-1'.length + 1 + 64 + 3 * 24;

describe('exact byte boundary', () => {
  it('stores an entry whose accounted size equals maxBytes', async () => {
    const cache = createLruCache({ maxBytes: OVERHEAD + 100, maxEntryBytes: 1_000 });
    await cache.set(ctx, keyOf(1), envelope(100));
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
  });

  it('refuses an entry one byte over maxBytes', async () => {
    const cache = createLruCache({ maxBytes: OVERHEAD + 100, maxEntryBytes: 1_000 });
    await cache.set(ctx, keyOf(1), envelope(101));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });

  it('keeps two entries whose total equals maxBytes', async () => {
    const cache = createLruCache({ maxBytes: 2 * (OVERHEAD + 100), maxEntryBytes: 1_000 });
    await cache.set(ctx, keyOf(1), envelope(100));
    await cache.set(ctx, keyOf(2), envelope(100));
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
    expect(await cache.get(ctx, keyOf(2))).not.toBeNull();
  });

  it('evicts the oldest when the total is one byte over maxBytes', async () => {
    const cache = createLruCache({ maxBytes: 2 * (OVERHEAD + 100), maxEntryBytes: 1_000 });
    await cache.set(ctx, keyOf(1), envelope(100));
    await cache.set(ctx, keyOf(2), envelope(101));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    expect(await cache.get(ctx, keyOf(2))).not.toBeNull();
  });

  it('applies the default 32 MiB cap', async () => {
    const cache = createLruCache();
    const size = 1024 * 1024 - 1024;
    for (let n = 1; n <= 33; n++) await cache.set(ctx, keyOf(n), envelope(size, n));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    expect((await cache.get(ctx, keyOf(2)))?.entry.value[0]).toBe(2);
    expect((await cache.get(ctx, keyOf(33)))?.entry.value[0]).toBe(33);
  });
});

describe('negative entries', () => {
  it('round-trips a negative entry without a stale window', async () => {
    const cache = createLruCache();
    const stored = envelope(0, 0, {
      negative: true,
      staleUntil: null,
      freshUntil: new Date(T0 + 30_000).toISOString(),
    });
    await cache.set(ctx, keyOf(1), stored);
    const hit = await cache.get(ctx, keyOf(1));
    expect(hit?.state).toBe('fresh');
    expect(hit?.entry).toEqual(stored);
  });

  it('misses a negative entry at its freshUntil instant', async () => {
    const cache = createLruCache();
    await cache.set(
      ctx,
      keyOf(1),
      envelope(0, 0, {
        negative: true,
        staleUntil: null,
        freshUntil: new Date(T0 + 30_000).toISOString(),
      }),
    );
    vi.setSystemTime(T0 + 30_000 - 1);
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
    vi.setSystemTime(T0 + 30_000);
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });
});

describe('expiry', () => {
  it('turns stale exactly at freshUntil', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(8));
    vi.setSystemTime(T0 + 300_000 - 1);
    expect((await cache.get(ctx, keyOf(1)))?.state).toBe('fresh');
    vi.setSystemTime(T0 + 300_000);
    expect((await cache.get(ctx, keyOf(1)))?.state).toBe('stale');
  });

  it('misses and drops the slot at staleUntil', async () => {
    const cache = createLruCache({ maxEntries: 2 });
    await cache.set(ctx, keyOf(1), envelope(8));
    vi.setSystemTime(T0 + 3_600_000 - 1);
    expect((await cache.get(ctx, keyOf(1)))?.state).toBe('stale');
    vi.setSystemTime(T0 + 3_600_000);
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
    vi.setSystemTime(T0);
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });
});

describe('staleUntil earlier than freshUntil', () => {
  const inverted = (): CacheEnvelope =>
    envelope(8, 7, {
      freshUntil: new Date(T0 + 60_000).toISOString(),
      staleUntil: new Date(T0 + 30_000).toISOString(),
    });

  it('stays fresh until freshUntil', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), inverted());
    vi.setSystemTime(T0 + 45_000);
    expect((await cache.get(ctx, keyOf(1)))?.state).toBe('fresh');
  });

  it('is gone after freshUntil', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), inverted());
    vi.setSystemTime(T0 + 61_000);
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });
});

describe('oversized entries', () => {
  it('refuses an entry above maxEntryBytes', async () => {
    const cache = createLruCache({ maxEntryBytes: 1_024 });
    await cache.set(ctx, keyOf(1), envelope(2_048));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });

  it('stores exactly 1 MiB and refuses 1 MiB + 1 by default', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(1024 * 1024, 3));
    await cache.set(ctx, keyOf(2), envelope(1024 * 1024 + 1));
    const hit = await cache.get(ctx, keyOf(1));
    expect(hit?.entry.value.byteLength).toBe(1024 * 1024);
    expect(hit?.entry.value[1024 * 1024 - 1]).toBe(3);
    expect(await cache.get(ctx, keyOf(2))).toBeNull();
  });

  it('accepts a value comfortably under the default limit', async () => {
    const cache = createLruCache();
    await cache.set(ctx, keyOf(1), envelope(1024 * 1024 - 1_024));
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
  });

  it('does not evict other entries when refusing', async () => {
    const cache = createLruCache({ maxEntryBytes: 1_024 });
    await cache.set(ctx, keyOf(1), envelope(100));
    await cache.set(ctx, keyOf(2), envelope(2_048));
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
  });

  it('drops the previous value under the key when the replacement is refused', async () => {
    const cache = createLruCache({ maxEntryBytes: 1_024 });
    await cache.set(ctx, keyOf(1), envelope(100, 1));
    await cache.set(ctx, keyOf(1), envelope(2_048, 2));
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });

  it('refuses an entry larger than maxBytes even when maxEntryBytes allows it', async () => {
    const cache = createLruCache({ maxBytes: 1_024, maxEntryBytes: 4_096 });
    await cache.set(ctx, keyOf(1), envelope(100));
    await cache.set(ctx, keyOf(2), envelope(2_048));
    expect(await cache.get(ctx, keyOf(2))).toBeNull();
    expect(await cache.get(ctx, keyOf(1))).not.toBeNull();
  });
});

describe('options', () => {
  it.each([
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { maxBytes: Number.NaN },
    { maxEntries: 0 },
    { maxEntries: 2.5 },
    { maxEntryBytes: 0 },
    { maxEntryBytes: Number.POSITIVE_INFINITY },
  ])('rejects invalid limits %j', (options) => {
    expect(() => createLruCache(options)).toThrow(RangeError);
  });
});

describe('failures are misses', () => {
  it.each([
    ['value', { value: [1, 2] }],
    ['freshUntil', { freshUntil: 5 }],
    ['insertedAt', { insertedAt: undefined }],
    ['staleUntil', { staleUntil: 5 }],
    ['negative', { negative: 'yes' }],
  ])('ignores an envelope with a malformed %s', async (_field, patch) => {
    const cache = createLruCache();
    const bad = { ...envelope(8), ...patch } as unknown as CacheEnvelope;
    await expect(cache.set(ctx, keyOf(1), bad)).resolves.toBeUndefined();
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });

  it('never rejects on a malformed envelope', async () => {
    const cache = createLruCache();
    const bad = { value: 'not bytes' } as unknown as CacheEnvelope;
    await expect(cache.set(ctx, keyOf(1), bad)).resolves.toBeUndefined();
    expect(await cache.get(ctx, keyOf(1))).toBeNull();
  });
});
