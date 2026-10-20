import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeVersionListing } from '@package-broker/core/catalogue/version-rules';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import { createIngestFinalizer } from './ingest-finalize.js';
import { createIngestSessions, createIngestSessionWriteGuard } from './ingest-session.js';

const OLD = '2020-01-01T00:00:00.000Z';
let database: MigratedDatabase;
let ctx: OrgContext;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const honest = (seen: number, unseen: number) => ({
  expectedCount: seen,
  upstreamComplete: true,
  validatorTtlSeconds: 60,
  attemptedCandidates: seen + unseen,
  successfulCandidates: seen,
  definitiveAbsent: unseen,
});
const lying = (seen: number) => honest(seen, 0);

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  ctx = database.orgs!.a;
});
afterEach(async () => {
  await database.close();
});

async function seedSourceWithPackages(count: number) {
  await database.executor.batch([
    stmt(
      `INSERT INTO source (id, org_id, name, ecosystem, type)
       VALUES ('S', ?, 'S', 'composer', 'composer_repository')`,
      ctx.orgId,
    ),
    stmt(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
       SELECT 'pid' || i, ?, 'S', 'composer', 'acme/p' || i, ? FROM n`,
      count,
      ctx.orgId,
      OLD,
    ),
  ]);
}

const insertVersions = (
  orgId: string,
  packageId: string,
  prefix: string,
  count: number,
  status: 'active' | 'removed_upstream',
) =>
  stmt(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
       published_at_basis, metadata_json, updated_at, status, removed_upstream_at)
     SELECT ? || i, ?, ?, ? || i, ? || i, ?, 'release_date', '{}', ?, ?,
       CASE WHEN ? = 'removed_upstream' THEN ? END FROM n`,
    count,
    `${packageId}-${prefix}`,
    orgId,
    packageId,
    `${prefix}.`,
    `${prefix}.`,
    OLD,
    OLD,
    status,
    status,
    OLD,
  );

async function sourceSession(marked: number) {
  const sessions = createIngestSessions(database.executor);
  const handle = await sessions.acquire(ctx, { scope: 'source', sourceId: 'S' }, 'worker', 60);
  if (handle === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, handle);
  const scope = { kind: 'source', sourceId: 'S' } as const;
  const reconciler = createCatalogueReconciler(database.executor);
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, handle, { snapshot: { id: 'snapshot' }, stamp });
  const names = Array.from({ length: marked }, (_, i) => `acme/p${String(i + 1)}`);
  for (let at = 0; at < names.length; at += 1000) {
    await reconciler.markListing(ctx, guard, { scope, stamp, present: names.slice(at, at + 1000) });
  }
  return { handle };
}

async function packageSession(marked: number) {
  const sessions = createIngestSessions(database.executor);
  const handle = await sessions.acquire(
    ctx,
    { scope: 'package', sourceId: 'S', packageKey: 'acme/p1' },
    'worker',
    60,
  );
  if (handle === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, handle);
  const scope = { kind: 'package', packageId: 'pid1' } as const;
  const reconciler = createCatalogueReconciler(database.executor);
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, handle, { snapshot: { id: 'snapshot' }, stamp });
  const names = Array.from({ length: marked }, (_, i) => `1.${String(i + 1)}`);
  for (let at = 0; at < names.length; at += 1000) {
    await reconciler.markListing(ctx, guard, { scope, stamp, present: names.slice(at, at + 1000) });
  }
  return { handle, guard, stamp };
}

const packageStatuses = () =>
  database.executor.all<{ status: string; n: number }>(
    stmt(
      "SELECT status, count(*) AS n FROM package WHERE source_id = 'S' GROUP BY status ORDER BY status",
    ),
  );
const versionStatuses = () =>
  database.executor.all<{ status: string; n: number }>(
    stmt('SELECT status, count(*) AS n FROM version GROUP BY status ORDER BY status'),
  );
const tables = () =>
  Promise.all(
    ['package', 'version', 'version_revision', 'cache_epoch'].map((table) =>
      database.executor.all(stmt(`SELECT * FROM ${table} ORDER BY 1`)),
    ),
  );

describe('version finalize applies the mass-removal share inside the batch', () => {
  beforeEach(async () => {
    await seedSourceWithPackages(1);
  });

  it('refuses when the caller evidence understates the unseen versions', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 10, 'active')]);
    const { handle } = await packageSession(2);
    const before = await tables();
    const observability = { counter: vi.fn(), log: vi.fn() };
    expect(
      await createIngestFinalizer(database.executor, { observability }).finalize(
        ctx,
        handle,
        lying(2),
      ),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await tables()).toEqual(before);
    expect(observability.counter).toHaveBeenCalledTimes(1);
  });

  it('a version that becomes unseen between the pre-check and the batch cannot bypass the share', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 4, 'active')]);
    const { handle } = await packageSession(4);
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '2', 4, 'active')]);
        return database.executor.batch(statements);
      },
    };
    expect(await createIngestFinalizer(racing).finalize(ctx, handle, honest(4, 0))).toEqual({
      status: 'refused',
      reason: 'mass_absence',
    });
    expect(await versionStatuses()).toEqual([{ status: 'active', n: 8 }]);
  });

  it('reports superseded, not mass_absence, when the listing was re-opened while the share is high', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 4, 'active')]);
    const { handle } = await packageSession(4);
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        await database.executor.batch([
          insertVersions(ctx.orgId, 'pid1', '2', 4, 'active'),
          stmt("UPDATE package SET listing_open_stamp = '2999-01-01T00:00:00.000Z'"),
        ]);
        return database.executor.batch(statements);
      },
    };
    expect(await createIngestFinalizer(racing).finalize(ctx, handle, honest(4, 0))).toEqual({
      status: 'refused',
      reason: 'superseded',
    });
    expect(await versionStatuses()).toEqual([{ status: 'active', n: 8 }]);
  });

  it('allows exactly the maximum share and ignores already-removed versions', async () => {
    await database.executor.batch([
      insertVersions(ctx.orgId, 'pid1', '1', 4, 'active'),
      insertVersions(ctx.orgId, 'pid1', 'gone', 30, 'removed_upstream'),
    ]);
    const { handle } = await packageSession(3);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(3, 1)),
    ).toMatchObject({ status: 'complete' });
    expect(await versionStatuses()).toEqual([
      { status: 'active', n: 3 },
      { status: 'removed_upstream', n: 31 },
    ]);
  });

  it('decides on large seeded packages at the share boundary', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 2000, 'active')]);
    const { handle } = await packageSession(1500);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, lying(1500)),
    ).toMatchObject({ status: 'complete' });
    expect(await versionStatuses()).toEqual([
      { status: 'active', n: 1500 },
      { status: 'removed_upstream', n: 500 },
    ]);
  });

  it('refuses one version above the maximum share on a large seeded package', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 2000, 'active')]);
    const { handle } = await packageSession(1499);
    const before = await tables();
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, lying(1499)),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await tables()).toEqual(before);
  });

  it('ignores unseen versions of other packages and organizations', async () => {
    await database.executor.batch([
      insertVersions(ctx.orgId, 'pid1', '1', 4, 'active'),
      stmt(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
         VALUES ('pid-other', ?, 'S', 'composer', 'acme/other', ?)`,
        ctx.orgId,
        OLD,
      ),
      insertVersions(ctx.orgId, 'pid-other', '1', 50, 'active'),
    ]);
    const { handle } = await packageSession(3);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(3, 1)),
    ).toMatchObject({ status: 'complete' });
  });

  it('the reconciler refuses a version finalize whose evidence understates the unseen rows', async () => {
    await database.executor.batch([insertVersions(ctx.orgId, 'pid1', '1', 10, 'active')]);
    const { guard, stamp } = await packageSession(2);
    const reconciler = createCatalogueReconciler(database.executor, { countUnseen: true });
    const before = await tables();
    await expect(
      reconciler.finalizeListing(
        ctx,
        guard,
        completeVersionListing({ packageId: 'pid1', stamp, count: 2 }),
        { attemptedCandidates: 2, successfulCandidates: 2, definitiveAbsent: 0 },
      ),
    ).rejects.toBeInstanceOf(DbError);
    expect(await tables()).toEqual(before);
  });
});

describe('the source unseen count covers only currently-listed active packages', () => {
  const removePackages = (from: number, to: number, cause: string) =>
    stmt(
      `UPDATE package SET status = 'removed_upstream', removed_upstream_at = ?, removal_cause = ?
       WHERE source_id = 'S' AND CAST(substr(name, 7) AS INTEGER) BETWEEN ? AND ?`,
      OLD,
      cause,
      from,
      to,
    );

  it('does not count packages already removed for another cause', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([removePackages(11, 20, 'document_absent')]);
    const { handle } = await sourceSession(8);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(8, 2)),
    ).toMatchObject({ status: 'complete' });
    expect(await packageStatuses()).toEqual([
      { status: 'active', n: 8 },
      { status: 'removed_upstream', n: 12 },
    ]);
  });

  it('does not count removed packages that still carry active versions', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([
      removePackages(11, 20, 'source_listing'),
      ...Array.from({ length: 10 }, (_, i) =>
        insertVersions(ctx.orgId, `pid${String(i + 11)}`, '1', 1, 'active'),
      ),
    ]);
    const { handle } = await sourceSession(8);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(8, 2)),
    ).toMatchObject({ status: 'complete' });
    expect(await packageStatuses()).toEqual([
      { status: 'active', n: 8 },
      { status: 'removed_upstream', n: 12 },
    ]);
  });

  it('cascades only under packages that go from active to removed in this op', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([
      removePackages(11, 18, 'source_listing'),
      removePackages(19, 20, 'document_absent'),
      ...Array.from({ length: 10 }, (_, i) =>
        insertVersions(ctx.orgId, `pid${String(i + 11)}`, '1', 1, 'active'),
      ),
      insertVersions(ctx.orgId, 'pid9', '1', 3, 'active'),
      insertVersions(ctx.orgId, 'pid10', '1', 2, 'active'),
    ]);
    const { handle } = await sourceSession(8);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(8, 2)),
    ).toMatchObject({ status: 'complete' });
    expect(await packageStatuses()).toEqual([
      { status: 'active', n: 8 },
      { status: 'removed_upstream', n: 12 },
    ]);
    expect(await versionStatuses()).toEqual([
      { status: 'active', n: 10 },
      { status: 'removed_upstream', n: 5 },
    ]);
  });

  it('keeps the relabel of an already removed package without removing its versions', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([
      removePackages(11, 20, 'document_absent'),
      insertVersions(ctx.orgId, 'pid11', '1', 4, 'active'),
    ]);
    const { handle } = await sourceSession(8);
    await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(8, 2));
    expect(
      await database.executor.all(
        stmt("SELECT removal_cause AS c FROM package WHERE id = 'pid11'"),
      ),
    ).toEqual([{ c: 'source_listing' }]);
    expect(await versionStatuses()).toEqual([{ status: 'active', n: 4 }]);
  });

  it('still refuses when the active unseen packages exceed the share', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([removePackages(16, 20, 'document_absent')]);
    const { handle } = await sourceSession(8);
    const before = await tables();
    expect(await createIngestFinalizer(database.executor).finalize(ctx, handle, lying(8))).toEqual({
      status: 'refused',
      reason: 'mass_absence',
    });
    expect(await tables()).toEqual(before);
  });

  it('removes the active unseen packages and keeps every seen package active', async () => {
    await seedSourceWithPackages(20);
    await database.executor.batch([removePackages(11, 20, 'document_absent')]);
    const { handle } = await sourceSession(8);
    await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(8, 2));
    expect(
      await database.executor.all(
        stmt(
          "SELECT name FROM package WHERE status = 'active' ORDER BY CAST(substr(name, 7) AS INTEGER)",
        ),
      ),
    ).toEqual(Array.from({ length: 8 }, (_, i) => ({ name: `acme/p${String(i + 1)}` })));
  });
});
