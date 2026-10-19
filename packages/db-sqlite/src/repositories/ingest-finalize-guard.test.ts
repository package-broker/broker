import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizeEvidence, ListingScope } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import { createIngestFinalizer } from './ingest-finalize.js';
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
  return handle;
}

describe.each(['npm', 'composer'] as const)('%s ingest mass-removal guard', (ecosystem) => {
  it.each(['source', 'package'] as const)(
    'stops above-share %s finalize before any batch',
    async (kind) => {
      const session = await fixture(ecosystem, kind, 2);
      const before = await snapshot();
      const batch = vi.fn(database.executor.batch.bind(database.executor));
      const executor: SqlExecutor = { ...database.executor, batch };
      const observability = { counter: vi.fn(), log: vi.fn() };
      expect(
        await createIngestFinalizer(executor, { observability }).finalize(ctx, session, {
          expectedCount: 2,
          upstreamComplete: true,
          validatorTtlSeconds: 60,
          ...evidence(2, 3),
        }),
      ).toEqual({ status: 'refused', reason: 'mass_absence' });
      expect(batch).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(observability.counter).toHaveBeenCalledTimes(1);
      expect(observability.log).toHaveBeenCalledWith({
        level: 'warn',
        event: 'ingest.mass_absence',
        reason_code: 'mass_absence',
      });
    },
  );

  it.each(['source', 'package'] as const)(
    'allows below-share %s finalize and removes absent keys',
    async (kind) => {
      const session = await fixture(ecosystem, kind, 4);
      expect(
        await createIngestFinalizer(database.executor).finalize(ctx, session, {
          expectedCount: 4,
          upstreamComplete: true,
          validatorTtlSeconds: 60,
          ...evidence(4, 1),
        }),
      ).toMatchObject({ status: 'complete' });
      const rows = await database.executor.all<{ status: string }>(
        stmt('SELECT status FROM version ORDER BY id'),
      );
      expect(rows.map((row) => row.status)).toEqual([
        'active',
        'active',
        'active',
        'active',
        'removed_upstream',
      ]);
    },
  );
});

it('an authenticated empty listing completes without sweeping active versions', async () => {
  const session = await fixture('npm', 'package', 0);
  const before = await snapshot();
  expect(
    await createIngestFinalizer(database.executor).finalize(ctx, session, {
      expectedCount: 0,
      upstreamComplete: true,
      validatorTtlSeconds: 60,
      ...evidence(0, 0),
    }),
  ).toMatchObject({ status: 'complete', empty: true });
  const after = await snapshot();
  expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  expect(after.at(-1)?.[0]).toMatchObject({ state: 'complete' });
});

it('all-failed candidates cannot finalize or purge anything', async () => {
  const session = await fixture('npm', 'package', 0);
  await database.executor.batch([
    stmt(
      "UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z' WHERE id = 'V0'",
    ),
  ]);
  const before = await snapshot();
  expect(
    await createIngestFinalizer(database.executor).finalize(ctx, session, {
      expectedCount: 0,
      upstreamComplete: true,
      validatorTtlSeconds: 60,
      attemptedCandidates: 5,
      successfulCandidates: 0,
      definitiveAbsent: 0,
    }),
  ).toEqual({ status: 'refused', reason: 'no_success' });
  expect(await snapshot()).toEqual(before);
});

it('missing candidate evidence fails closed before finalize', async () => {
  const session = await fixture('npm', 'package', 1);
  const before = await snapshot();
  await expect(
    createIngestFinalizer(database.executor).finalize(ctx, session, {
      expectedCount: 1,
      upstreamComplete: true,
      validatorTtlSeconds: 60,
    } as never),
  ).rejects.toThrow(RangeError);
  expect(await snapshot()).toEqual(before);
});
