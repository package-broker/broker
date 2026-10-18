import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import { createFilesystemArchiveStore } from './ssh-archive-store.js';
import type { SshArchiveRecord, SshArchiveStore, SshBuiltArchive } from './ssh-provider.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
const { link: mockedLink } = await import('node:fs/promises');

const ctx = orgContext('org-1');

export interface SshArchiveStoreFixture {
  readonly store: SshArchiveStore;
  readonly readZip: (
    source: ProviderSource,
    name: string,
    versionNormalized: string,
    commit: string,
  ) => Promise<Uint8Array | null>;
}

/** Observe publication while a put is in progress, including its final state. */
export async function assertSshArchiveAtomicPublish(
  fixture: SshArchiveStoreFixture,
  source: ProviderSource,
  name: string,
  archive: SshBuiltArchive,
): Promise<void> {
  let finished = false;
  const pending = fixture.store.store(ctx, source, name, archive).finally(() => {
    finished = true;
  });
  // Attach a handler immediately; observation can yield before the write rejects.
  void pending.catch(() => undefined);
  try {
    do {
      const record = await fixture.store.find(
        ctx,
        source,
        name,
        archive.versionNormalized,
        archive.commit,
      );
      if (record !== null) {
        const zip = await fixture.readZip(source, name, archive.versionNormalized, archive.commit);
        expect(zip).not.toBeNull();
        expect(zip).toEqual(archive.zip);
        expect(record).toEqual({ sha1: archive.sha1, time: archive.time });
      }
      if (!finished) await setImmediate();
    } while (!finished);
    await pending;
    expect(
      await fixture.store.find(ctx, source, name, archive.versionNormalized, archive.commit),
    ).toEqual({ sha1: archive.sha1, time: archive.time });
    expect(await fixture.readZip(source, name, archive.versionNormalized, archive.commit)).toEqual(
      archive.zip,
    );
  } finally {
    await pending.catch(() => undefined);
  }
}

export interface SshArchiveStoreContractFixture extends SshArchiveStoreFixture {
  readonly source: ProviderSource;
  readonly maxArchiveBytes: number;
  readonly temporaryFiles: () => Promise<readonly string[]>;
  readonly failNextWrite: () => void;
  readonly close: () => Promise<void>;
}

/** Factory returns a fresh, organization-bound store for each case. */
export function describeSshArchiveStoreContract(
  name: string,
  create: () => Promise<SshArchiveStoreContractFixture>,
): void {
  describe(name, () => {
    const zip = new Uint8Array([80, 75, 3, 4]);
    const archive: SshBuiltArchive = {
      version: '1.0.0',
      versionNormalized: '1.0.0.0',
      commit: 'a'.repeat(40),
      zip,
      sha1: createHash('sha1').update(zip).digest('hex'),
      time: '2024-01-02T03:04:05+00:00',
    };
    const run = async (work: (fixture: SshArchiveStoreContractFixture) => Promise<void>) => {
      const fixture = await create();
      try {
        await work(fixture);
      } finally {
        await fixture.close();
      }
    };

    it('returns null for an absent key', () =>
      run(async ({ store, source }) => {
        expect(
          await store.find(ctx, source, 'acme/lib', archive.versionNormalized, archive.commit),
        ).toBeNull();
      }));

    it('publishes complete bytes and metadata atomically', () =>
      run(async (fixture) => {
        await assertSshArchiveAtomicPublish(fixture, fixture.source, 'acme/lib', archive);
      }));

    it('preserves the first publication and isolates source, name, version and commit', () =>
      run(async (fixture) => {
        const { store, source } = fixture;
        await store.store(ctx, source, 'acme/lib', archive);
        await store.store(ctx, source, 'acme/lib', { ...archive, time: null });
        expect(
          await store.find(ctx, source, 'acme/lib', archive.versionNormalized, archive.commit),
        ).toEqual({ sha1: archive.sha1, time: archive.time });
        for (const [src, name, version, commit] of [
          [{ ...source, id: 'different' }, 'acme/lib', archive.versionNormalized, archive.commit],
          [source, 'acme/other', archive.versionNormalized, archive.commit],
          [source, 'acme/lib', '2.0.0.0', archive.commit],
          [source, 'acme/lib', archive.versionNormalized, 'b'.repeat(40)],
        ] as const) {
          expect(await store.find(ctx, src, name, version, commit)).toBeNull();
        }
      }));

    it('rejects oversized ZIPs without publishing or retaining temporary files', () =>
      run(async (fixture) => {
        const { store, source } = fixture;
        await expect(
          store.store(ctx, source, 'acme/lib', {
            ...archive,
            zip: new Uint8Array(fixture.maxArchiveBytes + 1),
          }),
        ).rejects.toThrow();
        expect(
          await store.find(ctx, source, 'acme/lib', archive.versionNormalized, archive.commit),
        ).toBeNull();
        expect(await fixture.temporaryFiles()).toEqual([]);
      }));

    it('cleans up a failed write without publishing metadata', () =>
      run(async (fixture) => {
        fixture.failNextWrite();
        await expect(
          fixture.store.store(ctx, fixture.source, 'acme/lib', archive),
        ).rejects.toThrow();
        expect(
          await fixture.store.find(
            ctx,
            fixture.source,
            'acme/lib',
            archive.versionNormalized,
            archive.commit,
          ),
        ).toBeNull();
        expect(await fixture.temporaryFiles()).toEqual([]);
      }));
  });
}

const source: ProviderSource = {
  id: 'source',
  ecosystem: 'composer',
  url: null,
  type: 'vcs',
  config: {
    provider: 'ssh',
    repository: 'git.example.com:repo.git',
    refs: { tags: true, branches: [] },
  },
};

const archive: SshBuiltArchive = {
  version: '1.0.0',
  versionNormalized: '1.0.0.0',
  commit: 'a'.repeat(40),
  zip: new Uint8Array([80, 75]),
  sha1: '0'.repeat(40),
  time: null,
};

const MEMORY_MAX_ARCHIVE_BYTES = 1024;

function createMemoryArchiveFixture(): SshArchiveStoreContractFixture {
  const published = new Map<string, { zip: Uint8Array; record: SshArchiveRecord }>();
  const staged = new Set<string>();
  let failNext = false;
  const keyOf = (src: ProviderSource, name: string, version: string, commit: string): string =>
    JSON.stringify([src.id, name, version, commit]);
  const store: SshArchiveStore = {
    async find(_ctx, src, name, version, commit) {
      const entry = published.get(keyOf(src, name, version, commit));
      return entry === undefined ? null : { ...entry.record };
    },
    async store(_ctx, src, name, built) {
      const key = keyOf(src, name, built.versionNormalized, built.commit);
      if (built.zip.byteLength > MEMORY_MAX_ARCHIVE_BYTES) throw new Error('archive too large');
      staged.add(key);
      try {
        await setImmediate();
        if (failNext) {
          failNext = false;
          throw new Error('write failed');
        }
        if (!published.has(key)) {
          published.set(key, {
            zip: new Uint8Array(built.zip),
            record: { sha1: built.sha1, time: built.time },
          });
        }
      } finally {
        staged.delete(key);
      }
    },
  };
  return {
    store,
    source,
    maxArchiveBytes: MEMORY_MAX_ARCHIVE_BYTES,
    readZip: async (src, name, version, commit) =>
      published.get(keyOf(src, name, version, commit))?.zip ?? null,
    temporaryFiles: async () => [...staged],
    failNextWrite: () => {
      failNext = true;
    },
    close: async () => undefined,
  };
}

describeSshArchiveStoreContract('memory', async () => createMemoryArchiveFixture());

const FILESYSTEM_MAX_ARCHIVE_BYTES = 64 * 1024;

async function createFilesystemFixture(): Promise<SshArchiveStoreContractFixture> {
  const root = join(await realpath(await mkdtemp(join(tmpdir(), 'ssh-archive-'))), 'store');
  const store = await createFilesystemArchiveStore(root, {
    maxZipBytes: FILESYSTEM_MAX_ARCHIVE_BYTES,
  });
  return {
    store,
    source,
    maxArchiveBytes: FILESYSTEM_MAX_ARCHIVE_BYTES,
    readZip: (src, name, version, commit) => store.readZip(ctx, src, name, version, commit),
    temporaryFiles: async () => readdir(join(root, '.staging')),
    failNextWrite: () => {
      vi.mocked(mockedLink).mockRejectedValueOnce(
        Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }),
      );
    },
    close: async () => rm(join(root, '..'), { recursive: true, force: true }),
  };
}

describeSshArchiveStoreContract('filesystem', createFilesystemFixture);

describe('filesystem store publication', () => {
  it('never exposes a partial archive while a large ZIP is being written', async () => {
    const fixture = await createFilesystemFixture();
    try {
      const zip = new Uint8Array(FILESYSTEM_MAX_ARCHIVE_BYTES).fill(7);
      await assertSshArchiveAtomicPublish(fixture, fixture.source, 'acme/lib', {
        ...archive,
        zip,
        sha1: createHash('sha1').update(zip).digest('hex'),
      });
    } finally {
      await fixture.close();
    }
  });
});

describe('SSH archive contract checker', () => {
  it('rejects a store exposing metadata before its complete bytes', async () => {
    let record: SshArchiveRecord | null = null;
    let zip: Uint8Array | null = null;
    await expect(
      assertSshArchiveAtomicPublish(
        {
          store: {
            async find() {
              return record;
            },
            async store(_ctx, _source, _name, built) {
              record = { sha1: built.sha1, time: built.time };
              await setImmediate();
              zip = built.zip;
            },
          },
          readZip: async () => zip,
        },
        source,
        'acme/lib',
        archive,
      ),
    ).rejects.toThrow();
  });
});
