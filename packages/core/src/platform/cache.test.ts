import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import {
  type BoundCacheKey,
  type Cache,
  type CacheEntry,
  type CacheEnvelope,
  type CacheKey,
  type EpochReader,
  type FillOrigin,
  MAX_ENTRY_BYTES,
  createScopedCache,
  defaultEntry,
} from './cache.js';

const ctx = orgContext('org-1');
const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const enc = new TextEncoder();
const dec = new TextDecoder();

const key: CacheKey = {
  projectId: 'proj-1',
  sourceId: 'src-1',
  kind: 'metadata',
  resource: 'vendor/pkg',
};
const negKey: CacheKey = { ...key, kind: 'negative' };

const okMeta: FillOrigin = { status: 200, authenticated: true, authorized: true };
const okNeg: FillOrigin = { status: 404, authenticated: true, authorized: true };

interface Raw extends Cache {
  readonly store: Map<string, CacheEnvelope>;
  readonly keys: BoundCacheKey[];
}

function memoryCache(): Raw {
  const store = new Map<string, CacheEnvelope>();
  const keys: BoundCacheKey[] = [];
  const id = (k: BoundCacheKey): string =>
    JSON.stringify([k.projectId, k.sourceId, k.kind, k.digest]);
  return {
    store,
    keys,
    get(_c, k) {
      keys.push(k);
      const entry = store.get(id(k));
      return Promise.resolve(entry === undefined ? null : { entry, state: 'fresh' as const });
    },
    set(_c, k, entry) {
      keys.push(k);
      store.set(id(k), entry);
      return Promise.resolve();
    },
    delete(_c, k) {
      store.delete(id(k));
      return Promise.resolve();
    },
  };
}

function epochOf(initial: string | null): EpochReader & { value: string | null; fail: boolean } {
  const reader = {
    value: initial,
    fail: false,
    read() {
      if (reader.fail) return Promise.reject(new Error('d1 down'));
      return Promise.resolve(reader.value);
    },
  };
  return reader;
}

function harness(
  epochValue: string | null = 'e1',
  raw: Raw = memoryCache(),
  deploymentId = 'dep-1',
) {
  const epoch = epochOf(epochValue);
  const clock = { t: T0 };
  const events: string[] = [];
  const cache = createScopedCache(raw, epoch, {
    now: () => new Date(clock.t),
    deploymentId,
    onEvent: (code) => events.push(code),
  });
  return { raw, epoch, clock, events, cache };
}

const body = (s: string): Uint8Array => enc.encode(s);
const meta = (s: string, at = T0): CacheEntry => defaultEntry('metadata', body(s), new Date(at));
const neg = (at = T0): CacheEntry => defaultEntry('negative', body('{}'), new Date(at));
const fillMeta = (h: ReturnType<typeof harness>, s: string, k: CacheKey = key) =>
  h.cache.set(ctx, k, meta(s), { expectedVersion: 'e1', origin: okMeta });
const storedText = (h: ReturnType<typeof harness>): string =>
  dec.decode([...h.raw.store.values()][0]?.value);

describe('key binding', () => {
  async function digestFor(
    k: CacheKey,
    o: { org?: string; dep?: string; epoch?: string } = {},
  ): Promise<string> {
    const h = harness(o.epoch ?? 'e1', memoryCache(), o.dep ?? 'dep-1');
    await h.cache.get(orgContext(o.org ?? 'org-1'), k);
    const found = h.raw.keys[0]?.digest;
    if (found === undefined) throw new Error('no digest');
    return found;
  }

  it('produces a stable 64-hex digest', async () => {
    const a = await digestFor(key);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestFor({ ...key })).toBe(a);
  });

  it('differs per epoch, org, deployment, project, source, kind and resource', async () => {
    const base = await digestFor(key);
    const variants = [
      await digestFor(key, { epoch: 'e2' }),
      await digestFor(key, { org: 'org-2' }),
      await digestFor(key, { dep: 'dep-2' }),
      await digestFor({ ...key, projectId: 'p2' }),
      await digestFor({ ...key, sourceId: 's2' }),
      await digestFor(negKey),
      await digestFor({ ...key, resource: 'vendor/other' }),
    ];
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('cannot be confused by delimiter shifting between fields', async () => {
    const a = await digestFor({ ...key, projectId: 'a', sourceId: 'b,c' });
    const b = await digestFor({ ...key, projectId: 'a,b', sourceId: 'c' });
    expect(a).not.toBe(b);
  });

  it('refuses urls, query, fragment, userinfo, empty values and unknown fields as key material', async () => {
    const bad: unknown[] = [
      { ...key, resource: 'https://x.example/p' },
      { ...key, resource: 'git+https://x.example/p' },
      { ...key, resource: 'vendor/pkg?token=1' },
      { ...key, resource: 'vendor/pkg#frag' },
      { ...key, resource: 'user@vendor/pkg' },
      { ...key, projectId: '' },
      { ...key, sourceId: null },
      { ...key, userId: 'u1' },
      { ...key, grantVersion: 'x' },
    ];
    for (const k of bad) {
      const h = harness();
      expect((await h.cache.get(ctx, k as CacheKey)).hit).toBeNull();
      expect(h.events).toEqual(['invalid_key']);
      expect(h.raw.keys).toEqual([]);
    }
  });

  it('never embeds key material in the digest', async () => {
    const d = await digestFor(key);
    for (const part of ['org-1', 'proj-1', 'src-1', 'vendor', 'dep-1']) {
      expect(d).not.toContain(part);
    }
  });
});

describe('createScopedCache construction', () => {
  it('requires a non-empty deploymentId', () => {
    const raw = memoryCache();
    const make = (deploymentId: unknown) => () =>
      createScopedCache(raw, epochOf('e1'), { deploymentId } as never);
    expect(make('')).toThrow();
    expect(make(undefined)).toThrow();
    expect(() => createScopedCache(raw, epochOf('e1'), undefined as never)).toThrow();
  });
});

describe('scoped cache: epoch injection and key binding', () => {
  it('injects the epoch into the key so fills under different epochs differ', async () => {
    const h = harness('e1');
    await fillMeta(h, '{"a":1}');
    expect((await h.cache.get(ctx, key)).hit).not.toBeNull();
    h.epoch.value = 'e2';
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    await h.cache.set(ctx, key, meta('{"a":2}'), { expectedVersion: 'e2', origin: okMeta });
    const first = h.raw.keys[0];
    const second = h.raw.keys.at(-1);
    expect(first?.digest).not.toBe(second?.digest);
    expect(first?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.raw.store.size).toBe(2);
  });

  it('hands the raw cache the final digest and no resource or caller field', async () => {
    const h = harness('e1');
    await fillMeta(h, '{}');
    for (const k of h.raw.keys) {
      expect(Object.keys(k).sort()).toEqual(['digest', 'kind', 'projectId', 'sourceId']);
      expect(k.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('takes no grantVersion from the caller', async () => {
    const h = harness('e1');
    const smuggled = { ...key, grantVersion: 'old' } as unknown as CacheKey;
    expect((await h.cache.get(ctx, smuggled)).hit).toBeNull();
    expect(h.events).toContain('invalid_key');
  });

  it('isolates organizations, projects and sources', async () => {
    const h = harness('e1');
    await fillMeta(h, '{"a":1}');
    const other = orgContext('org-2');
    expect((await h.cache.get(other, key)).hit).toBeNull();
    expect((await h.cache.get(ctx, { ...key, projectId: 'proj-2' })).hit).toBeNull();
    expect((await h.cache.get(ctx, { ...key, sourceId: 'src-2' })).hit).toBeNull();
    expect((await h.cache.get(ctx, { ...key, resource: 'vendor/other' })).hit).toBeNull();
    expect((await h.cache.get(ctx, key)).hit).not.toBeNull();
  });

  it('isolates two deployments with the same org and epoch', async () => {
    const raw = memoryCache();
    const a = harness('e1', raw, 'dep-a');
    const b = harness('e1', raw, 'dep-b');
    await fillMeta(a, '{"a":1}');
    expect((await b.cache.get(ctx, key)).hit).toBeNull();
    expect((await a.cache.get(ctx, key)).hit).not.toBeNull();
  });
});

describe('scoped cache: freshness', () => {
  it('metadata is fresh at 299 s, stale at 300 s and 301 s', async () => {
    const h = harness();
    await fillMeta(h, '{"v":1}');
    h.clock.t = T0 + 299_000;
    expect((await h.cache.get(ctx, key)).hit?.state).toBe('fresh');
    h.clock.t = T0 + 300_000;
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    h.clock.t = T0 + 301_000;
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    const stale = (await h.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit;
    expect(stale?.state).toBe('stale');
    expect(dec.decode(stale?.entry.value)).toBe('{"v":1}');
  });

  it('stale metadata expires 3600 s after insertion', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    const transient = { upstream: { kind: 'transient' } } as const;
    h.clock.t = T0 + 3_599_000;
    expect((await h.cache.get(ctx, key, transient)).hit?.state).toBe('stale');
    h.clock.t = T0 + 3_600_000;
    expect((await h.cache.get(ctx, key, transient)).hit).toBeNull();
  });

  it('negative is fresh at 29 s, absent at 30 s and 31 s and never stale', async () => {
    const h = harness();
    await h.cache.set(ctx, negKey, neg(), { expectedVersion: 'e1', origin: okNeg });
    h.clock.t = T0 + 29_000;
    expect((await h.cache.get(ctx, negKey)).hit?.state).toBe('fresh');
    for (const s of [30_000, 31_000]) {
      h.clock.t = T0 + s;
      expect((await h.cache.get(ctx, negKey)).hit).toBeNull();
      expect((await h.cache.get(ctx, negKey, { upstream: { kind: 'transient' } })).hit).toBeNull();
    }
  });

  it('treats the envelope as authoritative when the backing store keeps the object', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    h.clock.t = T0 + 10_000_000;
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    expect(h.raw.store.size).toBe(1);
  });

  it('caps lifetimes on read to the policy bounds from the insertion time', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    const [id] = [...h.raw.store.keys()];
    const stored = h.raw.store.get(id ?? '');
    const far = new Date(T0 + 86_400_000).toISOString();
    h.raw.store.set(id ?? '', { ...stored, freshUntil: far, staleUntil: far } as CacheEnvelope);
    h.clock.t = T0 + 400_000;
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    expect((await h.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit?.state).toBe(
      'stale',
    );
    h.clock.t = T0 + 3_700_000;
    expect((await h.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit).toBeNull();
  });

  it('refuses entries whose lifetimes exceed the defaults or negative stale serving', async () => {
    const h = harness();
    const iso = (ms: number) => new Date(T0 + ms).toISOString();
    const base = { value: body('{}'), negative: false };
    const long: CacheEntry = { ...base, freshUntil: iso(301_000), staleUntil: iso(3_600_000) };
    const longStale: CacheEntry = { ...base, freshUntil: iso(300_000), staleUntil: iso(3_601_000) };
    const negStale: CacheEntry = {
      value: body('{}'),
      freshUntil: iso(30_000),
      staleUntil: iso(60_000),
      negative: true,
    };
    const v = { expectedVersion: 'e1' };
    expect(await h.cache.set(ctx, key, long, { ...v, origin: okMeta })).toBe('refused');
    expect(await h.cache.set(ctx, key, longStale, { ...v, origin: okMeta })).toBe('refused');
    expect(await h.cache.set(ctx, negKey, negStale, { ...v, origin: okNeg })).toBe('refused');
    expect(h.raw.store.size).toBe(0);
  });

  it('a corrupt envelope is a miss with telemetry', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    const [stored] = [...h.raw.store.keys()];
    h.raw.store.set(stored ?? '', { value: 'x', freshUntil: 5 } as unknown as CacheEnvelope);
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    expect(h.events).toContain('corrupt_entry');
  });
});

describe('scoped cache: epoch authority', () => {
  it('a miss still returns the epoch it read so the caller can reuse it', async () => {
    const h = harness('e7');
    const r = await h.cache.get(ctx, key);
    expect(r).toEqual({ hit: null, version: 'e7' });
  });

  it('discards a fill whose expectedVersion differs from the current epoch', async () => {
    const h = harness('e2');
    expect(await fillMeta(h, '{}')).toBe('discarded');
    expect(h.raw.store.size).toBe(0);
  });

  it('a missing epoch row means no read and no fill', async () => {
    const h = harness('e1');
    await fillMeta(h, '{}');
    h.epoch.value = null;
    const before = h.raw.keys.length;
    expect(await h.cache.get(ctx, key)).toEqual({ hit: null, version: null });
    expect(await fillMeta(h, '{}')).toBe('bypassed');
    expect(h.raw.keys.length).toBe(before);
    expect(h.events).toContain('epoch_missing');
  });

  it('a failed epoch read means no read and no fill', async () => {
    const h = harness('e1');
    await fillMeta(h, '{}');
    h.epoch.fail = true;
    const before = h.raw.keys.length;
    expect(await h.cache.get(ctx, key)).toEqual({ hit: null, version: null });
    expect(await fillMeta(h, '{}')).toBe('bypassed');
    expect(h.raw.keys.length).toBe(before);
    expect(h.events).toContain('epoch_error');
  });

  it('an epoch error on delete is reported and nothing is deleted', async () => {
    const h = harness('e1');
    await fillMeta(h, '{}');
    h.epoch.fail = true;
    await h.cache.delete(ctx, key);
    expect(h.events).toContain('epoch_error');
    expect(h.raw.store.size).toBe(1);
  });

  it('currentVersion exposes the authoritative epoch and null on failure', async () => {
    const h = harness('e1');
    expect(await h.cache.currentVersion(ctx)).toBe('e1');
    h.epoch.fail = true;
    expect(await h.cache.currentVersion(ctx)).toBeNull();
  });

  it('raw cache failures are a miss plus telemetry, never a throw', async () => {
    const raw: Cache = {
      get: () => Promise.reject(new Error('boom')),
      set: () => Promise.reject(new Error('boom')),
      delete: () => Promise.reject(new Error('boom')),
    };
    const events: string[] = [];
    const cache = createScopedCache(raw, epochOf('e1'), {
      deploymentId: 'dep-1',
      onEvent: (c) => events.push(c),
    });
    expect((await cache.get(ctx, key)).hit).toBeNull();
    expect(
      await cache.set(ctx, key, meta('{}', Date.now()), { expectedVersion: 'e1', origin: okMeta }),
    ).toBe('error');
    await expect(cache.delete(ctx, key)).resolves.toBeUndefined();
    expect(events).toEqual(['cache_error', 'cache_error', 'cache_error']);
  });

  it('a throwing telemetry sink does not fail the request', async () => {
    const cache = createScopedCache(memoryCache(), epochOf('e1'), {
      deploymentId: 'dep-1',
      onEvent: () => {
        throw new Error('sink down');
      },
    });
    await expect(cache.get(ctx, key)).resolves.toEqual({ hit: null, version: 'e1' });
    await expect(
      cache.set(ctx, key, meta('{}', Date.now()), { expectedVersion: 'e1', origin: okMeta }),
    ).resolves.toBe('stored');
  });

  it('emits hit, miss and stale codes', async () => {
    const h = harness();
    await h.cache.get(ctx, key);
    await fillMeta(h, '{}');
    await h.cache.get(ctx, key);
    h.clock.t = T0 + 400_000;
    await h.cache.get(ctx, key, { upstream: { kind: 'transient' } });
    expect(h.events).toEqual(['cache_miss', 'cache_hit', 'cache_stale']);
  });

  it('delete removes the epoch-bound entry', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    await h.cache.delete(ctx, key);
    expect(h.raw.store.size).toBe(0);
  });
});

describe('scoped cache: stale only after transient failure', () => {
  async function stale() {
    const h = harness();
    await fillMeta(h, '{"v":1}');
    h.clock.t = T0 + 400_000;
    return h;
  }

  it('returns stale after a transient error', async () => {
    const h = await stale();
    expect((await h.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit?.state).toBe(
      'stale',
    );
  });

  it('refuses stale after 401, 403 and a bare 5xx status', async () => {
    const h = await stale();
    for (const status of [401, 403, 500, 503]) {
      expect(
        (await h.cache.get(ctx, key, { upstream: { kind: 'status', status } })).hit,
      ).toBeNull();
    }
  });

  it('refuses stale without an upstream outcome', async () => {
    const h = await stale();
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
  });

  it('refuses stale after a different grant generation', async () => {
    const h = await stale();
    h.epoch.value = 'e2';
    expect((await h.cache.get(ctx, key, { upstream: { kind: 'transient' } })).hit).toBeNull();
  });

  it('refuses stale after a removal policy change', async () => {
    const h = await stale();
    expect((await h.cache.get(ctx, key, { upstream: { kind: 'policy_removed' } })).hit).toBeNull();
  });
});

describe('scoped cache: fill origin', () => {
  it('stores metadata for authenticated authorized 2xx and 304', async () => {
    for (const status of [200, 204, 304]) {
      const h = harness();
      const origin = { status, authenticated: true, authorized: true };
      expect(await h.cache.set(ctx, key, meta('{}'), { expectedVersion: 'e1', origin })).toBe(
        'stored',
      );
    }
  });

  it.each([
    ['no origin', undefined],
    ['401', { status: 401, authenticated: true, authorized: true }],
    ['403', { status: 403, authenticated: true, authorized: true }],
    ['500', { status: 500, authenticated: true, authorized: true }],
    ['404', { status: 404, authenticated: true, authorized: true }],
    ['unauthenticated 200', { status: 200, authenticated: false, authorized: true }],
    ['unauthorized 200', { status: 200, authenticated: true, authorized: false }],
  ])('refuses metadata for %s', async (_name, origin) => {
    const h = harness();
    const result = await h.cache.set(ctx, key, meta('{}'), {
      expectedVersion: 'e1',
      ...(origin === undefined ? {} : { origin }),
    } as never);
    expect(result).toBe('refused');
    expect(h.raw.store.size).toBe(0);
  });

  it('writes negatives only for an authenticated authorized authoritative 404', async () => {
    const h = harness();
    expect(await h.cache.set(ctx, negKey, neg(), { expectedVersion: 'e1', origin: okNeg })).toBe(
      'stored',
    );
  });

  it.each([
    ['no origin', undefined],
    ['unauthenticated', { status: 404, authenticated: false, authorized: true }],
    ['unauthorized', { status: 404, authenticated: true, authorized: false }],
    ['403 masked as 404', { status: 403, authenticated: true, authorized: true }],
    ['401', { status: 401, authenticated: true, authorized: true }],
    ['transient 503', { status: 503, authenticated: true, authorized: true }],
    ['200', { status: 200, authenticated: true, authorized: true }],
  ])('refuses a negative for %s', async (_name, origin) => {
    const h = harness();
    const result = await h.cache.set(ctx, negKey, neg(), {
      expectedVersion: 'e1',
      ...(origin === undefined ? {} : { origin }),
    } as never);
    expect(result).toBe('refused');
    expect(h.raw.store.size).toBe(0);
  });

  it('refuses a mismatch between key kind and entry negative flag', async () => {
    const h = harness();
    expect(await h.cache.set(ctx, key, neg(), { expectedVersion: 'e1', origin: okNeg })).toBe(
      'refused',
    );
    expect(
      await h.cache.set(ctx, negKey, meta('{}'), { expectedVersion: 'e1', origin: okNeg }),
    ).toBe('refused');
  });
});

describe('scoped cache: credentials and size', () => {
  const run = '9f8e7d6c5b4a39281706';
  it.each([
    ['https user:pass', '{"url":"https://user:s3cretpw@repo.example/d.zip"}'],
    ['git+https user:pass', '{"url":"git+https://u:t0ken@host.example/r.git"}'],
    ['protocol-relative user:pass', '{"url":"//user:pass@host.example/d.zip"}'],
    ['token-shaped username', `{"url":"https://${run}abcdef@host.example/d.zip"}`],
    ['prefixed username', '{"url":"https://ghp_abcdefghijklmnop1234@host.example/d.zip"}'],
    ['escaped slashes', '{"url":"https:\\/\\/user:tok@host.example\\/d.zip"}'],
    ['escaped at sign', '{"url":"https://user:tok\\u0040host.example/d.zip"}'],
    ['escaped question mark', '{"url":"https://r.example/d\\u003ftoken=abcdefgh12"}'],
    ['non-JSON escaped slashes', 'u: https:\\/\\/user:tok@host.example\\/d.zip'],
    ['non-JSON escaped at', 'u: https://user:tok\\u0040host.example/d.zip'],
    ['token query', '{"url":"https://repo.example/d.zip?token=abc12345"}'],
    ['non-JSON token query', 'see https://repo.example/d.zip?x=1&token=abc12345'],
    ['access_token query', '{"u":"https://r.example/d?access_token=zzzzzzzz"}'],
    ['access-token query', '{"u":"https://r.example/d?access-token=zzzzzzzz"}'],
    ['private_token query', '{"u":"https://r.example/d?private_token=zzzzzzzz"}'],
    ['api_key query', '{"u":"https://r.example/d?API_KEY=zzzzzzzz"}'],
    ['apikey query', '{"u":"https://r.example/d?apikey=zzzzzzzz"}'],
    ['client_secret query', '{"u":"https://r.example/d?client_secret=zzzzzzzz"}'],
    ['password query', '{"u":"https://r.example/d?password=zzzzzzzz"}'],
    ['jwt query', '{"u":"https://r.example/d?jwt=zzzzzzzz"}'],
    ['sig query', '{"u":"https://r.example/d?sig=zzzzzzzz"}'],
    ['signature query', '{"u":"https://r.example/d?Signature=zzzzzzzz"}'],
    ['x-amz-signature', '{"u":"https://s3.example/o?X-Amz-Signature=deadbeef"}'],
    ['x-amz-credential', '{"u":"https://s3.example/o?X-Amz-Credential=AKIDEXAMPLE1"}'],
    ['x-amz-security-token', '{"u":"https://s3.example/o?X-Amz-Security-Token=zzzzzzzz"}'],
    ['x-goog-signature', '{"u":"https://g.example/o?X-Goog-Signature=deadbeef"}'],
    ['x-goog-credential', '{"u":"https://g.example/o?X-Goog-Credential=svc12345"}'],
    ['awsaccesskeyid with signature', '{"u":"https://s3.example/o?AWSAccessKeyId=AK&Signature=x"}'],
    ['token in a JSON key', '{"https://r.example/d?token=abc12345":1}'],
    ['ghp_ prefix', '{"note":"use ghp_abcdefghijklmnop1234 here"}'],
    ['gho_ prefix', '{"note":"gho_abcdefghijklmnop1234"}'],
    ['ghu_ prefix', '{"note":"ghu_abcdefghijklmnop1234"}'],
    ['ghs_ prefix', '{"note":"ghs_abcdefghijklmnop1234"}'],
    ['ghr_ prefix', '{"note":"ghr_abcdefghijklmnop1234"}'],
    ['github_pat_ prefix', '{"note":"github_pat_abcdefghijklmnop1234"}'],
    ['glpat- prefix', '{"note":"glpat-abcdefghijklmnop1234"}'],
    ['npm_ prefix', '{"note":"npm_abcdefghijklmnop1234"}'],
    ['AKIA key id', '{"note":"AKIAABCDEFGHIJKLMNOP"}'],
    ['ASIA key id', '{"note":"ASIAABCDEFGHIJKLMNOP"}'],
    ['bearer header', 'Authorization: Bearer abc123def456ghi789'],
    ['bearer in JSON', '{"h":"Bearer abc123def456ghi789jkl"}'],
    ['token scheme', '{"h":"Authorization: token abc123def456ghi789"}'],
    ['basic header', '{"h":"Basic dXNlcjpwYXNzd29yZA=="}'],
  ])('refuses and never stores: %s', async (_name, text) => {
    const h = harness();
    expect(await fillMeta(h, text)).toBe('refused');
    expect(h.raw.store.size).toBe(0);
    expect(h.events).toContain('fill_refused');
  });

  it('stores benign payloads byte for byte', async () => {
    const texts = [
      '{"description":"Authorization library","token":"","secret":null,"password":""}',
      '{"url":"https://repo.example/d.zip?ref=abc"}',
      '{"url":"https://repo.example/d.zip?sha=abc"}',
      '{"url":"https://repo.example/d.zip?key=zzzzzzzzzz&auth=zzzzzzzzzz"}',
      '{"url":"https://repo.example/d.zip?token=short"}',
      '{"description":"Basic usage and bearer tokens explained"}',
      '{"description":"Provides basic configuration."}',
      '{"description":"Basic HTTP-client wrapper"}',
      '{"description":"Send Authorization: Bearer YOUR_TOKEN"}',
      '{"description":"token configuration-management-system."}',
      '{"description":"Basic YWJjZGVmZ2hpamtsbW5v"}',
      '{"url":"https://repo.example/a/b@1.0.0.zip"}',
      '{"url":"ssh://git@host.example/r.git"}',
      '{"url":"git+ssh://git@host.example/r.git"}',
      '{"url":"git@host.example:vendor/r.git"}',
      '{"description":"npm_scripts and ghp_ prefixes explained"}',
    ];
    for (const text of texts) {
      const h = harness();
      expect(await fillMeta(h, text), text).toBe('stored');
      expect(storedText(h)).toBe(text);
    }
  });

  it('scans adversarial 1 MiB payloads in linear time', async () => {
    const n = MAX_ENTRY_BYTES;
    const payloads = [
      'a'.repeat(n),
      '/'.repeat(n),
      '//a'.repeat(n / 3),
      '&a'.repeat(n / 2),
      '?a=&'.repeat(n / 4),
      'token '.repeat(n / 6),
      'bearer ' + 'a'.repeat(n - 7),
      ' '.repeat(n),
      '\\u00'.repeat(n / 4),
      '['.repeat(n / 2),
    ];
    const started = performance.now();
    for (const text of payloads) {
      const h = harness();
      await h.cache.set(ctx, key, meta(text.slice(0, n)), {
        expectedVersion: 'e1',
        origin: okMeta,
      });
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('refuses a stored-shape entry with wrong field types without throwing', async () => {
    const h = harness();
    const bad = [
      { ...meta('{}'), value: 'text' },
      { ...meta('{}'), freshUntil: 5 },
      { ...meta('{}'), staleUntil: 7 },
      { ...meta('{}'), negative: 'no' },
    ];
    for (const entry of bad) {
      const r = await h.cache.set(ctx, key, entry as unknown as CacheEntry, {
        expectedVersion: 'e1',
        origin: okMeta,
      });
      expect(r).toBe('refused');
    }
  });

  it('treats an insertedAt in the future beyond skew as corrupt', async () => {
    const h = harness();
    await fillMeta(h, '{}');
    const [id] = [...h.raw.store.keys()];
    const stored = h.raw.store.get(id ?? '');
    const tamper = (ms: number) =>
      h.raw.store.set(id ?? '', {
        ...stored,
        insertedAt: new Date(T0 + ms).toISOString(),
      } as CacheEnvelope);
    tamper(120_000);
    expect((await h.cache.get(ctx, key)).hit).toBeNull();
    expect(h.events).toContain('corrupt_entry');
    tamper(30_000);
    expect((await h.cache.get(ctx, key)).hit?.state).toBe('fresh');
  });

  it('refuses an entry larger than 1 MiB and accepts exactly 1 MiB', async () => {
    const h = harness();
    const fill = (n: number) =>
      h.cache.set(ctx, key, defaultEntry('metadata', new Uint8Array(n).fill(97), new Date(T0)), {
        expectedVersion: 'e1',
        origin: okMeta,
      });
    expect(await fill(MAX_ENTRY_BYTES + 1)).toBe('refused');
    expect(await fill(MAX_ENTRY_BYTES)).toBe('stored');
  });
});

describe('scoped cache: principal independence', () => {
  const catalogue = JSON.stringify({ 'vendor/a': 1, 'vendor/b': 2 });

  it('serves identical bytes to two users in one project; filtering happens after the read', async () => {
    const h = harness();
    await fillMeta(h, catalogue);
    const allowed: Record<string, readonly string[]> = { alice: ['vendor/a'], bob: ['vendor/b'] };
    const view = async (user: string) => {
      const { hit } = await h.cache.get(ctx, key);
      const all = JSON.parse(dec.decode(hit?.entry.value)) as Record<string, number>;
      return Object.keys(all).filter((name) => allowed[user]?.includes(name));
    };
    expect(await view('alice')).toEqual(['vendor/a']);
    expect(await view('bob')).toEqual(['vendor/b']);
    expect(h.raw.store.size).toBe(1);
  });

  it('stores the same bytes whichever user performed the fill', async () => {
    const byAlice = harness();
    const byBob = harness();
    await fillMeta(byAlice, catalogue);
    await fillMeta(byBob, catalogue);
    expect(storedText(byAlice)).toBe(storedText(byBob));
    expect([...byAlice.raw.store.keys()]).toEqual([...byBob.raw.store.keys()]);
  });

  it('rejects any principal field smuggled into the key', async () => {
    const h = harness();
    for (const field of ['userId', 'user', 'principal', 'token', 'authorization', 'cookie']) {
      const smuggled = { ...key, [field]: 'x' } as unknown as CacheKey;
      expect((await h.cache.get(ctx, smuggled)).hit).toBeNull();
      expect(
        await h.cache.set(ctx, smuggled, meta('{}'), { expectedVersion: 'e1', origin: okMeta }),
      ).toBe('refused');
    }
    expect(h.raw.store.size).toBe(0);
  });
});
