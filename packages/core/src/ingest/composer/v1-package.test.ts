import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import type { ComposerVersionOrigin } from '../../registry/composer/version-object.js';
import type { DescribeResult, VersionCandidate } from '../../sources/provider.js';
import { createPolicyFetch, type PolicyFetch } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { readComposerRoot, type ComposerRoot, type ComposerRootSource } from './root.js';
import { documentKey, readV1Index, type V1IndexEntry } from './v1-index.js';
import { ComposerV1PackageError, describeComposerV1, type V1PackageOptions } from './v1-package.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const BASE = 'https://repo.example.com';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let settle!: { resolve(v: never): void; reject(e: unknown): void };
    const digests = new Promise<Record<A, Uint8Array>>((resolve, reject) => {
      settle = { resolve: resolve as (v: never) => void, reject };
    });
    digests.catch(() => undefined);
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const [, h] of hashes) h.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        settle.resolve(
          Object.fromEntries(hashes.map(([alg, h]) => [alg, new Uint8Array(h.digest())])) as never,
        );
      },
      cancel(reason) {
        settle.reject(reason);
      },
    });
    return { transform, digests };
  },
};
const origin: ComposerVersionOrigin = {
  probe: { secrets: ['s3cr3t-token-value'], queryParams: ['access_token'] },
  importedAt: '2026-10-16T08:00:00.000Z',
};
const source: ComposerRootSource = { url: BASE, policy, allowedOrigins: [] };
const selection = { packages: ['acme/listed'], patterns: ['lazy/*'], expandPatterns: false };

function root(overrides: Partial<ComposerRoot> = {}): ComposerRoot {
  return {
    mode: 'v1-providers',
    packagesJsonUrl: `${BASE}/packages.json`,
    providersUrl: `${BASE}/p/%package%$%hash%.json`,
    inlineProviders: false,
    inlinePackages: false,
    partialPackages: false,
    validator: { sha256: '0'.repeat(64) },
    messages: [],
    mirrors: [],
    ...overrides,
  };
}

function setup(routes: Record<string, (count: number) => string | Response>) {
  const requests: string[] = [];
  const counts = new Map<string, number>();
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      const count = (counts.get(url) ?? 0) + 1;
      counts.set(url, count);
      const route = routes[url];
      if (route === undefined) return new Response('missing', { status: 404 });
      const body = route(count);
      return body instanceof Response ? body : new Response(body, { status: 200 });
    },
  });
  return { requests, fetch };
}

function version(name: string, v: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    version: v,
    version_normalized: `${v}.0`,
    dist: { type: 'zip', url: `${BASE}/dist/${name}/${v}.zip`, reference: 'abc', shasum: '' },
    ...extra,
  };
}

const providerUrl = (name: string, hash: string): string => `${BASE}/p/${name}%24${hash}.json`;

function options(name: string, hash: string, extra: Partial<V1PackageOptions> = {}) {
  return {
    source,
    root: root(),
    origin,
    codecs,
    selection,
    entry: { kind: 'provider' as const, sha256: hash },
    ...extra,
  } satisfies V1PackageOptions;
}

async function members(result: DescribeResult): Promise<VersionCandidate[]> {
  if (result.kind !== 'found') throw new Error(`expected found, got ${result.kind}`);
  const out: VersionCandidate[] = [];
  for await (const member of result.description.members) out.push(member);
  expect(result.description.upstreamComplete).toBe(true);
  return out;
}

describe('describeComposerV1 provider files', () => {
  it('ingests owner objects only across 636 files where 38 carry foreign objects', async () => {
    const routes: Record<string, (count: number) => string> = {};
    const owners: { name: string; hash: string; own: number }[] = [];
    for (let i = 0; i < 636; i += 1) {
      const name = `magento/module-${i}`;
      const own = (i % 5) + 1;
      const packages: Record<string, Record<string, unknown>> = { [name]: {} };
      for (let v = 1; v <= own; v += 1) packages[name]![`${v}.0.0`] = version(name, `${v}.0.0`);
      if (i < 38) {
        packages[name]!['9.9.9'] = version('amzn/amazon-pay-module', '9.9.9');
        packages['dotmailer/extension'] = { '1.0.0': version('dotmailer/extension', '1.0.0') };
        packages[`magento/module-${i + 1}`] = {
          '1.0.0': version(`magento/module-${i + 1}`, '1.0.0'),
        };
      }
      const body = JSON.stringify({ packages });
      const hash = sha256(body);
      routes[providerUrl(name, hash)] = () => body;
      owners.push({ name, hash, own });
    }
    const { fetch } = setup(routes);
    let foreignSkipped = 0;
    for (const { name, hash, own } of owners) {
      const result = await describeComposerV1(fetch, name, options(name, hash));
      const found = await members(result);
      expect(found.map((m) => (JSON.parse(m.raw) as { name: string }).name)).toEqual(
        Array(own).fill(name),
      );
      if (result.kind === 'found') foreignSkipped += result.skipped.foreign_name ?? 0;
    }
    expect(foreignSkipped).toBe(38 * 3);
  });

  it('takes versions by the object name, not by the packages key', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/other': { '2.0.0': version('Acme/Owner', '2.0.0') },
        'acme/owner': {
          '1.0.0': version('acme/owner', '1.0.0'),
          '2.0.0': version('acme/owner', '2.0.0'),
        },
      },
    });
    const hash = sha256(body);
    const { fetch } = setup({ [providerUrl('acme/owner', hash)]: () => body });
    const found = await members(
      await describeComposerV1(fetch, 'acme/owner', options('acme/owner', hash)),
    );
    expect(found.map((m) => [m.ordinal, m.version])).toEqual([
      [0, '2.0.0'],
      [1, '1.0.0'],
    ]);
  });

  it('never yields uid or notification-url', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/owner': {
          '1.0.0': version('acme/owner', '1.0.0', { uid: 42, 'notification-url': `${BASE}/n` }),
        },
      },
    });
    const hash = sha256(body);
    const { fetch } = setup({ [providerUrl('acme/owner', hash)]: () => body });
    const [member] = await members(
      await describeComposerV1(fetch, 'acme/owner', options('acme/owner', hash)),
    );
    expect(member!.raw).not.toContain('uid');
    expect(member!.raw).not.toContain('notification-url');
  });

  it('retries a sha256 mismatch and accepts a matching third attempt', async () => {
    const body = JSON.stringify({
      packages: { 'acme/owner': { '1.0.0': version('acme/owner', '1.0.0') } },
    });
    const hash = sha256(body);
    const url = providerUrl('acme/owner', hash);
    const { fetch, requests } = setup({ [url]: (n) => (n < 3 ? '{"packages":{}}' : body) });
    const found = await members(
      await describeComposerV1(fetch, 'acme/owner', options('acme/owner', hash)),
    );
    expect(found).toHaveLength(1);
    expect(requests).toEqual([url, url, url]);
  });

  it('fails with a typed error after three sha256 mismatches', async () => {
    const hash = 'a'.repeat(64);
    const url = providerUrl('acme/owner', hash);
    const { fetch, requests } = setup({ [url]: () => '{"packages":{}}' });
    const error = await describeComposerV1(fetch, 'acme/owner', options('acme/owner', hash)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ComposerV1PackageError);
    expect((error as ComposerV1PackageError).code).toBe('hash');
    expect(requests).toEqual([url, url, url]);
  });

  it('answers not_modified for an unchanged listed hash without a request', async () => {
    const hash = 'b'.repeat(64);
    const { fetch, requests } = setup({});
    const result = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { previousSha256: hash }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
    expect(requests).toEqual([]);
  });

  it('refuses names outside the Composer grammar before any request', async () => {
    const { fetch, requests } = setup({});
    for (const name of [
      'acme/../x',
      'acme/x?y=1',
      'acme',
      '-acme/x',
      'acme/x#y',
      'acme/x/../../y',
    ]) {
      const error = await describeComposerV1(fetch, name, options(name, 'c'.repeat(64))).catch(
        (e: unknown) => e,
      );
      expect((error as ComposerV1PackageError).code).toBe('name');
    }
    expect(requests).toEqual([]);
  });

  it('refuses a listed hash that is not sha256 hex before any request', async () => {
    const { fetch, requests } = setup({});
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', '../../etc'),
    ).catch((e: unknown) => e);
    expect((error as ComposerV1PackageError).code).toBe('invalid');
    expect(requests).toEqual([]);
  });

  it('treats a 404 for a listed provider file as a non-definitive not_found', async () => {
    const { fetch } = setup({});
    const result = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', 'd'.repeat(64)),
    );
    expect(result).toEqual({ kind: 'not_found', definitive: false });
  });

  it('rejects a body that is not a provider document', async () => {
    const body = '{"packages":["x"]}';
    const hash = sha256(body);
    const { fetch } = setup({ [providerUrl('acme/owner', hash)]: () => body });
    const error = await describeComposerV1(fetch, 'acme/owner', options('acme/owner', hash)).catch(
      (e: unknown) => e,
    );
    expect((error as ComposerV1PackageError).code).toBe('invalid');
  });

  it('answers not_found for a name absent from the index without a request', async () => {
    const { fetch, requests } = setup({});
    const result = await describeComposerV1(fetch, 'acme/owner', {
      source,
      root: root(),
      origin,
      codecs,
      selection,
    });
    expect(result).toEqual({ kind: 'not_found', definitive: true });
    expect(requests).toEqual([]);
  });
});

describe('describeComposerV1 lazy providers', () => {
  const lazyRoot: { -readonly [K in keyof ComposerRoot]: ComposerRoot[K] } = {
    ...root(),
    mode: 'v1-lazy',
    providersLazyUrl: `${BASE}/lazy/%package%.json`,
  };
  delete lazyRoot.providersUrl;
  const lazyOptions = (extra: Partial<V1PackageOptions> = {}): V1PackageOptions => ({
    source,
    root: lazyRoot,
    origin,
    codecs,
    selection,
    ...extra,
  });

  it('fetches a selected name from providers-lazy-url', async () => {
    const body = JSON.stringify({
      packages: {
        'lazy/pkg': {
          '1.0.0': version('lazy/pkg', '1.0.0'),
          '2.0.0': version('other/pkg', '2.0.0'),
        },
      },
    });
    const { fetch, requests } = setup({ [`${BASE}/lazy/lazy/pkg.json`]: () => body });
    const found = await members(await describeComposerV1(fetch, 'lazy/pkg', lazyOptions()));
    expect(found.map((m) => m.version)).toEqual(['1.0.0']);
    expect(requests).toEqual([`${BASE}/lazy/lazy/pkg.json`]);
  });

  it('makes no request for a name outside the source selection', async () => {
    const { fetch, requests } = setup({});
    const result = await describeComposerV1(fetch, 'acme/unselected', lazyOptions());
    expect(result).toEqual({ kind: 'not_found', definitive: true });
    expect(requests).toEqual([]);
  });

  it('answers not_modified when the lazy body hash is unchanged', async () => {
    const body = JSON.stringify({
      packages: { 'acme/listed': { '1.0.0': version('acme/listed', '1.0.0') } },
    });
    const { fetch } = setup({ [`${BASE}/lazy/acme/listed.json`]: () => body });
    const result = await describeComposerV1(
      fetch,
      'acme/listed',
      lazyOptions({ previousSha256: sha256(body) }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
  });
});

describe('describeComposerV1 index completeness', () => {
  const listed = new Map<string, V1IndexEntry>([
    ['acme/other', { kind: 'provider', sha256: 'a'.repeat(64) }],
  ]);

  it.each([
    ['unknown index', undefined, false],
    ['incomplete empty index', { complete: false, entries: new Map() }, false],
    ['incomplete non-empty index', { complete: false, entries: listed }, false],
    ['complete empty index', { complete: true, entries: new Map() }, false],
    ['complete non-empty index', { complete: true, entries: listed }, true],
  ] as const)('answers absence from %s', async (_label, index, definitive) => {
    const { fetch, requests } = setup({});
    const result = await describeComposerV1(fetch, 'acme/listed', {
      source,
      root: root(),
      origin,
      codecs,
      selection,
      ...(index === undefined ? {} : { index }),
    });
    expect(result).toEqual({ kind: 'not_found', definitive });
    expect(requests).toEqual([]);
  });

  it.each([
    { 'providers-url': '/p/%package%$%hash%.json', 'provider-includes': {} },
    { includes: {} },
    { packages: [] },
    { packages: {} },
  ])('never proves absence from an empty upstream listing: %j', async (body) => {
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: () => JSON.stringify(body),
    });
    const result = await readV1Index(fetch, { source, codecs });
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') throw new Error('expected index');
    expect(result.index.entries.size).toBe(0);
    const before = requests.length;
    expect(
      await describeComposerV1(fetch, 'acme/listed', {
        source,
        root: result.root,
        index: result.index,
        origin,
        codecs,
        selection,
      }),
    ).toEqual({ kind: 'not_found', definitive: false });
    expect(requests).toHaveLength(before);
  });

  it('reads a provider entry from the index', async () => {
    const body = JSON.stringify({
      packages: { 'acme/listed': { '1.0.0': version('acme/listed', '1.0.0') } },
    });
    const hash = sha256(body);
    const { fetch } = setup({ [providerUrl('acme/listed', hash)]: () => body });
    const result = await describeComposerV1(fetch, 'acme/listed', {
      source,
      root: root(),
      origin,
      codecs,
      selection,
      index: {
        complete: true,
        entries: new Map([['acme/listed', { kind: 'provider', sha256: hash }]]),
      },
    });
    expect((await members(result)).map((m) => m.version)).toEqual(['1.0.0']);
  });

  it('uses lazy loading with both provider URLs and no provider listing', async () => {
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: () =>
        JSON.stringify({
          'providers-url': '/p/%package%$%hash%.json',
          'providers-lazy-url': '/lazy/%package%.json',
        }),
    });
    const lazy = await readComposerRoot(fetch, source);
    expect(
      await describeComposerV1(fetch, 'acme/listed', {
        source,
        root: lazy,
        origin,
        codecs,
        selection,
      }),
    ).toEqual({ kind: 'not_found', definitive: true });
    expect(requests).toEqual([`${BASE}/packages.json`, `${BASE}/lazy/acme/listed.json`]);
  });
});

describe('describeComposerV1 round 2', () => {
  async function describeBody(name: string, body: string, extra: Partial<V1PackageOptions> = {}) {
    const hash = sha256(body);
    const { fetch, requests } = setup({ [providerUrl(name, hash)]: () => body });
    return { result: await describeComposerV1(fetch, name, options(name, hash, extra)), requests };
  }
  const codeOf = (error: unknown): string | undefined =>
    error instanceof ComposerV1PackageError ? error.code : undefined;

  it('f12: a provider file listing other names yields the owner only', async () => {
    const one = JSON.stringify({
      packages: {
        'fx/one': { '1.0.0': version('fx/one', '1.0.0') },
        'fx/two': { '9.9.9': version('fx/two', '9.9.9') },
        'fx/ghost': { '4.0.0': version('fx/ghost', '4.0.0') },
      },
    });
    const two = JSON.stringify({ packages: { 'fx/two': { '2.0.0': version('fx/two', '2.0.0') } } });
    const first = await describeBody('fx/one', one);
    expect((await members(first.result)).map((m) => m.version)).toEqual(['1.0.0']);
    if (first.result.kind === 'found') expect(first.result.skipped.foreign_name).toBe(2);
    const second = await describeBody('fx/two', two);
    expect((await members(second.result)).map((m) => m.version)).toEqual(['2.0.0']);
    const { fetch } = setup({});
    const ghost = await describeComposerV1(fetch, 'fx/ghost', {
      source,
      root: root(),
      origin,
      codecs,
      selection,
    });
    expect(ghost).toEqual({ kind: 'not_found', definitive: true });
  });

  it('f13: the packages key differs from the version name', async () => {
    const body = JSON.stringify({
      packages: { 'fx/other-key': { '1.0.0': version('fx/key-a', '1.0.0') } },
    });
    const { result } = await describeBody('fx/key-a', body);
    expect((await members(result)).map((m) => m.version)).toEqual(['1.0.0']);
  });

  it('keeps the owner object when a foreign object with the same version comes first', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/aaa': { '1.0.0': version('acme/aaa', '1.0.0') },
        'acme/owner': { '1.0.0': version('acme/owner', '1.0.0') },
      },
    });
    const [member] = await members((await describeBody('acme/owner', body)).result);
    expect(JSON.parse(member!.raw)).toMatchObject({
      name: 'acme/owner',
      dist: { url: `${BASE}/dist/acme/owner/1.0.0.zip` },
    });
  });

  it('counts duplicate normalized owner versions', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/owner': { '1.0.0': version('acme/owner', '1.0.0') },
        'acme/alias': { '1.0.0': version('acme/owner', '1.0.0') },
      },
    });
    const { result } = await describeBody('acme/owner', body);
    expect(await members(result)).toHaveLength(1);
    if (result.kind === 'found') expect(result.skipped.duplicate).toBe(1);
  });

  it('streams a provider file above 1 MiB and emits forms evidence', async () => {
    const versions: Record<string, unknown> = {};
    for (let v = 0; v < 2000; v += 1) {
      versions[`1.0.${v}`] = version('acme/big', `1.0.${v}`, { description: 'x'.repeat(700) });
    }
    const body = JSON.stringify({ packages: { 'acme/big': versions } });
    expect(body.length).toBeGreaterThan(1024 * 1024);
    const { result } = await describeBody('acme/big', body);
    expect(await members(result)).toHaveLength(2000);
    if (result.kind !== 'found') throw new Error('expected found');
    expect(result.description.forms?.map((f) => [f.form, f.status, f.snapshot.id])).toEqual([
      ['composer-p2', 'present', `sha256:${sha256(body)}`],
      ['composer-p2-dev', 'present', `sha256:${sha256(body)}`],
    ]);
  });

  it('refuses a version object above 1 MiB without retrying', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/owner': { '1.0.0': version('acme/owner', '1.0.0', { readme: 'x'.repeat(1100000) }) },
      },
    });
    const error = await describeBody('acme/owner', body).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
  });

  it('caps the number of version objects and cancels the upstream body', async () => {
    const hash = '5'.repeat(64);
    const url = providerUrl('acme/owner', hash);
    const head = JSON.stringify({
      packages: {
        'acme/owner': {
          '1.0.0': version('acme/owner', '1.0.0'),
          '1.0.1': version('acme/owner', '1.0.1'),
        },
      },
    }).slice(0, -2);
    let cancelled = false;
    const { fetch, requests } = setup({
      [url]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(head));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { maxVersions: 1 }),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
    expect(requests).toEqual([url]);
    await expect.poll(() => cancelled).toBe(true);
  });

  it.each([
    '{}',
    '{"foo":1}',
    '{"packages":"x"}',
    '{"packages":[1]}',
    '{"packages":{"acme/owner":"x"}}',
    '{"packages":{"acme/owner":[{"name":"acme/owner"}]}}',
  ])('rejects the provider shape %s', async (body) => {
    const error = await describeBody('acme/owner', body).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('invalid');
  });

  it('accepts empty arrays as empty maps', async () => {
    const { result } = await describeBody('acme/owner', '{"packages":{"acme/owner":[]}}');
    expect(await members(result)).toEqual([]);
    const empty = await describeBody('acme/owner', '{"packages":[]}');
    expect(await members(empty.result)).toEqual([]);
  });

  it('shares one byte budget across the attempts', async () => {
    const hash = 'e'.repeat(64);
    const url = providerUrl('acme/owner', hash);
    const { fetch, requests } = setup({ [url]: () => '{"packages":{}}' });
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { maxBytes: 40 }),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
    expect(requests).toEqual([url, url, url]);
  });

  it('compares a previous hash case-insensitively', async () => {
    const hash = 'f'.repeat(64);
    const { fetch, requests } = setup({});
    const result = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { previousSha256: hash.toUpperCase() }),
    );
    expect(result).toEqual({ kind: 'not_modified' });
    expect(requests).toEqual([]);
  });

  it('refuses a template that does not resolve to a URL', async () => {
    const { fetch, requests } = setup({});
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', 'a'.repeat(64), {
        root: root({ providersUrl: 'not a url %package%' }),
      }),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('invalid');
    expect(requests).toEqual([]);
  });

  it('stops at the shared deadline after a hash mismatch', async () => {
    const hash = '1'.repeat(64);
    const url = providerUrl('acme/owner', hash);
    const { fetch, requests } = setup({ [url]: () => '{"packages":{}}' });
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { deadlineMs: 50 }),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('deadline');
    expect(requests.length).toBeLessThan(3);
  });

  it('maps an upstream timeout past the deadline to deadline', async () => {
    const fetch = createPolicyFetch({
      policy,
      userAgent: 'pb-test/1',
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    });
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', '2'.repeat(64), { deadlineMs: 50 }),
    ).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('deadline');
  });

  it('aborts during the pause between attempts', async () => {
    const hash = '3'.repeat(64);
    const url = providerUrl('acme/owner', hash);
    const controller = new AbortController();
    const { fetch, requests } = setup({
      [url]: () => {
        setTimeout(() => controller.abort(new Error('stop')), 10);
        return '{"packages":{}}';
      },
    });
    const started = Date.now();
    const error = await describeComposerV1(
      fetch,
      'acme/owner',
      options('acme/owner', hash, { signal: controller.signal }),
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe('stop');
    expect(requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(90);
  });

  it.each([
    ['maxBytes', 0],
    ['maxVersions', 1.5],
    ['deadlineMs', -1],
    ['maxBytes', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s = %s up front', async (field, value) => {
    const { fetch, requests } = setup({});
    await expect(
      describeComposerV1(
        fetch,
        'acme/owner',
        options('acme/owner', '4'.repeat(64), { [field]: value }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(requests).toEqual([]);
  });

  it('uses the document position as the ordinal', async () => {
    const body = JSON.stringify({
      packages: {
        'acme/owner': {
          '1.0.0': version('acme/owner', '1.0.0'),
          '1.5.0': version('other/x', '1.5.0'),
          '2.0.0': version('acme/owner', '2.0.0'),
        },
      },
    });
    const found = await members((await describeBody('acme/owner', body)).result);
    expect(found.map((m) => m.ordinal)).toEqual([0, 2]);
  });
  describe('rate limiting and unsupported roots', () => {
    const hash = sha256('x');
    const limited = (headers: Record<string, string>) =>
      setup({
        [providerUrl('acme/listed', hash)]: () =>
          new Response('slow down', { status: 429, headers }),
      });
    const status = async (headers: Record<string, string>): Promise<ComposerV1PackageError> => {
      const { fetch } = limited(headers);
      const error = await describeComposerV1(
        fetch,
        'acme/listed',
        options('acme/listed', hash),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ComposerV1PackageError);
      expect(error).toMatchObject({ code: 'status', status: 429 });
      return error as ComposerV1PackageError;
    };

    it('carries the parsed Retry-After on a 429', async () => {
      expect((await status({ 'retry-after': '7' })).retryAfterSeconds).toBe(7);
    });

    it('carries Retry-After beyond 60 seconds, bounded at 86400 seconds', async () => {
      expect((await status({ 'retry-after': '61' })).retryAfterSeconds).toBe(61);
      expect((await status({ 'retry-after': '86400' })).retryAfterSeconds).toBe(86400);
      expect((await status({ 'retry-after': '86401' })).retryAfterSeconds).toBe(86400);
    });

    it('carries no Retry-After when the header is absent or unparsable', async () => {
      expect((await status({})).retryAfterSeconds).toBeUndefined();
      expect((await status({ 'retry-after': 'soon' })).retryAfterSeconds).toBeUndefined();
    });

    it('refuses a v2 root instead of answering not_found', async () => {
      const { fetch, requests } = setup({});
      const error = await describeComposerV1(fetch, 'acme/listed', {
        source,
        origin,
        codecs,
        selection,
        root: root({ mode: 'v2', metadataUrl: `${BASE}/p2/%package%.json` }),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'unsupported' });
      expect(requests).toEqual([]);
    });
  });
});

describe('describeComposerV1 include kind', () => {
  const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');
  const ROOT_URL = `${BASE}/packages.json`;
  const INCLUDE_URL = (hash: string): string => `${BASE}/include/all%24${hash}.json`;
  const owner = (...versions: string[]): Record<string, unknown> =>
    Object.fromEntries(versions.map((v) => [v, version('acme/owner', v)]));
  const codeOf = (error: unknown): string | undefined =>
    error instanceof ComposerV1PackageError ? error.code : undefined;

  interface Doc {
    readonly body: string;
    readonly member: string;
    readonly entry: Extract<NonNullable<V1PackageOptions['entry']>, { kind: 'package' }>;
    readonly url: string;
  }

  function include(
    packages: Record<string, unknown>,
    over: { key?: string; algs?: ('sha1' | 'sha256')[] } = {},
  ): Doc {
    const body = JSON.stringify({ packages });
    const algs = over.algs ?? ['sha1'];
    const key = over.key ?? 'acme/owner';
    const member = JSON.stringify(packages[key]);
    const url = INCLUDE_URL(sha1(body));
    return {
      body,
      member,
      url,
      entry: {
        kind: 'package',
        sha256: sha256(member),
        document: {
          url,
          ...(algs.includes('sha1') ? { sha1: sha1(body) } : {}),
          ...(algs.includes('sha256') ? { sha256: sha256(body) } : {}),
        },
      },
    };
  }

  const run = (
    doc: Doc,
    extra: Partial<V1PackageOptions> = {},
    routes: Record<string, (n: number) => string | Response> = { [doc.url]: () => doc.body },
  ) => {
    const harness = setup(routes);
    return {
      ...harness,
      result: () =>
        describeComposerV1(harness.fetch, 'acme/owner', {
          source,
          root: root({ mode: 'v1-includes' }),
          origin,
          codecs,
          selection,
          entry: doc.entry,
          ...extra,
        }),
    };
  };

  it('describes a package from an include document verified by sha1', async () => {
    const doc = include({
      'acme/owner': {
        ...owner('1.0.0'),
        'dev-main': version('acme/owner', 'dev-main', { version_normalized: 'dev-main' }),
      },
    });
    const { result, requests } = run(doc);
    const found = await members(await result());
    expect(found.map((m) => [m.version, m.form])).toEqual([
      ['1.0.0', 'composer-p2'],
      ['dev-main', 'composer-p2-dev'],
    ]);
    expect(requests).toEqual([doc.url]);
  });

  it('describes a package from the inline packages of the root, verified by its sha256', async () => {
    const body = JSON.stringify({ packages: { 'acme/owner': owner('1.0.0') } });
    const member = JSON.stringify({ '1.0.0': version('acme/owner', '1.0.0') });
    const doc: Doc = {
      body,
      member,
      url: ROOT_URL,
      entry: {
        kind: 'package',
        sha256: sha256(member),
        document: { url: ROOT_URL, sha256: sha256(body) },
      },
    };
    const { result } = run(doc);
    expect((await members(await result())).map((m) => m.version)).toEqual(['1.0.0']);
  });

  it('verifies sha1 and sha256 together when an include lists both', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') }, { algs: ['sha1', 'sha256'] });
    const { result } = run(doc);
    expect(await members(await result())).toHaveLength(1);
  });

  it('uses the member hash as the snapshot', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result } = run(doc);
    const found = await result();
    if (found.kind !== 'found') throw new Error('expected found');
    expect(found.description.snapshot.id).toBe(`sha256:${sha256(doc.member)}`);
    await members(found);
  });

  it('drops other packages of the document and objects named for another package', async () => {
    const doc = include({
      'acme/other': { '9.0.0': version('acme/other', '9.0.0') },
      'acme/owner': { ...owner('1.0.0'), '2.0.0': version('acme/intruder', '2.0.0') },
    });
    const { result } = run(doc);
    const found = await result();
    expect((await members(found)).map((m) => m.version)).toEqual(['1.0.0']);
    expect(found.kind === 'found' && found.skipped).toEqual({ foreign_name: 1 });
  });

  it('finds a package whose key differs from its name in case', async () => {
    const doc = include({ 'Acme/Owner': owner('1.0.0') }, { key: 'Acme/Owner' });
    const { result } = run(doc);
    expect((await members(await result())).map((m) => m.version)).toEqual(['1.0.0']);
  });

  it('counts duplicate normalized versions of the owner', async () => {
    const doc = include({
      'acme/owner': {
        '1.0.0': version('acme/owner', '1.0.0'),
        'v1.0.0': version('acme/owner', 'v1.0.0', { version_normalized: '1.0.0.0' }),
      },
    });
    const { result } = run(doc);
    const found = await result();
    expect(await members(found)).toHaveLength(1);
    expect(found.kind === 'found' && found.skipped).toEqual({ duplicate: 1 });
  });

  it('answers not_modified for an unchanged package hash without a request', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result, requests } = run(doc, { previousSha256: sha256(doc.member).toUpperCase() });
    expect(await result()).toEqual({ kind: 'not_modified' });
    expect(requests).toEqual([]);
  });

  it('refetches when the previous hash differs', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result, requests } = run(doc, { previousSha256: 'a'.repeat(64) });
    expect(await members(await result())).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('fails closed on a sha1 mismatch after three attempts', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const tampered = doc.body.replace('1.0.0', '6.6.6');
    const { result, requests } = run(doc, {}, { [doc.url]: () => tampered });
    const error = await result().catch((e: unknown) => e);
    expect(codeOf(error)).toBe('hash');
    expect(requests).toHaveLength(3);
  });

  it('fails closed on a sha256 mismatch when sha1 matches', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') }, { algs: ['sha1', 'sha256'] });
    const bad: Doc = {
      ...doc,
      entry: {
        ...doc.entry,
        document: { ...doc.entry.document!, sha256: 'f'.repeat(64) },
      },
    };
    const error = await run(bad)
      .result()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('hash');
  });

  it('fails closed when the verified document holds a different package body than the index recorded', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const stale: Doc = { ...doc, entry: { ...doc.entry, sha256: 'e'.repeat(64) } };
    const harness = run(stale);
    const error = await harness.result().catch((e: unknown) => e);
    expect(codeOf(error)).toBe('hash');
    expect(harness.requests).toHaveLength(1);
  });

  it('accepts a matching document on a later attempt', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result, requests } = run(
      doc,
      {},
      { [doc.url]: (n) => (n < 3 ? '{"packages":{}}' : doc.body) },
    );
    expect(await members(await result())).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  it('refuses a document that lists no hash before any request', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const bare: Doc = {
      ...doc,
      entry: { ...doc.entry, document: { url: doc.url } },
    };
    const { result, requests } = run(bare);
    expect(codeOf(await result().catch((e: unknown) => e))).toBe('invalid');
    expect(requests).toEqual([]);
  });

  it('refuses a malformed listed sha1 before any request', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const bad: Doc = {
      ...doc,
      entry: { ...doc.entry, document: { url: doc.url, sha1: 'nope' } },
    };
    const { result, requests } = run(bad);
    expect(codeOf(await result().catch((e: unknown) => e))).toBe('invalid');
    expect(requests).toEqual([]);
  });

  it('refuses a malformed member hash before any request', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const bad: Doc = { ...doc, entry: { ...doc.entry, sha256: 'nope' } };
    const { result, requests } = run(bad);
    expect(codeOf(await result().catch((e: unknown) => e))).toBe('invalid');
    expect(requests).toEqual([]);
  });

  it('treats a 404 for a listed include as a non-definitive not_found', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result } = run(doc, {}, {});
    expect(await result()).toEqual({ kind: 'not_found', definitive: false });
  });

  it('reports a status error for a failing include', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result } = run(doc, {}, { [doc.url]: () => new Response('', { status: 503 }) });
    const error = await result().catch((e: unknown) => e);
    expect(codeOf(error)).toBe('status');
    expect((error as ComposerV1PackageError).status).toBe(503);
  });

  it('answers non-definitive not_found when a verified document no longer lists the package', async () => {
    const other = include(
      { 'acme/other': { '1.0.0': version('acme/other', '1.0.0') } },
      { key: 'acme/other' },
    );
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result } = run(
      { ...doc, entry: { ...doc.entry, document: other.entry.document! } },
      {},
      { [other.url]: () => other.body },
    );
    expect(await result()).toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([
    '{}',
    '{"foo":1}',
    '{"packages":"x"}',
    '{"packages":{"acme/owner":"x"}}',
    '{"packages":{"acme/owner":[{"name":"acme/owner"}]}}',
  ])('rejects the include shape %s', async (body) => {
    const url = INCLUDE_URL(sha1(body));
    const doc: Doc = {
      body,
      member: '{}',
      url,
      entry: { kind: 'package', sha256: sha256('{}'), document: { url, sha1: sha1(body) } },
    };
    expect(
      codeOf(
        await run(doc)
          .result()
          .catch((e: unknown) => e),
      ),
    ).toBe('invalid');
  });

  it('skips version values that are not objects', async () => {
    const doc = include({ 'acme/owner': { '1.0.0': version('acme/owner', '1.0.0'), '2.0.0': 5 } });
    const found = await run(doc).result();
    expect(await members(found)).toHaveLength(1);
    expect(found.kind === 'found' && found.skipped).toEqual({ malformed: 1 });
  });

  it('caps the document by the shared byte budget across attempts', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result, requests } = run(doc, { maxBytes: 40 });
    expect(codeOf(await result().catch((e: unknown) => e))).toBe('too_large');
    expect(requests.length).toBeGreaterThan(0);
  });

  it('refuses a package above 1 MiB', async () => {
    const doc = include({
      'acme/owner': { '1.0.0': version('acme/owner', '1.0.0', { readme: 'x'.repeat(1100000) }) },
    });
    expect(
      codeOf(
        await run(doc)
          .result()
          .catch((e: unknown) => e),
      ),
    ).toBe('too_large');
  });

  it('caps the number of version objects', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0', '1.0.1', '1.0.2') });
    expect(
      codeOf(
        await run(doc, { maxVersions: 2 })
          .result()
          .catch((e: unknown) => e),
      ),
    ).toBe('too_large');
  });

  it('stops at the shared deadline', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const { result, requests } = run(
      doc,
      { deadlineMs: 50 },
      { [doc.url]: () => '{"packages":{}}' },
    );
    expect(codeOf(await result().catch((e: unknown) => e))).toBe('deadline');
    expect(requests.length).toBeLessThan(3);
  });

  const twoPackages = (): { body: string; entries: Doc['entry'][]; url: string } => {
    const packages = {
      'acme/owner': owner('1.0.0'),
      'acme/second': { '1.0.0': version('acme/second', '1.0.0') },
      'acme/third': { '1.0.0': version('acme/third', '1.0.0') },
    };
    const body = JSON.stringify({ packages });
    const url = INCLUDE_URL(sha1(body));
    return {
      body,
      url,
      entries: Object.values(packages).map((pkg) => ({
        kind: 'package' as const,
        sha256: sha256(JSON.stringify(pkg)),
        document: { url, sha1: sha1(body) },
      })),
    };
  };
  const describeAs = (
    harness: ReturnType<typeof setup>,
    name: string,
    entry: Doc['entry'],
    extra: Partial<V1PackageOptions>,
  ) =>
    describeComposerV1(harness.fetch, name, {
      source,
      root: root({ mode: 'v1-includes' }),
      origin,
      codecs,
      selection: { packages: [name], patterns: [], expandPatterns: false },
      entry,
      ...extra,
    });

  const indexOf = (
    entries: Doc['entry'][],
    cached?: {
      document: Doc['entry']['document'];
      members: Record<string, string>;
      partial: boolean;
    },
  ): NonNullable<V1PackageOptions['index']> => ({
    complete: true,
    entries: new Map(entries.map((entry, i) => [`acme/p${i}`, entry])),
    documents: new Map(
      cached === undefined
        ? []
        : [
            [
              documentKey(cached.document),
              { members: new Map(Object.entries(cached.members)), partial: cached.partial },
            ],
          ],
    ),
  });
  const rawOf = (pkg: unknown): string => JSON.stringify(pkg);

  it('describes every package of a cached include without a request', async () => {
    const { body, entries, url } = twoPackages();
    const harness = setup({ [url]: () => body });
    const packages = JSON.parse(body).packages as Record<string, unknown>;
    const index = indexOf(entries, {
      document: entries[0]!.document,
      members: Object.fromEntries(Object.entries(packages).map(([k, v]) => [k, rawOf(v)])),
      partial: false,
    });
    for (const [i, name] of ['acme/owner', 'acme/second', 'acme/third'].entries()) {
      const found = await members(await describeAs(harness, name, entries[i]!, { index }));
      expect(found).toHaveLength(1);
    }
    expect(harness.requests).toEqual([]);
  });

  it('fetches the include for each package when nothing is cached', async () => {
    const { body, entries, url } = twoPackages();
    const harness = setup({ [url]: () => body });
    for (const [i, name] of ['acme/owner', 'acme/second'].entries()) {
      await members(await describeAs(harness, name, entries[i]!, {}));
    }
    expect(harness.requests).toEqual([url, url]);
  });

  it('includes the expected hash in the cache key', async () => {
    const { body, entries, url } = twoPackages();
    const harness = setup({ [url]: () => body });
    const other = { url, sha1: sha1('some other body') };
    const index = indexOf(entries, {
      document: other,
      members: { 'acme/owner': rawOf(owner('1.0.0')) },
      partial: false,
    });
    await members(await describeAs(harness, 'acme/owner', entries[0]!, { index }));
    expect(harness.requests).toEqual([url]);
  });

  it('answers non-definitive not_found for a name a complete cached document lacks', async () => {
    const { body, entries, url } = twoPackages();
    const harness = setup({ [url]: () => body });
    const index = indexOf(entries, { document: entries[0]!.document, members: {}, partial: false });
    expect(await describeAs(harness, 'acme/owner', entries[0]!, { index })).toEqual({
      kind: 'not_found',
      definitive: false,
    });
    expect(harness.requests).toEqual([]);
  });

  it('fetches the document for a name a partial cached document lacks', async () => {
    const { body, entries, url } = twoPackages();
    const harness = setup({ [url]: () => body });
    const index = indexOf(entries, {
      document: entries[0]!.document,
      members: { 'acme/owner': rawOf(owner('1.0.0')) },
      partial: true,
    });
    await members(await describeAs(harness, 'acme/owner', entries[0]!, { index }));
    expect(harness.requests).toEqual([]);
    await members(await describeAs(harness, 'acme/second', entries[1]!, { index }));
    expect(harness.requests).toEqual([url]);
  });

  it('does not retry a cached member that is not JSON', async () => {
    const { entries } = twoPackages();
    let reads = 0;
    class Counting extends Map<string, string> {
      override get(key: string): string | undefined {
        reads += 1;
        return super.get(key);
      }
    }
    const raw = 'not json';
    const entry = { ...entries[0]!, sha256: sha256(raw) };
    const index = {
      complete: true,
      entries: new Map(),
      documents: new Map([
        [
          documentKey(entry.document),
          { members: new Counting([['acme/owner', raw]]), partial: false },
        ],
      ]),
    };
    const error = await describeAs(setup({}), 'acme/owner', entry, { index }).catch(
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe('invalid');
    expect(reads).toBe(1);
  });

  it('sizes the byte budget by the document cap the index used', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const seen: number[] = [];
    const stub: PolicyFetch = async (request) => {
      seen.push(request.maxBytes ?? -1);
      return new Response(doc.body, { status: 200 });
    };
    await describeComposerV1(stub, 'acme/owner', {
      source,
      root: root({ mode: 'v1-includes' }),
      origin,
      codecs,
      selection,
      entry: doc.entry,
      maxDocumentBytes: 64 * 1024 * 1024,
    });
    expect(seen).toEqual([64 * 1024 * 1024]);
  });

  it('rejects a member above the default cap and accepts it under the cap the index used', async () => {
    const big = {
      'acme/owner': Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `1.0.${i}`,
          version('acme/owner', `1.0.${i}`, { readme: 'x'.repeat(40000) }),
        ]),
      ),
    };
    const doc = include(big);
    const capped = await run(doc)
      .result()
      .catch((e: unknown) => e);
    expect(codeOf(capped)).toBe('too_large');
    const raised = run(doc, { maxMemberBytes: 2 * 1024 * 1024 });
    expect(await members(await raised.result())).toHaveLength(30);
  });

  it('applies the document cap the index used', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    const error = await run(doc, { maxDocumentBytes: 50 })
      .result()
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('too_large');
  });

  it('rejects a non-positive carried limit', async () => {
    const doc = include({ 'acme/owner': owner('1.0.0') });
    await expect(run(doc, { maxMemberBytes: 0 }).result()).rejects.toThrow(RangeError);
    await expect(run(doc, { maxDocumentBytes: 0 }).result()).rejects.toThrow(RangeError);
  });
});

describe('describeComposerV1 absence', () => {
  const listed = { kind: 'provider' as const, sha256: 'a'.repeat(64) };
  const absent = (index: V1PackageOptions['index']) =>
    describeComposerV1(setup({}).fetch, 'acme/unlisted', {
      source,
      root: root({ mode: 'v1-includes' }),
      origin,
      codecs,
      selection: { packages: ['acme/unlisted'], patterns: [], expandPatterns: false },
      ...(index === undefined ? {} : { index }),
    });

  it('is definitive only when a complete, non-empty index does not list the name', async () => {
    const entries = new Map([['acme/other', listed]]);
    expect(await absent({ complete: true, entries })).toEqual({
      kind: 'not_found',
      definitive: true,
    });
  });

  it.each([
    ['an incomplete index', { complete: false, entries: new Map() }],
    ['an empty index', { complete: true, entries: new Map() }],
    [
      'an incomplete index that lists names',
      { complete: false, entries: new Map([['acme/other', listed]]) },
    ],
    ['no index', undefined],
  ])('is not definitive with %s', async (_label, index) => {
    expect(await absent(index)).toEqual({ kind: 'not_found', definitive: false });
  });

  it('reads the entry from the index', async () => {
    const body = JSON.stringify({ packages: { 'acme/owner': {} } });
    const hash = sha256(body);
    const { fetch } = setup({ [`${BASE}/p/acme/owner%24${hash}.json`]: () => body });
    const result = await describeComposerV1(fetch, 'acme/owner', {
      source,
      root: root(),
      origin,
      codecs,
      selection,
      index: {
        complete: true,
        entries: new Map([['acme/owner', { kind: 'provider', sha256: hash }]]),
      },
    });
    expect(result.kind).toBe('found');
  });
});
