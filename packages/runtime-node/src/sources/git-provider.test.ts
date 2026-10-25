import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext } from '@package-broker/core/db/port';
import type { ProviderContext, ProviderSource } from '@package-broker/core/sources/provider';

interface Build {
  orgId: string;
  sourceId: string;
  commit: string;
  signal: AbortSignal;
  release: () => void;
}

const builds = vi.hoisted(() => ({
  calls: [] as Build[],
  directory: '',
  fail: false,
  gated: false,
}));

const opens = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  reached: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      if (opens.hold !== null) {
        opens.reached?.();
        await opens.hold;
      }
      return original.open(...args);
    },
  };
});

vi.mock('@package-broker/core/ingest/vcs/git-provider', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@package-broker/core/ingest/vcs/git-provider')>();
  return {
    ...original,
    createGitProvider: () => ({
      id: 'git',
      sourceTypes: ['vcs'],
      ecosystems: ['composer'],
      listPackages: vi.fn(),
      describe: vi.fn(),
      openDist: vi.fn(),
      async buildArchive(ctx: ProviderContext, source: ProviderSource, commit: string) {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        builds.calls.push({
          orgId: ctx.org.orgId,
          sourceId: source.id,
          commit,
          signal: ctx.signal,
          release,
        });
        const index = builds.calls.length;
        if (builds.gated) {
          await new Promise<void>((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
            void gate.then(resolve);
          });
        }
        if (builds.fail) throw new Error('build failed');
        const path = join(builds.directory, `${String(index)}.zip`);
        const bytes = `${ctx.org.orgId}:${source.id}:${commit}`;
        await writeFile(path, bytes);
        return { path, size: bytes.length, sha1: '0'.repeat(40), sha256: '0'.repeat(64) };
      },
    }),
  };
});

const { createNodeGitProvider, nodeGitProviderFor, openGitArchiveStaging } =
  await import('./git-provider.js');
const { ProviderBusyError } = await import('@package-broker/core/sources/provider');

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const commit = (n: number) => n.toString(16).padStart(40, 'c');
const staging = { create: vi.fn() };

function context(orgId: string, signal = new AbortController().signal): ProviderContext {
  return { org: { orgId } as OrgContext, signal } as unknown as ProviderContext;
}

function source(id: string, provider: 'git' | 'github' = 'git'): ProviderSource {
  return {
    id,
    type: 'vcs',
    ecosystem: 'composer',
    url: null,
    config: {
      provider,
      repository: 'https://git.example.com/acme/lib.git',
      refs: { tags: true, branches: [] },
    },
  } as ProviderSource;
}

const target = (sourceRef: string | null) => ({
  packageName: 'acme/lib',
  version: '1.0.0',
  distType: 'zip' as const,
  sourceRef,
  url: 'https://git.example.com/acme/lib.git',
});

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

const gone = (path: string) =>
  vi.waitFor(async () => {
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

beforeEach(async () => {
  builds.calls = [];
  builds.fail = false;
  builds.gated = false;
  opens.hold = null;
  opens.reached = null;
  builds.directory = await mkdtemp(join(tmpdir(), 'pb-git-provider-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(builds.directory, { recursive: true, force: true });
});

describe('createNodeGitProvider', () => {
  it('builds a commit archive once and serves it to both passes of a store', async () => {
    const provider = createNodeGitProvider({ staging });
    const first = await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    const second = await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    expect(await text(first.body)).toBe(`org-1:src-1:${COMMIT}`);
    expect(await text(second.body)).toBe(`org-1:src-1:${COMMIT}`);
    expect(first.size).toBe(`org-1:src-1:${COMMIT}`.length);
    expect(builds.calls).toHaveLength(1);
  });

  it('never shares a staged archive across organizations, sources or commits', async () => {
    const provider = createNodeGitProvider({ staging });
    const read = async (orgId: string, sourceId: string, ref: string) =>
      text((await provider.openDist(context(orgId), source(sourceId), target(ref))).body);
    expect(await read('org-1', 'src-1', COMMIT)).toBe(`org-1:src-1:${COMMIT}`);
    expect(await read('org-2', 'src-1', COMMIT)).toBe(`org-2:src-1:${COMMIT}`);
    expect(await read('org-1', 'src-2', COMMIT)).toBe(`org-1:src-2:${COMMIT}`);
    expect(await read('org-1', 'src-1', OTHER_COMMIT)).toBe(`org-1:src-1:${OTHER_COMMIT}`);
    expect(builds.calls).toHaveLength(4);
  });

  it('removes the staged file once the reuse window ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = createNodeGitProvider({ staging, reuseMs: 1000 });
    const opened = await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    await text(opened.body);
    const path = join(builds.directory, '1.zip');
    await expect(stat(path)).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    await gone(path);
    await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    expect(builds.calls).toHaveLength(2);
  });

  it('evicts the oldest staged archive beyond the staging limit', async () => {
    const provider = createNodeGitProvider({ staging, maxStaged: 1 });
    await text((await provider.openDist(context('org-1'), source('src-1'), target(COMMIT))).body);
    await text(
      (await provider.openDist(context('org-1'), source('src-1'), target(OTHER_COMMIT))).body,
    );
    await gone(join(builds.directory, '1.zip'));
    await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    expect(builds.calls).toHaveLength(3);
  });

  it('does not keep a failed build', async () => {
    const provider = createNodeGitProvider({ staging });
    builds.fail = true;
    await expect(
      provider.openDist(context('org-1'), source('src-1'), target(COMMIT)),
    ).rejects.toThrow('build failed');
    builds.fail = false;
    await provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
    expect(builds.calls).toHaveLength(2);
  });

  it.each([null, 'main', 'A'.repeat(40), 'a'.repeat(39)])(
    'refuses the source reference %s without building',
    async (sourceRef) => {
      const provider = createNodeGitProvider({ staging });
      await expect(
        provider.openDist(context('org-1'), source('src-1'), target(sourceRef)),
      ).rejects.toMatchObject({ name: 'GitProviderError', code: 'invalid_request' });
      expect(builds.calls).toEqual([]);
    },
  );

  it('refuses a source that is not a generic git source', async () => {
    const provider = createNodeGitProvider({ staging });
    await expect(
      provider.openDist(context('org-1'), source('src-1', 'github'), target(COMMIT)),
    ).rejects.toMatchObject({ name: 'GitProviderError', code: 'invalid_request' });
    expect(builds.calls).toEqual([]);
  });

  describe('concurrency', () => {
    it('answers busy beyond the concurrent build limit and builds again once a slot frees', async () => {
      builds.gated = true;
      const provider = createNodeGitProvider({ staging, maxConcurrentBuilds: 2 });
      const first = provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
      const second = provider.openDist(context('org-1'), source('src-1'), target(commit(2)));
      await expect(
        provider.openDist(context('org-1'), source('src-1'), target(commit(3))),
      ).rejects.toBeInstanceOf(ProviderBusyError);
      expect(builds.calls).toHaveLength(2);
      const joined = provider.openDist(context('org-2'), source('src-1'), target(commit(1)));
      await expect(joined).rejects.toBeInstanceOf(ProviderBusyError);
      builds.calls[0]!.release();
      await text((await first).body);
      const third = provider.openDist(context('org-1'), source('src-1'), target(commit(3)));
      builds.calls[2]!.release();
      builds.calls[1]!.release();
      expect(await text((await third).body)).toBe(`org-1:src-1:${commit(3)}`);
      await text((await second).body);
    });

    it('never evicts an archive that is still building', async () => {
      builds.gated = true;
      const provider = createNodeGitProvider({
        staging,
        maxStaged: 1,
        maxConcurrentBuilds: 4,
      });
      const first = provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
      const second = provider.openDist(context('org-1'), source('src-1'), target(commit(2)));
      expect(builds.calls).toHaveLength(2);
      const again = provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
      expect(builds.calls).toHaveLength(2);
      builds.calls[0]!.release();
      builds.calls[1]!.release();
      expect(await text((await first).body)).toBe(`org-1:src-1:${commit(1)}`);
      expect(await text((await again).body)).toBe(`org-1:src-1:${commit(1)}`);
      await text((await second).body);
    });

    it('keeps an evicted archive readable for a reader that opened it', async () => {
      const provider = createNodeGitProvider({ staging, maxStaged: 2 });
      const held = await provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
      for (let n = 2; n <= 5; n += 1) {
        await text(
          (await provider.openDist(context('org-1'), source('src-1'), target(commit(n)))).body,
        );
      }
      expect(await text(held.body)).toBe(`org-1:src-1:${commit(1)}`);
      await gone(join(builds.directory, '1.zip'));
    });

    it.each([0, 1, 2, 3, 4, 5, 6, 8])(
      'opens an archive evicted %i microtasks after its build settles while a caller awaits it',
      async (ticks) => {
        builds.gated = true;
        const provider = createNodeGitProvider({ staging, maxStaged: 1, maxConcurrentBuilds: 4 });
        const waiting = provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
        builds.calls[0]!.release();
        for (let n = 0; n < ticks; n += 1) await Promise.resolve();
        builds.gated = false;
        const other = provider.openDist(context('org-1'), source('src-1'), target(commit(2)));
        expect(await text((await waiting).body)).toBe(`org-1:src-1:${commit(1)}`);
        await text((await other).body);
      },
    );

    it('does not unlink an archive evicted between its build settling and its reader opening it', async () => {
      const provider = createNodeGitProvider({ staging, maxStaged: 1 });
      let resume!: () => void;
      opens.hold = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        opens.reached = resolve;
      });
      const waiting = provider.openDist(context('org-1'), source('src-1'), target(commit(1)));
      await reached;
      opens.hold = null;
      const other = await provider.openDist(context('org-1'), source('src-1'), target(commit(2)));
      await text(other.body);
      await new Promise((resolve) => setTimeout(resolve, 20));
      resume();
      expect(await text((await waiting).body)).toBe(`org-1:src-1:${commit(1)}`);
      await gone(join(builds.directory, '1.zip'));
    });

    it('lets one caller abort without failing the others sharing the build', async () => {
      builds.gated = true;
      const provider = createNodeGitProvider({ staging });
      const leaving = new AbortController();
      const first = provider.openDist(
        context('org-1', leaving.signal),
        source('src-1'),
        target(COMMIT),
      );
      const second = provider.openDist(context('org-1'), source('src-1'), target(COMMIT));
      leaving.abort(new Error('caller left'));
      await expect(first).rejects.toThrow('caller left');
      expect(builds.calls[0]!.signal.aborted).toBe(false);
      builds.calls[0]!.release();
      expect(await text((await second).body)).toBe(`org-1:src-1:${COMMIT}`);
      expect(builds.calls).toHaveLength(1);
    });

    it('aborts the shared build when every caller has gone', async () => {
      builds.gated = true;
      const provider = createNodeGitProvider({ staging });
      const one = new AbortController();
      const two = new AbortController();
      const first = provider.openDist(
        context('org-1', one.signal),
        source('src-1'),
        target(COMMIT),
      );
      const second = provider.openDist(
        context('org-1', two.signal),
        source('src-1'),
        target(COMMIT),
      );
      one.abort(new Error('gone'));
      two.abort(new Error('gone'));
      await expect(first).rejects.toThrow('gone');
      await expect(second).rejects.toThrow('gone');
      expect(builds.calls[0]!.signal.aborted).toBe(true);
      builds.gated = false;
      await text((await provider.openDist(context('org-1'), source('src-1'), target(COMMIT))).body);
      expect(builds.calls).toHaveLength(2);
    });
  });
});

describe('openGitArchiveStaging', () => {
  it('creates the directory and removes only partial archives older than an hour', async () => {
    const directory = join(builds.directory, 'staging');
    await openGitArchiveStaging(directory);
    const old = `archive-${'d'.repeat(32)}.zip.part`;
    const fresh = `archive-${'e'.repeat(32)}.zip.part`;
    await writeFile(join(directory, old), 'partial');
    await writeFile(join(directory, fresh), 'in flight');
    await writeFile(join(directory, 'keep.txt'), 'other');
    const hourAgo = (Date.now() - 61 * 60_000) / 1000;
    await utimes(join(directory, old), hourAgo, hourAgo);
    const opened = await openGitArchiveStaging(directory);
    expect((await readdir(directory)).sort()).toEqual([fresh, 'keep.txt']);
    const staged = await opened.create();
    expect(staged.path.startsWith(join(directory, 'archive-'))).toBe(true);
    await staged.discard();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['a relative path', async () => 'relative/staging'],
    [
      'a regular file',
      async () => {
        const path = join(builds.directory, 'file');
        await writeFile(path, 'x');
        return path;
      },
    ],
    [
      'a symbolic link',
      async () => {
        const real = join(builds.directory, 'real');
        await mkdir(real, { mode: 0o700 });
        const link = join(builds.directory, 'link');
        await symlink(real, link);
        return link;
      },
    ],
    [
      'a group-writable directory',
      async () => {
        const path = join(builds.directory, 'shared');
        await mkdir(path);
        await chmod(path, 0o770);
        return path;
      },
    ],
  ])('refuses %s before sweeping anything', async (_label, root) => {
    const directory = await root();
    const part = `archive-${'f'.repeat(32)}.zip.part`;
    if (directory.startsWith('/') && !directory.endsWith('/file')) {
      await writeFile(join(directory, part), 'partial').catch(() => undefined);
      const hourAgo = (Date.now() - 61 * 60_000) / 1000;
      await utimes(join(directory, part), hourAgo, hourAgo).catch(() => undefined);
    }
    await expect(openGitArchiveStaging(directory)).rejects.toMatchObject({
      name: 'ArchiveStagingDirectoryError',
    });
    if (directory.startsWith('/') && !directory.endsWith('/file')) {
      expect(await readdir(directory)).toContain(part);
    }
  });
});

describe('nodeGitProviderFor', () => {
  it('logs one startup error without the path and registers nothing when staging fails', async () => {
    const path = join(builds.directory, 'not-a-directory');
    await writeFile(path, 'x');
    const log = vi.fn();
    expect(await nodeGitProviderFor(path, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      level: 'error',
      event: 'startup.git_archive_staging_failed',
      error_name: 'ArchiveStagingDirectoryError',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(builds.directory);
  });

  it('returns the git provider for a usable staging root', async () => {
    const log = vi.fn();
    const provider = await nodeGitProviderFor(join(builds.directory, 'git-archives'), log);
    expect(provider?.id).toBe('git');
    expect(provider?.sourceTypes).toEqual(['vcs']);
    expect(log).not.toHaveBeenCalled();
  });
});
