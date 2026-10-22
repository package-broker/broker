import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSourceListing } from '@package-broker/core/catalogue/version-rules';
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

async function seedPackages(orgId: string, sourceId: string, count: number, prefix: string) {
  await database.executor.batch([
    stmt(
      `INSERT INTO source (id, org_id, name, ecosystem, type)
       VALUES (?, ?, ?, 'composer', 'composer_repository')`,
      sourceId,
      orgId,
      sourceId,
    ),
    stmt(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
       SELECT ? || i, ?, ?, 'composer', ? || i, ? FROM n`,
      count,
      `${prefix}-id`,
      orgId,
      sourceId,
      `${prefix}/p`,
      OLD,
    ),
  ]);
}

async function openSession(marked: number) {
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
    await reconciler.markListing(ctx, guard, {
      scope,
      stamp,
      present: names.slice(at, at + 1000),
    });
  }
  return { handle, guard, stamp, scope, reconciler };
}

const statuses = () =>
  database.executor.all<{ status: string; n: number }>(
    stmt(
      "SELECT status, count(*) AS n FROM package WHERE source_id = 'S' GROUP BY status ORDER BY status",
    ),
  );
const tables = () =>
  Promise.all(
    ['package', 'version', 'version_revision', 'cache_epoch'].map((table) =>
      database.executor.all(stmt(`SELECT * FROM ${table} ORDER BY 1`)),
    ),
  );

describe('source finalize applies the mass-removal share inside the batch', () => {
  it('refuses when the caller evidence understates the unseen rows', async () => {
    await seedPackages(ctx.orgId, 'S', 10, 'acme');
    const { handle } = await openSession(2);
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
    expect(observability.log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'ingest.mass_absence',
      reason_code: 'mass_absence',
    });
  });

  it('a row that becomes unseen between the pre-check and the batch cannot bypass the share', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    const { handle } = await openSession(4);
    const before = await tables();
    let raced = false;
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        if (!raced) {
          raced = true;
          await database.executor.batch([
            stmt(
              `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
               INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
               SELECT 'late' || i, ?, 'S', 'composer', 'late/p' || i, ? FROM n`,
              ctx.orgId,
              OLD,
            ),
          ]);
        }
        return database.executor.batch(statements);
      },
    };
    const observability = { counter: vi.fn(), log: vi.fn() };
    expect(
      await createIngestFinalizer(racing, { observability, minPackages: 0 }).finalize(
        ctx,
        handle,
        honest(4, 0),
      ),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    const after = await statuses();
    expect(after).toEqual([{ status: 'active', n: 8 }]);
    expect((await tables()).map((rows, index) => (index === 0 ? rows.length : rows))).toEqual([
      8,
      ...before.slice(1),
    ]);
    expect(observability.counter).toHaveBeenCalledTimes(1);
  });

  it('exempts a source still below the minimum after rows become unseen inside the batch', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    const { handle } = await openSession(4);
    const before = await tables();
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        await database.executor.batch([
          stmt(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
             INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
             SELECT 'late' || i, ?, 'S', 'composer', 'late/p' || i, ? FROM n`,
            ctx.orgId,
            OLD,
          ),
        ]);
        return database.executor.batch(statements);
      },
    };
    const observability = { counter: vi.fn(), log: vi.fn() };
    expect(
      await createIngestFinalizer(racing, { observability }).finalize(ctx, handle, honest(4, 0)),
    ).toMatchObject({ status: 'complete' });
    const after = await statuses();
    expect(after).toEqual([
      { status: 'active', n: 4 },
      { status: 'removed_upstream', n: 4 },
    ]);
    expect((await tables()).map((rows, index) => (index === 0 ? rows.length : rows))).toEqual([
      8,
      ...before.slice(1),
    ]);
    expect(observability.counter).not.toHaveBeenCalled();
  });

  const lateRows = (count: number) =>
    stmt(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
       SELECT 'late' || i, ?, 'S', 'composer', 'late/p' || i, ? FROM n`,
      count,
      ctx.orgId,
      OLD,
    );

  it.each([
    [
      'the listing was re-opened',
      "UPDATE source SET listing_open_stamp = '2999-01-01T00:00:00.000Z'",
    ],
    [
      'the session lease expired',
      "UPDATE ingest_session SET lease_until = '2000-01-01T00:00:00.000Z'",
    ],
  ])(
    'reports superseded, not mass_absence, when %s while the share is high',
    async (_name, change) => {
      await seedPackages(ctx.orgId, 'S', 4, 'acme');
      const { handle } = await openSession(4);
      const racing: SqlExecutor = {
        ...database.executor,
        async batch(statements) {
          await database.executor.batch([lateRows(4), stmt(change)]);
          return database.executor.batch(statements);
        },
      };
      const observability = { counter: vi.fn(), log: vi.fn() };
      expect(
        await createIngestFinalizer(racing, { observability, minPackages: 0 }).finalize(
          ctx,
          handle,
          honest(4, 0),
        ),
      ).toEqual({ status: 'refused', reason: 'superseded' });
      expect(observability.counter).not.toHaveBeenCalled();
      expect(await statuses()).toEqual([{ status: 'active', n: 8 }]);
    },
  );

  it('classifies the re-probe with a non-default share', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    const { handle } = await openSession(4);
    let raced = false;
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        if (!raced) {
          raced = true;
          await database.executor.batch([lateRows(5)]);
        }
        return database.executor.batch(statements);
      },
    };
    expect(
      await createIngestFinalizer(racing, { maxAbsenceShare: 0.5, minPackages: 0 }).finalize(
        ctx,
        handle,
        honest(4, 0),
      ),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await statuses()).toEqual([{ status: 'active', n: 9 }]);
  });

  it('exempts a source below the minimum with a non-default share', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    const { handle } = await openSession(4);
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        await database.executor.batch([lateRows(5)]);
        return database.executor.batch(statements);
      },
    };
    expect(
      await createIngestFinalizer(racing, { maxAbsenceShare: 0.5 }).finalize(
        ctx,
        handle,
        honest(4, 0),
      ),
    ).toMatchObject({ status: 'complete' });
    expect(await statuses()).toEqual([
      { status: 'active', n: 4 },
      { status: 'removed_upstream', n: 5 },
    ]);
  });

  it('a listing change between the pre-check and the batch refuses as superseded', async () => {
    await seedPackages(ctx.orgId, 'S', 5, 'acme');
    const { handle } = await openSession(4);
    const racing: SqlExecutor = {
      ...database.executor,
      async batch(statements) {
        await database.executor.batch([
          stmt("UPDATE package SET listing_seen_stamp = NULL WHERE name = 'acme/p1'"),
        ]);
        return database.executor.batch(statements);
      },
    };
    expect(await createIngestFinalizer(racing).finalize(ctx, handle, honest(4, 1))).toEqual({
      status: 'refused',
      reason: 'superseded',
    });
    expect(await statuses()).toEqual([{ status: 'active', n: 5 }]);
  });

  it('allows exactly the maximum share and removes only the unseen rows', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    const { handle } = await openSession(3);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(3, 1)),
    ).toMatchObject({ status: 'complete' });
    expect(await statuses()).toEqual([
      { status: 'active', n: 3 },
      { status: 'removed_upstream', n: 1 },
    ]);
  });

  it('ignores unseen rows of other organizations and other sources', async () => {
    await seedPackages(ctx.orgId, 'S', 4, 'acme');
    await seedPackages(ctx.orgId, 'OTHER', 50, 'other');
    await seedPackages(database.orgs!.b.orgId, 'FOREIGN', 50, 'foreign');
    const { handle } = await openSession(3);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, honest(3, 1)),
    ).toMatchObject({ status: 'complete' });
  });

  it('decides on large seeded sources at the share boundary', async () => {
    await seedPackages(ctx.orgId, 'S', 2000, 'acme');
    const { handle } = await openSession(1500);
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, lying(1500)),
    ).toEqual({ status: 'complete', empty: false, validatorsPublished: 0, leaseHeldBack: 0 });
    expect(await statuses()).toEqual([
      { status: 'active', n: 1500 },
      { status: 'removed_upstream', n: 500 },
    ]);
  });

  it('refuses one row above the maximum share on a large seeded source', async () => {
    await seedPackages(ctx.orgId, 'S', 2000, 'acme');
    const { handle } = await openSession(1499);
    const before = await tables();
    expect(
      await createIngestFinalizer(database.executor).finalize(ctx, handle, lying(1499)),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await tables()).toEqual(before);
  });

  it('the reconciler refuses a finalize whose evidence understates the unseen rows', async () => {
    await seedPackages(ctx.orgId, 'S', 10, 'acme');
    const { guard, stamp } = await openSession(2);
    const reconciler = createCatalogueReconciler(database.executor, { countUnseen: true });
    const before = await tables();
    await expect(
      reconciler.finalizeListing(
        ctx,
        guard,
        completeSourceListing({ sourceId: 'S', stamp, count: 2 }),
        { attemptedCandidates: 2, successfulCandidates: 2, definitiveAbsent: 0 },
      ),
    ).rejects.toBeInstanceOf(DbError);
    expect(await tables()).toEqual(before);
  });
});

describe('markListing reports the newly marked rows', () => {
  it.each(['source', 'package'] as const)('counts only rows not yet marked (%s)', async (kind) => {
    await seedPackages(ctx.orgId, 'S', 3, 'acme');
    await database.executor.batch([
      stmt(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
         INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
           published_at_basis, metadata_json, updated_at)
         SELECT 'v' || i, ?, 'acme-id1', '1.0.' || i, '1.0.' || i, ?, 'release_date', '{}', ?
         FROM n`,
        ctx.orgId,
        OLD,
        OLD,
      ),
    ]);
    const sessions = createIngestSessions(database.executor);
    const handle = await sessions.acquire(
      ctx,
      kind === 'source'
        ? { scope: 'source', sourceId: 'S' }
        : { scope: 'package', sourceId: 'S', packageKey: 'acme/p1' },
      'worker',
      60,
    );
    if (handle === 'held') throw new Error('held');
    const guard = createIngestSessionWriteGuard(ctx, handle);
    const scope =
      kind === 'source'
        ? ({ kind, sourceId: 'S' } as const)
        : ({ kind, packageId: 'acme-id1' } as const);
    const key = (i: number) => (kind === 'source' ? `acme/p${String(i)}` : `1.0.${String(i)}`);
    const reconciler = createCatalogueReconciler(database.executor);
    const { stamp } = await reconciler.openListing(ctx, guard, scope);
    const mark = (...present: string[]) =>
      reconciler.markListing(ctx, guard, { scope, stamp, present });
    expect(await mark(key(1), key(2))).toMatchObject({ changed: true, marked: 2 });
    expect(await mark(key(1), key(2))).toMatchObject({ changed: false, marked: 0 });
    expect(await mark(key(2), key(3))).toMatchObject({ changed: true, marked: 1 });
  });
});
