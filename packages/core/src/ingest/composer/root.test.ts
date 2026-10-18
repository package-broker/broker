import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { createPolicyFetch, type UpstreamCredential } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import {
  baseOf,
  ComposerRootError,
  readComposerRoot as readRoot,
  type ComposerRootSource,
} from './root.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const SHA = 'a'.repeat(64);

const fixtureFetches = new WeakMap<
  Parameters<typeof readRoot>[0],
  () => Parameters<typeof readRoot>[0]
>();
async function readComposerRoot(...args: Parameters<typeof readRoot>): ReturnType<typeof readRoot> {
  const [fetch, source, streaming] = args;
  const replay = fixtureFetches.get(fetch);
  if (replay === undefined || streaming !== undefined) return readRoot(...args);
  const results = await Promise.allSettled(
    [undefined, STREAMING].map((options) =>
      readRoot(options === undefined ? fetch : replay(), source, options),
    ),
  );
  const comparable = results.map((result) => {
    if (result.status === 'fulfilled') return result.value;
    expect(result.reason).toBeInstanceOf(ComposerRootError);
    const { code, field, status } = result.reason as ComposerRootError;
    return { code, field, status };
  });
  expect(comparable[1]).toEqual(comparable[0]);
  const buffered = results[0]!;
  if (buffered.status === 'rejected') throw buffered.reason;
  return buffered.value;
}

function setup(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
  raw?: string,
): { requests: string[]; fetch: ReturnType<typeof createPolicyFetch> } {
  const requests: string[] = [];
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(raw ?? JSON.stringify(body), { status, headers });
    },
  });
  fixtureFetches.set(fetch, () => setup(body, headers, status, raw).fetch);
  return { requests, fetch };
}

function source(url: string, extra: Partial<ComposerRootSource> = {}): ComposerRootSource {
  return { url, policy, allowedOrigins: [], ...extra };
}

describe('readComposerRoot fixtures', () => {
  it('classifies packagist as v2 with an absolute-path metadata-url', async () => {
    const { fetch, requests } = setup(
      {
        'notify-batch': '/downloads/',
        search: 'https://packagist.org/search.json?q=%query%&type=%type%',
        'metadata-url': '/p2/%package%.json',
        'metadata-changes-url': 'https://packagist.org/metadata/changes.json',
        'providers-api': 'https://packagist.org/providers/%package%.json',
        list: 'https://packagist.org/packages/list.json',
        'security-advisories': {
          metadata: true,
          'api-url': 'https://packagist.org/api/security-advisories/',
        },
      },
      { etag: '"abc"', 'last-modified': 'Wed, 14 Oct 2026 10:00:00 GMT' },
    );
    const root = await readComposerRoot(
      fetch,
      source('https://repo.packagist.org', { allowedOrigins: ['https://packagist.org'] }),
    );
    expect(requests).toEqual(['https://repo.packagist.org/packages.json']);
    expect(root.mode).toBe('v2');
    expect(root.metadataUrl).toBe('https://repo.packagist.org/p2/%package%.json');
    expect(root.metadataChangesUrl).toBe('https://packagist.org/metadata/changes.json');
    expect(root.validator).toMatchObject({
      etag: '"abc"',
      lastModified: 'Wed, 14 Oct 2026 10:00:00 GMT',
    });
    expect(root.validator.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(root.availablePackages).toBeUndefined();
  });

  it('classifies Satis as v2, ignores legacy includes and records available-packages lowercased', async () => {
    const { fetch, requests } = setup({
      includes: { 'include/all$0123abcd.json': { sha1: 'b'.repeat(40) } },
      'metadata-url': '/p2/%package%.json',
      'available-packages': ['Fixture/Lib', 'fixture/other'],
    });
    const root = await readComposerRoot(fetch, source('https://satis.example.com/repo'));
    expect(root.mode).toBe('v2');
    expect(root.metadataUrl).toBe('https://satis.example.com/p2/%package%.json');
    expect(root.availablePackages).toEqual(['fixture/lib', 'fixture/other']);
    expect(root.includes).toBeUndefined();
    expect(requests).toEqual(['https://satis.example.com/repo/packages.json']);
  });

  it('resolves Drupal metadata-url outside /8/ against packages.json', async () => {
    const { fetch, requests } = setup({
      'metadata-url': '/files/packages/8/p2/%package%.json',
      'metadata-changes-url': '/8/metadata/changes.json',
      'available-package-patterns': ['drupal/*'],
      'security-advisories': { metadata: true, 'api-url': 'https://packages.drupal.org/8/api' },
    });
    const root = await readComposerRoot(fetch, source('https://packages.drupal.org/8'));
    expect(root.packagesJsonUrl).toBe('https://packages.drupal.org/8/packages.json');
    expect(root.metadataUrl).toBe('https://packages.drupal.org/files/packages/8/p2/%package%.json');
    expect(root.metadataChangesUrl).toBe('https://packages.drupal.org/8/metadata/changes.json');
    expect(root.availablePatterns).toEqual(['drupal/*']);
    expect(requests).toEqual(['https://packages.drupal.org/8/packages.json']);
  });

  it('classifies wpackagist as v1-providers with hash-bearing includes and no validators', async () => {
    const { fetch, requests } = setup({
      packages: [],
      'providers-url': '/p/%package%$%hash%.json',
      'provider-includes': {
        'p/provider-2024$%hash%.json': { sha256: SHA },
        'p/provider-latest$%hash%.json': { sha256: 'c'.repeat(64) },
      },
      'available-package-patterns': ['wpackagist-plugin/*', 'wpackagist-theme/*'],
    });
    const root = await readComposerRoot(fetch, source('https://wpackagist.org'));
    expect(root.mode).toBe('v1-providers');
    expect(root.metadataUrl).toBeUndefined();
    expect(root.providersUrl).toBe('https://wpackagist.org/p/%package%$%hash%.json');
    expect(root.providerIncludes).toEqual([
      { url: `https://wpackagist.org/p/provider-2024%24${SHA}.json`, sha256: SHA },
      {
        url: `https://wpackagist.org/p/provider-latest%24${'c'.repeat(64)}.json`,
        sha256: 'c'.repeat(64),
      },
    ]);
    expect(root.availablePatterns).toBeUndefined();
    expect(root.availablePackages).toBeUndefined();
    expect(root.validator.etag).toBeUndefined();
    expect(root.validator.lastModified).toBeUndefined();
    expect(requests).toEqual(['https://wpackagist.org/packages.json']);
    expect(root.validator.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('classifies repo.magento.com as v1-providers with a body hash validator', async () => {
    const { fetch, requests } = setup(
      {
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'p/providers-a$%hash%.json': { sha256: SHA } },
        'available-packages': ['magento/ignored'],
      },
      { 'set-cookie': '__cf_bm=x' },
    );
    const root = await readComposerRoot(fetch, source('https://repo.magento.com'));
    expect(requests).toEqual(['https://repo.magento.com/packages.json']);
    expect(root.mode).toBe('v1-providers');
    expect(root.availablePackages).toBeUndefined();
    expect(root.validator.etag).toBeUndefined();
  });
});

describe('readComposerRoot precedence', () => {
  it('lets metadata-url win over providers and includes', async () => {
    const { fetch, requests } = setup({
      'metadata-url': '/p2/%package%.json',
      'providers-url': '/p/%package%$%hash%.json',
      packages: [],
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.mode).toBe('v2');
    expect(root.providersUrl).toBeUndefined();
    expect(root.partialPackages).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('prefers providers-url over providers-lazy-url and inline packages', async () => {
    const { fetch, requests } = setup({
      'providers-url': '/p/%package%$%hash%.json',
      'providers-lazy-url': '/lazy/%package%.json',
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.mode).toBe('v1-providers');
    expect(root.providersLazyUrl).toBe('https://r.example.com/lazy/%package%.json');
    expect(requests).toHaveLength(1);
  });

  it('classifies providers-lazy-url alone as v1-lazy', async () => {
    const { fetch, requests } = setup({
      'providers-lazy-url': 'https://lazy.example.com/p/%package%.json',
    });
    const root = await readComposerRoot(
      fetch,
      source('https://r.example.com', { allowedOrigins: ['https://lazy.example.com'] }),
    );
    expect(root.mode).toBe('v1-lazy');
    expect(root.providersLazyUrl).toBe('https://lazy.example.com/p/%package%.json');
    expect(requests).toHaveLength(1);
  });

  it('classifies inline packages and includes as v1-includes', async () => {
    const { fetch, requests } = setup({
      packages: { 'a/b': {} },
      includes: { 'all$ff.json': { sha1: 'd'.repeat(40) } },
      providers: {},
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com/packages.json'));
    expect(root.mode).toBe('v1-includes');
    expect(root.includes?.[0]?.url).toBe('https://r.example.com/all%24ff.json');
    expect(requests).toHaveLength(1);
  });

  it('refuses inline providers without a providers url', async () => {
    const { fetch } = setup({ providers: { 'a/b': { sha256: SHA } } });
    await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
      name: 'ComposerRootError',
      code: 'unsupported',
    });
  });
});

describe.each([
  ['buffered', undefined],
  ['streamed', () => STREAMING],
] as const)(
  'readComposerRoot fails closed on shapes it cannot interpret (%s)',
  (_path, options) => {
    const unsupported = async (body: unknown): Promise<ComposerRootError> => {
      const { fetch } = setup(body);
      const error = await readRoot(fetch, source('https://r.example.com'), options?.()).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ComposerRootError);
      expect(error).toMatchObject({ code: 'unsupported' });
      return error as ComposerRootError;
    };

    it('refuses a legacy root keyed by package name', async () => {
      const error = await unsupported({
        'fx/lib': { versions: { '1.0.0': { name: 'fx/lib', version: '1.0.0' } } },
      });
      expect(error.field).toBe('packages');
    });

    it('refuses an empty root and a root with only unrelated keys', async () => {
      await unsupported({});
      await unsupported({ 'notify-batch': '/downloads/' });
    });

    it('refuses includes that are not an object when there is no packages key', async () => {
      await unsupported({ includes: ['a.json'] });
    });

    it.each([null, false, 0, 'packages', ['a/b'], [{}]].map((packages) => ({ packages })))(
      'refuses a malformed packages container: $packages',
      async ({ packages }) => {
        for (const extra of [{}, { includes: {} }, { 'metadata-url': '/p2/%package%.json' }]) {
          const error = await unsupported({ ...extra, packages });
          expect(error.field).toBe('packages');
        }
      },
    );

    it('refuses inline packages next to a metadata-url', async () => {
      const error = await unsupported({
        'metadata-url': '/p2/%package%.json',
        packages: { 'fx/inline': { '1.0.0': { name: 'fx/inline' } } },
      });
      expect(error.field).toBe('packages');
    });

    it.each([{ packages: [] }, { packages: {} }])(
      'still accepts empty packages $packages next to a metadata-url',
      async ({ packages }) => {
        const { fetch } = setup({ 'metadata-url': '/p2/%package%.json', packages });
        const root = await readRoot(fetch, source('https://r.example.com'), options?.());
        expect(root).toMatchObject({ mode: 'v2', inlinePackages: false, partialPackages: false });
      },
    );

    it('refuses providers-url when no provider file is listed', async () => {
      const error = await unsupported({ 'providers-url': '/p/%package%$%hash%.json' });
      expect(error.field).toBe('provider-includes');
    });

    it('refuses provider-includes without providers-url', async () => {
      await unsupported({
        packages: [],
        'provider-includes': { 'p/all$%hash%.json': { sha256: SHA } },
      });
    });

    it.each([{ packages: [] }, { packages: {} }])(
      'accepts empty packages $packages as an empty repository',
      async ({ packages }) => {
        const { fetch } = setup({ packages });
        const root = await readRoot(fetch, source('https://r.example.com'), options?.());
        expect(root).toMatchObject({ mode: 'v1-includes', inlinePackages: false });
      },
    );
  },
);

describe('readComposerRoot hygiene', () => {
  it('keeps mirrors internal and exposes no ignored endpoint', async () => {
    const { fetch, requests } = setup({
      'metadata-url': '/p2/%package%.json',
      mirrors: [
        { 'dist-url': 'https://m.example.com/%package%.%type%', preferred: true },
        { 'dist-url': 5 },
        'x',
      ],
      notify: '/notify/%package%',
      'notify-batch': '/notify-batch',
      search: '/search.json?q=%query%',
      'providers-api': '/providers/%package%.json',
      list: '/list.json',
      'security-advisories': { 'api-url': 'https://r.example.com/api/' },
    });
    const root = await readComposerRoot(
      fetch,
      source('https://r.example.com', { allowedOrigins: ['https://m.example.com'] }),
    );
    const text = JSON.stringify(root);
    for (const key of ['notify', 'search', 'providers-api', 'api-url', '/list.json']) {
      expect(text).not.toContain(key);
    }
    expect(root.mirrors).toEqual([
      { distUrl: 'https://m.example.com/%package%.%type%', preferred: true },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('records warning and info messages with their version constraints', async () => {
    const { fetch } = setup({
      'metadata-url': '/p2/%package%.json',
      warning: 'Update composer',
      'warning-versions': '<2.0',
      info: 'Hello',
      warnings: [{ message: 'second', versions: '>=1' }],
      infos: [{ message: 'third' }],
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.messages).toEqual([
      { type: 'warning', message: 'Update composer', versions: '<2.0' },
      { type: 'info', message: 'Hello' },
      { type: 'warning', message: 'second', versions: '>=1' },
      { type: 'info', message: 'third' },
    ]);
  });

  it('re-checks every resolved url against the policy', async () => {
    const { fetch, requests } = setup({
      'metadata-url': 'http://169.254.169.254/p2/%package%.json',
    });
    const error = await readComposerRoot(fetch, source('https://r.example.com')).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ComposerRootError);
    expect(error).toMatchObject({ code: 'refused', field: 'metadata-url' });
    expect(String((error as Error).message)).not.toContain('169.254');
    expect(requests).toHaveLength(1);
  });

  it('refuses a providers-url that points at a private host', async () => {
    const { fetch } = setup({ 'providers-url': 'https://10.0.0.1/p/%package%$%hash%.json' });
    await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
      code: 'refused',
      field: 'providers-url',
    });
  });

  it('throws on a non-200 status without echoing the url', async () => {
    const { fetch } = setup({}, {}, 401);
    const error = await readComposerRoot(fetch, source('https://r.example.com')).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'http_status', status: 401 });
    expect(String((error as Error).message)).not.toContain('r.example.com');
  });

  it('throws on a body that is not a JSON object', async () => {
    for (const raw of ['<html>', '[]', 'null', '"x"']) {
      const { fetch } = setup(null, {}, 200, raw);
      await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
        code: 'invalid',
      });
    }
  });

  it('refuses a source url the policy refuses before any request', async () => {
    const { fetch, requests } = setup({});
    await expect(readComposerRoot(fetch, source('http://10.0.0.1'))).rejects.toMatchObject({
      code: 'refused',
      field: 'url',
    });
    expect(requests).toHaveLength(0);
  });

  it('keeps the %package% placeholder intact in a relative metadata-url with a query', async () => {
    const { fetch } = setup({ 'metadata-url': 'p2/%package%.json?v=1' });
    const root = await readComposerRoot(fetch, source('https://r.example.com/repo'));
    expect(root.metadataUrl).toBe('https://r.example.com/repo/p2/%package%.json?v=1');
  });
});

describe('readComposerRoot origins and limits', () => {
  const refused = async (
    body: unknown,
    extra: Partial<ComposerRootSource> = {},
    url = 'https://r.example.com',
  ): Promise<ComposerRootError> => {
    const { fetch } = setup(body);
    const error = await readComposerRoot(fetch, source(url, extra)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComposerRootError);
    return error as ComposerRootError;
  };

  it.each([
    ['metadata-url', { 'metadata-url': 'https://other.example.net/p2/%package%.json' }],
    [
      'metadata-changes-url',
      { 'metadata-url': '/p2/%package%.json', 'metadata-changes-url': 'https://o.example.net/c' },
    ],
    ['providers-url', { 'providers-url': 'https://other.example.net/p/%package%$%hash%.json' }],
    ['providers-lazy-url', { 'providers-lazy-url': 'https://other.example.net/p/%package%.json' }],
  ])('refuses a cross-host %s with a typed error', async (field, body) => {
    const error = await refused(body);
    expect(error).toMatchObject({ code: 'origin', field });
  });

  it('refuses an include key that leaves the base through a query, fragment or backslash', async () => {
    for (const key of ['a.json?x=1', 'a.json#f', 'a\\b.json']) {
      const error = await refused({ packages: { 'a/b': {} }, includes: { [key]: {} } });
      expect(error).toMatchObject({ code: 'invalid', field: 'includes' });
    }
  });

  it('refuses IPv6-mapped and decimal IPv4 hosts even when listed as allowed', async () => {
    for (const host of ['[::ffff:127.0.0.1]', '2130706433', '[::1]']) {
      const origin = `https://${host}`;
      const error = await refused(
        { 'metadata-url': `${origin}/p2/%package%.json` },
        { allowedOrigins: [origin] },
      );
      expect(error).toMatchObject({ code: 'refused', field: 'metadata-url' });
    }
  });

  it('keeps a protocol-relative template on the repository origin', async () => {
    const { fetch } = setup({
      'metadata-url': '//evil.example.net/p2/%package%.json',
      'providers-lazy-url': '//evil.example.net/p/%package%.json',
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.metadataUrl).toBe('https://r.example.com//evil.example.net/p2/%package%.json');
  });

  it('refuses a non-absolute providers-url that does not start with a slash', async () => {
    const error = await refused({ 'providers-url': 'p/%package%$%hash%.json' });
    expect(error).toMatchObject({ code: 'invalid', field: 'providers-url' });
  });

  it('refuses %package% in the host or userinfo', async () => {
    for (const template of [
      'https://%package%.example.com/p2.json',
      'https://%package%@r.example.com/p2.json',
      'https://user:%package%@r.example.com/p2.json',
    ]) {
      const error = await refused({ 'metadata-url': template });
      expect(['invalid', 'refused']).toContain(error.code);
    }
  });

  it('refuses a redirect off the repository origins', async () => {
    const requests: string[] = [];
    const fetch = createPolicyFetch({
      policy,
      userAgent: 'pb-test/1',
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.net/x' },
        });
      },
    });
    const error = await readComposerRoot(fetch, source('https://r.example.com')).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'refused', field: 'destination' });
    expect(requests).toEqual(['https://r.example.com/packages.json']);
  });

  it('follows a redirect to an allowed origin', async () => {
    const fetch = createPolicyFetch({
      policy,
      userAgent: 'pb-test/1',
      fetchImpl: async (input) =>
        String(input).startsWith('https://r.example.com')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/p.json' },
            })
          : new Response(JSON.stringify({ 'metadata-url': '/p2/%package%.json' })),
    });
    const root = await readComposerRoot(
      fetch,
      source('https://r.example.com', { allowedOrigins: ['https://cdn.example.com'] }),
    );
    expect(root.mode).toBe('v2');
  });

  it('fails a root over the 1 MiB default as too_large', async () => {
    const { fetch } = setup({ packages: { x: 'y'.repeat(1024 * 1024 + 1) } });
    await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
      name: 'ComposerRootError',
      code: 'too_large',
    });
  });

  it('refuses a provider include without a valid sha256', async () => {
    for (const value of [{ sha256: 'zz' }, {}, 'x', { sha1: 'a'.repeat(40) }]) {
      const error = await refused({
        'providers-url': '/p/%package%$%hash%.json',
        'provider-includes': { 'p/a$%hash%.json': value },
      });
      expect(error).toMatchObject({ code: 'invalid', field: 'provider-includes' });
    }
  });

  it('caps includes at 1000 and accepts exactly 1000', async () => {
    const make = (n: number): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`i/${i}$ff.json`, {}]));
    const over = await refused({ packages: { 'a/b': {} }, includes: make(1001) });
    expect(over).toMatchObject({ code: 'invalid', field: 'includes' });
    const { fetch } = setup({ packages: { 'a/b': {} }, includes: make(1000) });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.includes).toHaveLength(1000);
  });

  it('classifies packages: {} as v1-includes without includes', async () => {
    const { fetch } = setup({ packages: {} });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.mode).toBe('v1-includes');
    expect(root.includes).toBeUndefined();
    expect(root.partialPackages).toBe(false);
  });

  it('replaces only the first dollar sign in include keys', async () => {
    const { fetch } = setup({ packages: { 'a/b': {} }, includes: { 'a$b$c.json': {} } });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.includes?.[0]?.url).toBe('https://r.example.com/a%24b$c.json');
  });

  it.each(['p/a?b.json', 'p/a#b.json', 'p/a\\b.json'])(
    'still refuses include key %s',
    async (key) => {
      const { fetch } = setup({ packages: { 'a/b': {} }, includes: { [key]: {} } });
      await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
        code: 'invalid',
        field: 'includes',
      });
    },
  );

  it('reports inlinePackages for every mode', async () => {
    const inline = { packages: { 'a/b': {} } };
    const read = async (body: unknown) =>
      readComposerRoot(setup(body).fetch, source('https://r.example.com'));
    expect((await read(inline)).inlinePackages).toBe(true);
    expect((await read({ packages: {} })).inlinePackages).toBe(false);
    expect((await read({ 'metadata-url': '/p2/%package%.json' })).inlinePackages).toBe(false);
    const lazy = await read({ 'providers-lazy-url': '/p/%package%.json', ...inline });
    expect(lazy.inlinePackages).toBe(true);
  });

  it('reads available-package-patterns only for metadata-url roots', async () => {
    const { fetch } = setup({
      'providers-url': '/p/%package%$%hash%.json',
      providers: { 'a/b': { sha256: SHA } },
      'available-package-patterns': ['a/*'],
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.availablePatterns).toBeUndefined();
  });

  it('caps mirrors at 16', async () => {
    const mirrors = Array.from({ length: 30 }, (_, i) => ({ distUrl: `/m/${i}/%package%.zip` }));
    const { fetch } = setup({ 'metadata-url': '/p2/%package%.json', mirrors });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.mirrors).toHaveLength(16);
  });

  it('puts no credential in errors', async () => {
    const secret = 'sek-ret-987';
    const credential: UpstreamCredential = {
      origins: ['https://r.example.com'],
      queryParams: ['token'],
      apply(headers, url) {
        headers.set('authorization', `Bearer ${secret}`);
        url.searchParams.set('token', secret);
        return { headers, url };
      },
    };
    const errors: unknown[] = [];
    for (const [body, status] of [
      [{}, 401],
      [{ 'metadata-url': 'https://other.example.net/%package%' }, 200],
    ] as const) {
      const { fetch } = setup(body, {}, status);
      errors.push(
        await readComposerRoot(fetch, source('https://r.example.com', { credential })).catch(
          (e: unknown) => e,
        ),
      );
    }
    for (const error of errors) {
      expect(error).toBeInstanceOf(ComposerRootError);
      const text = `${(error as Error).message}${(error as Error).stack}${JSON.stringify(error)}`;
      expect(text).not.toContain(secret);
    }
  });
});

describe('readComposerRoot mirrors and allowed origins', () => {
  it('skips a refused mirror, keeps an allowed one and records mirror_refused', async () => {
    const { fetch } = setup({
      'metadata-url': '/p2/%package%.json',
      mirrors: [
        { 'dist-url': 'https://other.example.net/%package%.zip' },
        { 'dist-url': 'https://10.0.0.1/%package%.zip' },
        { 'dist-url': 'https://m.example.com/%package%.zip', preferred: true },
      ],
    });
    const root = await readComposerRoot(
      fetch,
      source('https://r.example.com', { allowedOrigins: ['https://m.example.com'] }),
    );
    expect(root.mode).toBe('v2');
    expect(root.mirrors).toEqual([
      { distUrl: 'https://m.example.com/%package%.zip', preferred: true },
    ]);
    expect(root.messages).toEqual([{ type: 'warning', message: 'mirror_refused' }]);
  });

  it.each(['ftp://m.example.com', 'not a url', 'javascript:alert(1)'])(
    'rejects the allowed origin %s',
    async (origin) => {
      const { fetch, requests } = setup({ 'metadata-url': '/p2/%package%.json' });
      await expect(
        readComposerRoot(fetch, source('https://r.example.com', { allowedOrigins: [origin] })),
      ).rejects.toMatchObject({ code: 'invalid', field: 'allowedOrigins' });
      expect(requests).toHaveLength(0);
    },
  );
});

describe('baseOf', () => {
  it.each([
    ['https://r.example.com/packages.json', 'https://r.example.com'],
    ['https://r.example.com/repo/packages.json', 'https://r.example.com/repo'],
    ['https://r.example.com/repo/', 'https://r.example.com/repo'],
    ['https://r.example.com/repo//', 'https://r.example.com/repo'],
    ['https://r.example.com/repo/packages.json?token=x#frag', 'https://r.example.com/repo'],
  ])('derives the base of %s', (input, expected) => {
    expect(baseOf(input)).toBe(expected);
  });
});

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

const STREAMING = { codecs, maxDocumentBytes: 32 * 1024 * 1024 };

function chunked(text: string, size = 64 * 1024): Response {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) controller.close();
        else {
          controller.enqueue(bytes.subarray(at, at + size));
          at += size;
        }
      },
    }),
    { status: 200, headers: { etag: '"e"' } },
  );
}

function serve(text: string): ReturnType<typeof createPolicyFetch> {
  return createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async () => chunked(text),
  });
}

const STREAM_FIXTURES: Record<string, { body: unknown; extra?: Partial<ComposerRootSource> }> = {
  packagist: {
    body: {
      'metadata-url': '/p2/%package%.json',
      'metadata-changes-url': 'https://packagist.org/metadata/changes.json',
      list: 'https://packagist.org/packages/list.json',
    },
    extra: { allowedOrigins: ['https://packagist.org'] },
  },
  satisMetadata: {
    body: {
      includes: { 'include/all$0123abcd.json': { sha1: 'b'.repeat(40) } },
      'metadata-url': '/p2/%package%.json',
      'available-packages': ['Fixture/Lib', 'fixture/other'],
      'available-package-patterns': ['fixture/*'],
    },
  },
  wpackagist: {
    body: {
      'providers-url': '/p/%package%$%hash%.json',
      'provider-includes': { 'p/provider-a$%hash%.json': { sha256: 'c'.repeat(64) } },
      'providers-lazy-url': '/lazy/%package%.json',
      packages: { 'a/b': {} },
      warning: 'w',
      'warning-versions': '<1',
      info: 'i',
      'info-versions': '>2',
      warnings: [{ message: 'many', versions: '*' }],
      infos: [{ message: 'more' }],
    },
  },
  lazy: { body: { 'providers-lazy-url': '/lazy/%package%.json', packages: {} } },
  inlineProviders: {
    body: {
      'providers-url': '/p/%package%.json',
      providers: { 'a/b': { sha256: 'd'.repeat(64) } },
    },
  },
  includes: {
    body: {
      packages: { 'a/b': { '1.0.0': { name: 'a/b' } } },
      includes: { 'include/all$0123abcd.json': { sha1: 'b'.repeat(40) } },
      mirrors: [
        { 'dist-url': 'https://mirror.example.com/%package%/%version%.zip', preferred: true },
        { 'dist-url': 'https://evil.example.net/x.zip' },
      ],
    },
    extra: { allowedOrigins: ['https://mirror.example.com'] },
  },
  emptyPackages: { body: { packages: {}, includes: {} } },
  packagesArray: { body: { packages: [] } },
};

const STREAM_REFUSAL_FIXTURES = {
  empty: {},
  satis: {
    includes: { 'include/all$0123abcd.json': { sha1: 'b'.repeat(40) } },
    'metadata-url': '/p2/%package%.json',
    'available-packages': ['Fixture/Lib', 'fixture/other'],
    'available-package-patterns': ['fixture/*'],
    packages: { 'a/b': { '1.0.0': {} } },
  },
};

describe('readComposerRoot streaming path', () => {
  it.each(Object.entries(STREAM_FIXTURES))('matches the buffered path for %s', async (_n, f) => {
    const text = JSON.stringify(f.body);
    const src = source('https://r.example.com', f.extra);
    const buffered = await readComposerRoot(
      setup(undefined, { etag: '"e"' }, 200, text).fetch,
      src,
    );
    const streamed = await readComposerRoot(serve(text), src, STREAMING);
    expect(streamed).toEqual(buffered);
    expect(streamed.validator.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it.each(Object.entries(STREAM_REFUSAL_FIXTURES))(
    'matches the buffered refusal for %s',
    async (_name, body) => {
      const text = JSON.stringify(body);
      const errors = await Promise.all(
        [undefined, STREAMING].map((options) =>
          readRoot(serve(text), source('https://r.example.com'), options).catch(
            (error: unknown) => error,
          ),
        ),
      );
      const verdicts = errors.map((error) => {
        expect(error).toBeInstanceOf(ComposerRootError);
        expect(error).toMatchObject({ code: 'unsupported', field: 'packages' });
        const { code, field } = error as ComposerRootError;
        return { code, field };
      });
      expect(verdicts[1]).toEqual(verdicts[0]);
    },
  );

  it('classifies 20,000 inline packages in 5 MiB as v1-includes without holding them', async () => {
    const packages = Object.fromEntries(
      Array.from({ length: 20_000 }, (_v, i) => [
        `vendor/pkg-${i}`,
        { '1.0.0': { name: `vendor/pkg-${i}`, description: 'x'.repeat(240) } },
      ]),
    );
    const text = JSON.stringify({ packages });
    expect(text.length).toBeGreaterThan(5 * 1024 * 1024);
    const root = await readComposerRoot(serve(text), source('https://r.example.com'), STREAMING);
    expect(root.mode).toBe('v1-includes');
    expect(root.inlinePackages).toBe(true);
  });

  it('caps the retained non-inline fields at source.maxBytes', async () => {
    const includes = Object.fromEntries(
      Array.from({ length: 200 }, (_v, i) => [`include/${i}$0.json`, { sha1: 'b'.repeat(40) }]),
    );
    const text = JSON.stringify({ includes });
    await expect(
      readComposerRoot(serve(text), source('https://r.example.com', { maxBytes: 1024 }), STREAMING),
    ).rejects.toMatchObject({ code: 'too_large' });
    const ok = await readComposerRoot(serve(text), source('https://r.example.com'), STREAMING);
    expect(ok.includes).toHaveLength(200);
  });

  it('fails a document over maxDocumentBytes as too_large', async () => {
    const text = JSON.stringify({ packages: { x: { y: 'z'.repeat(5000) } } });
    await expect(
      readComposerRoot(serve(text), source('https://r.example.com'), {
        codecs,
        maxDocumentBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it.each([
    ['a duplicate top-level key', '{"metadata-url":"/a","metadata-url":"/b"}'],
    ['a non-object document', '[1,2]'],
    ['a scalar document', '"text"'],
    ['a truncated body', '{"packages":{"a/b":{"1.0.0":{'],
    ['an empty body', ''],
  ])('rejects %s as invalid', async (_n, text) => {
    await expect(
      readComposerRoot(serve(text), source('https://r.example.com'), STREAMING),
    ).rejects.toMatchObject({ name: 'ComposerRootError', code: 'invalid', field: 'body' });
  });

  it('keeps the buffered behaviour without options', async () => {
    const { fetch } = setup({ packages: { x: 'y'.repeat(1024 * 1024 + 1) } });
    await expect(readComposerRoot(fetch, source('https://r.example.com'))).rejects.toMatchObject({
      code: 'too_large',
    });
  });
});

describe('readComposerRoot streaming regressions', () => {
  it.each([1, 2, 3, 65536])(
    'strips a leading BOM across %i-byte chunks after hashing',
    async (size) => {
      const text = '\uFEFF' + JSON.stringify({ includes: {} });
      const src = source('https://r.example.com');
      const buffered = await readComposerRoot(
        setup(undefined, { etag: '"e"' }, 200, text).fetch,
        src,
      );
      const fetch = createPolicyFetch({
        policy,
        userAgent: 'pb-test/1',
        fetchImpl: async () => chunked(text, size),
      });
      expect(await readComposerRoot(fetch, src, STREAMING)).toEqual(buffered);
      expect(buffered.validator.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    },
  );

  it('counts retained UTF-8 bytes near the cap', async () => {
    const text = JSON.stringify({ info: '界'.repeat(10), warning: '界'.repeat(10), packages: {} });
    const read = (maxBytes: number) =>
      readComposerRoot(serve(text), source('https://r.example.com', { maxBytes }), STREAMING);
    expect((await read(64)).messages).toHaveLength(2);
    await expect(read(63)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('allows a retained includes field above the inline member cap', async () => {
    const text = JSON.stringify({
      includes: Object.fromEntries(
        Array.from({ length: 900 }, (_, i) => [`${i}-${'x'.repeat(1200)}.json`, {}]),
      ),
    });
    const src = source('https://r.example.com', { maxBytes: 2 * 1024 * 1024 });
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const buffered = await readComposerRoot(serve(text), src);
    expect(await readComposerRoot(serve(text), src, STREAMING)).toEqual(buffered);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid streaming limits: %s', async (value) => {
    for (const [extra, limits] of [
      [{}, { ...STREAMING, maxDocumentBytes: value }],
      [{}, { ...STREAMING, maxMemberBytes: value }],
      [{ maxBytes: value }, STREAMING],
    ] as const) {
      const fetch = vi.fn();
      await expect(
        readComposerRoot(fetch, source('https://r.example.com', extra), limits),
      ).rejects.toMatchObject({ name: 'ComposerRootError', code: 'invalid', field: 'limits' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('preserves an unrelated stream TypeError', async () => {
    const error = new TypeError('stream failed');
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw error;
      },
    });
    await expect(
      readComposerRoot(
        async () => ({ status: 200, headers: new Headers(), body }),
        source('https://r.example.com'),
        STREAMING,
      ),
    ).rejects.toBe(error);
  });

  it.each([
    [
      'invalid UTF-8',
      new Uint8Array([
        ...new TextEncoder().encode('{"info":"'),
        0xc3,
        0x28,
        ...new TextEncoder().encode('"}'),
      ]),
    ],
    [
      'deep nesting',
      new TextEncoder().encode('{"info":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}'),
    ],
    ['upstream bytes', new TextEncoder().encode('{"info":{"BODY_SENTINEL_477":!}}')],
  ])('sanitizes %s errors', async (_name, bytes) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const error = await readComposerRoot(
      async () => ({ status: 200, headers: new Headers(), body }),
      source('https://r.example.com'),
      STREAMING,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'ComposerRootError',
      code: 'invalid',
      field: 'body',
      message: 'composer root invalid: body',
    });
    expect(JSON.stringify(error)).not.toContain('BODY_SENTINEL_477');
    expect(String(error)).not.toContain('BODY_SENTINEL_477');
  });

  it('cancels the reader and releases stream locks on a retained-size failure', async () => {
    const cancel = vi.fn();
    let at = 0;
    const chunks = ['{"info":"' + 'x'.repeat(40) + '",', '"packages":{', '"a/b":{}}}'];
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (at < chunks.length) c.enqueue(new TextEncoder().encode(chunks[at++]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const tapped: ReadableStream<Uint8Array>[] = [];
    const observingCodecs: typeof codecs = {
      digestTap(algs) {
        const tap = codecs.digestTap(algs);
        tapped.push(tap.transform.readable);
        return tap;
      },
    };
    await expect(
      readComposerRoot(
        async () => ({ status: 200, headers: new Headers(), body }),
        source('https://r.example.com', { maxBytes: 16 }),
        { ...STREAMING, codecs: observingCodecs },
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(tapped[0]?.locked).toBe(false);
    });
    expect(at).toBeLessThan(chunks.length);
  });
});

it('keeps the inline member cap when retained fields have a larger allowance', async () => {
  const text = JSON.stringify({ packages: { 'vendor/a': { description: 'x'.repeat(100) } } });
  await expect(
    readComposerRoot(serve(text), source('https://r.example.com', { maxBytes: 1024 }), {
      ...STREAMING,
      maxMemberBytes: 64,
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
});

it('maps a stalled streamed body timeout without exposing body bytes', async () => {
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"info":"BODY_SENTINEL_477'));
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('BODY_SENTINEL_477')),
              { once: true },
            );
          },
        }),
      ),
  });
  const error = await readComposerRoot(
    fetch,
    source('https://r.example.com', { timeoutMs: 20 }),
    STREAMING,
  ).catch((e: unknown) => e);
  expect(error).toMatchObject({
    name: 'ComposerRootError',
    code: 'timeout',
    message: 'composer root timeout',
  });
  expect(JSON.stringify(error)).not.toContain('BODY_SENTINEL_477');
  expect(String(error)).not.toContain('BODY_SENTINEL_477');
});
