import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CatalogueWriteGuard, ListingScope } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createCatalogueWriter } from './catalogue-writer.js';

const OLD = '2020-01-01T00:00:00.000Z';
let database: MigratedDatabase;
let ctx: OrgContext;
let guard: CatalogueWriteGuard;
let batches: (readonly Statement[])[];
let databaseNow: string | undefined;
let writer: ReturnType<typeof createCatalogueWriter>;
const statement = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const run = (...statements: Statement[]) => database.executor.batch(statements);
const rows = (table: string) =>
  database.executor.all(statement(`SELECT * FROM ${table} ORDER BY 1`));
const pkg = async () =>
  (await database.executor.all(statement("SELECT * FROM package WHERE id = 'P'")))[0]!;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  ctx = database.orgs!.a;
  batches = [];
  databaseNow = undefined;
  writer = createCatalogueWriter({
    driver: database.executor.driver,
    all: () => {
      throw new Error('catalogue writes must use batches');
    },
    batch: (statements) => {
      expect(statements.every((s) => s.params.length <= 100)).toBe(true);
      batches.push(statements);
      return database.executor.batch(
        databaseNow === undefined
          ? statements
          : statements.map((s) => ({
              ...s,
              sql: s.sql.replaceAll("'now'", `'${databaseNow}'`),
            })),
      );
    },
  });
  await run(
    statement(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'sync:v1', 'J', 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
      ctx.orgId,
    ),
    statement(
      "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES ('S', ?, 'source', 'npm', 'npm_registry', 'exclude')",
      ctx.orgId,
    ),
    statement(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('P', ?, 'S', 'npm', 'widget', ?), ('Q', ?, 'S', 'npm', 'other', ?)",
      ctx.orgId,
      OLD,
      ctx.orgId,
      OLD,
    ),
    ...['1.0.0', '2.0.0', '3.0.0'].map((v) =>
      statement(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES (?, ?, 'P', ?, ?, ?, 'release_date', '{}', ?)",
        v,
        ctx.orgId,
        v,
        v,
        OLD,
        OLD,
      ),
    ),
  );
  guard = createCatalogueWriteGuard(ctx, { id: 'J', owner: 'worker', fence: 1 });
});
afterEach(async () => {
  await database.close();
});

async function listing(scope: ListingScope, present: string[]) {
  const { stamp } = await writer.openListing(ctx, guard, scope);
  await writer.markListing(ctx, guard, { scope, stamp, present });
  return scope.kind === 'source'
    ? completeSourceListing({ sourceId: scope.sourceId, stamp, count: present.length })
    : completeVersionListing({ packageId: scope.packageId, stamp, count: present.length });
}
async function absenceEvidence() {
  await run(
    statement(
      "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at) VALUES (?, 'P', 'npm-packument', ?, ?, 2, ?)",
      ctx.orgId,
      OLD,
      OLD,
      OLD,
    ),
  );
}

it('records document absence and revives an npm package without changing its source marker', async () => {
  await absenceEvidence();
  await writer.markPackageAbsent(ctx, guard, { packageId: 'P' });
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'document_absent',
  });
  const marker = (await pkg())['updated_at'];
  await writer.finalizeListing(
    ctx,
    guard,
    await listing({ kind: 'package', packageId: 'P' }, ['1.0.0']),
  );
  expect(await pkg()).toMatchObject({
    status: 'active',
    removal_cause: null,
    removed_upstream_at: null,
    updated_at: marker,
  });
  expect((await rows('version')).map((v) => v['status'])).toEqual([
    'active',
    'removed_upstream',
    'removed_upstream',
  ]);
});

it('rejects a marked package listing when a newer document absence removes the package', async () => {
  const scope = { kind: 'package', packageId: 'P' } as const;
  const stale = await listing(scope, ['1.0.0']);
  await absenceEvidence();
  await expect(writer.markPackageAbsent(ctx, guard, { packageId: 'P' })).resolves.toMatchObject({
    changed: true,
  });
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'document_absent',
  });
  expect((await rows('version')).every((v) => v['status'] === 'removed_upstream')).toBe(true);
  const snapshot = () =>
    Promise.all(['package', 'version', 'version_revision', 'cache_epoch'].map(rows));
  const before = await snapshot();
  await expect(writer.finalizeListing(ctx, guard, stale)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await expect(
    writer.markListing(ctx, guard, { scope, stamp: stale.stamp, present: ['2.0.0'] }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);

  const fresh = await listing(scope, ['1.0.0']);
  expect(fresh.stamp > stale.stamp).toBe(true);
  await writer.finalizeListing(ctx, guard, fresh);
  expect(await pkg()).toMatchObject({ status: 'active', removal_cause: null });
  expect((await rows('version')).map((v) => v['status'])).toEqual([
    'active',
    'removed_upstream',
    'removed_upstream',
  ]);
});

it('invalidates a marked listing when eligible absence changes no statuses', async () => {
  await absenceEvidence();
  await writer.markPackageAbsent(ctx, guard, { packageId: 'P' });
  const scope = { kind: 'package', packageId: 'P' } as const;
  const stale = await listing(scope, ['1.0.0']);
  const beforeAbsence = await pkg();
  const revisions = await rows('version_revision');
  const epoch = await rows('cache_epoch');
  await expect(writer.markPackageAbsent(ctx, guard, { packageId: 'P' })).resolves.toMatchObject({
    changed: false,
  });
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'document_absent',
    rev: beforeAbsence['rev'],
    modified_at: beforeAbsence['modified_at'],
  });
  expect(await rows('version_revision')).toEqual(revisions);
  expect(await rows('cache_epoch')).toEqual(epoch);
  const snapshot = () =>
    Promise.all(['package', 'version', 'version_revision', 'cache_epoch'].map(rows));
  const before = await snapshot();
  await expect(writer.finalizeListing(ctx, guard, stale)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await expect(
    writer.markListing(ctx, guard, { scope, stamp: stale.stamp, present: ['2.0.0'] }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const fresh = await listing(scope, ['1.0.0']);
  expect(fresh.stamp > stale.stamp).toBe(true);
  await writer.finalizeListing(ctx, guard, fresh);
  expect(await pkg()).toMatchObject({ status: 'active', removal_cause: null });
  expect((await rows('version')).map((v) => v['status'])).toEqual([
    'active',
    'removed_upstream',
    'removed_upstream',
  ]);
});

it.each(['source', 'package'] as const)(
  'preserves a post-open insertion after rapid consecutive %s opens',
  async (kind) => {
    // Freeze database time so every open and the later insert share one millisecond.
    databaseNow = '2026-10-18T12:00:00.000Z';
    const scope = kind === 'source' ? { kind, sourceId: 'S' } : { kind, packageId: 'P' };
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) {
      stamps.push((await writer.openListing(ctx, guard, scope)).stamp);
    }
    expect(new Set(stamps).size).toBe(4);
    const stamp = stamps.at(-1)!;
    await writer.markListing(ctx, guard, {
      scope,
      stamp,
      present: [kind === 'source' ? 'widget' : '1.0.0'],
    });
    if (kind === 'source') {
      await run(
        statement(
          "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('R', ?, 'S', 'npm', 'fresh', ?)",
          ctx.orgId,
          databaseNow,
        ),
      );
    } else {
      await run(
        statement(
          "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES ('4.0.0', ?, 'P', '4.0.0', '4.0.0', ?, 'release_date', '{}', ?)",
          ctx.orgId,
          OLD,
          databaseNow,
        ),
      );
    }
    const proof =
      kind === 'source'
        ? completeSourceListing({ sourceId: 'S', stamp, count: 1 })
        : completeVersionListing({ packageId: 'P', stamp, count: 1 });
    await writer.finalizeListing(ctx, guard, proof);
    const table = kind === 'source' ? 'package' : 'version';
    const added = (await rows(table)).find((row) =>
      kind === 'source' ? row['id'] === 'R' : row['version'] === '4.0.0',
    );
    expect(added).toMatchObject({
      status: 'active',
      listing_seen_stamp: null,
      updated_at: databaseNow,
    });
    expect((await rows(table)).some((row) => row['status'] === 'removed_upstream')).toBe(true);
  },
);

it('source removal cascades once, preserves protected versions, and only the source revives a Composer package', async () => {
  await run(
    statement(
      "UPDATE source SET ecosystem = 'composer', type = 'composer_repository' WHERE id = 'S'",
    ),
    statement("UPDATE package SET ecosystem = 'composer'"),
    statement("UPDATE version SET status = 'quarantined' WHERE id = '3.0.0'"),
    statement('CREATE TABLE epoch_bumps (value TEXT)'),
    statement(
      'CREATE TRIGGER count_epoch_bumps AFTER UPDATE ON cache_epoch BEGIN INSERT INTO epoch_bumps VALUES (new.version); END',
    ),
  );
  const source = await listing({ kind: 'source', sourceId: 'S' }, ['other']);
  await writer.finalizeListing(ctx, guard, source);
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'source_listing',
  });
  expect((await rows('version')).map((v) => v['status'])).toEqual([
    'removed_upstream',
    'removed_upstream',
    'quarantined',
  ]);
  expect(await rows('version_revision')).toHaveLength(2);
  expect(await rows('epoch_bumps')).toHaveLength(1);
  await writer.finalizeListing(ctx, guard, source);
  expect(await rows('epoch_bumps')).toHaveLength(1);
  await writer.finalizeListing(
    ctx,
    guard,
    await listing({ kind: 'package', packageId: 'P' }, ['1.0.0']),
  );
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'source_listing',
  });
  await writer.finalizeListing(
    ctx,
    guard,
    await listing({ kind: 'source', sourceId: 'S' }, ['widget', 'other']),
  );
  expect(await pkg()).toMatchObject({ status: 'active', removal_cause: null });
  expect((await rows('version'))[1]?.['status']).toBe('removed_upstream');
});

it.each(['source', 'package'] as const)(
  'rejects a %s listing from a superseded open and both count mismatches atomically',
  async (kind) => {
    const scope = kind === 'source' ? { kind, sourceId: 'S' } : { kind, packageId: 'P' };
    const present = kind === 'source' ? ['widget', 'other'] : ['1.0.0', '2.0.0'];
    const stale = await listing(scope, present);
    const current = await writer.openListing(ctx, guard, scope);
    expect(current.stamp).not.toBe(stale.stamp);
    const snapshot = () =>
      Promise.all(['package', 'version', 'version_revision', 'cache_epoch'].map(rows));
    const before = await snapshot();
    await expect(writer.finalizeListing(ctx, guard, stale)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await expect(
      writer.markListing(ctx, guard, { scope, stamp: stale.stamp, present }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await writer.markListing(ctx, guard, { scope, stamp: current.stamp, present });
    for (const proof of [
      ...[1, 3].map((count) =>
        kind === 'source'
          ? completeSourceListing({ sourceId: 'S', stamp: current.stamp, count })
          : completeVersionListing({ packageId: 'P', stamp: current.stamp, count }),
      ),
    ]) {
      const before = await Promise.all(
        ['package', 'version', 'version_revision', 'cache_epoch'].map(rows),
      );
      await expect(writer.finalizeListing(ctx, guard, proof)).rejects.toThrow();
      expect(
        await Promise.all(['package', 'version', 'version_revision', 'cache_epoch'].map(rows)),
      ).toEqual(before);
    }
    expect(() =>
      completeVersionListing({ packageId: 'P', stamp: current.stamp, count: 0 }),
    ).toThrow();
  },
);

it('leaves a refused stored version unmarked and removes it using the successful-run count', async () => {
  const scope = { kind: 'package', packageId: 'P' } as const;
  const { stamp } = await writer.openListing(ctx, guard, scope);
  const input = (version: string, sourceRef: string | null) => ({
    version,
    versionNormalized: version,
    license: null,
    upstreamReleasedAt: null,
    history: { at: OLD, basis: 'release_date' as const },
    distType: null,
    sourceRef,
    metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  });
  const result = await writer.syncPackage(ctx, guard, {
    sourceId: 'S',
    ecosystem: 'npm',
    key: 'widget',
    description: null,
    versions: [input('1.0.0', null), input('2.0.0', 'x'.repeat(5000))],
  });
  expect(result.refused).toEqual([{ version: '2.0.0', reason: 'invalid' }]);
  await writer.markListing(ctx, guard, { scope, stamp, present: ['1.0.0'] });
  await writer.finalizeListing(
    ctx,
    guard,
    completeVersionListing({ packageId: 'P', stamp, count: 2 - result.refused.length }),
  );
  expect((await rows('version'))[1]).toMatchObject({ status: 'removed_upstream', updated_at: OLD });
});

it('decides absence eligibility once and derives the cascade and epoch from that operation', async () => {
  await absenceEvidence();
  await writer.markPackageAbsent(ctx, guard, { packageId: 'P' });
  const statements = batches.at(-1)!;
  expect(statements.filter((s) => s.sql.includes('first_not_found_at'))).toHaveLength(1);
  const decision = statements.findIndex((s) => s.sql.includes('first_not_found_at'));
  expect(statements[decision]?.sql).toMatch(/UPDATE package/);
  const later = statements.slice(decision + 1);
  expect(
    later.some((s) => s.sql.includes('version_revision') && s.sql.includes('last_op_id')),
  ).toBe(true);
  expect(
    later.some((s) => s.sql.includes('UPDATE cache_epoch') && s.sql.includes('last_op_id')),
  ).toBe(true);
});

it('source absence supersedes document absence before a version listing can revive the package', async () => {
  await absenceEvidence();
  await writer.markPackageAbsent(ctx, guard, { packageId: 'P' });
  await writer.finalizeListing(
    ctx,
    guard,
    await listing({ kind: 'source', sourceId: 'S' }, ['other']),
  );
  expect(await pkg()).toMatchObject({ removal_cause: 'source_listing' });
  await writer.finalizeListing(
    ctx,
    guard,
    await listing({ kind: 'package', packageId: 'P' }, ['1.0.0']),
  );
  expect(await pkg()).toMatchObject({
    status: 'removed_upstream',
    removal_cause: 'source_listing',
  });
});
