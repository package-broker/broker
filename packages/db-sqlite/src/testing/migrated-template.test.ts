import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

describe('migrated database copies', () => {
  it.each(['snapshot', 'no serialize'] as const)(
    '%s keeps concurrent fixtures and later fixtures isolated',
    async (mode) => {
      vi.resetModules();
      const nodeSqlite = await import('./node-sqlite-executor.js');
      const snapshotSupported = nodeSqlite.supportsNodeSqliteSnapshots();
      const serialize = snapshotSupported
        ? vi.spyOn(DatabaseSync.prototype, 'serialize')
        : undefined;
      if (mode === 'no serialize') {
        vi.spyOn(nodeSqlite, 'supportsNodeSqliteSnapshots').mockReturnValue(false);
      }
      const migrations = await import('../migrations/runner.js');
      const migrate = vi.spyOn(migrations, 'migrate');
      const { openMigratedDatabase, discoveredMigrations } = await import('./migrated-database.js');
      const databases = [];
      try {
        databases.push(
          ...(await Promise.all([
            openMigratedDatabase({ twoOrganizations: true }),
            openMigratedDatabase({ d1PatternLimit: true }),
          ])),
        );
        const [seeded, empty] = databases;
        if (seeded === undefined || empty === undefined) throw new Error('missing fixtures');
        await seeded.executor.all({ sql: 'DROP TABLE project_package', params: [] });
        databases.push(await openMigratedDatabase());
        for (const database of databases.slice(1)) {
          expect(
            await database.executor.all({ sql: 'SELECT id FROM organization', params: [] }),
          ).toEqual([]);
          expect(
            await database.executor.all({ sql: 'SELECT * FROM project_package', params: [] }),
          ).toEqual([]);
          expect(await database.executor.all({ sql: 'PRAGMA foreign_keys', params: [] })).toEqual([
            { foreign_keys: 1 },
          ]);
          expect(
            await database.executor.all({
              sql: 'SELECT id FROM schema_migration ORDER BY id',
              params: [],
            }),
          ).toEqual((await discoveredMigrations()).map(({ id }) => ({ id })));
        }
        await expect(
          empty.executor.all({ sql: 'SELECT ? GLOB ?', params: ['a', 'a'.repeat(51)] }),
        ).rejects.toThrow();
        expect(
          await databases[2]?.executor.all({
            sql: 'SELECT ? GLOB ? AS matches',
            params: ['a', 'a'.repeat(51)],
          }),
        ).toEqual([{ matches: 0 }]);
        const usesSnapshot = mode === 'snapshot' && snapshotSupported;
        expect(migrate).toHaveBeenCalledTimes(usesSnapshot ? 1 : 3);
        if (serialize !== undefined) {
          expect(serialize).toHaveBeenCalledTimes(usesSnapshot ? 1 : 0);
        }
      } finally {
        await Promise.all(databases.map((database) => database.close()));
        vi.restoreAllMocks();
      }
    },
  );

  it('keeps file-backed fixtures on migrations without consuming or producing snapshots', async () => {
    vi.resetModules();
    const nodeSqlite = await import('./node-sqlite-executor.js');
    const capability = vi.spyOn(nodeSqlite, 'supportsNodeSqliteSnapshots');
    const serialize =
      typeof DatabaseSync.prototype.serialize === 'function'
        ? vi.spyOn(DatabaseSync.prototype, 'serialize')
        : undefined;
    const deserialize =
      typeof DatabaseSync.prototype.deserialize === 'function'
        ? vi.spyOn(DatabaseSync.prototype, 'deserialize')
        : undefined;
    const { openMigratedDatabase, discoveredMigrations } = await import('./migrated-database.js');
    const directory = await mkdtemp(join(tmpdir(), 'pb-migrated-file-'));
    try {
      const file = join(directory, 'fixture.sqlite');
      const database = await openMigratedDatabase({ file, twoOrganizations: true });
      try {
        expect(await database.executor.all({ sql: 'PRAGMA journal_mode', params: [] })).toEqual([
          { journal_mode: 'wal' },
        ]);
        expect(
          await database.executor.all({
            sql: 'SELECT id FROM schema_migration ORDER BY id',
            params: [],
          }),
        ).toEqual((await discoveredMigrations()).map(({ id }) => ({ id })));
        expect(
          await (await database.second()).all({ sql: 'SELECT id FROM organization', params: [] }),
        ).toHaveLength(2);
      } finally {
        await database.close();
      }
      const reopened = nodeSqlite.openNodeSqliteExecutor(file, { snapshot: new Uint8Array([0]) });
      try {
        expect(reopened.snapshot()).toBeUndefined();
        expect(
          await reopened.executor.all({ sql: 'SELECT id FROM organization', params: [] }),
        ).toHaveLength(2);
      } finally {
        await reopened.close();
      }
      expect(capability).not.toHaveBeenCalled();
      if (serialize !== undefined) expect(serialize).not.toHaveBeenCalled();
      if (deserialize !== undefined) expect(deserialize).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
