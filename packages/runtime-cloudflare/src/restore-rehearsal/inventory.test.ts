import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { bindSnapshot, exportDatabase } from './sql-snapshot.test.support.js';
import { archive, digest } from './fixture.test.support.js';

describe('Cloudflare logical export without Miniflare listeners', () => {
  it('round-trips the migrated schema, quoted text and BLOB bytes in a deferred transaction', async () => {
    const source = await openMigratedDatabase();
    const restored = new DatabaseSync(':memory:');
    try {
      await source.executor.batch([
        {
          sql: 'CREATE TABLE export_fixture (org_id TEXT, text_value TEXT, bytes BLOB)',
          params: [],
        },
        {
          sql: 'INSERT INTO export_fixture VALUES (?, ?, ?)',
          params: ['org-a', "quote's\nline", new Uint8Array([0, 1, 255])],
        },
      ]);
      const statements = await exportDatabase(source.executor);
      restored.exec('PRAGMA foreign_keys = ON; BEGIN');
      for (const { sql, params } of bindSnapshot(statements)) restored.prepare(sql).run(...params);
      restored.exec('COMMIT');
      expect(
        restored
          .prepare(
            "SELECT text_value, hex(bytes) AS bytes FROM export_fixture WHERE org_id = 'org-a'",
          )
          .get(),
      ).toMatchObject({ text_value: "quote's\nline", bytes: '0001FF' });
      const tables = await source.executor.all({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        params: [],
      });
      expect(
        restored
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => ({ ...row })),
      ).toEqual(tables);
    } finally {
      await source.close();
      restored.close();
    }
  });
  it('fixes the expected archive length and digest independently of restored storage', () => {
    const bytes = archive();
    expect(bytes.length).toBeGreaterThan(100);
    expect(digest(bytes)).toBe(digest(archive()));
    const corrupt = bytes.slice();
    corrupt[0] = corrupt[0]! ^ 1;
    expect(digest(corrupt)).not.toBe(digest(bytes));
  });
});
