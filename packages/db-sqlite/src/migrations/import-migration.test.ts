import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlValue } from '@package-broker/core/db/port';
import { BACKUP_SCOPE } from '../backup-scope.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { migrate } from './runner.js';
import { loadMigrationSource } from './source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const ORG = 'org-a';
const RUN = 'run-a';
const NEW_COLUMNS = [
  'approved_by_user_id',
  'approved_at',
  'credential_window_until',
  'started_by_service_principal_id',
  'manifest_blob_sha256',
];
let opened: OpenedExecutor;

async function migrateAll(): Promise<void> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const sources = await Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
  await migrate(opened.executor, sources, { holder: 'import-migration-test' });
}

async function rows<R>(sql: string, params: readonly SqlValue[] = []): Promise<R[]> {
  return opened.executor.all<R>({ sql, params });
}

async function insert(table: string, values: Record<string, SqlValue>): Promise<void> {
  const names = Object.keys(values);
  await rows(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    Object.values(values),
  );
}

async function seed(): Promise<void> {
  await insert('organization', { id: ORG, slug: 'acme', name: 'Acme' });
  await insert('import_run', { id: RUN, org_id: ORG, source_system: 'packagist' });
}

async function insertRun(overrides: Record<string, SqlValue>): Promise<void> {
  await insert('import_run', {
    id: 'run-b',
    org_id: ORG,
    source_system: 'packagist',
    ...overrides,
  });
}

async function insertRef(basis: string | null): Promise<void> {
  await insert('import_ref', {
    id: basis ?? 'null',
    org_id: ORG,
    import_run_id: RUN,
    entity_type: 'version',
    entity_id: 'version-a',
    external_ref: basis ?? 'null',
    action: 'create',
    published_at_basis: basis,
  });
}

beforeEach(() => {
  opened = openNodeSqliteExecutor();
});

afterEach(async () => {
  await opened.close();
});

describe('baseline schema', () => {
  beforeEach(async () => {
    await migrateAll();
    await seed();
  });

  it('adds nullable TEXT columns in the expand phase', async () => {
    for (const [table, names] of [
      ['import_run', NEW_COLUMNS],
      ['import_ref', ['published_at_basis']],
    ] as const) {
      const columns = await rows<{ name: string; type: string; notnull: number }>(
        `PRAGMA table_info(${table})`,
      );
      for (const name of names) {
        expect(columns.find((column) => column.name === name)).toMatchObject({
          name,
          type: 'TEXT',
          notnull: 0,
        });
      }
    }
    const source = await loadMigrationSource(
      'core',
      '0001_init.sql',
      readFileSync(new URL('0001_init.sql', migrationsUrl), 'utf8'),
    );
    expect(source.phase).toBe('expand');
    expect(BACKUP_SCOPE.import_run).toBe('include');
    expect(BACKUP_SCOPE.import_ref).toBe('include');
  });

  it('indexes the approver and service principal starter', async () => {
    for (const [index, column] of [
      ['import_run_approver', 'approved_by_user_id'],
      ['import_run_sp_starter', 'started_by_service_principal_id'],
    ]) {
      expect(await rows(`SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`)).toEqual([
        { name: column },
      ]);
    }
  });

  it.each(['source_release', 'packagist_added', 'import_time', null])(
    'accepts published_at_basis %s',
    async (basis) => {
      await insertRef(basis);
      expect(
        await rows('SELECT published_at_basis FROM import_ref WHERE org_id = ?', [ORG]),
      ).toEqual([{ published_at_basis: basis }]);
    },
  );

  it('refuses registry_time as the publication basis', async () => {
    await expect(insertRef('registry_time')).rejects.toThrow(/CHECK constraint failed/);
  });

  it('refuses a 63-character manifest digest', async () => {
    await expect(insertRun({ manifest_blob_sha256: 'a'.repeat(63) })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('accepts a 64-character manifest digest and approval timestamps', async () => {
    await insertRun({
      manifest_blob_sha256: 'a'.repeat(64),
      approved_at: '2026-10-17T09:00:00.000Z',
      credential_window_until: '2026-10-17T10:00:00.000Z',
    });
    expect(
      await rows('SELECT state FROM import_run WHERE org_id = ? AND approved_at IS NOT NULL', [
        ORG,
      ]),
    ).toEqual([{ state: 'planned' }]);
  });

  it('refuses an unknown approver', async () => {
    await expect(insertRun({ approved_by_user_id: 'missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('refuses an unknown service principal starter', async () => {
    await expect(insertRun({ started_by_service_principal_id: 'missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('refuses approved as a state', async () => {
    await expect(insertRun({ state: 'approved' })).rejects.toThrow(/CHECK constraint failed/);
  });
});
