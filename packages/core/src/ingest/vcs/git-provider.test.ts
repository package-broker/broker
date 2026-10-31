import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { createDeflateRaw } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import type { DigestAlgorithm } from '../../platform/codec.js';
import { FLUSH, GitRemoteError, encodePkt } from '../../sources/git/pkt-line.js';
import { GitFetchError, type FileAtRef, type GitFetchContext } from '../../sources/git/fetch.js';
import { UpstreamError } from '../../sources/policy-fetch.js';
import { GitRefsError, type GitRef } from '../../sources/git/refs.js';
import { bindCredential, parseCredentialMaterial } from '../../sources/credentials.js';
import type { ProviderContext, ProviderSource } from '../../sources/provider.js';

const lsRefs = vi.fn();
const discoverCapabilities = vi.fn();
const { lsRefs: actualLsRefs } = await vi.importActual<typeof import('../../sources/git/refs.js')>(
  '../../sources/git/refs.js',
);
const readFileAtRefs = vi.fn();
const readTreeAtCommit = vi.fn();
const createGitBlobReader = vi.fn();
const buildZipFromTree = vi.fn();

vi.mock('../../sources/git/refs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sources/git/refs.js')>()),
  lsRefs: (...args: unknown[]) => lsRefs(...args),
  discoverCapabilities: (...args: unknown[]) => discoverCapabilities(...args),
}));
vi.mock('../../sources/git/fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sources/git/fetch.js')>()),
  readFileAtRefs: (...args: unknown[]) => readFileAtRefs(...args),
  readTreeAtCommit: (...args: unknown[]) => readTreeAtCommit(...args),
  createGitBlobReader: (...args: unknown[]) => createGitBlobReader(...args),
}));
vi.mock('../../sources/git/archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sources/git/archive.js')>()),
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
  org: orgContext('org-test'),
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
  discoverCapabilities.mockResolvedValue({ filter: false });
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

describe('git provider smart-HTTP capabilities', () => {
  const ADVERT = 'application/x-git-upload-pack-advertisement';
  const RESULT = 'application/x-git-upload-pack-result';
  const pkts = (...parts: (string | Uint8Array)[]): Uint8Array => {
    const chunks = parts.map((part) => (typeof part === 'string' ? encodePkt(part) : part));
    const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  function serverAdvertising(fetchCapability: string): ProviderContext {
    const fetch = vi.fn(async (request: { method?: string }) =>
      request.method === 'POST'
        ? new Response(
            pkts(
              `${oid(1)} HEAD symref-target:refs/heads/main\n`,
              `${oid(1)} refs/heads/main\n`,
              FLUSH,
            ),
            { headers: { 'content-type': RESULT } },
          )
        : new Response(
            pkts(
              '# service=git-upload-pack\n',
              FLUSH,
              'version 2\n',
              'ls-refs=unborn\n',
              `${fetchCapability}\n`,
              FLUSH,
            ),
            { headers: { 'content-type': ADVERT } },
          ),
    );
    return { ...ctx, fetch } as unknown as ProviderContext;
  }

  async function capabilitiesSeen(fetchCapability: string) {
    lsRefs.mockImplementation(async (...args: Parameters<typeof actualLsRefs>) =>
      actualLsRefs(...args),
    );
    await createGitProvider({ runtime: 'docker' }).describe(
      serverAdvertising(fetchCapability),
      source({ packageName: NAME }),
      NAME,
      {},
    );
    return (readFileAtRefs.mock.calls[0]![0] as GitFetchContext).capabilities;
  }

  it('passes filter support when the server advertises filter', async () => {
    expect(await capabilitiesSeen('fetch=shallow filter')).toEqual({ filter: true });
  });

  it('passes no filter support when the server does not advertise filter', async () => {
    expect(await capabilitiesSeen('fetch=shallow')).toEqual({ filter: false });
  });

  it.each([true, false])('sends filter packets only when advertised (%s)', async (filter) => {
    const { readFileAtRefs: real } = await vi.importActual<
      typeof import('../../sources/git/fetch.js')
    >('../../sources/git/fetch.js');
    const context = serverAdvertising(filter ? 'fetch=shallow filter' : 'fetch=shallow');
    const server = context.fetch;
    const bodies: string[] = [];
    const fetch: ProviderContext['fetch'] = async (request) => {
      const body = new TextDecoder().decode(request.body as Uint8Array);
      if (body.includes('command=fetch')) {
        bodies.push(body);
        return new Response(encodePkt('ERR unavailable\n'), {
          headers: { 'content-type': RESULT },
        });
      }
      return server(request);
    };
    lsRefs.mockImplementation(actualLsRefs);
    readFileAtRefs.mockImplementation(real);
    await expect(
      createGitProvider({ runtime: 'docker' }).describe(
        { ...context, fetch },
        source({ packageName: NAME }),
        NAME,
        {},
      ),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.includes('filter ')).toBe(filter);
  });

  it('discovers capabilities before building an unfiltered archive', async () => {
    discoverCapabilities.mockImplementation(
      (
        await vi.importActual<typeof import('../../sources/git/refs.js')>(
          '../../sources/git/refs.js',
        )
      ).discoverCapabilities,
    );
    readTreeAtCommit.mockResolvedValue({ entries: [], skipped: 0 });
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      serverAdvertising('fetch=shallow'),
      source(),
      oid(1),
    );
    expect(readTreeAtCommit.mock.calls[0]![0].capabilities).toEqual({ filter: false });
  });

  it('sends no filter packet when fetching an archive from a server without filter', async () => {
    const { readTreeAtCommit: real } = await vi.importActual<
      typeof import('../../sources/git/fetch.js')
    >('../../sources/git/fetch.js');
    const context = serverAdvertising('fetch=shallow');
    const bodies: string[] = [];
    const fetch: ProviderContext['fetch'] = async (request) => {
      const body = new TextDecoder().decode(request.body as Uint8Array);
      if (body.includes('command=fetch')) {
        bodies.push(body);
        return new Response(encodePkt('ERR unavailable\n'), {
          headers: { 'content-type': RESULT },
        });
      }
      return context.fetch(request);
    };
    discoverCapabilities.mockImplementation(
      (
        await vi.importActual<typeof import('../../sources/git/refs.js')>(
          '../../sources/git/refs.js',
        )
      ).discoverCapabilities,
    );
    readTreeAtCommit.mockImplementation(real);
    await expect(
      createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
        { ...context, fetch },
        source(),
        oid(1),
      ),
    ).rejects.toBeInstanceOf(GitRemoteError);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('filter ');
  });

  it('builds archives without listing refs even when the listing exceeds its budget', async () => {
    lsRefs.mockRejectedValue(new GitRefsError('too_large'));
    const actual = await vi.importActual<typeof import('../../sources/git/refs.js')>(
      '../../sources/git/refs.js',
    );
    discoverCapabilities.mockImplementation(actual.discoverCapabilities);
    const context = serverAdvertising('fetch=shallow filter');
    readTreeAtCommit.mockResolvedValue({ entries: [], skipped: 0 });
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      context,
      source(),
      oid(1),
    );
    expect(lsRefs).not.toHaveBeenCalled();
    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(readTreeAtCommit.mock.calls[0]![0].capabilities).toEqual({ filter: true });
  });

  it('leaves capabilities unset when the listing reports none', async () => {
    await createGitProvider({ runtime: 'docker' }).describe(ctx, source(), NAME, {});
    expect((readFileAtRefs.mock.calls[0]![0] as GitFetchContext).capabilities).toBeUndefined();
  });
});

describe('git provider next-tag fallback', () => {
  const refsWithAlias: GitRef[] = [...REFS, { name: 'refs/tags/1.0.0', oid: oid(11) }];

  beforeEach(() => {
    lsRefs.mockResolvedValue({ refs: refsWithAlias, skipped: 0 });
  });

  it('resolves a version from the next candidate tag when the winning tag is unreadable', async () => {
    manifests({ 'refs/tags/1.0.0': 'missing' });
    const { members: found, description } = await members(createGitProvider({ runtime: 'docker' }));
    const fallback = found.find((m) => JSON.parse(m.raw).version_normalized === '1.0.0.0')!;
    expect(fallback.version).toBe('v1.0.0');
    expect(JSON.parse(fallback.raw).dist.reference).toBe(oid(10));
    expect(description.upstreamComplete).toBe(false);
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'missing' },
    });
  });

  it.each([new GitFetchError('missing_object'), new GitRemoteError('remote_error')])(
    'isolates a thrown ref failure and tries its alias (%s)',
    async (error) => {
      const real = readFileAtRefs.getMockImplementation()!;
      readFileAtRefs.mockImplementation(async (c, u, refs: GitRef[], path) => {
        if (refs.some((ref) => ref.name === 'refs/tags/1.0.0')) throw error;
        return real(c, u, refs, path);
      });
      const { members: found, description } = await members(
        createGitProvider({ runtime: 'docker' }),
      );
      expect(found.map((m) => m.version)).toContain('v1.0.0');
      expect(found.map((m) => m.version)).toContain('v1.1.0');
      expect(description.upstreamComplete).toBe(false);
      expect(counters).toContainEqual({
        name: 'git_provider_ref_skipped',
        labels: { reason: error.code },
      });
    },
  );

  it.each([new GitFetchError('missing_object'), new UpstreamError('timeout')])(
    'keeps resolved versions when a fallback batch fails (%s)',
    async (error) => {
      manifests({ 'refs/tags/1.0.0': 'missing' });
      const real = readFileAtRefs.getMockImplementation()!;
      readFileAtRefs.mockImplementation(async (c, u, refs: GitRef[], path) => {
        if (refs.some((ref) => ref.name === 'refs/tags/v1.0.0')) throw error;
        return real(c, u, refs, path);
      });
      const { members: found, description } = await members(
        createGitProvider({ runtime: 'docker' }),
      );
      expect(found.map((m) => m.version)).toContain('v1.1.0');
      expect(found.map((m) => m.version)).not.toContain('v1.0.0');
      expect(description.upstreamComplete).toBe(false);
      expect(counters).toContainEqual({
        name: 'git_provider_ref_skipped',
        labels: { reason: error.code },
      });
    },
  );

  it.each([new GitFetchError('bad_response'), new UpstreamError('refused')])(
    'skips all refs in a failed fallback batch and retains resolved versions (%s)',
    async (error) => {
      lsRefs.mockResolvedValue({
        refs: [...refsWithAlias, { name: 'refs/tags/1.1.0', oid: oid(12) }],
        skipped: 0,
      });
      manifests({ 'refs/tags/1.0.0': 'missing', 'refs/tags/1.1.0': 'missing' });
      const real = readFileAtRefs.getMockImplementation()!;
      readFileAtRefs.mockImplementation(async (c, u, refs: GitRef[], path) => {
        if (refs.some((ref) => ref.name === 'refs/tags/v1.0.0')) {
          expect(refs.map((ref) => ref.name)).toEqual(['refs/tags/v1.0.0', 'refs/tags/v1.1.0']);
          throw error;
        }
        return real(c, u, refs, path);
      });
      const { members: found, description } = await members(
        createGitProvider({ runtime: 'docker' }),
      );
      expect(found.map((m) => m.version)).toEqual(['v2.0.0-beta1', 'dev-main']);
      expect(description.upstreamComplete).toBe(false);
      expect(counters.filter((c) => c.labels?.reason === error.code)).toHaveLength(2);
    },
  );

  it.each([
    new GitFetchError('missing_object'),
    new GitRemoteError('remote_error'),
    new UpstreamError('timeout'),
  ])('propagates a single initial ref fetch failure (%s)', async (error) => {
    lsRefs.mockResolvedValue({ refs: [{ name: 'refs/tags/1.0.0', oid: oid(11) }], skipped: 0 });
    readFileAtRefs.mockRejectedValue(error);
    await expect(
      createGitProvider({ runtime: 'docker' }).describe(
        ctx,
        source({ packageName: NAME }),
        NAME,
        {},
      ),
    ).rejects.toBe(error);
    expect(readFileAtRefs).toHaveBeenCalledTimes(1);
    expect(counters).toEqual([]);
  });

  it('propagates cancellation during fallback and makes no further requests', async () => {
    lsRefs.mockResolvedValue({
      refs: ['1.0.0', 'v1.0.0', 'v1.0.0.0'].map((tag, n) => ({
        name: `refs/tags/${tag}`,
        oid: oid(n + 20),
      })),
      skipped: 0,
    });
    manifests({ 'refs/tags/1.0.0': 'missing' });
    const real = readFileAtRefs.getMockImplementation()!;
    const controller = new AbortController();
    const reason = new Error('cancelled');
    readFileAtRefs.mockImplementation(async (c, u, refs: GitRef[], path) => {
      if (refs.some((ref) => ref.name === 'refs/tags/v1.0.0')) {
        controller.abort(reason);
        throw new UpstreamError('timeout');
      }
      return real(c, u, refs, path);
    });
    await expect(
      createGitProvider({ runtime: 'docker' }).describe(
        { ...ctx, signal: controller.signal },
        source({ packageName: NAME }),
        NAME,
        {},
      ),
    ).rejects.toBe(reason);
    expect(readFileAtRefs).toHaveBeenCalledTimes(2);
    expect(counters).toHaveLength(1);
  });

  it('bisects an initial batch to isolate one bad ref in logarithmic requests', async () => {
    const count = 64;
    const refs = Array.from({ length: count }, (_, n) => ({
      name: `refs/tags/1.${n}.0`,
      oid: oid(n + 20),
    }));
    lsRefs.mockResolvedValue({ refs, skipped: 0 });
    const real = readFileAtRefs.getMockImplementation()!;
    readFileAtRefs.mockImplementation(async (c, u, batch: GitRef[], path) => {
      if (batch.some((ref) => ref.name === refs[21]!.name)) {
        throw new GitFetchError('missing_object');
      }
      return real(c, u, batch, path);
    });
    const { members: found, description } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 1);
    expect(description.upstreamComplete).toBe(false);
    expect(readFileAtRefs.mock.calls.length).toBeLessThanOrEqual(1 + 2 * Math.log2(count));
    expect(readFileAtRefs.mock.calls[1]![2]).toHaveLength(32);
    expect(counters).toEqual([
      { name: 'git_provider_ref_skipped', labels: { reason: 'missing_object' } },
    ]);
  });

  it('exhausts more than four aliases before resolving a version', async () => {
    const aliases = ['1.0', '1.0.0', '1.0.0.0', 'v1.0', 'v1.0.0', 'v1.0.0.0'];
    lsRefs.mockResolvedValue({
      refs: aliases.map((tag, n) => ({ name: `refs/tags/${tag}`, oid: oid(n + 20) })),
      skipped: 0,
    });
    manifests(
      Object.fromEntries(aliases.slice(0, -1).map((tag) => [`refs/tags/${tag}`, 'missing'])),
    );
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found.map((m) => m.version)).toEqual(['v1.0.0.0']);
    expect(counters).toHaveLength(5);
  });

  it('falls back when the winning tag manifest is unparsable', async () => {
    manifests({});
    const real = readFileAtRefs.getMockImplementation()!;
    readFileAtRefs.mockImplementation(async (c, u, refs: GitRef[], path) =>
      (await real(c, u, refs, path)).map((file: FileAtRef) =>
        file.ref === 'refs/tags/1.0.0' ? { ...file, text: '{' } : file,
      ),
    );
    const { members: found } = await members(createGitProvider({ runtime: 'docker' }));
    expect(found.map((m) => m.version)).toContain('v1.0.0');
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'bad_manifest' },
    });
  });

  it('skips the version when every candidate tag is unreadable', async () => {
    manifests({ 'refs/tags/1.0.0': 'missing', 'refs/tags/v1.0.0': 'too_large' });
    const { members: found, description } = await members(createGitProvider({ runtime: 'docker' }));
    expect(found.map((m) => JSON.parse(m.raw).version_normalized)).not.toContain('1.0.0.0');
    expect(description.upstreamComplete).toBe(false);
    expect(counters.filter((c) => c.name === 'git_provider_ref_skipped')).toEqual([
      { name: 'git_provider_ref_skipped', labels: { reason: 'missing' } },
      { name: 'git_provider_ref_skipped', labels: { reason: 'too_large' } },
    ]);
  });

  it('does not fall back from a readable tag that names another package', async () => {
    manifests({ 'refs/tags/1.0.0': { name: 'evil/other' } });
    const { members: found } = await members(createGitProvider({ runtime: 'docker' }));
    expect(found.map((m) => JSON.parse(m.raw).version_normalized)).not.toContain('1.0.0.0');
    expect(counters).toContainEqual({
      name: 'git_provider_ref_skipped',
      labels: { reason: 'foreign_name' },
    });
  });

  it('keeps the non-definitive not_found for an unreadable default branch', async () => {
    manifests({ 'refs/heads/main': 'missing' });
    expect(
      await createGitProvider({ runtime: 'docker' }).describe(ctx, source(), NAME, {}),
    ).toEqual({ kind: 'not_found', definitive: false });
  });
});

describe('git provider blob plan', () => {
  const sha1 = (text: string): string =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest('hex');
  const ATTRIBUTES = '.gitattributes export-ignore\ndocs export-ignore\n*.md export-ignore\n';
  const contents: Record<string, string> = {
    '.gitattributes': ATTRIBUTES,
    'a.php': '<?php // a\n',
    'README.md': '# readme\n',
    'docs/guide.txt': 'guide\n',
    'src/b.php': '<?php // b\n',
    'src/NOTES.md': 'notes\n',
  };
  const entries = Object.entries(contents).map(([path, text]) => ({
    path,
    mode: '100644',
    type: 'blob',
    oid: sha1(text),
  }));
  const tree = { commit: oid(3), committedAt: '2025-06-01T10:00:00.000Z', skipped: 0, entries };
  const byOid = new Map(Object.values(contents).map((text) => [sha1(text), text]));
  const oidOf = (path: string): string => sha1(contents[path]!);

  function servingReader(log: string[] = []) {
    return (_ctx: unknown, _url: string, plan: readonly string[]) => ({
      read: async (id: string) => {
        if (!plan.includes(id)) throw new GitFetchError('missing_object');
        log.push(id);
        const bytes = new TextEncoder().encode(byOid.get(id)!);
        return { size: bytes.length, body: new Blob([bytes]).stream() };
      },
    });
  }

  it('leaves export-ignored blobs out of the plan and keeps their siblings', async () => {
    readTreeAtCommit.mockResolvedValue(tree);
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      ctx,
      source(),
      oid(3),
    );
    const plan = createGitBlobReader.mock.calls.at(-1)![2] as string[];
    expect(plan).toEqual(expect.arrayContaining([oidOf('a.php'), oidOf('src/b.php')]));
    for (const ignored of ['README.md', 'docs/guide.txt', 'src/NOTES.md'])
      expect(plan).not.toContain(oidOf(ignored));
  });

  it('never plans attributes beneath an export-ignored directory', async () => {
    const ignored = { path: 'docs/.gitattributes', mode: '100644', type: 'blob', oid: oid(99) };
    readTreeAtCommit.mockResolvedValue({ ...tree, entries: [...entries, ignored] });
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      ctx,
      source(),
      oid(3),
    );
    for (const call of createGitBlobReader.mock.calls) expect(call[2]).not.toContain(ignored.oid);
  });

  it('reads an attributes file during planning even when a rule ignores it, and leaves it out of the archive reader plan', async () => {
    const text = '.gitattributes export-ignore\n';
    const attributes = { path: '.gitattributes', mode: '100644', type: 'blob', oid: sha1(text) };
    byOid.set(sha1(text), text);
    readTreeAtCommit.mockResolvedValue({ ...tree, entries: [attributes, entries[1]] });
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      ctx,
      source(),
      oid(3),
    );
    const plan = createGitBlobReader.mock.calls.at(-1)![2] as string[];
    expect(plan).toEqual([oidOf('a.php')]);
    const readAhead = createGitBlobReader.mock.calls
      .slice(0, -1)
      .flatMap((call) => call[2] as string[]);
    expect(readAhead).toEqual([sha1(text)]);
  });

  it('keeps the full plan when the tree has no attributes file', async () => {
    readTreeAtCommit.mockResolvedValue({ ...tree, entries: entries.slice(1) });
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockResolvedValue({});
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      ctx,
      source(),
      oid(3),
    );
    expect(createGitBlobReader).toHaveBeenCalledTimes(1);
    expect(createGitBlobReader.mock.calls[0]![2]).toEqual(entries.slice(1).map((e) => e.oid));
  });

  it('plans exactly the blobs the real archive builder reads', async () => {
    const { buildZipFromTree: real } = await vi.importActual<
      typeof import('../../sources/git/archive.js')
    >('../../sources/git/archive.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'pb-git-provider-'));
    let n = 0;
    const staging = {
      create() {
        const file = path.join(dir, `zip-${n++}.tmp`);
        const stream = createWriteStream(file);
        return Promise.resolve({
          path: file,
          writable: Writable.toWeb(stream) as WritableStream<Uint8Array>,
          discard: () => rm(file, { force: true }),
        });
      },
    };
    const codecs = {
      digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
        const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
        let done!: (v: Record<A, Uint8Array>) => void;
        const digests = new Promise<Record<A, Uint8Array>>((resolve) => {
          done = resolve;
        });
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            for (const [, h] of hashes) h.update(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            done(
              Object.fromEntries(hashes.map(([a, h]) => [a, new Uint8Array(h.digest())])) as Record<
                A,
                Uint8Array
              >,
            );
          },
        });
        return { transform, digests };
      },
      deflateRaw: () =>
        Duplex.toWeb(createDeflateRaw()) as unknown as TransformStream<Uint8Array, Uint8Array>,
    };
    const archiveReads: string[] = [];
    readTreeAtCommit.mockResolvedValue(tree);
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockImplementation(
      (
        archiveTree: unknown,
        archiveCodecs: unknown,
        io: { blobs: { read(id: string, max: number): Promise<unknown> } },
        opts: unknown,
      ) =>
        (real as (...args: unknown[]) => Promise<unknown>)(
          archiveTree,
          archiveCodecs,
          {
            ...io,
            blobs: {
              read: (id: string, max: number) => {
                archiveReads.push(id);
                return io.blobs.read(id, max);
              },
            },
          },
          opts,
        ),
    );
    try {
      const built = await createGitProvider({ runtime: 'docker', staging }).buildArchive(
        { ...ctx, codecs } as unknown as ProviderContext,
        source(),
        oid(3),
      );
      const plan = new Set(createGitBlobReader.mock.calls.flatMap((call) => call[2] as string[]));
      expect(new Set(archiveReads)).toEqual(plan);
      const zip = (await readFile(built.path)).toString('latin1');
      expect(zip).toContain('src/b.php');
      expect(zip).not.toContain('README.md');
      expect(zip).not.toContain('docs/guide.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never asks the archive reader for an attributes file that planning already read', async () => {
    const nested = '*.log export-ignore\n';
    const extra = {
      '.gitattributes': ATTRIBUTES,
      'a.php': contents['a.php']!,
      'src/.gitattributes': nested,
      'src/b.php': contents['src/b.php']!,
    };
    byOid.set(sha1(nested), nested);
    const list = Object.entries(extra).map(([path, text]) => ({
      path,
      mode: '100644',
      type: 'blob',
      oid: sha1(text),
    }));
    const asked: string[][] = [];
    readTreeAtCommit.mockResolvedValue({ ...tree, entries: list });
    createGitBlobReader.mockImplementation((c: unknown, u: string, plan: readonly string[]) => {
      const log: string[] = [];
      asked.push(log);
      const inner = servingReader(log)(c, u, plan);
      return {
        read: async (id: string) => {
          if (!plan.includes(id)) throw new GitFetchError('missing_object');
          log.push(...plan.filter((planned) => !log.includes(planned)));
          return inner.read(id);
        },
      };
    });
    buildZipFromTree.mockImplementation(
      async (
        _t: unknown,
        _c: unknown,
        io: { blobs: { read(id: string, max: number): Promise<unknown> } },
      ) => {
        for (const entry of list) await io.blobs.read(entry.oid, 1024);
        return {};
      },
    );
    await createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } }).buildArchive(
      ctx,
      source(),
      oid(3),
    );
    const mainPlan = createGitBlobReader.mock.calls.at(-1)![2] as string[];
    for (const attributes of ['.gitattributes', 'src/.gitattributes'])
      expect(mainPlan).not.toContain(sha1(extra[attributes as keyof typeof extra]));
    expect(asked.at(-1)).not.toContain(sha1(ATTRIBUTES));
    expect(asked.at(-1)).not.toContain(sha1(nested));
  });

  it('reads each attributes file from the repository once across planning and the archive build', async () => {
    const { buildZipFromTree: real } = await vi.importActual<
      typeof import('../../sources/git/archive.js')
    >('../../sources/git/archive.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'pb-git-provider-'));
    let n = 0;
    const staging = {
      create() {
        const file = path.join(dir, `zip-${n++}.tmp`);
        const stream = createWriteStream(file);
        return Promise.resolve({
          path: file,
          writable: Writable.toWeb(stream) as WritableStream<Uint8Array>,
          discard: () => rm(file, { force: true }),
        });
      },
    };
    const codecs = {
      digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
        const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
        let done!: (v: Record<A, Uint8Array>) => void;
        const digests = new Promise<Record<A, Uint8Array>>((resolve) => {
          done = resolve;
        });
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            for (const [, h] of hashes) h.update(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            done(
              Object.fromEntries(hashes.map(([a, h]) => [a, new Uint8Array(h.digest())])) as Record<
                A,
                Uint8Array
              >,
            );
          },
        });
        return { transform, digests };
      },
      deflateRaw: () =>
        Duplex.toWeb(createDeflateRaw()) as unknown as TransformStream<Uint8Array, Uint8Array>,
    };
    const reads: string[] = [];
    readTreeAtCommit.mockResolvedValue(tree);
    createGitBlobReader.mockImplementation(servingReader(reads));
    buildZipFromTree.mockImplementation(real);
    try {
      const built = await createGitProvider({ runtime: 'docker', staging }).buildArchive(
        { ...ctx, codecs } as unknown as ProviderContext,
        source(),
        oid(3),
      );
      expect(reads.filter((id) => id === oidOf('.gitattributes'))).toHaveLength(1);
      expect(new Set(reads).size).toBe(reads.length);
      const zip = (await readFile(built.path)).toString('latin1');
      expect(zip).toContain('src/b.php');
      expect(zip).not.toContain('README.md');
      expect(zip).not.toContain('.gitattributes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses attribute bytes that do not hash to their id even when planning already read them', async () => {
    const { buildZipFromTree: real } = await vi.importActual<
      typeof import('../../sources/git/archive.js')
    >('../../sources/git/archive.js');
    const codecs = {
      digestTap: () => {
        const transform = new TransformStream<Uint8Array, Uint8Array>();
        return { transform, digests: Promise.resolve({ sha1: new Uint8Array(20) }) };
      },
      deflateRaw: () => new TransformStream<Uint8Array, Uint8Array>(),
    };
    readTreeAtCommit.mockResolvedValue(tree);
    createGitBlobReader.mockImplementation(servingReader());
    buildZipFromTree.mockImplementation(real);
    await expect(
      createGitProvider({
        runtime: 'docker',
        staging: { create: vi.fn() },
      }).buildArchive({ ...ctx, codecs } as unknown as ProviderContext, source(), oid(3)),
    ).rejects.toMatchObject({ code: 'bad_object' });
  });
});

describe('git provider batch isolation cost', () => {
  const count = 64;
  const refs = Array.from({ length: count }, (_, n) => ({
    name: `refs/tags/1.${n}.0`,
    oid: oid(n + 20),
  }));

  function failing(error: (batch: GitRef[]) => Error | undefined): void {
    lsRefs.mockResolvedValue({ refs, skipped: 0 });
    const real = readFileAtRefs.getMockImplementation()!;
    readFileAtRefs.mockImplementation(async (c, u, batch: GitRef[], path) => {
      const failure = error(batch);
      if (failure !== undefined) throw failure;
      return real(c, u, batch, path);
    });
  }

  const describeAll = () =>
    createGitProvider({ runtime: 'docker' }).describe(ctx, source({ packageName: NAME }), NAME, {});

  it('falls back to every ref after both top halves and probes fail alike, then rethrows the first error', async () => {
    const failure = new GitFetchError('missing_object');
    failing(() => failure);
    await expect(describeAll()).rejects.toBe(failure);
    expect(readFileAtRefs.mock.calls.length).toBeLessThanOrEqual(count + Math.log2(count));
    expect(readFileAtRefs).toHaveBeenCalledTimes(1 + 2 + 2 + (count - 2));
  });

  it('keeps bisecting when the two top halves fail with different errors', async () => {
    failing((batch) => {
      if (batch.some((ref) => ref.name === refs[3]!.name))
        return new GitFetchError('missing_object');
      if (batch.some((ref) => ref.name === refs[40]!.name)) return new GitFetchError('bad_object');
      return undefined;
    });
    const { members: found, description } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 2);
    expect(description.upstreamComplete).toBe(false);
    expect(counters.map((c) => c.labels?.reason).sort()).toEqual(['bad_object', 'missing_object']);
  });

  it('isolates one bad ref per top half when both fail with the same error', async () => {
    failing((batch) =>
      batch.some((ref) => ref.name === refs[21]!.name || ref.name === refs[50]!.name)
        ? new GitFetchError('missing_object')
        : undefined,
    );
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 2);
    expect(counters).toHaveLength(2);
  });

  it('keeps the readable refs when both top halves and both probes fail alike', async () => {
    failing((batch) =>
      batch.some((ref) => ref.name === refs[0]!.name || ref.name === refs[32]!.name)
        ? new GitFetchError('missing_object')
        : undefined,
    );
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 2);
    expect(counters).toHaveLength(2);
  });

  it('treats upstream failures with different statuses as different errors', async () => {
    failing((batch) => {
      if (batch.length === count) return new GitFetchError('missing_object');
      if (batch.some((ref) => ref.name === refs[0]!.name))
        return new UpstreamError('http_status', 502);
      if (batch.some((ref) => ref.name === refs[32]!.name))
        return new UpstreamError('http_status', 503);
      return undefined;
    });
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 2);
  });

  it('isolates only the failing refs when some refs of a batch fail alike', async () => {
    failing((batch) =>
      batch.some((ref) => ref.name === refs[21]!.name || ref.name === refs[22]!.name)
        ? new GitFetchError('missing_object')
        : undefined,
    );
    const { members: found } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 2);
    expect(counters).toHaveLength(2);
  });

  it('bisects a sub-batch UpstreamError once per level down to single refs and keeps the rest', async () => {
    failing((batch) => {
      if (batch.length === count) return new GitFetchError('missing_object');
      return batch.some((ref) => ref.name === refs[5]!.name)
        ? new UpstreamError('http_status', 503)
        : undefined;
    });
    const { members: found, description } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found).toHaveLength(count - 1);
    expect(description.upstreamComplete).toBe(false);
    expect(counters).toEqual([
      { name: 'git_provider_ref_skipped', labels: { reason: 'http_status' } },
    ]);
  });

  it.each([
    ['timeout', new UpstreamError('timeout')],
    ['network', new UpstreamError('network')],
    ['429', new UpstreamError('http_status', 429)],
  ])(
    'retries a transient upstream %s once before failing the whole sub-batch without bisecting it',
    async (_name, upstream) => {
      failing((batch) => {
        if (batch.length === count) return new GitFetchError('missing_object');
        return batch.some((ref) => ref.name === refs[5]!.name) ? upstream : undefined;
      });
      const { members: found } = await members(
        createGitProvider({ runtime: 'docker' }),
        source({ packageName: NAME }),
      );
      expect(found).toHaveLength(count / 2);
      expect(counters).toHaveLength(count / 2);
      expect(readFileAtRefs).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    ['timeout', new UpstreamError('timeout')],
    ['network', new UpstreamError('network')],
    ['429', new UpstreamError('http_status', 429)],
  ])('keeps every ref when a transient upstream %s recovers on retry', async (_name, upstream) => {
    let attempts = 0;
    failing((batch) => {
      if (batch.length === count) return new GitFetchError('missing_object');
      if (batch.some((ref) => ref.name === refs[5]!.name) && ++attempts === 1) return upstream;
      return undefined;
    });
    const { members: found, description } = await members(
      createGitProvider({ runtime: 'docker' }),
      source({ packageName: NAME }),
    );
    expect(found.map((member) => member.version).sort()).toEqual(
      refs.map((ref) => ref.name.slice('refs/tags/'.length)).sort(),
    );
    expect(description.upstreamComplete).toBe(true);
    expect(counters).toEqual([]);
    expect(attempts).toBe(2);
    expect(readFileAtRefs).toHaveBeenCalledTimes(4);
    expect(readFileAtRefs.mock.calls[2]![2]).toEqual(readFileAtRefs.mock.calls[1]![2]);
  });

  it('fails both persistently transient halves after exactly one retry each without probing refs', async () => {
    const initial = new GitFetchError('missing_object');
    failing((batch) => (batch.length === count ? initial : new UpstreamError('timeout')));
    await expect(describeAll()).rejects.toBe(initial);
    expect(readFileAtRefs.mock.calls.map((call) => call[2])).toEqual([
      refs,
      refs.slice(0, count / 2),
      refs.slice(0, count / 2),
      refs.slice(count / 2),
      refs.slice(count / 2),
    ]);
  });

  it('aborts during retry backoff without another read', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      failing((batch) => {
        if (batch.length === count) return new GitFetchError('missing_object');
        ready();
        return new UpstreamError('network');
      });
      const pending = createGitProvider({ runtime: 'docker' }).describe(
        { ...ctx, signal: controller.signal },
        source({ packageName: NAME }),
        NAME,
        {},
      );
      const rejected = expect(pending).rejects.toBe(reason);
      await waiting;
      await vi.advanceTimersByTimeAsync(50);
      expect(readFileAtRefs).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(reason);
      await rejected;
      await vi.runAllTimersAsync();
      expect(readFileAtRefs).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays within 4n+2 reads while bisecting all 64 refs and retrying transient leaves', async () => {
    vi.useFakeTimers();
    try {
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const attempts = new Map<string, number>();
      failing((batch) => {
        if (batch.length > 1) {
          const index = refs.findIndex((ref) => ref.name === batch[0]!.name);
          return new GitFetchError(index === 0 ? 'missing_object' : 'bad_object');
        }
        const name = batch[0]!.name;
        const reads = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, reads);
        ready();
        return reads === 1 ? new UpstreamError('timeout') : undefined;
      });
      const pending = members(
        createGitProvider({ runtime: 'docker' }),
        source({ packageName: NAME }),
      );
      await waiting;
      await vi.runAllTimersAsync();
      const { members: found, description } = await pending;
      expect(found).toHaveLength(count);
      expect(description.upstreamComplete).toBe(true);
      expect(attempts.size).toBe(count);
      expect([...attempts.values()]).toEqual(Array.from({ length: count }, () => 2));
      expect(readFileAtRefs).toHaveBeenCalledTimes(3 * count - 1);
      expect(readFileAtRefs.mock.calls.length).toBeLessThanOrEqual(4 * count + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('git provider capability discovery', () => {
  const ADVERT = 'application/x-git-upload-pack-advertisement';
  const RESULT = 'application/x-git-upload-pack-result';
  const pkt = (...parts: string[]): Uint8Array => {
    const chunks = parts.map((part) => (part === '' ? FLUSH : encodePkt(part)));
    const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };
  const server = () =>
    vi.fn(async (request: { method?: string }) =>
      request.method === 'POST'
        ? new Response(
            pkt(
              `${oid(1)} HEAD symref-target:refs/heads/main\n`,
              `${oid(1)} refs/heads/main\n`,
              '',
            ),
            { headers: { 'content-type': RESULT } },
          )
        : new Response(
            pkt(
              '# service=git-upload-pack\n',
              '',
              'version 2\n',
              'ls-refs=unborn\n',
              'fetch=shallow filter\n',
              '',
            ),
            { headers: { 'content-type': ADVERT } },
          ),
    );
  const gets = (fetch: ReturnType<typeof server>): number =>
    fetch.mock.calls.filter(([request]) => request.method !== 'POST').length;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../sources/git/refs.js')>(
      '../../sources/git/refs.js',
    );
    discoverCapabilities.mockImplementation(actual.discoverCapabilities);
    lsRefs.mockImplementation(actual.lsRefs);
    readTreeAtCommit.mockResolvedValue({ entries: [], skipped: 0 });
    buildZipFromTree.mockResolvedValue({});
  });

  it('discovers once for consecutive archive builds of one source', async () => {
    const fetch = server();
    const context = { ...ctx, fetch } as unknown as ProviderContext;
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await provider.buildArchive(context, source(), oid(1));
    await provider.buildArchive(context, source(), oid(2));
    expect(gets(fetch)).toBe(1);
    expect(readTreeAtCommit.mock.calls[1]![0].capabilities).toEqual({ filter: true });
  });

  it('reuses the capabilities the ref listing already discovered', async () => {
    const fetch = server();
    const context = { ...ctx, fetch } as unknown as ProviderContext;
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await provider.describe(context, source({ packageName: NAME }), NAME, {});
    await provider.buildArchive(context, source(), oid(1));
    expect(gets(fetch)).toBe(1);
  });

  it('discovers again for another source', async () => {
    const fetch = server();
    const context = { ...ctx, fetch } as unknown as ProviderContext;
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await provider.buildArchive(context, source(), oid(1));
    await provider.buildArchive(context, { ...source(), id: 's2' } as ProviderSource, oid(1));
    expect(gets(fetch)).toBe(2);
  });

  it('keeps discovery capabilities separate for two orgs with the same source id and URL', async () => {
    const fetchA = server();
    const fetchB = server();
    const contextA = { ...ctx, org: orgContext('org-a'), fetch: fetchA };
    const contextB = { ...ctx, org: orgContext('org-b'), fetch: fetchB };
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    discoverCapabilities
      .mockResolvedValueOnce({ filter: true })
      .mockResolvedValueOnce({ filter: false });

    await provider.buildArchive(contextA, source(), oid(1));
    await provider.buildArchive(contextB, source(), oid(1));
    await provider.buildArchive(contextA, source(), oid(2));
    await provider.buildArchive(contextB, source(), oid(2));

    expect(discoverCapabilities).toHaveBeenCalledTimes(2);
    expect(readTreeAtCommit.mock.calls.map(([git]) => git.capabilities)).toEqual([
      { filter: true },
      { filter: false },
      { filter: true },
      { filter: false },
    ]);
  });

  it('keeps capabilities remembered by a ref listing within that org', async () => {
    const fetchA = server();
    const fetchB = server();
    const contextA = { ...ctx, org: orgContext('org-a'), fetch: fetchA };
    const contextB = { ...ctx, org: orgContext('org-b'), fetch: fetchB };
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await provider.describe(contextA, source({ packageName: NAME }), NAME, {});
    await provider.buildArchive(contextB, source(), oid(1));
    await provider.buildArchive(contextA, source(), oid(2));
    expect(gets(fetchA)).toBe(1);
    expect(gets(fetchB)).toBe(1);
  });

  it('discovers again once the cached capabilities are older than five minutes', async () => {
    const fetch = server();
    let now = Date.parse('2026-01-01T00:00:00Z');
    const context = {
      ...ctx,
      fetch,
      clock: { now: () => new Date(now) },
    } as unknown as ProviderContext;
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await provider.buildArchive(context, source(), oid(1));
    now += 4 * 60_000;
    await provider.buildArchive(context, source(), oid(1));
    expect(gets(fetch)).toBe(1);
    now += 2 * 60_000;
    await provider.buildArchive(context, source(), oid(1));
    expect(gets(fetch)).toBe(2);
  });

  it('does not keep a failed discovery', async () => {
    const fetch = server();
    fetch.mockRejectedValueOnce(new UpstreamError('timeout'));
    const context = { ...ctx, fetch } as unknown as ProviderContext;
    const provider = createGitProvider({ runtime: 'docker', staging: { create: vi.fn() } });
    await expect(provider.buildArchive(context, source(), oid(1))).rejects.toBeInstanceOf(
      UpstreamError,
    );
    await provider.buildArchive(context, source(), oid(1));
    expect(gets(fetch)).toBe(2);
  });
});

describe('npm git metadata adapter', () => {
  it('reads package.json and emits npm tags with configured-name mismatch reports', async () => {
    const src = { ...source({ packageName: '@scope/a' }), ecosystem: 'npm' as const };
    manifests({
      'refs/tags/v1.0.0': { name: '@scope/a', version: '1.0.0' },
      'refs/tags/v1.1.0': { name: '@scope/b', version: '1.1.0' },
      'refs/tags/v2.0.0-beta1': { name: '@scope/a', version: '2.0.0-beta1' },
    });
    const result = await members(createGitProvider({ runtime: 'docker' }), src, '@scope/a');
    expect(result.members.map(({ form, version }) => [form, version])).toEqual([
      ['npm-vcs', '2.0.0-beta1'],
      ['npm-vcs', '1.0.0'],
    ]);
    expect(result.description.skippedMembers).toEqual([
      { version: '1.1.0', reason: 'name_mismatch' },
    ]);
    expect(readFileAtRefs.mock.calls[0]![3]).toBe('package.json');
  });
});
