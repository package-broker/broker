import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import {
  archiveFileName,
  createFilesystemArchiveStore,
  SshArchiveStoreError,
} from './ssh-archive-store.js';
import type { FilesystemArchiveStore } from './ssh-archive-store.js';
import type { SshBuiltArchive } from './ssh-provider.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const { link: mockedLink, open: mockedOpen } = await import('node:fs/promises');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const ctx = orgContext('org-1');
const SECRET_URL = 'ssh://deploy-secret@git.internal.example/private/repo.git';
const source: ProviderSource = {
  id: 'source-1',
  ecosystem: 'composer',
  url: null,
  type: 'vcs',
  config: { provider: 'ssh', repository: SECRET_URL, refs: { tags: true, branches: [] } },
};
const MAX = 1024;

function archiveOf(fill: number, size = 16): SshBuiltArchive {
  const zip = new Uint8Array(size).fill(fill);
  return {
    version: '1.0.0',
    versionNormalized: '1.0.0.0',
    commit: 'a'.repeat(40),
    zip,
    sha1: createHash('sha1').update(zip).digest('hex'),
    time: null,
  };
}

let base: string;
let root: string;
let store: FilesystemArchiveStore;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'ssh-archive-unit-')));
  root = join(base, 'store');
  store = await createFilesystemArchiveStore(root, { maxZipBytes: MAX });
});

afterEach(async () => {
  vi.mocked(mockedOpen).mockImplementation(actualFs.open);
  vi.mocked(mockedLink).mockImplementation(actualFs.link);
  await rm(base, { recursive: true, force: true });
});

const staged = () => readdir(join(root, '.staging'));
const published = async () => (await readdir(root)).filter((entry) => !entry.startsWith('.'));

describe('filesystem archive store', () => {
  it('keeps the first archive bytes on a repeated put', async () => {
    const first = archiveOf(1);
    const second = archiveOf(2);
    await store.store(ctx, source, 'acme/lib', first);
    await store.store(ctx, source, 'acme/lib', second);
    expect(
      await store.readZip(ctx, source, 'acme/lib', first.versionNormalized, first.commit),
    ).toEqual(first.zip);
    expect(
      await store.find(ctx, source, 'acme/lib', first.versionNormalized, first.commit),
    ).toEqual({
      sha1: first.sha1,
      time: null,
    });
    expect(await staged()).toEqual([]);
  });

  it('accepts an archive exactly at the size cap', async () => {
    await store.store(ctx, source, 'acme/lib', archiveOf(3, MAX));
    expect(await published()).toHaveLength(1);
  });

  it('rejects an archive one byte over the cap and leaves nothing behind', async () => {
    await expect(store.store(ctx, source, 'acme/lib', archiveOf(3, MAX + 1))).rejects.toMatchObject(
      {
        reason: 'too_large',
      },
    );
    expect(await published()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  it('leaves one complete archive after concurrent puts of the same key', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => archiveOf(index + 1, 512));
    await Promise.all(
      candidates.map((candidate) => store.store(ctx, source, 'acme/lib', candidate)),
    );
    const zip = await store.readZip(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40));
    expect(candidates.map((candidate) => candidate.zip)).toContainEqual(zip);
    expect(await published()).toHaveLength(1);
    expect(await staged()).toEqual([]);
  });

  it('removes its temporary file when publication fails', async () => {
    vi.mocked(mockedLink).mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(store.store(ctx, source, 'acme/lib', archiveOf(1))).rejects.toBeInstanceOf(
      SshArchiveStoreError,
    );
    expect(await staged()).toEqual([]);
    expect(await published()).toEqual([]);
  });

  it('separates organizations sharing a root', async () => {
    const second = orgContext('org-2');
    await store.store(ctx, source, 'acme/lib', archiveOf(1));
    expect(await store.find(second, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40))).toBeNull();
    await store.store(second, source, 'acme/lib', archiveOf(2));
    expect(await store.readZip(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40))).toEqual(
      archiveOf(1).zip,
    );
    expect(await store.readZip(second, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40))).toEqual(
      archiveOf(2).zip,
    );
  });
});

describe('filesystem archive store confinement', () => {
  const hostile = [
    '../escape',
    '../../escape',
    'a/../../escape',
    '..',
    '/etc/passwd',
    'a\\..\\escape',
    'name\u0000nul',
    '%2e%2e/escape',
  ];

  it.each(hostile)('keeps %j inside the root', async (name) => {
    const before = await readdir(base);
    const built = archiveOf(1);
    await store.store(ctx, source, name, built);
    expect(await readdir(base)).toEqual(before);
    const entries = await published();
    expect(entries).toEqual([archiveFileName(ctx.orgId, source.id, name, '1.0.0.0', built.commit)]);
    expect(entries[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.readZip(ctx, source, name, built.versionNormalized, built.commit)).toEqual(
      built.zip,
    );
  });

  it('refuses to read through a symlink planted at a key', async () => {
    const outside = join(base, 'outside');
    await writeFile(outside, 'not an archive');
    const key = archiveFileName(ctx.orgId, source.id, 'acme/lib', '1.0.0.0', 'a'.repeat(40));
    await symlink(outside, join(root, key));
    await expect(
      store.find(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40)),
    ).rejects.toBeInstanceOf(SshArchiveStoreError);
    await expect(store.store(ctx, source, 'acme/lib', archiveOf(1))).rejects.toBeInstanceOf(
      SshArchiveStoreError,
    );
    expect(await readFile(outside, 'utf8')).toBe('not an archive');
  });

  it('refuses a symlinked root', async () => {
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    const linked = join(base, 'linked');
    await symlink(real, linked);
    await expect(createFilesystemArchiveStore(linked, { maxZipBytes: MAX })).rejects.toMatchObject({
      reason: 'unsafe_root',
    });
  });

  it('refuses a relative or non-normalised root', async () => {
    for (const bad of ['relative/dir', `${base}/a/../b`]) {
      await expect(createFilesystemArchiveStore(bad, { maxZipBytes: MAX })).rejects.toMatchObject({
        reason: 'unsafe_root',
      });
    }
  });

  it('refuses a staging directory replaced by a symlink', async () => {
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await rm(join(root, '.staging'), { recursive: true });
    await symlink(elsewhere, join(root, '.staging'));
    await expect(store.store(ctx, source, 'acme/lib', archiveOf(1))).rejects.toMatchObject({
      reason: 'unsafe_root',
    });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('rejects invalid options', async () => {
    for (const options of [{ maxZipBytes: 0 }, { maxZipBytes: 1.5 }, { maxZipBytes: Number.NaN }]) {
      await expect(createFilesystemArchiveStore(root, options)).rejects.toMatchObject({
        reason: 'invalid_options',
      });
    }
  });
});

describe('filesystem archive store errors', () => {
  const name = 'vendor-secret/package-secret';

  const expectClean = (error: unknown) => {
    expect(error).toBeInstanceOf(SshArchiveStoreError);
    const text = JSON.stringify([
      (error as Error).message,
      (error as Error).stack?.split('\n')[0],
      (error as Error).cause,
      Object.getOwnPropertyNames(error).map((key) => String((error as never)[key])),
    ]);
    for (const leaked of [
      root,
      base,
      name,
      SECRET_URL,
      'deploy-secret',
      source.id,
      'a'.repeat(40),
    ]) {
      expect(text).not.toContain(leaked);
    }
  };

  it('does not leak paths or keys from an oversize rejection', async () => {
    const error = await store
      .store(ctx, source, name, archiveOf(1, MAX + 1))
      .catch((e: unknown) => e);
    expectClean(error);
  });

  it('does not leak the path carried by a filesystem error', async () => {
    vi.mocked(mockedLink).mockRejectedValueOnce(
      Object.assign(new Error(`EIO: i/o error, link '${root}/${name}'`), {
        code: 'EIO',
        path: root,
        dest: name,
      }),
    );
    expectClean(await store.store(ctx, source, name, archiveOf(1)).catch((e: unknown) => e));
  });

  it('does not leak the path from a failed read', async () => {
    const key = archiveFileName(ctx.orgId, source.id, name, '1.0.0.0', 'a'.repeat(40));
    await writeFile(join(root, key), 'garbage');
    expectClean(
      await store.find(ctx, source, name, '1.0.0.0', 'a'.repeat(40)).catch((e: unknown) => e),
    );
    expectClean(
      await store.readZip(ctx, source, name, '1.0.0.0', 'a'.repeat(40)).catch((e: unknown) => e),
    );
  });
});

describe('filesystem archive store hardening', () => {
  const key = () => archiveFileName(ctx.orgId, source.id, 'acme/lib', '1.0.0.0', 'a'.repeat(40));

  it('rejects malformed archive input before staging anything', async () => {
    vi.mocked(mockedOpen).mockClear();
    const good = archiveOf(1);
    await expect(
      store.store(ctx, source, 'acme/lib', { ...good, sha1: 'nothex' }),
    ).rejects.toMatchObject({ reason: 'invalid_archive' });
    await expect(
      store.store(ctx, source, 'acme/lib', { ...good, zip: 'text' as never }),
    ).rejects.toMatchObject({ reason: 'invalid_archive' });
    await expect(
      store.store(ctx, source, 'acme/lib', { ...good, time: 'x'.repeat(5000) }),
    ).rejects.toMatchObject({ reason: 'invalid_metadata' });
    await expect(
      store.store(ctx, source, 'acme/lib', { ...good, time: 'yesterday' }),
    ).rejects.toMatchObject({ reason: 'invalid_metadata' });
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(await published()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  it('removes stale staging files left by a crashed process and keeps fresh ones', async () => {
    const stale = join(root, '.staging', '.stage-old');
    const fresh = join(root, '.staging', '.stage-new');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await createFilesystemArchiveStore(root, { maxZipBytes: MAX });
    expect(await staged()).toEqual(['.stage-new']);
  });

  it('refuses a root below a directory writable by other users', async () => {
    const open = join(base, 'open');
    await mkdir(open);
    await chmod(open, 0o777);
    await expect(
      createFilesystemArchiveStore(join(open, 'store'), { maxZipBytes: MAX }),
    ).rejects.toMatchObject({ reason: 'unsafe_root' });
  });

  it('accepts a root below a sticky shared directory', async () => {
    const shared = join(base, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o1777);
    await createFilesystemArchiveStore(join(shared, 'store'), { maxZipBytes: MAX });
  });

  it('does not reject a put whose directory fsync fails after publication', async () => {
    vi.mocked(mockedOpen).mockImplementation(((path: string, flags: number, mode?: number) =>
      (flags & constants.O_DIRECTORY) !== 0
        ? Promise.reject(Object.assign(new Error(`EIO ${root}`), { code: 'EIO' }))
        : actualFs.open(path, flags, mode)) as never);
    await store.store(ctx, source, 'acme/lib', archiveOf(1));
    vi.mocked(mockedOpen).mockImplementation(actualFs.open);
    expect(await store.find(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40))).not.toBeNull();
    expect(await staged()).toEqual([]);
  });

  it('recreates a removed staging directory', async () => {
    await rm(join(root, '.staging'), { recursive: true });
    await store.store(ctx, source, 'acme/lib', archiveOf(1));
    expect(await published()).toHaveLength(1);
  });

  it('does not block on a FIFO planted at a key', async () => {
    execFileSync('mkfifo', [join(root, key())]);
    await expect(
      store.find(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40)),
    ).rejects.toMatchObject({
      reason: 'io',
    });
  });

  it('rejects reading an archive larger than the configured cap', async () => {
    const big = await createFilesystemArchiveStore(root, { maxZipBytes: MAX * 4 });
    await big.store(ctx, source, 'acme/lib', archiveOf(1, MAX * 2));
    await expect(
      store.readZip(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40)),
    ).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('keeps a sanitised errno code and no path on wrapped errors', async () => {
    vi.mocked(mockedLink).mockRejectedValueOnce(
      Object.assign(new Error(`ENOSPC ${root}`), { code: 'ENOSPC', path: root }),
    );
    const error = await store.store(ctx, source, 'acme/lib', archiveOf(1)).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'io', code: 'ENOSPC' });
    vi.mocked(mockedLink).mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: `/${root}/secret` }),
    );
    const other = await store.store(ctx, source, 'acme/lib', archiveOf(1)).catch((e: unknown) => e);
    expect((other as { code?: string }).code).toBeUndefined();
  });

  it('cleans a raw filesystem error carrying a path through find and readZip', async () => {
    const raw = () =>
      Object.assign(new Error(`EACCES: permission denied, open '${root}/secret-key'`), {
        code: 'EACCES',
        path: `${root}/secret-key`,
      });
    for (const call of [
      () => store.find(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40)),
      () => store.readZip(ctx, source, 'acme/lib', '1.0.0.0', 'a'.repeat(40)),
    ]) {
      vi.mocked(mockedOpen).mockRejectedValueOnce(raw());
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SshArchiveStoreError);
      expect(JSON.stringify([(error as Error).message, (error as Error).cause])).not.toContain(
        base,
      );
      expect(Object.keys(error as object)).not.toContain('path');
      expect((error as SshArchiveStoreError).code).toBe('EACCES');
    }
  });

  it('refuses to start without O_NOFOLLOW', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
    });
    try {
      const fresh = await import('./ssh-archive-store.js');
      await expect(
        fresh.createFilesystemArchiveStore(join(base, 'second'), { maxZipBytes: MAX }),
      ).rejects.toMatchObject({ reason: 'unsafe_root' });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('lets exactly the first successful link win among concurrent puts', async () => {
    let winner: Uint8Array | null = null;
    vi.mocked(mockedLink).mockImplementation(async (from, to) => {
      const bytes = new Uint8Array(await readFile(from));
      await actualFs.link(from, to);
      winner ??= bytes;
    });
    const candidates = Array.from({ length: 8 }, (_, index) => archiveOf(index + 1, 64));
    await Promise.all(
      candidates.map((candidate) => store.store(ctx, source, 'acme/lib', candidate)),
    );
    const stored = new Uint8Array(await readFile(join(root, key())));
    expect(winner).not.toBeNull();
    expect(stored).toEqual(winner);
    await store.store(ctx, source, 'acme/lib', archiveOf(99, 64));
    expect(new Uint8Array(await readFile(join(root, key())))).toEqual(winner);
  });
});
