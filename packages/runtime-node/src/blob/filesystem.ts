import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  BlobBusyError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobValidationError,
} from '@package-broker/core/platform/blob';
import type { ByteRange, ByteStore } from '@package-broker/core/platform/blob';

export interface FilesystemByteStoreOptions {
  readonly root: string;
}

export class FilesystemUnsafePathError extends Error {
  override name = 'FilesystemUnsafePathError';
  constructor() {
    super('unsafe path under the blob root');
  }
}

export class FilesystemRootError extends Error {
  override name = 'FilesystemRootError';
  constructor(problem: string) {
    super(`blob root ${problem}`);
  }
}

export class FilesystemIntegrityError extends Error {
  override name = 'FilesystemIntegrityError';
  constructor() {
    super('stored object does not match its digest');
  }
}

const COMPONENT = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_COMPONENTS = 8;
const STAGING_DIRECTORY = '.staging';
const STAGING_PREFIX = '.stage-';
const PROBE_PREFIX = '.probe-';
const CLAIM_PREFIX = '.claim-';
const INSTANCE_NAME = /^[0-9a-f]{32}$/;
const SWEEP_NAME = /^[0-9a-f]{32}\.sweep-[0-9a-f]{32}$/;
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60 * 60 * 1000;
const ORPHAN_SIDECAR_MS = 5 * 60 * 1000;
const MEDIA_SUFFIX = '.media';
const MEDIA_TYPE = /^[\x21-\x7e]{1,255}$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const STAGE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function code(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function vanishedAsBusy(error: unknown): unknown {
  return code(error) === 'ENOENT' ? new BlobBusyError() : error;
}

const randomName = (): string => randomBytes(16).toString('hex');

function parseKey(storageKey: string): { parents: string[]; name: string } {
  if (typeof storageKey !== 'string') throw new BlobValidationError();
  const parts = storageKey.split('/');
  if (parts.length > MAX_COMPONENTS || !parts.every((part) => COMPONENT.test(part))) {
    throw new BlobValidationError();
  }
  const name = parts.pop();
  if (name === undefined) throw new BlobValidationError();
  return { parents: parts, name };
}

function parseMediaType(value: unknown): string {
  if (typeof value !== 'string' || !MEDIA_TYPE.test(value)) throw new BlobValidationError();
  return value;
}

function parsePutInput(input: unknown): { sha256: string; size: number; mediaType: string } {
  if (input === null || typeof input !== 'object') throw new BlobValidationError();
  const { sha256, size, mediaType } = input as Record<string, unknown>;
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new BlobValidationError();
  }
  return { sha256, size, mediaType: parseMediaType(mediaType) };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, DIRECTORY_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireDirectory(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
  if (!stats.isDirectory()) throw new FilesystemUnsafePathError();
  return true;
}

async function makeDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
  }
  if (!(await requireDirectory(path))) throw new FilesystemUnsafePathError();
  await syncDirectory(dirname(path));
}

async function isStale(path: string, cutoff: number): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && stats.mtimeMs < cutoff;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
}

async function sweepStaging(stagingRoot: string): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of await readdir(stagingRoot)) {
    const path = join(stagingRoot, name);
    if (SWEEP_NAME.test(name)) {
      if (await isStale(path, cutoff)) await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!INSTANCE_NAME.test(name) || !(await isStale(path, cutoff))) continue;
    const moved = join(stagingRoot, `${name}.sweep-${randomName()}`);
    try {
      await rename(path, moved);
    } catch (error) {
      if (code(error) === 'ENOENT') continue;
      throw error;
    }
    await rm(moved, { recursive: true, force: true });
  }
}

async function createInstanceDirectory(stagingRoot: string): Promise<string> {
  for (;;) {
    const path = join(stagingRoot, randomName());
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      await syncDirectory(stagingRoot);
      return path;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
  }
}

async function validateRoot(root: string): Promise<void> {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw new FilesystemRootError('must be a normalized absolute path');
  }
  const top = parse(root).root;
  const components = root
    .slice(top.length)
    .split(sep)
    .filter((part) => part !== '');
  let path = top;
  let index = 0;
  for (; index < components.length; index++) {
    const next = join(path, components[index] as string);
    let stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      if (code(error) === 'ENOENT') break;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new FilesystemRootError('or a parent is a symlink');
    if (!stats.isDirectory()) throw new FilesystemRootError('or a parent is not a directory');
    path = next;
  }
  if ((await realpath(path)) !== path) throw new FilesystemRootError('or a parent is a symlink');
  for (; index < components.length; index++) {
    const next = join(path, components[index] as string);
    try {
      await mkdir(next, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    const stats = await lstat(next);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FilesystemRootError('or a parent changed while it was created');
    }
    await syncDirectory(path);
    path = next;
  }
  const stats = await lstat(root);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new FilesystemRootError('is not owned by the service user');
  }
  if ((stats.mode & 0o022) !== 0) throw new FilesystemRootError('is writable by group or others');
}

interface Staging {
  readonly path: string;
  readonly handle: FileHandle;
}

async function createStaging(directory: string): Promise<Staging> {
  for (;;) {
    const path = join(directory, STAGING_PREFIX + randomName());
    try {
      return { path, handle: await open(path, STAGE_FLAGS, FILE_MODE) };
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let at = 0;
  while (at < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, at, chunk.length - at, null);
    at += bytesWritten;
  }
}

async function openRegular(path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    if (code(error) === 'ELOOP') throw new FilesystemUnsafePathError();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new FilesystemUnsafePathError();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

async function readMediaType(path: string): Promise<string | null> {
  const handle = await openRegular(path);
  if (handle === null) return null;
  try {
    return parseMediaType((await handle.readFile({ encoding: 'utf8' })).toString());
  } finally {
    await handle.close();
  }
}

async function verifyExisting(path: string, sha256: string, size: number): Promise<void> {
  const handle = await openRegular(path);
  if (handle === null) throw new BlobBusyError();
  try {
    if ((await handle.stat()).size !== size) throw new FilesystemIntegrityError();
    const hash = createHash('sha256');
    const buffer = new Uint8Array(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== size || hash.digest('hex') !== sha256) throw new FilesystemIntegrityError();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
}

async function isOrphanSidecar(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && stats.mtimeMs < Date.now() - ORPHAN_SIDECAR_MS;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function openFilesystemByteStore(
  options: FilesystemByteStoreOptions,
): Promise<ByteStore> {
  const root = options?.root;
  await validateRoot(root);
  const stagingRoot = join(root, STAGING_DIRECTORY);
  await makeDirectory(stagingRoot);
  await sweepStaging(stagingRoot);
  const instance = await createInstanceDirectory(stagingRoot);

  const inFlight = new Set<string>();
  let refresher: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    const now = new Date();
    await utimes(instance, now, now);
  }

  async function stage(): Promise<Staging> {
    let staging: Staging;
    try {
      staging = await createStaging(instance);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      try {
        await makeDirectory(stagingRoot);
        await makeDirectory(instance);
        staging = await createStaging(instance);
      } catch (retryError) {
        throw vanishedAsBusy(retryError);
      }
    }
    inFlight.add(staging.path);
    if (refresher === null) {
      refresher = setInterval(() => {
        refresh().catch(() => undefined);
      }, REFRESH_MS);
      refresher.unref?.();
    }
    try {
      await refresh();
    } catch (error) {
      await release(staging);
      throw vanishedAsBusy(error);
    }
    return staging;
  }

  async function release(staging: Staging): Promise<void> {
    await staging.handle.close().catch(() => undefined);
    try {
      await unlink(staging.path);
      await syncDirectory(instance);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    } finally {
      inFlight.delete(staging.path);
      if (inFlight.size === 0 && refresher !== null) {
        clearInterval(refresher);
        refresher = null;
      }
    }
  }

  async function probe(): Promise<void> {
    const staging = await stage();
    try {
      await staging.handle.close();
      const target = join(root, PROBE_PREFIX + randomName());
      try {
        await link(staging.path, target);
      } catch (error) {
        if (code(error) === 'EXDEV') {
          throw new FilesystemRootError('staging is on a different filesystem than the root');
        }
        throw error;
      }
      await unlink(target);
    } finally {
      await release(staging);
    }
  }

  await probe();

  const publishing = new Map<string, Promise<unknown>>();

  async function exclusive<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = publishing.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    publishing.set(path, current);
    try {
      return await current;
    } finally {
      if (publishing.get(path) === current) publishing.delete(path);
    }
  }

  async function directoryOf(parents: readonly string[], create: boolean): Promise<string | null> {
    let path = root;
    for (const part of parents) {
      path = join(path, part);
      if (create) await makeDirectory(path);
      else if (!(await requireDirectory(path))) return null;
    }
    return path;
  }

  async function publishMediaType(
    directory: string,
    name: string,
    mediaType: string,
  ): Promise<{ mediaType: string; created: boolean }> {
    const staging = await stage();
    try {
      await writeAll(staging.handle, new TextEncoder().encode(mediaType));
      await staging.handle.sync();
      await staging.handle.close();
      const target = join(directory, name + MEDIA_SUFFIX);
      const publish = async (): Promise<boolean> => {
        try {
          await link(staging.path, target);
          return true;
        } catch (error) {
          if (code(error) !== 'EEXIST') throw vanishedAsBusy(error);
          return false;
        }
      };
      if (await publish()) return { mediaType, created: true };
      if (!(await exists(join(directory, name)))) {
        if (!(await isOrphanSidecar(target))) throw new BlobBusyError();
        const claim = join(directory, CLAIM_PREFIX + randomName());
        try {
          await rename(target, claim);
        } catch (error) {
          throw vanishedAsBusy(error);
        }
        if (!(await isOrphanSidecar(claim))) {
          await link(claim, target).catch(() => undefined);
          await unlink(claim);
          throw new BlobBusyError();
        }
        await unlink(claim);
        if (await publish()) return { mediaType, created: true };
      }
      const existing = await readMediaType(target);
      if (existing === null) throw new BlobBusyError();
      return { mediaType: existing, created: false };
    } finally {
      await release(staging);
    }
  }

  return Object.freeze({
    async putVerified(storageKey, body, input) {
      let key: { parents: string[]; name: string };
      let expected: { sha256: string; size: number; mediaType: string };
      try {
        key = parseKey(storageKey);
        expected = parsePutInput(input);
      } catch (error) {
        await body.cancel().catch(() => undefined);
        throw error;
      }
      const reader = body.getReader();
      let staging: Staging | null = null;
      let source: 'reader' | 'local' = 'local';
      try {
        staging = await stage();
        const hash = createHash('sha256');
        let count = 0;
        for (;;) {
          source = 'reader';
          const { done, value } = await reader.read();
          source = 'local';
          if (done) break;
          if (!(value instanceof Uint8Array)) throw new BlobValidationError();
          count += value.length;
          if (count > expected.size) throw new BlobSizeMismatchError();
          hash.update(value);
          await writeAll(staging.handle, value);
        }
        if (count !== expected.size) throw new BlobSizeMismatchError();
        if (hash.digest('hex') !== expected.sha256) throw new BlobValidationError();
        await staging.handle.sync();
        await staging.handle.close();

        const directory = await directoryOf(key.parents, true);
        if (directory === null) throw new FilesystemUnsafePathError();
        const finalPath = join(directory, key.name);
        const staged = staging;
        const stored = await exclusive(finalPath, async () => {
          const sidecar = await publishMediaType(directory, key.name, expected.mediaType);
          try {
            await link(staged.path, finalPath);
          } catch (error) {
            if (code(error) === 'EEXIST') {
              await verifyExisting(finalPath, expected.sha256, expected.size);
            } else {
              if (sidecar.created) {
                await unlink(finalPath + MEDIA_SUFFIX).catch(() => undefined);
              }
              throw code(error) === 'ENOENT' ? new BlobBusyError() : error;
            }
          }
          await syncDirectory(directory);
          return sidecar.mediaType;
        });
        staging = null;
        await release(staged);
        return { size: expected.size, mediaType: stored };
      } catch (error) {
        if (source === 'local') await reader.cancel().catch(() => undefined);
        if (staging !== null) await release(staging).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    },

    async get(storageKey, range) {
      const { parents, name } = parseKey(storageKey);
      const directory = await directoryOf(parents, false);
      if (directory === null) return null;
      const handle = await openRegular(join(directory, name));
      if (handle === null) return null;
      let owned = true;
      try {
        const stats = await handle.stat();
        const mediaType = await readMediaType(join(directory, name + MEDIA_SUFFIX));
        if (mediaType === null) return null;
        let served: ByteRange | null = null;
        if (range !== undefined) {
          if (
            !Number.isSafeInteger(range.offset) ||
            !Number.isSafeInteger(range.length) ||
            range.offset < 0 ||
            range.length < 1 ||
            range.offset >= stats.size
          ) {
            throw new BlobRangeError();
          }
          served = {
            offset: range.offset,
            length: Math.min(range.length, stats.size - range.offset),
          };
        }
        const stream =
          served === null
            ? handle.createReadStream({ autoClose: true })
            : handle.createReadStream({
                start: served.offset,
                end: served.offset + served.length - 1,
                autoClose: true,
              });
        owned = false;
        return {
          size: stats.size,
          mediaType,
          range: served,
          body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
        };
      } finally {
        if (owned) await handle.close().catch(() => undefined);
      }
    },

    async head(storageKey) {
      const { parents, name } = parseKey(storageKey);
      const directory = await directoryOf(parents, false);
      if (directory === null) return null;
      let stats;
      try {
        stats = await lstat(join(directory, name));
      } catch (error) {
        if (code(error) === 'ENOENT') return null;
        throw error;
      }
      if (!stats.isFile()) throw new FilesystemUnsafePathError();
      const mediaType = await readMediaType(join(directory, name + MEDIA_SUFFIX));
      return mediaType === null ? null : { size: stats.size, mediaType };
    },

    async remove(storageKey) {
      const { parents, name } = parseKey(storageKey);
      const directory = await directoryOf(parents, false);
      if (directory === null) return;
      for (const file of [name + MEDIA_SUFFIX, name]) {
        await unlink(join(directory, file)).catch((error: unknown) => {
          if (code(error) !== 'ENOENT') throw error;
        });
      }
      await syncDirectory(directory);
    },
  } satisfies ByteStore);
}
