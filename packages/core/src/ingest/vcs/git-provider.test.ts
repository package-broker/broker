import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitFetchError, type FileAtRef, type GitFetchContext } from '../../sources/git/fetch.js';
import type { GitRef } from '../../sources/git/refs.js';
import { bindCredential, parseCredentialMaterial } from '../../sources/credentials.js';
import type { ProviderContext, ProviderSource } from '../../sources/provider.js';

const lsRefs = vi.fn();
const readFileAtRefs = vi.fn();
const readTreeAtCommit = vi.fn();
const createGitBlobReader = vi.fn();
const buildZipFromTree = vi.fn();

vi.mock('../../sources/git/refs.js', () => ({ lsRefs: (...args: unknown[]) => lsRefs(...args) }));
vi.mock('../../sources/git/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sources/git/fetch.js')>()),
  readFileAtRefs: (...args: unknown[]) => readFileAtRefs(...args),
  readTreeAtCommit: (...args: unknown[]) => readTreeAtCommit(...args),
  createGitBlobReader: (...args: unknown[]) => createGitBlobReader(...args),
}));
vi.mock('../../sources/git/archive.js', () => ({
  buildZipFromTree: (...args: unknown[]) => buildZipFromTree(...args),
}));

const { createGitProvider, GitProviderError } = await import('./git-provider.js');

const REPO = 'https://git.example.com/acme/lib.git';
const NAME = 'acme/lib';
const oid = (n: number): string => n.toString(16).padStart(40, '0');

const REFS: GitRef[] = [
  { name: 'HEAD', oid: oid(1), symref: 'refs/heads/main' },
  { name: 'refs/heads/main', oid: oid(1) },
  { name: 'refs/heads/feature/x', oid: oid(2) },
  { name: 'refs/tags/v1.0.0', oid: oid(3), peeled: oid(10) },
  { name: 'refs/tags/v1.1.0', oid: oid(4) },
  { name: 'refs/tags/v2.0.0-beta1', oid: oid(5) },
  { name: 'refs/tags/not-a-version', oid: oid(6) },
];

const source = (config: Partial<ProviderSource['config']> = {}): ProviderSource =>
  ({
    id: 's1',
    ecosystem: 'composer',
    url: null,
    type: 'vcs',
    config: {
      provider: 'git',
      repository: REPO,
      refs: { tags: true, branches: ['main'] },
      ...config,
    },
  }) as ProviderSource;

const counters: { name: string; labels: Record<string, string> | undefined }[] = [];
const ctx = {
  fetch: vi.fn(),
  credential: null,
  codecs: {},
  signal: new AbortController().signal,
  clock: { now: () => new Date('2026-01-01T00:00:00Z') },
  observability: {
    log: vi.fn(),
    counter: (name: string, labels?: Record<string, string>) => counters.push({ name, labels }),
    histogram: vi.fn(),
  },
} as unknown as ProviderContext;

function manifests(
  byRef: Record<string, string | Record<string, unknown> | FileAtRef['reason']>,
): void {
  readFileAtRefs.mockImplementation(async (_c, _u, refs: GitRef[]) =>
    refs.map((ref): FileAtRef => {
      const entry = byRef[ref.name];
      const base = {
        ref: ref.name,
        commit: ref.peeled ?? ref.oid,
        committedAt: '2025-06-01T10:00:00.000Z',
      };
      if (typeof entry === 'string') {
        return entry === 'missing' || entry === 'too_large' || entry === 'bad_tree'
          ? { ...base, text: null, reason: entry }
          : { ...base, text: JSON.stringify({ name: entry }) };
      }
      return { ...base, text: JSON.stringify(entry ?? { name: NAME }) };
    }),
  );
}

async function members(
  provider: ReturnType<typeof createGitProvider>,
  src = source(),
  name = NAME,
) {
  const result = await provider.describe(ctx, src, name, {});
  if (result.kind !== 'found') throw new Error(result.kind);
  const out = [];
  for await (const m of result.description.members) out.push(m);
  return { description: result.description, members: out };
}

beforeEach(() => {
  vi.clearAllMocks();
  counters.length = 0;
  lsRefs.mockResolvedValue({ refs: REFS, skipped: 0 });
  manifests({});
});

describe('git provider listPackages', () => {
  it('names the package from composer.json at the default branch and is last after ls-refs', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const page = await provider.listPackages!(ctx, source(), null);
    expect(page).toMatchObject({ names: [NAME], next: null, last: true });
    expect(page.snapshot.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileAtRefs.mock.calls[0]![2]).toEqual([{ name: 'refs/heads/main', oid: oid(1) }]);
  });

  it('rejects a listing without the HEAD symref', async () => {
    lsRefs.mockResolvedValue({ refs: REFS.filter((ref) => ref.name !== 'HEAD'), skipped: 0 });
    await expect(
      createGitProvider({ runtime: 'docker' }).listPackages!(ctx, source(), null),
    ).rejects.toMatchObject({ code: 'no_default_branch' });
  });

  it('prefers config.packageName and reads no file', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const page = await provider.listPackages!(ctx, source({ packageName: 'Acme/Other' }), null);
    expect(page.names).toEqual(['acme/other']);
    expect(readFileAtRefs).not.toHaveBeenCalled();
  });

  it('is not last when the default branch manifest cannot be read', async () => {
    manifests({ 'refs/heads/main': 'missing' });
    const provider = createGitProvider({ runtime: 'docker' });
    expect(await provider.listPackages!(ctx, source(), null)).toMatchObject({
      names: [],
      last: false,
      next: null,
    });
  });

  it('propagates an ls-refs failure instead of answering a listing', async () => {
    lsRefs.mockRejectedValue(new Error('upstream down'));
    const provider = createGitProvider({ runtime: 'docker' });
    await expect(provider.listPackages!(ctx, source(), null)).rejects.toThrow('upstream down');
  });
});

describe('git provider describe', () => {
  it('yields the versions Composer reports for the fixture refs', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const { members: found } = await members(provider);
    expect(found.map((m) => [m.version, m.form])).toEqual([
      ['v2.0.0-beta1', 'composer-p2'],
      ['v1.1.0', 'composer-p2'],
      ['v1.0.0', 'composer-p2'],
      ['dev-main', 'composer-p2-dev'],
    ]);
    expect(found.map((m) => m.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('matches the expected Composer list for numeric branches and normalized duplicate tags', async () => {
    lsRefs.mockResolvedValue({
      refs: [
        ...REFS,
        { name: 'refs/tags/1.0.0', oid: oid(11) },
        { name: 'refs/heads/2.x', oid: oid(12) },
      ],
      skipped: 0,
    });
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ refs: { tags: true, branches: ['main', '2.x'] } }),
    );
    expect(found.map((m) => [m.version, JSON.parse(m.raw).version_normalized])).toEqual([
      ['2.x-dev', '2.9999999.9999999.9999999-dev'],
      ['v2.0.0-beta1', '2.0.0.0-beta1'],
      ['v1.1.0', '1.1.0.0'],
      ['1.0.0', '1.0.0.0'],
      ['dev-main', 'dev-main'],
    ]);
  });

  it('builds dist from the repository url and the commit, with the commit time', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const { members: found } = await members(provider);
    const first = found.find((m) => m.version === 'v1.0.0')!;
    const raw = JSON.parse(first.raw);
    expect(raw.dist).toEqual({ type: 'zip', url: REPO, reference: oid(10) });
    expect(raw).not.toHaveProperty('source');
    expect(raw.time).toBe('2025-06-01T10:00:00.000Z');
    expect(raw.version_normalized).toBe('1.0.0.0');
    expect(first.upstreamTime).toBe('2025-06-01T10:00:00.000Z');
  });

  it('skips a tag whose composer.json names another package and reports the reason', async () => {
    manifests({ 'refs/tags/v1.1.0': { name: 'evil/other' } });
    const provider = createGitProvider({ runtime: 'docker' });
    const { members: found, description } = await members(provider);
    expect(found.map((m) => m.version)).toEqual(['v2.0.0-beta1', 'v1.0.0', 'dev-main']);
    expect(description.upstreamComplete).toBe(false);
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'foreign_name' },
    });
  });

  it('skips a ref without composer.json and never treats it as complete', async () => {
    manifests({ 'refs/tags/v1.0.0': 'missing' });
    const provider = createGitProvider({ runtime: 'docker' });
    const { members: found, description } = await members(provider);
    expect(found.map((m) => m.version)).not.toContain('v1.0.0');
    expect(description.upstreamComplete).toBe(false);
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'missing' },
    });
  });

  it.each(['invalid_json', 'nameless', 'too_large', 'bad_tree'])(
    'skips %s with a reason',
    async (kind) => {
      manifests({ 'refs/tags/v1.1.0': kind === 'nameless' ? {} : kind });
      if (kind === 'invalid_json') {
        readFileAtRefs.mockResolvedValueOnce([
          {
            ref: 'refs/heads/main',
            commit: oid(1),
            text: JSON.stringify({ name: NAME }),
            committedAt: null,
          },
        ]);
        readFileAtRefs.mockResolvedValueOnce([
          { ref: 'refs/tags/v1.1.0', commit: oid(4), text: '{', committedAt: null },
        ]);
      }
      const { members: found, description } = await members(
        createGitProvider({ runtime: 'docker' }),
      );
      expect(found.map((m) => m.version)).not.toContain('v1.1.0');
      expect(description.upstreamComplete).toBe(false);
      expect(counters).toContainEqual({
        name: 'git_provider_ref_skipped',
        labels: {
          reason: kind === 'invalid_json' || kind === 'nameless' ? 'bad_manifest' : kind,
        },
      });
    },
  );

  it('sanitizes metadata and drops keys outside the mapper allowlist', async () => {
    manifests({
      'refs/tags/v1.1.0': {
        name: NAME,
        authors: [{ name: 'Author', email: 'author@example.test' }],
        homepage: 'https://user:password@example.test/',
        scripts: { test: 'example' },
      },
    });
    const { members: found } = await members(createGitProvider({ runtime: 'docker' }));
    const raw = JSON.parse(found.find((m) => m.version === 'v1.1.0')!.raw);
    expect(raw.authors).toEqual([{ name: 'Author' }]);
    expect(raw).not.toHaveProperty('homepage');
    expect(raw).not.toHaveProperty('scripts');
  });

  it('refuses a manifest echoing the bound credential', async () => {
    const credential = bindCredential(
      parseCredentialMaterial('bearer', JSON.stringify({ token: 'fixture-secret-token' })),
      [new URL(REPO).origin],
    );
    manifests({ 'refs/tags/v1.1.0': { name: NAME, description: 'fixture-secret-token' } });
    const result = await createGitProvider({ runtime: 'docker' }).describe(
      { ...ctx, credential },
      source(),
      NAME,
      {},
    );
    if (result.kind !== 'found') throw new Error(result.kind);
    const found = [];
    for await (const member of result.description.members) found.push(member);
    expect(found.map((m) => m.version)).not.toContain('v1.1.0');
    expect(result.description.upstreamComplete).toBe(false);
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'credential_echo' },
    });
  });

  it('marks the default branch and returns the canonical package key', async () => {
    const { members: found, description } = await members(
      createGitProvider({ runtime: 'docker' }),
      source(),
      'Acme/Lib',
    );
    expect(description.name).toBe(NAME);
    expect(JSON.parse(found.find((m) => m.version === 'dev-main')!.raw)['default-branch']).toBe(
      true,
    );
    expect(JSON.parse(found[0]!.raw)).not.toHaveProperty('default-branch');
  });

  it.each([
    ['http_basic', { username: 'fixture-user', password: 'fixture-secret:password' }],
    ['http_basic', { username: 'użytkownik', password: 'fixture-秘密:hasło' }],
    ['header', { name: 'x-api-key', value: 'fixture-secret-token' }],
    ['query', { param: 'access_token', value: 'fixture-secret-token' }],
  ] as const)('refuses a manifest echoing a %s credential (%j)', async (kind, material) => {
    const credential = bindCredential(parseCredentialMaterial(kind, JSON.stringify(material)), [
      new URL(REPO).origin,
    ]);
    const echoed = 'password' in material ? material.password : material.value;
    manifests({ 'refs/tags/v1.1.0': { name: NAME, description: echoed } });
    const result = await createGitProvider({ runtime: 'docker' }).describe(
      { ...ctx, credential },
      source(),
      NAME,
      {},
    );
    if (result.kind !== 'found') throw new Error(result.kind);
    const found = [];
    for await (const member of result.description.members) found.push(member);
    expect(found.map((m) => m.version)).toEqual(['v2.0.0-beta1', 'v1.0.0', 'dev-main']);
    expect(result.description.upstreamComplete).toBe(false);
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'credential_echo' },
    });
  });

  it.each(['missing', 'too_large', 'bad_tree'] as const)(
    'answers non-definitive not_found for a %s default-branch manifest',
    async (reason) => {
      manifests({ 'refs/heads/main': reason });
      expect(
        await createGitProvider({ runtime: 'docker' }).describe(ctx, source(), NAME, {}),
      ).toEqual({ kind: 'not_found', definitive: false });
    },
  );

  it('answers non-definitive not_found for an unparsable default-branch manifest', async () => {
    readFileAtRefs.mockResolvedValue([
      { ref: 'refs/heads/main', commit: oid(1), committedAt: null, text: '{' },
    ]);
    expect(
      await createGitProvider({ runtime: 'docker' }).describe(ctx, source(), NAME, {}),
    ).toEqual({ kind: 'not_found', definitive: false });
  });

  it.each([NAME, 'foreign/package', 'invalid'])(
    'checks the pinned snapshot before resolving the package name %s',
    async (name) => {
      const provider = createGitProvider({ runtime: 'docker' });
      const { snapshot } = await provider.listPackages!(ctx, source(), null);
      readFileAtRefs.mockClear();
      lsRefs.mockResolvedValue({
        refs: REFS.map((ref) => (ref.name === 'refs/heads/main' ? { ...ref, oid: oid(99) } : ref)),
        skipped: 0,
      });
      manifests({ 'refs/heads/main': 'foreign/package' });
      await expect(provider.describe(ctx, source(), name, { snapshot })).rejects.toMatchObject({
        code: 'snapshot_changed',
      });
      expect(readFileAtRefs).not.toHaveBeenCalled();
    },
  );

  it.each(['foreign/package', 'invalid'])(
    'rejects a noncanonical requested package %s',
    async (name) => {
      manifests({ 'refs/tags/v1.1.0': { name: 'foreign/package' } });
      expect(
        await createGitProvider({ runtime: 'docker' }).describe(ctx, source(), name, {}),
      ).toEqual({ kind: 'not_found', definitive: true });
    },
  );

  it('hashes sorted refs including the unselected default branch', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const src = source({ refs: { tags: true, branches: [] } });
    const a = (await provider.listPackages!(ctx, src, null)).snapshot.id;
    lsRefs.mockResolvedValue({ refs: [...REFS].reverse(), skipped: 0 });
    expect((await provider.listPackages!(ctx, src, null)).snapshot.id).toBe(a);
    lsRefs.mockResolvedValue({
      refs: REFS.map((ref) => (ref.name === 'refs/heads/main' ? { ...ref, oid: oid(99) } : ref)),
      skipped: 0,
    });
    expect((await provider.listPackages!(ctx, src, null)).snapshot.id).not.toBe(a);
  });

  it('is complete when every ref was read', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const { description } = await members(provider);
    expect(description.upstreamComplete).toBe(true);
  });

  it('honours the refs configuration', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const { members: found } = await members(
      provider,
      source({ refs: { tags: false, branches: ['main', 'feature/x'] } }),
    );
    expect(found.map((m) => m.version).sort()).toEqual(['dev-feature/x', 'dev-main']);
  });

  it('answers not_found definitively when the name differs from the configured package', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    expect(
      await provider.describe(ctx, source({ packageName: 'acme/lib' }), 'acme/else', {}),
    ).toEqual({ kind: 'not_found', definitive: true });
  });

  it('derives the same snapshot id for the same refs and a different one when a ref moves', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const a = (await members(provider)).description.snapshot.id;
    const b = (await members(provider)).description.snapshot.id;
    lsRefs.mockResolvedValue({
      refs: REFS.map((r) => (r.name === 'refs/tags/v1.1.0' ? { ...r, oid: oid(99) } : r)),
      skipped: 0,
    });
    const c = (await members(provider)).description.snapshot.id;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('rejects a pinned snapshot that no longer matches', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const { description } = await members(provider);
    lsRefs.mockResolvedValue({ refs: REFS.slice(0, 3), skipped: 0 });
    await expect(
      provider.describe(ctx, source(), NAME, { snapshot: description.snapshot }),
    ).rejects.toMatchObject({ code: 'snapshot_changed' });
  });

  it('fails the whole call on a missing_object failure', async () => {
    readFileAtRefs.mockRejectedValue(new GitFetchError('missing_object'));
    const provider = createGitProvider({ runtime: 'docker' });
    await expect(
      provider.describe(ctx, source({ packageName: NAME }), NAME, {}),
    ).rejects.toMatchObject({ name: 'GitFetchError', code: 'missing_object' });
  });

  it('refuses a source that is not a git vcs source', async () => {
    const provider = createGitProvider({ runtime: 'docker' });
    const github = { ...source(), config: { ...source().config, provider: 'github' } };
    await expect(provider.describe(ctx, github as ProviderSource, NAME, {})).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });
});

describe('git provider archives', () => {
  const staging = { create: vi.fn() };
  const built = { path: '/tmp/a.zip', size: 3, sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) };

  it('refuses to build on cloudflare with git_archive_requires_docker', async () => {
    const provider = createGitProvider({ runtime: 'cloudflare' });
    await expect(provider.buildArchive(ctx, source(), oid(3))).rejects.toMatchObject({
      code: 'git_archive_requires_docker',
    });
    expect(readTreeAtCommit).not.toHaveBeenCalled();
  });

  it('builds the zip from the full tree on docker', async () => {
    const tree = {
      commit: oid(3),
      committedAt: '2025-06-01T10:00:00.000Z',
      skipped: 0,
      entries: [
        { path: 'a.php', mode: '100644', type: 'blob', oid: oid(20) },
        { path: 'src', mode: '40000', type: 'tree', oid: oid(21) },
      ],
    };
    readTreeAtCommit.mockResolvedValue(tree);
    const reader = { read: vi.fn() };
    createGitBlobReader.mockReturnValue(reader);
    buildZipFromTree.mockResolvedValue(built);
    const provider = createGitProvider({ runtime: 'docker', staging });
    expect(await provider.buildArchive(ctx, source(), oid(3))).toBe(built);
    expect(createGitBlobReader.mock.calls[0]![2]).toEqual([oid(20)]);
    expect(buildZipFromTree).toHaveBeenCalledWith(tree, ctx.codecs, { blobs: reader, staging });
  });

  it('forwards the bound credential and policy fetch to every git reader', async () => {
    const credential = bindCredential(
      parseCredentialMaterial('bearer', JSON.stringify({ token: 'fixture-secret-token' })),
      [new URL(REPO).origin],
    );
    const fetch = vi.fn().mockResolvedValue(new Response());
    const controller = new AbortController();
    const context = { ...ctx, credential, fetch, signal: controller.signal };
    const provider = createGitProvider({ runtime: 'docker', staging });
    readTreeAtCommit.mockResolvedValue({ entries: [], skipped: 0 });
    await provider.describe(context, source(), NAME, {});
    await provider.buildArchive(context, source(), oid(1));
    expect(lsRefs.mock.calls[0]![2]).toBe(credential);
    const contexts: GitFetchContext[] = [
      ...readFileAtRefs.mock.calls.map((call) => call[0]),
      readTreeAtCommit.mock.calls[0]![0],
      createGitBlobReader.mock.calls[0]![0],
    ];
    const policies = [lsRefs.mock.calls[0]![0], ...contexts.map((git) => git.policyFetch)];
    for (const git of contexts) expect(git.credential).toBe(credential);
    const requestController = new AbortController();
    for (const policy of policies) {
      await policy({ url: REPO, method: 'GET', credential });
      expect(fetch.mock.lastCall![0]).toMatchObject({
        url: REPO,
        method: 'GET',
        credential,
        signal: controller.signal,
      });
      await policy({ url: REPO, method: 'GET', credential, signal: requestController.signal });
    }
    requestController.abort();
    for (const call of fetch.mock.calls.filter((_, index) => index % 2 === 1))
      expect(call[0].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(policies.length * 2);
  });

  it('rejects a commit that is not a full object id', async () => {
    const provider = createGitProvider({ runtime: 'docker', staging });
    await expect(provider.buildArchive(ctx, source(), '-bad')).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });

  it('never refetches a dist at serve time', async () => {
    const provider = createGitProvider({ runtime: 'docker', staging });
    await expect(
      provider.openDist(ctx, source(), {
        packageName: NAME,
        version: '1.0.0',
        url: REPO,
        distType: 'zip',
        sourceRef: oid(3),
      }),
    ).rejects.toMatchObject({ code: 'not_refetchable' });
  });
});
