import { repositoryListingEvidence } from '../../internal/composer-repository-listing.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../platform/jobs.js';
import { createSourceSyncJob, type SourceSyncDeps } from '../source-sync-job.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { bindCredential, parseCredentialMaterial } from '../../sources/credentials.js';
import { createPolicyFetch } from '../../sources/policy-fetch.js';
import type { ProviderContext, ProviderSource } from '../../sources/provider.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import type { CatalogueWriteGuard } from '../../db/catalogue.js';
import type { CoreBlobStore as BlobStore } from '../../platform/blob.js';
import { fetchAndVerifyDist, type DistFetchDeps } from '../dist-fetch.js';
import { createComposerRepositoryProvider } from './composer-repository.js';

const BASE = 'https://composer.example.com';
const DIST = 'https://dist.example.com';
const NAME = 'acme/widget';
const policy = createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] });
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let resolve!: (value: Record<A, Uint8Array>) => void;
    const digests = new Promise<Record<A, Uint8Array>>((done) => {
      resolve = done;
    });
    return {
      digests,
      transform: new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const [, digest] of hashes) digest.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          resolve(
            Object.fromEntries(
              hashes.map(([alg, digest]) => [alg, new Uint8Array(digest.digest())]),
            ) as Record<A, Uint8Array>,
          );
        },
      }),
    };
  },
};
const version = {
  name: NAME,
  version: '1.0.0',
  version_normalized: '1.0.0.0',
  dist: { type: 'zip', url: `${DIST}/widget.zip`, reference: 'abc', shasum: '' },
};
function setup(root: unknown, extra: Record<string, unknown> = {}) {
  const calls: Request[] = [];
  const routes: Record<string, unknown> = { [`${BASE}/packages.json`]: root, ...extra };
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const body = routes[request.url];
      return body instanceof Response
        ? body.clone()
        : Response.json(body ?? {}, { status: body === undefined ? 404 : 200 });
    },
  });
  const source: ProviderSource & { type: 'composer_repository' } = {
    id: 'source',
    type: 'composer_repository',
    ecosystem: 'composer',
    providerId: 'composer-repository',
    url: BASE,
    config: {
      selection: { packages: [NAME], patterns: ['other/*'], expandPatterns: false },
      distHosts: ['dist.example.com'],
      mirrorsFallback: false,
    },
  };
  const ctx: ProviderContext = {
    org: orgContext('org'),
    fetch,
    credential: null,
    codecs: codecs as Codecs,
    clock: fixedClock('2026-10-23T10:00:00Z'),
    signal: new AbortController().signal,
    observability: { log() {}, counter() {}, histogram() {} },
  };
  return { provider: createComposerRepositoryProvider(policy), ctx, source, calls, routes };
}

afterEach(() => vi.restoreAllMocks());

describe('Composer repository provider', () => {
  it('lists v2 availability and expands minified stable and dev metadata', async () => {
    const t = setup(
      {
        'metadata-url': '/p2/%package%.json',
        'available-packages': [NAME, 'ignored/package'],
        'available-package-patterns': ['other/*'],
      },
      {
        [`${BASE}/p2/${NAME}.json`]: {
          minified: 'composer/2.0',
          packages: { [NAME]: [version, { version: '1.1.0', version_normalized: '1.1.0.0' }] },
        },
        [`${BASE}/p2/${NAME}~dev.json`]: {
          packages: {
            [NAME]: [{ ...version, version: 'dev-main', version_normalized: 'dev-main' }],
          },
        },
      },
    );
    expect((await t.provider.listPackages!(t.ctx, t.source, null)).names).toContain(NAME);
    const result = await t.provider.describe(t.ctx, t.source, NAME, {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected package');
    const members = [];
    for await (const member of result.description.members) members.push(JSON.parse(member.raw));
    expect(members.map((member) => member.version)).toEqual(['1.0.0', '1.1.0', 'dev-main']);
    expect(members[1].dist).toEqual(version.dist);
    expect(result.description.upstreamComplete).toBe(true);
    expect((await t.provider.describe(t.ctx, t.source, 'ignored/package', {})).kind).toBe(
      'not_found',
    );
  });

  it('uses available-package-patterns for selected names without enumerating patterns as names', async () => {
    const name = 'other/widget';
    const t = setup(
      { 'metadata-url': '/p2/%package%.json', 'available-package-patterns': ['other/*'] },
      {
        [`${BASE}/p2/${name}.json`]: { packages: { [name]: [{ ...version, name }] } },
        [`${BASE}/p2/${name}~dev.json`]: { packages: { [name]: [] } },
      },
    );
    const result = await t.provider.describe(t.ctx, t.source, name, {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected package');
    const members = [];
    for await (const member of result.description.members) members.push(member.version);
    expect(members).toEqual(['1.0.0']);
    t.calls.length = 0;
    expect(await t.provider.describe(t.ctx, t.source, NAME, {})).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(t.calls.map((call) => call.url)).toEqual([`${BASE}/packages.json`]);
    expect((await t.provider.listPackages!(t.ctx, t.source, null)).names).not.toContain('other/*');
  });

  it.each([
    { 'metadata-url': '/p2/%package%.json', 'available-packages': ['other/present'] },
    { packages: { 'other/present': { '1.0.0': { ...version, name: 'other/present' } } } },
  ])('does not list configured candidates as upstream presence: %j', async (root) => {
    const t = setup(root);
    expect((await t.provider.listPackages!(t.ctx, t.source, null)).names).toEqual([
      'other/present',
    ]);
  });

  it.each([
    { 'metadata-url': '/p2/%package%.json' },
    { 'metadata-url': '/p2/%package%.json', 'available-package-patterns': ['other/*'] },
    { 'providers-lazy-url': '/p/%package%.json' },
    { 'providers-url': '/p/%package%$%hash%.json', 'providers-lazy-url': '/p/%package%.json' },
  ])(
    'refreshes selection without authorizing removals for a non-enumerable repository %j',
    async (root) => {
      const t = setup(root);
      const enqueue = vi.fn(async () => ({ id: 'queued', created: true }));
      const finalize = vi.fn(async () => ({ status: 'complete' as const }));
      const markListing = vi.fn();
      const abandon = vi.fn(async () => true);
      const deps = {
        sources: {
          get: async () => ({ ...t.source, status: 'active', credentialId: null }),
          pollState: vi.fn(async () => 'written'),
        },
        providers: { forSource: () => t.provider },
        toProviderSource: () => t.source,
        providerContext: () => t.ctx,
        sessions: {
          acquire: async () => ({
            id: 'session',
            generation: 1,
            stamp: null,
            cursor: null,
            pagesSoFar: 0,
            snapshotId: null,
            seenCount: 0,
          }),
          start: async () => true,
          advance: async () => ({ seenCount: 0, pagesSoFar: 1 }),
          abandon,
          release: async () => true,
        },
        writer: { openListing: async () => ({ stamp: 'stamp' }), markListing },
        finalizer: { finalize },
        existingKeys: async () => new Set([NAME, 'other/removed']),
        staleHeldKeys: async () => ({ keys: [], next: null }),
        markedCount: async () => 1,
        unseenExistingCount: async () => 1,
        writeGuard: () => [],
        jobGuard: () => ({}),
      } as unknown as SourceSyncDeps;
      const job = createSourceSyncJob(deps);
      await job.handler({ sourceId: t.source.id, reason: 'poll' }, {
        org: t.ctx.org,
        signal: t.ctx.signal,
        observability: t.ctx.observability,
        ports: { platform: { jobs: { enqueue } } },
      } as unknown as JobContext);
      expect(enqueue).toHaveBeenCalledWith(
        t.ctx.org,
        'core:package-sync:v1',
        {
          sourceId: t.source.id,
          key: NAME,
          syncGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        expect.anything(),
      );
      expect(markListing).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(abandon).toHaveBeenCalled();
      expect(deps.sources.pollState).toHaveBeenCalledWith(t.ctx.org, expect.anything(), {
        id: t.source.id,
        outcome: 'success',
      });
    },
  );

  it.each([429, 404])('does not sleep on request-path metadata status %s', async (status) => {
    const t = setup(
      { 'metadata-url': '/p2/%package%.json', 'available-packages': [NAME] },
      {
        [`${BASE}/p2/${NAME}.json`]: new Response('{}', {
          status,
          headers: { 'retry-after': '1' },
        }),
      },
    );
    t.ctx = {
      ...t.ctx,
      credential: bindCredential(parseCredentialMaterial('bearer', '{"token":"secret-token"}'), [
        BASE,
      ]),
    };
    const sleeps: number[] = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...parameters: Parameters<typeof setTimeout>
    ) => {
      const [callback, ms, ...args] = parameters;
      if (ms === 1000 || ms === 1500) {
        sleeps.push(ms);
        return schedule(callback, 0, ...args);
      }
      return schedule(callback, ms, ...args);
    }) as typeof setTimeout);
    if (status === 429)
      await expect(t.provider.describe(t.ctx, t.source, NAME, {})).rejects.toMatchObject({
        retryAfterSeconds: 1,
      });
    else
      expect(await t.provider.describe(t.ctx, t.source, NAME, {})).toEqual({
        kind: 'not_found',
        definitive: false,
      });
    expect(sleeps).toEqual([]);
    expect(t.calls.filter((call) => call.url === `${BASE}/p2/${NAME}.json`)).toHaveLength(1);
  });

  it.each([
    { 'providers-lazy-url': '/p/%package%.json' },
    { 'providers-url': '/p/%package%$%hash%.json', 'providers-lazy-url': '/p/%package%.json' },
  ])('never treats a lazy v1 index as a complete enumeration: %j', async (root) => {
    const t = setup(root);
    const listing = await t.provider.listPackages!(t.ctx, t.source, null);
    expect(repositoryListingEvidence(listing)).toMatchObject({ enumerable: false });
    expect(listing.names).toEqual([]);
  });

  it.each(['v2', 'inline', 'providers'] as const)(
    'filters %s listing names before the sync fan-out budget is spent',
    async (mode) => {
      const names = [
        ...Array.from({ length: 150 }, (_, i) => `ignored/p${i}`),
        NAME,
        'other/widget',
      ];
      const include = JSON.stringify({
        providers: Object.fromEntries(names.map((name) => [name, { sha256: '1'.repeat(64) }])),
      });
      const root =
        mode === 'v2'
          ? { 'metadata-url': '/p2/%package%.json', 'available-packages': names }
          : mode === 'inline'
            ? {
                packages: Object.fromEntries(
                  names.map((name) => [name, { '1.0.0': { ...version, name } }]),
                ),
              }
            : {
                'providers-url': '/p/%package%$%hash%.json',
                'provider-includes': { 'providers.json': { sha256: hash(include) } },
              };
      const t = setup(root, { [`${BASE}/providers.json`]: new Response(include) });
      expect((await t.provider.listPackages!(t.ctx, t.source, null)).names).toEqual([
        NAME,
        'other/widget',
      ]);
    },
  );

  it('preserves the v1 parser deadline signal together with job cancellation', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const include = JSON.stringify({ providers: { [NAME]: { sha256: '1'.repeat(64) } } });
    const t = setup(
      {
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'providers.json': { sha256: hash(include) } },
      },
      { [`${BASE}/providers.json`]: new Response(include) },
    );
    const signals: AbortSignal[] = [];
    const fetch = t.ctx.fetch;
    t.ctx = {
      ...t.ctx,
      fetch: (request) => {
        if (request.url.endsWith('/providers.json') && request.signal !== undefined)
          signals.push(request.signal);
        return fetch(request);
      },
    };
    await t.provider.listPackages!(t.ctx, t.source, null);
    expect(signals).toHaveLength(1);
    deadline.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(t.ctx.signal.aborted).toBe(false);
  });

  it('reuses verified v1 indexes across sync descriptions and scopes them by root and organization', async () => {
    const other = 'other/widget';
    const bodies = {
      [NAME]: JSON.stringify({ packages: { [NAME]: { '1.0.0': version } } }),
      [other]: JSON.stringify({ packages: { [other]: { '1.0.0': { ...version, name: other } } } }),
    };
    const include = JSON.stringify({
      providers: Object.fromEntries(
        Object.entries(bodies).map(([name, body]) => [name, { sha256: hash(body) }]),
      ),
    });
    const t = setup(
      {
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'providers.json': { sha256: hash(include) } },
      },
      {
        [`${BASE}/providers.json`]: new Response(include),
        ...Object.fromEntries(
          Object.entries(bodies).map(([name, body]) => [
            `${BASE}/p/${name}%24${hash(body)}.json`,
            new Response(body),
          ]),
        ),
      },
    );
    await t.provider.listPackages!(t.ctx, t.source, null);
    for (const name of [NAME, other]) {
      const result = await t.provider.describe(t.ctx, t.source, name, {});
      expect(result.kind).toBe('found');
      if (result.kind === 'found')
        for await (const member of result.description.members) expect(member.version).toBe('1.0.0');
    }
    expect(t.calls.filter((call) => call.url.endsWith('/providers.json'))).toHaveLength(1);
    await t.provider.describe({ ...t.ctx }, t.source, NAME, {});
    expect(t.calls.filter((call) => call.url.endsWith('/providers.json'))).toHaveLength(1);
    await t.provider.describe({ ...t.ctx, org: orgContext('another-org') }, t.source, NAME, {});
    expect(t.calls.filter((call) => call.url.endsWith('/providers.json'))).toHaveLength(2);
    await t.provider.describe(t.ctx, { ...t.source, id: 'another-source' }, NAME, {});
    expect(t.calls.filter((call) => call.url.endsWith('/providers.json'))).toHaveLength(3);
    await t.provider.describe(
      t.ctx,
      {
        ...t.source,
        config: {
          ...t.source.config,
          selection: { packages: [NAME], patterns: [], expandPatterns: false },
        },
      },
      NAME,
      {},
    );
    expect(t.calls.filter((call) => call.url.endsWith('/providers.json'))).toHaveLength(4);
    t.routes[`${BASE}/packages.json`] = {
      'providers-url': '/p/%package%$%hash%.json',
      'provider-includes': { 'providers.json': { sha256: '0'.repeat(64) } },
    };
    await expect(t.provider.describe(t.ctx, t.source, NAME, {})).rejects.toMatchObject({
      code: 'network',
    });
    t.routes[`${BASE}/packages.json`] = new Response(null, { status: 401 });
    await expect(t.provider.describe(t.ctx, t.source, NAME, {})).rejects.toMatchObject({
      code: 'http_status',
      status: 401,
    });
  });

  it('refuses an incomplete v1 index instead of publishing an empty listing', async () => {
    const t = setup(
      {
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'providers.json': { sha256: '0'.repeat(64) } },
      },
      {
        [`${BASE}/providers.json`]: { providers: { [NAME]: { sha256: '1'.repeat(64) } } },
      },
    );
    await expect(t.provider.listPackages!(t.ctx, t.source, null)).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('reads verified v1 provider-includes and provider files', async () => {
    const body = JSON.stringify({ packages: { [NAME]: { '1.0.0': version } } });
    const include = JSON.stringify({ providers: { [NAME]: { sha256: hash(body) } } });
    const t = setup(
      {
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'p/providers.json': { sha256: hash(include) } },
      },
      {
        [`${BASE}/p/providers.json`]: new Response(include),
        [`${BASE}/p/${NAME}%24${hash(body)}.json`]: new Response(body),
      },
    );
    expect((await t.provider.listPackages!(t.ctx, t.source, null)).names).toContain(NAME);
    const result = await t.provider.describe(t.ctx, t.source, NAME, {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected package');
    const members = [];
    for await (const member of result.description.members) members.push(member.version);
    expect(members).toEqual(['1.0.0']);
    expect(result.description.upstreamComplete).toBe(true);
  });

  it('reads inline packages and applies selection before fetching metadata', async () => {
    const t = setup({
      packages: {
        [NAME]: { '1.0.0': version },
        'other/thing': { '1.0.0': { ...version, name: 'other/thing' } },
      },
    });
    const result = await t.provider.describe(t.ctx, t.source, NAME, {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected package');
    const members = [];
    for await (const member of result.description.members) members.push(member.version);
    expect(members).toEqual(['1.0.0']);
    t.calls.length = 0;
    expect(await t.provider.describe(t.ctx, t.source, 'ignored/package', {})).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ['http_basic', { username: 'user', password: 'secret-password' }, 'authorization'],
    ['bearer', { token: 'secret-token' }, 'authorization'],
    ['header', { name: 'x-api-key', value: 'secret-key' }, 'x-api-key'],
  ] as const)(
    'scopes %s credentials to the repository and allowed dist hosts',
    async (kind, material, header) => {
      const t = setup(
        { packages: {} },
        {
          [`${DIST}/widget.zip`]: new Response(null, {
            status: 302,
            headers: { location: 'https://foreign.example.com/stolen.zip' },
          }),
        },
      );
      t.ctx = {
        ...t.ctx,
        credential: bindCredential(parseCredentialMaterial(kind, JSON.stringify(material)), [
          BASE,
          DIST,
        ]),
      };
      await t.provider.listPackages!(t.ctx, t.source, null);
      await expect(
        t.provider.openDist(t.ctx, t.source, {
          packageName: NAME,
          version: '1.0.0',
          url: `${DIST}/widget.zip`,
          distType: 'zip',
          sourceRef: 'abc',
        }),
      ).rejects.toMatchObject({ code: 'refused' });
      expect(t.calls[0]!.headers.get(header)).toBeTruthy();
      expect(t.calls[1]!.headers.get(header)).toBeTruthy();
      expect(t.calls.some((call) => call.url.includes('foreign.example.com'))).toBe(false);
    },
  );

  it('refuses unlisted dist hosts through policy fetch', async () => {
    const t = setup({ packages: {} });
    await expect(
      t.provider.openDist(t.ctx, t.source, {
        packageName: NAME,
        version: '1.0.0',
        url: 'https://foreign.example.com/a.zip',
        distType: 'zip',
        sourceRef: null,
      }),
    ).rejects.toMatchObject({ code: 'refused', reason: 'destination' });
    expect(t.calls).toHaveLength(0);
  });

  it('keeps the archive failure when the mirror fallback root is over its cap, and quarantines nothing', async () => {
    const t = setup(new Response('{}', { headers: { 'content-length': String(2 ** 40) } }), {
      [`${DIST}/widget.zip`]: new Response('unavailable', { status: 503 }),
    });
    t.source = { ...t.source, config: { ...t.source.config, mirrorsFallback: true } };
    const target = {
      packageName: NAME,
      version: '1.0.0',
      url: `${DIST}/widget.zip`,
      distType: 'zip' as const,
      sourceRef: 'abc',
    };
    await expect(t.provider.openDist(t.ctx, t.source, target)).rejects.toMatchObject({
      code: 'http_status',
      status: 503,
    });
    expect(t.calls.some((call) => call.url === `${BASE}/packages.json`)).toBe(true);

    const writes: string[] = [];
    const deps: DistFetchDeps = {
      provider: t.provider,
      providerContext: t.ctx,
      source: t.source,
      store: {
        put: async () => {
          writes.push('put');
          throw new Error('unreachable');
        },
      } as unknown as BlobStore,
      writer: {
        attachDist: async () => {
          writes.push('attach');
          return { changed: true, statements: 1 };
        },
        quarantine: async () => {
          writes.push('quarantine');
          return { changed: true, statements: 1 };
        },
      },
      blobReplacer: {
        replaceBlob: async () => {
          writes.push('replace');
          return { changed: true, statements: 1 };
        },
      },
      maxBytes: 1024,
    };
    await expect(
      fetchAndVerifyDist(deps, orgContext('org'), [] as unknown as CatalogueWriteGuard, {
        versionId: 'v1',
        revision: 1,
        packageName: NAME,
        version: '1.0.0',
        previousBlob: null,
        fetch: {
          sourceRef: 'abc',
          upstreamDistUrl: `${DIST}/widget.zip`,
          distType: 'zip',
          composerShasum: null,
          npmIntegrity: null,
          npmShasum: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'http_status', status: 503 });
    expect(writes).toEqual([]);
  });

  it.each([false, true])('uses root mirrors only with mirrorsFallback=%s', async (enabled) => {
    const t = setup(
      {
        packages: {},
        mirrors: [
          { 'dist-url': `${DIST}/%package%/%version%/%reference%.%type%`, preferred: true },
        ],
      },
      {
        [`${DIST}/${NAME}/1.0.0/abc.zip`]: new Response('archive'),
      },
    );
    t.source = { ...t.source, config: { ...t.source.config, mirrorsFallback: enabled } };
    const opened = t.provider.openDist(t.ctx, t.source, {
      packageName: NAME,
      version: '1.0.0',
      url: `${DIST}/missing.zip`,
      distType: 'zip',
      sourceRef: 'abc',
    });
    if (enabled) expect(await new Response((await opened).body).text()).toBe('archive');
    else await expect(opened).rejects.toMatchObject({ code: 'http_status', status: 404 });
    expect(t.calls.some((call) => call.url.endsWith('/abc.zip'))).toBe(enabled);
  });
});
