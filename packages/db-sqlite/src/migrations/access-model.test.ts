import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlValue } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource, type MigrationSource } from './source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);

async function loadCore(): Promise<MigrationSource[]> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

const ORG = '01J0ACME000000000000000000';
const OTHER_ORG = '01J0ACME000000000000000001';
const MISSING_PRINCIPAL = '01J0SVCP000000000000000009';
const USER = '01J0USER000000000000000000';
const IDENTITY = '01J0IDEN000000000000000000';
const PRINCIPAL = '01J0SVCP000000000000000000';
const PROJECT = '01J0PROJ000000000000000000';
const ROLE = '01J0ROLE000000000000000000';
const GRANT = '01J0GRNT000000000000000000';
const TOKEN = '01J0TOKN000000000000000000';
const HASH_64 = 'a'.repeat(64);
const EXPIRY = '2027-10-16T09:00:00.000Z';

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

async function dbErrorKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) return error.kind;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

async function migrateAll(): Promise<void> {
  await migrate(opened.executor, await loadCore(), { holder: 'access-model-test' });
}

async function seedBase(): Promise<void> {
  await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [ORG, 'acme', 'Acme']);
  await run('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
    USER,
    ORG,
    'admin@example.test',
  ]);
  await run(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
    [IDENTITY, ORG, USER, 'dex', 'subject-1', 'admin@example.test'],
  );
  await run('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    PROJECT,
    ORG,
    'web',
    'Web',
  ]);
  await run('INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)', [
    ROLE,
    ORG,
    'reader',
    'Reader',
    'project',
  ]);
  await run(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [GRANT, ORG, 'email', 'dev@example.test', 'project', PROJECT, ROLE],
  );
  await run(
    'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
    [PRINCIPAL, ORG, 'ci', USER],
  );
  await run(
    'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [TOKEN, ORG, 'pat', 'abcdefghijkl', HASH_64, 1, 'laptop', '[]', USER, EXPIRY],
  );
}

async function insertToken(id: string, columns: Record<string, SqlValue>): Promise<void> {
  const values: Record<string, SqlValue> = {
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
    `INSERT INTO token (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

interface TableInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function columnsOf(table: string): Promise<Map<string, TableInfo>> {
  const found = await rows<TableInfo>(`SELECT * FROM pragma_table_info('${table}')`);
  return new Map(found.map((column) => [column.name, column]));
}

describe('access model baseline', () => {
  describe('schema shape', () => {
    beforeEach(migrateAll);

    it('3: revision and last_op_id exist on role, access_grant, project and service_principal', async () => {
      for (const table of ['role', 'access_grant', 'project', 'service_principal']) {
        const columns = await columnsOf(table);
        const revision = columns.get('revision');
        expect(revision?.type, table).toBe('INTEGER');
        expect(revision?.notnull, table).toBe(1);
        expect(revision?.dflt_value, table).toBe('1');
        const lastOp = columns.get('last_op_id');
        expect(lastOp?.type, table).toBe('TEXT');
        expect(lastOp?.notnull, table).toBe(0);
      }
    });

    it('4: token gains project_mode, validation_kind, validation_identity_id and last_op_id', async () => {
      const columns = await columnsOf('token');
      expect(columns.get('project_mode')).toMatchObject({ notnull: 1, dflt_value: "'selected'" });
      expect(columns.get('validation_kind')).toMatchObject({ notnull: 0, dflt_value: null });
      expect(columns.get('validation_identity_id')).toMatchObject({ notnull: 0 });
      expect(columns.get('last_op_id')).toMatchObject({ notnull: 0 });
      const keys = await rows<{ table: string; from: string; on_delete: string }>(
        'SELECT "table", "from", on_delete FROM pragma_foreign_key_list(\'token\') WHERE "from" = \'validation_identity_id\'',
      );
      expect(keys).toEqual([
        { table: 'identity', from: 'validation_identity_id', on_delete: 'SET NULL' },
      ]);
    });

    it('5: the new tables are STRICT and WITHOUT ROWID where stated, with the stated keys', async () => {
      const flags = await rows<{ name: string; wr: number; strict: number }>(
        "SELECT name, wr, strict FROM pragma_table_list WHERE name IN ('service_principal_permission', 'identity_block', 'access_mutation_guard') ORDER BY name",
      );
      expect(flags).toEqual([
        { name: 'access_mutation_guard', wr: 0, strict: 1 },
        { name: 'identity_block', wr: 1, strict: 1 },
        { name: 'service_principal_permission', wr: 1, strict: 1 },
      ]);
      const pk = async (table: string): Promise<string[]> =>
        (
          await rows<{ name: string; pk: number }>(
            `SELECT name, pk FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`,
          )
        ).map((row) => row.name);
      expect(await pk('service_principal_permission')).toEqual([
        'org_id',
        'service_principal_id',
        'permission',
      ]);
      expect(await pk('identity_block')).toEqual(['org_id', 'provider', 'issuer', 'subject']);
      expect(await pk('access_mutation_guard')).toEqual(['key']);
    });

    it('6: service_principal_permission has a composite cascading FK to service_principal(org_id, id)', async () => {
      const keys = await rows<{ table: string; from: string; to: string; on_delete: string }>(
        'SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(\'service_principal_permission\') WHERE "table" = \'service_principal\' ORDER BY seq',
      );
      expect(keys).toEqual([
        { table: 'service_principal', from: 'org_id', to: 'org_id', on_delete: 'CASCADE' },
        {
          table: 'service_principal',
          from: 'service_principal_id',
          to: 'id',
          on_delete: 'CASCADE',
        },
      ]);
    });

    it('7: the new indexes exist and token_validation_identity is partial', async () => {
      const found = await rows<{ name: string; partial: number }>(
        "SELECT name, \"partial\" FROM pragma_index_list('token') WHERE name = 'token_validation_identity' UNION ALL SELECT name, \"partial\" FROM pragma_index_list('token') WHERE name = 'token_user' UNION ALL SELECT name, \"partial\" FROM pragma_index_list('token_project') WHERE name = 'token_project_project' UNION ALL SELECT name, \"partial\" FROM pragma_index_list('service_principal') WHERE name = 'service_principal_project'",
      );
      expect(Object.fromEntries(found.map((row) => [row.name, row.partial]))).toEqual({
        token_validation_identity: 1,
        token_user: 0,
        token_project_project: 0,
        service_principal_project: 0,
      });
    });

    it('8: foreign key enforcement is on', async () => {
      const [state] = await rows<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(state?.foreign_keys).toBe(1);
    });
  });

  describe('token defaults', () => {
    it('9: a PAT gets NULL validation_kind and project_mode selected, and no service permission rows appear', async () => {
      await migrateAll();
      await seedBase();

      await migrateAll();

      expect(
        await rows(
          'SELECT project_mode, validation_kind, validation_identity_id, last_op_id FROM token WHERE id = ?',
          [TOKEN],
        ),
      ).toEqual([
        {
          project_mode: 'selected',
          validation_kind: null,
          validation_identity_id: null,
          last_op_id: null,
        },
      ]);
      expect(await rows('SELECT count(*) AS n FROM service_principal_permission')).toEqual([
        { n: 0 },
      ]);
      expect(await rows('SELECT count(*) AS n FROM identity_block')).toEqual([{ n: 0 }]);
      expect(await rows('SELECT count(*) AS n FROM access_mutation_guard')).toEqual([{ n: 0 }]);
      for (const [table, id] of [
        ['role', ROLE],
        ['access_grant', GRANT],
        ['project', PROJECT],
        ['service_principal', PRINCIPAL],
      ] as const) {
        expect(await rows(`SELECT revision, last_op_id FROM ${table} WHERE id = ?`, [id])).toEqual([
          { revision: 1, last_op_id: null },
        ]);
      }
    });
  });

  describe('constraints', () => {
    beforeEach(async () => {
      await migrateAll();
      await seedBase();
    });

    it('10: revision below 1 fails with kind check on all four tables', async () => {
      for (const [table, id] of [
        ['role', ROLE],
        ['access_grant', GRANT],
        ['project', PROJECT],
        ['service_principal', PRINCIPAL],
      ] as const) {
        expect(
          await dbErrorKind(run(`UPDATE ${table} SET revision = 0 WHERE id = ?`, [id])),
          table,
        ).toBe('check');
      }
    });

    it('11: project_mode accepts all and selected and refuses other values and NULL', async () => {
      await insertToken('01J0TOKN00000000000AAAAA', { project_mode: 'all' });
      await insertToken('01J0TOKN00000000000BBBBB', { project_mode: 'selected' });
      expect(
        await dbErrorKind(insertToken('01J0TOKN00000000000CCCCC', { project_mode: 'some' })),
      ).toBe('check');
      expect(
        await dbErrorKind(insertToken('01J0TOKN00000000000DDDDD', { project_mode: null })),
      ).toBe('not_null');
    });

    it('12: validation_kind accepts sso and local and refuses other values', async () => {
      await insertToken('01J0TOKN00000000000AAAAA', {
        validation_kind: 'sso',
        validation_identity_id: IDENTITY,
      });
      await insertToken('01J0TOKN00000000000BBBBB', { validation_kind: 'local' });
      expect(
        await dbErrorKind(insertToken('01J0TOKN00000000000CCCCC', { validation_kind: 'mfa' })),
      ).toBe('check');
    });

    it('13: validation_kind local with a non-NULL identity fails with kind check', async () => {
      expect(
        await dbErrorKind(
          insertToken('01J0TOKN00000000000AAAAA', {
            validation_kind: 'local',
            validation_identity_id: IDENTITY,
          }),
        ),
      ).toBe('check');
      expect(
        await dbErrorKind(
          run('UPDATE token SET validation_kind = ?, validation_identity_id = ? WHERE id = ?', [
            'local',
            IDENTITY,
            TOKEN,
          ]),
        ),
      ).toBe('check');
    });

    it('13b: validation_kind and validation_identity_id are refused on service and customer tokens', async () => {
      const svc = {
        kind: 'svc',
        user_id: null,
        service_principal_id: PRINCIPAL,
        expires_at: EXPIRY,
      };
      await insertToken('01J0TOKN00000000000AAAAA', svc);
      for (const columns of [
        { validation_kind: 'sso' },
        { validation_kind: 'local' },
        { validation_identity_id: IDENTITY },
      ]) {
        expect(
          await dbErrorKind(insertToken('01J0TOKN00000000000BBBBB', { ...svc, ...columns })),
        ).toBe('check');
      }
      expect(
        await dbErrorKind(
          run('UPDATE token SET validation_kind = ? WHERE id = ?', [
            'sso',
            '01J0TOKN00000000000AAAAA',
          ]),
        ),
      ).toBe('check');
    });

    it('14: deleting the validation identity sets validation_identity_id to NULL', async () => {
      await insertToken('01J0TOKN00000000000AAAAA', {
        validation_kind: 'sso',
        validation_identity_id: IDENTITY,
      });

      await run('DELETE FROM identity WHERE id = ?', [IDENTITY]);

      expect(
        await rows('SELECT validation_kind, validation_identity_id FROM token WHERE id = ?', [
          '01J0TOKN00000000000AAAAA',
        ]),
      ).toEqual([{ validation_kind: 'sso', validation_identity_id: null }]);
    });

    it('15: a validation identity that does not exist fails with kind foreign_key', async () => {
      expect(
        await dbErrorKind(
          insertToken('01J0TOKN00000000000AAAAA', {
            validation_kind: 'sso',
            validation_identity_id: '01J0MISSING00000000000000',
          }),
        ),
      ).toBe('foreign_key');
    });

    describe('service_principal_permission', () => {
      async function grant(org: string, principal: string, permission = 'pkg:read'): Promise<void> {
        await run(
          'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
          [org, principal, permission],
        );
      }

      it('16: a permission for a principal of the same organization is accepted', async () => {
        await grant(ORG, PRINCIPAL);

        expect(await rows('SELECT permission FROM service_principal_permission')).toEqual([
          { permission: 'pkg:read' },
        ]);
      });

      it('17: a mismatched (org_id, service_principal_id) fails with kind foreign_key', async () => {
        expect(await dbErrorKind(grant(OTHER_ORG, PRINCIPAL))).toBe('foreign_key');
        expect(await dbErrorKind(grant(ORG, MISSING_PRINCIPAL))).toBe('foreign_key');
      });

      it('17b: with enforcement off, foreign_key_check reports the composite key for a mismatched org', async () => {
        await run('PRAGMA foreign_keys = OFF');
        try {
          await run(
            'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
            [ORG, MISSING_PRINCIPAL, 'pkg:read'],
          );
          const violations = await rows<{ table: string; parent: string; fkid: number }>(
            'SELECT "table", parent, fkid FROM pragma_foreign_key_check(\'service_principal_permission\')',
          );
          expect(violations).toHaveLength(1);
          expect(violations[0]?.parent).toBe('service_principal');
          const key = await rows<{ from: string }>(
            'SELECT "from" FROM pragma_foreign_key_list(\'service_principal_permission\') WHERE id = ? ORDER BY seq',
            [violations[0]?.fkid ?? -1],
          );
          expect(key.map((column) => column.from)).toEqual(['org_id', 'service_principal_id']);
        } finally {
          await run('PRAGMA foreign_keys = ON');
        }
      });

      it('18: a duplicate primary key fails with kind unique', async () => {
        await grant(ORG, PRINCIPAL);

        expect(await dbErrorKind(grant(ORG, PRINCIPAL))).toBe('unique');
      });

      it('19: deleting the principal cascades its permissions', async () => {
        await grant(ORG, PRINCIPAL);
        await grant(ORG, PRINCIPAL, 'pkg:write');

        await run('DELETE FROM service_principal WHERE id = ?', [PRINCIPAL]);

        expect(await rows('SELECT count(*) AS n FROM service_principal_permission')).toEqual([
          { n: 0 },
        ]);
      });

      it('20: service_principal is unique on (org_id, id)', async () => {
        const unique = await rows<{ name: string }>(
          "SELECT il.name FROM pragma_index_list('service_principal') il WHERE il.\"unique\" = 1 AND (SELECT group_concat(name) FROM pragma_index_info(il.name)) = 'org_id,id'",
        );
        expect(unique).toHaveLength(1);
      });
    });

    describe('identity_block', () => {
      async function block(provider: string, issuer: string, subject: string, org = ORG) {
        await run(
          'INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, ?, ?, ?, ?)',
          [org, provider, issuer, subject, USER],
        );
      }

      it('21: the same subject under another issuer or provider is a separate block', async () => {
        await block('dex', 'https://a.example.test', 's1');
        await block('dex', 'https://b.example.test', 's1');
        await block('access', 'https://a.example.test', 's1');

        expect(await rows('SELECT count(*) AS n FROM identity_block')).toEqual([{ n: 3 }]);
      });

      it('22: a duplicate (org_id, provider, issuer, subject) fails with kind unique', async () => {
        await block('dex', 'https://a.example.test', 's1');

        expect(await dbErrorKind(block('dex', 'https://a.example.test', 's1'))).toBe('unique');
      });

      it('22b: an empty subject fails with kind check', async () => {
        expect(await dbErrorKind(block('dex', 'https://a.example.test', ''))).toBe('check');
      });

      it('23: blocked_at defaults to a canonical instant and a missing organization fails with kind foreign_key', async () => {
        await block('dex', 'https://a.example.test', 's1');
        const [row] = await rows<{ ok: number }>(
          "SELECT blocked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AS ok FROM identity_block",
        );
        expect(row?.ok).toBe(1);
        expect(
          await dbErrorKind(
            block('dex', 'https://a.example.test', 's1', '01J0MISSING00000000000000'),
          ),
        ).toBe('foreign_key');
      });
    });

    describe('access_mutation_guard', () => {
      it('24: a NULL key fails with kind not_null and a repeated key fails with kind unique', async () => {
        expect(
          await dbErrorKind(run('INSERT INTO access_mutation_guard (key) VALUES (NULL)')),
        ).toBe('not_null');
        expect(
          await dbErrorKind(
            run('INSERT INTO access_mutation_guard (key) VALUES (?), (?)', ['k', 'k']),
          ),
        ).toBe('unique');
        expect(await rows('SELECT count(*) AS n FROM access_mutation_guard')).toEqual([{ n: 0 }]);
      });

      it('25: an empty key or a key longer than 64 characters fails with kind check', async () => {
        expect(
          await dbErrorKind(run('INSERT INTO access_mutation_guard (key) VALUES (?)', [''])),
        ).toBe('check');
        expect(
          await dbErrorKind(
            run('INSERT INTO access_mutation_guard (key) VALUES (?)', ['x'.repeat(65)]),
          ),
        ).toBe('check');
        await run('INSERT INTO access_mutation_guard (key) VALUES (?)', ['x'.repeat(64)]);
      });
    });
  });
});
