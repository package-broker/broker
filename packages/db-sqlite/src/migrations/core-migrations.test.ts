import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlValue } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource, type MigrationSource } from './source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);

async function loadCore(only?: (name: string) => boolean): Promise<MigrationSource[]> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql') && (only?.(name) ?? true))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

const ORG = '01J0ACME000000000000000000';
const USER = '01J0USER000000000000000000';
const OTHER_USER = '01J0USER000000000000000001';
const IDENTITY = '01J0IDEN000000000000000000';
const SESSION = '01J0SESS000000000000000000';
const CREDENTIAL = '01J0CRED000000000000000000';
const HASH_64 = 'a'.repeat(64);
const SETUP_EXPIRY = '2026-10-16T09:00:00.000Z';

let opened: OpenedExecutor;

beforeEach(() => {
  opened = openNodeSqliteExecutor();
});

afterEach(async () => {
  await opened.close();
});

async function run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
  await opened.executor.all({ sql, params });
}

async function rows<R>(sql: string, params: readonly SqlValue[] = []): Promise<R[]> {
  return opened.executor.all<R>({ sql, params });
}

async function countTables(): Promise<number> {
  const [row] = await rows<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return row?.n ?? -1;
}

async function seedOrganization(): Promise<void> {
  await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [ORG, 'acme', 'Acme']);
}

async function seedUser(id: string, email: string): Promise<void> {
  await run('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [id, ORG, email]);
}

async function seedCredential(): Promise<void> {
  await run(
    'INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [CREDENTIAL, ORG, 'totp', new Uint8Array([1, 2, 3]), new Uint8Array(12), 1, 'aad'],
  );
}

async function insertLocalLogin(
  userId: string,
  columns: Record<string, SqlValue> = {},
): Promise<void> {
  const values: Record<string, SqlValue> = { user_id: userId, org_id: ORG, ...columns };
  const names = Object.keys(values);
  await run(
    `INSERT INTO local_login (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

async function dbErrorKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) return error.kind;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

async function tableNames(): Promise<string[]> {
  const found = await rows<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return found.map((row) => row.name);
}

async function snapshot(): Promise<Record<string, Record<string, unknown>[]>> {
  const tables = ['organization', 'user_account', 'identity', 'session', 'credential'];
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const columns = await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
    const names = columns.map((column) => column.name).filter((name) => name !== 'validated_at');
    result[table] = await rows(`SELECT ${names.join(', ')} FROM ${table} ORDER BY id`);
  }
  return result;
}

async function migrateAll(): Promise<void> {
  await migrate(opened.executor, await loadCore(), { holder: 'core-migrations-test' });
}

describe('core migrations', () => {
  it('1: a fresh database gets every core migration: 39 tables, expand phase for 0002', async () => {
    const sources = await loadCore();
    const ids = sources.map((source) => source.id);

    const result = await migrate(opened.executor, sources, { holder: 'core-migrations-test' });

    expect(ids.slice(0, 2)).toEqual(['core:0001_init', 'core:0002_local_login']);
    expect(result.applied).toEqual(ids);
    expect(await countTables()).toBe(39);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(['local_login', 'identity_provider_binding']),
    );
    expect(sources.find((source) => source.id === 'core:0002_local_login')?.phase).toBe('expand');
    const applied = await rows<{ id: string }>('SELECT id FROM schema_migration ORDER BY id');
    expect(applied.map((row) => row.id)).toEqual(ids);
  });

  it('2: upgrades a populated 0001 database and keeps its rows', async () => {
    const [init] = await loadCore((name) => name.startsWith('0001_'));
    if (init === undefined) throw new Error('0001_init.sql is missing');
    await migrate(opened.executor, [init], { holder: 'core-migrations-test' });
    await seedOrganization();
    await seedUser(USER, 'admin@example.test');
    await run(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
      [IDENTITY, ORG, USER, 'dex', 'subject-1', 'admin@example.test'],
    );
    await run(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [SESSION, ORG, USER, IDENTITY, HASH_64, HASH_64, SETUP_EXPIRY],
    );
    await seedCredential();
    expect(await countTables()).toBe(37);
    const before = await snapshot();
    const sources = await loadCore();

    const result = await migrate(opened.executor, sources, { holder: 'core-migrations-test' });

    expect(result.applied).toEqual(sources.slice(1).map((source) => source.id));
    expect(result.skipped).toEqual(['core:0001_init']);
    expect(await countTables()).toBe(39);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(['local_login', 'identity_provider_binding']),
    );
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await rows('SELECT id, validated_at FROM identity')).toEqual([
      { id: IDENTITY, validated_at: null },
    ]);
  });

  describe('local_login', () => {
    beforeEach(async () => {
      await migrateAll();
      await seedOrganization();
      await seedUser(USER, 'admin@example.test');
      await seedUser(OTHER_USER, 'other@example.test');
    });

    it('3: deleting the referenced credential sets totp_credential_id to NULL', async () => {
      await seedCredential();
      await insertLocalLogin(USER, { totp_credential_id: CREDENTIAL });

      await run('DELETE FROM credential WHERE id = ?', [CREDENTIAL]);

      expect(await rows('SELECT user_id, totp_credential_id FROM local_login')).toEqual([
        { user_id: USER, totp_credential_id: null },
      ]);
    });

    it('4: a missing user fails with kind foreign_key', async () => {
      expect(await dbErrorKind(insertLocalLogin('01J0MISSING00000000000000'))).toBe('foreign_key');
    });

    it('5: applies the column defaults', async () => {
      await insertLocalLogin(USER);

      const [row] = await rows<{ credential_rev: number; failed_count: number }>(
        'SELECT credential_rev, failed_count FROM local_login',
      );
      expect(row).toEqual({ credential_rev: 0, failed_count: 0 });
    });

    it('6: setup_hash without setup_expires_at fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { setup_hash: HASH_64 }))).toBe('check');
    });

    it('7: setup_expires_at without setup_hash fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { setup_expires_at: SETUP_EXPIRY }))).toBe(
        'check',
      );
    });

    it('8: a 63-character setup_hash fails with kind check', async () => {
      const columns = { setup_hash: 'a'.repeat(63), setup_expires_at: SETUP_EXPIRY };
      expect(await dbErrorKind(insertLocalLogin(USER, columns))).toBe('check');
    });

    it('8b: a 64-character setup_hash that is not lowercase hex fails with kind check', async () => {
      const columns = { setup_hash: 'Z'.repeat(64), setup_expires_at: SETUP_EXPIRY };
      expect(await dbErrorKind(insertLocalLogin(USER, columns))).toBe('check');
    });

    it('9: a password_hash outside the pbkdf2-sha256 format fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { password_hash: 'bcrypt$x' }))).toBe(
        'check',
      );
    });

    it('10: a pbkdf2-sha256 password_hash is accepted', async () => {
      await insertLocalLogin(USER, { password_hash: 'pbkdf2-sha256$i=100000$v=1$salt$hash' });

      expect(await rows('SELECT user_id FROM local_login')).toEqual([{ user_id: USER }]);
    });

    it('10b: a password_hash with the prefix in another case fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { password_hash: 'PBKDF2-SHA256$x' }))).toBe(
        'check',
      );
    });

    it('11: a negative credential_rev fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { credential_rev: -1 }))).toBe('check');
    });

    it('12: a negative failed_count or totp_last_step fails with kind check', async () => {
      expect(await dbErrorKind(insertLocalLogin(USER, { failed_count: -1 }))).toBe('check');
      expect(await dbErrorKind(insertLocalLogin(USER, { totp_last_step: -1 }))).toBe('check');
    });

    it('13: a duplicate non-NULL setup_hash fails with kind unique', async () => {
      const columns = { setup_hash: HASH_64, setup_expires_at: SETUP_EXPIRY };
      await insertLocalLogin(USER, columns);

      expect(await dbErrorKind(insertLocalLogin(OTHER_USER, columns))).toBe('unique');
    });

    it('13b: two rows pointing at the same TOTP credential fail with kind unique', async () => {
      await seedCredential();
      await insertLocalLogin(USER, { totp_credential_id: CREDENTIAL });

      expect(
        await dbErrorKind(insertLocalLogin(OTHER_USER, { totp_credential_id: CREDENTIAL })),
      ).toBe('unique');
    });

    it('14: two rows with a NULL setup_hash succeed', async () => {
      await insertLocalLogin(USER);
      await insertLocalLogin(OTHER_USER);

      expect(await rows('SELECT user_id FROM local_login')).toHaveLength(2);
    });
  });

  describe('identity_provider_binding', () => {
    beforeEach(async () => {
      await migrateAll();
      await seedOrganization();
    });

    async function bind(provider: string, anchor: string): Promise<void> {
      await run(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        [ORG, provider, anchor],
      );
    }

    it('15: a duplicate (org_id, provider) fails with kind unique', async () => {
      await bind('dex', 'oidc:https://dex.example.test');

      expect(await dbErrorKind(bind('dex', 'oidc:https://other.example.test'))).toBe('unique');
    });

    it('16: another provider binds, and an empty or padded provider fails with kind check', async () => {
      await bind('dex', 'oidc:https://dex.example.test');
      await bind('access', 'access:team.example.test/aud');

      expect(await rows('SELECT provider FROM identity_provider_binding')).toHaveLength(2);
      expect(await dbErrorKind(bind('', 'anchor'))).toBe('check');
      expect(await dbErrorKind(bind(' dex', 'anchor'))).toBe('check');
      expect(await dbErrorKind(bind('okta', ''))).toBe('check');
    });
  });
});
