import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext } from '../db/port.js';
import type { CatalogueDocKind, ResolvedPackage } from '../db/catalogue.js';
import {
  type BoundCacheKey,
  type Cache,
  type CacheEnvelope,
  type EpochReader,
  createScopedCache,
  defaultEntry,
} from '../platform/cache.js';
import type { CacheKey } from '../platform/cache.js';
import type { NameEcosystem } from './names.js';
import { boundEpochReader, catalogueCacheKey, catalogueNegativeKey } from './cache-keys.js';

const ctx = orgContext('org-1');
const origin = { status: 200, authenticated: true, authorized: true };

const pkg: ResolvedPackage = {
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'vendor/pkg',
  packageId: 'pkg-1',
  sourceId: 'src-1',
  rev: 3,
  modifiedAt: '2026-10-16T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
  listingComplete: true,
  cacheEpoch: 'epoch-1',
};

function memoryCache(): Cache & {
  readonly store: Map<string, CacheEnvelope>;
  readonly calls: { gets: number; sets: number };
} {
  const store = new Map<string, CacheEnvelope>();
  const calls = { gets: 0, sets: 0 };
  const id = (k: BoundCacheKey): string =>
    JSON.stringify([k.projectId, k.sourceId, k.kind, k.digest]);
  return {
    store,
    calls,
    get: (_c, k) => {
      calls.gets += 1;
      const entry = store.get(id(k));
      return Promise.resolve(entry === undefined ? null : { entry, state: 'fresh' as const });
    },
    set: (_c, k, e) => {
      calls.sets += 1;
      store.set(id(k), e);
      return Promise.resolve();
    },
    delete: (_c, k) => {
      store.delete(id(k));
      return Promise.resolve();
    },
  };
}

async function digestOf(p: ResolvedPackage, docKind: Parameters<typeof catalogueCacheKey>[1]) {
  const raw = memoryCache();
  const cache = createScopedCache(raw, boundEpochReader(p), { deploymentId: 'dep' });
  const { version } = await cache.get(ctx, catalogueCacheKey(p, docKind));
  await cache.set(
    ctx,
    catalogueCacheKey(p, docKind),
    defaultEntry('metadata', new Uint8Array([1]), new Date()),
    {
      expectedVersion: version ?? '',
      origin,
    },
  );
  return [...raw.store.keys()][0];
}

describe('catalogueCacheKey', () => {
  it('is a valid metadata key scoped to project and winner', () => {
    expect(catalogueCacheKey(pkg, 'composer-p2')).toEqual({
      projectId: 'proj-1',
      sourceId: 'src-1',
      kind: 'metadata',
      resource: 'composer/composer-p2/pkg-1:3',
    });
  });

  it('differs across projectId, sourceId, rev and docKind', async () => {
    const variants: ResolvedPackage[] = [
      pkg,
      { ...pkg, projectId: 'proj-2' },
      { ...pkg, sourceId: 'src-2' },
      { ...pkg, rev: 4 },
    ];
    const digests = await Promise.all(variants.map((v) => digestOf(v, 'composer-p2')));
    expect(digests.every((d) => d !== undefined)).toBe(true);
    expect(new Set(digests).size).toBe(variants.length);
    expect(await digestOf(pkg, 'composer-p2-dev')).not.toBe(digests[0]);
  });

  it('is accepted by the scoped cache (stored, not refused)', async () => {
    const raw = memoryCache();
    const cache = createScopedCache(raw, boundEpochReader(pkg), { deploymentId: 'dep' });
    const key = catalogueCacheKey(pkg, 'npm-full');
    const { version } = await cache.get(ctx, key);
    const result = await cache.set(
      ctx,
      key,
      defaultEntry('metadata', new Uint8Array([1]), new Date()),
      {
        expectedVersion: version ?? '',
        origin,
      },
    );
    expect(result).toBe('stored');
  });

  it('misses after the package epoch changes', async () => {
    const raw = memoryCache();
    const key = catalogueCacheKey(pkg, 'composer-p2');
    const first = createScopedCache(raw, boundEpochReader(pkg), { deploymentId: 'dep' });
    const { version } = await first.get(ctx, key);
    const entry = defaultEntry('metadata', new Uint8Array([1]), new Date());
    expect(await first.set(ctx, key, entry, { expectedVersion: version ?? '', origin })).toBe(
      'stored',
    );
    expect((await first.get(ctx, key)).hit).not.toBeNull();
    const bumped = { ...pkg, cacheEpoch: 'e2' };
    const second = createScopedCache(raw, boundEpochReader(bumped), { deploymentId: 'dep' });
    expect((await second.get(ctx, catalogueCacheKey(bumped, 'composer-p2'))).hit).toBeNull();
  });

  it('stores and separates package ids containing / : and @', async () => {
    const odd = { ...pkg, packageId: 'a:b/c@d' };
    const raw = memoryCache();
    const cache = createScopedCache(raw, boundEpochReader(odd), { deploymentId: 'dep' });
    const key = catalogueCacheKey(odd, 'composer-p2');
    const { version } = await cache.get(ctx, key);
    const entry = defaultEntry('metadata', new Uint8Array([1]), new Date());
    expect(await cache.set(ctx, key, entry, { expectedVersion: version ?? '', origin })).toBe(
      'stored',
    );
    const a = catalogueCacheKey({ ...pkg, packageId: 'x:1', rev: 2 }, 'composer-p2');
    const b = catalogueCacheKey({ ...pkg, packageId: 'x', rev: 1 }, 'composer-p2');
    const c = catalogueCacheKey({ ...pkg, packageId: 'x/composer-p2/y' }, 'composer-p2');
    const d = catalogueCacheKey({ ...pkg, packageId: 'y' }, 'composer-p2');
    expect(new Set([a.resource, b.resource, c.resource, d.resource]).size).toBe(4);
    expect(a.resource).not.toContain('x:1');
    expect(odd.packageId).toContain('@');
  });

  it('takes no user, token, page or cut-off input', () => {
    type Params = Parameters<typeof catalogueCacheKey>;
    const arity: Params['length'] = 2;
    expect(arity).toBe(2);
    // @ts-expect-error a third argument (page, cut-off, user) is not accepted
    catalogueCacheKey(pkg, 'composer-p2', { page: 1 });
    // @ts-expect-error doc kinds are a closed set
    catalogueCacheKey(pkg, 'composer-p3');
    const key = catalogueCacheKey(pkg, 'npm-dist-tags');
    expect(Object.keys(key).sort()).toEqual(['kind', 'projectId', 'resource', 'sourceId']);
  });
});

describe('catalogueNegativeKey', () => {
  it('is per attached source and uses kind negative', () => {
    const a = catalogueNegativeKey('proj-1', 'proxy-a', 'npm', '@scope/name');
    const b = catalogueNegativeKey('proj-1', 'proxy-b', 'npm', '@scope/name');
    expect(a.kind).toBe('negative');
    expect(a.sourceId).toBe('proxy-a');
    expect(a).not.toEqual(b);
    const base = catalogueNegativeKey('proj-1', 'proxy-a', 'npm', 'name');
    expect(catalogueNegativeKey('proj-2', 'proxy-a', 'npm', 'name')).not.toEqual(base);
    expect(catalogueNegativeKey('proj-1', 'proxy-a', 'npm', 'other')).not.toEqual(base);
    expect(catalogueNegativeKey('proj-1', 'proxy-a', 'composer', 'name')).not.toEqual(base);
  });

  it('has exact parameter and return types', () => {
    expectTypeOf<Parameters<typeof catalogueNegativeKey>>().toEqualTypeOf<
      [string, string, NameEcosystem, string]
    >();
    expectTypeOf<ReturnType<typeof catalogueNegativeKey>>().toEqualTypeOf<CacheKey>();
    expectTypeOf<Parameters<typeof catalogueCacheKey>>().toEqualTypeOf<
      [ResolvedPackage, CatalogueDocKind]
    >();
    expectTypeOf<ReturnType<typeof catalogueCacheKey>>().toEqualTypeOf<CacheKey>();
    expectTypeOf<Parameters<typeof boundEpochReader>>().toEqualTypeOf<[ResolvedPackage]>();
    expectTypeOf<ReturnType<typeof boundEpochReader>>().toEqualTypeOf<EpochReader>();
  });

  it('is accepted by the scoped cache for names containing @', async () => {
    const raw = memoryCache();
    const cache = createScopedCache(
      raw,
      { read: () => Promise.resolve('e1') },
      { deploymentId: 'dep' },
    );
    const key = catalogueNegativeKey('proj-1', 'proxy-a', 'npm', '@scope/name');
    const { version } = await cache.get(ctx, key);
    const result = await cache.set(
      ctx,
      key,
      defaultEntry('negative', new Uint8Array([1]), new Date()),
      {
        expectedVersion: version ?? '',
        origin: { status: 404, authenticated: true, authorized: true },
      },
    );
    expect(result).toBe('stored');
  });
});

describe('boundEpochReader', () => {
  it('yields the epoch bound to the package', async () => {
    const reader: EpochReader = boundEpochReader(pkg);
    expect(await reader.read(ctx)).toBe('epoch-1');
  });

  it('bypasses read and fill when cacheEpoch is null', async () => {
    const raw = memoryCache();
    const nullPkg = { ...pkg, cacheEpoch: null };
    const cache = createScopedCache(raw, boundEpochReader(nullPkg), { deploymentId: 'dep' });
    const key = catalogueCacheKey(nullPkg, 'composer-p2');
    expect(await cache.get(ctx, key)).toEqual({ hit: null, version: null });
    const result = await cache.set(
      ctx,
      key,
      defaultEntry('metadata', new Uint8Array([1]), new Date()),
      {
        expectedVersion: 'epoch-1',
        origin,
      },
    );
    expect(result).toBe('bypassed');
    expect(raw.store.size).toBe(0);
    expect(raw.calls).toEqual({ gets: 0, sets: 0 });
  });
});
