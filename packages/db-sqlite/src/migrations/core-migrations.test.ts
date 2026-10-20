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

function expectContiguousSequences(
  sources: readonly Pick<MigrationSource, 'owner' | 'sequence'>[],
): void {
  const byOwner = new Map<string, number[]>();
  for (const { owner, sequence } of sources) {
    const sequences = byOwner.get(owner) ?? [];
    sequences.push(sequence);
    byOwner.set(owner, sequences);
  }
  for (const [owner, sequences] of byOwner) {
    expect(
      sequences.sort((a, b) => a - b),
      `${owner}: migration sequences must be 1..N`,
    ).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
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

describe('migration sequence contiguity', () => {
  it('checks every core migration from the directory', async () => {
    expectContiguousSequences(await loadCore());
  });

  it('checks each owner independently, regardless of input order', () => {
    expectContiguousSequences([
      { owner: 'plugin-a', sequence: 2 },
      { owner: 'core', sequence: 1 },
      { owner: 'plugin-b', sequence: 1 },
      { owner: 'plugin-a', sequence: 1 },
      { owner: 'core', sequence: 2 },
    ]);
  });

  it.each(['core', 'plugin-a'])('rejects a gap for %s', (owner) => {
    expect(() =>
      expectContiguousSequences([
        { owner, sequence: 1 },
        { owner, sequence: 3 },
      ]),
    ).toThrow(owner);
  });

  it.each(['core', 'plugin-a'])('rejects a duplicate for %s', (owner) => {
    expect(() =>
      expectContiguousSequences([
        { owner, sequence: 1 },
        { owner, sequence: 2 },
        { owner, sequence: 2 },
      ]),
    ).toThrow(owner);
  });

  it('requires every owner to start at one', () => {
    expect(() =>
      expectContiguousSequences([
        { owner: 'core', sequence: 1 },
        { owner: 'plugin-a', sequence: 2 },
      ]),
    ).toThrow('plugin-a');
  });
});

describe('core migrations', () => {
  it('1: a fresh database gets every core migration: 55 tables, expand phase for 0002', async () => {
    const sources = await loadCore();
    const ids = sources.map((source) => source.id);

    const result = await migrate(opened.executor, sources, { holder: 'core-migrations-test' });

    expect(ids.slice(0, 2)).toEqual(['core:0001_init', 'core:0002_local_login']);
    const migrationFiles = readdirSync(migrationsUrl)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(ids.at(-1)).toBe(`core:${migrationFiles.at(-1)?.slice(0, -'.sql'.length)}`);
    expect(result.applied).toEqual(ids);
    // 37 from 0001, +2 from 0002, +3 from 0003, +1 from 0004: cache_epoch; 0005 and 0006 add none, 0007: 4; 0008, 0009 and 0010 add none; 0011 adds 2; 0012, 0013 and 0014 add none; 0015 adds 1
    expect(await countTables()).toBe(55);
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
    // 0002, 0003, 0004, 0007, 0015_keyring_verifier and 0011 add 13 tables to the 37 of 0001
    expect(await countTables()).toBe(55);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(['local_login', 'identity_provider_binding']),
    );
    const after = await snapshot();
    expect(after).toEqual({
      ...before,
      user_account: (before.user_account ?? []).map((row) => ({
        ...row,
        pat_invalid_before: null,
      })),
    });
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

  describe('cache_epoch', () => {
    const OTHER_ORG = '01J0ACME000000000000000001';

    it('17: seeds one random 32-character hex version for each existing organization', async () => {
      const [init] = await loadCore((name) => name.startsWith('0001_'));
      if (init === undefined) throw new Error('0001_init.sql is missing');
      await migrate(opened.executor, [init], { holder: 'core-migrations-test' });
      await seedOrganization();

      await migrateAll();

      const found = await rows<{ org_id: string; version: string }>(
        'SELECT org_id, version FROM cache_epoch',
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.org_id).toBe(ORG);
      expect(found[0]?.version).toMatch(/^[0-9A-F]{32}$/);
    });

    it('18: seeds no row on an empty database and creates no trigger', async () => {
      await migrateAll();

      expect(await rows('SELECT org_id FROM cache_epoch')).toEqual([]);
      expect(await rows("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);
    });

    it('19: a version is required and an unknown organization fails with kind foreign_key', async () => {
      await migrateAll();
      await seedOrganization();

      expect(
        await dbErrorKind(
          run('INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [ORG, null]),
        ),
      ).toBe('not_null');
      expect(
        await dbErrorKind(
          run('INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [
            '01J0MISSING00000000000000',
            'v',
          ]),
        ),
      ).toBe('foreign_key');
    });

    it('20: a second row for one organization fails with kind unique', async () => {
      await migrateAll();
      await seedOrganization();
      await run('INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [ORG, 'a']);

      expect(
        await dbErrorKind(
          run('INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [ORG, 'b']),
        ),
      ).toBe('unique');
    });

    it('21: deleting the organization cascades to its cache_epoch row only', async () => {
      await migrateAll();
      await seedOrganization();
      await run('DROP INDEX organization_singleton');
      await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
        OTHER_ORG,
        'other',
        'Other',
      ]);
      await run('INSERT INTO cache_epoch (org_id, version) SELECT id, ? FROM organization', ['v']);

      await run('DELETE FROM organization WHERE id = ?', [OTHER_ORG]);

      expect(await rows('SELECT org_id FROM cache_epoch')).toEqual([{ org_id: ORG }]);
    });

    it('23: a failure after CREATE TABLE cache_epoch leaves no table and no bookkeeping row', async () => {
      const before = await loadCore((name) => name < '0004_');
      const [real] = await loadCore((name) => name.startsWith('0004_'));
      if (real === undefined) throw new Error('0004_cache_epoch.sql is missing');
      const broken = await loadMigrationSource(
        'core',
        '0004_cache_epoch.sql',
        `${real.sql}\nCREATE TABL broken (id INTEGER);\n`,
      );

      await expect(
        migrate(opened.executor, [...before, broken], { holder: 'core-migrations-test' }),
      ).rejects.toThrow();

      expect(await tableNames()).not.toContain('cache_epoch');
      expect(
        await rows<{ id: string }>("SELECT id FROM schema_migration WHERE id LIKE '%0004%'"),
      ).toEqual([]);
      expect(await countTables()).toBe(42);
    });

    it('22: the table is STRICT without a rowid shortcut and has exactly org_id and version', async () => {
      await migrateAll();

      expect(
        await rows<{ name: string }>(
          "SELECT name FROM pragma_table_info('cache_epoch') ORDER BY cid",
        ),
      ).toEqual([{ name: 'org_id' }, { name: 'version' }]);
      expect(await rows("SELECT strict FROM pragma_table_list WHERE name = 'cache_epoch'")).toEqual(
        [{ strict: 1 }],
      );
    });
  });
});

describe('import rollback persistence (0019)', () => {
  const COUNT_COLUMNS = [
    'rollback_restored_count',
    'rollback_conflict_count',
    'rollback_expired_count',
  ];

  async function seedJournal(): Promise<void> {
    await seedOrganization();
    await run("INSERT INTO import_run (id, org_id, source_system) VALUES ('run', ?, 'test')", [
      ORG,
    ]);
    await run(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('ref', ?, 'run', 'project', 'p', 'p', 'create')",
      [ORG],
    );
  }

  it('adds the three count columns and expired_at, additive and in the expand phase', async () => {
    const sources = await loadCore();
    const source = sources.find((candidate) => candidate.id.startsWith('core:0019_'));
    expect(source?.phase).toBe('expand');
    await migrate(opened.executor, sources, { holder: 'core-migrations-test' });

    expect(
      await rows<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
        "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('import_run') WHERE name LIKE 'rollback_%' ORDER BY name",
      ),
    ).toEqual(
      [...COUNT_COLUMNS].sort().map((name) => ({
        name,
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      })),
    );
    expect(
      await rows(
        "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('import_ref') WHERE name = 'expired_at'",
      ),
    ).toEqual([{ name: 'expired_at', type: 'TEXT', notnull: 0, dflt_value: null }]);
  });

  it('keeps existing journal rows and backfills zero counts and a null expiry', async () => {
    await migrate(opened.executor, await loadCore((name) => name < '0019_'), {
      holder: 'core-migrations-test',
    });
    await seedJournal();
    const runBefore = await rows<Record<string, SqlValue>>('SELECT * FROM import_run');
    const refBefore = await rows<Record<string, SqlValue>>('SELECT * FROM import_ref');

    await migrate(opened.executor, await loadCore(), { holder: 'core-migrations-test' });

    expect(await rows('SELECT * FROM import_run WHERE 1 = 1')).toEqual([
      {
        ...runBefore[0],
        rollback_restored_count: 0,
        rollback_conflict_count: 0,
        rollback_expired_count: 0,
      },
    ]);
    expect(await rows('SELECT * FROM import_ref WHERE 1 = 1')).toEqual([
      { ...refBefore[0], expired_at: null },
    ]);
  });

  it.each(COUNT_COLUMNS)('rejects a negative %s', async (column) => {
    await migrate(opened.executor, await loadCore(), { holder: 'core-migrations-test' });
    await seedJournal();

    expect(await dbErrorKind(run(`UPDATE import_run SET ${column} = -1 WHERE id = 'run'`))).toBe(
      'check',
    );
  });
});
