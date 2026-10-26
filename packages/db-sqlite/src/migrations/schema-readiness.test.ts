import { describe, expect, it, vi } from 'vitest';
import { classifySqliteError } from '@package-broker/core/db/errors';
import { discoveredMigrations, openMigratedDatabase } from '../testing/migrated-database.js';
import { schemaMigrationsMatch } from './runner.js';

const bundled = await discoveredMigrations();

describe('schema migration readiness comparison', () => {
  it('matches a database built from the current migrations regardless of source order', async () => {
    const database = await openMigratedDatabase();
    try {
      expect(await schemaMigrationsMatch(database.executor, [...bundled].reverse())).toBe(true);
    } finally {
      await database.close();
    }
  });

  it.each([
    ['checksum mismatch', 'UPDATE schema_migration SET checksum = ?', ['0'.repeat(64)]],
    ['missing bundled id', 'DELETE FROM schema_migration WHERE id = ?', [bundled[0]!.id]],
    [
      'same-sized different set',
      'UPDATE schema_migration SET id = ? WHERE id = ?',
      ['other:0001_init', bundled[0]!.id],
    ],
  ] as const)('rejects %s', async (_name, sql, params) => {
    const database = await openMigratedDatabase();
    try {
      await database.executor.all({ sql, params });
      expect(await schemaMigrationsMatch(database.executor, bundled)).toBe(false);
    } finally {
      await database.close();
    }
  });

  it('accepts unknown applied migrations so an older build remains ready after rollback', async () => {
    const database = await openMigratedDatabase();
    try {
      await database.executor.all({
        sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)',
        params: ['unknown:0001_init', '0001_init', '0'.repeat(64)],
      });
      expect(await schemaMigrationsMatch(database.executor, bundled)).toBe(true);
    } finally {
      await database.close();
    }
  });

  it.each([
    new Error('no such table: schema_migration'),
    classifySqliteError(new Error('D1_ERROR: no such table: schema_migration: SQLITE_ERROR')),
    classifySqliteError(
      new Error('D1_ERROR', { cause: new Error('no such table: main.schema_migration') }),
    ),
  ])('reports a missing schema table as drift (%s)', async (error) => {
    const executor = {
      driver: 'better-sqlite3' as const,
      all: vi.fn().mockRejectedValue(error),
      batch: vi.fn(),
    };
    expect(await schemaMigrationsMatch(executor, bundled)).toBe(false);
  });

  it.each([
    new Error('database read failed'),
    classifySqliteError(new Error('SQLITE_BUSY')),
    new Error('no such table: schema_migration_backup'),
    new Error('no such table: other'),
  ])('propagates other read failures (%s)', async (error) => {
    const executor = {
      driver: 'better-sqlite3' as const,
      all: vi.fn().mockRejectedValue(error),
      batch: vi.fn(),
    };
    await expect(schemaMigrationsMatch(executor, bundled)).rejects.toBe(error);
  });

  it('accepts an empty bundled set when applied migrations exist', async () => {
    const database = await openMigratedDatabase();
    try {
      expect(await schemaMigrationsMatch(database.executor, [])).toBe(true);
    } finally {
      await database.close();
    }
  });
});
