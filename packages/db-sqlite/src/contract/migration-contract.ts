import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  type DefaultRoleKey,
} from '@package-broker/core/authz/permissions';
import {
  orgContext,
  type ScalarSqlExecutor,
  type ScalarSqlValue,
} from '@package-broker/core/db/port';
import { bootstrapAdmin } from '../repositories/admin-bootstrap.js';
import { migrate, MigrationApplyError, MigrationChecksumError } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { countCalls } from './count-calls.js';
import type { OpenedExecutor } from './executor-contract.js';

export interface OpenedPair extends OpenedExecutor {
  second(): Promise<ScalarSqlExecutor>;
}

const migrationsUrl = new URL('../../migrations/', import.meta.url);

const ORG = '01J0ACME000000000000000000';
const OTHER_ORG = '01J0ACME000000000000000001';
const USER = '01J0USER000000000000000000';
const IDENTITY = '01J0IDEN000000000000000000';
const PROJECT = '01J0PROJ000000000000000000';
const OTHER_PROJECT = '01J0PROJ000000000000000001';
const READER_ROLE = '01J0ROLE000000000000000001';
const GRANT = '01J0GRNT000000000000000000';
const PRINCIPAL = '01J0SVCP000000000000000000';
const PAT_UNBOUND = '01J0TOKN000000000000000000';
const PAT_BOUND = '01J0TOKN000000000000000001';
const SVC_TOKEN = '01J0TOKN000000000000000002';
const HASH_64 = 'a'.repeat(64);
const EXPIRY = '2027-10-16T09:00:00.000Z';
const NOW = '2026-10-16T09:00:00.000Z';
const SETUP_EXPIRES = '2026-10-17T09:00:00.000Z';

const ROLE_IDS: Readonly<Record<DefaultRoleKey, string>> = {
  organization_admin: '01J0ROLE000000000000000010',
  organization_auditor: '01J0ROLE000000000000000011',
  project_owner: '01J0ROLE000000000000000012',
  project_developer: '01J0ROLE000000000000000013',
  project_auditor: '01J0ROLE000000000000000014',
};

const NEW_TABLES = ['access_mutation_guard', 'identity_block', 'service_principal_permission'];
const REVISED_TABLES = ['role', 'access_grant', 'project', 'service_principal'];
const PRE_0003_ADMIN_PERMISSIONS = [
  'org:read',
  'org:users:read',
  'org:roles:read',
  'org:grants:read',
  'project:read',
  'project:packages:read',
];

const COUNT_TABLES =
  "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'";

async function withPair(
  open: () => Promise<OpenedPair>,
  body: (pair: OpenedPair) => Promise<void>,
): Promise<void> {
  const pair = await open();
  try {
    await body(pair);
  } finally {
    await pair.close();
  }
}

async function countTables(executor: ScalarSqlExecutor): Promise<number> {
  const [row] = await executor.all<{ n: number }>({ sql: COUNT_TABLES, params: [] });
  return row?.n ?? 0;
}

async function countBookkeepingRows(executor: ScalarSqlExecutor): Promise<number> {
  const [row] = await executor.all<{ n: number }>({
    sql: 'SELECT count(*) AS n FROM schema_migration',
    params: [],
  });
  return row?.n ?? 0;
}

interface BookkeepingRecord {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

interface LockRecord {
  readonly id: number;
  readonly holder: string | null;
  readonly acquired_at: string | null;
  readonly expires_at: string | null;
}

async function readBookkeeping(executor: ScalarSqlExecutor): Promise<BookkeepingRecord[]> {
  return executor.all<BookkeepingRecord>({
    sql: 'SELECT id, name, checksum FROM schema_migration ORDER BY id',
    params: [],
  });
}

async function readLock(executor: ScalarSqlExecutor): Promise<LockRecord> {
  const rows = await executor.all<LockRecord>({
    sql: 'SELECT id, holder, acquired_at, expires_at FROM migration_lock',
    params: [],
  });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('migration_lock row is missing');
  return row;
}

async function lockHolder(executor: ScalarSqlExecutor): Promise<string | null> {
  return (await readLock(executor)).holder;
}

async function loadCore(prefix: (name: string) => boolean): Promise<MigrationSource[]> {
  const names = ['0001_init.sql', '0002_local_login.sql', '0003_access_model.sql'].filter(prefix);
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

const upTo0002 = (name: string): boolean => name <= '0002_z';
const all = (): boolean => true;

async function enableForeignKeys(executor: ScalarSqlExecutor): Promise<void> {
  await executor.all({ sql: 'PRAGMA foreign_keys = ON', params: [] });
  const [state] = await executor.all<{ foreign_keys: number }>({
    sql: 'PRAGMA foreign_keys',
    params: [],
  });
  expect(state?.foreign_keys).toBe(1);
}

async function run(
  executor: ScalarSqlExecutor,
  sql: string,
  params: readonly ScalarSqlValue[] = [],
): Promise<void> {
  await executor.all({ sql, params });
}

async function rows<R>(
  executor: ScalarSqlExecutor,
  sql: string,
  params: readonly ScalarSqlValue[] = [],
): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

async function tableNames(executor: ScalarSqlExecutor): Promise<string[]> {
  const found = await rows<{ name: string }>(
    executor,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  );
  return found.map((row) => row.name);
}

async function columnNames(executor: ScalarSqlExecutor, table: string): Promise<string[]> {
  const found = await rows<{ name: string }>(
    executor,
    `SELECT name FROM pragma_table_info('${table}')`,
  );
  return found.map((row) => row.name);
}

async function insertToken(
  executor: ScalarSqlExecutor,
  id: string,
  columns: Record<string, ScalarSqlValue>,
): Promise<void> {
  const values: Record<string, ScalarSqlValue> = {
    id,
    org_id: ORG,
    kind: 'pat',
    selector: id.slice(-12),
    hash: HASH_64,
    pepper_version: 1,
    name: 'laptop',
    scopes_json: '[]',
    user_id: USER,
    expires_at: EXPIRY,
    ...columns,
  };
  const names = Object.keys(values);
  await run(
    executor,
    `INSERT INTO token (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

async function seedPopulated(executor: ScalarSqlExecutor): Promise<void> {
  const statements: [string, ScalarSqlValue[]][] = [
    ['INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [ORG, 'acme', 'Acme']],
    [
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      [USER, ORG, 'owner@example.test'],
    ],
    [
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
      [IDENTITY, ORG, USER, 'dex', 'subject-1', 'owner@example.test'],
    ],
    [
      'INSERT INTO local_login (user_id, org_id, setup_hash, setup_expires_at) VALUES (?, ?, ?, ?)',
      [USER, ORG, 'b'.repeat(64), SETUP_EXPIRES],
    ],
    [
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      [PROJECT, ORG, 'web', 'Web'],
    ],
    [
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      [OTHER_PROJECT, ORG, 'api', 'Api'],
    ],
    [
      'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
      [READER_ROLE, ORG, 'reader', 'Reader', 'project'],
    ],
    [
      'INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1, 1)',
      [
        ROLE_IDS.organization_admin,
        ORG,
        'organization_admin',
        'Organization Admin',
        'organization',
      ],
    ],
    ...PRE_0003_ADMIN_PERMISSIONS.map((permission): [string, ScalarSqlValue[]] => [
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      [ORG, ROLE_IDS.organization_admin, permission],
    ]),
    [
      'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [GRANT, ORG, 'email', 'dev@example.test', 'project', PROJECT, READER_ROLE],
    ],
    [
      'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
      [PRINCIPAL, ORG, 'ci', USER],
    ],
  ];
  for (const [sql, params] of statements) await run(executor, sql, params);
  await insertToken(executor, PAT_UNBOUND, {});
  await insertToken(executor, PAT_BOUND, {});
  await insertToken(executor, SVC_TOKEN, {
    kind: 'svc',
    user_id: null,
    service_principal_id: PRINCIPAL,
  });
  await run(executor, 'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)', [
    ORG,
    PAT_BOUND,
    PROJECT,
  ]);
}

const SNAPSHOT_TABLES = [
  'organization',
  'user_account',
  'identity',
  'local_login',
  'project',
  'role',
  'role_permission',
  'access_grant',
  'service_principal',
  'token',
  'token_project',
];

async function snapshot(
  executor: ScalarSqlExecutor,
  columnsOf: (table: string) => string[] | undefined,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    const columns = columnsOf(table);
    if (columns === undefined) throw new Error(`no columns recorded for ${table}`);
    result[table] = await rows(
      executor,
      `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`,
    );
  }
  return result;
}

async function snapshotColumns(executor: ScalarSqlExecutor): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const table of SNAPSHOT_TABLES) map.set(table, await columnNames(executor, table));
  return map;
}

async function permissionsOf(executor: ScalarSqlExecutor, roleId: string): Promise<string[]> {
  const found = await rows<{ permission: string }>(
    executor,
    'SELECT permission FROM role_permission WHERE org_id = ? AND role_id = ? ORDER BY permission',
    [ORG, roleId],
  );
  return found.map((row) => row.permission);
}

async function count(executor: ScalarSqlExecutor, sql: string): Promise<number> {
  const [row] = await rows<{ n: number }>(executor, sql);
  return row?.n ?? -1;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function probeNewConstraints(executor: ScalarSqlExecutor): Promise<void> {
  await run(executor, 'DROP INDEX organization_singleton');
  await run(executor, 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
    OTHER_ORG,
    'other',
    'Other',
  ]);

  for (const table of REVISED_TABLES) {
    await rejection(run(executor, `UPDATE ${table} SET revision = 0`));
    expect(
      await rows(executor, `SELECT count(*) AS n FROM ${table} WHERE revision < 1`),
      table,
    ).toEqual([{ n: 0 }]);
  }
  await rejection(
    run(executor, "UPDATE token SET project_mode = 'some' WHERE id = ?", [PAT_BOUND]),
  );
  await rejection(run(executor, 'UPDATE token SET project_mode = NULL WHERE id = ?', [PAT_BOUND]));
  await rejection(
    run(executor, "UPDATE token SET validation_kind = 'mfa' WHERE id = ?", [PAT_BOUND]),
  );
  await rejection(
    run(executor, "UPDATE token SET validation_kind = 'sso' WHERE id = ?", [SVC_TOKEN]),
  );
  await rejection(
    run(
      executor,
      "UPDATE token SET validation_kind = 'local', validation_identity_id = ? WHERE id = ?",
      [IDENTITY, PAT_BOUND],
    ),
  );
  await rejection(
    run(executor, 'UPDATE token SET validation_identity_id = ? WHERE id = ?', [
      'no-such-identity',
      PAT_BOUND,
    ]),
  );
  await rejection(
    run(
      executor,
      'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
      [ORG, 'no-such-principal', 'org:read'],
    ),
  );
  await rejection(
    run(
      executor,
      'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
      [OTHER_ORG, PRINCIPAL, 'org:read'],
    ),
  );
  await rejection(run(executor, 'INSERT INTO access_mutation_guard (key) VALUES (?)', [null]));
  await run(executor, 'INSERT INTO access_mutation_guard (key) VALUES (?)', ['k']);
  await rejection(run(executor, 'INSERT INTO access_mutation_guard (key) VALUES (?)', ['k']));
  await run(executor, 'DELETE FROM access_mutation_guard');

  const block = (
    org: string,
    provider: string,
    issuer: string,
    subject: string,
    blockedBy: string | null = null,
  ): Promise<void> =>
    run(
      executor,
      'INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, ?, ?, ?, ?)',
      [org, provider, issuer, subject, blockedBy],
    );
  await block(ORG, 'dex', 'https://issuer.example.test', 'subject-1', USER);
  await block(ORG, 'dex', 'https://issuer.example.test', 'subject-2');
  await block(OTHER_ORG, 'dex', 'https://issuer.example.test', 'subject-1');
  await rejection(block(ORG, 'dex', 'https://issuer.example.test', 'subject-1'));
  await rejection(block(ORG, '', 'https://issuer.example.test', 'subject-3'));
  await rejection(block(ORG, ' dex', 'https://issuer.example.test', 'subject-3'));
  await rejection(block(ORG, 'x'.repeat(65), 'https://issuer.example.test', 'subject-3'));
  await rejection(block(ORG, 'dex', '', 'subject-3'));
  await rejection(block(ORG, 'dex', 'i'.repeat(513), 'subject-3'));
  await rejection(block(ORG, 'dex', 'https://issuer.example.test', ''));
  await rejection(block('no-such-org', 'dex', 'https://issuer.example.test', 'subject-3'));
  await rejection(block(ORG, 'dex', 'https://issuer.example.test', 'subject-3', 'no-such-user'));
  expect(await count(executor, 'SELECT count(*) AS n FROM identity_block')).toBe(3);
  await run(executor, 'DELETE FROM identity_block');

  await run(
    executor,
    "UPDATE token SET validation_kind = 'sso', validation_identity_id = ? WHERE id = ?",
    [IDENTITY, PAT_BOUND],
  );
  await run(
    executor,
    'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
    [ORG, PRINCIPAL, 'org:read'],
  );
  await run(executor, 'DELETE FROM identity WHERE id = ?', [IDENTITY]);
  expect(
    await rows(executor, 'SELECT validation_kind, validation_identity_id FROM token WHERE id = ?', [
      PAT_BOUND,
    ]),
  ).toEqual([{ validation_kind: 'sso', validation_identity_id: null }]);
  await run(executor, 'UPDATE token SET revoked_at = ? WHERE kind = ?', [NOW, 'svc']);
  await run(executor, 'DELETE FROM token WHERE kind = ?', ['svc']);
  await run(executor, 'DELETE FROM service_principal WHERE id = ?', [PRINCIPAL]);
  expect(await count(executor, 'SELECT count(*) AS n FROM service_principal_permission')).toBe(0);
}

export function describeMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
  core0001: () => Promise<MigrationSource>,
): void {
  describe(`migration contract: ${name}`, () => {
    it('1. applies the real 0001_init.sql: 37 tables, one bookkeeping row, lock free', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();

        const result = await migrate(executor, [init], { holder: 'contract-1' });

        expect(result.applied).toEqual([init.id]);
        expect(await countTables(executor)).toBe(37);
        expect(await countBookkeepingRows(executor)).toBe(1);
        expect(await lockHolder(executor)).toBeNull();
      });
    });

    it('2. a rerun skips the applied source without a batch call', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const counted = countCalls(executor);

        const result = await migrate(counted.executor, [init], { holder: 'contract-2' });

        expect(result.applied).toEqual([]);
        expect(result.skipped).toEqual([init.id]);
        expect(counted.counts().batch).toBe(0);
      });
    });

    it('3. an edited applied source rejects with MigrationChecksumError', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const edited = await loadMigrationSource(
          'core',
          '0001_init.sql',
          `${init.sql}\n-- edited\n`,
        );

        const error = await rejection(migrate(executor, [edited], { holder: 'contract-2' }));

        expect(error).toBeInstanceOf(MigrationChecksumError);
        expect((error as MigrationChecksumError).id).toBe(init.id);
        expect((error as MigrationChecksumError).stored).toBe(init.checksum);
        expect((error as MigrationChecksumError).computed).toBe(edited.checksum);
      });
    });

    it('4. reports an applied id this build does not ship, without an error', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        await executor.all({
          sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)',
          params: ['legacy:0042_gone', '0042_gone', '0'.repeat(64)],
        });

        const result = await migrate(executor, [init], { holder: 'contract-2' });

        expect(result.unknown).toEqual(['legacy:0042_gone']);
        expect(result.skipped).toEqual([init.id]);
      });
    });

    it('5. a failing pending source leaves no DDL, no bookkeeping row and a free lock', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const failing = await loadMigrationSource(
          'core',
          '0002_broken.sql',
          'CREATE TABLE broken (id INTEGER PRIMARY KEY);\nCREATE TABLE broken (id INTEGER PRIMARY KEY);\n',
        );

        const error = await rejection(migrate(executor, [init, failing], { holder: 'contract-2' }));

        expect(error).toBeInstanceOf(MigrationApplyError);
        expect(await countTables(executor)).toBe(37);
        expect(await countBookkeepingRows(executor)).toBe(1);
        expect(await lockHolder(executor)).toBeNull();
      });
    });

    it('6. a dry run on a fresh database writes nothing', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();

        const result = await migrate(executor, [init], { holder: 'contract-1', dryRun: true });

        expect(result.pending).toEqual([init.id]);
        expect(result.applied).toEqual([]);
        expect(await countTables(executor)).toBe(0);
      });
    });

    it('7. a dry run on an initialized database leaves a pending source unwritten', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();
        await migrate(executor, [init], { holder: 'contract-1' });
        const pending = await loadMigrationSource(
          'core',
          '0002_pending.sql',
          'CREATE TABLE pending_row (id INTEGER PRIMARY KEY);\n',
        );
        const bookkeepingBefore = await readBookkeeping(executor);
        const lockBefore = await readLock(executor);

        const result = await migrate(executor, [init, pending], {
          holder: 'contract-2',
          dryRun: true,
        });

        expect(result.pending).toEqual([pending.id]);
        expect(result.skipped).toEqual([init.id]);
        expect(await countTables(executor)).toBe(37);
        expect(await readBookkeeping(executor)).toEqual(bookkeepingBefore);
        expect(await readLock(executor)).toEqual(lockBefore);
      });
    });
    it('8. fresh 0001+0002+0003 with foreign keys on: three bookkeeping rows, new tables, lock free', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        const sources = await loadCore(all);

        const result = await migrate(executor, sources, { holder: 'contract-fresh' });

        expect(result.applied).toEqual(sources.map((source) => source.id));
        expect((await readBookkeeping(executor)).map((row) => row.checksum)).toEqual(
          sources.map((source) => source.checksum),
        );
        const names = await tableNames(executor);
        for (const table of NEW_TABLES) expect(names).toContain(table);
        expect(names).toHaveLength(37 + 2 + NEW_TABLES.length);
        expect(await lockHolder(executor)).toBeNull();
        expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        for (const table of ['token_project', 'service_principal_permission']) {
          expect(await count(executor, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
        }
      });
    });

    it('9. a populated 0001+0002 database upgrades to 0003 with every prior row intact', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(upTo0002), { holder: 'contract-populated' });
        await seedPopulated(executor);
        const columns = await snapshotColumns(executor);
        const before = await snapshot(executor, (table) => columns.get(table));
        const bookkeepingBefore = await readBookkeeping(executor);

        const result = await migrate(executor, await loadCore(all), { holder: 'contract-upgrade' });

        expect(result.applied).toEqual(['core:0003_access_model']);
        expect(result.skipped).toEqual(['core:0001_init', 'core:0002_local_login']);
        expect(await snapshot(executor, (table) => columns.get(table))).toEqual(before);
        expect((await readBookkeeping(executor)).slice(0, 2)).toEqual(bookkeepingBefore);
        expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        expect(await lockHolder(executor)).toBeNull();
        for (const table of REVISED_TABLES) {
          expect(
            await rows(executor, `SELECT DISTINCT revision, last_op_id FROM ${table}`),
            table,
          ).toEqual([{ revision: 1, last_op_id: null }]);
        }
      });
    });

    it('10. pre-existing tokens stay unusable: no authority rows, NULL validation origin, selected mode, no bindings invented', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(upTo0002), { holder: 'contract-populated' });
        await seedPopulated(executor);

        await migrate(executor, await loadCore(all), { holder: 'contract-upgrade' });

        expect(
          await rows(
            executor,
            'SELECT id, kind, project_mode, validation_kind, validation_identity_id, last_op_id FROM token ORDER BY id',
          ),
        ).toEqual(
          [
            [PAT_UNBOUND, 'pat'],
            [PAT_BOUND, 'pat'],
            [SVC_TOKEN, 'svc'],
          ].map(([id, kind]) => ({
            id,
            kind,
            project_mode: 'selected',
            validation_kind: null,
            validation_identity_id: null,
            last_op_id: null,
          })),
        );
        expect(
          await count(executor, 'SELECT count(*) AS n FROM service_principal_permission'),
        ).toBe(0);
        expect(await count(executor, 'SELECT count(*) AS n FROM identity_block')).toBe(0);
        expect(await count(executor, 'SELECT count(*) AS n FROM access_mutation_guard')).toBe(0);
        const unbound = await rows<{ id: string }>(
          executor,
          "SELECT t.id FROM token t WHERE t.project_mode = 'selected' AND NOT EXISTS (SELECT 1 FROM token_project b WHERE b.token_id = t.id) ORDER BY t.id",
        );
        expect(unbound.map((row) => row.id)).toEqual([PAT_UNBOUND, SVC_TOKEN]);
        const reachable = await rows<{ id: string; project_id: string }>(
          executor,
          "SELECT t.id, p.id AS project_id FROM token t JOIN project p ON p.org_id = t.org_id WHERE t.project_mode = 'selected' AND EXISTS (SELECT 1 FROM token_project b WHERE b.token_id = t.id AND b.project_id = p.id AND b.org_id = t.org_id) ORDER BY t.id",
        );
        expect(reachable).toEqual([{ id: PAT_BOUND, project_id: PROJECT }]);
        expect(
          await count(
            executor,
            `SELECT count(*) AS n FROM token WHERE id = '${PAT_UNBOUND}' AND (project_mode <> 'selected' OR project_id IS NOT NULL)`,
          ),
        ).toBe(0);
        expect(
          await rows(executor, 'SELECT token_id, project_id FROM token_project ORDER BY token_id'),
        ).toEqual([{ token_id: PAT_BOUND, project_id: PROJECT }]);
      });
    });

    it('11. the new constraints hold on the upgraded populated database', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(upTo0002), { holder: 'contract-populated' });
        await seedPopulated(executor);
        await migrate(executor, await loadCore(all), { holder: 'contract-upgrade' });
        await probeNewConstraints(executor);
      });
    });

    it('11b. the same constraints hold on a freshly migrated database', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(all), { holder: 'contract-fresh' });
        await seedPopulated(executor);
        await probeNewConstraints(executor);
      });
    });

    it('12. a failing 0003 statement on a populated database leaves no partial table or column', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(upTo0002), { holder: 'contract-populated' });
        await seedPopulated(executor);
        const columns = await snapshotColumns(executor);
        const before = await snapshot(executor, (table) => columns.get(table));
        const tablesBefore = await tableNames(executor);
        const bookkeepingBefore = await readBookkeeping(executor);
        const [real] = await loadCore((name) => name.startsWith('0003_'));
        if (real === undefined) throw new Error('0003_access_model.sql is missing');
        const broken = await loadMigrationSource(
          'core',
          '0003_access_model.sql',
          `${real.sql}\nCREATE TABL broken (id INTEGER);\n`,
        );

        const error = await rejection(
          migrate(executor, [...(await loadCore(upTo0002)), broken], {
            holder: 'contract-failing',
          }),
        );

        expect(error).toBeInstanceOf(MigrationApplyError);
        expect(await tableNames(executor)).toEqual(tablesBefore);
        for (const table of NEW_TABLES) expect(await tableNames(executor)).not.toContain(table);
        expect(await columnNames(executor, 'token')).not.toContain('project_mode');
        expect(await columnNames(executor, 'project')).not.toContain('revision');
        expect(await snapshot(executor, (table) => columns.get(table))).toEqual(before);
        expect(await readBookkeeping(executor)).toEqual(bookkeepingBefore);
        expect(await lockHolder(executor)).toBeNull();

        const retry = await migrate(executor, await loadCore(all), { holder: 'contract-retry' });
        expect(retry.applied).toEqual(['core:0003_access_model']);
      });
    });

    it('13. organization/admin bootstrap on the populated upgrade seeds the whole catalogue idempotently', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await loadCore(upTo0002), { holder: 'contract-populated' });
        await seedPopulated(executor);
        await migrate(executor, await loadCore(all), { holder: 'contract-upgrade' });
        const catalogue = PERMISSIONS.map(({ name }) => name).sort();
        expect(await permissionsOf(executor, ROLE_IDS.organization_admin)).toEqual(
          [...PRE_0003_ADMIN_PERMISSIONS].sort(),
        );
        const input = {
          email: 'admin@example.test',
          userId: '01J0USER000000000000000001',
          setupHash: 'c'.repeat(64),
          setupExpiresAt: SETUP_EXPIRES,
          grantId: '01J0GRNT000000000000000001',
          roleIds: ROLE_IDS,
          opId: '01J0OP00000000000000000001',
          now: NOW,
        };

        expect(await bootstrapAdmin(executor, orgContext(ORG), input)).toBe('created');

        expect(await permissionsOf(executor, ROLE_IDS.organization_admin)).toEqual(catalogue);
        const rolesAfterFirst = await rows(
          executor,
          'SELECT id, key, is_system, protects_last_holder, revision FROM role ORDER BY id',
        );
        const permissionRows = await count(executor, 'SELECT count(*) AS n FROM role_permission');
        for (const defaults of DEFAULT_ROLES) {
          expect(await permissionsOf(executor, ROLE_IDS[defaults.key]), defaults.key).toEqual(
            [...defaults.permissions].sort(),
          );
        }

        await bootstrapAdmin(executor, orgContext(ORG), {
          ...input,
          setupHash: 'd'.repeat(64),
          opId: '01J0OP00000000000000000002',
        });

        expect(await permissionsOf(executor, ROLE_IDS.organization_admin)).toEqual(catalogue);
        expect(await count(executor, 'SELECT count(*) AS n FROM role_permission')).toBe(
          permissionRows,
        );
        expect(
          await rows(
            executor,
            'SELECT id, key, is_system, protects_last_holder, revision FROM role ORDER BY id',
          ),
        ).toEqual(rolesAfterFirst);
        expect(
          await count(
            executor,
            "SELECT count(*) AS n FROM access_grant WHERE subject_value = 'admin@example.test'",
          ),
        ).toBe(1);
        expect(
          await count(executor, 'SELECT count(*) AS n FROM service_principal_permission'),
        ).toBe(0);
      });
    });
  });
}
