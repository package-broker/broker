import { describe, expect, it } from 'vitest';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import type { BlobStore } from '../../platform/blob.js';
import type { Codecs } from '../../platform/codec.js';
import type { Observability } from '../../platform/observability.js';
import { bindCredential, parseCredentialMaterial } from '../../sources/credentials.js';
import {
  UpstreamError,
  createPolicyFetch,
  type UpstreamCredential,
} from '../../sources/policy-fetch.js';
import type {
  ProviderContext,
  ProviderDistTarget,
  ProviderSource,
  VersionCandidate,
} from '../../sources/provider.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { createNpmjsProxyProvider, npmPackumentUrl } from './npmjs-proxy.js';
import { createNpmRegistryProvider } from './scoped-registry.js';

const TOKEN = 'npm-test-token-value-0123';
const GH = 'https://npm.pkg.github.com';
const GH_STORAGE = 'https://pkg-npm.githubusercontent.com';
const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const org = orgContext('01J0ACME000000000000000000');

interface Hop {
  readonly url: string;
  readonly headers: Headers;
}

function upstream(replies: Record<string, () => Response>) {
  const hops: Hop[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hops.push({ url, headers: new Headers(init?.headers) });
    const reply = replies[url];
    if (reply === undefined) throw new Error('unexpected request');
    return reply();
  };
  return {
    hops,
    fetch: createPolicyFetch({ fetchImpl, policy, userAgent: 'pb-test (ops@example.test)' }),
  };
}

const json =
  (body: unknown, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"', ...headers } });
const redirect =
  (location: string): (() => Response) =>
  () =>
    new Response(null, { status: 302, headers: { location } });
const status =
  (code: number): (() => Response) =>
  () =>
    new Response('{}', { status: code });
const tarball = (): Response => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

const unusedStore = new Proxy({} as BlobStore, {
  get() {
    throw new Error('store must not be used for an inline packument');
  },
});
const staging = { store: unusedStore, orgOf: () => org };

function context(fetch: ProviderContext['fetch'], credential: UpstreamCredential | null = null) {
  return {
    fetch,
    credential,
    codecs: {} as Codecs,
    signal: new AbortController().signal,
    clock: fixedClock('2026-10-16T00:00:00.000Z'),
    observability: {} as Observability,
  } satisfies ProviderContext;
}

const npmjsSource: ProviderSource = {
  id: 'src-npmjs',
  ecosystem: 'npm',
  url: 'https://registry.npmjs.org',
  type: 'npmjs_proxy',
  config: {},
  providerId: 'npmjs',
};

const ghSource: ProviderSource = {
  id: 'src-gh',
  ecosystem: 'npm',
  url: GH,
  type: 'npm_registry',
  config: { scopes: ['@acme'] },
  providerId: 'npm-registry',
};

const ghToken = (): UpstreamCredential =>
  bindCredential(parseCredentialMaterial('npm_token', JSON.stringify({ token: TOKEN })), [GH]);

function dist(url: string | null, packageName = 'left-pad'): ProviderDistTarget {
  return { packageName, version: '1.0.0', url, distType: 'tar', sourceRef: null };
}

function packument(name: string, tarballUrl: string) {
  return {
    name,
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
    versions: {
      '1.0.0': { name, version: '1.0.0', dist: { tarball: tarballUrl, shasum: 'a'.repeat(40) } },
    },
  };
}

async function drain(members: AsyncIterable<VersionCandidate>): Promise<VersionCandidate[]> {
  const out: VersionCandidate[] = [];
  for await (const member of members) out.push(member);
  return out;
}

describe('npmPackumentUrl', () => {
  it('encodes the scope separator and nothing else of a scoped name', () => {
    expect(npmPackumentUrl('https://registry.npmjs.org', '@scope/name')).toBe(
      'https://registry.npmjs.org/@scope%2fname',
    );
    expect(npmPackumentUrl('https://registry.npmjs.org', 'left-pad')).toBe(
      'https://registry.npmjs.org/left-pad',
    );
  });

  it('keeps a registry base path', () => {
    expect(npmPackumentUrl('https://gitlab.example.test/api/v4/packages/npm/', '@a/b')).toBe(
      'https://gitlab.example.test/api/v4/packages/npm/@a%2fb',
    );
  });

  it('refuses a name that is not a valid npm name', () => {
    expect(() => npmPackumentUrl('https://registry.npmjs.org', '../etc')).toThrow();
    expect(() => npmPackumentUrl('https://registry.npmjs.org', '@a/b/c')).toThrow();
  });
});

describe('npmjs proxy provider', () => {
  const provider = createNpmjsProxyProvider(staging);

  it('fetches the scoped packument from the fixed upstream without a credential', async () => {
    const url = 'https://registry.npmjs.org/@scope%2fname';
    const { hops, fetch } = upstream({
      [url]: json(
        packument('@scope/name', 'https://registry.npmjs.org/@scope/name/-/name-1.0.0.tgz'),
      ),
    });
    const result = await provider.describe(context(fetch), npmjsSource, '@scope/name', {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect((await drain(result.description.members)).map((m) => m.version)).toEqual(['1.0.0']);
    expect(hops).toHaveLength(1);
    expect(hops[0]?.headers.get('authorization')).toBeNull();
    expect(hops[0]?.headers.get('user-agent')).toBe('pb-test (ops@example.test)');
  });

  it('ignores a different source url and always asks registry.npmjs.org', async () => {
    const { hops, fetch } = upstream({ 'https://registry.npmjs.org/left-pad': status(404) });
    const source = { ...npmjsSource, url: 'https://evil.example.test' } as ProviderSource;
    await provider.describe(context(fetch), source, 'left-pad', {});
    expect(hops.map((h) => h.url)).toEqual(['https://registry.npmjs.org/left-pad']);
  });

  it('stores a manifest that names a foreign tarball host', async () => {
    const { fetch } = upstream({
      'https://registry.npmjs.org/left-pad': json(
        packument('left-pad', 'https://cdn.example.test/left-pad-1.0.0.tgz'),
      ),
    });
    const result = await provider.describe(context(fetch), npmjsSource, 'left-pad', {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    const [member] = await drain(result.description.members);
    expect(member?.raw).toContain('cdn.example.test');
  });

  it('refuses a foreign tarball host before any request', async () => {
    const { hops, fetch } = upstream({});
    const opening = provider.openDist(
      context(fetch),
      npmjsSource,
      dist('https://cdn.example.test/left-pad-1.0.0.tgz'),
    );
    await expect(opening).rejects.toMatchObject({
      code: 'refused',
      reason: 'foreign_tarball_host',
    });
    expect(hops).toHaveLength(0);
  });

  it('opens a tarball from registry.npmjs.org and from registry.yarnpkg.com', async () => {
    const npm = 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz';
    const yarn = 'https://registry.yarnpkg.com/left-pad/-/left-pad-1.0.0.tgz';
    const { hops, fetch } = upstream({ [npm]: tarball, [yarn]: tarball });
    for (const url of [npm, yarn]) {
      const stream = await provider.openDist(context(fetch), npmjsSource, dist(url));
      expect(new Uint8Array(await new Response(stream.body).arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    }
    expect(hops.map((h) => h.url)).toEqual([npm, yarn]);
  });

  it('refuses an allowed tarball origin that redirects to a foreign public host', async () => {
    const start = 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz';
    const { hops, fetch } = upstream({
      [start]: redirect('https://cdn.example.test/left-pad-1.0.0.tgz'),
      'https://cdn.example.test/left-pad-1.0.0.tgz': tarball,
    });
    const opening = provider.openDist(context(fetch), npmjsSource, dist(start));
    await expect(opening).rejects.toMatchObject({ code: 'refused', reason: 'destination' });
    expect(hops.map((h) => h.url)).toEqual([start]);
  });

  it('follows a redirect between the two allowed origins', async () => {
    const start = 'https://registry.yarnpkg.com/left-pad/-/left-pad-1.0.0.tgz';
    const end = 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz';
    const { hops, fetch } = upstream({ [start]: redirect(end), [end]: tarball });
    await provider.openDist(context(fetch), npmjsSource, dist(start));
    expect(hops.map((h) => h.url)).toEqual([start, end]);
  });

  it('refuses a missing tarball url and a non-200 tarball', async () => {
    const url = 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz';
    const { fetch } = upstream({ [url]: status(404) });
    await expect(provider.openDist(context(fetch), npmjsSource, dist(null))).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(provider.openDist(context(fetch), npmjsSource, dist(url))).rejects.toMatchObject({
      code: 'http_status',
      status: 404,
    });
  });

  it('refuses a credential handed to the proxy', async () => {
    const { hops, fetch } = upstream({});
    await expect(
      provider.describe(context(fetch, ghToken()), npmjsSource, 'left-pad', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'credential' });
    expect(hops).toHaveLength(0);
  });

  it('refuses a source of another type', async () => {
    const { fetch } = upstream({});
    await expect(provider.describe(context(fetch), ghSource, '@acme/x', {})).rejects.toThrow();
  });

  it('refuses a packument redirect to a foreign host', async () => {
    const start = 'https://registry.npmjs.org/left-pad';
    const foreign = 'https://cdn.example.test/left-pad';
    const { hops, fetch } = upstream({
      [start]: redirect(foreign),
      [foreign]: json(packument('left-pad', `${start}/-/left-pad-1.0.0.tgz`)),
    });
    await expect(
      provider.describe(context(fetch), npmjsSource, 'left-pad', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'destination' });
    expect(hops.map((h) => h.url)).toEqual([start]);
  });

  it.each(['../etc', '@scope/..', '@scope/.', '@a/b/c', 'node_modules'])(
    'answers an invalid name %s with a definitive not_found and no request',
    async (name) => {
      const { hops, fetch } = upstream({});
      await expect(provider.describe(context(fetch), npmjsSource, name, {})).resolves.toEqual({
        kind: 'not_found',
        definitive: true,
      });
      expect(hops).toHaveLength(0);
    },
  );

  it('refuses an oversized tarball', async () => {
    const url = 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz';
    const { fetch } = upstream({
      [url]: () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
        }),
    });
    await expect(provider.openDist(context(fetch), npmjsSource, dist(url))).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('reports a size only for an identity-encoded tarball', async () => {
    const plain = 'https://registry.npmjs.org/a/-/a-1.0.0.tgz';
    const gzip = 'https://registry.npmjs.org/b/-/b-1.0.0.tgz';
    const reply = (headers: Record<string, string>) => () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers });
    const { fetch } = upstream({
      [plain]: reply({ 'content-length': '3', 'content-encoding': 'identity' }),
      [gzip]: reply({ 'content-length': '3', 'content-encoding': 'gzip' }),
    });
    expect((await provider.openDist(context(fetch), npmjsSource, dist(plain))).size).toBe(3);
    expect((await provider.openDist(context(fetch), npmjsSource, dist(gzip))).size).toBeNull();
  });
});

describe('npm registry provider (GitHub Packages)', () => {
  const provider = createNpmRegistryProvider(staging);
  const pkgUrl = `${GH}/@acme%2fwidget`;
  const tgz = `${GH}/download/@acme/widget/1.0.0/abc123`;
  const storage = `${GH_STORAGE}/npm/acme/widget/1.0.0.tgz?X-Amz-Signature=sig`;

  it('makes zero upstream requests for a name outside the scopes', async () => {
    const { hops, fetch } = upstream({});
    for (const name of ['@other/widget', 'widget', '@acmex/widget']) {
      const result = await provider.describe(context(fetch, ghToken()), ghSource, name, {});
      expect(result).toEqual({ kind: 'not_found', definitive: true });
    }
    expect(hops).toHaveLength(0);
  });

  it('sends the token to the registry origin for the packument', async () => {
    const { hops, fetch } = upstream({ [pkgUrl]: json(packument('@acme/widget', tgz)) });
    const result = await provider.describe(context(fetch, ghToken()), ghSource, '@acme/widget', {});
    expect(result.kind).toBe('found');
    expect(hops[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([401, 403])('treats %i as an error, never not_found', async (code) => {
    const { hops, fetch } = upstream({ [pkgUrl]: status(code) });
    const error = await provider
      .describe(context(fetch, ghToken()), ghSource, '@acme/widget', {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ code: 'http_status', status: code });
    expect(hops.map((h) => h.url)).toEqual([pkgUrl]);
  });

  it('fetches the storage redirect of a tarball without Authorization', async () => {
    const { hops, fetch } = upstream({ [tgz]: redirect(storage), [storage]: tarball });
    const stream = await provider.openDist(
      context(fetch, ghToken()),
      ghSource,
      dist(tgz, '@acme/widget'),
    );
    await new Response(stream.body).arrayBuffer();
    expect(hops.map((h) => h.url)).toEqual([tgz, storage]);
    expect(hops[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(hops[1]?.headers.get('authorization')).toBeNull();
  });

  it('refuses a tarball redirect to a host the registry does not document', async () => {
    const foreign = 'https://cdn.example.test/widget.tgz';
    const { hops, fetch } = upstream({ [tgz]: redirect(foreign), [foreign]: tarball });
    await expect(
      provider.openDist(context(fetch, ghToken()), ghSource, dist(tgz, '@acme/widget')),
    ).rejects.toMatchObject({ code: 'refused', reason: 'destination' });
    expect(hops.map((h) => h.url)).toEqual([tgz]);
  });

  it('refuses a tarball url outside the registry origin before any request', async () => {
    const { hops, fetch } = upstream({});
    await expect(
      provider.openDist(context(fetch, ghToken()), ghSource, dist(storage, '@acme/widget')),
    ).rejects.toMatchObject({ code: 'refused', reason: 'foreign_tarball_host' });
    expect(hops).toHaveLength(0);
  });

  it.each([401, 403])('treats a %i tarball as an error', async (code) => {
    const { fetch } = upstream({ [tgz]: status(code) });
    await expect(
      provider.openDist(context(fetch, ghToken()), ghSource, dist(tgz, '@acme/widget')),
    ).rejects.toMatchObject({ code: 'http_status', status: code });
  });

  it('refuses a credential bound beyond the registry origin', async () => {
    const wide = bindCredential(
      parseCredentialMaterial('npm_token', JSON.stringify({ token: TOKEN })),
      [GH, GH_STORAGE],
    );
    const { hops, fetch } = upstream({});
    await expect(
      provider.describe(context(fetch, wide), ghSource, '@acme/widget', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'credential' });
    await expect(
      provider.openDist(context(fetch, wide), ghSource, dist(tgz, '@acme/widget')),
    ).rejects.toMatchObject({ code: 'refused', reason: 'credential' });
    expect(hops).toHaveLength(0);
  });

  it('never puts the token into an error message', async () => {
    const { fetch } = upstream({ [pkgUrl]: status(401) });
    const error = await provider
      .describe(context(fetch, ghToken()), ghSource, '@acme/widget', {})
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('refuses an off-origin packument redirect and never sends the token there', async () => {
    const foreign = 'https://cdn.example.test/@acme%2fwidget';
    const { hops, fetch } = upstream({
      [pkgUrl]: redirect(foreign),
      [foreign]: json(packument('@acme/widget', tgz)),
    });
    await expect(
      provider.describe(context(fetch, ghToken()), ghSource, '@acme/widget', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'destination' });
    expect(hops.map((h) => h.url)).toEqual([pkgUrl]);
    expect(hops.filter((h) => h.headers.get('authorization') !== null).map((h) => h.url)).toEqual([
      pkgUrl,
    ]);
  });

  it.each(['@acme/..', '@acme/.', '@acme/a/b', '@acme/'])(
    'answers an invalid scoped name %s with a definitive not_found and no request',
    async (name) => {
      const { hops, fetch } = upstream({});
      await expect(
        provider.describe(context(fetch, ghToken()), ghSource, name, {}),
      ).resolves.toEqual({ kind: 'not_found', definitive: true });
      expect(hops).toHaveLength(0);
    },
  );

  it('refuses a source url that does not parse', async () => {
    const { fetch } = upstream({});
    const broken = { ...ghSource, url: 'not a url' } as ProviderSource;
    await expect(
      provider.describe(context(fetch, null), broken, '@acme/widget', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'source_url' });
  });

  it('refuses a credential bound to no origin', async () => {
    const unbound: UpstreamCredential = {
      origins: [],
      queryParams: [],
      apply: (headers, url) => ({ headers, url }),
    };
    const { hops, fetch } = upstream({});
    await expect(
      provider.describe(context(fetch, unbound), ghSource, '@acme/widget', {}),
    ).rejects.toMatchObject({ code: 'refused', reason: 'credential' });
    expect(hops).toHaveLength(0);
  });

  it('refuses a registry tarball whose path lacks the package scope', async () => {
    const other = `${GH}/download/@other/widget/1.0.0/abc123`;
    const { hops, fetch } = upstream({ [other]: tarball });
    await expect(
      provider.openDist(context(fetch, ghToken()), ghSource, dist(other, '@acme/widget')),
    ).rejects.toMatchObject({ code: 'refused', reason: 'tarball_url' });
    expect(hops).toHaveLength(0);
  });
});
