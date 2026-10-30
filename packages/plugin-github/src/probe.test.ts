import { describe, expect, it, vi } from 'vitest';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { InstallationTokenError, type InstallationTokens } from './installation-token.js';
import { probeComposerBlob, probeRootTree } from './probe.js';

const treeSha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);
const complete = { sha: treeSha, truncated: false, tree: [] };
const composer = { path: 'composer.json', type: 'blob', mode: '100644', sha: blobSha };
function setup(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  const tokens: InstallationTokens = {
    forRepositoryIds: vi.fn(async () => ({
      value: 'fixture-token',
      expiresAt: 1e15,
      repositories: [],
      repositoryIds: [7],
    })),
    forRepositories: vi.fn(),
    forListing: vi.fn(),
    observe: vi.fn(),
    retryAfterSeconds: vi.fn(),
    rateLimit: vi.fn(),
  };
  const fetch = createPolicyFetch({
    policy: createOutboundPolicy({ runtime: 'node', selfOrigins: [], allowPrivateHosts: [] }),
    userAgent: 'test',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), { status, headers });
    },
  });
  return {
    options: { fetch, tokens, installationId: '12', repositoryId: 7, repository: 'owner/repo' },
    calls,
    tokens,
  };
}

describe('GitHub import probe', () => {
  it('proves root presence and absence with one nonrecursive tree request', async () => {
    const { options, calls, tokens } = setup({
      ...complete,
      tree: [composer, { path: 'marker', type: 'tree', sha: treeSha }],
    });
    await expect(probeRootTree(options, 'feature/branch')).resolves.toEqual({
      kind: 'complete',
      treeSha,
      rootEntries: ['composer.json', 'marker'],
      composerBlobSha: blobSha,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/owner/repo/git/trees/feature/branch');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(tokens.forRepositoryIds).toHaveBeenCalledWith('12', [7]);
    expect(tokens.forRepositories).not.toHaveBeenCalled();
    expect(tokens.observe).toHaveBeenCalledOnce();
  });

  it('encodes each branch segment while preserving slash separators', async () => {
    const { options, calls } = setup(complete);
    await probeRootTree(options, 'feature/x#y%z');
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/owner/repo/git/trees/feature/x%23y%25z',
    );
  });

  it.each([
    [403, {}, { reason: 'access' }],
    [404, {}, { reason: 'access' }],
    [429, {}, { reason: 'rate_limited' }],
    [429, { 'retry-after': '17' }, { reason: 'rate_limited', retryAfterSeconds: 17 }],
    [403, { 'retry-after': '23' }, { reason: 'rate_limited', retryAfterSeconds: 23 }],
    [
      403,
      { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '42' },
      { reason: 'rate_limited' },
    ],
    [500, { 'retry-after': '17' }, { reason: 'ambiguous' }],
  ])('classifies probe status %i with %j', async (status, headers, detail) => {
    const { options, tokens } = setup(complete, status, headers);
    for (const run of [
      () => probeRootTree(options, 'main'),
      () => probeComposerBlob(options, blobSha),
    ]) {
      await expect(run()).resolves.toEqual({ kind: 'unknown', ...detail });
    }
    expect(tokens.observe).toHaveBeenCalledWith('12', expect.any(Headers));
  });

  it.each([
    ['not_found', 'access'],
    ['unprocessable', 'access'],
    ['forbidden', 'access'],
    ['unauthorized', 'ambiguous'],
    ['invalid_response', 'ambiguous'],
    ['rate_limited', 'rate_limited'],
  ] as const)('classifies token mint %s without leaking request data', async (code, reason) => {
    const { options, tokens, calls } = setup(complete);
    vi.mocked(tokens.forRepositoryIds).mockRejectedValue(
      new InstallationTokenError(
        code,
        undefined,
        code === 'rate_limited' ? { retryAfter: 31 } : {},
      ),
    );
    const expected = {
      kind: 'unknown',
      reason,
      ...(code === 'rate_limited' ? { retryAfterSeconds: 31 } : {}),
    };
    await expect(probeRootTree(options, 'main')).resolves.toEqual(expected);
    await expect(probeComposerBlob(options, blobSha)).resolves.toEqual(expected);
    expect(calls).toHaveLength(0);
  });

  it('records composer absence only from a complete 200 tree', async () => {
    const { options, calls } = setup(complete);
    await expect(probeRootTree(options, 'main')).resolves.toEqual({
      kind: 'complete',
      treeSha,
      rootEntries: [],
      composerBlobSha: null,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([409, 422, 451, 500, 201, 206])(
    'keeps status %i unknown even with a complete-looking body',
    async (status) => {
      const { options } = setup(complete, status);
      await expect(probeRootTree(options, 'main')).resolves.toEqual({
        kind: 'unknown',
        reason: 'ambiguous',
      });
    },
  );

  it.each([
    { ...complete, truncated: true },
    { ...complete, truncated: undefined },
    { ...complete, sha: 'invalid' },
    { ...complete, tree: undefined },
    { ...complete, tree: [{ ...composer, sha: 'bad' }] },
    { ...complete, tree: [{ ...composer, path: 'nested/composer.json' }] },
    { ...complete, tree: [composer, composer] },
    { ...complete, tree: [{ ...composer, mode: '120000' }] },
    { ...complete, tree: [{ ...composer, type: 'tree' }] },
  ])('keeps malformed, truncated or unusable trees unknown %#', async (body) => {
    const { options } = setup(body);
    await expect(probeRootTree(options, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
  });

  it('does not turn transport or token failures into absence', async () => {
    const { options } = setup(complete);
    const fetch = vi.fn(async () => {
      throw new Error('fixture-secret');
    });
    await expect(probeRootTree({ ...options, fetch }, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    vi.mocked(options.tokens.forRepositoryIds).mockRejectedValue(new Error('fixture-secret'));
    await expect(probeRootTree(options, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
  });

  it('reads the content-addressed Composer blob with the same id-narrowed token', async () => {
    const { options, calls } = setup({
      sha: blobSha,
      encoding: 'base64',
      content: btoa('{"name":"vendor/package"}'),
    });
    await expect(probeComposerBlob(options, blobSha)).resolves.toEqual({
      kind: 'found',
      name: 'vendor/package',
    });
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/owner/repo/git/blobs/${blobSha}`);
    expect(options.tokens.forRepositoryIds).toHaveBeenCalledWith('12', [7]);
  });

  it.each([
    { sha: treeSha, encoding: 'base64', content: btoa('{"name":"vendor/package"}') },
    { sha: blobSha, encoding: 'none', content: '{}' },
    { sha: blobSha, encoding: 'base64', content: '!' },
    { sha: blobSha, encoding: 'base64', content: btoa('invalid') },
    { sha: blobSha, encoding: 'base64', content: btoa('{}') },
    { sha: blobSha, encoding: 'base64', content: btoa('{"name":"bad name"}') },
  ])('keeps unusable blobs unknown %#', async (body) => {
    const { options } = setup(body);
    await expect(probeComposerBlob(options, blobSha)).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
  });

  it('keeps blob 404 unknown with an access reason', async () => {
    const { options } = setup({}, 404);
    await expect(probeComposerBlob(options, blobSha)).resolves.toEqual({
      kind: 'unknown',
      reason: 'access',
    });
  });

  it('never reuses an ambiguous tree as evidence', async () => {
    const { options, calls } = setup({ ...complete, truncated: true });
    await expect(probeRootTree(options, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    await expect(probeRootTree(options, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    expect(calls).toHaveLength(2);
  });

  it('bounds tree and blob bodies through PolicyFetch', async () => {
    const tree = setup({ ...complete, extra: 'x'.repeat(8 * 1024 * 1024) });
    await expect(probeRootTree(tree.options, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    const blob = setup({
      sha: blobSha,
      encoding: 'base64',
      content: btoa(
        JSON.stringify({ name: 'vendor/package', description: 'x'.repeat(1024 * 1024) }),
      ),
    });
    await expect(probeComposerBlob(blob.options, blobSha)).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
  });

  it('refuses invalid local paths before sending requests', async () => {
    const { options, calls } = setup(complete);
    await expect(probeRootTree({ ...options, repository: 'owner/..' }, 'main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    await expect(probeRootTree(options, '..')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    await expect(probeComposerBlob(options, '../main')).resolves.toEqual({
      kind: 'unknown',
      reason: 'ambiguous',
    });
    expect(calls).toHaveLength(0);
  });
});
