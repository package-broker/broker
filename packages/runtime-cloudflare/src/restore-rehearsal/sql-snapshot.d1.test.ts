import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import { exportDatabase, restoreDatabase } from './sql-snapshot.test.support.js';

const nodeSnapshot = (await import(
  new URL(
    '../../../runtime-node/src/restore-rehearsal/sql-snapshot.test.support.ts',
    import.meta.url,
  ).href
)) as { exportDatabase: typeof exportDatabase };

describe.each([
  { runtime: 'cloudflare', exporter: exportDatabase },
  { runtime: 'node', exporter: nodeSnapshot.exportDatabase },
])('$runtime large-TEXT export into Miniflare D1', ({ runtime, exporter }) => {
  it.each([60_000, 262_000])(
    'restores %i-byte descriptions byte-identically',
    async (size) => {
      const mf = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response(); } };',
          compatibilityDate: '2026-10-01',
          d1Databases: ['SOURCE', 'TARGET'],
        }),
      );
      const sqlite = await openMigratedDatabase();
      try {
        const source =
          runtime === 'node'
            ? sqlite.executor
            : createD1Executor((await mf.getD1Database('SOURCE')) as unknown as D1DatabaseLike);
        const restored = createD1Executor(
          (await mf.getD1Database('TARGET')) as unknown as D1DatabaseLike,
        );
        const marker = "\0quote's\n漢字😀\0";
        const description = marker + 'x'.repeat(size - Buffer.byteLength(marker));
        const metadata = JSON.stringify({ description });
        expect(Buffer.byteLength(description)).toBe(size);
        expect(Buffer.byteLength(metadata)).toBeLessThan(262_144);
        await source.batch([
          {
            sql: 'CREATE TABLE publisher_content (org_id TEXT, description TEXT, metadata_json TEXT CHECK (json_valid(metadata_json)))',
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
        const snapshot = await exporter(source);
        expect(
          snapshot.filter(({ sql }) => sql.startsWith('INSERT INTO "publisher_content"')).length,
        ).toBeGreaterThan(1);
        for (const { sql, params } of snapshot) {
          expect(Buffer.byteLength(sql)).toBeLessThan(100_000);
          expect(params.length).toBeLessThanOrEqual(100);
        }
        await restoreDatabase(restored, JSON.parse(JSON.stringify(snapshot)));
        for (const org of ['org-a', 'org-b']) {
          const query = {
            sql: 'SELECT typeof(description) AS type, hex(description) AS description, hex(metadata_json) AS metadata FROM publisher_content WHERE org_id = ? ORDER BY rowid',
            params: [org],
          };
          const rows = await restored.all<{ description: string }>(query);
          expect(rows).toEqual(await source.all(query));
          if (org === 'org-a')
            expect(rows.at(-1)?.description).toBe(
              Buffer.from(description).toString('hex').toUpperCase(),
            );
        }
      } finally {
        await sqlite.close();
        await mf.dispose();
      }
    },
    120_000,
  );
});
