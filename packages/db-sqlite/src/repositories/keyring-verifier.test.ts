import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import { createKeyring } from '@package-broker/core/secrets/keyring';
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
  await migrate(opened.executor, [init], { holder: 't707' });
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
    expect(await store.add({ version: 1, mac: mac(1) })).toBe(true);
    expect(await store.add({ version: 1, mac: mac(2) })).toBe(false);
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

  it('reports a missing version index as an unavailable store', async () => {
    await migrated();
    await run('DROP INDEX token_pepper_version', []);
    await expect(
      createKeyringVerifierStore(opened.executor).checkUsedVersions([1]),
    ).rejects.toBeInstanceOf(KeyringStoreUnavailableError);
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
    await store.checkUsedVersions([1]);
    expect(seen.length).toBe(8);
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

  describe('checkUsedVersions', () => {
    async function organization(): Promise<void> {
      await run("INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')", []);
      await run(
        "INSERT INTO user_account (id, org_id, email) VALUES ('01USER', '01ORG', 'a@example.test')",
        [],
      );
    }

    it('is empty without key-dependent rows', async () => {
      await migrated();
      expect(await createKeyringVerifierStore(opened.executor).checkUsedVersions([1])).toBe(false);
    });

    it('reports credential key versions', async () => {
      await migrated();
      await organization();
      await run(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01C', '01ORG', 'k', X'00', X'000000000000000000000000', 3, 'a')",
        [],
      );
      const store = createKeyringVerifierStore(opened.executor);
      await expect(store.checkUsedVersions([1])).rejects.toMatchObject({
        keyVersion: 3,
        message: expect.stringContaining('credential'),
      });
      expect(await store.checkUsedVersions([3])).toBe(true);
    });

    it('reports token pepper versions', async () => {
      await migrated();
      await organization();
      await run(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES ('01T', '01ORG', 'pat', 'abcdefghijkl', '${'a'.repeat(64)}', 2, 'n', '[]', '01USER', '2099-01-01T00:00:00.000Z')`,
        [],
      );
      const store = createKeyringVerifierStore(opened.executor);
      await expect(store.checkUsedVersions([1])).rejects.toMatchObject({
        keyVersion: 2,
        message: expect.stringContaining('token'),
      });
      expect(await store.checkUsedVersions([2])).toBe(true);
    });

    it('names local_login for a missing password version and reports unreadable hashes separately', async () => {
      await migrated();
      await organization();
      await run(
        `INSERT INTO local_login (user_id, org_id, password_hash) VALUES ('01USER', '01ORG', 'pbkdf2-sha256$i=100000$v=12$${'A'.repeat(22)}$${'A'.repeat(43)}')`,
        [],
      );
      const store = createKeyringVerifierStore(opened.executor);
      await expect(store.checkUsedVersions([1])).rejects.toMatchObject({
        name: 'KeyringVersionInUseError',
        keyVersion: 12,
        message: expect.stringContaining('local_login'),
      });
      expect(await store.checkUsedVersions([12])).toBe(true);
      await run(
        `UPDATE local_login SET password_hash = 'pbkdf2-sha256$i=100000$v=12$${'A'.repeat(22)}$${'B'.repeat(43)}'`,
        [],
      );
      await expect(store.checkUsedVersions([12])).rejects.toMatchObject({
        name: 'KeyringPasswordHashUnreadableError',
      });
      await run("UPDATE local_login SET password_hash = 'pbkdf2-sha256$garbage'", []);
      await expect(store.checkUsedVersions([12])).rejects.toMatchObject({
        name: 'KeyringPasswordHashUnreadableError',
        message: expect.stringContaining('local_login'),
      });
    });

    it('ignores a null password hash and accepts repeated uses of a configured version', async () => {
      await migrated();
      await organization();
      await run("INSERT INTO local_login (user_id, org_id) VALUES ('01USER', '01ORG')", []);
      for (const id of ['01C1', '01C2']) {
        await run(
          `INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('${id}', '01ORG', 'k', X'00', X'000000000000000000000000', 3, 'a')`,
          [],
        );
      }
      const store = createKeyringVerifierStore(opened.executor);
      await expect(store.checkUsedVersions([1])).rejects.toMatchObject({
        keyVersion: 3,
        message: expect.stringContaining('credential'),
      });
      expect(await store.checkUsedVersions([3])).toBe(true);
    });
  });
  it('samples one authentic credential per loaded version and refuses mismatched AAD', async () => {
    await migrated();
    await run("INSERT INTO organization (id, slug, name) VALUES ('01ORG', 'acme', 'Acme')", []);
    const keyring = createKeyring(
      [2, 1].map((version) => ({ version, bytes: new Uint8Array(32).fill(version) })),
    );
    for (const [id, version] of [
      ['01C1', 1],
      ['01C2', 1],
      ['01C3', 2],
    ] as const) {
      const aad = credentialAad({ id, orgId: '01ORG', kind: 'k' });
      const cipher = createSecretCipher(
        createKeyring([{ version, bytes: new Uint8Array(32).fill(version) }]),
        'credential-encryption',
      );
      const sealed = await cipher.seal(new Uint8Array([7]), aad);
      await run(
        `INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, '01ORG', 'k', X'${Buffer.from(sealed.ciphertext).toString('hex')}', X'${Buffer.from(sealed.nonce).toString('hex')}', ?, ?)`,
        [id, version, aad],
      );
    }
    const store = createKeyringVerifierStore(opened.executor);
    const samples = await store.credentialSamples([2, 1]);
    expect(samples.map((sample) => sample.sealed.keyVersion)).toEqual([2, 1]);
    for (const sample of samples) {
      const plaintext = await createSecretCipher(keyring, 'credential-encryption').open(
        sample.sealed,
        sample.aad,
      );
      expect(plaintext).toEqual(new Uint8Array([7]));
      plaintext.fill(0);
    }
    await run("UPDATE credential SET aad = 'wrong' WHERE key_version = 1", []);
    await expect(store.credentialSamples([1])).rejects.toMatchObject({
      name: 'KeyringMismatchError',
      keyVersion: 1,
    });
  });

  it('EXPLAIN QUERY PLAN uses the new version indexes for both bounded in-use checks', async () => {
    await migrated();
    const checks: import('@package-broker/core/db/port').ScalarStatement[] = [];
    const store = createKeyringVerifierStore({
      ...opened.executor,
      all: (statement) => {
        if (statement.sql.includes('NOT IN')) checks.push(statement);
        return opened.executor.all(statement);
      },
    });
    await store.checkUsedVersions([1, 2, 3, 4]);
    expect(checks).toHaveLength(2);
    for (const [index, statement] of checks.entries()) {
      expect(statement.sql).toMatch(/SELECT 1, .* NOT IN \(\?, \?, \?, \?\).*LIMIT 1/);
      const plan = await opened.executor.all<{ detail: string }>({
        ...statement,
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      });
      expect(plan.map((row) => row.detail).join(' ')).toContain(
        index === 0 ? 'credential_version_in_use' : 'token_pepper_version',
      );
    }
    await expect(store.checkUsedVersions([1, 2, 3, 4, 5])).rejects.toThrow(RangeError);
  });
});
