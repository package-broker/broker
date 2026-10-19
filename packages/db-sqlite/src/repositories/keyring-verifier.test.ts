import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { KeyringStoreUnavailableError } from '@package-broker/core/secrets/keyring-verifier';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { KeyringMismatchError } from '@package-broker/core/secrets/keyring-verifier';
import type { Database, KeyringVerifierTable } from '../schema.js';
import { createKeyringVerifierStore } from './keyring-verifier.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

let opened: OpenedExecutor;

beforeEach(async () => {
  opened = openNodeSqliteExecutor();
});

afterEach(async () => {
  await opened.close();
});

async function run(sql: string, params: (string | number)[]): Promise<void> {
  await opened.executor.batch([{ sql, params }]);
}

async function migrated(): Promise<void> {
  const init = await loadMigrationSource('core', '0001_init.sql', read('0001_init.sql'));
  const login = await loadMigrationSource(
    'core',
    '0002_local_login.sql',
    read('0002_local_login.sql'),
  );
  const verifier = await loadMigrationSource(
    'core',
    '0015_keyring_verifier.sql',
    read('0015_keyring_verifier.sql'),
  );
  await migrate(opened.executor, [init, login, verifier], { holder: 't707' });
}

const mac = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe('keyring verifier store', () => {
  it('starts empty and returns what it stored, bytes intact', async () => {
    await migrated();
    const store = createKeyringVerifierStore(opened.executor);
    expect(await store.list()).toEqual([]);
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 8 + 1);
    await store.add({ version: 3, mac: bytes });
    await store.add({ version: 2, mac: mac(9) });
    const rows = await store.list();
    expect(rows.map((row) => row.version)).toEqual([3, 2]);
    expect(rows[0]?.mac).toEqual(bytes);
  });

  it('keeps the first row for a version and ignores a second write', async () => {
    await migrated();
    const store = createKeyringVerifierStore(opened.executor);
    await store.add({ version: 1, mac: mac(1) });
    await store.add({ version: 1, mac: mac(2) });
    expect(await store.list()).toEqual([{ version: 1, mac: mac(1) }]);
  });

  it('rejects a mac that is not 32 bytes', async () => {
    await migrated();
    const store = createKeyringVerifierStore(opened.executor);
    await expect(store.add({ version: 1, mac: new Uint8Array(31) })).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('reports a missing table as an unavailable store', async () => {
    const store = createKeyringVerifierStore(opened.executor);
    await expect(store.list()).rejects.toBeInstanceOf(KeyringStoreUnavailableError);
  });

  it('writes and reads the mac without unhex() or bound BLOB parameters', async () => {
    await migrated();
    const seen: string[] = [];
    const store = createKeyringVerifierStore({
      driver: opened.executor.driver,
      all: (statement) => {
        seen.push(statement.sql);
        expect(statement.params.every((value) => typeof value !== 'object' || value === null)).toBe(
          true,
        );
        return opened.executor.all(statement);
      },
      batch: (statements) => {
        for (const statement of statements) {
          seen.push(statement.sql);
          expect(
            statement.params.every((value) => typeof value !== 'object' || value === null),
          ).toBe(true);
        }
        return opened.executor.batch(statements);
      },
    });
    await store.enroll({ version: 1, mac: mac(1) });
    await store.add({ version: 2, mac: mac(2) });
    await store.list();
    await store.usedVersions();
    expect(seen.length).toBe(4);
    expect(seen.join('\n')).not.toMatch(/unhex/i);
  });

  it('enroll stores only while the table is empty and reports whether it stored', async () => {
    await migrated();
    const store = createKeyringVerifierStore(opened.executor);
    expect(await store.enroll({ version: 4, mac: mac(4) })).toBe(true);
    expect(await store.enroll({ version: 5, mac: mac(5) })).toBe(false);
    expect(await store.list()).toEqual([{ version: 4, mac: mac(4) }]);
  });

  it('a malformed stored mac raises KeyringMismatchError with the version', async () => {
    for (const mac_hex of ['0102', null, 42, 'zz'.repeat(32)]) {
      const executor: ScalarSqlExecutor = {
        driver: 'none',
        all: async () => [{ key_version: 7, mac_hex }] as never,
        batch: async () => [],
      };
      const store = createKeyringVerifierStore(executor);
      await expect(store.list()).rejects.toBeInstanceOf(KeyringMismatchError);
      await expect(store.list()).rejects.toMatchObject({ keyVersion: 7 });
    }
  });

  it('the table itself refuses a stored mac that is not 32 bytes', async () => {
    await migrated();
    await expect(
      run("INSERT INTO keyring_verifier (key_version, mac) VALUES (7, X'0102')", []),
    ).rejects.toThrow(/length\(mac\) = 32/);
  });

  it('stores the mac as a BLOB, matching the declared table type', async () => {
    await migrated();
    const store = createKeyringVerifierStore(opened.executor);
    await store.add({ version: 1, mac: mac(0xab) });
    const rows = await opened.executor.all<{ t: string; v: number }>({
      sql: 'SELECT typeof(mac) AS t, key_version AS v FROM keyring_verifier',
      params: [],
    });
    expect(rows).toEqual([{ t: 'blob', v: 1 }]);
    expectTypeOf<Database['keyring_verifier']>().toEqualTypeOf<KeyringVerifierTable>();
    expectTypeOf<KeyringVerifierTable['mac']>().toEqualTypeOf<Uint8Array>();
  });

  it('declares exactly the migrated columns with their storage types', async () => {
    await migrated();
    const declared: Record<keyof KeyringVerifierTable, string> = {
      key_version: 'INTEGER',
      mac: 'BLOB',
      created_at: 'TEXT',
    };
    const columns = await opened.executor.all<{ name: string; type: string }>({
      sql: "SELECT name, type FROM pragma_table_info('keyring_verifier') ORDER BY cid",
      params: [],
    });
    expect(Object.fromEntries(columns.map((column) => [column.name, column.type]))).toEqual(
      declared,
    );
  });

  describe('usedVersions', () => {
    async function organization(): Promise<void> {
      await run("INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')", []);
      await run(
        "INSERT INTO user_account (id, org_id, email) VALUES ('01USER', '01ORG', 'a@example.test')",
        [],
      );
    }

    it('is empty without key-dependent rows', async () => {
      await migrated();
      expect(await createKeyringVerifierStore(opened.executor).usedVersions()).toEqual([]);
    });

    it('reports credential key versions', async () => {
      await migrated();
      await organization();
      await run(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01C', '01ORG', 'k', X'00', X'000000000000000000000000', 3, 'a')",
        [],
      );
      expect(await createKeyringVerifierStore(opened.executor).usedVersions()).toEqual([3]);
    });

    it('reports token pepper versions', async () => {
      await migrated();
      await organization();
      await run(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES ('01T', '01ORG', 'pat', 'abcdefghijkl', '${'a'.repeat(64)}', 2, 'n', '[]', '01USER', '2099-01-01T00:00:00.000Z')`,
        [],
      );
      expect(await createKeyringVerifierStore(opened.executor).usedVersions()).toEqual([2]);
    });

    it('reports password hash pepper versions and treats an unreadable one as version 0', async () => {
      await migrated();
      await organization();
      await run(
        `INSERT INTO local_login (user_id, org_id, password_hash) VALUES ('01USER', '01ORG', 'pbkdf2-sha256$i=100000$v=12$${'A'.repeat(22)}$${'B'.repeat(43)}')`,
        [],
      );
      const store = createKeyringVerifierStore(opened.executor);
      expect(await store.usedVersions()).toEqual([12]);
      await run("UPDATE local_login SET password_hash = 'pbkdf2-sha256$garbage'", []);
      expect(await store.usedVersions()).toEqual([0]);
    });

    it('ignores a null password hash and returns each version once', async () => {
      await migrated();
      await organization();
      await run("INSERT INTO local_login (user_id, org_id) VALUES ('01USER', '01ORG')", []);
      for (const id of ['01C1', '01C2']) {
        await run(
          `INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('${id}', '01ORG', 'k', X'00', X'000000000000000000000000', 3, 'a')`,
          [],
        );
      }
      expect(await createKeyringVerifierStore(opened.executor).usedVersions()).toEqual([3]);
    });
  });
});
