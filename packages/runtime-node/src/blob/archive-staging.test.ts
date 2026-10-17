import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveStaging } from '@package-broker/core/sources/git/archive';
import { nodeCodecs } from '../codec/node-codec.js';
import {
  ArchiveStagingDirectoryError,
  ArchiveStagingError,
  createNodeArchiveStaging,
} from './archive-staging.js';

const hooks = vi.hoisted(() => ({ opened: null as null | ((handle: FileHandle) => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      hooks.opened?.(handle);
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  hooks.opened = null;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pb-archive-'));
  roots.push(root);
  return root;
}
const missing = (path: string) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

describe('Node archive staging', () => {
  it('refuses directories owned by another user or writable by group or others', async () => {
    const root = await directory();
    const uid = process.getuid!();
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(createNodeArchiveStaging({ directory: root })).rejects.toBeInstanceOf(
      ArchiveStagingDirectoryError,
    );
    getuid.mockRestore();
    for (const mode of [0o720, 0o702]) {
      await chmod(root, mode);
      await expect(createNodeArchiveStaging({ directory: root })).rejects.toBeInstanceOf(
        ArchiveStagingDirectoryError,
      );
    }
  });

  it('refuses a directory replaced after startup', async () => {
    const root = await directory();
    const target = join(root, 'staging');
    const staging = await createNodeArchiveStaging({ directory: target });
    const first = await staging.create();
    await first.discard();
    await rename(target, join(root, 'original'));
    await mkdir(target, { mode: 0o700 });
    await expect(staging.create()).rejects.toBeInstanceOf(ArchiveStagingDirectoryError);
  });

  it('attempts close only once when closing the handle rejects', async () => {
    let close!: ReturnType<typeof vi.fn>;
    hooks.opened = (handle) => {
      const original = handle.close.bind(handle);
      close = vi.spyOn(handle, 'close').mockImplementation(async () => {
        await original();
        throw new Error('private close error');
      });
    };
    const file = await (await createNodeArchiveStaging({ directory: await directory() })).create();
    await expect(file.writable.getWriter().close()).rejects.toBeInstanceOf(ArchiveStagingError);
    await file.discard();
    await file.discard();
    expect(close).toHaveBeenCalledTimes(1);
    await missing(file.path);
  });

  it('rejects a non-Uint8Array chunk and removes the file', async () => {
    const file = await (await createNodeArchiveStaging({ directory: await directory() })).create();
    const writer = file.writable.getWriter();
    await expect(writer.write('private' as unknown as Uint8Array)).rejects.toBeInstanceOf(
      ArchiveStagingError,
    );
    await missing(file.path);
    await file.discard();
  });

  it('accepts a valid random name with leading zeroes', async () => {
    const name = '0'.repeat(31) + 'a';
    const staging = await createNodeArchiveStaging({
      directory: await directory(),
      randomName: () => name,
    });
    const file = await staging.create();
    expect(basename(file.path)).toBe(`archive-${name}.zip.part`);
    await file.discard();
  });

  it('creates private, distinct files and a private missing directory', async () => {
    const target = join(await directory(), 'staging');
    const previous = process.umask(0o022);
    try {
      const staging = (await createNodeArchiveStaging({
        directory: target,
      })) satisfies ArchiveStaging;
      const a = await staging.create();
      const b = await staging.create();
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      for (const file of [a, b]) {
        expect(dirname(file.path)).toBe(target);
        expect(basename(file.path)).toMatch(/^archive-[0-9a-f]{32}\.zip\.part$/);
        expect((await stat(file.path)).mode & 0o777).toBe(0o600);
        await file.discard();
      }
      expect(a.path).not.toBe(b.path);
    } finally {
      process.umask(previous);
    }
  });

  it('round-trips 3 MiB in uneven chunks through the digest tap', async () => {
    const staging = await createNodeArchiveStaging({ directory: await directory() });
    const file = await staging.create();
    const data = randomBytes(3 * 1024 * 1024);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === data.length) return controller.close();
        const end = Math.min(data.length, offset + (offset % 65521) + 123);
        controller.enqueue(data.subarray(offset, end));
        offset = end;
      },
    });
    const tap = nodeCodecs.digestTap(['sha1', 'sha256']);
    await source.pipeThrough(tap.transform).pipeTo(file.writable);
    const disk = await readFile(file.path);
    expect(disk.equals(data)).toBe(true);
    expect(Buffer.from((await tap.digests).sha256).toString('hex')).toBe(
      createHash('sha256').update(disk).digest('hex'),
    );
    await file.discard();
    await file.discard();
    await missing(file.path);
  });

  it.each(['abort', 'discard'] as const)(
    'cleans up with %s before close, twice',
    async (action) => {
      const file = await (
        await createNodeArchiveStaging({ directory: await directory() })
      ).create();
      if (action === 'abort') await file.writable.abort('private content');
      else await file.discard();
      await file.discard();
      await missing(file.path);
    },
  );

  it('ignores an already removed file', async () => {
    const file = await (await createNodeArchiveStaging({ directory: await directory() })).create();
    await unlink(file.path);
    await file.discard();
    await file.discard();
  });

  it.each(['abort', 'discard'] as const)(
    'serializes partial writes and waits for a pending write on %s',
    async (action) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = 0;
      let maximum = 0;
      hooks.opened = (handle) => {
        const write = handle.write.bind(handle);
        const target: {
          write(
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number | null,
          ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
        } = handle;
        vi.spyOn(target, 'write').mockImplementation(async (buffer, offset, length, position) => {
          active++;
          maximum = Math.max(maximum, active);
          entered();
          await paused;
          try {
            return await write(buffer, offset, Math.min(length ?? buffer.byteLength, 7), position);
          } finally {
            active--;
          }
        });
      };
      const staging = await createNodeArchiveStaging({ directory: await directory() });
      const file = await staging.create();
      const writer = file.writable.getWriter();
      const first = writer.write(new Uint8Array(101).fill(42));
      await started;
      const discarded = action === 'abort' ? writer.abort('private content') : file.discard();
      release();
      await first;
      await discarded;
      expect(maximum).toBe(1);
      await file.discard();
      await missing(file.path);
      // A separate completed file verifies the partial-write loop preserves all bytes.
      const complete = await staging.create();
      const output = complete.writable.getWriter();
      await Promise.all([
        output.write(new Uint8Array(101).fill(42)),
        output.write(new Uint8Array([9])),
      ]);
      await output.close();
      expect(await readFile(complete.path)).toEqual(
        Buffer.from([...new Uint8Array(101).fill(42), 9]),
      );
      await complete.discard();
    },
  );

  it.each(['write', 'sync'] as const)(
    'removes failed files and sanitizes %s errors',
    async (method) => {
      hooks.opened = (handle) => {
        vi.spyOn(handle, method).mockRejectedValue(new Error('private path and content'));
      };
      const file = await (
        await createNodeArchiveStaging({ directory: await directory() })
      ).create();
      const writer = file.writable.getWriter();
      const result = method === 'write' ? writer.write(new Uint8Array([1])) : writer.close();
      await expect(result).rejects.toMatchObject({
        name: 'ArchiveStagingError',
        message: 'archive staging operation failed',
      });
      await missing(file.path);
      await file.discard();
    },
  );

  it('refuses relative, symlink and non-directory paths', async () => {
    await expect(createNodeArchiveStaging({ directory: 'relative' })).rejects.toBeInstanceOf(
      TypeError,
    );
    const root = await directory();
    const link = join(root, 'link');
    const file = join(root, 'file');
    await symlink(root, link);
    await writeFile(file, 'private');
    for (const target of [link, file]) {
      await expect(createNodeArchiveStaging({ directory: target })).rejects.toBeInstanceOf(
        ArchiveStagingDirectoryError,
      );
      await expect(createNodeArchiveStaging({ directory: target })).rejects.toMatchObject({
        name: 'ArchiveStagingDirectoryError',
        message: 'invalid archive staging directory',
      });
    }
  });

  it.each(['', 'a'.repeat(31), 'A'.repeat(32), '../private', `${'a'.repeat(32)}\n`])(
    'rejects invalid names at create: %j',
    async (name) => {
      const staging = await createNodeArchiveStaging({
        directory: await directory(),
        randomName: () => name,
      });
      await expect(staging.create()).rejects.toBeInstanceOf(TypeError);
    },
  );

  it('uses exclusive no-follow opens without truncating collisions', async () => {
    const root = await directory();
    const name = 'a'.repeat(32);
    const path = join(root, `archive-${name}.zip.part`);
    await writeFile(path, 'original');
    const staging = await createNodeArchiveStaging({ directory: root, randomName: () => name });
    await expect(staging.create()).rejects.toMatchObject({
      name: 'ArchiveStagingError',
      message: 'archive staging operation failed',
    });
    expect(await readFile(path, 'utf8')).toBe('original');
    await unlink(path);
    const target = join(root, 'target');
    await writeFile(target, 'original');
    await symlink(target, path);
    await expect(staging.create()).rejects.toMatchObject({ name: 'ArchiveStagingError' });
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });
});
