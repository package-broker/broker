import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import {
  BlobBusyError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobValidationError,
  blobStorageKey,
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
} from '@package-broker/core/platform/blob';
import type { BlobMetadataPort, ByteStore, Sha256 } from '@package-broker/core/platform/blob';
import type { FileHandle } from 'node:fs/promises';
import {
  describeBlobContract,
  type BlobContractFixture,
} from '@package-broker/db-sqlite/contract/blob-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';
import {
  FilesystemIntegrityError,
  FilesystemRootError,
  FilesystemUnsafePathError,
  openFilesystemByteStore,
} from './filesystem.js';

const fsHooks = vi.hoisted(() => ({
  link: null as
    | null
    | ((from: string, to: string, real: (a: string, b: string) => Promise<void>) => Promise<void>),
  rename: null as
    | null
    | ((from: string, to: string, real: (a: string, b: string) => Promise<void>) => Promise<void>),
  utimes: null as null | ((path: string, real: (path: string) => Promise<void>) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: (from: string, to: string) =>
      fsHooks.link === null ? actual.link(from, to) : fsHooks.link(from, to, actual.link),
    rename: (from: string, to: string) =>
      fsHooks.rename === null ? actual.rename(from, to) : fsHooks.rename(from, to, actual.rename),
    utimes: (path: string, atime: Date, mtime: Date) =>
      fsHooks.utimes === null
        ? actual.utimes(path, atime, mtime)
        : fsHooks.utimes(path, (target) => actual.utimes(target, atime, mtime)),
  };
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const sha = (data: Uint8Array): Sha256 =>
  parseSha256(createHash('sha256').update(data).digest('hex'));

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempRoot(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pb-blob-fs-')));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
}

function streamOf(data: Uint8Array, chunk = 3): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return new Uint8Array(Buffer.concat(parts));
}

async function listAll(root: string, at = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const relative = at === '' ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listAll(root, relative)));
    else out.push(relative);
  }
  return out.sort();
}

const isStaging = (name: string): boolean => /(^|\/)\.stage-/.test(name);

async function stagedIn(root: string): Promise<number> {
  return (await listAll(root)).filter(isStaging).length;
}

const KEY = (digest: Sha256): string => `sha256/6f7267/${digest.slice(0, 2)}/${digest}`;
const PLAIN = { mediaType: 'application/octet-stream' } as const;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function fsFixture(): Promise<BlobContractFixture> {
  const root = await tempRoot();
  const byteStore = await openFilesystemByteStore({ root });
  const directory = await tempRoot();
  const opened = openBetterSqliteExecutor(join(directory, 'meta.sqlite'));
  cleanups.push(() => opened.close());
  const executor: SqlExecutor = opened.executor;
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  await migrate(
    executor,
    await Promise.all(
      names.map(async (name) =>
        loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
      ),
    ),
    { holder: 'filesystem-blob-test' },
  );
  const repository = createBlobRepository(executor);
  const state = { failPublish: false, failRead: false, fullBody: false };

  const guarded: ByteStore = {
    putVerified: (key, body, input) => byteStore.putVerified(key, body, input),
    async get(key, range) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      const whole = state.fullBody && range !== undefined;
      state.fullBody = false;
      const found = await byteStore.get(key, whole ? undefined : range);
      return found;
    },
    async head(key) {
      if (state.failRead) {
        state.failRead = false;
        throw new Error('storage down');
      }
      return byteStore.head(key);
    },
    remove: (key) => byteStore.remove(key),
  };

  const metadata: BlobMetadataPort = {
    reserve: (ctx, key) => repository.reserve(ctx, key),
    async publish(ctx, input) {
      if (state.failPublish) {
        state.failPublish = false;
        throw new Error('database down');
      }
      return repository.publish(ctx, input);
    },
    find: (ctx, key) => repository.find(ctx, key),
    narrowRefetchable: (ctx, input) => repository.narrowRefetchable(ctx, input),
    inspect: (ctx, key) => repository.inspect(ctx, key),
  };

  const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
  const exec = async (sql: string, ...params: (string | number)[]): Promise<void> => {
    await executor.batch([{ sql, params }]);
  };
  const seeded = new Set<string>();
  const pathOf = (ctx: OrgContext, key: Sha256): string =>
    join(root, ...blobStorageKey(ctx.orgId, key).split('/'));

  return {
    store: createBlobStore(guarded, metadata, {
      admission: createBlobUploadAdmission(),
      idleTimeoutMs: 2_000,
    }),
    stagesUploads: true,
    async seed(org) {
      if (!seeded.has(org)) {
        await exec('DROP INDEX IF EXISTS organization_singleton');
        await exec(
          'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
          org,
          `org-${org.toLowerCase()}`,
          `Organization ${org}`,
        );
        seeded.add(org);
      }
      return orgContext(org);
    },
    async now() {
      const rows = await executor.all<{ now: string }>({
        sql: `SELECT strftime('${FORMAT}', 'now') AS now`,
        params: [],
      });
      return rows[0]!.now;
    },
    softDelete: (ctx, key, input) => repository.softDelete(ctx, key, input),
    async expireRetention(ctx, key) {
      await exec(
        `UPDATE blob SET purge_after = strftime('${FORMAT}', 'now', '-1 minute') WHERE org_id = ? AND sha256 = ?`,
        ctx.orgId,
        key,
      );
    },
    async refetchableOf(ctx, key) {
      const rows = await executor.all<{ refetchable: number }>({
        sql: 'SELECT refetchable FROM blob WHERE org_id = ? AND sha256 = ?',
        params: [ctx.orgId, key],
      });
      return rows[0] === undefined ? null : rows[0].refetchable === 1;
    },
    failNextPublish() {
      state.failPublish = true;
    },
    failNextStorageRead() {
      state.failRead = true;
    },
    async corruptBytes(ctx, key) {
      const file = pathOf(ctx, key);
      await truncate(file, (await stat(file)).size - 1);
    },
    async removeBytes(ctx, key) {
      await byteStore.remove(blobStorageKey(ctx.orgId, key));
    },
    stagedObjects: () => stagedIn(root),
    answerNextRangeWithFullBody() {
      state.fullBody = true;
    },
  };
}

describeBlobContract('filesystem bytes with sqlite metadata', fsFixture);

describe('openFilesystemByteStore startup', () => {
  it('rejects a relative root', async () => {
    await expect(openFilesystemByteStore({ root: './data/blobs' })).rejects.toBeInstanceOf(
      FilesystemRootError,
    );
  });

  it('rejects a root that is a file', async () => {
    const base = await tempRoot();
    const file = join(base, 'file');
    await writeFile(file, 'x');
    await expect(openFilesystemByteStore({ root: file })).rejects.toBeInstanceOf(
      FilesystemRootError,
    );
  });

  it('rejects a symlinked root', async () => {
    const base = await tempRoot();
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'link'));
    await expect(openFilesystemByteStore({ root: join(base, 'link') })).rejects.toBeInstanceOf(
      FilesystemRootError,
    );
  });

  it('rejects a root under a symlinked parent', async () => {
    const base = await tempRoot();
    await mkdir(join(base, 'real', 'blobs'), { recursive: true });
    await symlink(join(base, 'real'), join(base, 'link'));
    await expect(
      openFilesystemByteStore({ root: join(base, 'link', 'blobs') }),
    ).rejects.toBeInstanceOf(FilesystemRootError);
  });

  it('rejects a root writable by group or others', async () => {
    const base = await tempRoot();
    const root = join(base, 'open');
    await mkdir(root);
    await chmod(root, 0o777);
    await expect(openFilesystemByteStore({ root })).rejects.toBeInstanceOf(FilesystemRootError);
  });

  it('creates a missing root', async () => {
    const base = await tempRoot();
    const root = join(base, 'fresh', 'blobs');
    await openFilesystemByteStore({ root });
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it('keeps staging under a per-instance directory', async () => {
    const root = await tempRoot();
    await openFilesystemByteStore({ root });
    const instances = await readdir(join(root, '.staging'));
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sweeps abandoned staging directories and keeps published objects', async () => {
    const root = await tempRoot();
    const store = await openFilesystemByteStore({ root });
    const data = bytes('survivor');
    const digest = sha(data);
    await store.putVerified(KEY(digest), streamOf(data), {
      sha256: digest,
      size: data.length,
      ...PLAIN,
    });
    const abandoned = join(root, '.staging', 'c'.repeat(32));
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, '.stage-' + 'a'.repeat(32)), 'partial');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(abandoned, old, old);
    expect(await stagedIn(root)).toBe(1);
    const reopened = await openFilesystemByteStore({ root });
    expect(await stagedIn(root)).toBe(0);
    expect(await readdir(join(root, '.staging'))).not.toContain('c'.repeat(32));
    expect(await reopened.head(KEY(digest))).toEqual({ size: data.length, ...PLAIN });
  });

  it('does not sweep the in-flight staging of a live store on the same root', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const data = bytes('slow upload in flight');
    const digest = sha(data);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(data.slice(0, 5));
          return;
        }
        await gate;
        controller.enqueue(data.slice(5));
        controller.close();
      },
    });
    const pending = first.putVerified(KEY(digest), body, {
      sha256: digest,
      size: data.length,
      ...PLAIN,
    });
    for (let i = 0; i < 100 && (await stagedIn(root)) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await stagedIn(root)).toBe(1);
    await openFilesystemByteStore({ root });
    expect(await stagedIn(root)).toBe(1);
    release();
    expect(await pending).toEqual({ size: data.length, ...PLAIN });
    expect(await first.head(KEY(digest))).toEqual({ size: data.length, ...PLAIN });
    expect(await stagedIn(root)).toBe(0);
  });

  it('recreates its staging directory when a sibling swept it as idle', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const [own] = await readdir(join(root, '.staging'));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(join(root, '.staging', own!), old, old);
    await openFilesystemByteStore({ root });
    expect(await readdir(join(root, '.staging'))).not.toContain(own);
    const data = bytes('after an idle day');
    const digest = sha(data);
    await first.putVerified(KEY(digest), streamOf(data), {
      sha256: digest,
      size: data.length,
      ...PLAIN,
    });
    expect(await first.head(KEY(digest))).toEqual({ size: data.length, ...PLAIN });
  });

  it('refuses a symlinked staging directory', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, '.staging'));
    await expect(openFilesystemByteStore({ root })).rejects.toBeInstanceOf(
      FilesystemUnsafePathError,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a missing root under a symlinked parent without creating anything outside', async () => {
    const base = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(base, 'link'));
    await expect(
      openFilesystemByteStore({ root: join(base, 'link', 'blobs', 'deeper') }),
    ).rejects.toBeInstanceOf(FilesystemRootError);
    expect(await readdir(outside)).toEqual([]);
  });

  it('fails startup when staging cannot be hard-linked into the root', async () => {
    const root = await tempRoot();
    fsHooks.link = async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };
    try {
      await expect(openFilesystemByteStore({ root })).rejects.toBeInstanceOf(FilesystemRootError);
    } finally {
      fsHooks.link = null;
    }
  });

  it('leaves no probe or staging file after startup', async () => {
    const root = await tempRoot();
    await openFilesystemByteStore({ root });
    expect(await readdir(root)).toEqual(['.staging']);
    expect(await listAll(root)).toEqual([]);
  });

  it('keeps an old-mtime staging directory that its live owner refreshes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const root = await tempRoot();
      const first = await openFilesystemByteStore({ root });
      const [own] = await readdir(join(root, '.staging'));
      const ownPath = join(root, '.staging', own!);
      const data = bytes('a very long upload');
      const digest = sha(data);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(data.slice(0, 4));
            return;
          }
          await gate;
          controller.enqueue(data.slice(4));
          controller.close();
        },
      });
      const pending = first.putVerified(KEY(digest), body, {
        sha256: digest,
        size: data.length,
        ...PLAIN,
      });
      for (let i = 0; i < 100 && (await stagedIn(root)) === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(ownPath, old, old);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      const cutoff = Date.now() - 60 * 1000;
      for (let i = 0; i < 100 && (await stat(ownPath)).mtimeMs < cutoff; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await openFilesystemByteStore({ root });
      expect(await readdir(join(root, '.staging'))).toContain(own);
      expect(await stagedIn(root)).toBe(1);
      release();
      expect(await pending).toEqual({ size: data.length, ...PLAIN });
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes stale sweep leftovers and lets a swept sibling keep publishing', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const [own] = await readdir(join(root, '.staging'));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(join(root, '.staging', own!), old, old);
    const leftover = join(root, '.staging', `${'d'.repeat(32)}.sweep-${'e'.repeat(32)}`);
    await mkdir(leftover);
    await utimes(leftover, old, old);
    const second = await openFilesystemByteStore({ root });
    const names = await readdir(join(root, '.staging'));
    expect(names).not.toContain(own);
    expect(names.every((name) => /^[0-9a-f]{32}$/.test(name))).toBe(true);
    const one = bytes('first after sweep');
    const two = bytes('second after sweep');
    await Promise.all([
      first.putVerified(KEY(sha(one)), streamOf(one), {
        sha256: sha(one),
        size: one.length,
        ...PLAIN,
      }),
      second.putVerified(KEY(sha(two)), streamOf(two), {
        sha256: sha(two),
        size: two.length,
        ...PLAIN,
      }),
    ]);
    expect(await first.head(KEY(sha(two)))).toEqual({ size: two.length, ...PLAIN });
    expect(await second.head(KEY(sha(one)))).toEqual({ size: one.length, ...PLAIN });
  });
});

describe('filesystem byte store', () => {
  async function opened(): Promise<{ root: string; store: ByteStore }> {
    const root = await tempRoot();
    return { root, store: await openFilesystemByteStore({ root }) };
  }
  const put = (store: ByteStore, data: Uint8Array, mediaType: string = PLAIN.mediaType) => {
    const digest = sha(data);
    return {
      digest,
      result: store.putVerified(KEY(digest), streamOf(data), {
        sha256: digest,
        size: data.length,
        mediaType,
      }),
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fsHooks.link = null;
    fsHooks.rename = null;
    fsHooks.utimes = null;
  });

  it('round-trips write, read, ranged read and head with exact size', async () => {
    const { store } = await opened();
    const data = bytes('hello filesystem blob');
    const { digest, result } = put(store, data, 'text/plain');
    expect(await result).toEqual({ size: data.length, mediaType: 'text/plain' });
    expect(await store.head(KEY(digest))).toEqual({ size: data.length, mediaType: 'text/plain' });
    const full = await store.get(KEY(digest));
    expect(full?.range).toBeNull();
    expect(full?.size).toBe(data.length);
    expect(Buffer.from(await drain(full!.body)).toString()).toBe('hello filesystem blob');
    const part = await store.get(KEY(digest), { offset: 6, length: 10 });
    expect(part?.range).toEqual({ offset: 6, length: 10 });
    expect(part?.size).toBe(data.length);
    expect(Buffer.from(await drain(part!.body)).toString()).toBe('filesystem');
    const clamped = await store.get(KEY(digest), { offset: 17, length: 100 });
    expect(clamped?.range).toEqual({ offset: 17, length: 4 });
    expect(Buffer.from(await drain(clamped!.body)).toString()).toBe('blob');
  });

  it('round-trips an empty object and refuses a range on it', async () => {
    const { store } = await opened();
    const { digest, result } = put(store, new Uint8Array());
    await result;
    expect(await store.head(KEY(digest))).toEqual({ size: 0, ...PLAIN });
    const read = await store.get(KEY(digest));
    expect((await drain(read!.body)).length).toBe(0);
    await expect(store.get(KEY(digest), { offset: 0, length: 1 })).rejects.toBeInstanceOf(
      BlobRangeError,
    );
  });

  it('answers null for an object never stored', async () => {
    const { store } = await opened();
    const digest = sha(bytes('nothing'));
    expect(await store.get(KEY(digest))).toBeNull();
    expect(await store.head(KEY(digest))).toBeNull();
    await expect(store.remove(KEY(digest))).resolves.toBeUndefined();
  });

  it('rejects a digest mismatch and leaves no object and no staging', async () => {
    const { root, store } = await opened();
    const claimed = sha(bytes('claimed'));
    const wrong = bytes('claimeX');
    const error = await rejection(
      store.putVerified(KEY(claimed), streamOf(wrong), {
        sha256: claimed,
        size: wrong.length,
        ...PLAIN,
      }),
    );
    expect(error).toBeInstanceOf(BlobValidationError);
    expect(await store.head(KEY(claimed))).toBeNull();
    expect(await listAll(root)).toEqual([]);
    expect(await readdir(root)).toEqual(['.staging']);
    expect(await stagedIn(root)).toBe(0);
  });

  it.each([-3, 5])('rejects a size off by %i and leaves nothing behind', async (delta) => {
    const { root, store } = await opened();
    const data = bytes('twelve bytes');
    const digest = sha(data);
    const error = await rejection(
      store.putVerified(KEY(digest), streamOf(data), {
        sha256: digest,
        size: data.length + delta,
        ...PLAIN,
      }),
    );
    expect(error).toBeInstanceOf(BlobSizeMismatchError);
    expect(await store.head(KEY(digest))).toBeNull();
    expect(await listAll(root)).toEqual([]);
    expect(await readdir(root)).toEqual(['.staging']);
  });

  it('propagates a mid-stream failure and cleans staging', async () => {
    const { root, store } = await opened();
    const data = bytes('partial upload');
    const digest = sha(data);
    const aborted = new Error('client aborted');
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(data.slice(0, 4));
          return;
        }
        controller.error(aborted);
      },
    });
    const error = await rejection(
      store.putVerified(KEY(digest), body, { sha256: digest, size: data.length, ...PLAIN }),
    );
    expect(error).toBe(aborted);
    expect(await stagedIn(root)).toBe(0);
    expect(await store.head(KEY(digest))).toBeNull();
  });

  it('fsyncs the staging file, then the destination and new parents after the link', async () => {
    const { root, store } = await opened();
    const data = bytes('durable bytes');
    const digest = sha(data);
    const finalPath = join(root, KEY(digest));
    const handle = await open(join(await tempRoot(), 'probe'), 'w+');
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> };
    await handle.close();
    const original = prototype.sync;
    const synced: Array<{ ino: number; directory: boolean; published: boolean }> = [];
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const stats = await this.stat();
      let published = true;
      await lstat(finalPath).catch(() => {
        published = false;
      });
      synced.push({ ino: stats.ino, directory: stats.isDirectory(), published });
      return original.call(this);
    });
    await put(store, data).result;
    const inode = async (path: string): Promise<number> => (await stat(path)).ino;
    const dataInode = await inode(finalPath);
    const sidecarInode = await inode(finalPath + '.media');
    expect(dataInode).not.toBe(sidecarInode);
    expect(
      synced.some((entry) => !entry.directory && entry.ino === dataInode && !entry.published),
    ).toBe(true);
    expect(synced.some((entry) => !entry.directory && entry.ino === sidecarInode)).toBe(true);
    const destination = await inode(dirname(finalPath));
    expect(synced.some((entry) => entry.ino === destination && entry.published)).toBe(true);
    for (const parent of [root, join(root, 'sha256'), join(root, 'sha256', '6f7267')]) {
      const ino = await inode(parent);
      expect(synced.some((entry) => entry.directory && entry.ino === ino)).toBe(true);
    }
    const [instance] = await readdir(join(root, '.staging'));
    const staging = await inode(join(root, '.staging', instance!));
    expect(synced.some((entry) => entry.ino === staging && entry.published)).toBe(true);
  });

  it('converges concurrent writers of one digest on one object without replacing it', async () => {
    const { root, store } = await opened();
    const data = bytes('racing writers share one digest');
    const digest = sha(data);
    const results = await Promise.all(Array.from({ length: 8 }, () => put(store, data).result));
    for (const result of results) expect(result).toEqual({ size: data.length, ...PLAIN });
    const files = await listAll(root);
    expect(files.filter((name) => !isStaging(name)).sort()).toEqual([
      `${KEY(digest)}`,
      `${KEY(digest)}.media`,
    ]);
    expect(await stagedIn(root)).toBe(0);
    const before = (await stat(join(root, KEY(digest)))).ino;
    await put(store, data).result;
    expect((await stat(join(root, KEY(digest)))).ino).toBe(before);
  });

  it('keeps the first media type for a digest', async () => {
    const { store } = await opened();
    const data = bytes('typed once');
    await put(store, data, 'application/zip').result;
    const second = await put(store, data, 'application/gzip').result;
    expect(second.mediaType).toBe('application/zip');
    expect((await store.head(KEY(sha(data))))?.mediaType).toBe('application/zip');
  });

  it('never replaces an existing object with different bytes', async () => {
    const { root, store } = await opened();
    const data = bytes('original bytes');
    const { digest, result } = put(store, data);
    await result;
    const file = join(root, KEY(digest));
    await writeFile(file, 'tampered');
    const before = (await stat(file)).ino;
    const error = await rejection(put(store, data).result);
    expect(error).toBeInstanceOf(FilesystemIntegrityError);
    expect((await stat(file)).ino).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('tampered');
    expect(await stagedIn(root)).toBe(0);
  });

  it('removes bytes and media type, idempotently, and accepts a new media type afterwards', async () => {
    const { root, store } = await opened();
    const data = bytes('short lived');
    const { digest, result } = put(store, data, 'application/zip');
    await result;
    await store.remove(KEY(digest));
    await store.remove(KEY(digest));
    expect(await store.head(KEY(digest))).toBeNull();
    expect((await listAll(root)).filter((name) => !isStaging(name))).toEqual([]);
    expect((await put(store, data, 'text/plain').result).mediaType).toBe('text/plain');
  });

  const badKeys: Array<[string, string]> = [
    ['an absolute path', `/etc/${'a'.repeat(64)}`],
    ['a parent segment', `sha256/../${'a'.repeat(64)}`],
    ['a dot segment', `sha256/./${'a'.repeat(64)}`],
    ['an empty segment', `sha256//${'a'.repeat(64)}`],
    ['a trailing separator', 'sha256/ab/'],
    ['an empty key', ''],
    ['a backslash', `sha256\\${'a'.repeat(64)}`],
    ['a NUL byte', `sha256/\0${'a'.repeat(64)}`],
    ['a dotted component', `sha256/${'a'.repeat(64)}.media`],
    ['a staging-shaped component', `sha256/.stage-${'a'.repeat(32)}`],
    ['a drive letter', `C:/${'a'.repeat(64)}`],
  ];

  it.each(badKeys)('refuses %s in a key on every operation', async (_name, key) => {
    const { root, store } = await opened();
    const data = bytes('x');
    const input = { sha256: sha(data), size: data.length, ...PLAIN };
    expect(await rejection(store.putVerified(key, streamOf(data), input))).toBeInstanceOf(
      BlobValidationError,
    );
    expect(await rejection(store.get(key))).toBeInstanceOf(BlobValidationError);
    expect(await rejection(store.head(key))).toBeInstanceOf(BlobValidationError);
    expect(await rejection(store.remove(key))).toBeInstanceOf(BlobValidationError);
    expect(await listAll(root)).toEqual([]);
  });

  it('refuses a symlinked directory under the root and writes nothing outside it', async () => {
    const { root, store } = await opened();
    const outside = await tempRoot();
    await symlink(outside, join(root, 'sha256'));
    const data = bytes('escape attempt');
    const digest = sha(data);
    await expect(put(store, data).result).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(store.get(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(store.head(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked final object', async () => {
    const { root, store } = await opened();
    const data = bytes('real bytes');
    const { digest, result } = put(store, data);
    await result;
    const file = join(root, KEY(digest));
    const outside = join(await tempRoot(), 'secret');
    await writeFile(outside, 'real bytes');
    await rm(file);
    await symlink(outside, file);
    await expect(store.get(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(store.head(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(put(store, data).result).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    expect(await readFile(outside, 'utf8')).toBe('real bytes');
  });

  it('refuses an existing object of the same length with different bytes', async () => {
    const { root, store } = await opened();
    const data = bytes('sixteen bytes ok');
    const { digest, result } = put(store, data);
    await result;
    const file = join(root, KEY(digest));
    await writeFile(file, 'sixteen bytes NO');
    const before = (await stat(file)).ino;
    expect(await rejection(put(store, data).result)).toBeInstanceOf(FilesystemIntegrityError);
    expect((await stat(file)).ino).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('sixteen bytes NO');
    expect(await stagedIn(root)).toBe(0);
  });

  it('replaces an orphan media type sidecar whose data file is absent', async () => {
    const { root, store } = await opened();
    const data = bytes('orphaned sidecar');
    const digest = sha(data);
    const file = join(root, KEY(digest));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.media', 'application/zip');
    const old = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(file + '.media', old, old);
    expect((await put(store, data, 'text/plain').result).mediaType).toBe('text/plain');
    expect(await store.head(KEY(digest))).toEqual({ size: data.length, mediaType: 'text/plain' });
    expect(await stagedIn(root)).toBe(0);
  });

  it('removes the sidecar before the data file', async () => {
    const { root, store } = await opened();
    const data = bytes('sidecar goes first');
    const { digest, result } = put(store, data);
    await result;
    const file = join(root, KEY(digest));
    await rm(file);
    await mkdir(file);
    await writeFile(join(file, 'pinned'), 'x');
    await expect(store.remove(KEY(digest))).rejects.toThrow();
    await expect(lstat(file + '.media')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked media type sidecar', async () => {
    const { root, store } = await opened();
    const data = bytes('sidecar link');
    const { digest, result } = put(store, data);
    await result;
    const sidecar = join(root, KEY(digest)) + '.media';
    const outside = join(await tempRoot(), 'type');
    await writeFile(outside, 'text/plain');
    await rm(sidecar);
    await symlink(outside, sidecar);
    await expect(store.get(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(store.head(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(put(store, data).result).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    expect(await readFile(outside, 'utf8')).toBe('text/plain');
  });

  it('refuses a FIFO in place of the object or the sidecar without blocking', async () => {
    const { root, store } = await opened();
    const data = bytes('fifo target');
    const { digest, result } = put(store, data);
    await result;
    const file = join(root, KEY(digest));
    await rm(file + '.media');
    execFileSync('mkfifo', [file + '.media']);
    await expect(store.head(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await expect(store.get(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
    await rm(file);
    execFileSync('mkfifo', [file]);
    await expect(store.get(KEY(digest))).rejects.toBeInstanceOf(FilesystemUnsafePathError);
  }, 5_000);

  it('raises a busy error when the sidecar vanishes between EEXIST and its read', async () => {
    const { store } = await opened();
    const data = bytes('vanishing sidecar');
    await put(store, data).result;
    fsHooks.link = async (from, to, real) => {
      try {
        await real(from, to);
      } catch (error) {
        if (to.endsWith('.media')) await rm(to, { force: true });
        throw error;
      }
    };
    expect(await rejection(put(store, data).result)).toBeInstanceOf(BlobBusyError);
  });

  it('cancels the body when the key is invalid', async () => {
    const { store } = await opened();
    const data = bytes('never read');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(data);
      },
      cancel,
    });
    expect(
      await rejection(
        store.putVerified('../escape', body, { sha256: sha(data), size: data.length, ...PLAIN }),
      ),
    ).toBeInstanceOf(BlobValidationError);
    expect(cancel).toHaveBeenCalled();
  });

  it('fails an upload whose staging a sibling swept with a retryable error and no residue', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const [own] = await readdir(join(root, '.staging'));
    const data = bytes('swept while paused');
    const digest = sha(data);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(data.slice(0, 6));
          return;
        }
        await gate;
        controller.enqueue(data.slice(6));
        controller.close();
      },
    });
    const pending = first.putVerified(KEY(digest), body, {
      sha256: digest,
      size: data.length,
      ...PLAIN,
    });
    for (let i = 0; i < 100 && (await stagedIn(root)) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await stagedIn(root)).toBe(1);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(join(root, '.staging', own!), old, old);
    await openFilesystemByteStore({ root });
    expect(await stagedIn(root)).toBe(0);
    resume();
    expect(await rejection(pending)).toBeInstanceOf(BlobBusyError);
    expect(await listAll(join(root, '.staging'))).toEqual([]);
    expect(await listAll(root)).toEqual([]);
    expect(await put(first, data).result).toEqual({ size: data.length, ...PLAIN });
  });

  it('refuses a young sidecar without data from another store and keeps the first result', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const second = await openFilesystemByteStore({ root });
    const data = bytes('two stores, one digest');
    const digest = sha(data);
    const finalPath = join(root, KEY(digest));
    let reached!: () => void;
    const atDataLink = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    fsHooks.link = async (from, to, real) => {
      if (to === finalPath && !paused) {
        paused = true;
        reached();
        await gate;
      }
      return real(from, to);
    };
    const pending = put(first, data, 'application/zip').result;
    await atDataLink;
    expect(await rejection(put(second, data, 'text/plain').result)).toBeInstanceOf(BlobBusyError);
    resume();
    const result = await pending;
    expect(result).toEqual({ size: data.length, mediaType: 'application/zip' });
    expect(await second.head(KEY(digest))).toEqual(result);
    expect(await stagedIn(root)).toBe(0);
  });

  it('turns a sweep that resumes after the owner staged into a retryable error', async () => {
    const root = await tempRoot();
    const owner = await openFilesystemByteStore({ root });
    const [own] = await readdir(join(root, '.staging'));
    const ownPath = join(root, '.staging', own!);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(ownPath, old, old);
    let observed!: () => void;
    const sweepObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let resumeSweep!: () => void;
    const sweepGate = new Promise<void>((resolve) => {
      resumeSweep = resolve;
    });
    fsHooks.rename = async (from, to, real) => {
      if (to.includes('.sweep-')) {
        observed();
        await sweepGate;
      }
      return real(from, to);
    };
    const sweeping = openFilesystemByteStore({ root });
    await sweepObserved;
    let interleaved = false;
    fsHooks.utimes = async (path, real) => {
      if (path === ownPath && !interleaved) {
        interleaved = true;
        resumeSweep();
        await sweeping;
      }
      return real(path);
    };
    const data = bytes('owner staged before the sweep resumed');
    expect(await rejection(put(owner, data).result)).toBeInstanceOf(BlobBusyError);
    expect(interleaved).toBe(true);
    expect(await listAll(join(root, '.staging'))).toEqual([]);
    expect(await listAll(root)).toEqual([]);
    fsHooks.rename = null;
    fsHooks.utimes = null;
    expect(await put(owner, data).result).toEqual({ size: data.length, ...PLAIN });
  });

  it('turns a sidecar staging swept before its link into a retryable error', async () => {
    const root = await tempRoot();
    const owner = await openFilesystemByteStore({ root });
    const [own] = await readdir(join(root, '.staging'));
    const ownPath = join(root, '.staging', own!);
    let swept = false;
    fsHooks.link = async (from, to, real) => {
      if (to.endsWith('.media') && !swept) {
        swept = true;
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await utimes(ownPath, old, old);
        await openFilesystemByteStore({ root });
      }
      return real(from, to);
    };
    const data = bytes('sidecar staging swept');
    expect(await rejection(put(owner, data).result)).toBeInstanceOf(BlobBusyError);
    expect(swept).toBe(true);
    expect(await listAll(join(root, '.staging'))).toEqual([]);
    expect(await listAll(root)).toEqual([]);
  });

  it('lets exactly one store reclaim an old orphan sidecar', async () => {
    const root = await tempRoot();
    const first = await openFilesystemByteStore({ root });
    const second = await openFilesystemByteStore({ root });
    const data = bytes('contested orphan');
    const digest = sha(data);
    const file = join(root, KEY(digest));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.media', 'application/octet-stream');
    const old = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(file + '.media', old, old);
    let arrived = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    fsHooks.link = async (from, to, real) => {
      if (to === file + '.media' && arrived < 2) {
        arrived += 1;
        if (arrived === 2) open();
        await barrier;
      }
      return real(from, to);
    };
    const outcomes = await Promise.allSettled([
      put(first, data, 'application/zip').result,
      put(second, data, 'text/plain').result,
    ]);
    const head = await first.head(KEY(digest));
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(['application/zip', 'text/plain']).toContain(head?.mediaType);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') expect(outcome.value).toEqual(head);
      else expect(outcome.reason).toBeInstanceOf(BlobBusyError);
    }
    expect(await second.head(KEY(digest))).toEqual(head);
    expect(await stagedIn(root)).toBe(0);
  });
});
