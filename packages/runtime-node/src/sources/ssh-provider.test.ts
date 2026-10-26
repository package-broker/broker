import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { existsSync, readdirSync, watch } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { BlobStore } from '@package-broker/core/platform/blob';
import type { Observability } from '@package-broker/core/platform/observability';
import { fetchAndVerifyDist } from '@package-broker/core/ingest/dist-fetch';
import { nodeCodecs } from '../codec/node-codec.js';
import { orgContext } from '@package-broker/core/db/port';
import { fixedClock } from '@package-broker/core/ids';
import {
  parseCredentialMaterial,
  type SshKeyMaterial,
} from '@package-broker/core/sources/credentials';
import type {
  ProviderContext,
  ProviderSource,
  VersionCandidate,
} from '@package-broker/core/sources/provider';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { UpstreamError } from '@package-broker/core/sources/policy-fetch';
import { createFilesystemArchiveStore, SshArchiveStoreError } from './ssh-archive-store.js';
import { createDnsGuard } from './dns-guard.js';
import { openSshGitSession, type SpawnGit } from './ssh-git.js';
import {
  createSshGitProvider,
  informationalUrl,
  parseSshRepository,
  type SshArchiveReader,
} from './ssh-provider.js';

const REPOSITORY = 'git@git.example.com:acme/lib.git';
const DATES = {
  main: '2024-01-02T03:04:05Z',
  feature: '2024-03-04T05:06:07Z',
};

const KEY_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'QUJDREVG'.repeat(8)}\n-----END OPENSSH PRIVATE KEY-----`;
const KEY = parseCredentialMaterial(
  'ssh_key',
  JSON.stringify({ privateKeyPem: KEY_PEM, knownHosts: 'git.example.com ssh-ed25519 AAAA' }),
) as SshKeyMaterial;

let root: string;
let bare: string;
let altBare: string;
let altCommits: Record<string, string>;
let catFileBytes = new Map<string, number>();
let commits: Record<string, string>;
let archiveCalls: number;
let showCalls: number;
let tzBare: string;
let gcBare: string;
let trunkBare: string;
let movedHeadBare: string;

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      ...(date === undefined ? {} : { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }),
    },
  })
    .toString()
    .trim();
}

function commitComposer(work: string, json: object, date: string): string {
  execFileSync('sh', ['-c', 'cat > composer.json'], { cwd: work, input: JSON.stringify(json) });
  git(work, ['add', 'composer.json']);
  git(work, ['commit', '-q', '-m', 'c'], date);
  return git(work, ['rev-parse', 'HEAD']);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ssh-provider-'));
  const work = join(root, 'work');
  git(root, ['init', '-q', '-b', 'main', work]);
  const main = commitComposer(work, { name: 'acme/lib', require: { php: '>=8.1' } }, DATES.main);
  git(work, ['tag', '-a', 'v1.0.0', '-m', 'release'], DATES.main);
  git(work, ['checkout', '-q', '-b', 'feature']);
  const feature = commitComposer(work, { name: 'acme/lib', description: 'beta' }, DATES.feature);
  git(work, ['tag', 'v2.0.0-beta1']);
  git(work, ['checkout', '-q', '-b', 'other', main]);
  const foreign = commitComposer(work, { name: 'evil/other' }, DATES.feature);
  git(work, ['tag', 'v0.9.0']);
  git(work, ['checkout', '-q', '-b', 'huge', main]);
  const huge = commitComposer(
    work,
    { name: 'acme/lib', description: 'x'.repeat(4 * 1024 * 1024) },
    DATES.feature,
  );
  git(work, ['tag', 'v0.8.0']);
  git(work, ['checkout', '-q', '-b', 'invalid', main]);
  const invalid = commitComposer(
    work,
    { name: 'acme/lib', description: 'y'.repeat(300_000) },
    DATES.feature,
  );
  git(work, ['tag', 'v0.7.0']);
  git(work, ['checkout', '-q', 'main']);
  git(work, ['branch', '-q', '-D', 'invalid']);
  git(work, ['branch', 'feat#1', main]);
  git(work, ['checkout', '-q', 'main']);
  git(work, ['branch', '-q', '-D', 'other', 'huge']);
  bare = join(root, 'remote.git');
  git(root, ['clone', '-q', '--bare', work, bare]);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  git(bare, ['update-ref', 'refs/pull/2/refs/heads/evil', main]);
  git(bare, ['update-ref', 'refs/pull/3/HEAD', main]);
  commits = { main, feature, foreign, huge, invalid };

  const tz = join(root, 'tz');
  git(root, ['init', '-q', '-b', 'main', tz]);
  commitComposer(tz, { name: 'acme/lib' }, '2024-05-06T07:08:09+02:00');
  tzBare = join(root, 'tz.git');
  git(root, ['clone', '-q', '--bare', tz, tzBare]);

  const gc = join(root, 'gc');
  git(root, ['init', '-q', '-b', 'main', gc]);
  writeFileSync(join(gc, 'first.txt'), 'first');
  git(gc, ['add', '.']);
  git(gc, ['commit', '-q', '-m', 'gc'], DATES.main);
  git(gc, ['checkout', '-q', '-b', 'second']);
  writeFileSync(join(gc, 'second.txt'), 'second');
  git(gc, ['add', '.']);
  git(gc, ['commit', '-q', '-m', 'second'], DATES.feature);
  gcBare = join(root, 'gc.git');
  git(root, ['clone', '-q', '--bare', gc, gcBare]);

  const trunk = join(root, 'trunk');
  git(root, ['init', '-q', '-b', 'main', trunk]);
  commitComposer(trunk, { name: 'other/main-branch' }, DATES.main);
  git(trunk, ['checkout', '-q', '-b', 'trunk']);
  commitComposer(trunk, { name: 'acme/lib' }, DATES.feature);
  trunkBare = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', trunk, trunkBare]);
  movedHeadBare = join(root, 'moved-head.git');
  git(root, ['clone', '-q', '--bare', trunkBare, movedHeadBare]);
  git(movedHeadBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const alt = join(root, 'alt');
  git(root, ['init', '-q', '-b', 'main', alt]);
  writeFileSync(join(alt, 'README'), 'no manifest here');
  git(alt, ['add', 'README']);
  git(alt, ['commit', '-q', '-m', 'readme'], DATES.main);
  const readme = git(alt, ['rev-parse', 'HEAD']);
  git(alt, ['checkout', '-q', '-b', 'rel']);
  const small = commitComposer(alt, { name: 'acme/lib' }, DATES.main);
  git(alt, ['tag', 'v1.0.0']);
  writeFileSync(join(alt, 'big.bin'), randomBytes(700_000));
  git(alt, ['add', 'big.bin']);
  git(alt, ['commit', '-q', '-m', 'big'], DATES.feature);
  const big = git(alt, ['rev-parse', 'HEAD']);
  git(alt, ['tag', 'v1.1.0']);
  git(alt, ['rm', '-q', 'big.bin']);
  const echo = commitComposer(alt, { name: 'acme/lib', description: KEY_PEM }, DATES.feature);
  git(alt, ['tag', 'v1.2.0']);
  git(alt, ['checkout', '-q', 'main']);
  git(alt, ['branch', '-q', '-D', 'rel']);
  altBare = join(root, 'alt.git');
  git(root, ['clone', '-q', '--bare', alt, altBare]);
  git(altBare, ['config', 'uploadpack.allowFilter', 'true']);
  altCommits = { readme, small, big, echo };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface StubOptions {
  readonly target?: string;
  readonly beforeFetch?: () => void;
}

const stubSpawn =
  (fail = false, stub: StubOptions = {}): SpawnGit =>
  (command, args, options) => {
    if (args.includes('archive')) archiveCalls += 1;
    if (args.includes('show')) showCalls += 1;
    if (args.includes('fetch') && stub.beforeFetch !== undefined) stub.beforeFetch();
    const target = stub.target ?? bare;
    const rewritten = args.map((arg) =>
      arg.startsWith('ssh://') ? (fail ? 'file:///nonexistent/repo.git' : `file://${target}`) : arg,
    );
    const child = spawn(command, rewritten, {
      ...options,
      env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' },
    });
    const read = args.find((arg) => arg.endsWith(':composer.json'));
    if (read !== undefined) {
      child.stdout?.on('data', (chunk: Buffer) => {
        catFileBytes.set(read, (catFileBytes.get(read) ?? 0) + chunk.length);
      });
    }
    return child;
  };

function memoryStore(): SshArchiveReader & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const records = new Map<string, { sha1: string; time: string | null }>();
  return {
    stored,
    async find(scope, from, name, versionNormalized, commit) {
      return (
        records.get(`${scope.orgId}/${from.id}/${name}/${versionNormalized}@${commit}`) ?? null
      );
    },
    async readZip(scope, from, name, versionNormalized, commit) {
      return stored.get(`${scope.orgId}/${from.id}/${name}/${versionNormalized}@${commit}`) ?? null;
    },
    async store(scope, from, name, archive) {
      const key = `${scope.orgId}/${from.id}/${name}/${archive.versionNormalized}@${archive.commit}`;
      stored.set(key, archive.zip);
      records.set(key, { sha1: archive.sha1, time: archive.time });
    },
  };
}

const source = (
  extra: Partial<{ packageName: string; tags: boolean; branches: string[] }> = {},
): ProviderSource => ({
  id: 'src-1',
  ecosystem: 'composer',
  url: null,
  type: 'vcs',
  config: {
    provider: 'ssh',
    repository: REPOSITORY,
    ...(extra.packageName === undefined ? {} : { packageName: extra.packageName }),
    refs: { tags: extra.tags ?? true, branches: extra.branches ?? [] },
  },
});

const observability: Observability = {
  log: () => undefined,
  counter: () => undefined,
  histogram: () => undefined,
};

const ctx = {
  org: orgContext('org-1'),
  signal: new AbortController().signal,
  clock: fixedClock('2026-10-16T12:00:00.000Z'),
  observability,
} as ProviderContext;

function provider(
  store: SshArchiveReader,
  fail = false,
  maxStdoutBytes?: number,
  stub: StubOptions = {},
) {
  return createSshGitProvider({
    dnsGuard: createDnsGuard(
      createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      { resolver: async () => [{ address: '93.184.216.34', family: 4 }] },
    ),
    sshKey: async () => KEY,
    archives: store,
    tmpRoot: root,
    spawn: stubSpawn(fail, stub),
    ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
  });
}

async function members(store: SshArchiveReader, name = 'acme/lib') {
  const result = await provider(store).describe(ctx, source(), name, {});
  if (result.kind !== 'found') throw new Error(`expected found, got ${result.kind}`);
  const out: VersionCandidate[] = [];
  for await (const member of result.description.members) out.push(member);
  return { description: result.description, out };
}

describe('parseSshRepository', () => {
  it('parses scp-like and ssh:// forms', () => {
    expect(parseSshRepository('git@git.example.com:acme/lib.git')).toEqual({
      host: 'git.example.com',
      user: 'git',
      path: 'acme/lib.git',
    });
    expect(parseSshRepository('ssh://deploy@git.example.com:2222/acme/lib.git')).toEqual({
      host: 'git.example.com',
      user: 'deploy',
      port: 2222,
      path: 'acme/lib.git',
    });
    expect(
      informationalUrl(parseSshRepository('ssh://git@Git.Example.com:2222/acme/lib.git')),
    ).toBe('https://git.example.com/acme/lib.git');
    expect(parseSshRepository('git.example.com:acme/lib.git')).toEqual({
      host: 'git.example.com',
      path: 'acme/lib.git',
    });
    expect(parseSshRepository('ssh://[2001:db8::1]:2222/acme/lib.git')).toEqual({
      host: '[2001:db8::1]',
      port: 2222,
      path: 'acme/lib.git',
    });
    expect(parseSshRepository('git@[2001:db8::1]:acme/lib.git')).toEqual({
      host: '[2001:db8::1]',
      user: 'git',
      path: 'acme/lib.git',
    });
  });

  it('refuses malformed repositories', () => {
    expect(() => parseSshRepository('https://git.example.com/acme/lib.git')).toThrow();
    expect(() => parseSshRepository('git@-oProxyCommand=x:acme/lib.git')).toThrow();
  });
});

describe('createSshGitProvider', () => {
  it('yields every tag, including tags off the default branch, with commit dates', async () => {
    archiveCalls = 0;
    const { description, out } = await members(memoryStore());
    const raws = out.map((member) => JSON.parse(member.raw) as Record<string, unknown>);
    const versions = out.map((member) => member.version).sort();
    expect(versions).toEqual(['dev-feature', 'dev-main', 'v1.0.0', 'v2.0.0-beta1']);
    const beta = raws.find((raw) => raw['version'] === 'v2.0.0-beta1');
    expect(beta).toMatchObject({
      name: 'acme/lib',
      description: 'beta',
      time: '2024-03-04T05:06:07+00:00',
      dist: {
        type: 'zip',
        url: 'https://git.example.com/acme/lib.git',
        reference: commits['feature'],
      },
    });
    const stable = out.find((member) => member.version === 'v1.0.0');
    expect(stable).toMatchObject({
      form: 'composer-p2',
      upstreamTime: '2024-01-02T03:04:05+00:00',
    });
    expect(out.find((member) => member.version === 'dev-main')?.form).toBe('composer-p2-dev');
    expect(JSON.stringify(raws)).not.toContain(commits['foreign']);
    expect(JSON.stringify(raws)).not.toContain(commits['huge']);
    expect(description.upstreamComplete).toBe(true);
    expect(description.snapshot.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('publishes the sha1 of the stored archive', async () => {
    const store = memoryStore();
    const { out } = await members(store);
    for (const member of out) {
      const dist = (JSON.parse(member.raw) as { dist: { reference: string; shasum: string } }).dist;
      const zip = [...store.stored.entries()].find(([key]) => key.endsWith(dist.reference))?.[1];
      expect(zip).toBeDefined();
      expect(dist.shasum).toBe(
        createHash('sha1')
          .update(zip as Uint8Array)
          .digest('hex'),
      );
    }
  });

  it('scopes archives by the organization of the provider context', async () => {
    const holder = await realpath(await mkdtemp(join(tmpdir(), 'ssh-org-')));
    try {
      const fsStore = await createFilesystemArchiveStore(join(holder, 'store'), {
        maxZipBytes: 4 * 1024 * 1024,
      });
      archiveCalls = 0;
      const describeAs = (org: string) =>
        provider(fsStore).describe({ ...ctx, org: orgContext(org) }, source(), 'acme/lib', {});
      await describeAs('org-a');
      expect(archiveCalls).toBe(4);
      await describeAs('org-a');
      expect(archiveCalls).toBe(4);
      await describeAs('org-b');
      expect(archiveCalls).toBe(8);
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  });

  it('opens built archives without contacting the upstream, including branch and prerelease versions', async () => {
    const store = await createFilesystemArchiveStore(join(await realpath(root), 'dist-store'), {
      maxZipBytes: 4 * 1024 * 1024,
    });
    const result = await provider(store).describe(ctx, source(), 'acme/lib', {});
    if (result.kind !== 'found') throw new Error('expected found');
    let count = 0;
    for await (const member of result.description.members) {
      const raw = JSON.parse(member.raw) as {
        version_normalized: string;
        dist: { reference: string; shasum: string };
      };
      const opened = await provider(store, true).openDist(ctx, source(), {
        packageName: 'acme/lib',
        version: member.version,
        sourceRef: raw.dist.reference,
        distType: 'zip',
        url: null,
      });
      const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
      expect(bytes).toEqual(
        await store.readZip(
          ctx.org,
          source(),
          'acme/lib',
          raw.version_normalized,
          raw.dist.reference,
        ),
      );
      expect(opened.size).toBe(bytes.byteLength);
      expect(createHash('sha1').update(bytes).digest('hex')).toBe(raw.dist.shasum);
      count += 1;
    }
    expect(count).toBe(4);
  });

  it('opens a numeric branch using its normalized archive version', async () => {
    const store = await createFilesystemArchiveStore(join(await realpath(root), 'dist-branch'), {
      maxZipBytes: 4 * 1024 * 1024,
    });
    const numericBare = join(root, 'numeric.git');
    git(root, ['clone', '-q', '--bare', bare, numericBare]);
    git(numericBare, ['branch', 'v1.x', commits['main']!]);
    const src = source({ tags: false, branches: ['v1.x'] });
    const result = await provider(store, false, undefined, { target: numericBare }).describe(
      ctx,
      src,
      'acme/lib',
      {},
    );
    if (result.kind !== 'found') throw new Error('expected found');
    const versions: string[] = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions).toContain('v1.x-dev');
    const zip = await store.readZip(
      ctx.org,
      src,
      'acme/lib',
      '1.9999999.9999999.9999999-dev',
      commits['main']!,
    );
    expect(zip).not.toBeNull();
    const opened = await provider(store, true).openDist(ctx, source(), {
      packageName: 'acme/lib',
      version: 'v1.x-dev',
      sourceRef: commits['main']!,
      distType: 'zip',
      url: null,
    });
    expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(zip);
    expect(opened.size).toBe(zip!.byteLength);
  });

  it('refuses absent and foreign archive tuples without falling back to upstream', async () => {
    const store = await createFilesystemArchiveStore(join(await realpath(root), 'dist-isolation'), {
      maxZipBytes: 1024,
    });
    await store.store(ctx.org, source(), 'acme/lib', {
      version: 'v1.0.0',
      versionNormalized: '1.0.0.0',
      commit: commits['main']!,
      zip: new Uint8Array([80, 75]),
      sha1: '0'.repeat(40),
      time: null,
    });
    const target = {
      packageName: 'acme/lib',
      version: 'v1.0.0',
      sourceRef: commits['main']!,
      distType: 'zip' as const,
      url: 'https://git.example.com/acme/lib.git',
    };
    const offline = provider(store, true);
    const cases = [
      { context: { ...ctx, org: orgContext('foreign-org') }, src: source(), target },
      { context: ctx, src: { ...source(), id: 'foreign-source' }, target },
      { context: ctx, src: source(), target: { ...target, packageName: 'other/lib' } },
      { context: ctx, src: source(), target: { ...target, version: 'v2.0.0' } },
      { context: ctx, src: source(), target: { ...target, sourceRef: 'f'.repeat(40) } },
    ];
    for (const entry of cases) {
      await expect(offline.openDist(entry.context, entry.src, entry.target)).rejects.toMatchObject({
        name: 'UpstreamError',
        code: 'http_status',
        status: 404,
      });
    }
  });

  it('logs a data-free event for a missing archive and maps store failures to a network error', async () => {
    const store = memoryStore();
    const log = vi.fn();
    const target = {
      packageName: 'acme/lib',
      version: 'v1.0.0',
      sourceRef: commits['main']!,
      distType: 'zip' as const,
      url: null,
    };
    const observed = { ...ctx, observability: { ...ctx.observability, log } };
    await expect(provider(store, true).openDist(observed, source(), target)).rejects.toMatchObject({
      name: 'UpstreamError',
      code: 'http_status',
      status: 404,
    });
    expect(log.mock.calls).toEqual([[{ level: 'warn', event: 'dist.archive_missing' }]]);
    log.mockClear();
    for (const failure of ['io', 'unsafe_root', 'invalid_metadata'] as const) {
      vi.spyOn(store, 'readZip').mockRejectedValueOnce(new SshArchiveStoreError(failure, 'EIO'));
      const error = await provider(store, true)
        .openDist(observed, source(), target)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ code: 'network', message: 'upstream network' });
      expect(log.mock.calls).toEqual([
        [{ level: 'warn', event: 'dist.archive_store_error', reason_code: failure }],
      ]);
      log.mockClear();
    }
    vi.spyOn(store, 'readZip').mockRejectedValueOnce(new RangeError('programming error'));
    await expect(provider(store, true).openDist(observed, source(), target)).rejects.toThrow(
      RangeError,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('keys the in-memory archive helper by organization, source and package name', async () => {
    const store = memoryStore();
    const zip = new Uint8Array([80, 75, 5, 6]);
    await store.store(ctx.org, source(), 'acme/lib', {
      version: 'v1.0.0',
      versionNormalized: '1.0.0.0',
      commit: commits['main']!,
      zip,
      sha1: createHash('sha1').update(zip).digest('hex'),
      time: null,
    });
    const read = (org: string, id: string, name: string) =>
      store.readZip(orgContext(org), { ...source(), id }, name, '1.0.0.0', commits['main']!);
    expect(await read('org-1', 'src-1', 'acme/lib')).toEqual(zip);
    expect(await read('org-2', 'src-1', 'acme/lib')).toBeNull();
    expect(await read('org-1', 'src-2', 'acme/lib')).toBeNull();
    expect(await read('org-1', 'src-1', 'acme/other')).toBeNull();
  });

  it('refuses invalid dist targets with data-free errors and honours cancellation', async () => {
    const store = memoryStore();
    const read = vi.spyOn(store, 'readZip');
    const target = {
      packageName: 'acme/lib',
      version: 'v1.0.0',
      sourceRef: 'a'.repeat(40),
      distType: 'zip' as const,
      url: null,
    };
    for (const change of [
      { sourceRef: null },
      { sourceRef: 'secret-commit' },
      { distType: 'tar' as const },
      { version: 'secret-invalid' },
      { packageName: 'secret-invalid' },
    ]) {
      await expect(
        provider(store).openDist(ctx, source(), { ...target, ...change }),
      ).rejects.toMatchObject({ name: 'UpstreamError', message: 'upstream refused' });
    }
    const abort = new AbortController();
    abort.abort();
    await expect(
      provider(store).openDist({ ...ctx, signal: abort.signal }, source(), target),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('quarantines a stored SSH archive whose bytes mismatch the published digest', async () => {
    const store = await createFilesystemArchiveStore(join(await realpath(root), 'dist-corrupt'), {
      maxZipBytes: 1024,
    });
    await store.store(ctx.org, source(), 'acme/lib', {
      version: 'v1.0.0',
      versionNormalized: '1.0.0.0',
      commit: commits['main']!,
      zip: new Uint8Array([80, 75, 99]),
      sha1: '0'.repeat(40),
      time: null,
    });
    const quarantine = vi.fn(async () => ({ changed: true, statements: 1 }));
    const attachDist = vi.fn();
    const put = vi.fn();
    const log = vi.fn();
    const guard = {} as CatalogueWriteGuard;
    expect(
      await fetchAndVerifyDist(
        {
          provider: provider(store, true),
          providerContext: {
            ...ctx,
            codecs: nodeCodecs,
            observability: { log, counter: vi.fn(), histogram: vi.fn() },
          } as ProviderContext,
          source: source(),
          store: { put } as unknown as BlobStore,
          writer: { quarantine, attachDist },
          blobReplacer: { replaceBlob: vi.fn() },
          maxBytes: 1024,
        },
        ctx.org,
        guard,
        {
          versionId: 'version-1',
          revision: 1,
          packageName: 'acme/lib',
          version: 'v1.0.0',
          previousBlob: null,
          fetch: {
            sourceRef: commits['main']!,
            distType: 'zip',
            upstreamDistUrl: null,
            composerShasum: '0'.repeat(40),
            npmIntegrity: null,
            npmShasum: null,
          },
        },
      ),
    ).toBe('quarantined');
    expect(quarantine).toHaveBeenCalledWith(ctx.org, guard, {
      versionId: 'version-1',
      reason: 'digest_mismatch',
    });
    expect(attachDist).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'dist.quarantined',
      reason_code: 'digest_mismatch',
      source_id: 'src-1',
    });
  });

  it('builds each archive once and never rebuilds an existing version', async () => {
    const store = memoryStore();
    archiveCalls = 0;
    const first = await members(store);
    expect(archiveCalls).toBe(4);
    expect(store.stored.size).toBe(4);
    const second = await members(store);
    expect(archiveCalls).toBe(4);
    expect(second.out.map((member) => member.raw)).toEqual(first.out.map((member) => member.raw));
    expect(second.description.snapshot.id).toBe(first.description.snapshot.id);
  });

  it('skips tags when the source disables them', async () => {
    const result = await provider(memoryStore()).describe(
      ctx,
      source({ tags: false }),
      'acme/lib',
      {},
    );
    if (result.kind !== 'found') throw new Error('expected found');
    const versions: string[] = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions.sort()).toEqual(['dev-feature', 'dev-main']);
  });

  it('answers not_found for a name the repository does not hold', async () => {
    const result = await provider(memoryStore()).describe(
      ctx,
      source({ packageName: 'acme/lib' }),
      'other/pkg',
      {},
    );
    expect(result).toEqual({ kind: 'not_found', definitive: true });
  });

  it('lists the one package with last=true after a successful ls-remote', async () => {
    const page = await provider(memoryStore()).listPackages?.(ctx, source(), null);
    expect(page).toMatchObject({ names: ['acme/lib'], next: null, last: true });
    expect(page?.snapshot.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('never reports last=true when ls-remote fails', async () => {
    const page = await provider(memoryStore(), true).listPackages?.(
      ctx,
      source({ packageName: 'acme/lib' }),
      null,
    );
    expect(page).toMatchObject({ names: ['acme/lib'], next: null, last: false });
  });

  it('refuses a source that is not an ssh vcs source', async () => {
    const git: ProviderSource = {
      ...source(),
      config: {
        provider: 'git',
        repository: 'https://x.example/r.git',
        refs: { tags: true, branches: [] },
      },
    } as ProviderSource;
    await expect(provider(memoryStore()).describe(ctx, git, 'acme/lib', {})).rejects.toThrow();
  });

  async function versionsOf(
    src: ProviderSource,
    options: { maxStdoutBytes?: number; signal?: AbortSignal; stub?: StubOptions } = {},
  ): Promise<string[]> {
    const context = { ...ctx, ...(options.signal === undefined ? {} : { signal: options.signal }) };
    const result = await provider(
      memoryStore(),
      false,
      options.maxStdoutBytes,
      options.stub,
    ).describe(context, src, 'acme/lib', {});
    if (result.kind !== 'found') throw new Error(`expected found, got ${result.kind}`);
    const versions: string[] = [];
    for await (const member of result.description.members) versions.push(member.version);
    return versions.sort();
  }

  it('answers not_found for a foreign name when packageName is not configured', async () => {
    const result = await provider(memoryStore()).describe(ctx, source(), 'evil/other', {});
    expect(result).toEqual({ kind: 'not_found', definitive: true });
  });

  it('does not report a complete listing when the package name cannot be resolved', async () => {
    const page = await provider(memoryStore()).listPackages?.(
      ctx,
      source({ tags: false, branches: ['absent'] }),
      null,
    );
    expect(page).toMatchObject({ names: [], next: null, last: false });
  });

  it('skips refs whose names fall outside the safe charset', async () => {
    const versions = await versionsOf(source());
    expect(versions).not.toContain('dev-feat#1');
    expect(versions).toEqual(['dev-feature', 'dev-main', 'v1.0.0', 'v2.0.0-beta1']);
  });

  it('honours the configured branch filter', async () => {
    expect(await versionsOf(source({ branches: ['feature'] }))).toEqual([
      'dev-feature',
      'v1.0.0',
      'v2.0.0-beta1',
    ]);
  });

  async function describeAlt(store: SshArchiveReader, maxStdoutBytes?: number) {
    const result = await provider(store, false, maxStdoutBytes, { target: altBare }).describe(
      ctx,
      source(),
      'acme/lib',
      {},
    );
    if (result.kind !== 'found') throw new Error(`expected found, got ${result.kind}`);
    const out: VersionCandidate[] = [];
    for await (const member of result.description.members) out.push(member);
    return { complete: result.description.upstreamComplete, out };
  }

  it('reports an incomplete description when an archive exceeds the output limit', async () => {
    const store = memoryStore();
    const { complete, out } = await describeAlt(store, 600_000);
    expect(out.map((member) => member.version)).toEqual(['v1.0.0']);
    expect(complete).toBe(false);
    for (const key of store.stored.keys()) expect(key).not.toContain(altCommits['big']);
  });

  it('keeps the description complete when only a manifest is oversized', async () => {
    catFileBytes = new Map();
    const result = await provider(memoryStore()).describe(ctx, source(), 'acme/lib', {});
    if (result.kind !== 'found') throw new Error('expected found');
    const versions: string[] = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions).not.toContain('v0.8.0');
    expect(result.description.upstreamComplete).toBe(true);
    const consumed = catFileBytes.get(`${commits['huge']}:composer.json`) ?? 0;
    expect(consumed).toBeGreaterThan(0);
    expect(consumed).toBeLessThan(1024 * 1024 + 256 * 1024);
  });

  it('resolves the name from tags when the preferred branch has no manifest', async () => {
    const page = await provider(memoryStore(), false, undefined, {
      target: altBare,
    }).listPackages?.(ctx, source(), null);
    expect(page).toMatchObject({ names: ['acme/lib'], last: true });
    const { complete, out } = await describeAlt(memoryStore());
    expect(out.map((member) => member.version).sort()).toEqual(['v1.0.0', 'v1.1.0']);
    expect(complete).toBe(true);
  });

  it('refuses a version whose manifest echoes the ssh key and emits sanitized metadata', async () => {
    const store = memoryStore();
    const { out } = await describeAlt(store);
    expect(out.map((member) => member.version)).not.toContain('v1.2.0');
    for (const member of out) expect(member.raw).not.toContain('PRIVATE KEY');
    for (const key of store.stored.keys()) expect(key).not.toContain(altCommits['echo']);
  });

  it('builds from the commit discovered by ls-remote when a ref moves afterwards', async () => {
    const moved = join(root, `moved-${Date.now()}.git`);
    git(root, ['clone', '-q', '--bare', bare, moved]);
    git(moved, ['config', 'uploadpack.allowFilter', 'true']);
    const mover = join(root, `mover-${Date.now()}`);
    git(root, ['clone', '-q', moved, mover]);
    const next = commitComposer(mover, { name: 'acme/lib', description: 'moved' }, DATES.feature);
    let pushed = false;
    const beforeFetch = (): void => {
      if (pushed) return;
      pushed = true;
      git(mover, ['push', '-q', 'origin', 'main']);
    };
    const result = await provider(memoryStore(), false, undefined, {
      target: moved,
      beforeFetch,
    }).describe(ctx, source(), 'acme/lib', {});
    if (result.kind !== 'found') throw new Error('expected found');
    const raws: string[] = [];
    for await (const member of result.description.members) {
      if (member.version === 'dev-main') raws.push(member.raw);
    }
    expect(pushed).toBe(true);
    expect(raws).toHaveLength(1);
    expect(raws[0]).toContain(commits['main']);
    expect(raws[0]).not.toContain(next);
    expect(raws[0]).not.toContain('moved');
  });

  it('stops between versions when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(versionsOf(source(), { signal: controller.signal })).rejects.toThrow('stop');
  });

  it('stores no archive for a version that fails the composer check', async () => {
    const store = memoryStore();
    archiveCalls = 0;
    await provider(store).describe(ctx, source(), 'acme/lib', {});
    for (const key of store.stored.keys()) {
      expect(key).not.toContain(commits['foreign']);
      expect(key).not.toContain(commits['invalid']);
    }
    expect(archiveCalls).toBe(store.stored.size);
  });
});

function openFixtureSession(target: string, wrap?: SpawnGit) {
  const spawnGit = stubSpawn(false, { target });
  return openSshGitSession(parseSshRepository(REPOSITORY), {
    dnsGuard: createDnsGuard(
      createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
      { resolver: async () => [{ address: '93.184.216.34', family: 4 }] },
    ),
    credential: KEY,
    tmpRoot: root,
    spawn: wrap ?? spawnGit,
  });
}

describe('SSH ref metadata', () => {
  it('lists only HEAD, branches and tags, ignoring tail-matching foreign refs', async () => {
    const session = await openFixtureSession(bare);
    try {
      const names = (await session.lsRemote()).map((ref) => ref.name);
      expect(names).toContain('HEAD');
      expect(names).toContain('refs/heads/main');
      expect(names.filter((name) => name.includes('refs/pull'))).toEqual([]);
      for (const name of names) {
        expect(name === 'HEAD' || /^refs\/(?:heads|tags)\//.test(name)).toBe(true);
      }
    } finally {
      await session.close();
    }
  });

  it('keeps foreign refs out of the snapshot digest', async () => {
    const clean = join(root, `clean-${Date.now()}.git`);
    git(root, ['clone', '-q', '--bare', bare, clean]);
    git(clean, ['update-ref', '-d', 'refs/pull/2/refs/heads/evil']);
    git(clean, ['update-ref', '-d', 'refs/pull/3/HEAD']);
    const snapshotOf = async (target: string) => {
      const result = await provider(memoryStore(), false, undefined, { target }).describe(
        ctx,
        source(),
        'acme/lib',
        {},
      );
      if (result.kind !== 'found') throw new Error('expected found');
      return result.description.snapshot;
    };
    expect(await snapshotOf(bare)).toEqual(await snapshotOf(clean));
  });

  it('prefers the remote default branch over main when resolving the package name', async () => {
    const page = await provider(memoryStore(), false, undefined, {
      target: trunkBare,
    }).listPackages?.(ctx, source(), null);
    expect(page).toMatchObject({ names: ['acme/lib'], last: true });
  });

  it('changes the snapshot id when HEAD moves to another branch', async () => {
    const snapshotOf = async (target: string) => {
      const result = await provider(memoryStore(), false, undefined, { target }).describe(
        ctx,
        source({ packageName: 'acme/lib' }),
        'acme/lib',
        {},
      );
      if (result.kind !== 'found') throw new Error('expected found');
      return result.description.snapshot.id;
    };
    const before = await snapshotOf(trunkBare);
    expect(await snapshotOf(trunkBare)).toBe(before);
    expect(await snapshotOf(movedHeadBare)).not.toBe(before);
  });

  it('normalizes commit times to UTC and forbids lazy fetches', async () => {
    const envs: Record<string, string | undefined>[] = [];
    const inner = stubSpawn(false, { target: tzBare });
    const session = await openFixtureSession(tzBare, (command, args, options) => {
      if (args.includes('show')) envs.push({ ...options.env });
      return inner(command, args, options);
    });
    try {
      await session.lsRemote();
      await session.fetchRefs(['refs/heads/main'], { filter: 'blob:none', depth: 1 });
      expect(await session.commitTime('refs/heads/main')).toBe('2024-05-06T05:08:09.000Z');
      expect(envs).toHaveLength(1);
      expect(envs[0]?.['GIT_NO_LAZY_FETCH']).toBe('1');
      await expect(session.commitTime('f'.repeat(40))).rejects.toMatchObject({
        reason: expect.stringMatching(/^(?:not_found|git_failed)$/),
      });
    } finally {
      await session.close();
    }
  });

  it('reads the commit time once per commit', async () => {
    const store = memoryStore();
    archiveCalls = 0;
    showCalls = 0;
    await provider(store).describe(ctx, source(), 'acme/lib', {});
    const commitsStored = new Set([...store.stored.keys()].map((key) => key.split('@')[1]));
    expect(archiveCalls).toBeGreaterThan(commitsStored.size);
    expect(showCalls).toBe(commitsStored.size);
  });

  it('discovers HEAD symref and reads fetched commit times without further transport calls', async () => {
    const pids: number[] = [];
    const invocations: string[][] = [];
    const spawnGit = stubSpawn();
    const session = await openSshGitSession(parseSshRepository(REPOSITORY), {
      dnsGuard: createDnsGuard(
        createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
        { resolver: async () => [{ address: '93.184.216.34', family: 4 }] },
      ),
      credential: KEY,
      tmpRoot: root,
      spawn(command, args, options) {
        invocations.push([...args]);
        const child = spawnGit(command, args, options);
        if (child.pid !== undefined) pids.push(child.pid);
        return child;
      },
    });
    try {
      const refs = await session.lsRemote();
      expect(refs.find((ref) => ref.name === 'HEAD')).toMatchObject({
        symref: 'refs/heads/main',
        sha: commits['main'],
      });
      const selected = refs.filter((ref) =>
        ['refs/heads/main', 'refs/heads/feature', 'refs/tags/v1.0.0'].includes(ref.name),
      );
      await session.fetchRefs(
        selected.map((ref) => ref.name),
        { filter: 'blob:none', depth: 1 },
      );
      const networkCalls = () =>
        invocations.filter((args) => args.includes('fetch') || args.includes('ls-remote')).length;
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
        expect(() => process.kill(-pid, 0)).toThrow();
      }
      const before = networkCalls();
      for (const ref of selected) {
        expect(await session.commitTime(ref.name)).toBe(
          new Date(git(bare, ['log', '-1', '--format=%cI', ref.name])).toISOString(),
        );
      }
      expect(networkCalls()).toBe(before);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
        expect(() => process.kill(-pid, 0)).toThrow();
      }
    } finally {
      await session.close();
    }
  });
});

describe('SSH scratch repository maintenance', () => {
  const autoGcEnv = {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '1',
    GIT_CONFIG_KEY_1: 'gc.autoDetach',
    GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_KEY_2: 'gc.autoPackLimit',
    GIT_CONFIG_VALUE_2: '1',
  };
  const packCount = (repo: string): number =>
    readdirSync(join(repo, 'objects', 'pack')).filter((file) => file.endsWith('.pack')).length;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('control: without the quiet flags the second fetch triggers a detached gc', async () => {
    const repo = join(root, `gc-control-${Date.now()}.git`);
    git(root, ['init', '-q', '--bare', repo]);
    for (const refspec of ['main:refs/heads/main', 'second:refs/heads/second']) {
      const result = spawnSync(
        'git',
        [
          `--git-dir=${repo}`,
          '-c',
          'transfer.fsckObjects=true',
          'fetch',
          '--no-tags',
          '--depth=1',
          `file://${gcBare}`,
          refspec,
        ],
        {
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: root,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_ALLOW_PROTOCOL: 'file',
            ...autoGcEnv,
          },
        },
      );
      expect(result.status).toBe(0);
    }
    let packs = packCount(repo);
    for (let waited = 0; packs !== 1 && waited < 5000; waited += 100) {
      await pause(100);
      packs = packCount(repo);
    }
    expect(packs).toBe(1);
  });

  const lockFiles = (repo: string): string[] =>
    ['gc.pid', join('objects', 'maintenance.lock')].filter((file) => existsSync(join(repo, file)));
  const watchLocks = async (
    repo: string,
    ms: number,
    stopOnSight: boolean,
    every = 5,
  ): Promise<string[]> => {
    const seen = new Set<string>();
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      for (const file of lockFiles(repo)) seen.add(file);
      if (stopOnSight && seen.size > 0) break;
      await pause(every);
    }
    return [...seen];
  };

  it('control: with gc.auto=1 the second fetch leaves a gc.pid or maintenance lock', async () => {
    const repo = join(root, `gc-lock-control-${Date.now()}.git`);
    git(root, ['init', '-q', '--bare', repo]);
    const fetchInto = (refspec: string) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          'git',
          [`--git-dir=${repo}`, 'fetch', '--no-tags', '--depth=1', `file://${gcBare}`, refspec],
          {
            stdio: 'ignore',
            env: {
              PATH: process.env['PATH'] ?? '/usr/bin:/bin',
              HOME: root,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_ALLOW_PROTOCOL: 'file',
              ...autoGcEnv,
            },
          },
        );
        child.on('error', () => resolve(null));
        child.on('close', resolve);
      });
    expect(await fetchInto('main:refs/heads/main')).toBe(0);
    const lockDeadlineMs = 15_000;
    const seen = new Set<string>();
    const note = (_event: string, name: string | null | Buffer) => {
      if (name === 'gc.pid' || name === 'maintenance.lock') seen.add(name);
    };
    const watchers = [watch(repo, note), watch(join(repo, 'objects'), note)];
    try {
      expect(await fetchInto('second:refs/heads/second')).toBe(0);
      for (const deadline = Date.now() + lockDeadlineMs; seen.size === 0;) {
        if (Date.now() > deadline) break;
        await pause(20);
      }
    } finally {
      for (const watcher of watchers) watcher.close();
    }
    expect(
      seen.size,
      `no gc.pid or maintenance.lock appeared within ${lockDeadlineMs} ms after the second fetch ended`,
    ).toBeGreaterThan(0);
  }, 40_000);

  it('the quiet configuration leaves no gc.pid and no maintenance lock', async () => {
    const inner = stubSpawn(false, { target: gcBare });
    const session = await openFixtureSession(gcBare, (command, args, options) =>
      inner(command, args, { ...options, env: { ...autoGcEnv, ...options.env } }),
    );
    try {
      await session.lsRemote();
      await session.fetchRefs(['refs/heads/main'], { filter: 'none', depth: 1 });
      const scratch = readdirSync(root).find((entry) => entry.startsWith('ssh-git-')) ?? '';
      const repo = join(root, scratch, 'repo.git');
      expect(existsSync(join(repo, 'objects'))).toBe(true);
      const during = watchLocks(repo, 1500, false);
      await session.fetchRefs(['refs/heads/second'], { filter: 'none', depth: 1 });
      const after = watchLocks(repo, 1500, false);
      expect(await during).toEqual([]);
      expect(await after).toEqual([]);
      expect(lockFiles(repo)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('the flagged session never starts gc or maintenance', async () => {
    const inner = stubSpawn(false, { target: gcBare });
    const session = await openFixtureSession(gcBare, (command, args, options) =>
      inner(command, args, { ...options, env: { ...autoGcEnv, ...options.env } }),
    );
    try {
      await session.lsRemote();
      await session.fetchRefs(['refs/heads/main'], { filter: 'none', depth: 1 });
      await session.fetchRefs(['refs/heads/second'], { filter: 'none', depth: 1 });
      const scratch = readdirSync(root).find((entry) => entry.startsWith('ssh-git-')) ?? '';
      const repo = join(root, scratch, 'repo.git');
      await pause(1500);
      expect(existsSync(join(repo, 'gc.pid'))).toBe(false);
      expect(existsSync(join(repo, 'gc.log'))).toBe(false);
      expect(packCount(repo)).toBe(2);
    } finally {
      await session.close();
    }
  });
});
