import { describe, expect, it } from 'vitest';
import { createPolicyFetch, type UpstreamCredential } from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { baseOf, ComposerRootError, readComposerRoot, type ComposerRootSource } from './root.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const SHA = 'a'.repeat(64);

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
      packages: { 'a/b': { '1.0.0': { name: 'a/b' } } },
    });
    const root = await readComposerRoot(fetch, source('https://r.example.com'));
    expect(root.mode).toBe('v2');
    expect(root.providersUrl).toBeUndefined();
    expect(root.partialPackages).toBe(true);
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
    expect((await read({})).inlinePackages).toBe(false);
    const v2 = await read({ 'metadata-url': '/p2/%package%.json', ...inline });
    expect(v2).toMatchObject({ inlinePackages: true, partialPackages: true });
    const lazy = await read({ 'providers-lazy-url': '/p/%package%.json', ...inline });
    expect(lazy.inlinePackages).toBe(true);
  });

  it('reads available-package-patterns only for metadata-url roots', async () => {
    const { fetch } = setup({
      'providers-url': '/p/%package%$%hash%.json',
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
