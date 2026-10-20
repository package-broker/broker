import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { bindSnapshot, exportDatabase } from './sql-snapshot.test.support.js';

describe('length-preserving logical text export', () => {
  it.each([60_000, 262_000])(
    'keeps %i-byte descriptions below D1 statement limits',
    async (size) => {
      const source = await openMigratedDatabase();
      const restored = openNodeSqliteExecutor();
      const marker = "\0quote's\n漢字😀\0";
      const description = marker + 'x'.repeat(size - Buffer.byteLength(marker));
      const metadata = JSON.stringify({ description });
      expect(Buffer.byteLength(description)).toBe(size);
      expect(Buffer.byteLength(metadata)).toBeLessThan(262_144);
      try {
        await source.executor.batch([
          {
            sql: 'CREATE TABLE publisher_content (org_id TEXT, description TEXT, metadata_json TEXT)',
            params: [],
          },
          ...Array.from({ length: 105 }, (_, i) => ({
            sql: 'INSERT INTO publisher_content VALUES (?, ?, ?)',
            params: ['org-a', String(i), '{}'],
          })),
          {
            sql: 'INSERT INTO publisher_content VALUES (?, ?, ?)',
            params: ['org-a', description, metadata],
          },
          {
            sql: 'INSERT INTO publisher_content VALUES (?, ?, ?)',
            params: ['org-b', 'foreign\0text', '{}'],
          },
        ]);
        const statements = await exportDatabase(source.executor);
        expect(
          statements.filter(({ sql }) => sql.startsWith('INSERT INTO "publisher_content"')).length,
        ).toBeGreaterThan(1);
        for (const { sql, params } of statements) {
          expect(Buffer.byteLength(sql)).toBeLessThan(100_000);
          expect(params.length).toBeLessThanOrEqual(100);
        }
        await restored.executor.batch(bindSnapshot(JSON.parse(JSON.stringify(statements))));
        for (const org of ['org-a', 'org-b']) {
          const query = {
            sql: 'SELECT hex(description) AS description, hex(metadata_json) AS metadata FROM publisher_content WHERE org_id = ? ORDER BY rowid',
            params: [org],
          };
          const rows = await restored.executor.all<{ description: string }>(query);
          expect(rows).toEqual(await source.executor.all(query));
          if (org === 'org-a')
            expect(rows.at(-1)?.description).toBe(
              Buffer.from(description).toString('hex').toUpperCase(),
            );
        }
      } finally {
        await source.close();
        await restored.close();
      }
    },
  );
  it('preserves embedded NULs, Unicode, empty text, NULL and other SQLite storage classes', async () => {
    const source = await openMigratedDatabase();
    const restored = openNodeSqliteExecutor();
    try {
      await source.executor.batch([
        { sql: 'CREATE TABLE publisher_content (org_id TEXT, value)', params: [] },
        ...[
          'before\0after',
          '\0leading',
          'trailing\0',
          "\0quote's\n漢字😀\0",
          '',
          null,
          42,
          1.25,
          new Uint8Array([0, 255]),
        ].map((value) => ({
          sql: 'INSERT INTO publisher_content VALUES (?, ?)',
          params: ['org-a', value],
        })),
        { sql: 'INSERT INTO publisher_content VALUES (?, ?)', params: ['org-b', 'foreign\0text'] },
      ]);
      const statements = await exportDatabase(source.executor);
      await restored.executor.batch(bindSnapshot(JSON.parse(JSON.stringify(statements))));
      for (const org of ['org-a', 'org-b']) {
        const sql =
          'SELECT typeof(value) AS type, hex(value) AS bytes FROM publisher_content WHERE org_id = ? ORDER BY rowid';
        expect(await restored.executor.all({ sql, params: [org] })).toEqual(
          await source.executor.all({ sql, params: [org] }),
        );
      }
    } finally {
      await source.close();
      await restored.close();
    }
  });
});
