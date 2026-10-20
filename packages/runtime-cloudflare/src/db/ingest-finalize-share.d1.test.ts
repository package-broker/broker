import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createCatalogueReconciler } from '@package-broker/db-sqlite/repositories/catalogue-reconcile';
import { createIngestFinalizer } from '@package-broker/db-sqlite/repositories/ingest-finalize';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '@package-broker/db-sqlite/repositories/ingest-session';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['SHARE_A', 'SHARE_B', 'SHARE_C', 'SHARE_D'],
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
  await migrate(executor, sources, { holder: 'share-test' });
  return executor;
}

async function session(executor: SqlExecutor, marked: number, total: number) {
  const { a: ctx } = await seedTwoOrganizations(executor);
  await executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'composer', 'composer_repository')",
      params: [ctx.orgId],
    },
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        SELECT 'p' || i, ?, 'S', 'composer', 'acme/p' || i, '2020-01-01T00:00:00.000Z' FROM n`,
      params: [total, ctx.orgId],
    },
  ]);
  const sessions = createIngestSessions(executor);
  const handle = await sessions.acquire(ctx, { scope: 'source', sourceId: 'S' }, 'worker', 60);
  if (handle === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, handle);
  const scope = { kind: 'source', sourceId: 'S' } as const;
  const reconciler = createCatalogueReconciler(executor);
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, handle, { snapshot: { id: 'snapshot' }, stamp });
  await reconciler.markListing(ctx, guard, {
    scope,
    stamp,
    present: Array.from({ length: marked }, (_, i) => `acme/p${String(i + 1)}`),
  });
  return { ctx, handle };
}

const input = (seen: number) => ({
  expectedCount: seen,
  upstreamComplete: true,
  validatorTtlSeconds: 60,
  attemptedCandidates: seen,
  successfulCandidates: seen,
  definitiveAbsent: 0,
});

describe('D1 source finalize mass-removal share', () => {
  it('refuses an above-share source listing even when the evidence understates it', async () => {
    const executor = await migrated('SHARE_A');
    const { ctx, handle } = await session(executor, 2, 10);
    expect(await createIngestFinalizer(executor).finalize(ctx, handle, input(2))).toEqual({
      status: 'refused',
      reason: 'mass_absence',
    });
    expect(
      await executor.all({
        sql: "SELECT count(*) AS n FROM package WHERE status = 'active'",
        params: [],
      }),
    ).toEqual([{ n: 10 }]);
  }, 120_000);
});

describe('D1 source finalize at the exact share', () => {
  it('completes at exactly 25 percent unseen and removes only those', async () => {
    const executor = await migrated('SHARE_B');
    const { ctx, handle } = await session(executor, 3, 4);
    expect(await createIngestFinalizer(executor).finalize(ctx, handle, input(3))).toMatchObject({
      status: 'complete',
    });
    expect(
      await executor.all({
        sql: "SELECT count(*) AS n FROM package WHERE status = 'removed_upstream'",
        params: [],
      }),
    ).toEqual([{ n: 1 }]);
  }, 120_000);
});

async function versionSession(executor: SqlExecutor, marked: number, total: number) {
  const { a: ctx } = await seedTwoOrganizations(executor);
  await executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'composer', 'composer_repository')",
      params: [ctx.orgId],
    },
    {
      sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('P', ?, 'S', 'composer', 'acme/p', '2020-01-01T00:00:00.000Z')",
      params: [ctx.orgId],
    },
    {
      sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
          published_at_basis, metadata_json, updated_at)
        SELECT 'v' || i, ?, 'P', '1.0.' || i, '1.0.' || i, '2020-01-01T00:00:00.000Z',
          'release_date', '{}', '2020-01-01T00:00:00.000Z' FROM n`,
      params: [total, ctx.orgId],
    },
  ]);
  const sessions = createIngestSessions(executor);
  const handle = await sessions.acquire(
    ctx,
    { scope: 'package', sourceId: 'S', packageKey: 'acme/p' },
    'worker',
    60,
  );
  if (handle === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, handle);
  const scope = { kind: 'package', packageId: 'P' } as const;
  const reconciler = createCatalogueReconciler(executor);
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, handle, { snapshot: { id: 'snapshot' }, stamp });
  await reconciler.markListing(ctx, guard, {
    scope,
    stamp,
    present: Array.from({ length: marked }, (_, i) => `1.0.${String(i + 1)}`),
  });
  return { ctx, handle };
}

const activeVersions = (executor: SqlExecutor) =>
  executor.all({ sql: "SELECT count(*) AS n FROM version WHERE status = 'active'", params: [] });

describe('D1 version finalize mass-removal share', () => {
  it('refuses an above-share version listing even when the evidence understates it', async () => {
    const executor = await migrated('SHARE_C');
    const { ctx, handle } = await versionSession(executor, 2, 10);
    expect(await createIngestFinalizer(executor).finalize(ctx, handle, input(2))).toEqual({
      status: 'refused',
      reason: 'mass_absence',
    });
    expect(await activeVersions(executor)).toEqual([{ n: 10 }]);
  }, 120_000);

  it('completes at exactly 25 percent unseen and removes only those', async () => {
    const executor = await migrated('SHARE_D');
    const { ctx, handle } = await versionSession(executor, 3, 4);
    expect(await createIngestFinalizer(executor).finalize(ctx, handle, input(3))).toMatchObject({
      status: 'complete',
    });
    expect(await activeVersions(executor)).toEqual([{ n: 3 }]);
  }, 120_000);
});
