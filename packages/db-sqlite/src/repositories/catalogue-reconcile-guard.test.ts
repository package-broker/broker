import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizeEvidence, ListingScope } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { createIngestSessions, createIngestSessionWriteGuard } from './ingest-session.js';

let database: MigratedDatabase;
let ctx: OrgContext;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const evidence = (successfulCandidates: number, definitiveAbsent: number): FinalizeEvidence => ({
  attemptedCandidates: successfulCandidates + definitiveAbsent,
  successfulCandidates,
  definitiveAbsent,
});
const snapshot = () =>
  Promise.all(
    [
      'source',
      'package',
      'version',
      'version_revision',
      'blob',
      'cache_epoch',
      'upstream_state',
      'ingest_session',
    ].map((table) => database.executor.all(stmt(`SELECT * FROM ${table} ORDER BY 1`))),
  );

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  ctx = database.orgs!.a;
});
afterEach(async () => {
  await database.close();
});

async function fixture(ecosystem: 'npm' | 'composer', kind: 'source' | 'package', present: number) {
  await database.executor.batch([
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'source', ?, ?)",
      ctx.orgId,
      ecosystem,
      ecosystem === 'npm' ? 'npm_registry' : 'composer_repository',
    ),
    ...Array.from({ length: kind === 'source' ? 5 : 1 }, (_, index) =>
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, 'S', ?, ?, '2020-01-01T00:00:00.000Z')",
        `P${index}`,
        ctx.orgId,
        ecosystem,
        `key${index}`,
      ),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      stmt(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        `B${index}`,
        ctx.orgId,
        String(index).repeat(64),
        `blob${index}`,
      ),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
        published_at_basis, metadata_json, updated_at, blob_id)
       VALUES (?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z', 'release_date', '{}', '2020-01-01T00:00:00.000Z', ?)`,
        `V${index}`,
        ctx.orgId,
        kind === 'source' ? `P${index}` : 'P0',
        `1.0.${index}`,
        `1.0.${index}`,
        `B${index}`,
      ),
    ),
  ]);
  const sessions = createIngestSessions(database.executor);
  const handle = await sessions.acquire(
    ctx,
    kind === 'source'
      ? { scope: 'source', sourceId: 'S' }
      : { scope: 'package', sourceId: 'S', packageKey: 'key0' },
    'worker',
    60,
  );
  if (handle === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, handle);
  const scope: ListingScope =
    kind === 'source' ? { kind, sourceId: 'S' } : { kind, packageId: 'P0' };
  const reconciler = createCatalogueReconciler(database.executor);
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, handle, { snapshot: { id: 'snapshot' }, stamp });
  if (present > 0)
    await reconciler.markListing(ctx, guard, {
      scope,
      stamp,
      present: Array.from({ length: present }, (_, i) =>
        kind === 'source' ? `key${i}` : `1.0.${i}`,
      ),
    });
  return { guard, scope, stamp };
}

describe.each(['npm', 'composer'] as const)('%s direct reconciliation guard', (ecosystem) => {
  it.each(['source', 'package'] as const)(
    'stops above-share %s reconciliation without writes',
    async (kind) => {
      const { guard, scope, stamp } = await fixture(ecosystem, kind, 2);
      const listing =
        scope.kind === 'source'
          ? completeSourceListing({ sourceId: 'S', stamp, count: 2 })
          : completeVersionListing({ packageId: 'P0', stamp, count: 2 });
      const before = await snapshot();
      const batch = vi.fn(database.executor.batch.bind(database.executor));
      const executor: SqlExecutor = { ...database.executor, batch };
      const observability = { counter: vi.fn(), log: vi.fn() };
      await expect(
        createCatalogueReconciler(executor, { observability }).finalizeListing(
          ctx,
          guard,
          listing,
          evidence(2, 3),
        ),
      ).rejects.toThrow('sync stopped');
      expect(batch).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(observability.counter).toHaveBeenCalledTimes(1);
      expect(observability.log).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['source', 'package'] as const)('allows below-share %s reconciliation', async (kind) => {
    const { guard, scope, stamp } = await fixture(ecosystem, kind, 4);
    const listing =
      scope.kind === 'source'
        ? completeSourceListing({ sourceId: 'S', stamp, count: 4 })
        : completeVersionListing({ packageId: 'P0', stamp, count: 4 });
    expect(
      await createCatalogueReconciler(database.executor).finalizeListing(
        ctx,
        guard,
        listing,
        evidence(4, 1),
      ),
    ).toMatchObject({ removed: 1 });
    expect(
      (
        await database.executor.all<{ status: string }>(
          stmt('SELECT status FROM version ORDER BY id'),
        )
      ).map((row) => row.status),
    ).toEqual(['active', 'active', 'active', 'active', 'removed_upstream']);
  });
});

it('direct reconciliation rejects missing candidate evidence', async () => {
  const { guard, stamp } = await fixture('npm', 'package', 1);
  const before = await snapshot();
  await expect(
    createCatalogueReconciler(database.executor).finalizeListing(
      ctx,
      guard,
      completeVersionListing({ packageId: 'P0', stamp, count: 1 }),
      undefined as never,
    ),
  ).rejects.toThrow(RangeError);
  expect(await snapshot()).toEqual(before);
});

it('direct reconciliation rejects all-failed candidates', async () => {
  const { guard, stamp } = await fixture('npm', 'package', 1);
  const before = await snapshot();
  await expect(
    createCatalogueReconciler(database.executor).finalizeListing(
      ctx,
      guard,
      completeVersionListing({ packageId: 'P0', stamp, count: 1 }),
      { attemptedCandidates: 5, successfulCandidates: 0, definitiveAbsent: 0 },
    ),
  ).rejects.toThrow('no successful candidates');
  expect(await snapshot()).toEqual(before);
});
