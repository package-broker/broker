import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import type { ComposerVersionOrigin } from '../../registry/composer/version-object.js';
import type { DescribeResult, VersionCandidate } from '../../sources/provider.js';
import { createPolicyFetch } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import type { ComposerRoot, ComposerRootSource } from './root.js';
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
});
