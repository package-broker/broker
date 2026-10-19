import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  ABSENCE_MIN_NOT_FOUND,
  type CatalogueWriteGuard,
  type VersionInput,
} from '@package-broker/core/db/catalogue';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import { createCatalogueReconciler, type CatalogueReconciler } from './catalogue-reconcile.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S01';
const EXCLUDE_SOURCE = '01J0SRC0000000000000000S02';
const PACKAGE = '01J0PKG0000000000000000K01';
const PACKAGE_B = '01J0PKG0000000000000000K02';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let guard: CatalogueWriteGuard;
let reconciler: CatalogueReconciler;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

const run = (...statements: Statement[]) => database.executor.batch(statements);

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  await run(
    stmt(
      `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
        VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
      JOB_ID,
      org.orgId,
      `k:${JOB_ID}`,
      OWNER,
      FUTURE,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
      SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type, removal_policy) VALUES (?, ?, 'excl', 'composer', 'composer_repository', 'exclude')",
      EXCLUDE_SOURCE,
      org.orgId,
    ),
    stmt(
      `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        VALUES (?, ?, ?, 'composer', 'acme/one', ?), (?, ?, ?, 'composer', 'acme/two', ?)`,
      PACKAGE,
      org.orgId,
      SOURCE,
      OLD,
      PACKAGE_B,
      org.orgId,
      SOURCE,
      OLD,
    ),
  );
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
  reconciler = createCatalogueReconciler(database.executor);
});

afterEach(async () => {
  await database.close();
});

async function seedVersions(packageId: string, ...names: string[]): Promise<void> {
  for (const name of names) {
    await run(
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'release_date', '{}', ?)`,
        `V-${packageId}-${name}`,
        org.orgId,
        packageId,
        name,
        name,
        OLD,
        OLD,
      ),
    );
  }
}

const statuses = (table: 'package' | 'version', where = '1=1') =>
  database.executor.all<{ k: string; status: string }>(
    stmt(
      `SELECT ${table === 'package' ? 'name' : 'id'} AS k, status FROM ${table} WHERE ${where} ORDER BY 1`,
    ),
  );

const scalar = async (sql: string, ...params: (string | number | null)[]) =>
  (await database.executor.all<{ v: unknown }>(stmt(sql, ...params)))[0]?.v;

const epoch = () => scalar('SELECT version AS v FROM cache_epoch WHERE org_id = ?', org.orgId);

async function sourceListing(present: readonly string[], sourceId = SOURCE) {
  const { stamp } = await reconciler.openListing(org, guard, { kind: 'source', sourceId });
  await reconciler.markListing(org, guard, {
    scope: { kind: 'source', sourceId },
    stamp,
    present,
  });
  return completeSourceListing({ sourceId, stamp, count: present.length });
}

describe('source listing reconciliation', () => {
  it('1: 1,001 names across two mark chunks all stay active', async () => {
    await run(
      stmt(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
          INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
          SELECT 'BULK' || i, ?, ?, 'composer', 'bulk/p' || i, ? FROM n`,
        org.orgId,
        EXCLUDE_SOURCE,
        OLD,
      ),
    );
    const names = Array.from({ length: 1001 }, (_, i) => `bulk/p${String(i + 1)}`);
    const { stamp } = await reconciler.openListing(org, guard, {
      kind: 'source',
      sourceId: EXCLUDE_SOURCE,
    });
    const scope = { kind: 'source', sourceId: EXCLUDE_SOURCE } as const;
    await reconciler.markListing(org, guard, { scope, stamp, present: names.slice(0, 1000) });
    const tail = await reconciler.markListing(org, guard, {
      scope,
      stamp,
      present: names.slice(1000),
    });
    expect(tail.changed).toBe(true);
    const result = await reconciler.finalizeListing(
      org,
      guard,
      completeSourceListing({ sourceId: EXCLUDE_SOURCE, stamp, count: 1001 }),
      { attemptedCandidates: 1001, successfulCandidates: 1001, definitiveAbsent: 0 },
    );
    expect(result).toMatchObject({ removed: 0, restored: 0 });
    expect(
      await scalar(
        "SELECT count(*) AS v FROM package WHERE source_id = ? AND status = 'active'",
        EXCLUDE_SOURCE,
      ),
    ).toBe(1001);
  });

  it('1: unseen packages are removed, seen removed ones are revived, per source', async () => {
    await run(
      stmt(
        "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?",
        OLD,
        PACKAGE_B,
      ),
    );
    const listing = await sourceListing(['acme/two']);
    const result = await reconciler.finalizeListing(org, guard, listing, {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(result).toMatchObject({ removed: 1, restored: 1 });
    expect(await statuses('package', `source_id = '${SOURCE}'`)).toEqual([
      { k: 'acme/one', status: 'removed_upstream' },
      { k: 'acme/two', status: 'active' },
    ]);
    expect(
      await scalar('SELECT removed_upstream_at AS v FROM package WHERE id = ?', PACKAGE_B),
    ).toBeNull();
    expect(await scalar('SELECT rev AS v FROM package WHERE id = ?', PACKAGE)).toBe(2);
  });

  it('2: without a finalize nothing is removed', async () => {
    await sourceListing(['acme/one']);
    expect((await statuses('package')).every((row) => row.status === 'active')).toBe(true);
  });

  it('2: an empty listing cannot be completed or finalized', async () => {
    const { stamp } = await reconciler.openListing(org, guard, {
      kind: 'source',
      sourceId: SOURCE,
    });
    expect(() => completeSourceListing({ sourceId: SOURCE, stamp, count: 0 })).toThrow();
    await expect(
      reconciler.finalizeListing(org, guard, { sourceId: SOURCE, stamp, count: 0 } as never, {
        attemptedCandidates: 0,
        successfulCandidates: 0,
        definitiveAbsent: 0,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('2: a finalize whose count exceeds the seen rows rolls back', async () => {
    const { stamp } = await reconciler.openListing(org, guard, {
      kind: 'source',
      sourceId: SOURCE,
    });
    await reconciler.markListing(org, guard, {
      scope: { kind: 'source', sourceId: SOURCE },
      stamp,
      present: ['acme/one'],
    });
    await expect(
      reconciler.finalizeListing(
        org,
        guard,
        completeSourceListing({ sourceId: SOURCE, stamp, count: 2 }),
        { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 0 },
      ),
    ).rejects.toThrow();
    expect((await statuses('package')).every((row) => row.status === 'active')).toBe(true);
  });

  it('2: finalize after lease takeover rolls back', async () => {
    const listing = await sourceListing(['acme/one']);
    await run(stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID));
    await expect(
      reconciler.finalizeListing(org, guard, listing, {
        attemptedCandidates: 1,
        successfulCandidates: 1,
        definitiveAbsent: 0,
      }),
    ).rejects.toThrow();
    expect((await statuses('package')).every((row) => row.status === 'active')).toBe(true);
  });

  it('2: mark and open also refuse a taken-over lease', async () => {
    const { stamp } = await reconciler.openListing(org, guard, {
      kind: 'source',
      sourceId: SOURCE,
    });
    await run(stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID));
    await expect(
      reconciler.markListing(org, guard, {
        scope: { kind: 'source', sourceId: SOURCE },
        stamp,
        present: ['acme/one'],
      }),
    ).rejects.toThrow();
    await expect(
      reconciler.openListing(org, guard, { kind: 'source', sourceId: SOURCE }),
    ).rejects.toThrow();
  });

  it('mark refuses oversize chunks, unknown keys, future stamps and another organization', async () => {
    const { stamp } = await reconciler.openListing(org, guard, {
      kind: 'source',
      sourceId: SOURCE,
    });
    const scope = { kind: 'source', sourceId: SOURCE } as const;
    await expect(
      reconciler.markListing(org, guard, {
        scope,
        stamp,
        present: Array.from({ length: 1001 }, (_, i) => `a/p${String(i)}`),
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reconciler.markListing(org, guard, { scope, stamp, present: ['acme/one', 'acme/missing'] }),
    ).rejects.toThrow();
    await expect(
      reconciler.markListing(org, guard, { scope, stamp: FUTURE, present: ['acme/one'] }),
    ).rejects.toThrow();
    await expect(
      reconciler.markListing(other, guard, { scope, stamp, present: ['acme/one'] }),
    ).rejects.toThrow(TypeError);
    expect(await scalar('SELECT updated_at AS v FROM package WHERE id = ?', PACKAGE)).toBe(OLD);
  });

  it('another organization cannot open or finalize this source', async () => {
    const foreign = createCatalogueWriteGuard(other, { id: JOB_ID, owner: OWNER, fence: 3 });
    await expect(
      reconciler.openListing(other, foreign, { kind: 'source', sourceId: SOURCE }),
    ).rejects.toThrow();
  });

  it('exclude policy bumps the epoch on removal, flag policy does not', async () => {
    await run(
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('EX1', ?, ?, 'composer', 'ex/one', ?), ('EX2', ?, ?, 'composer', 'ex/two', ?)",
        org.orgId,
        EXCLUDE_SOURCE,
        OLD,
        org.orgId,
        EXCLUDE_SOURCE,
        OLD,
      ),
    );
    const before = await epoch();
    await reconciler.finalizeListing(org, guard, await sourceListing(['acme/one']), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(await epoch()).toBe(before);
    await reconciler.finalizeListing(org, guard, await sourceListing(['ex/one'], EXCLUDE_SOURCE), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(await epoch()).not.toBe(before);
    expect(await scalar("SELECT status AS v FROM package WHERE id = 'EX2'")).toBe(
      'removed_upstream',
    );
  });
});

describe('version listing reconciliation', () => {
  const scope = (packageId: string) => ({ kind: 'package', packageId }) as const;

  async function versionListing(packageId: string, present: readonly string[]) {
    const { stamp } = await reconciler.openListing(org, guard, scope(packageId));
    await reconciler.markListing(org, guard, { scope: scope(packageId), stamp, present });
    return completeVersionListing({ packageId, stamp, count: present.length });
  }

  it('1: the same version string in two packages is reconciled per package', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0');
    await seedVersions(PACKAGE_B, '1.0.0', '2.0.0');
    const listing = await versionListing(PACKAGE, ['1.0.0']);
    await reconciler.finalizeListing(org, guard, listing, {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(await statuses('version')).toEqual([
      { k: `V-${PACKAGE}-1.0.0`, status: 'active' },
      { k: `V-${PACKAGE}-2.0.0`, status: 'removed_upstream' },
      { k: `V-${PACKAGE_B}-1.0.0`, status: 'active' },
      { k: `V-${PACKAGE_B}-2.0.0`, status: 'active' },
    ]);
  });

  it('removal and revival write revision rows with status reasons and bump the clocks', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0');
    await run(
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?",
        OLD,
        `V-${PACKAGE}-1.0.0`,
      ),
    );
    const result = await reconciler.finalizeListing(
      org,
      guard,
      await versionListing(PACKAGE, ['1.0.0']),
      { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 0 },
    );
    expect(result).toMatchObject({ removed: 1, restored: 1 });
    const revisions = await database.executor.all<{
      version_id: string;
      revision: number;
      reason: string;
    }>(stmt('SELECT version_id, revision, reason FROM version_revision ORDER BY version_id'));
    expect(revisions).toEqual([
      {
        version_id: `V-${PACKAGE}-1.0.0`,
        revision: 1,
        reason: 'status:removed_upstream>active:listing_present',
      },
      {
        version_id: `V-${PACKAGE}-2.0.0`,
        revision: 1,
        reason: 'status:active>removed_upstream:listing_absent',
      },
    ]);
    expect(
      await scalar('SELECT revision AS v FROM version WHERE id = ?', `V-${PACKAGE}-2.0.0`),
    ).toBe(2);
    expect(await scalar('SELECT rev AS v FROM package WHERE id = ?', PACKAGE)).toBe(2);
    expect(
      await scalar(
        'SELECT removed_upstream_at IS NOT NULL AS v FROM version WHERE id = ?',
        `V-${PACKAGE}-2.0.0`,
      ),
    ).toBe(1);
  });

  it('3: finalize sets last_synced_at without moving the clock when nothing changed; later inserts use broker time', async () => {
    await seedVersions(PACKAGE, '1.0.0');
    expect(
      await scalar('SELECT last_synced_at AS v FROM package WHERE id = ?', PACKAGE),
    ).toBeNull();
    await reconciler.finalizeListing(org, guard, await versionListing(PACKAGE, ['1.0.0']), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(
      await scalar('SELECT last_synced_at IS NOT NULL AS v FROM package WHERE id = ?', PACKAGE),
    ).toBe(1);
    expect(await scalar('SELECT rev AS v FROM package WHERE id = ?', PACKAGE)).toBe(1);
    const input: VersionInput = {
      version: '3.0.0',
      versionNormalized: '3.0.0.0',
      history: { at: OLD, basis: 'release_date' },
      license: null,
      upstreamReleasedAt: null,
      distType: 'zip',
      sourceRef: null,
      metadata: normalizeVersionMetadata('composer', {
        name: 'acme/one',
        dist: { type: 'zip', url: 'https://example.test/w.zip', shasum: 'a'.repeat(40) },
      }),
    };
    const plan = versionInsertStatements(org, guard, {
      packageId: PACKAGE,
      ecosystem: 'composer',
      versions: [input],
    });
    await database.executor.batch(plan.statements);
    expect(
      await scalar("SELECT published_at_basis AS v FROM version WHERE version = '3.0.0'"),
    ).toBe('broker');
  });

  it('3: removal under exclude bumps the epoch; under flag it does not', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0');
    const before = await epoch();
    await reconciler.finalizeListing(org, guard, await versionListing(PACKAGE, ['1.0.0']), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(await epoch()).toBe(before);
    await run(stmt('UPDATE package SET source_id = ? WHERE id = ?', EXCLUDE_SOURCE, PACKAGE));
    await run(
      stmt(
        "UPDATE version SET status = 'active', removed_upstream_at = NULL WHERE package_id = ?",
        PACKAGE,
      ),
    );
    await reconciler.finalizeListing(org, guard, await versionListing(PACKAGE, ['1.0.0']), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect(await epoch()).not.toBe(before);
  });

  it('2: quarantined and tombstoned versions are never touched', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0', '3.0.0');
    await run(
      stmt("UPDATE version SET status = 'quarantined' WHERE id = ?", `V-${PACKAGE}-2.0.0`),
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = ? WHERE id = ?",
        OLD,
        `V-${PACKAGE}-3.0.0`,
      ),
    );
    await reconciler.finalizeListing(org, guard, await versionListing(PACKAGE, ['1.0.0']), {
      attemptedCandidates: 1,
      successfulCandidates: 1,
      definitiveAbsent: 0,
    });
    expect((await statuses('version')).map((row) => row.status)).toEqual([
      'active',
      'quarantined',
      'tombstoned',
    ]);
  });

  it('2: a lease takeover rolls the whole finalize back, including last_synced_at', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0');
    const listing = await versionListing(PACKAGE, ['1.0.0']);
    await run(stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID));
    await expect(
      reconciler.finalizeListing(org, guard, listing, {
        attemptedCandidates: 1,
        successfulCandidates: 1,
        definitiveAbsent: 0,
      }),
    ).rejects.toThrow();
    expect(
      await scalar('SELECT last_synced_at AS v FROM package WHERE id = ?', PACKAGE),
    ).toBeNull();
    expect((await statuses('version')).every((row) => row.status === 'active')).toBe(true);
  });
});

describe('markPackageAbsent', () => {
  const evidence = (count: number, firstAt: string | null, form = 'composer-p2') =>
    stmt(
      `INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      org.orgId,
      PACKAGE,
      form,
      OLD,
      OLD,
      count,
      firstAt,
    );

  it('changes nothing below the not-found count or inside the minimum span', async () => {
    await seedVersions(PACKAGE, '1.0.0');
    await run(evidence(ABSENCE_MIN_NOT_FOUND - 1, OLD));
    expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
      changed: false,
    });
    await run(
      stmt(
        'UPDATE upstream_state SET not_found_count = ?, first_not_found_at = ?',
        ABSENCE_MIN_NOT_FOUND,
        new Date().toISOString(),
      ),
    );
    expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
      changed: false,
    });
    expect((await statuses('package', `id = '${PACKAGE}'`))[0]?.status).toBe('active');
    expect((await statuses('version'))[0]?.status).toBe('active');
  });

  it('changes nothing without evidence or while another form is still found', async () => {
    expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
      changed: false,
    });
    await run(evidence(ABSENCE_MIN_NOT_FOUND, OLD), evidence(0, null, 'composer-p2-dev'));
    expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
      changed: false,
    });
  });

  it('flags the package and its active versions once the evidence is old enough', async () => {
    await seedVersions(PACKAGE, '1.0.0');
    await run(evidence(ABSENCE_MIN_NOT_FOUND, OLD));
    const effect = await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE });
    expect(effect.changed).toBe(true);
    expect((await statuses('package', `id = '${PACKAGE}'`))[0]?.status).toBe('removed_upstream');
    expect((await statuses('version'))[0]?.status).toBe('removed_upstream');
    expect(await scalar('SELECT reason AS v FROM version_revision')).toBe(
      'status:active>removed_upstream:upstream_absent',
    );
    expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
      changed: false,
    });
  });

  it('refuses a taken-over lease', async () => {
    await run(
      evidence(ABSENCE_MIN_NOT_FOUND, OLD),
      stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID),
    );
    await expect(
      reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE }),
    ).rejects.toThrow();
    expect((await statuses('package', `id = '${PACKAGE}'`))[0]?.status).toBe('active');
  });
});

describe('reconciliation safeguards', () => {
  function sourceFiles(directory: URL): URL[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('only reconciliation writes package or version updated_at', () => {
    const writers = sourceFiles(new URL('../', import.meta.url)).filter((path) => {
      if (path.href === new URL('./catalogue-reconcile.ts', import.meta.url).href) return false;
      const source = readFileSync(path, 'utf8');
      const kyselyWrite =
        /\.updateTable\(\s*['"`](?:package|version)(?:\s+as\s+\w+)?['"`]\s*\)[^;]*?\.set\(\s*\{[^}]*\bupdated_at\s*:/s;
      const rawWrite =
        /\bUPDATE\s+["`]?\b(?:package|version)\b["`]?\s+(?:AS\s+\w+\s+)?SET\b(?:(?!\bWHERE\b|[;`]).)*\bupdated_at\s*=/is;
      return kyselyWrite.test(source) || rawWrite.test(source);
    });
    expect(writers.map((path) => path.pathname)).toEqual([]);
  });

  it.each(['source', 'package'] as const)(
    'a missing key rolls back the whole %s mark chunk',
    async (kind) => {
      await seedVersions(PACKAGE, '1.0.0', '2.0.0');
      const scope = kind === 'source' ? { kind, sourceId: SOURCE } : { kind, packageId: PACKAGE };
      const { stamp } = await reconciler.openListing(org, guard, scope);
      const table = kind === 'source' ? 'package' : 'version';
      const before = await database.executor.all(
        stmt(`SELECT id, updated_at FROM ${table} ORDER BY id`),
      );
      await expect(
        reconciler.markListing(org, guard, {
          scope,
          stamp,
          present:
            kind === 'source'
              ? ['acme/one', 'acme/two', 'acme/missing']
              : ['1.0.0', '2.0.0', 'missing'],
        }),
      ).rejects.toThrow();
      expect(
        await database.executor.all(stmt(`SELECT id, updated_at FROM ${table} ORDER BY id`)),
      ).toEqual(before);
    },
  );

  it.each(['source', 'package'] as const)('a replayed %s mark reports no change', async (kind) => {
    await seedVersions(PACKAGE, '1.0.0');
    const scope = kind === 'source' ? { kind, sourceId: SOURCE } : { kind, packageId: PACKAGE };
    const { stamp } = await reconciler.openListing(org, guard, scope);
    const input = { scope, stamp, present: [kind === 'source' ? 'acme/one' : '1.0.0'] };
    expect(await reconciler.markListing(org, guard, input)).toMatchObject({ changed: true });
    expect(await reconciler.markListing(org, guard, input)).toMatchObject({ changed: false });
  });

  it.each(['source', 'package'] as const)(
    'a replayed %s finalize adds no revisions or clock or epoch bumps',
    async (kind) => {
      await seedVersions(PACKAGE, '1.0.0', '2.0.0');
      await run(
        stmt('UPDATE package SET source_id = ? WHERE source_id = ?', EXCLUDE_SOURCE, SOURCE),
        stmt(
          "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?",
          OLD,
          PACKAGE,
        ),
        stmt(
          "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?",
          OLD,
          `V-${PACKAGE}-1.0.0`,
        ),
      );
      const scope =
        kind === 'source' ? { kind, sourceId: EXCLUDE_SOURCE } : { kind, packageId: PACKAGE };
      const { stamp } = await reconciler.openListing(org, guard, scope);
      await reconciler.markListing(org, guard, {
        scope,
        stamp,
        present: [kind === 'source' ? 'acme/one' : '1.0.0'],
      });
      const listing =
        kind === 'source'
          ? completeSourceListing({ sourceId: EXCLUDE_SOURCE, stamp, count: 1 })
          : completeVersionListing({ packageId: PACKAGE, stamp, count: 1 });
      expect(
        await reconciler.finalizeListing(org, guard, listing, {
          attemptedCandidates: 1,
          successfulCandidates: 1,
          definitiveAbsent: 0,
        }),
      ).toMatchObject({
        removed: 1,
        restored: 1,
      });
      const snapshot = async () => ({
        packages: await database.executor.all(
          stmt('SELECT id, status, rev, modified_at, removed_upstream_at FROM package ORDER BY id'),
        ),
        versions: await database.executor.all(stmt('SELECT * FROM version ORDER BY id')),
        revisions: await database.executor.all(stmt('SELECT * FROM version_revision ORDER BY id')),
        epoch: await epoch(),
      });
      const before = await snapshot();
      expect(
        await reconciler.finalizeListing(org, guard, listing, {
          attemptedCandidates: 1,
          successfulCandidates: 1,
          definitiveAbsent: 0,
        }),
      ).toMatchObject({
        removed: 0,
        restored: 0,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('a version inserted after open through the insert writer stays active even when unlisted', async () => {
    await seedVersions(PACKAGE, '1.0.0');
    const scope = { kind: 'package', packageId: PACKAGE } as const;
    const { stamp } = await reconciler.openListing(org, guard, scope);
    await reconciler.markListing(org, guard, { scope, stamp, present: ['1.0.0'] });
    const input: VersionInput = {
      version: '3.0.0',
      versionNormalized: '3.0.0.0',
      history: { at: OLD, basis: 'release_date' },
      license: null,
      upstreamReleasedAt: null,
      distType: 'zip',
      sourceRef: null,
      metadata: normalizeVersionMetadata('composer', {
        name: 'acme/one',
        dist: { type: 'zip', url: 'https://example.test/w.zip', shasum: 'a'.repeat(40) },
      }),
    };
    await database.executor.batch(
      versionInsertStatements(org, guard, {
        packageId: PACKAGE,
        ecosystem: 'composer',
        versions: [input],
      }).statements,
    );
    expect(
      await reconciler.finalizeListing(
        org,
        guard,
        completeVersionListing({ packageId: PACKAGE, stamp, count: 1 }),
        { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 0 },
      ),
    ).toMatchObject({ removed: 0, restored: 0 });
    expect(await scalar("SELECT status AS v FROM version WHERE version = '3.0.0'")).toBe('active');
    expect(
      await scalar("SELECT updated_at >= ? AS v FROM version WHERE version = '3.0.0'", stamp),
    ).toBe(1);
  });

  it.each(['source', 'package'] as const)(
    'a %s revival alone under exclude bumps the epoch',
    async (kind) => {
      await seedVersions(PACKAGE, '1.0.0');
      await run(stmt('UPDATE package SET source_id = ? WHERE id = ?', EXCLUDE_SOURCE, PACKAGE));
      const table = kind === 'source' ? 'package' : 'version';
      await run(
        stmt(
          `UPDATE ${table} SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?`,
          OLD,
          kind === 'source' ? PACKAGE : `V-${PACKAGE}-1.0.0`,
        ),
      );
      const scope =
        kind === 'source' ? { kind, sourceId: EXCLUDE_SOURCE } : { kind, packageId: PACKAGE };
      const { stamp } = await reconciler.openListing(org, guard, scope);
      await reconciler.markListing(org, guard, {
        scope,
        stamp,
        present: [kind === 'source' ? 'acme/one' : '1.0.0'],
      });
      const listing =
        kind === 'source'
          ? completeSourceListing({ sourceId: EXCLUDE_SOURCE, stamp, count: 1 })
          : completeVersionListing({ packageId: PACKAGE, stamp, count: 1 });
      const before = await epoch();
      expect(
        await reconciler.finalizeListing(org, guard, listing, {
          attemptedCandidates: 1,
          successfulCandidates: 1,
          definitiveAbsent: 0,
        }),
      ).toMatchObject({
        removed: 0,
        restored: 1,
      });
      expect(await epoch()).not.toBe(before);
    },
  );

  it.each(['source', 'package'] as const)(
    'a valid org-B guard rejects org-A %s scopes in every method',
    async (kind) => {
      const foreignJob = '01J0JOB00000000000000000C2';
      await seedVersions(PACKAGE, '1.0.0');
      await run(
        stmt(
          `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
        VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
          foreignJob,
          other.orgId,
          `k:${foreignJob}`,
          OWNER,
          FUTURE,
        ),
        stmt(
          `INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at)
        VALUES (?, ?, 'composer-p2', ?, ?, ?, ?)`,
          org.orgId,
          PACKAGE,
          OLD,
          OLD,
          ABSENCE_MIN_NOT_FOUND,
          OLD,
        ),
      );
      const foreign = createCatalogueWriteGuard(other, { id: foreignJob, owner: OWNER, fence: 3 });
      await database.executor.batch(foreign);
      const scope = kind === 'source' ? { kind, sourceId: SOURCE } : { kind, packageId: PACKAGE };
      const { stamp } = await reconciler.openListing(org, guard, scope);
      const present = [kind === 'source' ? 'acme/one' : '1.0.0'];
      await reconciler.markListing(org, guard, { scope, stamp, present });
      const listing =
        kind === 'source'
          ? completeSourceListing({ sourceId: SOURCE, stamp, count: 1 })
          : completeVersionListing({ packageId: PACKAGE, stamp, count: 1 });
      const snapshot = async () => ({
        packages: await database.executor.all(
          stmt('SELECT * FROM package WHERE org_id = ? ORDER BY id', org.orgId),
        ),
        versions: await database.executor.all(
          stmt('SELECT * FROM version WHERE org_id = ? ORDER BY id', org.orgId),
        ),
        revisions: await database.executor.all(
          stmt('SELECT * FROM version_revision WHERE org_id = ? ORDER BY id', org.orgId),
        ),
        epoch: await epoch(),
      });
      const before = await snapshot();
      await expect(reconciler.openListing(other, foreign, scope)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(
        reconciler.markListing(other, foreign, { scope, stamp, present }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(
        reconciler.finalizeListing(other, foreign, listing, {
          attemptedCandidates: 1,
          successfulCandidates: 1,
          definitiveAbsent: 0,
        }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(
        reconciler.markPackageAbsent(other, foreign, { packageId: PACKAGE }),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['source', 'package', 'absent'] as const)(
    'rejects %s ids over 512 UTF-8 bytes before executing SQL',
    async (kind) => {
      const id = 'é'.repeat(257);
      if (kind === 'absent') {
        await expect(reconciler.markPackageAbsent(org, guard, { packageId: id })).rejects.toThrow(
          RangeError,
        );
      } else {
        const scope = kind === 'source' ? { kind, sourceId: id } : { kind, packageId: id };
        await expect(reconciler.openListing(org, guard, scope)).rejects.toThrow(RangeError);
      }
    },
  );
});
