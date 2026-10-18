import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { ProviderSource } from '@package-broker/core/sources/provider';
import type {
  SshArchiveRecord,
  SshArchiveStore,
  SshBuiltArchive,
} from '../sources/ssh-provider.js';

export interface SshArchiveStoreFixture {
  readonly store: SshArchiveStore;
  readonly readZip: (
    source: ProviderSource,
    name: string,
    versionNormalized: string,
    commit: string,
  ) => Promise<Uint8Array | null>;
}

export interface SshArchiveStoreContractFixture extends SshArchiveStoreFixture {
  readonly source: ProviderSource;
  readonly maxArchiveBytes: number;
  readonly temporaryFiles: () => Promise<readonly string[]>;
  readonly failNextWrite: () => void;
  readonly close: () => Promise<void>;
}

export interface SuiteHarness {
  readonly describe: (name: string, body: () => void) => unknown;
  readonly it: (name: string, body: () => Promise<void>) => unknown;
}

const LEAK_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /PRIVATE KEY/,
  /id_key|known_hosts|\.ssh\b/,
];

function sameBytes(actual: Uint8Array | null, expected: Uint8Array): boolean {
  return actual !== null && Buffer.from(actual).equals(Buffer.from(expected));
}

function sameRecord(actual: SshArchiveRecord | null, expected: SshArchiveRecord): boolean {
  return (
    actual !== null &&
    Object.keys(actual).sort().join() === 'sha1,time' &&
    actual.sha1 === expected.sha1 &&
    actual.time === expected.time
  );
}

/** Observe publication while a put is in progress, including its final state. */
export async function assertSshArchiveAtomicPublish(
  fixture: SshArchiveStoreFixture,
  source: ProviderSource,
  name: string,
  archive: SshBuiltArchive,
): Promise<void> {
  let finished = false;
  const pending = fixture.store.store(source, name, archive).finally(() => {
    finished = true;
  });
  void pending.catch(() => undefined);
  try {
    do {
      const record = await fixture.store.find(
        source,
        name,
        archive.versionNormalized,
        archive.commit,
      );
      if (record !== null) {
        const zip = await fixture.readZip(source, name, archive.versionNormalized, archive.commit);
        assert.ok(sameBytes(zip, archive.zip), 'metadata visible before the complete ZIP');
        assert.ok(sameRecord(record, archive), 'published record differs from the archive');
      }
      if (!finished) await setImmediate();
    } while (!finished);
    await pending;
    assert.ok(
      sameRecord(
        await fixture.store.find(source, name, archive.versionNormalized, archive.commit),
        archive,
      ),
      'record missing after publication',
    );
    assert.ok(
      sameBytes(
        await fixture.readZip(source, name, archive.versionNormalized, archive.commit),
        archive.zip,
      ),
      'ZIP missing after publication',
    );
  } finally {
    await pending.catch(() => undefined);
  }
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    if (error.cause !== undefined) parts.push(errorText(error.cause));
  } else {
    parts.push(String(error));
  }
  try {
    parts.push(JSON.stringify(error) ?? '');
  } catch {
    parts.push('');
  }
  return parts.join('\n');
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return assert.fail('expected the operation to reject');
}

function assertAbsent(actual: SshArchiveRecord | null, message: string): void {
  assert.equal(actual, null, message);
}

/** Factory returns a fresh, organization-bound store for each case. */
export function describeSshArchiveStoreContract(
  harness: SuiteHarness,
  name: string,
  create: () => Promise<SshArchiveStoreContractFixture>,
): void {
  const { describe, it } = harness;
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
        assertAbsent(
          await store.find(source, 'acme/lib', archive.versionNormalized, archive.commit),
          'absent key reported a record',
        );
      }));

    it('publishes complete bytes and metadata atomically', () =>
      run(async (fixture) => {
        await assertSshArchiveAtomicPublish(fixture, fixture.source, 'acme/lib', archive);
      }));

    it('preserves the first publication and isolates source, name, version and commit', () =>
      run(async (fixture) => {
        const { store, source } = fixture;
        await store.store(source, 'acme/lib', archive);
        await store.store(source, 'acme/lib', { ...archive, time: null });
        assert.ok(
          sameRecord(
            await store.find(source, 'acme/lib', archive.versionNormalized, archive.commit),
            archive,
          ),
          'the first publication was replaced',
        );
        for (const [src, name, version, commit] of [
          [{ ...source, id: 'different' }, 'acme/lib', archive.versionNormalized, archive.commit],
          [source, 'acme/other', archive.versionNormalized, archive.commit],
          [source, 'acme/lib', '2.0.0.0', archive.commit],
          [source, 'acme/lib', archive.versionNormalized, 'b'.repeat(40)],
        ] as const) {
          assertAbsent(await store.find(src, name, version, commit), 'keys are not isolated');
        }
      }));

    it('rejects oversized ZIPs without publishing or retaining temporary files', () =>
      run(async (fixture) => {
        const { store, source } = fixture;
        await rejection(
          store.store(source, 'acme/lib', {
            ...archive,
            zip: new Uint8Array(fixture.maxArchiveBytes + 1),
          }),
        );
        assertAbsent(
          await store.find(source, 'acme/lib', archive.versionNormalized, archive.commit),
          'an oversized archive was published',
        );
        assert.deepEqual(await fixture.temporaryFiles(), []);
      }));

    it('cleans up a failed write without publishing metadata', () =>
      run(async (fixture) => {
        fixture.failNextWrite();
        await rejection(fixture.store.store(fixture.source, 'acme/lib', archive));
        assertAbsent(
          await fixture.store.find(
            fixture.source,
            'acme/lib',
            archive.versionNormalized,
            archive.commit,
          ),
          'a failed write was published',
        );
        assert.deepEqual(await fixture.temporaryFiles(), []);
      }));

    it('carries no URL, key path or credential text in a failed write error', () =>
      run(async (fixture) => {
        fixture.failNextWrite();
        const text = errorText(
          await rejection(fixture.store.store(fixture.source, 'acme/lib', archive)),
        );
        const repository =
          fixture.source.type === 'vcs' ? fixture.source.config.repository : undefined;
        if (repository !== undefined)
          assert.ok(!text.includes(repository), 'error echoes the repository');
        for (const pattern of LEAK_PATTERNS) {
          assert.ok(!pattern.test(text), `error text matches ${String(pattern)}`);
        }
      }));
  });
}
