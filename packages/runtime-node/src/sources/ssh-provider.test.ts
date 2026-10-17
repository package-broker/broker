import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { createDnsGuard } from './dns-guard.js';
import type { SpawnGit } from './ssh-git.js';
import {
  createSshGitProvider,
  informationalUrl,
  parseSshRepository,
  type SshArchiveStore,
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
  commits = { main, feature, foreign, huge, invalid };

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

function memoryStore(): SshArchiveStore & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const records = new Map<string, { sha1: string; time: string | null }>();
  return {
    stored,
    async find(_source, _name, versionNormalized, commit) {
      return records.get(`${versionNormalized}@${commit}`) ?? null;
    },
    async store(_source, _name, archive) {
      const key = `${archive.versionNormalized}@${archive.commit}`;
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

const ctx = {
  signal: new AbortController().signal,
  clock: fixedClock('2026-10-16T12:00:00.000Z'),
} as ProviderContext;

function provider(
  store: SshArchiveStore,
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

async function members(store: SshArchiveStore, name = 'acme/lib') {
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

  async function describeAlt(store: SshArchiveStore, maxStdoutBytes?: number) {
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
