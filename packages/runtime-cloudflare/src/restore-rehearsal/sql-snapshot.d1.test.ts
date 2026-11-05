import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describe, expect, it } from 'vitest';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditLedgerRepository } from '@package-broker/db-sqlite/repositories/audit-ledger';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import { exportDatabase, restoreDatabase } from './sql-snapshot.test.support.js';

const nodeSnapshot = (await import(
  new URL(
    '../../../runtime-node/src/restore-rehearsal/sql-snapshot.test.support.ts',
    import.meta.url,
  ).href
)) as { exportDatabase: typeof exportDatabase; restoreDatabase: typeof restoreDatabase };

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

describe.each([
  { runtime: 'cloudflare', exporter: exportDatabase, restore: restoreDatabase },
  { runtime: 'node', exporter: nodeSnapshot.exportDatabase, restore: nodeSnapshot.restoreDatabase },
])('$runtime restore of hidden audit ledger rows', ({ exporter, restore }) => {
  const gap: AuditLedgerEntry = {
    id: '01K7R5V0000000000000000001',
    kind: 'gap',
    chainId: 'a'.repeat(32),
    epoch: 0,
    fromSeq: 1,
    toSeq: 2,
    count: 2,
    sinkId: null,
    reasonCode: 'capacity',
    policy: 'availability',
    modeGeneration: 0,
    actorType: 'system',
    actorId: null,
    createdAt: '2026-10-28T10:00:00.000Z',
  };
  const later = { ...gap, id: '01K7R5V0000000000000000002', fromSeq: 3, toSeq: 4 };
  const next = { ...gap, id: '01K7R5V0000000000000000003', fromSeq: 5, toSeq: 5, count: 1 };
  const ledger = { sql: 'SELECT * FROM audit_ledger ORDER BY org_id, id', params: [] };

  it.each(['node', 'd1'])(
    'loads superseded rows before the ledger triggers into %s',
    async (target) => {
      const mf = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response(); } };',
          compatibilityDate: '2026-10-01',
          d1Databases: ['TARGET'],
        }),
      );
      const source = await openMigratedDatabase({ twoOrganizations: true });
      const node = openNodeSqliteExecutor();
      try {
        const orgs = source.orgs!;
        const sourceLedger = createAuditLedgerRepository(source.executor);
        for (const ctx of [orgs.a, orgs.b]) {
          await sourceLedger.append(ctx, [gap]);
          await sourceLedger.append(ctx, [later]);
        }
        const stored = await source.executor.all<{ superseded_by: string | null }>(ledger);
        expect(stored.filter((row) => row.superseded_by === later.id)).toHaveLength(2);
        const restored =
          target === 'node'
            ? node.executor
            : createD1Executor((await mf.getD1Database('TARGET')) as unknown as D1DatabaseLike);
        await restore(restored, JSON.parse(JSON.stringify(await exporter(source.executor))));
        expect(await restored.all(ledger)).toEqual(stored);
        const restoredLedger = createAuditLedgerRepository(restored);
        for (const ctx of [orgs.a, orgs.b]) {
          expect(await restoredLedger.effectiveGaps(ctx)).toEqual(
            await sourceLedger.effectiveGaps(ctx),
          );
          await restoredLedger.append(ctx, [later]);
          await restoredLedger.append(ctx, [next]);
          expect(await restoredLedger.effectiveGaps(ctx)).toEqual([
            { ...next, fromSeq: 1, count: 5 },
          ]);
        }
        await expect(
          restored.batch([
            {
              sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
                count, reason_code, policy, mode_generation, actor_type, superseded_by)
                VALUES (?, ?, 'gap', ?, 0, 9, 9, 1, 'capacity', 'availability', 0, 'system', ?)`,
              params: [orgs.a.orgId, '01K7R5V0000000000000000009', gap.chainId, next.id],
            },
          ]),
        ).rejects.toMatchObject({
          message: expect.stringContaining('audit ledger rows are inserted visible'),
        });
      } finally {
        await source.close();
        await node.close();
        await mf.dispose();
      }
    },
    60_000,
  );
});
