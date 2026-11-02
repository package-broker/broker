import { readFileSync } from 'node:fs';
import { discoveredMigrations } from '../testing/migrated-database.js';
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
import { scanSql } from '../sql/scan.js';
import { countCalls } from './count-calls.js';
import type { OpenedExecutor } from './executor-contract.js';
import { describeOrgKeyContract } from './org-key-contract.js';

export { describeNpmIdentityMigrationContract } from './npm-identity-migration-contract.js';

export { describeNpmPublishMigrationContract } from './npm-publish-migration-contract.js';

export interface OpenedPair extends OpenedExecutor {
  second(): Promise<ScalarSqlExecutor>;
}

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
  organization_publisher: '01J0ROLE000000000000000015',
  organization_admin: '01J0ROLE000000000000000010',
  organization_auditor: '01J0ROLE000000000000000011',
  project_owner: '01J0ROLE000000000000000012',
  project_developer: '01J0ROLE000000000000000013',
  project_auditor: '01J0ROLE000000000000000014',
};

const NEW_TABLES = ['access_mutation_guard', 'identity_block', 'service_principal_permission'];
const REVISED_TABLES = ['role', 'access_grant', 'project', 'service_principal'];
const PARTIAL_ADMIN_PERMISSIONS = [
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
    ['INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)', [ORG, 'initial']],
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
    ...PARTIAL_ADMIN_PERMISSIONS.map((permission): [string, ScalarSqlValue[]] => [
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
    await rows(
      executor,
      'SELECT org_id, user_id, validation_kind, validation_identity_id FROM token WHERE id = ?',
      [PAT_BOUND],
    ),
  ).toEqual([{ org_id: ORG, user_id: USER, validation_kind: 'sso', validation_identity_id: null }]);
  await run(executor, 'UPDATE token SET revoked_at = ? WHERE kind = ?', [NOW, 'svc']);
  await run(executor, 'DELETE FROM token WHERE kind = ?', ['svc']);
  await run(executor, 'DELETE FROM service_principal WHERE id = ?', [PRINCIPAL]);
  expect(await count(executor, 'SELECT count(*) AS n FROM service_principal_permission')).toBe(0);
}

const JOB_QUEUED = '01J0JOB0000000000000000000';
const JOB_RUNNING = '01J0JOB0000000000000000001';
const BLOB_FRESH = '01J0BLOB000000000000000002';
const LEASE_UNTIL = '2026-10-16T09:05:00.000Z';
const ATTEMPT_OUTCOMES = ['running', 'succeeded', 'failed', 'lease_expired', 'released'];
const EXPECTED_BLOB_INDEXES = ['blob_digest', 'blob_idle', 'blob_purge', 'blob_storage_key'];

async function seedJob(
  executor: ScalarSqlExecutor,
  job: { readonly id: string; readonly state: string; readonly key: string },
): Promise<void> {
  await run(
    executor,
    `INSERT INTO job (id, org_id, type, payload_json, resource_key, idempotency_key, state, attempts, max_attempts,
       lease_owner, lease_until, fence, run_at, last_error, finished_at, created_at, updated_at)
     VALUES (?, ?, 'sync', '{"a":1}', ?, ?, ?, 2, 5, 'worker-1', ?, 2, ?, 'boom', ?, ?, ?)`,
    [job.id, ORG, job.key, job.key, job.state, LEASE_UNTIL, NOW, NOW, NOW, NOW],
  );
}

async function seedAttempt(
  executor: ScalarSqlExecutor,
  attempt: {
    readonly id: string;
    readonly job: string;
    readonly fence: number;
    readonly outcome: string;
  },
): Promise<void> {
  await run(
    executor,
    `INSERT INTO job_attempt (id, org_id, job_id, attempt, fence, worker, outcome, error, started_at, finished_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, 'worker-1', ?, 'E_BOOM', ?, ?, ?)`,
    [attempt.id, ORG, attempt.job, attempt.fence, attempt.fence, attempt.outcome, NOW, NOW, NOW],
  );
}

async function seedBlob(
  executor: ScalarSqlExecutor,
  id: string,
  columns: Readonly<Record<string, ScalarSqlValue>>,
): Promise<void> {
  const values: Record<string, ScalarSqlValue> = {
    id,
    org_id: ORG,
    sha256: id
      .slice(-1)
      .repeat(64)
      .replace(/[^0-9a-f]/g, 'c'),
    size_bytes: 10,
    storage_key: `blobs/${id}`,
    ...columns,
  };
  const names = Object.keys(values);
  await run(
    executor,
    `INSERT INTO blob (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

async function tableInfo(
  executor: ScalarSqlExecutor,
  table: string,
  column: string,
): Promise<unknown[]> {
  return rows(
    executor,
    `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}') WHERE name = ?`,
    [column],
  );
}

async function attemptShape(executor: ScalarSqlExecutor): Promise<Record<string, unknown[]>> {
  return {
    columns: await rows(
      executor,
      'SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(\'job_attempt\') ORDER BY cid',
    ),
    foreignKeys: await rows(
      executor,
      'SELECT "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(\'job_attempt\') ORDER BY "from"',
    ),
    indexes: await rows(
      executor,
      'SELECT name, "unique", origin, partial FROM pragma_index_list(\'job_attempt\') ORDER BY name',
    ),
    strict: await rows(executor, "SELECT strict FROM pragma_table_list('job_attempt')"),
  };
}

async function indexNames(executor: ScalarSqlExecutor, table: string): Promise<string[]> {
  const found = await rows<{ name: string }>(
    executor,
    `SELECT name FROM pragma_index_list('${table}') WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
  );
  return found.map((row) => row.name);
}

export function describeMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
  core0001: () => Promise<MigrationSource>,
): void {
  describe(`migration contract: ${name}`, () => {
    it('1. applies the real 0001_init.sql: 56 tables, one bookkeeping row, lock free', async () => {
      await withPair(open, async ({ executor }) => {
        const init = await core0001();

        const result = await migrate(executor, [init], { holder: 'contract-1' });

        expect(result.applied).toEqual([init.id]);
        expect(await countTables(executor)).toBe(56);
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
        expect(await countTables(executor)).toBe(56);
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
        expect(await countTables(executor)).toBe(56);
        expect(await readBookkeeping(executor)).toEqual(bookkeepingBefore);
        expect(await readLock(executor)).toEqual(lockBefore);
      });
    });
    it('8. fresh schema with foreign keys on: five bookkeeping rows, all tables, lock free', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        const sources = await discoveredMigrations();

        const result = await migrate(executor, sources, { holder: 'contract-fresh' });

        expect(result.applied).toEqual(sources.map((source) => source.id));
        expect((await readBookkeeping(executor)).map((row) => row.checksum)).toEqual(
          sources.map((source) => source.checksum),
        );
        const names = await tableNames(executor);
        for (const table of NEW_TABLES) expect(names).toContain(table);
        expect(names).toHaveLength(62);
        expect(await lockHolder(executor)).toBeNull();
        expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        for (const table of ['token_project', 'service_principal_permission']) {
          expect(await count(executor, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
        }
      });
    });

    it('10. tokens default to no authority: no authority rows, NULL validation origin, selected mode, no bindings invented', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-populated' });
        await seedPopulated(executor);

        await migrate(executor, await discoveredMigrations(), { holder: 'contract-upgrade' });

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

    it('11. the constraints hold on the populated baseline', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-populated' });
        await seedPopulated(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-upgrade' });
        await probeNewConstraints(executor);
      });
    });

    it('11b. the same constraints hold on a freshly migrated database', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-fresh' });
        await seedPopulated(executor);
        await probeNewConstraints(executor);
      });
    });

    it('13. organization/admin bootstrap on the baseline seeds the whole catalogue idempotently', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-populated' });
        await seedPopulated(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-upgrade' });
        const catalogue = PERMISSIONS.map(({ name }) => name).sort();
        expect(await permissionsOf(executor, ROLE_IDS.organization_admin)).toEqual(
          [...PARTIAL_ADMIN_PERMISSIONS].sort(),
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

    it('16. a fresh database creates no role and no permission row', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);

        const result = await migrate(executor, await discoveredMigrations(), {
          holder: 'contract-fresh',
        });

        expect(result.applied).toEqual([
          'core:0001_init',
          'core:0002_npm_publish',
          'core:0003_npm_identity',
          'core:0004_source_revision',
          'core:0005_package_settings_revision',
          'core:0006_npm_login_handoff',
        ]);
        expect(await count(executor, 'SELECT count(*) AS n FROM role')).toBe(0);
        expect(await count(executor, 'SELECT count(*) AS n FROM role_permission')).toBe(0);
      });
    });

    it('17. baseline: job provenance columns, the released attempt outcome, a cascading leaf table and the blob purge columns', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        const result = await migrate(executor, await discoveredMigrations(), {
          holder: 'contract-fresh',
        });
        expect(result.applied).toEqual([
          'core:0001_init',
          'core:0002_npm_publish',
          'core:0003_npm_identity',
          'core:0004_source_revision',
          'core:0005_package_settings_revision',
          'core:0006_npm_login_handoff',
        ]);
        expect((await attemptShape(executor)).strict).toEqual([{ strict: 1 }]);
        expect(await tableInfo(executor, 'job', 'project_id')).toEqual([
          { name: 'project_id', type: 'TEXT', notnull: 0, dflt_value: null },
        ]);
        expect(await tableInfo(executor, 'job', 'initiator_token_id')).toEqual([
          { name: 'initiator_token_id', type: 'TEXT', notnull: 0, dflt_value: null },
        ]);
        expect(
          await rows(
            executor,
            'SELECT "from", "table", "to" FROM pragma_foreign_key_list(\'job\') ORDER BY "from"',
          ),
        ).toEqual([
          { from: 'org_id', table: 'organization', to: 'id' },
          { from: 'project_id', table: 'project', to: 'id' },
        ]);
        expect(await tableNames(executor)).not.toContain('job_attempt_0006');
        expect(await countTables(executor)).toBe(62);
        expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);

        await seedPopulated(executor);
        await seedJob(executor, { id: JOB_QUEUED, state: 'queued', key: 'k-queued' });
        for (const [index, outcome] of ATTEMPT_OUTCOMES.entries()) {
          await run(executor, 'DELETE FROM job_attempt');
          await seedAttempt(executor, {
            id: `01J0ATT000000000000000000${index}`,
            job: JOB_QUEUED,
            fence: 1,
            outcome,
          });
        }
        await run(executor, 'DELETE FROM job_attempt');
        for (const outcome of ['dead', 'bogus']) {
          const error = await rejection(
            seedAttempt(executor, {
              id: '01J0ATT0000000000000000009',
              job: JOB_QUEUED,
              fence: 1,
              outcome,
            }),
          );
          expect(String((error as Error).message), outcome).toMatch(/CHECK/i);
        }
        await seedAttempt(executor, {
          id: '01J0ATT0000000000000000000',
          job: JOB_QUEUED,
          fence: 1,
          outcome: 'released',
        });
        const duplicate = await rejection(
          seedAttempt(executor, {
            id: '01J0ATT0000000000000000001',
            job: JOB_QUEUED,
            fence: 1,
            outcome: 'running',
          }),
        );
        expect(String((duplicate as Error).message)).toMatch(/UNIQUE|job_attempt_fence/i);
        await run(executor, 'DELETE FROM job WHERE id = ?', [JOB_QUEUED]);
        expect(await count(executor, 'SELECT count(*) AS n FROM job_attempt')).toBe(0);
        expect(await lockHolder(executor)).toBeNull();

        expect(await tableInfo(executor, 'blob', 'purge_generation')).toEqual([
          { name: 'purge_generation', type: 'TEXT', notnull: 0, dflt_value: null },
        ]);
        expect(await tableInfo(executor, 'blob', 'purge_lease_until')).toEqual([
          { name: 'purge_lease_until', type: 'TEXT', notnull: 0, dflt_value: null },
        ]);
        const blobColumns = await columnNames(executor, 'blob');
        expect(blobColumns.slice(-3)).toEqual([
          'purge_generation',
          'purge_lease_until',
          'published_at',
        ]);
        expect(await indexNames(executor, 'blob')).toEqual(EXPECTED_BLOB_INDEXES);
        await seedBlob(executor, BLOB_FRESH, {});
        expect(
          await rows(
            executor,
            'SELECT purge_generation, purge_lease_until FROM blob WHERE id = ?',
            [BLOB_FRESH],
          ),
        ).toEqual([{ purge_generation: null, purge_lease_until: null }]);
        await run(
          executor,
          "UPDATE blob SET purge_generation = lower(hex(randomblob(16))), purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+900 seconds') WHERE id = ?",
          [BLOB_FRESH],
        );
        const [lease] = await rows<{ generation: string; live: number }>(
          executor,
          "SELECT purge_generation AS generation, purge_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS live FROM blob WHERE id = ?",
          [BLOB_FRESH],
        );
        expect(lease?.generation).toMatch(/^[0-9a-f]{32}$/);
        expect(lease?.live).toBe(1);
      });
    });

    it('20. job.project_id is a foreign key; job.initiator_token_id survives the token it names', async () => {
      await withPair(open, async ({ executor }) => {
        await enableForeignKeys(executor);
        await migrate(executor, await discoveredMigrations(), { holder: 'contract-fresh' });
        await seedPopulated(executor);
        const insertJob = (id: string, project: string | null, token: string | null) =>
          run(
            executor,
            "INSERT INTO job (id, org_id, type, project_id, initiator_token_id) VALUES (?, ?, 'sync', ?, ?)",
            [id, ORG, project, token],
          );

        const missing = await rejection(insertJob(JOB_QUEUED, 'no-such-project', null));
        expect(String((missing as Error).message)).toMatch(/FOREIGN KEY/i);
        await insertJob(JOB_RUNNING, PROJECT, PAT_UNBOUND);
        await run(executor, 'DELETE FROM token WHERE id = ?', [PAT_UNBOUND]);

        expect(await rows(executor, 'SELECT id, project_id, initiator_token_id FROM job')).toEqual([
          { id: JOB_RUNNING, project_id: PROJECT, initiator_token_id: PAT_UNBOUND },
        ]);
        expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
      });
    });

    it.each([
      { mismatch: 'user', operation: 'INSERT' },
      { mismatch: 'org', operation: 'INSERT' },
      { mismatch: 'user', operation: 'UPDATE' },
      { mismatch: 'org', operation: 'UPDATE' },
    ])(
      'session $operation rejects an identity from another $mismatch',
      async ({ mismatch, operation }) => {
        await withPair(open, async ({ executor }) => {
          await enableForeignKeys(executor);
          await migrate(executor, [await core0001()], { holder: 'session-identity' });
          await seedPopulated(executor);
          await run(executor, 'DROP INDEX organization_singleton');
          await run(executor, 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
            OTHER_ORG,
            'other',
            'Other',
          ]);
          await run(executor, 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
            'other-user',
            ORG,
            'other@example.test',
          ]);
          await run(
            executor,
            'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
            [
              'other-identity',
              mismatch === 'org' ? OTHER_ORG : ORG,
              mismatch === 'user' ? 'other-user' : USER,
              'dex',
              'other-subject',
              'other@example.test',
            ],
          );
          const insert = (identity: string | null) =>
            run(
              executor,
              'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              ['session', ORG, USER, identity, HASH_64, HASH_64, EXPIRY],
            );
          if (operation === 'UPDATE') await insert(IDENTITY);

          await expect(
            operation === 'INSERT'
              ? insert('other-identity')
              : run(executor, 'UPDATE session SET identity_id = ? WHERE org_id = ? AND id = ?', [
                  'other-identity',
                  ORG,
                  'session',
                ]),
          ).rejects.toMatchObject({ kind: 'foreign_key' });
          expect(
            await rows(executor, 'SELECT identity_id FROM session WHERE org_id = ?', [ORG]),
          ).toEqual(operation === 'INSERT' ? [] : [{ identity_id: IDENTITY }]);
          expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        });
      },
    );

    it.each([null, IDENTITY])(
      'session accepts its own identity or local login: %s',
      async (identity) => {
        await withPair(open, async ({ executor }) => {
          await enableForeignKeys(executor);
          await migrate(executor, [await core0001()], { holder: 'session-identity' });
          await seedPopulated(executor);
          await run(
            executor,
            'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['session', ORG, USER, identity, HASH_64, HASH_64, EXPIRY],
          );
          expect(
            await rows(executor, 'SELECT identity_id FROM session WHERE org_id = ?', [ORG]),
          ).toEqual([{ identity_id: identity }]);
          expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        });
      },
    );

    it.each([
      { mismatch: 'user', operation: 'INSERT' },
      { mismatch: 'org', operation: 'INSERT' },
      { mismatch: 'user', operation: 'UPDATE' },
      { mismatch: 'org', operation: 'UPDATE' },
    ])(
      'token $operation rejects an identity from another $mismatch',
      async ({ mismatch, operation }) => {
        await withPair(open, async ({ executor }) => {
          await enableForeignKeys(executor);
          await migrate(executor, [await core0001()], { holder: 'token-identity' });
          await seedPopulated(executor);
          await run(executor, 'DROP INDEX organization_singleton');
          await run(executor, 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
            OTHER_ORG,
            'other',
            'Other',
          ]);
          await run(executor, 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
            'other-user',
            ORG,
            'other@example.test',
          ]);
          await run(
            executor,
            'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
            [
              'other-identity',
              mismatch === 'org' ? OTHER_ORG : ORG,
              mismatch === 'user' ? 'other-user' : USER,
              'dex',
              'other-subject',
              'other@example.test',
            ],
          );
          const insert = (identity: string | null) =>
            insertToken(executor, 'identity-token', {
              validation_kind: 'sso',
              validation_identity_id: identity,
            });
          if (operation === 'UPDATE') await insert(IDENTITY);

          await expect(
            operation === 'INSERT'
              ? insert('other-identity')
              : run(
                  executor,
                  'UPDATE token SET validation_identity_id = ? WHERE org_id = ? AND id = ?',
                  ['other-identity', ORG, 'identity-token'],
                ),
          ).rejects.toMatchObject({ kind: 'foreign_key' });
          expect(
            await rows(
              executor,
              'SELECT validation_identity_id FROM token WHERE org_id = ? AND id = ?',
              [ORG, 'identity-token'],
            ),
          ).toEqual(operation === 'INSERT' ? [] : [{ validation_identity_id: IDENTITY }]);
          expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        });
      },
    );

    it.each([null, IDENTITY])(
      'token accepts its own identity or a null validation identity: %s',
      async (identity) => {
        await withPair(open, async ({ executor }) => {
          await enableForeignKeys(executor);
          await migrate(executor, [await core0001()], { holder: 'token-identity' });
          await seedPopulated(executor);
          await insertToken(executor, 'identity-token', {
            validation_kind: 'sso',
            validation_identity_id: identity,
          });
          expect(
            await rows(
              executor,
              'SELECT validation_identity_id FROM token WHERE org_id = ? AND id = ?',
              [ORG, 'identity-token'],
            ),
          ).toEqual([{ validation_identity_id: identity }]);
          expect(await rows(executor, 'PRAGMA foreign_key_check')).toEqual([]);
        });
      },
    );
  });

  describeOrgKeyContract(name, open);
}

/** Production drivers exercise vulnerability tables on the fresh baseline. */
export function describeVulnerabilityMigrationContract(
  name: string,
  open: () => Promise<OpenedPair>,
): void {
  describe(`vulnerability migration: ${name}`, () => {
    it('creates all five tables and org composite foreign keys', async () => {
      await withPair(open, async ({ executor }) => {
        const all = await discoveredMigrations();
        const migrated = await migrate(executor, all, { holder: 'vulnerability-migration' });
        expect(migrated.applied).toEqual([
          'core:0001_init',
          'core:0002_npm_publish',
          'core:0003_npm_identity',
          'core:0004_source_revision',
          'core:0005_package_settings_revision',
          'core:0006_npm_login_handoff',
        ]);
        expect(
          await executor.all({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,14) = 'vulnerability_' ORDER BY name",
            params: [],
          }),
        ).toEqual(
          ['advisory', 'match', 'refresh', 'result', 'sync_state'].map((s) => ({
            name: `vulnerability_${s}`,
          })),
        );
        const fks = await executor.all<{
          id: number;
          seq: number;
          from: string;
          to: string;
          table: string;
        }>({ sql: "PRAGMA foreign_key_list('vulnerability_result')", params: [] });
        for (const parent of ['version', 'package']) {
          const links = fks.filter((f) => f.table === parent);
          expect(links.map((f) => [f.from, f.to]).sort()).toEqual(
            [
              ['org_id', 'org_id'],
              [`${parent}_id`, 'id'],
            ].sort(),
          );
        }
        expect(await executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual([]);
      });
    });
  });
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface IndexRow {
  readonly tbl_name: string;
  readonly seq: number;
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface SchemaDump {
  readonly schema: readonly SchemaRow[];
  readonly indexes: readonly IndexRow[];
}

function normalizedDump(dump: SchemaDump): string {
  return JSON.stringify({
    schema: dump.schema.map((row) => ({
      ...row,
      // SQLite quotes names after ALTER TABLE RENAME and preserves DDL formatting.
      // Keep string literals byte-exact while normalizing identifier quotes and SQL spacing.
      sql:
        row.sql === null
          ? null
          : scanSql(row.sql)
              .filter((segment) => segment.kind !== 'comment')
              .flatMap((segment) => {
                if (segment.kind === 'string') return [segment.text];
                if (segment.kind === 'identifier') return [segment.text.slice(1, -1)];
                return segment.text.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g) ?? [];
              }),
    })),
    indexes: dump.indexes,
  });
}

export function describeSchemaEquivalenceContract(
  name: string,
  open: () => Promise<OpenedExecutor>,
): void {
  describe(`baseline schema equivalence: ${name}`, () => {
    it('matches the recorded schema including npm publish and identity and per-table index order', async () => {
      const oldChain = JSON.parse(
        readFileSync(new URL('../migrations/old-chain-schema.json', import.meta.url), 'utf8'),
      ) as SchemaDump;
      const sources = (await discoveredMigrations()).filter((source) => source.sequence <= 4);
      expect(sources.map(({ id, phase }) => ({ id, phase }))).toEqual([
        { id: 'core:0001_init', phase: 'expand' },
        { id: 'core:0002_npm_publish', phase: 'expand' },
        { id: 'core:0003_npm_identity', phase: 'expand' },
        { id: 'core:0004_source_revision', phase: 'expand' },
      ]);
      const opened = await open();
      try {
        await migrate(opened.executor, sources, { holder: 'schema-equivalence' });
        // D1 owns _cf_ metadata tables; they are not part of the broker schema.
        const schema = await opened.executor.all<SchemaRow>({
          sql: "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY type, name",
          params: [],
        });
        const indexes = await opened.executor.all<IndexRow>({
          sql: `SELECT s.name AS tbl_name, i.seq, i.name, i."unique", i.origin, i.partial
                FROM sqlite_schema s JOIN pragma_index_list(s.name) i
                WHERE s.type = 'table' AND substr(s.name, 1, 7) <> 'sqlite_' AND substr(s.name, 1, 4) <> '_cf_'
                ORDER BY s.name, i.seq`,
          params: [],
        });
        const expected: SchemaDump = {
          ...oldChain,
          schema: oldChain.schema.map((row) =>
            row.type === 'table' && row.name === 'source'
              ? {
                  ...row,
                  sql: row.sql!.replace(
                    ',\n  CHECK ((last_refusal_at',
                    ', revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),\n  CHECK ((last_refusal_at',
                  ),
                }
              : row,
          ),
        };
        expect(normalizedDump({ schema, indexes })).toBe(normalizedDump(expected));
        expect(await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).toEqual(
          [],
        );
      } finally {
        await opened.close();
      }
    });
  });
}
