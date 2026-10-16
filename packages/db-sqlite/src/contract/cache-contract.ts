import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type {
  CacheEnvelope,
  CacheEntry,
  CacheEventCode,
  CacheKey,
  FillOrigin,
  ScopedCache,
} from '@package-broker/core/platform/cache';
import {
  MAX_ENTRY_BYTES,
  METADATA_FRESH_SECONDS,
  METADATA_STALE_SECONDS,
  NEGATIVE_FRESH_SECONDS,
  defaultEntry,
} from '@package-broker/core/platform/cache';

type Hook<A extends unknown[] = []> = (...args: A) => void | Promise<void>;

/**
 * Fixtures build their scoped cache with the default clock: the suite moves time with fake timers.
 * Callers map upstream 5xx responses and network errors to `{ kind: 'transient' }`; a bare status
 * outcome never unlocks stale serving. Adapters keep stored objects until `staleUntil`, because the
 * scoped cache, not the store, decides freshness.
 */
export interface CacheContractFixture {
  readonly cache: ScopedCache;
  readonly forDeployment: (deploymentId: string) => ScopedCache;
  readonly setEpoch: Hook<[version: number | null]>;
  readonly failNextOperation: Hook;
  readonly failNextEpochRead: Hook;
  readonly corruptStored: Hook;
  readonly rewriteStored: Hook<[patch: Partial<CacheEnvelope>]>;
  readonly events: () => readonly CacheEventCode[];
}

const HOOKS = [
  'cache',
  'forDeployment',
  'setEpoch',
  'failNextOperation',
  'failNextEpochRead',
  'corruptStored',
  'rewriteStored',
  'events',
] as const;

export function requireFixtureHooks(fixture: CacheContractFixture): void {
  for (const hook of HOOKS) {
    const value: unknown = (fixture as unknown as Record<string, unknown>)[hook];
    if (
      hook === 'cache' ? typeof value !== 'object' || value === null : typeof value !== 'function'
    ) {
      throw new Error(`cache contract fixture is missing the ${hook} hook`);
    }
  }
  for (const method of ['get', 'set', 'delete', 'currentVersion'] as const) {
    if (typeof (fixture.cache as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`cache contract fixture cache is missing ${method}`);
    }
  }
}

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const ctx = orgContext('org-1');
const otherOrg = orgContext('org-2');
const encoder = new TextEncoder();

const key: CacheKey = {
  projectId: 'proj-1',
  sourceId: 'src-1',
  kind: 'metadata',
  resource: 'vendor/pkg',
};
const negativeKey: CacheKey = { ...key, kind: 'negative' };

const authorizedOk: FillOrigin = { status: 200, authenticated: true, authorized: true };
const authorizedNotFound: FillOrigin = { status: 404, authenticated: true, authorized: true };

const bytes = (text: string): Uint8Array => encoder.encode(text);
const metadata = (text: string): CacheEntry => defaultEntry('metadata', bytes(text), new Date());
const negative = (): CacheEntry => defaultEntry('negative', bytes('{}'), new Date());
const at = (seconds: number): void => {
  vi.setSystemTime(T0 + seconds * 1000);
};
const text = (entry: { value: Uint8Array } | undefined): string | undefined =>
  entry === undefined ? undefined : new TextDecoder().decode(entry.value);

async function ready(make: () => Promise<CacheContractFixture>): Promise<CacheContractFixture> {
  const fixture = await make();
  requireFixtureHooks(fixture);
  await fixture.setEpoch(1);
  return fixture;
}

async function fill(
  cache: ScopedCache,
  entry: CacheEntry,
  options: { key?: CacheKey; org?: typeof ctx; origin?: FillOrigin } = {},
): Promise<string> {
  const target = options.key ?? key;
  const org = options.org ?? ctx;
  const { version } = await cache.get(org, target);
  if (version === null) throw new Error('epoch unavailable');
  return cache.set(org, target, entry, {
    expectedVersion: version,
    origin: options.origin ?? (entry.negative ? authorizedNotFound : authorizedOk),
  });
}

export function describeCacheContract(
  name: string,
  make: () => Promise<CacheContractFixture>,
): void {
  describe(`cache contract: ${name}`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a complete fixture is required: a missing hook fails the suite', async () => {
      const fixture = await make();
      expect(() => requireFixtureHooks(fixture)).not.toThrow();
    });

    it('isolates organizations, projects, sources, resources and kinds', async () => {
      const f = await ready(make);
      expect(await fill(f.cache, metadata('a'))).toBe('stored');
      expect((await f.cache.get(otherOrg, key)).hit).toBeNull();
      expect((await f.cache.get(ctx, { ...key, projectId: 'proj-2' })).hit).toBeNull();
      expect((await f.cache.get(ctx, { ...key, sourceId: 'src-2' })).hit).toBeNull();
      expect((await f.cache.get(ctx, { ...key, resource: 'vendor/other' })).hit).toBeNull();
      expect((await f.cache.get(ctx, negativeKey)).hit).toBeNull();
      expect(f.events()).not.toContain('corrupt_entry');
      expect(text((await f.cache.get(ctx, key)).hit?.entry)).toBe('a');
    });

    it('isolates two deployments sharing one store', async () => {
      const f = await ready(make);
      const first = f.forDeployment('dep-isolation-a');
      const second = f.forDeployment('dep-isolation-b');
      expect(await fill(first, metadata('a'))).toBe('stored');
      expect((await second.get(ctx, key)).hit).toBeNull();
      expect(text((await first.get(ctx, key)).hit?.entry)).toBe('a');
    });

    it('metadata is fresh at 299 s and not fresh at 300 s and 301 s', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      at(METADATA_FRESH_SECONDS - 1);
      expect((await f.cache.get(ctx, key)).hit?.state).toBe('fresh');
      expect(f.events()).not.toContain('cache_error');
      expect(f.events()).not.toContain('corrupt_entry');
      for (const seconds of [METADATA_FRESH_SECONDS, METADATA_FRESH_SECONDS + 1]) {
        at(seconds);
        expect((await f.cache.get(ctx, key)).hit).toBeNull();
      }
    });

    it('stale is served only after a transient error, from 300 s up to 3,599 s', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      const transient = { upstream: { kind: 'transient' } } as const;
      at(METADATA_FRESH_SECONDS);
      expect((await f.cache.get(ctx, key, transient)).hit?.state).toBe('stale');
      at(METADATA_STALE_SECONDS - 1);
      expect((await f.cache.get(ctx, key, transient)).hit?.state).toBe('stale');
      for (const seconds of [METADATA_STALE_SECONDS, METADATA_STALE_SECONDS + 1]) {
        at(seconds);
        expect((await f.cache.get(ctx, key, transient)).hit).toBeNull();
      }
    });

    it('no stale without an upstream outcome, after 401, 403, 5xx or a policy removal', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      at(METADATA_FRESH_SECONDS + 1);
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
      const refusals = [
        { kind: 'status', status: 401 },
        { kind: 'status', status: 403 },
        { kind: 'status', status: 500 },
        { kind: 'policy_removed' },
      ] as const;
      for (const upstream of refusals) {
        expect((await f.cache.get(ctx, key, { upstream })).hit).toBeNull();
      }
    });

    it('a negative is fresh at 29 s, gone at 30 s and 31 s, and never stale', async () => {
      const f = await ready(make);
      expect(await fill(f.cache, negative(), { key: negativeKey })).toBe('stored');
      at(NEGATIVE_FRESH_SECONDS - 1);
      expect((await f.cache.get(ctx, negativeKey)).hit?.state).toBe('fresh');
      for (const seconds of [NEGATIVE_FRESH_SECONDS, NEGATIVE_FRESH_SECONDS + 1]) {
        at(seconds);
        const transient = { upstream: { kind: 'transient' } } as const;
        expect((await f.cache.get(ctx, negativeKey)).hit).toBeNull();
        expect((await f.cache.get(ctx, negativeKey, transient)).hit).toBeNull();
      }
    });

    it('an epoch advance makes earlier entries unreachable, including for stale serving', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('old'));
      await f.setEpoch(2);
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
      at(METADATA_FRESH_SECONDS + 1);
      expect((await f.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit).toBeNull();
    });

    it('a fill that read the epoch before an advance is discarded', async () => {
      const f = await ready(make);
      const { version } = await f.cache.get(ctx, key);
      if (version === null) throw new Error('epoch unavailable');
      await f.setEpoch(2);
      const result = await f.cache.set(ctx, key, metadata('late'), {
        expectedVersion: version,
        origin: authorizedOk,
      });
      expect(result).toBe('discarded');
      expect(f.events()).toContain('fill_discarded');
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('refuses an entry over 1 MiB and stores exactly 1 MiB', async () => {
      const f = await ready(make);
      const oversized = { ...metadata(''), value: new Uint8Array(MAX_ENTRY_BYTES + 1) };
      expect(await fill(f.cache, oversized)).toBe('refused');
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
      const exact = { ...metadata(''), value: new Uint8Array(MAX_ENTRY_BYTES) };
      expect(await fill(f.cache, exact)).toBe('stored');
    });

    it('a corrupt envelope is a miss with a corrupt_entry or cache_error event', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.corruptStored();
      const result = await f.cache.get(ctx, key);
      expect(result.hit).toBeNull();
      expect(result.version).not.toBeNull();
      const codes = f.events();
      expect(codes.includes('corrupt_entry') || codes.includes('cache_error')).toBe(true);
    });

    it('a cache error on read is a miss plus a cache_error event, never a throw', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.failNextOperation();
      const result = await f.cache.get(ctx, key);
      expect(result.hit).toBeNull();
      expect(result.version).not.toBeNull();
      expect(f.events()).toContain('cache_error');
      expect(text((await f.cache.get(ctx, key)).hit?.entry)).toBe('m');
    });

    it('a cache error on write reports error and stores nothing', async () => {
      const f = await ready(make);
      const { version } = await f.cache.get(ctx, key);
      if (version === null) throw new Error('epoch unavailable');
      await f.failNextOperation();
      const result = await f.cache.set(ctx, key, metadata('m'), {
        expectedVersion: version,
        origin: authorizedOk,
      });
      expect(result).toBe('error');
      expect(f.events()).toContain('cache_error');
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('an epoch read error bypasses the cache on read and write (C26)', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.failNextEpochRead();
      expect(await f.cache.get(ctx, key)).toEqual({ hit: null, version: null });
      expect(f.events()).toContain('epoch_error');
      const { version } = await f.cache.get(ctx, key);
      if (version === null) throw new Error('epoch unavailable');
      await f.failNextEpochRead();
      const result = await f.cache.set(ctx, key, metadata('n'), {
        expectedVersion: version,
        origin: authorizedOk,
      });
      expect(result).toBe('bypassed');
      expect(text((await f.cache.get(ctx, key)).hit?.entry)).toBe('m');
    });

    it('a token-bearing response is never stored (C25)', async () => {
      const f = await ready(make);
      const carriers = [
        '{"dist":"https://registry.example/p.zip?token=abcdef1234567890"}',
        '{"url":"https://user:secret@registry.example/p.zip"}',
        '{"auth":"Bearer abcdefghijklmnop1234"}',
        '{"key":"ghp_abcdefghijklmnop1234"}',
      ];
      for (const carrier of carriers) {
        expect(await fill(f.cache, metadata(carrier))).toBe('refused');
      }
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('negatives are written only for an authenticated, authorized 404 (G6)', async () => {
      const f = await ready(make);
      const refused: FillOrigin[] = [
        { status: 404, authenticated: false, authorized: false },
        { status: 404, authenticated: false, authorized: true },
        { status: 404, authenticated: true, authorized: false },
        { status: 403, authenticated: true, authorized: true },
        { status: 500, authenticated: true, authorized: true },
        { status: 200, authenticated: true, authorized: true },
      ];
      for (const origin of refused) {
        expect(await fill(f.cache, negative(), { key: negativeKey, origin })).toBe('refused');
      }
      expect((await f.cache.get(ctx, negativeKey)).hit).toBeNull();
      expect(await fill(f.cache, negative(), { key: negativeKey })).toBe('stored');
    });

    it('metadata is stored only for an authenticated, authorized success', async () => {
      const f = await ready(make);
      const refused: FillOrigin[] = [
        { status: 200, authenticated: false, authorized: false },
        { status: 200, authenticated: false, authorized: true },
        { status: 200, authenticated: true, authorized: false },
        { status: 401, authenticated: true, authorized: true },
        { status: 404, authenticated: true, authorized: true },
      ];
      for (const origin of refused) {
        expect(await fill(f.cache, metadata('m'), { origin })).toBe('refused');
      }
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
      const notModified = { status: 304, authenticated: true, authorized: true };
      expect(await fill(f.cache, metadata('m'), { origin: notModified })).toBe('stored');
    });

    it('delete removes the entry for the current epoch', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.cache.delete(ctx, key);
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('refuses lifetimes beyond 300 s fresh and 3,600 s stale', async () => {
      const f = await ready(make);
      const tooFresh = { ...metadata('m'), freshUntil: new Date(T0 + 301_000).toISOString() };
      const tooStale = { ...metadata('m'), staleUntil: new Date(T0 + 3_601_000).toISOString() };
      expect(await fill(f.cache, tooFresh)).toBe('refused');
      expect(await fill(f.cache, tooStale)).toBe('refused');
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('caps a stored freshUntil at insertion plus 300 s', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.rewriteStored({ freshUntil: new Date(T0 + 100_000_000).toISOString() });
      at(METADATA_FRESH_SECONDS - 1);
      expect((await f.cache.get(ctx, key)).hit?.state).toBe('fresh');
      at(METADATA_FRESH_SECONDS);
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
    });

    it('does not serve stale past a stored staleUntil', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      const freshUntil = new Date(T0 + METADATA_FRESH_SECONDS * 1000);
      await f.rewriteStored({ staleUntil: new Date(freshUntil.getTime() + 10_000).toISOString() });
      at(METADATA_FRESH_SECONDS + 20);
      const transient = { upstream: { kind: 'transient' } } as const;
      expect((await f.cache.get(ctx, key, transient)).hit).toBeNull();
    });

    it('caps a stored staleUntil at insertion plus 3,600 s', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.rewriteStored({ staleUntil: new Date(T0 + 100_000_000).toISOString() });
      const transient = { upstream: { kind: 'transient' } } as const;
      at(METADATA_STALE_SECONDS - 1);
      expect((await f.cache.get(ctx, key, transient)).hit?.state).toBe('stale');
      at(METADATA_STALE_SECONDS);
      expect((await f.cache.get(ctx, key, transient)).hit).toBeNull();
    });

    it('never serves a negative stale, even with a stored staleUntil', async () => {
      const f = await ready(make);
      await fill(f.cache, negative(), { key: negativeKey });
      await f.rewriteStored({ staleUntil: new Date(T0 + 3_000_000).toISOString() });
      at(NEGATIVE_FRESH_SECONDS + 1);
      const transient = { upstream: { kind: 'transient' } } as const;
      expect((await f.cache.get(ctx, negativeKey, transient)).hit).toBeNull();
    });

    it('treats an insertedAt in the future as corrupt', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.rewriteStored({
        insertedAt: new Date(T0 + 86_400_000).toISOString(),
        freshUntil: new Date(T0 + 2 * 86_400_000).toISOString(),
      });
      expect((await f.cache.get(ctx, key)).hit).toBeNull();
      const codes = f.events();
      expect(codes.includes('corrupt_entry') || codes.includes('cache_error')).toBe(true);
    });

    it('refuses a negative with freshUntil beyond 30 s or any staleUntil', async () => {
      const f = await ready(make);
      const tooFresh = { ...negative(), freshUntil: new Date(T0 + 31_000).toISOString() };
      const stale = { ...negative(), staleUntil: new Date(T0 + 60_000).toISOString() };
      expect(await fill(f.cache, tooFresh, { key: negativeKey })).toBe('refused');
      expect(await fill(f.cache, stale, { key: negativeKey })).toBe('refused');
      expect((await f.cache.get(ctx, negativeKey)).hit).toBeNull();
    });

    it('caps a stored negative freshUntil at insertion plus 30 s', async () => {
      const f = await ready(make);
      await fill(f.cache, negative(), { key: negativeKey });
      await f.rewriteStored({ freshUntil: new Date(T0 + 100_000_000).toISOString() });
      at(NEGATIVE_FRESH_SECONDS);
      expect((await f.cache.get(ctx, negativeKey)).hit).toBeNull();
    });

    it('a missing epoch row bypasses reads and fills', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.setEpoch(null);
      expect(await f.cache.get(ctx, key)).toEqual({ hit: null, version: null });
      expect(f.events()).toContain('epoch_missing');
      const result = await f.cache.set(ctx, key, metadata('n'), {
        expectedVersion: '0',
        origin: authorizedOk,
      });
      expect(result).toBe('bypassed');
    });

    it('delete swallows a cache error', async () => {
      const f = await ready(make);
      await fill(f.cache, metadata('m'));
      await f.failNextOperation();
      await expect(f.cache.delete(ctx, key)).resolves.toBeUndefined();
      expect(f.events()).toContain('cache_error');
    });
  });
}
