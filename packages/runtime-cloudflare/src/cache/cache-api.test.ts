import { describe, expect, it } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { BoundCacheKey, CacheEnvelope } from '@package-broker/core/platform/cache';
import { MAX_ENTRY_BYTES } from '@package-broker/core/platform/cache';
import { CacheCorruptError, createCacheApiAdapter, type CacheStorageLike } from './cache-api.js';

const ctx = orgContext('org-1');
const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const digest = 'a'.repeat(64);
const key: BoundCacheKey = { projectId: 'proj-1', sourceId: 'src-1', kind: 'metadata', digest };
const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();

function envelope(overrides: Partial<CacheEnvelope> = {}): CacheEnvelope {
  return {
    value: new Uint8Array([0, 1, 2, 250, 255]),
    freshUntil: iso(300),
    staleUntil: iso(3600),
    negative: false,
    insertedAt: iso(0),
    ...overrides,
  };
}

function fakeStorage(undefinedMiss = false) {
  const store = new Map<string, Response>();
  const opened: string[] = [];
  const urls: string[] = [];
  const storage: CacheStorageLike = {
    async open(name) {
      opened.push(name);
      return {
        async match(req) {
          urls.push(`${req.method} ${req.url}`);
          return store.get(req.url)?.clone() ?? (undefinedMiss ? undefined : null);
        },
        async put(req, res) {
          urls.push(`${req.method} ${req.url}`);
          store.set(req.url, res);
        },
        async delete(req) {
          urls.push(`${req.method} ${req.url}`);
          return store.delete(req.url);
        },
      };
    },
  };
  return { storage, store, opened, urls };
}

function setup(now = T0) {
  const fake = fakeStorage();
  const clock = { now };
  const counters: Array<{ name: string; labels: unknown }> = [];
  const cache = createCacheApiAdapter(fake.storage, undefined, {
    now: () => new Date(clock.now),
    metrics: { counter: (name, labels) => void counters.push({ name, labels }) },
  });
  return { ...fake, clock, counters, cache };
}

describe('cache api adapter', () => {
  it('round-trips set, get and delete and misses an unknown key', async () => {
    const h = setup();
    expect(await h.cache.get(ctx, key)).toBeNull();
    await h.cache.set(ctx, key, envelope());
    const hit = await h.cache.get(ctx, key);
    expect(hit?.state).toBe('fresh');
    expect(Array.from(hit?.entry.value ?? [])).toEqual([0, 1, 2, 250, 255]);
    expect(hit?.entry).toMatchObject({
      negative: false,
      insertedAt: iso(0),
      staleUntil: iso(3600),
    });
    await h.cache.delete(ctx, key);
    expect(await h.cache.get(ctx, key)).toBeNull();
    expect(h.counters).toEqual([]);
  });

  it('opens the named cache and uses the synthetic key verbatim', async () => {
    const h = setup();
    await h.cache.set(ctx, key, envelope());
    await h.cache.get(ctx, key);
    await h.cache.delete(ctx, key);
    expect(new Set(h.opened)).toEqual(new Set(['pb-metadata-v1']));
    const expected = `https://cache.invalid/pb/v1/${digest}`;
    expect(h.urls).toEqual([`GET ${expected}`, `GET ${expected}`, `GET ${expected}`]);
    expect([...h.store.keys()]).toEqual([]);
    for (const u of h.urls) {
      expect(u).not.toMatch(/proj-1|src-1|org-1/);
    }
  });

  it('honours a custom namespace', async () => {
    const fake = fakeStorage();
    const cache = createCacheApiAdapter(fake.storage, 'pb-test', { now: () => new Date(T0) });
    await cache.get(ctx, key);
    expect(fake.opened).toEqual(['pb-test']);
  });

  it('reports an entry past freshUntil as stale and one past staleUntil as a miss', async () => {
    const h = setup();
    await h.cache.set(ctx, key, envelope());
    h.clock.now = T0 + 301_000;
    expect((await h.cache.get(ctx, key))?.state).toBe('stale');
    h.clock.now = T0 + 3_601_000;
    expect(await h.cache.get(ctx, key)).toBeNull();
  });

  it('never serves a negative entry or one without staleUntil after freshUntil', async () => {
    const h = setup();
    await h.cache.set(
      ctx,
      key,
      envelope({ negative: true, staleUntil: null, freshUntil: iso(30) }),
    );
    expect((await h.cache.get(ctx, key))?.state).toBe('fresh');
    h.clock.now = T0 + 31_000;
    expect(await h.cache.get(ctx, key)).toBeNull();
  });

  it('keeps serving fresh while freshUntil is ahead of an already-passed staleUntil', async () => {
    const h = setup();
    await h.cache.set(ctx, key, envelope({ freshUntil: iso(300), staleUntil: iso(-5) }));
    expect(h.store.size).toBe(1);
    expect((await h.cache.get(ctx, key))?.state).toBe('fresh');
    expect(h.store.get(`https://cache.invalid/pb/v1/${digest}`)?.headers.get('cache-control')).toBe(
      'public, max-age=300',
    );
    h.clock.now = T0 + 301_000;
    expect(await h.cache.get(ctx, key)).toBeNull();
  });

  it('does not store an envelope that is already expired', async () => {
    const h = setup();
    await h.cache.set(ctx, key, envelope({ freshUntil: iso(-10), staleUntil: iso(-5) }));
    expect(h.store.size).toBe(0);
  });

  it('deletes an older entry instead of leaving it when the new one is already expired', async () => {
    const h = setup();
    await h.cache.set(ctx, key, envelope());
    expect(h.store.size).toBe(1);
    await h.cache.set(ctx, key, envelope({ freshUntil: iso(-10), staleUntil: iso(-5) }));
    expect(h.store.size).toBe(0);
  });

  it('throws a typed error for a corrupt body or valid JSON of the wrong shape', async () => {
    const h = setup();
    const url = `https://cache.invalid/pb/v1/${digest}`;
    for (const body of ['not json', '{"v":1}', '[]', 'null', '{"v":2}']) {
      h.store.set(url, new Response(body));
      await expect(h.cache.get(ctx, key)).rejects.toBeInstanceOf(CacheCorruptError);
    }
    h.store.set(
      url,
      new Response(
        JSON.stringify({
          v: 1,
          freshUntil: iso(300),
          staleUntil: null,
          negative: false,
          insertedAt: iso(0),
          value: '***',
        }),
      ),
    );
    await expect(h.cache.get(ctx, key)).rejects.toBeInstanceOf(CacheCorruptError);
  });

  it('treats an undefined match result as a miss', async () => {
    const fake = fakeStorage(true);
    const cache = createCacheApiAdapter(fake.storage, undefined, { now: () => new Date(T0) });
    expect(await cache.get(ctx, key)).toBeNull();
  });

  it('lets backing store failures propagate on get, delete and awaited set', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('store down');
    };
    const failing: CacheStorageLike = {
      open: async () => ({ match: boom, put: boom, delete: boom }),
    };
    const cache = createCacheApiAdapter(failing, undefined, { now: () => new Date(T0) });
    await expect(cache.get(ctx, key)).rejects.toThrow('store down');
    await expect(cache.set(ctx, key, envelope())).rejects.toThrow('store down');
    await expect(cache.delete(ctx, key)).rejects.toThrow('store down');
    const failOpen = createCacheApiAdapter(
      { open: () => Promise.reject(new Error('x')) },
      undefined,
      { now: () => new Date(T0) },
    );
    await expect(failOpen.get(ctx, key)).rejects.toThrow('x');
  });

  it('rejects a digest that is not 64 lowercase hex characters', async () => {
    const h = setup();
    for (const digestValue of ['../x?token=1', 'A'.repeat(64), 'a'.repeat(63)]) {
      const bad = { ...key, digest: digestValue };
      await expect(h.cache.get(ctx, bad)).rejects.toBeInstanceOf(TypeError);
      await expect(h.cache.set(ctx, bad, envelope())).rejects.toBeInstanceOf(TypeError);
      await expect(h.cache.delete(ctx, bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(h.urls).toEqual([]);
  });

  it('round-trips exactly 1 MiB and refuses one byte more', async () => {
    const h = setup();
    const value = new Uint8Array(MAX_ENTRY_BYTES).fill(7);
    await h.cache.set(ctx, key, envelope({ value }));
    const hit = await h.cache.get(ctx, key);
    expect(hit?.entry.value.byteLength).toBe(MAX_ENTRY_BYTES);
    expect(hit?.entry.value[MAX_ENTRY_BYTES - 1]).toBe(7);
    h.store.clear();
    await h.cache.set(ctx, key, envelope({ value: new Uint8Array(MAX_ENTRY_BYTES + 1) }));
    expect(h.store.size).toBe(0);
  });

  it('sets cache-control max-age to the ceiling of the seconds until expiry', async () => {
    const h = setup(T0 + 500);
    await h.cache.set(ctx, key, envelope());
    const stored = h.store.get(`https://cache.invalid/pb/v1/${digest}`);
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=3600');
    h.store.clear();
    await h.cache.set(ctx, key, envelope({ staleUntil: null, freshUntil: iso(30) }));
    expect(h.store.get(`https://cache.invalid/pb/v1/${digest}`)?.headers.get('cache-control')).toBe(
      'public, max-age=30',
    );
  });

  it('resolves set while a deferred put is still pending, and counts its failure', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: string[] = [];
    const storage: CacheStorageLike = {
      open: async () => ({
        match: async () => null,
        put: async (req) => {
          await gate;
          stored.push(req.url);
        },
        delete: async () => false,
      }),
    };
    const pending: Promise<unknown>[] = [];
    const cache = createCacheApiAdapter(storage, undefined, {
      now: () => new Date(T0),
      waitUntil: (p) => void pending.push(p),
    });
    await cache.set(ctx, key, envelope());
    expect(pending).toHaveLength(1);
    expect(stored).toEqual([]);
    release();
    await Promise.all(pending);
    expect(stored).toHaveLength(1);

    const counters: unknown[] = [];
    const failing = createCacheApiAdapter(
      { open: () => Promise.reject(new Error('x')) },
      undefined,
      {
        now: () => new Date(T0),
        waitUntil: (p) => void pending.push(p),
        metrics: { counter: (n, l) => void counters.push([n, l]) },
      },
    );
    await failing.set(ctx, key, envelope());
    await Promise.all(pending);
    expect(counters).toEqual([['pb.cache.operations', { outcome: 'error', adapter: 'cache-api' }]]);
  });
});
