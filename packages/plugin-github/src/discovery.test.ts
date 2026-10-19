import type { PlanEntry } from '@package-broker/core/plugin';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { describe, expect, it } from 'vitest';
import {
  DiscoveryError,
  PAGE_SIZE,
  discoverRepositories,
  planRepository,
  type PlanRepositoryOptions,
  type DiscoveryOptions,
} from './discovery.js';
import {
  InstallationTokenError,
  createInstallationTokens,
  type InstallationToken,
  type InstallationTokens,
} from './installation-token.js';

const LISTING_TOKEN = 'ghs_listingTokenValue0123456789';
const CONTENTS_TOKEN = 'ghs_contentsTokenValue0123456789';

interface Call {
  readonly url: string;
  readonly headers: Headers;
}

interface Repo {
  readonly name: string;
  readonly archived?: boolean;
  readonly branch?: string;
}

type Files = Record<string, Record<string, Response | string | number>>;

function token(value: string, repositories: readonly string[] | null): InstallationToken {
  return { value, expiresAt: Date.now() + 3600_000, repositories };
}

function setup(repos: readonly Repo[], files: Files, total = repos.length) {
  const calls: Call[] = [];
  const minted: (readonly string[] | null)[] = [];
  const mintIds: string[] = [];
  const observed: { id: string; headers: Headers }[] = [];
  const tokens: InstallationTokens = {
    forListing: async () => {
      minted.push(null);
      return token(LISTING_TOKEN, null);
    },
    forRepositories: async (id, names) => {
      mintIds.push(id);
      minted.push(names);
      return token(CONTENTS_TOKEN, names);
    },
    observe: (id, headers) => {
      observed.push({ id, headers });
    },
    rateLimit: () => undefined,
  };
  const fetch = createPolicyFetch({
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      const parsed = new URL(url);
      if (parsed.pathname === '/installation/repositories') {
        return new Response(
          JSON.stringify({
            total_count: total,
            repositories: repos.map((repo) => ({
              name: repo.name,
              full_name: `acme/${repo.name}`,
              owner: { login: 'acme' },
              archived: repo.archived ?? false,
              default_branch: repo.branch ?? 'main',
            })),
          }),
          { status: 200 },
        );
      }
      const repository = /^\/repos\/acme\/([^/]+)$/.exec(parsed.pathname);
      if (repository) {
        const reply = files[repository[1]!]?.['$repository'];
        if (reply instanceof Response) return reply.clone();
        const repo = repos.find((repo) => repo.name === repository[1]);
        return new Response(
          typeof reply === 'string'
            ? reply
            : JSON.stringify({
                archived: repo?.archived ?? false,
                default_branch: repo?.branch ?? 'main',
              }),
          { status: typeof reply === 'number' ? reply : 200 },
        );
      }
      const match = /^\/repos\/acme\/([^/]+)\/contents\/(.+)$/.exec(parsed.pathname);
      const reply = match ? files[match[1]!]?.[match[2]!] : undefined;
      if (typeof reply === 'string') return new Response(reply, { status: 200 });
      if (typeof reply === 'number') return new Response('{"message":"x"}', { status: reply });
      if (reply instanceof Response) return reply.clone();
      return new Response('{"message":"Not Found"}', { status: 404 });
    },
    policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
    userAgent: 'package-broker-test',
  });
  return { calls, minted, mintIds, observed, tokens, fetch };
}

function run(
  harness: ReturnType<typeof setup>,
  extra: Partial<DiscoveryOptions> = {},
): Promise<{ entries: readonly PlanEntry[]; nextCursor: string | null }> {
  return discoverRepositories({
    tokens: harness.tokens,
    fetch: harness.fetch,
    installationId: '42',
    exists: () => false,
    ...extra,
  });
}

const composer = (name: string) => JSON.stringify({ name });
const npm = (name: string) => JSON.stringify({ name, version: '1.0.0' });

describe('discoverRepositories', () => {
  it('plans composer, npm and empty repositories', async () => {
    const harness = setup(
      [
        { name: 'lib' },
        { name: 'known' },
        { name: 'web' },
        { name: 'empty' },
        { name: 'old', archived: true },
        { name: 'bad' },
      ],
      {
        lib: { 'composer.json': composer('acme/lib') },
        known: { 'composer.json': composer('acme/known') },
        web: { 'package.json': npm('@acme/web') },
        bad: { 'composer.json': composer('Not Valid') },
      },
    );
    const { entries, nextCursor } = await run(harness, {
      exists: (candidate) => candidate.packageName === 'acme/known',
    });
    expect(nextCursor).toBeNull();
    expect(entries).toEqual([
      {
        repository: 'acme/lib',
        ecosystem: 'composer',
        packageName: 'acme/lib',
        action: 'new',
        reason: null,
      },
      {
        repository: 'acme/known',
        ecosystem: 'composer',
        packageName: 'acme/known',
        action: 'existing',
        reason: null,
      },
      {
        repository: 'acme/web',
        ecosystem: 'npm',
        packageName: '@acme/web',
        action: 'skipped',
        reason: 'npm_from_vcs_unsupported',
      },
      {
        repository: 'acme/empty',
        ecosystem: null,
        packageName: null,
        action: 'skipped',
        reason: 'no_manifest',
      },
      {
        repository: 'acme/old',
        ecosystem: null,
        packageName: null,
        action: 'skipped',
        reason: 'archived',
      },
      {
        repository: 'acme/bad',
        ecosystem: 'composer',
        packageName: null,
        action: 'skipped',
        reason: 'invalid_name',
      },
    ]);
  });

  it('uses the listing token for the listing and a narrowed token for contents', async () => {
    const harness = setup([{ name: 'lib' }], { lib: { 'composer.json': composer('acme/lib') } });
    await run(harness);
    expect(harness.minted).toEqual([null, ['lib']]);
    const [list, contents] = harness.calls as [Call, Call];
    expect(list.url).toBe('https://api.github.com/installation/repositories?per_page=49&page=1');
    expect(list.headers.get('authorization')).toBe(`Bearer ${LISTING_TOKEN}`);
    expect(contents.url).toBe(
      'https://api.github.com/repos/acme/lib/contents/composer.json?ref=main',
    );
    expect(contents.headers.get('authorization')).toBe(`Bearer ${CONTENTS_TOKEN}`);
    expect(contents.headers.get('accept')).toBe('application/vnd.github.raw+json');
  });

  it('applies the name pattern before any manifest request', async () => {
    const harness = setup([{ name: 'php-a' }, { name: 'js-b' }, { name: 'PHP-c' }], {
      'php-a': { 'composer.json': composer('acme/a') },
      'PHP-c': { 'composer.json': composer('acme/c') },
    });
    const { entries } = await run(harness, { pattern: 'php-*' });
    expect(entries.map((entry) => [entry.repository, entry.action, entry.reason])).toEqual([
      ['acme/php-a', 'new', null],
      ['acme/js-b', 'skipped', 'filtered_out'],
      ['acme/PHP-c', 'new', null],
    ]);
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/installation/repositories',
      '/repos/acme/php-a/contents/composer.json',
      '/repos/acme/php-a/contents/package.json',
      '/repos/acme/PHP-c/contents/composer.json',
      '/repos/acme/PHP-c/contents/package.json',
    ]);
    expect(harness.minted).toEqual([null, ['php-a', 'PHP-c']]);
  });

  it('makes no manifest request and no contents token when everything is filtered', async () => {
    const harness = setup([{ name: 'a' }, { name: 'b', archived: true }], {});
    const { entries } = await run(harness, { pattern: 'zzz' });
    expect(entries.every((entry) => entry.reason === 'filtered_out')).toBe(true);
    expect(harness.calls).toHaveLength(1);
    expect(harness.minted).toEqual([null]);
  });

  it('keeps listing, token minting and manifests within 101 upstream requests', async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    let binary = '';
    for (const byte of der) binary += String.fromCharCode(byte);
    const pem = `-----BEGIN PRIVATE KEY-----\n${(btoa(binary).match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
    const repos = Array.from({ length: PAGE_SIZE }, (_, i) => ({ name: `r${i}` }));
    const requests: string[] = [];
    const fetch = createPolicyFetch({
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname.endsWith('/access_tokens')) {
          const asked = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
            repositories?: string[];
            permissions: object;
          };
          return new Response(
            JSON.stringify({
              token: 'ghs_mintedTokenValue0123456789',
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: asked.permissions,
              ...(asked.repositories === undefined
                ? {}
                : { repositories: asked.repositories.map((name) => ({ name })) }),
            }),
            { status: 201 },
          );
        }
        if (url.pathname === '/installation/repositories') {
          return new Response(
            JSON.stringify({
              total_count: 120,
              repositories: repos.map((repo) => ({
                name: repo.name,
                owner: { login: 'acme' },
                archived: false,
                default_branch: 'main',
              })),
            }),
            { status: 200 },
          );
        }
        return new Response('{"message":"Not Found"}', { status: 404 });
      },
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      userAgent: 'package-broker-test',
    });
    const tokens = createInstallationTokens({ app: { appId: '1', privateKeyPem: pem }, fetch });
    const { entries, nextCursor } = await discoverRepositories({
      tokens,
      fetch,
      installationId: '42',
      exists: () => false,
    });
    expect(entries).toHaveLength(PAGE_SIZE);
    expect(requests.length).toBeLessThanOrEqual(101);
    expect(requests.filter((line) => line.endsWith('/access_tokens'))).toHaveLength(2);
    expect(nextCursor).toBe('2');
  });

  it('requests the page named by the cursor and ends when the listing is exhausted', async () => {
    const harness = setup([{ name: 'last' }], {}, 51);
    const { nextCursor } = await run(harness, { cursor: '2' });
    expect(harness.calls[0]!.url).toContain('page=2');
    expect(nextCursor).toBeNull();
  });

  it.each(['0', '-1', 'abc', '1.5', '9999999', ''])(
    'rejects cursor %j before any request',
    async (cursor) => {
      const harness = setup([], {});
      const error = await run(harness, { cursor }).catch((e: unknown) => e);
      expect((error as DiscoveryError).code).toBe('invalid_request');
      expect(harness.calls).toHaveLength(0);
    },
  );

  it('rejects an over-long or malformed pattern and installation id', async () => {
    const harness = setup([], {});
    for (const extra of [
      { pattern: 'x'.repeat(101) },
      { pattern: 'a b' },
      { installationId: 'x' },
    ]) {
      const error = await run(harness, extra).catch((e: unknown) => e);
      expect((error as DiscoveryError).code).toBe('invalid_request');
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('maps 451 and a missing branch per repository and keeps the rest of the page', async () => {
    const harness = setup([{ name: 'blocked' }, { name: 'nobranch' }, { name: 'fine' }], {
      blocked: { 'composer.json': 451 },
      nobranch: {
        'composer.json': new Response('{"message":"No commit found for the ref main"}', {
          status: 404,
        }),
      },
      fine: { 'composer.json': composer('acme/fine') },
    });
    const { entries } = await run(harness);
    expect(entries.map((entry) => entry.reason)).toEqual(['error_451', 'error_404', null]);
  });

  it('reads and classifies both manifests independently and keeps both entries', async () => {
    const harness = setup([{ name: 'both' }, { name: 'mixed' }], {
      both: { 'composer.json': composer('acme/both'), 'package.json': npm('both') },
      mixed: { 'composer.json': composer('Not Valid'), 'package.json': npm('mixed') },
    });
    const { entries } = await run(harness);
    expect(entries.map((e) => [e.repository, e.ecosystem, e.action, e.reason])).toEqual([
      ['acme/both', 'composer', 'new', null],
      ['acme/both', 'npm', 'skipped', 'npm_from_vcs_unsupported'],
      ['acme/mixed', 'composer', 'skipped', 'invalid_name'],
      ['acme/mixed', 'npm', 'skipped', 'npm_from_vcs_unsupported'],
    ]);
    expect(harness.calls).toHaveLength(5);
  });

  it('turns a Content-Length over the cap into a per-entry result', async () => {
    const harness = setup([{ name: 'big' }, { name: 'fine' }], {
      big: {
        'composer.json': new Response('{}', {
          status: 200,
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
      },
      fine: { 'composer.json': composer('acme/fine') },
    });
    const { entries } = await run(harness);
    expect(entries.map((e) => e.reason)).toEqual(['invalid_name', null]);
  });

  it('does not carry partial multi-byte state from an oversized manifest to the next one', async () => {
    const chunk = new TextEncoder().encode('\u00e9'.repeat(400 * 1024));
    const big = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk.slice(0, chunk.length - 1));
          controller.enqueue(new Uint8Array(300 * 1024).fill(0x61));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const harness = setup([{ name: 'big' }, { name: 'fine' }], {
      big: { 'composer.json': big },
      fine: { 'composer.json': composer('acme/fine') },
    });
    const { entries } = await run(harness);
    expect(entries.map((e) => [e.packageName, e.reason])).toEqual([
      [null, 'invalid_name'],
      ['acme/fine', null],
    ]);
  });

  it('rejects dot-only repository names, non-https origins and keeps the cursor on short pages', async () => {
    const dots = setup([{ name: '..' }], {});
    expect(((await run(dots).catch((e: unknown) => e)) as DiscoveryError).code).toBe(
      'invalid_response',
    );
    const plain = setup([], {});
    const error = await run(plain, { apiOrigin: 'http://api.github.com' }).catch((e: unknown) => e);
    expect((error as DiscoveryError).code).toBe('invalid_request');
    const short = setup([{ name: 'a' }], {}, 500);
    expect((await run(short)).nextCursor).toBe('2');
  });

  it('accepts valid Git branch names with plus signs and Unicode', async () => {
    const harness = setup(
      [
        { name: 'plus', branch: 'release+1' },
        { name: 'uni', branch: 'wörld/ü' },
        { name: 'skip', branch: 'x y', archived: true },
      ],
      {},
    );
    const error = await run(harness).catch((e: unknown) => e);
    expect((error as DiscoveryError).code).toBe('invalid_response');
    const ok = setup(
      [
        { name: 'plus', branch: 'release+1' },
        { name: 'uni', branch: 'wörld/ü' },
      ],
      {},
    );
    const { entries } = await run(ok);
    expect(entries.map((e) => e.reason)).toEqual(['no_manifest', 'no_manifest']);
    expect(ok.calls[1]!.url).toContain('ref=release%2B1');
  });

  it('matches adversarial names and patterns in bounded time', async () => {
    const harness = setup([{ name: 'a'.repeat(100) }, { name: 'ok' }], {
      ['a'.repeat(100)]: { 'composer.json': composer(`${'a'.repeat(200)}!`) },
      ok: { 'composer.json': composer(`${'a-'.repeat(60)}!/x`) },
    });
    const { entries } = await run(harness, { pattern: '*a'.repeat(40) + 'b' });
    expect(entries.map((e) => e.reason)).toEqual(['filtered_out', 'filtered_out']);
    const second = setup([{ name: 'a'.repeat(100) }, { name: 'ok' }], {
      ['a'.repeat(100)]: { 'composer.json': composer(`${'a'.repeat(200)}!`) },
      ok: { 'composer.json': composer(`${'a-'.repeat(60)}!/x`) },
    });
    const result = await run(second);
    expect(result.entries.map((e) => e.reason)).toEqual(['invalid_name', 'invalid_name']);
  });

  it('treats an oversized or non-object manifest as an invalid name', async () => {
    const harness = setup([{ name: 'big' }, { name: 'arr' }], {
      big: { 'composer.json': new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }) },
      arr: { 'composer.json': '[]' },
    });
    const { entries } = await run(harness);
    expect(entries.map((entry) => entry.reason)).toEqual(['invalid_name', 'invalid_name']);
  });

  it('fails the page on a rate limit without leaking the token', async () => {
    const harness = setup([{ name: 'a' }], {
      a: {
        'composer.json': new Response(`limit ${CONTENTS_TOKEN}`, {
          status: 403,
          headers: { 'retry-after': '30' },
        }),
      },
    });
    const error = await run(harness).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).code).toBe('rate_limited');
    expect((error as DiscoveryError).retryAfter).toBe(30);
    expect(`${(error as Error).message}${JSON.stringify(error)}`).not.toContain(CONTENTS_TOKEN);
  });

  it('fails on a malformed listing', async () => {
    const harness = setup([], {});
    const broken = createPolicyFetch({
      fetchImpl: async () => new Response('{"repositories":"no"}', { status: 200 }),
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      userAgent: 'package-broker-test',
    });
    const error = await run(harness, { fetch: broken }).catch((e: unknown) => e);
    expect((error as DiscoveryError).code).toBe('invalid_response');
  });
});

function planOne(harness: ReturnType<typeof setup>, extra: Partial<PlanRepositoryOptions> = {}) {
  return planRepository({
    tokens: harness.tokens,
    fetch: harness.fetch,
    installationId: '42',
    repository: 'acme/lib',
    exists: () => false,
    ...extra,
  });
}

describe('planRepository', () => {
  const cases: { label: string; repo?: Partial<Repo>; files: Files[string]; existing?: boolean }[] =
    [
      { label: 'archived', repo: { archived: true }, files: {} },
      { label: 'no manifest', files: {} },
      { label: 'invalid name', files: { 'composer.json': composer('Not Valid') } },
      { label: 'npm', files: { 'package.json': npm('@acme/lib') } },
      {
        label: 'missing ref',
        files: {
          'composer.json': new Response('{"message":"No commit found for the ref main"}', {
            status: 404,
          }),
        },
      },
      { label: '451', files: { 'composer.json': 451 } },
      { label: 'existing', files: { 'composer.json': composer('acme/lib') }, existing: true },
      { label: 'new', files: { 'composer.json': composer('acme/lib') } },
      {
        label: 'both manifests',
        files: { 'composer.json': composer('acme/lib'), 'package.json': npm('lib') },
      },
      { label: 'malformed manifest', files: { 'composer.json': '{' } },
      { label: 'non-object manifest', files: { 'composer.json': '[]' } },
      {
        label: 'oversized manifest',
        files: {
          'composer.json': new Response('{}', {
            headers: { 'content-length': String(1024 * 1024 + 1) },
          }),
        },
      },
    ];

  it.each(cases)('matches the page entry for $label', async ({ repo, files, existing }) => {
    const harness = setup([{ name: 'lib', ...repo }], { lib: files });
    const exists = () => existing ?? false;
    const page = await run(harness, { exists });
    const entry = await planOne(harness, { exists });
    expect(entry).toEqual(page.entries[0]);
    expect(entry.reason).not.toBe('filtered_out');
  });

  it('does not fetch manifests for an archived repository', async () => {
    const harness = setup([{ name: 'lib', archived: true }], {});
    expect((await planOne(harness)).reason).toBe('archived');
    expect(harness.calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/acme/lib',
    ]);
  });

  it('uses one narrowed token and observes all three responses when manifests are absent', async () => {
    const harness = setup([{ name: 'lib', branch: 'release+1' }], {});
    const installationId = '12345678901234567890';
    expect((await planOne(harness, { installationId })).reason).toBe('no_manifest');
    expect(harness.minted).toEqual([['lib']]);
    expect(harness.mintIds).toEqual([installationId]);
    expect(harness.calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/acme/lib',
      'https://api.github.com/repos/acme/lib/contents/composer.json?ref=release%2B1',
      'https://api.github.com/repos/acme/lib/contents/package.json?ref=release%2B1',
    ]);
    expect(
      harness.calls.every(
        (call) => call.headers.get('authorization') === `Bearer ${CONTENTS_TOKEN}`,
      ),
    ).toBe(true);
    expect(harness.observed).toHaveLength(3);
    expect(
      harness.observed.every(
        (item) => item.id === installationId && item.headers instanceof Headers,
      ),
    ).toBe(true);
  });

  it.each([
    'lib',
    'acme/lib/extra',
    '/lib',
    'acme/',
    'acme/..',
    '../lib',
    'ac me/lib',
    'acme/li b',
    'acme/lib\n',
    'acme\n/lib',
    'acme/li%62',
    'acme/é',
    'a'.repeat(40) + '/lib',
    'acme/' + 'a'.repeat(101),
  ])('rejects repository %j before minting or fetching', async (repository) => {
    const harness = setup([], {});
    await expect(planOne(harness, { repository })).rejects.toMatchObject({
      name: 'DiscoveryError',
      code: 'invalid_request',
    });
    expect(harness.calls).toHaveLength(0);
    expect(harness.minted).toHaveLength(0);
  });

  it.each(['', '0', '-1', '01', 'abc', '1.5', '42\n', '1'.repeat(21)])(
    'rejects installation id %j before minting or fetching',
    async (installationId) => {
      const harness = setup([], {});
      await expect(planOne(harness, { installationId })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(harness.calls).toHaveLength(0);
      expect(harness.minted).toHaveLength(0);
    },
  );

  it.each(['not_found', 'unprocessable'] as const)(
    'maps token mint failure %s to an unavailable repository',
    async (code) => {
      const harness = setup([], {});
      harness.tokens.forRepositories = async () => {
        throw new InstallationTokenError(code);
      };
      expect(await planOne(harness)).toEqual({
        repository: 'acme/lib',
        ecosystem: null,
        packageName: null,
        action: 'skipped',
        reason: 'error_404',
      });
      expect(harness.calls).toHaveLength(0);
    },
  );

  it.each([
    new InstallationTokenError('unauthorized'),
    new InstallationTokenError('forbidden'),
    new InstallationTokenError('rate_limited'),
    new Error('unrelated failure'),
  ])('propagates unrelated token mint failure %s', async (error) => {
    const harness = setup([], {});
    harness.tokens.forRepositories = async () => {
      throw error;
    };
    await expect(planOne(harness)).rejects.toBe(error);
    expect(harness.calls).toHaveLength(0);
  });

  it.each([404, 451])('maps repository status %i without manifest requests', async (status) => {
    const harness = setup([{ name: 'lib' }], { lib: { $repository: status } });
    expect(await planOne(harness)).toEqual({
      repository: 'acme/lib',
      ecosystem: null,
      packageName: null,
      action: 'skipped',
      reason: `error_${status}`,
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.observed).toHaveLength(1);
  });

  it.each(['{', '[]', '{}', '{"archived":false,"default_branch":"a b"}'])(
    'rejects malformed repository metadata %j',
    async (body) => {
      const harness = setup([{ name: 'lib' }], { lib: { $repository: body } });
      await expect(planOne(harness)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(harness.calls).toHaveLength(1);
    },
  );

  it('shares rate-limit handling for repository reads', async () => {
    const harness = setup([{ name: 'lib' }], {
      lib: { $repository: new Response('{}', { status: 403, headers: { 'retry-after': '30' } }) },
    });
    await expect(planOne(harness)).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30 });
    expect(harness.observed).toHaveLength(1);
  });
});
