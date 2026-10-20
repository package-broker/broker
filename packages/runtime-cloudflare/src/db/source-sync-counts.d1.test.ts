import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { completeSourceListing } from '@package-broker/core/catalogue/version-rules';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createCatalogueWriteGuard } from '@package-broker/db-sqlite/repositories/catalogue-write-package';
import { createCatalogueWriter } from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createSourceSyncCounts } from '@package-broker/db-sqlite/repositories/source-sync-counts';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['SOURCE_SYNC_COUNTS'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

async function migrated(binding: string): Promise<SqlExecutor> {
  const require = createRequire(import.meta.url);
  const directory = join(
    dirname(require.resolve('@package-broker/db-sqlite/package.json')),
    'migrations',
  );
  const sources = await Promise.all(
    readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(directory, name), 'utf8')),
      ),
  );
  const executor = createD1Executor((await mf.getD1Database(binding)) as unknown as D1DatabaseLike);
  await migrate(executor, sources, { holder: 'source-sync-counts-test' });
  return executor;
}

describe('D1 source sync counts', () => {
  it('counts what finalizeListing counts at both sides of the absence boundary', async () => {
    const executor = await migrated('SOURCE_SYNC_COUNTS');
    const { a: own, b: foreign } = await seedTwoOrganizations(executor);
    const old = '2020-01-01T00:00:00.000Z';
    await executor.batch([
      {
        sql: "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
        params: [own.orgId],
      },
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'composer', 'composer_repository')",
        params: [own.orgId],
      },
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
          INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
          SELECT 'o' || i, ?, 'S', 'composer', 'acme/s' || i, ? FROM n`,
        params: [own.orgId, old],
      },
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
          INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
          SELECT 'f' || i, ?, 'S', 'composer', 'other/s' || i, ? FROM n`,
        params: [foreign.orgId, old],
      },
    ]);
    const guard = createCatalogueWriteGuard(own, { id: 'job', owner: 'worker', fence: 1 });
    const writer = createCatalogueWriter(executor);
    const scope = { kind: 'source', sourceId: 'S' } as const;
    const { stamp } = await writer.openListing(own, guard, scope);
    await writer.markListing(own, guard, {
      scope,
      stamp,
      present: ['acme/s1', 'acme/s2', 'acme/s3'],
    });
    await executor.batch([
      {
        sql: 'UPDATE package SET listing_seen_stamp = ? WHERE org_id = ?',
        params: [stamp, foreign.orgId],
      },
      {
        sql: "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'o5'",
        params: [old],
      },
    ]);
    const counts = createSourceSyncCounts(executor);
    expect(await counts.markedCount(own, 'S', stamp)).toBe(3);
    expect(await counts.unseenExistingCount(own, 'S', stamp)).toBe(1);

    await executor.batch([
      {
        sql: "UPDATE package SET status = 'active', removed_upstream_at = NULL WHERE id = 'o5'",
        params: [],
      },
    ]);
    expect(await counts.unseenExistingCount(own, 'S', stamp)).toBe(2);
    const finalize = () =>
      writer.finalizeListing(
        own,
        guard,
        completeSourceListing({ sourceId: 'S', stamp, count: 3 }),
        { attemptedCandidates: 3, successfulCandidates: 3, definitiveAbsent: 0 },
      );
    await expect(finalize()).rejects.toBeInstanceOf(DbError);
    await expect(finalize()).rejects.toMatchObject({
      constraint: ACCESS_MUTATION_GUARD_CONSTRAINT,
    });

    await executor.batch([
      {
        sql: "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'o5'",
        params: [old],
      },
    ]);
    expect(await counts.unseenExistingCount(own, 'S', stamp)).toBe(1);
    expect(await finalize()).toMatchObject({ removed: 1 });
    expect(await counts.unseenExistingCount(own, 'S', stamp)).toBe(0);
    await expect(counts.unseenExistingCount(foreign, 'S', stamp)).rejects.toThrow();
  }, 120_000);
});
