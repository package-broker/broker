import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import {
  assertSshArchiveAtomicPublish,
  describeSshArchiveStoreContract,
  type SshArchiveStoreContractFixture,
} from '../testing/ssh-archive-store-contract.js';
import type { SshArchiveRecord, SshArchiveStore, SshBuiltArchive } from './ssh-provider.js';

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
    async find(src, name, version, commit) {
      const entry = published.get(keyOf(src, name, version, commit));
      return entry === undefined ? null : { ...entry.record };
    },
    async store(src, name, built) {
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
            async store(_source, _name, built) {
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
