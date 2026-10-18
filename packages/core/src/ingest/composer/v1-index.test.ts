import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { createPolicyFetch, type UpstreamCredential } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { ComposerRootError, type ComposerRootSource } from './root.js';
import { documentKey, readV1Index, type V1IndexResult } from './v1-index.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const BASE = 'https://repo.example.com';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

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

type Served = string | ((count: number) => string | null | Response | Promise<Response>);

function setup(routes: Record<string, Served>): {
  requests: string[];
  headers: Map<string, Headers>;
  fetch: ReturnType<typeof createPolicyFetch>;
} {
  const requests: string[] = [];
  const headers = new Map<string, Headers>();
  const counts = new Map<string, number>();
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push(url);
      headers.set(url, new Headers(init?.headers));
      const count = (counts.get(url) ?? 0) + 1;
      counts.set(url, count);
      const route = routes[url];
      const body = typeof route === 'function' ? await route(count) : route;
      if (body instanceof Response) return body;
      if (body === undefined || body === null) return new Response('missing', { status: 404 });
      return new Response(body, { status: 200 });
    },
  });
  return { requests, headers, fetch };
}

const source: ComposerRootSource = { url: BASE, policy, allowedOrigins: [] };
const options = { source, codecs };

function providerFile(names: Record<string, string>): string {
  return JSON.stringify({
    providers: Object.fromEntries(Object.entries(names).map(([n, h]) => [n, { sha256: h }])),
  });
}

function providersRoot(files: Record<string, string>, extra: object = {}): string {
  return JSON.stringify({
    'providers-url': '/p/%package%$%hash%.json',
    'provider-includes': Object.fromEntries(
      Object.entries(files).map(([key, body]) => [key, { sha256: sha256(body) }]),
    ),
    ...extra,
  });
}

function incomplete(result: V1IndexResult): string | undefined {
  expect(result.status).toBe('updated');
  if (result.status !== 'updated') throw new Error('expected updated');
  expect(result.index.complete).toBe(false);
  expect(result.index.entries.size).toBe(0);
  return result.index.reason;
}

function entriesOf(result: V1IndexResult): Record<string, string> {
  if (result.status !== 'updated') throw new Error('expected updated');
  return Object.fromEntries([...result.index.entries].map(([name, e]) => [name, e.sha256]));
}

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

describe('readV1Index provider listings', () => {
  const fileA = providerFile({ 'Vendor/A': H1 });
  const fileB = providerFile({ 'vendor/b': H2 });
  const routes = (root: string, a = fileA, b = fileB): Record<string, Served> => ({
    [`${BASE}/packages.json`]: root,
    [`${BASE}/p/a%24${sha256(a)}.json`]: a,
    [`${BASE}/p/b%24${sha256(b)}.json`]: b,
  });

  it('lists every provider with its sha256 and verifies each include', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA, 'p/b$%hash%.json': fileB });
    const { fetch, requests } = setup(routes(root));
    const result = await readV1Index(fetch, options);
    expect(entriesOf(result)).toEqual({ 'vendor/a': H1, 'vendor/b': H2 });
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(result.status === 'updated' && result.index.rootSha256).toBe(sha256(root));
    expect(requests).toHaveLength(3);
  });

  it('returns not_modified after one request when the root hash is unchanged', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA, 'p/b$%hash%.json': fileB });
    const { fetch, requests } = setup(routes(root));
    const result = await readV1Index(fetch, options, { rootSha256: sha256(root), complete: true });
    expect(result.status).toBe('not_modified');
    expect(requests).toEqual([`${BASE}/packages.json`]);
  });

  it('refetches every include when the root changed, including unchanged ones', async () => {
    const fileB2 = providerFile({ 'vendor/b': H3, 'vendor/c': H1 });
    const oldRoot = providersRoot({ 'p/a$%hash%.json': fileA, 'p/b$%hash%.json': fileB });
    const root = providersRoot({ 'p/a$%hash%.json': fileA, 'p/b$%hash%.json': fileB2 });
    const { fetch, requests } = setup(routes(root, fileA, fileB2));
    const result = await readV1Index(fetch, options, {
      rootSha256: sha256(oldRoot),
      complete: true,
    });
    expect(entriesOf(result)).toEqual({ 'vendor/a': H1, 'vendor/b': H3, 'vendor/c': H1 });
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(requests).toEqual([
      `${BASE}/packages.json`,
      `${BASE}/p/a%24${sha256(fileA)}.json`,
      `${BASE}/p/b%24${sha256(fileB2)}.json`,
    ]);
  });

  it('re-reads the root once after a hash mismatch and completes when the retry verifies', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/p/a%24${sha256(fileA)}.json`]: (n) =>
        n === 1 ? providerFile({ evil: H3 }) : fileA,
    });
    const result = await readV1Index(fetch, options);
    expect(entriesOf(result)).toEqual({ 'vendor/a': H1 });
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(requests.filter((u) => u.endsWith('/packages.json'))).toHaveLength(2);
  });

  it('marks the index incomplete when an include mismatches its hash twice', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA, 'p/b$%hash%.json': fileB });
    const { fetch, requests } = setup({
      ...routes(root),
      [`${BASE}/p/b%24${sha256(fileB)}.json`]: providerFile({ 'vendor/b': H3 }),
    });
    const result = await readV1Index(fetch, options);
    expect(incomplete(result)).toBe('hash');
    expect(requests.filter((u) => u.endsWith('/packages.json'))).toHaveLength(2);
    expect(requests.filter((u) => u.includes('/p/b%24'))).toHaveLength(2);
  });

  it('treats a missing include twice as incomplete', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA });
    const { fetch, requests } = setup({ [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(incomplete(result)).toBe('status');
    expect(requests).toHaveLength(4);
  });

  it('marks the index incomplete for a provider entry without a valid sha256', async () => {
    const bad = JSON.stringify({ providers: { 'vendor/a': { sha256: 'nope' } } });
    const root = providersRoot({ 'p/a$%hash%.json': bad });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/p/a%24${sha256(bad)}.json`]: bad,
    });
    const result = await readV1Index(fetch, options);
    expect(incomplete(result)).toBe('invalid');
    expect(requests).toHaveLength(4);
  });

  it('streams inline providers from the root', async () => {
    const root = JSON.stringify({
      'providers-url': '/p/%package%$%hash%.json',
      providers: { 'vendor/x': { sha256: H2 } },
    });
    const { fetch, requests } = setup({ [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(entriesOf(result)).toEqual({ 'vendor/x': H2 });
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('treats a root that changed between the two reads as a mismatch', async () => {
    const first = JSON.stringify({
      'providers-url': '/p/%package%$%hash%.json',
      providers: { 'vendor/x': { sha256: H2 } },
    });
    const second = JSON.stringify({
      'providers-url': '/p/%package%$%hash%.json',
      providers: { 'vendor/y': { sha256: H3 } },
    });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: (n) => (n === 1 ? first : second),
    });
    const result = await readV1Index(fetch, options);
    expect(entriesOf(result)).toEqual({ 'vendor/y': H3 });
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(result.status === 'updated' && result.index.rootSha256).toBe(sha256(second));
  });

  it('runs a full pass when the previous index with the same root was incomplete', async () => {
    const root = providersRoot({ 'p/a$%hash%.json': fileA });
    const { fetch, requests } = setup(routes(root));
    const result = await readV1Index(fetch, options, { rootSha256: sha256(root), complete: false });
    expect(entriesOf(result)).toEqual({ 'vendor/a': H1 });
    expect(requests).toHaveLength(2);
  });
});

describe('readV1Index includes', () => {
  const nested = JSON.stringify({
    packages: { 'vendor/deep': { '1.0.0': { name: 'vendor/deep' } } },
  });
  const included = JSON.stringify({
    packages: { 'Vendor/Inc': { '1.0.0': { name: 'vendor/inc', version: '1.0.0' } } },
    includes: { 'include/deep.json': { sha1: sha1(nested) } },
  });

  it('lists inline packages and verified includes, nested included', async () => {
    const root = JSON.stringify({
      packages: { 'vendor/inline': { '2.0.0': { name: 'vendor/inline' } } },
      includes: { 'include/all$abc.json': { sha256: sha256(included) } },
    });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/include/all%24abc.json`]: included,
      [`${BASE}/include/deep.json`]: nested,
    });
    const result = await readV1Index(fetch, options);
    const entries = entriesOf(result);
    expect(Object.keys(entries).sort()).toEqual(['vendor/deep', 'vendor/inc', 'vendor/inline']);
    for (const hash of Object.values(entries)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(requests).toHaveLength(4);
  });

  it('records the document and hashes each package was read from', async () => {
    const root = JSON.stringify({
      packages: { 'vendor/inline': { '2.0.0': { name: 'vendor/inline' } } },
      includes: { 'include/all$abc.json': { sha256: sha256(included) } },
    });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/include/all%24abc.json`]: included,
      [`${BASE}/include/deep.json`]: nested,
    });
    const result = await readV1Index(fetch, options);
    if (result.status !== 'updated') throw new Error('expected updated');
    const documents = Object.fromEntries(
      [...result.index.entries].map(([name, entry]) => [
        name,
        entry.kind === 'package' ? entry.document : undefined,
      ]),
    );
    expect(documents).toEqual({
      'vendor/inline': { url: `${BASE}/packages.json`, sha256: sha256(root) },
      'vendor/inc': { url: `${BASE}/include/all%24abc.json`, sha256: sha256(included) },
      'vendor/deep': { url: `${BASE}/include/deep.json`, sha1: sha1(nested) },
    });
  });

  const includeRoot = JSON.stringify({
    includes: { 'include/all$abc.json': { sha256: sha256(included) } },
  });
  const served = {
    [`${BASE}/packages.json`]: includeRoot,
    [`${BASE}/include/all%24abc.json`]: included,
    [`${BASE}/include/deep.json`]: nested,
  };
  const docsOf = (result: V1IndexResult) => {
    if (result.status !== 'updated') throw new Error('expected updated');
    return result.index.documents;
  };
  const deepKey = documentKey({ url: `${BASE}/include/deep.json`, sha1: sha1(nested) });

  it('hands the packages of each verified document to the index', async () => {
    const { fetch } = setup(served);
    const documents = docsOf(await readV1Index(fetch, options));
    expect([...(documents.get(deepKey)?.members.keys() ?? [])]).toEqual(['vendor/deep']);
    expect(documents.get(deepKey)?.partial).toBe(false);
  });

  it('keeps a document that failed its hash out of the cache', async () => {
    const root = JSON.stringify({
      includes: { 'include/all$abc.json': { sha256: 'f'.repeat(64) } },
    });
    const { fetch } = setup({ ...served, [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(result.status === 'updated' && result.index.complete).toBe(false);
    expect(docsOf(result).size).toBe(0);
  });

  it('does not carry first-pass documents into the retry pass', async () => {
    const solo = JSON.stringify({
      packages: { 'vendor/solo': { '1.0.0': { name: 'vendor/solo' } } },
    });
    const first = JSON.stringify({
      includes: {
        'include/solo.json': { sha1: sha1(solo) },
        'include/b.json': { sha1: sha1(included) },
      },
    });
    const second = JSON.stringify({ includes: { 'include/b.json': { sha1: sha1(included) } } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: (n) => (n <= 2 ? first : second),
      [`${BASE}/include/solo.json`]: solo,
      [`${BASE}/include/deep.json`]: nested,
      [`${BASE}/include/b.json`]: (n) => (n === 1 ? '{"packages":{}}' : included),
    });
    const result = await readV1Index(fetch, options);
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    const documents = docsOf(result);
    expect(documents.has(documentKey({ url: `${BASE}/include/solo.json`, sha1: sha1(solo) }))).toBe(
      false,
    );
    expect(documents.has(deepKey)).toBe(true);
  });

  it('keeps only selected names in the cache and marks the document partial', async () => {
    const { fetch } = setup(served);
    const selection = { packages: ['vendor/inc'], patterns: [], expandPatterns: false };
    const result = await readV1Index(fetch, { ...options, selection });
    const documents = docsOf(result);
    const key = documentKey({
      url: `${BASE}/include/all%24abc.json`,
      sha256: sha256(included),
    });
    expect([...(documents.get(key)?.members.keys() ?? [])]).toEqual(['vendor/inc']);
    expect(documents.get(deepKey)?.members.size).toBe(0);
    expect(documents.get(deepKey)?.partial).toBe(true);
    expect(result.status === 'updated' && result.index.entries.size).toBe(2);
  });

  it('stops caching raw package text at the byte budget but still lists every name', async () => {
    const both = JSON.stringify({
      packages: {
        'vendor/a': { '1.0.0': { name: 'vendor/a' } },
        'vendor/b': { '1.0.0': { name: 'vendor/b' } },
      },
    });
    const root = JSON.stringify({ includes: { 'include/both.json': { sha1: sha1(both) } } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/include/both.json`]: both,
    });
    const one = JSON.stringify({ '1.0.0': { name: 'vendor/a' } }).length;
    const result = await readV1Index(fetch, { ...options, maxCachedBytes: one });
    const cached = docsOf(result).get(
      documentKey({ url: `${BASE}/include/both.json`, sha1: sha1(both) }),
    );
    expect([...(cached?.members.keys() ?? [])]).toEqual(['vendor/a']);
    expect(cached?.partial).toBe(true);
    expect(result.status === 'updated' && result.index.entries.size).toBe(2);
  });

  it('refuses a non-positive cache budget', async () => {
    const { fetch } = setup(served);
    await expect(readV1Index(fetch, { ...options, maxCachedBytes: 0 })).rejects.toThrow(RangeError);
  });

  it('lists the packages of a legacy root without includes', async () => {
    const root = JSON.stringify({ packages: { 'vendor/legacy': { '1.0.0': {} } } });
    const { fetch } = setup({ [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(Object.keys(entriesOf(result))).toEqual(['vendor/legacy']);
  });

  it('changes the package digest when its versions change', async () => {
    const one = JSON.stringify({ packages: { 'vendor/p': { '1.0.0': {} } } });
    const two = JSON.stringify({ packages: { 'vendor/p': { '1.0.0': {}, '1.1.0': {} } } });
    const a = entriesOf(
      await readV1Index(setup({ [`${BASE}/packages.json`]: one }).fetch, options),
    );
    const b = entriesOf(
      await readV1Index(setup({ [`${BASE}/packages.json`]: two }).fetch, options),
    );
    expect(a['vendor/p']).not.toBe(b['vendor/p']);
  });

  it('marks the index incomplete for an include sha1 mismatch twice', async () => {
    const root = JSON.stringify({ includes: { 'include/a.json': { sha1: sha1('{}') } } });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/include/a.json`]: included,
    });
    const result = await readV1Index(fetch, options);
    expect(incomplete(result)).toBe('hash');
    expect(requests.filter((u) => u.endsWith('/include/a.json'))).toHaveLength(2);
  });

  it('refuses a nested include outside the repository base without requesting it', async () => {
    const escaping = JSON.stringify({
      packages: {},
      includes: { '../../evil.json': { sha1: sha1('{}') } },
    });
    const root = JSON.stringify({ includes: { 'include/a.json': { sha256: sha256(escaping) } } });
    const { fetch, requests } = setup({
      [`${BASE}/repo/packages.json`]: root,
      [`${BASE}/repo/include/a.json`]: escaping,
    });
    const result = await readV1Index(fetch, { source: { ...source, url: `${BASE}/repo` }, codecs });
    expect(incomplete(result)).toBe('invalid');
    expect(requests.some((u) => u.includes('evil'))).toBe(false);
  });

  it('marks an include without a usable hash incomplete', async () => {
    const root = JSON.stringify({ includes: { 'include/a.json': {} } });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/include/a.json`]: included,
    });
    const result = await readV1Index(fetch, options);
    expect(incomplete(result)).toBe('hash');
    expect(requests).toHaveLength(4);
  });
});

describe('readV1Index modes', () => {
  it('refuses a v2 root', async () => {
    const { fetch } = setup({
      [`${BASE}/packages.json`]: JSON.stringify({ 'metadata-url': '/p2/%package%.json' }),
    });
    await expect(readV1Index(fetch, options)).rejects.toBeInstanceOf(ComposerRootError);
  });

  it('lists inline partial packages of a lazy root', async () => {
    const root = JSON.stringify({
      'providers-lazy-url': '/lazy/%package%.json',
      packages: { 'vendor/partial': { '1.0.0': {} } },
    });
    const { fetch } = setup({ [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(Object.keys(entriesOf(result))).toEqual(['vendor/partial']);
    expect(result.status === 'updated' && result.index.entries.get('vendor/partial')?.kind).toBe(
      'package',
    );
  });

  it('does not request the root twice for a lazy root without inline packages', async () => {
    const root = JSON.stringify({ 'providers-lazy-url': '/lazy/%package%.json' });
    const { fetch, requests } = setup({ [`${BASE}/packages.json`]: root });
    const result = await readV1Index(fetch, options);
    expect(entriesOf(result)).toEqual({});
    expect(requests).toHaveLength(1);
  });
});

describe('readV1Index round 2 hardening', () => {
  const pkgs = (names: Record<string, unknown>): string => JSON.stringify({ packages: names });
  const includesRoot = (files: Record<string, string>): string =>
    JSON.stringify({
      includes: Object.fromEntries(
        Object.entries(files).map(([key, body]) => [key, { sha256: sha256(body) }]),
      ),
    });

  it.each(['../../x', 'a?b=', 'a#', '%2e%2e/x', 'vendor/a b', 'vendor/a\u0001', 'vendor', '/x'])(
    'fails a provider include listing the invalid name %j',
    async (name) => {
      const file = providerFile({ [name]: H1 });
      const root = providersRoot({ 'p/a$%hash%.json': file });
      const { fetch, requests } = setup({
        [`${BASE}/packages.json`]: root,
        [`${BASE}/p/a%24${sha256(file)}.json`]: file,
      });
      expect(incomplete(await readV1Index(fetch, options))).toBe('name');
      expect(requests).toHaveLength(4);
    },
  );

  it.each(['../../x', 'vendor/a?b=', 'vendor/a#', '%2e%2e/x', 'vendor/a b'])(
    'fails an include listing the invalid package name %j',
    async (name) => {
      const file = pkgs({ [name]: { '1.0.0': {} } });
      const { fetch } = setup({
        [`${BASE}/packages.json`]: includesRoot({ 'include/a.json': file }),
        [`${BASE}/include/a.json`]: file,
      });
      expect(incomplete(await readV1Index(fetch, options))).toBe('name');
    },
  );

  it('accepts names the Composer grammar allows', async () => {
    const file = providerFile({ 'v.e_n-d0r/pkg--name.x_y': H1 });
    const root = providersRoot({ 'p/a$%hash%.json': file });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/p/a%24${sha256(file)}.json`]: file,
    });
    expect(entriesOf(await readV1Index(fetch, options))).toEqual({
      'v.e_n-d0r/pkg--name.x_y': H1,
    });
  });

  it('fails on a case-insensitive duplicate name across documents', async () => {
    const a = providerFile({ 'Vendor/A': H1 });
    const b = providerFile({ 'vendor/a': H2 });
    const root = providersRoot({ 'p/a$%hash%.json': a, 'p/b$%hash%.json': b });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/p/a%24${sha256(a)}.json`]: a,
      [`${BASE}/p/b%24${sha256(b)}.json`]: b,
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('duplicate');
  });

  it('fails on a case-insensitive duplicate name inside one document', async () => {
    const file = pkgs({ 'Vendor/A': { '1.0.0': {} }, 'vendor/a': { '2.0.0': {} } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'include/a.json': file }),
      [`${BASE}/include/a.json`]: file,
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('duplicate');
  });

  it('treats an empty package value as absent', async () => {
    const file = pkgs({ 'vendor/empty': [], 'vendor/none': {}, 'vendor/real': { '1.0.0': {} } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'include/a.json': file }),
      [`${BASE}/include/a.json`]: file,
    });
    expect(Object.keys(entriesOf(await readV1Index(fetch, options)))).toEqual(['vendor/real']);
  });

  it('fails a non-object package value', async () => {
    const file = pkgs({ 'vendor/s': 'x' });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'include/a.json': file }),
      [`${BASE}/include/a.json`]: file,
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('invalid');
  });

  it('fails a nested include whose hash mismatches, retrying once', async () => {
    const outer = JSON.stringify({
      packages: {},
      includes: { 'include/deep.json': { sha1: sha1('{"packages":{}}') } },
    });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'include/a.json': outer }),
      [`${BASE}/include/a.json`]: outer,
      [`${BASE}/include/deep.json`]: pkgs({ 'vendor/x': { '1.0.0': {} } }),
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('hash');
    expect(requests.filter((u) => u.endsWith('/deep.json'))).toHaveLength(2);
  });

  it('enforces the nesting depth limit', async () => {
    const c = pkgs({ 'vendor/c': { '1.0.0': {} } });
    const b = JSON.stringify({ packages: {}, includes: { 'c.json': { sha1: sha1(c) } } });
    const a = JSON.stringify({ packages: {}, includes: { 'b.json': { sha1: sha1(b) } } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a }),
      [`${BASE}/a.json`]: a,
      [`${BASE}/b.json`]: b,
      [`${BASE}/c.json`]: c,
    });
    expect(incomplete(await readV1Index(fetch, { ...options, maxDepth: 1 }))).toBe('limit');
    expect(Object.keys(entriesOf(await readV1Index(fetch, { ...options, maxDepth: 2 })))).toEqual([
      'vendor/c',
    ]);
  });

  it('enforces the document count limit', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const b = pkgs({ 'vendor/b': { '1.0.0': {} } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a, 'b.json': b }),
      [`${BASE}/a.json`]: a,
      [`${BASE}/b.json`]: b,
    });
    expect(incomplete(await readV1Index(fetch, { ...options, maxFiles: 2 }))).toBe('limit');
  });

  it('counts staged entries against the entry limit', async () => {
    const file = pkgs({ 'vendor/a': { 1: {} }, 'vendor/b': { 1: {} }, 'vendor/c': { 1: {} } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': file }),
      [`${BASE}/a.json`]: file,
    });
    expect(incomplete(await readV1Index(fetch, { ...options, maxEntries: 2 }))).toBe('limit');
  });

  it('enforces the per-document size limit', async () => {
    const file = pkgs({ 'vendor/a': { '1.0.0': { description: 'x'.repeat(200) } } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': file }),
      [`${BASE}/a.json`]: file,
    });
    expect(incomplete(await readV1Index(fetch, { ...options, maxDocumentBytes: 128 }))).toBe(
      'read',
    );
  });

  it('enforces the total byte budget of a pass', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': { description: 'x'.repeat(100) } } });
    const b = pkgs({ 'vendor/b': { '1.0.0': { description: 'x'.repeat(100) } } });
    const root = includesRoot({ 'a.json': a, 'b.json': b });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: root,
      [`${BASE}/a.json`]: a,
      [`${BASE}/b.json`]: b,
    });
    const budget = root.length + a.length + 10;
    expect(incomplete(await readV1Index(fetch, { ...options, maxPassBytes: budget }))).toBe(
      'bytes',
    );
  });

  it('enforces the total deadline of a pass', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const b = pkgs({ 'vendor/b': { '1.0.0': {} } });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a, 'b.json': b }),
      [`${BASE}/a.json`]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(a);
      },
      [`${BASE}/b.json`]: b,
    });
    expect(incomplete(await readV1Index(fetch, { ...options, passTimeoutMs: 30 }))).toBe(
      'deadline',
    );
  });

  it('fails an include redirected to a disallowed origin without requesting it', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a }),
      [`${BASE}/a.json`]: () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.org/a' } }),
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('read');
    expect(requests.some((u) => u.includes('evil'))).toBe(false);
  });

  it('does not send the credential to another allowed origin', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const cdn = 'https://cdn.example.com';
    const { fetch, headers } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a }),
      [`${BASE}/a.json`]: () =>
        new Response(null, { status: 302, headers: { location: `${cdn}/a.json` } }),
      [`${cdn}/a.json`]: a,
    });
    const credential: UpstreamCredential = {
      origins: [BASE],
      queryParams: [],
      apply(h, url) {
        h.set('authorization', 'Bearer secret');
        return { headers: h, url };
      },
    };
    const result = await readV1Index(fetch, {
      source: { ...source, allowedOrigins: [cdn], credential },
      codecs,
    });
    expect(Object.keys(entriesOf(result))).toEqual(['vendor/a']);
    expect(headers.get(`${BASE}/a.json`)?.get('authorization')).toBe('Bearer secret');
    expect(headers.get(`${cdn}/a.json`)?.get('authorization')).toBeNull();
  });

  it('returns an incomplete index when the second root read fails', async () => {
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const root = includesRoot({ 'a.json': a });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: (n) => (n <= 2 ? root : new Response('down', { status: 500 })),
      [`${BASE}/a.json`]: pkgs({ 'vendor/b': { '1.0.0': {} } }),
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('root');
    expect(requests.filter((u) => u.endsWith('/packages.json'))).toHaveLength(3);
  });

  it('validates options up front', async () => {
    const { fetch, requests } = setup({});
    for (const bad of [
      { maxEntries: 0 },
      { maxEntries: 200_001 },
      { maxDocumentBytes: -1 },
      { maxMemberBytes: 1.5 },
      { maxPassBytes: Number.NaN },
      { passTimeoutMs: 0 },
      { maxFiles: 0 },
      { maxDepth: -1 },
    ]) {
      await expect(readV1Index(fetch, { ...options, ...bad })).rejects.toBeInstanceOf(RangeError);
    }
    expect(requests).toHaveLength(0);
  });

  it('passes the signal on and stops when it aborts', async () => {
    const controller = new AbortController();
    const a = pkgs({ 'vendor/a': { '1.0.0': {} } });
    const b = pkgs({ 'vendor/b': { '1.0.0': {} } });
    const { fetch, requests } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': a, 'b.json': b }),
      [`${BASE}/a.json`]: () => {
        controller.abort(new Error('stop'));
        return a;
      },
      [`${BASE}/b.json`]: b,
    });
    await expect(readV1Index(fetch, { ...options, signal: controller.signal })).rejects.toThrow(
      'stop',
    );
    expect(requests.some((u) => u.endsWith('/b.json'))).toBe(false);
  });
});

describe('readV1Index listing containers', () => {
  const includesRoot = (files: Record<string, string>): string =>
    JSON.stringify({
      includes: Object.fromEntries(
        Object.entries(files).map(([key, body]) => [key, { sha256: sha256(body) }]),
      ),
    });
  const run = async (file: string): Promise<V1IndexResult> => {
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': file }),
      [`${BASE}/a.json`]: file,
    });
    return readV1Index(fetch, options);
  };

  it.each([
    ['a string packages container', '{"packages":"x"}'],
    ['a number packages container', '{"packages":5}'],
    ['a non-empty array packages container', '{"packages":[{"name":"vendor/a"}]}'],
    ['a null packages container', '{"packages":null}'],
    ['a string includes container', '{"packages":{},"includes":"x"}'],
    ['a non-empty array includes container', '{"packages":{},"includes":["a.json"]}'],
    ['a non-empty array package value', '{"packages":{"vendor/a":[{"name":"vendor/a"}]}}'],
    ['a scalar package value', '{"packages":{"vendor/a":true}}'],
  ])('marks the index incomplete for %s', async (_label, file) => {
    expect(incomplete(await run(file))).toBe('invalid');
  });

  it('accepts empty array containers as empty', async () => {
    const result = await run('{"packages": [ ],"includes":[]}');
    expect(entriesOf(result)).toEqual({});
    expect(result.status === 'updated' && result.index.complete).toBe(true);
  });

  it('skips an empty package value as absent', async () => {
    const result = await run('{"packages":{"vendor/a":[],"vendor/b":{},"vendor/c":{"1.0.0":{}}}}');
    expect(Object.keys(entriesOf(result))).toEqual(['vendor/c']);
  });

  it('marks the index incomplete for a malformed providers container', async () => {
    for (const file of ['{"providers":[{"sha256":"x"}]}', '{"providers":"x"}']) {
      const root = providersRoot({ 'p/a$%hash%.json': file });
      const { fetch } = setup({
        [`${BASE}/packages.json`]: root,
        [`${BASE}/p/a%24${sha256(file)}.json`]: file,
      });
      expect(incomplete(await readV1Index(fetch, options))).toBe('invalid');
    }
  });

  it('rejects a malformed root packages container before streaming the index', async () => {
    const root = JSON.stringify({ packages: 'x' });
    const { fetch } = setup({ [`${BASE}/packages.json`]: root });
    await expect(readV1Index(fetch, options)).rejects.toMatchObject({
      name: 'ComposerRootError',
      code: 'unsupported',
      field: 'packages',
    });
  });

  it('splits the container check across chunk boundaries', async () => {
    const file = '{"packages" :   \n [ 1 ]}';
    const { fetch } = setup({
      [`${BASE}/packages.json`]: includesRoot({ 'a.json': file }),
      [`${BASE}/a.json`]: () => {
        const bytes = new TextEncoder().encode(file);
        let i = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (i >= bytes.length) controller.close();
              else controller.enqueue(bytes.subarray(i, ++i));
            },
          }),
        );
      },
    });
    expect(incomplete(await readV1Index(fetch, options))).toBe('invalid');
  });
});

describe('readV1Index streamed root', () => {
  function bigRoot(count: number): string {
    return JSON.stringify({
      packages: Object.fromEntries(
        Array.from({ length: count }, (_v, i) => [
          `vendor/pkg-${i}`,
          { '1.0.0': { name: `vendor/pkg-${i}`, description: 'x'.repeat(240) } },
        ]),
      ),
    });
  }

  function chunkedRoutes(root: string): ReturnType<typeof createPolicyFetch> {
    const bytes = new TextEncoder().encode(root);
    return createPolicyFetch({
      policy,
      userAgent: 'pb-test/1',
      fetchImpl: async () => {
        let at = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (at >= bytes.length) controller.close();
              else {
                controller.enqueue(bytes.subarray(at, at + 65536));
                at += 65536;
              }
            },
          }),
          { status: 200 },
        );
      },
    });
  }

  it('indexes a 5 MiB single-file root with 20,000 packages', async () => {
    const root = bigRoot(20_000);
    expect(root.length).toBeGreaterThan(5 * 1024 * 1024);
    const result = await readV1Index(chunkedRoutes(root), options);
    expect(result.status === 'updated' && result.index.complete).toBe(true);
    expect(result.status === 'updated' && result.index.entries.size).toBe(20_000);
    expect(result.status === 'updated' && result.index.rootSha256).toBe(sha256(root));
  }, 30_000);

  it('fails a root over maxDocumentBytes as too_large', async () => {
    const { fetch } = setup({ [`${BASE}/packages.json`]: bigRoot(50) });
    await expect(readV1Index(fetch, { ...options, maxDocumentBytes: 4096 })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('counts the root against the pass byte budget', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `p/${i}$%hash%.json`,
        providerFile({ [`vendor/pkg-${i}`]: H1 }),
      ]),
    );
    const root = providersRoot(files);
    const routes = Object.fromEntries(
      Object.entries(files).map(([key, body]) => [
        `${BASE}/${key.replace('$', '%24').replace('%hash%', sha256(body))}`,
        body,
      ]),
    );
    const { fetch } = setup({ [`${BASE}/packages.json`]: root, ...routes });
    const maxPassBytes = Math.floor(root.length * 1.5);
    expect(root.length).toBeLessThan(maxPassBytes);
    expect(maxPassBytes).toBeLessThan(root.length * 2);
    expect(incomplete(await readV1Index(fetch, { ...options, maxPassBytes }))).toBe('bytes');
  });
});

describe('readV1Index root budget regressions', () => {
  it('does not retry when the root alone exceeds maxPassBytes', async () => {
    const root = providersRoot({});
    const { fetch, requests } = setup({ [`${BASE}/packages.json`]: root });
    expect(
      incomplete(await readV1Index(fetch, { ...options, maxPassBytes: root.length - 1 })),
    ).toBe('bytes');
    expect(requests).toEqual([`${BASE}/packages.json`]);
  });

  it('shares the deadline between a slow root and slow includes', async () => {
    const file = providerFile({ 'vendor/a': H1 });
    const other = providerFile({ 'vendor/b': H2 });
    const root = providersRoot({ 'p/a$%hash%.json': file, 'p/b$%hash%.json': other });
    const { fetch } = setup({
      [`${BASE}/packages.json`]: async () => {
        await new Promise((r) => setTimeout(r, 70));
        return new Response(root);
      },
      [`${BASE}/p/b%24${sha256(other)}.json`]: other,
      [`${BASE}/p/a%24${sha256(file)}.json`]: async () => {
        await new Promise((r) => setTimeout(r, 70));
        return new Response(file);
      },
    });
    const timeouts: number[] = [];
    const result = await readV1Index(
      (request) => {
        timeouts.push(request.timeoutMs);
        return fetch(request);
      },
      { ...options, passTimeoutMs: 110 },
    );
    expect(incomplete(result)).toBe('deadline');
    expect(timeouts).toHaveLength(4);
    expect(timeouts[1]).toBeLessThan(70);
    expect(timeouts[3]).toBeLessThan(70);
  });
});

it.each([1000, 25])(
  'caps the root fetch at the remaining deadline and source timeout %i',
  async (timeoutMs) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1030);
    now.mockReturnValueOnce(1000);
    try {
      const timeouts: number[] = [];
      const root = providersRoot({});
      const result = await readV1Index(
        async (request) => {
          timeouts.push(request.timeoutMs);
          return { status: 200, headers: new Headers(), body: new Response(root).body };
        },
        { ...options, source: { ...source, timeoutMs }, passTimeoutMs: 100 },
      );
      expect(timeouts).toEqual([Math.min(timeoutMs, 70)]);
      expect(result.status === 'updated' && result.index.complete).toBe(true);
    } finally {
      now.mockRestore();
    }
  },
);
