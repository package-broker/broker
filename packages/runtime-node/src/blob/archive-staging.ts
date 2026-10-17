import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ArchiveStaging, StagedFile } from '@package-broker/core/sources/git/archive';

export interface NodeArchiveStagingOptions {
  readonly directory: string;
  readonly randomName?: () => string;
}

export class ArchiveStagingDirectoryError extends Error {
  override name = 'ArchiveStagingDirectoryError';
  constructor() {
    super('invalid archive staging directory');
  }
}

export class ArchiveStagingError extends Error {
  override name = 'ArchiveStagingError';
  constructor() {
    super('archive staging operation failed');
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function stagedFile(path: string, handle: FileHandle): StagedFile {
  let closed = false;
  let discarded = false;
  let pending: Promise<unknown> = Promise.resolve();

  function exclusive(task: () => Promise<void>): Promise<void> {
    const result = pending.catch(() => undefined).then(task);
    pending = result;
    return result;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await handle.close();
  }

  async function remove(): Promise<void> {
    let closeFailed = false;
    try {
      await close();
    } catch {
      closeFailed = true;
    }
    try {
      await unlink(path);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    if (closeFailed) throw new ArchiveStagingError();
  }

  async function guarded(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch {
      discarded = true;
      await remove().catch(() => undefined);
      throw new ArchiveStagingError();
    }
  }

  const discard = (): Promise<void> => {
    discarded = true;
    return exclusive(() => guarded(remove));
  };

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return exclusive(() =>
        guarded(async () => {
          if (discarded || closed || !(chunk instanceof Uint8Array))
            throw new ArchiveStagingError();
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              null,
            );
            if (bytesWritten <= 0) throw new ArchiveStagingError();
            offset += bytesWritten;
          }
        }),
      );
    },
    close() {
      return exclusive(() =>
        guarded(async () => {
          if (discarded) throw new ArchiveStagingError();
          await handle.sync();
          await close();
        }),
      );
    },
    abort: discard,
  });
  return { path, writable, discard };
}

export async function createNodeArchiveStaging(
  options: NodeArchiveStagingOptions,
): Promise<ArchiveStaging> {
  const { directory } = options;
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new TypeError('archive staging directory must be absolute');
  }
  async function inspectDirectory() {
    try {
      const stats = await lstat(directory);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        stats.uid !== process.getuid!() ||
        (stats.mode & 0o022) !== 0
      ) {
        throw new ArchiveStagingDirectoryError();
      }
      return stats;
    } catch {
      throw new ArchiveStagingDirectoryError();
    }
  }
  try {
    try {
      await mkdir(directory, { mode: 0o700, recursive: true });
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
  } catch {
    throw new ArchiveStagingDirectoryError();
  }
  const initial = await inspectDirectory();
  const randomName = options.randomName ?? (() => randomBytes(16).toString('hex'));
  return {
    async create() {
      const current = await inspectDirectory();
      if (current.dev !== initial.dev || current.ino !== initial.ino) {
        throw new ArchiveStagingDirectoryError();
      }
      let name: string;
      try {
        name = randomName();
      } catch {
        throw new ArchiveStagingError();
      }
      if (typeof name !== 'string' || !/^[0-9a-f]{32}$/.test(name)) {
        throw new TypeError('invalid archive staging name');
      }
      const path = join(directory, `archive-${name}.zip.part`);
      try {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        return stagedFile(path, handle);
      } catch {
        throw new ArchiveStagingError();
      }
    },
  };
}
