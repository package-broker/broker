import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { OrgContext } from '@package-broker/core/db/port';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import type { SshArchiveRecord, SshArchiveStore, SshBuiltArchive } from './ssh-provider.js';

export type SshArchiveStoreFailure =
  'invalid_options' | 'invalid_archive' | 'invalid_metadata' | 'too_large' | 'unsafe_root' | 'io';

export class SshArchiveStoreError extends Error {
  override name = 'SshArchiveStoreError';
  readonly reason: SshArchiveStoreFailure;
  readonly code?: string;
  constructor(reason: SshArchiveStoreFailure, code?: string) {
    super(`ssh archive store: ${reason}`);
    this.reason = reason;
    if (code !== undefined) this.code = code;
  }
}

export interface FilesystemArchiveStoreOptions {
  readonly maxZipBytes: number;
}

export interface FilesystemArchiveStore extends SshArchiveStore {
  readZip(
    ctx: OrgContext,
    source: ProviderSource,
    name: string,
    versionNormalized: string,
    commit: string,
  ): Promise<Uint8Array | null>;
}

const STAGING_DIRECTORY = '.staging';
const STAGING_PREFIX = '.stage-';
const STALE_STAGING_MS = 60 * 60 * 1000;
const SHA1 = /^[0-9a-f]{40}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ERRNO = /^E[A-Z0-9]{1,15}$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const STAGE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const STICKY = 0o1000;
const HEADER_BYTES = 4;
const MAX_META_BYTES = 1024;

function code(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function wrap(error: unknown): SshArchiveStoreError {
  if (error instanceof SshArchiveStoreError) return error;
  const errno = code(error);
  return new SshArchiveStoreError(
    'io',
    errno !== undefined && ERRNO.test(errno) ? errno : undefined,
  );
}

export function archiveFileName(
  orgId: string,
  sourceId: string,
  name: string,
  versionNormalized: string,
  commit: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([orgId, sourceId, name, versionNormalized, commit]))
    .digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, DIRECTORY_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SshArchiveStoreError('unsafe_root');
}

async function requireTrustedAncestors(root: string): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (let path = dirname(root); ; path = dirname(path)) {
    const stats = await lstat(path);
    const untrustedOwner = uid !== undefined && stats.uid !== uid && stats.uid !== 0;
    const sharedWritable = (stats.mode & 0o022) !== 0 && (stats.mode & STICKY) === 0;
    if (untrustedOwner || sharedWritable) throw new SshArchiveStoreError('unsafe_root');
    if (dirname(path) === path) return;
  }
}

async function sweepStaging(staging: string): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const entry of await readdir(staging)) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const path = join(staging, entry);
    const stats = await lstat(path).catch(() => null);
    if (stats !== null && !stats.isDirectory() && stats.mtimeMs < cutoff) {
      await unlink(path).catch(() => undefined);
    }
  }
}

async function prepareRoot(root: string): Promise<void> {
  if (process.platform !== 'win32' && (!constants.O_NOFOLLOW || !constants.O_DIRECTORY)) {
    throw new SshArchiveStoreError('unsafe_root');
  }
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw new SshArchiveStoreError('unsafe_root');
  }
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  await requireDirectory(root, false);
  if ((await realpath(root)) !== root) throw new SshArchiveStoreError('unsafe_root');
  const stats = await lstat(root);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new SshArchiveStoreError('unsafe_root');
  }
  if ((stats.mode & 0o022) !== 0) throw new SshArchiveStoreError('unsafe_root');
  await requireTrustedAncestors(root);
  const staging = join(root, STAGING_DIRECTORY);
  await requireDirectory(staging, true);
  await sweepStaging(staging);
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let at = 0;
  while (at < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, at, chunk.length - at, null);
    at += bytesWritten;
  }
}

async function readExactly(handle: FileHandle, length: number, position: number) {
  const buffer = new Uint8Array(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await handle.read(buffer, at, length - at, position + at);
    if (bytesRead === 0) throw new SshArchiveStoreError('io');
    at += bytesRead;
  }
  return buffer;
}

async function openRegular(path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new SshArchiveStoreError('io');
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

interface Stored {
  readonly record: SshArchiveRecord;
  readonly zipOffset: number;
  readonly size: number;
}

async function readStored(handle: FileHandle): Promise<Stored> {
  const size = (await handle.stat()).size;
  const header = await readExactly(handle, HEADER_BYTES, 0);
  const metaLength = new DataView(header.buffer).getUint32(0);
  if (metaLength > MAX_META_BYTES || HEADER_BYTES + metaLength > size) {
    throw new SshArchiveStoreError('io');
  }
  const meta: unknown = JSON.parse(
    new TextDecoder().decode(await readExactly(handle, metaLength, HEADER_BYTES)),
  );
  if (meta === null || typeof meta !== 'object') throw new SshArchiveStoreError('io');
  const { sha1, time } = meta as Record<string, unknown>;
  if (typeof sha1 !== 'string' || !SHA1.test(sha1) || (time !== null && typeof time !== 'string')) {
    throw new SshArchiveStoreError('io');
  }
  return { record: { sha1, time }, zipOffset: HEADER_BYTES + metaLength, size };
}

function encode(built: SshBuiltArchive): Uint8Array[] {
  if (
    !(built.zip instanceof Uint8Array) ||
    typeof built.sha1 !== 'string' ||
    !SHA1.test(built.sha1)
  ) {
    throw new SshArchiveStoreError('invalid_archive');
  }
  if (built.time !== null && (typeof built.time !== 'string' || !TIME.test(built.time))) {
    throw new SshArchiveStoreError('invalid_metadata');
  }
  const meta = new TextEncoder().encode(JSON.stringify({ sha1: built.sha1, time: built.time }));
  if (meta.length > MAX_META_BYTES) throw new SshArchiveStoreError('invalid_metadata');
  const header = new Uint8Array(HEADER_BYTES);
  new DataView(header.buffer).setUint32(0, meta.length);
  return [header, meta, built.zip];
}

export async function createFilesystemArchiveStore(
  root: string,
  options: FilesystemArchiveStoreOptions,
): Promise<FilesystemArchiveStore> {
  const maxZipBytes = options?.maxZipBytes;
  if (typeof maxZipBytes !== 'number' || !Number.isSafeInteger(maxZipBytes) || maxZipBytes < 1) {
    throw new SshArchiveStoreError('invalid_options');
  }
  try {
    await prepareRoot(root);
  } catch (error) {
    throw wrap(error);
  }
  const staging = join(root, STAGING_DIRECTORY);

  const finalPath = (
    ctx: OrgContext,
    src: ProviderSource,
    name: string,
    version: string,
    commit: string,
  ) => join(root, archiveFileName(ctx.orgId, src.id, name, version, commit));

  return Object.freeze({
    async find(ctx, src, name, version, commit) {
      try {
        const handle = await openRegular(finalPath(ctx, src, name, version, commit));
        if (handle === null) return null;
        try {
          return { ...(await readStored(handle)).record };
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw wrap(error);
      }
    },

    async readZip(ctx, src, name, version, commit) {
      try {
        const handle = await openRegular(finalPath(ctx, src, name, version, commit));
        if (handle === null) return null;
        try {
          const stored = await readStored(handle);
          const length = stored.size - stored.zipOffset;
          if (length > maxZipBytes) throw new SshArchiveStoreError('too_large');
          return await readExactly(handle, length, stored.zipOffset);
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw wrap(error);
      }
    },

    async store(ctx, src, name, built) {
      const parts = encode(built);
      if (built.zip.byteLength > maxZipBytes) throw new SshArchiveStoreError('too_large');
      const target = finalPath(ctx, src, name, built.versionNormalized, built.commit);
      let tempPath: string | null = null;
      try {
        await requireDirectory(staging, true);
        let handle: FileHandle | null = null;
        while (handle === null) {
          const candidate = join(staging, STAGING_PREFIX + randomBytes(16).toString('hex'));
          try {
            handle = await open(candidate, STAGE_FLAGS, FILE_MODE);
            tempPath = candidate;
          } catch (error) {
            if (code(error) !== 'EEXIST') throw error;
          }
        }
        try {
          for (const part of parts) await writeAll(handle, part);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(tempPath as string, target);
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error;
          const existing = await openRegular(target);
          await existing?.close();
          if (existing === null) throw new SshArchiveStoreError('io');
        }
      } catch (error) {
        throw wrap(error);
      } finally {
        if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
      }
      await syncDirectory(root).catch(() => undefined);
    },
  } satisfies FilesystemArchiveStore);
}
