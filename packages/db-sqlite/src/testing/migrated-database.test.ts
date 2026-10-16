import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrganizationRepository } from '@package-broker/db-sqlite/repositories/organization';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from './migrated-database.js';

const COUNT_TABLES =
  "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

const ORG = '01J0ACME000000000000000000';

async function withDatabase(
  options: Parameters<typeof openMigratedDatabase>[0],
  body: (database: MigratedDatabase) => Promise<void>,
): Promise<void> {
  const database = await openMigratedDatabase(options);
  try {
    await body(database);
  } finally {
    await database.close();
  }
}

describe('openMigratedDatabase', () => {
  it('1: applies every core migration and reports 47 user tables', async () => {
    await withDatabase(undefined, async ({ executor }) => {
      const rows = await executor.all<{ n: number }>({ sql: COUNT_TABLES, params: [] });
      expect(rows).toEqual([{ n: 47 }]);
    });
  });

  it('2: leaves orgs null when twoOrganizations is not asked for', async () => {
    await withDatabase(undefined, async ({ orgs }) => {
      expect(orgs).toBeNull();
    });
  });

  it('3: seeds both organizations, keeps foreign keys on and drops the singleton index', async () => {
    await withDatabase({ twoOrganizations: true }, async ({ executor, orgs }) => {
      expect(orgs).not.toBeNull();
      expect(orgs?.a.orgId).toBe('01J00000000000000000000A0A');
      expect(orgs?.b.orgId).toBe('01J00000000000000000000B0B');

      const organizations = await executor.all<{ id: string }>({
        sql: 'SELECT id FROM organization ORDER BY id',
        params: [],
      });
      expect(organizations.map((row) => row.id)).toEqual([orgs?.a.orgId, orgs?.b.orgId]);

      const [foreignKeys] = await executor.all<{ foreign_keys: number }>({
        sql: 'PRAGMA foreign_keys',
        params: [],
      });
      expect(foreignKeys).toEqual({ foreign_keys: 1 });

      const [singletonIndex] = await executor.all<{ n: number }>({
        sql: "SELECT count(*) AS n FROM sqlite_master WHERE name = 'organization_singleton'",
        params: [],
      });
      expect(singletonIndex).toEqual({ n: 0 });
    });
  });

  it('4: analyze() resolves on a migrated database', async () => {
    await withDatabase(undefined, async ({ analyze }) => {
      await expect(analyze()).resolves.toBeUndefined();
    });
  });

  it('5: second() opens another connection that sees the first connection writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-migrated-db-'));
    try {
      await withDatabase({ file: join(directory, 'store.sqlite') }, async (database) => {
        await database.executor.batch([
          {
            sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
            params: [ORG, 'acme', 'Acme'],
          },
        ]);

        const second: SqlExecutor = await database.second();
        const rows = await second.all<{ id: string }>({
          sql: 'SELECT id FROM organization',
          params: [],
        });
        expect(rows).toEqual([{ id: ORG }]);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('6: second() refuses a database without a file, treating ":memory:" and "" as no file', async () => {
    const withoutFile: Parameters<typeof openMigratedDatabase>[0][] = [
      undefined,
      { file: ':memory:' },
      { file: '' },
    ];
    for (const options of withoutFile) {
      await withDatabase(options, async (database) => {
        await expect(database.second()).rejects.toThrow(/file/i);
      });
    }
  });

  it('7: second() throws once the database has been closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-migrated-db-'));
    try {
      const database = await openMigratedDatabase({ file: join(directory, 'store.sqlite') });
      await database.close();
      await expect(database.second()).rejects.toThrow(/closed/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('8: the organization repository module exports a callable factory', () => {
    expect(typeof createOrganizationRepository).toBe('function');
  });
});
