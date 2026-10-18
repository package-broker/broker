import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import {
  assertSshArchiveAtomicPublish,
  describeSshArchiveStoreContract,
  type SshArchiveStoreContractFixture,
} from '../testing/ssh-archive-store-contract.js';
import { createFilesystemArchiveStore } from './ssh-archive-store.js';
import type { SshArchiveRecord, SshArchiveStore, SshBuiltArchive } from './ssh-provider.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
const { link: mockedLink } = await import('node:fs/promises');

const ctx = orgContext('org-1');

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

describeSshArchiveStoreContract({ describe, it }, 'memory', async () =>
  createMemoryArchiveFixture(),
);

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

describeSshArchiveStoreContract({ describe, it }, 'filesystem', createFilesystemFixture);

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
