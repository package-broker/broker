import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { ProviderContext, ProviderSource } from '@package-broker/core/sources/provider';
import { lsRefs } from '@package-broker/core/sources/git/refs';
import { GitFetchError, readFileAtRefs } from '@package-broker/core/sources/git/fetch';
import { InstallationTokenError, type InstallationTokens } from './installation-token.js';
import { createGithubProvider, RateLimited } from './provider.js';

vi.mock('@package-broker/core/sources/git/refs', () => ({ lsRefs: vi.fn() }));
vi.mock('@package-broker/core/sources/git/fetch', async (original) => ({
  ...(await original<typeof import('@package-broker/core/sources/git/fetch')>()),
  readFileAtRefs: vi.fn(),
}));
const sha = 'a'.repeat(40);
const source = {
  id: 'source',
  type: 'vcs',
  ecosystem: 'composer',
  url: null,
  config: {
    provider: 'github',
    repository: 'owner/repo',
    installationId: 12,
    refs: { tags: true, branches: [] },
  },
} satisfies ProviderSource;
function setup(
  status = 200,
  headers: Record<string, string> = {},
  metadata = { archived: true, default_branch: 'main', full_name: 'owner/repo' },
  redirect = `https://codeload.github.com/owner/repo/legacy.zip/${sha}`,
) {
  const hops: { url: string; headers: Headers }[] = [];
  const fetch = createPolicyFetch({
    policy: createOutboundPolicy({ runtime: 'node', selfOrigins: [], allowPrivateHosts: [] }),
    userAgent: 'test',
    fetchImpl: async (input, init) => {
      const url = String(input);
      hops.push({ url, headers: new Headers(init?.headers) });
      if (url.includes('/zipball/'))
        return new Response(null, {
          status: 302,
          headers: { location: redirect },
        });
      if (url.includes('codeload.github.com'))
        return new Response('archive', { headers: { 'content-length': '7' } });
      return new Response(JSON.stringify(metadata), {
        status,
        headers,
      });
    },
  });
  const tokens: InstallationTokens = {
    forRepositories: vi.fn(async () => ({
      value: 'fixture-token',
      expiresAt: 1e15,
      repositories: ['repo'],
    })),
    forListing: vi.fn(),
    observe: vi.fn(),
    rateLimit: vi.fn(),
  };
  const ctx = {
    fetch,
    signal: new AbortController().signal,
    credential: null,
    clock: { now: () => new Date(1_700_000_000_000) },
  } as ProviderContext;
  const tokensFor = vi.fn<(source: ProviderSource) => InstallationTokens | null>(() => tokens);
  const provider = createGithubProvider({ tokensFor, runtime: 'docker' });
  return { provider, ctx, tokens, tokensFor, hops };
}
beforeEach(() => {
  vi.mocked(lsRefs)
    .mockReset()
    .mockResolvedValue({ refs: [{ name: 'refs/tags/v1.0.0', oid: sha }], skipped: 0 });
  vi.mocked(readFileAtRefs)
    .mockReset()
    .mockResolvedValue([
      {
        ref: 'refs/tags/v1.0.0',
        commit: sha,
        committedAt: null,
        text: '{"name":"vendor/package"}',
      },
    ]);
});
describe('GitHub provider', () => {
  it('narrows tokens to one repository and binds Basic Git auth to github.com', async () => {
    const { provider, ctx, tokens } = setup();
    await provider.describe(ctx, source, 'vendor/package', {});
    expect(tokens.forRepositories).toHaveBeenCalledWith('12', ['repo']);
    const credential = vi.mocked(lsRefs).mock.calls[0]![2]!;
    expect(credential.origins).toEqual(['https://github.com']);
    expect(
      credential
        .apply(new Headers(), new URL('https://github.com/owner/repo.git'))
        .headers.get('authorization'),
    ).toBe(`Basic ${btoa('x-access-token:fixture-token')}`);
    expect(
      credential
        .apply(new Headers(), new URL('https://other.example/'))
        .headers.has('authorization'),
    ).toBe(false);
    expect(vi.mocked(readFileAtRefs).mock.calls[0]![0].credential).toBe(credential);
  });
  it('emits zipball metadata and marks archived repositories abandoned', async () => {
    const { provider, ctx } = setup();
    const result = await provider.describe(ctx, source, 'vendor/package', {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('missing description');
    expect(result.description.upstreamComplete).toBe(false);
    const members = [];
    for await (const member of result.description.members) members.push(JSON.parse(member.raw));
    expect(members[0]).toMatchObject({
      abandoned: true,
      version: 'v1.0.0',
      dist: {
        type: 'zip',
        url: `https://api.github.com/repos/owner/repo/zipball/${sha}`,
        reference: sha,
        shasum: '',
      },
    });
    expect(result.description.upstreamComplete).toBe(true);
  });
  it.each([404, 451])(
    'skips repository status %s without describing or listing complete',
    async (status) => {
      const { provider, ctx } = setup(status);
      await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
        code: 'skipped',
        status,
      });
      expect(lsRefs).not.toHaveBeenCalled();
      await expect(provider.listPackages!(ctx, source, null)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    },
  );
  it.each([200, 403, 429])(
    'returns typed rate limit with reset time for status %s',
    async (status) => {
      const { provider, ctx } = setup(status, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '4',
        'x-ratelimit-reset': '1700001800',
      });
      const error = await provider
        .describe(ctx, source, 'vendor/package', {})
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RateLimited);
      expect(error).toMatchObject({ resetEpochSeconds: 1700001800 });
      expect(lsRefs).not.toHaveBeenCalled();
    },
  );
  it('drops authorization on the codeload hop', async () => {
    const { provider, ctx, hops } = setup();
    const dist = await provider.openDist(ctx, source, {
      packageName: 'vendor/package',
      version: '1.0.0',
      distType: 'zip',
      sourceRef: sha,
      url: null,
    });
    expect(await new Response(dist.body).text()).toBe('archive');
    expect(dist.size).toBe(7);
    expect(hops[0]!.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(hops[1]!.headers.has('authorization')).toBe(false);
  });
  it.each(['missing', 'too_large', 'bad_tree'] as const)(
    'keeps %s manifest results incomplete',
    async (reason) => {
      vi.mocked(readFileAtRefs).mockResolvedValue([
        { ref: 'refs/tags/v1.0.0', commit: sha, committedAt: null, text: null, reason },
      ]);
      const { provider, ctx } = setup();
      const result = await provider.describe(ctx, source, 'vendor/package', {});
      if (result.kind !== 'found') throw new Error('missing description');
      for await (const member of result.description.members) void member;
      expect(result.description.upstreamComplete).toBe(false);
    },
  );
  it('propagates missing objects instead of treating them as removal', async () => {
    const error = new GitFetchError('missing_object');
    vi.mocked(readFileAtRefs).mockRejectedValue(error);
    const { provider, ctx } = setup();
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toBe(error);
  });
  it('refuses arbitrary dist destinations and invalid commit references', async () => {
    const { provider, ctx, hops } = setup();
    await expect(
      provider.openDist(ctx, source, {
        packageName: 'vendor/package',
        version: '1',
        distType: 'zip',
        sourceRef: '../main',
        url: 'https://evil.example/file',
      }),
    ).rejects.toThrow();
    expect(hops).toEqual([]);
  });
});

async function described(
  provider: ReturnType<typeof createGithubProvider>,
  ctx: ProviderContext,
  input = source,
) {
  const result = await provider.describe(ctx, input, 'vendor/package', {});
  if (result.kind !== 'found') throw new Error('missing description');
  const members = [];
  for await (const member of result.description.members) members.push(member);
  return { description: result.description, members };
}
const target = {
  packageName: 'vendor/package',
  version: '1',
  distType: 'zip' as const,
  sourceRef: sha,
  url: null,
};

describe('GitHub provider review regressions', () => {
  it('resolves a separate token service per source and reuses it across syncs', async () => {
    const { provider, ctx, tokens, tokensFor } = setup();
    const other = { ...source, id: 'other' };
    const otherTokens = {
      ...tokens,
      forRepositories: vi.fn(async () => ({
        value: 'other-fixture-token',
        expiresAt: 1e15,
        repositories: ['repo'],
      })),
    };
    tokensFor.mockImplementation((input: ProviderSource) =>
      input.id === other.id ? otherTokens : tokens,
    );
    await described(provider, ctx);
    await described(provider, ctx, other);
    await described(provider, ctx);
    expect(tokensFor.mock.calls.map(([input]) => input.id)).toEqual(['source', 'other', 'source']);
    expect(tokens.forRepositories).toHaveBeenCalledTimes(2);
    expect(otherTokens.forRepositories).toHaveBeenCalledTimes(1);
  });
  it('refuses sources without a github_app credential', async () => {
    const { provider, ctx, tokens, tokensFor, hops } = setup();
    tokensFor.mockReturnValue(null);
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(tokens.forRepositories).not.toHaveBeenCalled();
    expect(hops).toEqual([]);
  });
  it.each([
    '../repo',
    'owner/..',
    'owner/repo?x',
    'https://github.com/owner/repo',
    'owner/repo/extra',
  ])('refuses invalid repository %s before token minting', async (repository) => {
    const { provider, ctx, tokens } = setup();
    await expect(
      provider.describe(
        ctx,
        { ...source, config: { ...source.config, repository } },
        'vendor/package',
        {},
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(tokens.forRepositories).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid installationId or a missing token credential (%s)',
    async (installationId) => {
      const { provider, ctx, tokens } = setup();
      await expect(
        provider.describe(
          ctx,
          {
            ...source,
            config: {
              provider: 'github',
              repository: source.config.repository,
              refs: source.config.refs,
              ...(installationId === undefined ? {} : { installationId }),
            },
          },
          'vendor/package',
          {},
        ),
      ).rejects.toMatchObject(
        installationId === undefined
          ? { name: 'UpstreamError', code: 'http_status', status: 401 }
          : { code: 'invalid_request' },
      );
      expect(tokens.forRepositories).not.toHaveBeenCalled();
    },
  );
  it.each(['not_found', 'unprocessable'] as const)(
    'skips token narrowing error %s',
    async (code) => {
      const { provider, ctx, tokens } = setup();
      vi.mocked(tokens.forRepositories).mockRejectedValue(new InstallationTokenError(code));
      await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
        code: 'skipped',
      });
      expect(lsRefs).not.toHaveBeenCalled();
    },
  );
  it.each([{ rateLimit: { limit: 100, remaining: 0, reset: 1700001800 } }, { retryAfter: 60 }])(
    'maps token mint rate limits to RateLimited',
    async (backOff) => {
      const { provider, ctx, tokens } = setup();
      vi.mocked(tokens.forRepositories).mockRejectedValue(
        new InstallationTokenError('rate_limited', 429, backOff),
      );
      await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
        name: 'RateLimited',
        resetEpochSeconds: backOff.rateLimit?.reset ?? 1700000060,
      });
    },
  );
  it.each([
    ['999999999999999', 1700003600],
    ['-5', 1700000001],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 1700000001],
  ])('bounds retry-after %s to the next hour', async (retryAfter, reset) => {
    const { provider, ctx } = setup(429, { 'retry-after': retryAfter });
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
      name: 'RateLimited',
      resetEpochSeconds: reset,
    });
  });
  it.each([403, 429])('honors retry-after without primary rate headers on %s', async (status) => {
    const { provider, ctx } = setup(status, { 'retry-after': '60' });
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
      name: 'RateLimited',
      resetEpochSeconds: 1700000060,
    });
  });
  it('treats a bare 429 as RateLimited', async () => {
    const { provider, ctx } = setup(429);
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
      name: 'RateLimited',
    });
  });
  it('rejects a repository transferred to another owner', async () => {
    const { provider, ctx } = setup(
      200,
      {},
      { archived: false, default_branch: 'main', full_name: 'other/repo' },
    );
    await expect(provider.describe(ctx, source, 'vendor/package', {})).rejects.toMatchObject({
      code: 'skipped',
    });
    expect(lsRefs).not.toHaveBeenCalled();
  });
  it('accepts repository casing differences', async () => {
    const { provider, ctx } = setup(
      200,
      {},
      { archived: false, default_branch: 'main', full_name: 'OWNER/REPO' },
    );
    expect((await described(provider, ctx)).description.upstreamComplete).toBe(true);
  });
  it('keeps the snapshot stable when unrelated repository metadata changes', async () => {
    const first = setup();
    const second = setup(200, {}, {
      archived: true,
      default_branch: 'main',
      full_name: 'owner/repo',
      stargazers_count: 99,
    } as Parameters<typeof setup>[2]);
    expect((await described(first.provider, first.ctx)).description.snapshot).toEqual(
      (await described(second.provider, second.ctx)).description.snapshot,
    );
  });
  it('fails a changed continuation snapshot before reading manifests', async () => {
    const { provider, ctx } = setup();
    const { description } = await described(provider, ctx);
    vi.mocked(readFileAtRefs).mockClear();
    vi.mocked(lsRefs).mockResolvedValue({
      refs: [{ name: 'refs/tags/v1.0.0', oid: 'b'.repeat(40) }],
      skipped: 0,
    });
    await expect(
      provider.describe(ctx, source, 'vendor/package', { snapshot: description.snapshot }),
    ).rejects.toMatchObject({ code: 'snapshot_changed' });
    expect(readFileAtRefs).not.toHaveBeenCalled();
  });
  it('accepts an unchanged continuation snapshot', async () => {
    const { provider, ctx } = setup();
    const { description } = await described(provider, ctx);
    await expect(
      provider.describe(ctx, source, 'vendor/package', { snapshot: description.snapshot }),
    ).resolves.toMatchObject({ kind: 'found' });
  });
  it('reads only winning refs and ignores malformed names for completeness', async () => {
    const winner = { name: 'refs/tags/1.0.0', oid: sha };
    vi.mocked(lsRefs).mockResolvedValue({
      refs: [
        winner,
        { name: 'refs/tags/v1.0.0', oid: sha },
        { name: 'refs/tags/nonsense', oid: sha },
      ],
      skipped: 1,
    });
    vi.mocked(readFileAtRefs).mockResolvedValue([
      { ref: winner.name, commit: sha, committedAt: null, text: '{"name":"vendor/package"}' },
    ]);
    const { provider, ctx } = setup();
    expect((await described(provider, ctx)).description.upstreamComplete).toBe(true);
    expect(vi.mocked(readFileAtRefs).mock.calls[0]![2]).toEqual([winner]);
  });
  it('canonicalizes manifest names, replaces source metadata and strips transport keys', async () => {
    const committedAt = '2026-10-16T00:00:00Z';
    vi.mocked(readFileAtRefs).mockResolvedValue([
      {
        ref: 'refs/tags/v1.0.0',
        commit: sha,
        committedAt,
        text: JSON.stringify({
          name: 'Vendor/Package',
          source: { url: 'https://other.example' },
          abandoned: 'old/package',
          support: { source: 'https://other.example' },
          'notification-url': 'https://other.example',
        }),
      },
    ]);
    const { provider, ctx } = setup(
      200,
      {},
      { archived: false, default_branch: 'main', full_name: 'owner/repo' },
    );
    const { members, description } = await described(provider, ctx);
    expect(description.upstreamComplete).toBe(true);
    expect(members[0]?.upstreamTime).toBe(committedAt);
    const raw = JSON.parse(members[0]!.raw);
    expect(raw.source).toEqual({
      type: 'git',
      url: 'https://github.com/owner/repo.git',
      reference: sha,
    });
    expect(raw).not.toHaveProperty('abandoned');
    expect(raw).not.toHaveProperty('support');
    expect(raw).not.toHaveProperty('notification-url');
  });
  it.each(['other/package', 'invalid name'])(
    'rejects manifest name %s without completeness',
    async (name) => {
      vi.mocked(readFileAtRefs).mockResolvedValue([
        { ref: 'refs/tags/v1.0.0', commit: sha, committedAt: null, text: JSON.stringify({ name }) },
      ]);
      const { provider, ctx } = setup();
      const { description, members } = await described(provider, ctx);
      expect(members).toEqual([]);
      expect(description.upstreamComplete).toBe(false);
    },
  );
  it('checks the configured package name too', async () => {
    const { provider, ctx } = setup();
    const input = { ...source, config: { ...source.config, packageName: 'other/package' } };
    const { description, members } = await described(provider, ctx, input);
    expect(members).toEqual([]);
    expect(description.upstreamComplete).toBe(false);
  });
  it('refuses a valid SHA paired with an arbitrary dist URL', async () => {
    const { provider, ctx, hops } = setup();
    await expect(
      provider.openDist(ctx, source, { ...target, url: 'https://evil.example/file' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(hops).toEqual([]);
  });
  it('refuses an invalid SHA with no dist URL', async () => {
    const { provider, ctx, hops } = setup();
    await expect(
      provider.openDist(ctx, source, { ...target, sourceRef: '../main' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(hops).toEqual([]);
  });
  it('refuses a zipball redirect to an unapproved host', async () => {
    const { provider, ctx, hops } = setup(200, {}, undefined, 'https://evil.example/file');
    await expect(provider.openDist(ctx, source, target)).rejects.toMatchObject({ code: 'refused' });
    expect(hops).toHaveLength(1);
  });
  it.each([404, 451])('keeps dist status %s retryable rather than skipped', async (status) => {
    const { provider, ctx } = setup();
    const fetch = vi.fn(async () => ({ status, headers: new Headers(), body: null }));
    await expect(provider.openDist({ ...ctx, fetch }, source, target)).rejects.toMatchObject({
      code: 'http_status',
      status,
    });
  });
  it('combines request cancellation with context cancellation and pins Git destinations', async () => {
    const { provider, ctx } = setup();
    const abort = new AbortController();
    const fetch = vi.fn(ctx.fetch);
    vi.mocked(lsRefs).mockImplementationOnce(async (policyFetch) => {
      const pending = policyFetch({
        url: 'https://github.com/owner/repo.git/info/refs',
        method: 'GET',
        purpose: 'git',
        maxBytes: 1024,
        timeoutMs: 1000,
        signal: abort.signal,
      });
      const request = fetch.mock.calls.at(-1)![0];
      expect(request.destinations).toEqual(['https://github.com']);
      abort.abort();
      expect(request.signal?.aborted).toBe(true);
      await pending;
      return { refs: [], skipped: 0 };
    });
    await provider.describe({ ...ctx, fetch }, source, 'vendor/package', {});
  });
});

describe('token source request controls', () => {
  const tokenSource = {
    ...source,
    config: { provider: 'github', repository: 'owner/repo', refs: { tags: true, branches: [] } },
  } satisfies ProviderSource;
  function tokenContext() {
    const result = setup();
    const ctx: { -readonly [K in keyof ProviderContext]: ProviderContext[K] } = {
      ...result.ctx,
      credential: {
        origins: ['https://api.github.com'],
        queryParams: [],
        apply(headers, url) {
          headers.set('authorization', 'Bearer private-sentinel');
          return { headers, url };
        },
      },
    };
    return { ...result, ctx };
  }
  it.each([
    [undefined, 1700000060],
    ['1', 1700000001],
    ['9999999999', 1700003600],
  ])('clamps GraphQL reset %s using the context clock', async (reset, expected) => {
    const { provider, ctx } = tokenContext();
    ctx.fetch = async (request) => ({
      status: 200,
      headers: new Headers(
        reset === undefined
          ? {}
          : {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4999',
              'x-ratelimit-reset': reset,
            },
      ),
      body: Response.json(
        request.url.endsWith('/graphql')
          ? { errors: [{ type: 'RATE_LIMITED', message: 'private-sentinel' }] }
          : request.url.includes('/tags?')
            ? [{ name: 'v1.0.0', commit: { sha } }]
            : { archived: false, default_branch: 'main', full_name: 'owner/repo' },
      ).body,
    });
    await expect(provider.describe(ctx, tokenSource, 'vendor/package', {})).rejects.toMatchObject({
      code: 'rate_limited',
      resetEpochSeconds: expected,
      message: 'GitHub rate limit exhausted',
    });
  });
  it('stops assigning branches after the first rejection while other workers finish', async () => {
    const { provider, ctx } = tokenContext();
    const pending: (() => void)[] = [];
    const requested: string[] = [];
    ctx.fetch = async (request) => {
      if (request.url.includes('/branches/')) {
        requested.push(request.url);
        if (request.url.endsWith('/b0')) throw new Error('BranchLookupFailed');
        await new Promise<void>((resolve) => pending.push(resolve));
        return {
          status: 200,
          headers: new Headers(),
          body: Response.json({
            name: request.url.split('/').at(-1),
            commit: { sha },
          }).body,
        };
      }
      return {
        status: 200,
        headers: new Headers(),
        body: Response.json({
          archived: false,
          default_branch: 'main',
          full_name: 'owner/repo',
        }).body,
      };
    };
    const answer = provider.describe(
      ctx,
      {
        ...tokenSource,
        config: {
          ...tokenSource.config,
          refs: {
            tags: false,
            branches: Array.from({ length: 12 }, (_, index) => `b${index}`),
          },
        },
      },
      'vendor/package',
      {},
    );
    await expect(answer).rejects.toThrow('BranchLookupFailed');
    expect(requested).toHaveLength(4);
    pending.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toHaveLength(4);
  });
});
