import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  GitProviderError,
  createGitProvider,
  type GitProvider,
} from '@package-broker/core/ingest/vcs/git-provider';
import type { ArchiveStaging, BuiltArchive } from '@package-broker/core/sources/git/archive';
import {
  ProviderBusyError,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '@package-broker/core/sources/provider';
import { ArchiveStagingDirectoryError, createNodeArchiveStaging } from '../blob/archive-staging.js';

export interface NodeGitProviderOptions {
  readonly staging: ArchiveStaging;
  /** How long a built archive stays staged for the second read of a two-pass store. */
  readonly reuseMs?: number;
  readonly maxStaged?: number;
  /** Archive builds running at once across all organizations; more answer busy. */
  readonly maxConcurrentBuilds?: number;
}

const COMMIT = /^[a-f0-9]{40}$/;
const STAGED_PART = /^archive-[0-9a-f]{32}\.zip\.part$/;
const STALE_PART_MS = 60 * 60_000;
const REUSE_MS = 60_000;
const MAX_STAGED = 32;
const MAX_CONCURRENT_BUILDS = 2;

interface Staged {
  readonly key: string;
  readonly built: Promise<BuiltArchive>;
  readonly controller: AbortController;
  archive?: BuiltArchive;
  waiting: number;
  holders: number;
  settled: boolean;
  dead: boolean;
  timer?: NodeJS.Timeout;
}

function repositoryOf(source: ProviderSource): string {
  if (source.type !== 'vcs' || source.config.provider !== 'git') {
    throw new GitProviderError('invalid_request');
  }
  return source.config.repository;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function requireOwnedDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new ArchiveStagingDirectoryError();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new ArchiveStagingDirectoryError();
  }
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    throw new ArchiveStagingDirectoryError();
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.uid !== process.getuid!() ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new ArchiveStagingDirectoryError();
  }
}

/**
 * Opens the git archive staging directory. Partial archives older than an hour are removed; a
 * newer one may belong to another process sharing the volume.
 */
export async function openGitArchiveStaging(
  directory: string,
  now: () => number = Date.now,
): Promise<ArchiveStaging> {
  await requireOwnedDirectory(directory);
  for (const name of await readdir(directory)) {
    if (!STAGED_PART.test(name)) continue;
    const path = join(directory, name);
    const stats = await lstat(path).catch(() => null);
    if (stats?.isFile() === true && now() - stats.mtimeMs > STALE_PART_MS) {
      await unlink(path).catch(() => undefined);
    }
  }
  return createNodeArchiveStaging({ directory });
}

/**
 * The generic Git provider with dists built on demand: `openDist` builds the zip of the requested
 * commit once and serves it to every reader, including both passes of the blob store.
 */
export function createNodeGitProvider(options: NodeGitProviderOptions): SourceProvider {
  const git: GitProvider = createGitProvider({ runtime: 'docker', staging: options.staging });
  const reuseMs = options.reuseMs ?? REUSE_MS;
  const maxStaged = options.maxStaged ?? MAX_STAGED;
  const maxConcurrentBuilds = options.maxConcurrentBuilds ?? MAX_CONCURRENT_BUILDS;
  const staged = new Map<string, Staged>();
  let building = 0;

  function cleanup(entry: Staged): void {
    if (!entry.dead || entry.holders > 0 || !entry.settled) return;
    clearTimeout(entry.timer);
    if (entry.archive !== undefined) void unlink(entry.archive.path).catch(() => undefined);
  }

  function retire(key: string, entry: Staged): void {
    if (staged.get(key) === entry) staged.delete(key);
    entry.dead = true;
    cleanup(entry);
  }

  function evictSettled(): void {
    if (staged.size < maxStaged) return;
    for (const [key, entry] of staged) {
      if (entry.settled) {
        retire(key, entry);
        return;
      }
    }
  }

  function start(key: string, ctx: ProviderContext, source: ProviderSource, commit: string) {
    if (building >= maxConcurrentBuilds) throw new ProviderBusyError();
    evictSettled();
    const controller = new AbortController();
    building += 1;
    const built = git.buildArchive({ ...ctx, signal: controller.signal }, source, commit);
    const entry: Staged = {
      key,
      built,
      controller,
      waiting: 0,
      holders: 0,
      settled: false,
      dead: false,
    };
    staged.set(key, entry);
    built.then(
      (archive) => {
        building -= 1;
        entry.archive = archive;
        entry.settled = true;
        if (entry.dead) {
          cleanup(entry);
          return;
        }
        entry.timer = setTimeout(() => retire(key, entry), reuseMs);
        entry.timer.unref();
      },
      () => {
        building -= 1;
        entry.settled = true;
        retire(key, entry);
      },
    );
    return entry;
  }

  async function read(entry: Staged, signal: AbortSignal) {
    entry.holders += 1;
    entry.waiting += 1;
    let handle: FileHandle | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      cleanup(entry);
    };
    try {
      const archive = await untilAborted(entry.built, signal).finally(() => {
        entry.waiting -= 1;
        if (entry.waiting === 0 && !entry.settled) {
          retire(entry.key, entry);
          entry.controller.abort(signal.reason);
        }
      });
      handle = await open(archive.path, 'r');
      const stream = handle.createReadStream();
      stream.once('close', release);
      return {
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        size: archive.size,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      release();
      throw error;
    }
  }

  return {
    id: git.id,
    sourceTypes: git.sourceTypes,
    ecosystems: git.ecosystems,
    listPackages: git.listPackages!.bind(git),
    describe: git.describe.bind(git),
    async openDist(ctx, source, target) {
      if (source.ecosystem === 'npm') return git.openDist(ctx, source, target);
      const repository = repositoryOf(source);
      const commit = target.sourceRef;
      if (commit === null || !COMMIT.test(commit)) throw new GitProviderError('invalid_request');
      const key = JSON.stringify([ctx.org.orgId, source.id, repository, commit]);
      const entry = staged.get(key) ?? start(key, ctx, source, commit);
      return read(entry, ctx.signal);
    },
  };
}

/**
 * The generic Git provider for a staging root, or null when the root cannot be used; the failure is
 * logged once and the provider stays unregistered, so the broker neither reports nor accepts it.
 */
export async function nodeGitProviderFor(
  root: string,
  log: (record: { level: 'error'; event: string; error_name: string }) => void,
  options: Omit<NodeGitProviderOptions, 'staging'> = {},
): Promise<SourceProvider | null> {
  let staging: ArchiveStaging;
  try {
    staging = await openGitArchiveStaging(root);
  } catch (error) {
    log({
      level: 'error',
      event: 'startup.git_archive_staging_failed',
      error_name: error instanceof Error ? error.name : 'Error',
    });
    return null;
  }
  return createNodeGitProvider({ ...options, staging });
}
