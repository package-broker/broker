import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  ABSENCE_MIN_NOT_FOUND,
  type CatalogueWriteGuard,
  type VersionInput,
} from '@package-broker/core/db/catalogue';
import { parseSha256 } from '@package-broker/core/platform/blob';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createBlobReferenceReader } from './blob-references.js';
import { createBlobRepository } from './blob.js';
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

async function attachBlob(name: string, packageId = PACKAGE): Promise<string> {
  const id = `B-${packageId}-${name}`;
  const digest = createHash('sha256').update(id).digest('hex');
  await run(
    stmt(
      `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable)
        VALUES (?, ?, ?, 1, ?, 'application/zip', 1)`,
      id,
      org.orgId,
      digest,
      id,
    ),
    stmt('UPDATE version SET blob_id = ? WHERE id = ?', id, `V-${packageId}-${name}`),
  );
  return digest;
}

it.each([0, 1])(
  'removed-upstream purge remains eligible with refetchable = %i',
  async (refetchable) => {
    await seedVersions(PACKAGE, '1.0.0');
    const digest = await attachBlob('1.0.0');
    await run(
      stmt("UPDATE version SET status = 'removed_upstream', removed_upstream_at = ?", OLD),
      stmt('UPDATE blob SET refetchable = ?, purge_after = ?', refetchable, OLD),
    );
    expect(await createBlobReferenceReader(database.executor).stillEligible(org, digest)).toBe(
      true,
    );
    expect(
      await createBlobRepository(database.executor).claimPurge(org, parseSha256(digest)),
    ).not.toBeNull();
  },
);

async function packageListing(present: readonly string[]) {
  const scope = { kind: 'package', packageId: PACKAGE } as const;
  const { stamp } = await reconciler.openListing(org, guard, scope);
  await reconciler.markListing(org, guard, { scope, stamp, present });
  return completeVersionListing({ packageId: PACKAGE, stamp, count: present.length });
}

const blobState = () => database.executor.all(stmt('SELECT * FROM blob ORDER BY id'));

it.each(['package', 'source', 'absent'] as const)(
  '%s removal retains bytes while respecting purge ownership and organization boundaries',
  async (kind) => {
    reconciler = createCatalogueReconciler(
      {
        ...database.executor,
        batch: (statements) => {
          expect(statements.length).toBeLessThanOrEqual(100);
          expect(statements.every((statement) => statement.params.length <= 100)).toBe(true);
          return database.executor.batch(statements);
        },
      },
      { maxAbsenceShare: kind === 'package' ? 7 / 8 : 0.5 },
    );
    const names = [
      'removed',
      'scheduled',
      'deleted',
      'leased',
      'expired',
      'shared',
      'stays',
      'previous',
    ];
    await seedVersions(PACKAGE, ...names);
    await seedVersions(PACKAGE_B, 'shared');
    for (const name of names) await attachBlob(name);
    await run(
      stmt(
        'UPDATE version SET blob_id = ? WHERE id = ?',
        `B-${PACKAGE}-shared`,
        `V-${PACKAGE_B}-shared`,
      ),
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z', last_op_id = 'previous-operation' WHERE id = ?",
        `V-${PACKAGE}-previous`,
      ),
      stmt('UPDATE blob SET purge_after = ? WHERE id = ?', OLD, `B-${PACKAGE}-scheduled`),
      stmt('UPDATE blob SET deleted_at = ? WHERE id = ?', OLD, `B-${PACKAGE}-deleted`),
      stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', FUTURE, `B-${PACKAGE}-leased`),
      stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', OLD, `B-${PACKAGE}-expired`),
      stmt(
        `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, refetchable)
        SELECT 'foreign', ?, sha256, size_bytes, 'foreign', 1 FROM blob WHERE id = ?`,
        other.orgId,
        `B-${PACKAGE}-removed`,
      ),
    );
    if (kind !== 'package') {
      await run(
        stmt("UPDATE version SET status = 'quarantined' WHERE id = ?", `V-${PACKAGE}-stays`),
      );
    }
    const before = await blobState();
    let statements: number;
    if (kind === 'absent') {
      expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
        changed: false,
      });
      expect(await blobState()).toEqual(before);
      await run(
        stmt(
          `INSERT INTO upstream_state
        (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at)
        VALUES (?, ?, 'composer-p2', ?, ?, ?, ?)`,
          org.orgId,
          PACKAGE,
          OLD,
          OLD,
          ABSENCE_MIN_NOT_FOUND,
          OLD,
        ),
      );
      const effect = await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE });
      expect(effect.changed).toBe(true);
      statements = effect.statements;
    } else {
      const listing =
        kind === 'source' ? await sourceListing(['acme/two']) : await packageListing(['stays']);
      const effect = await reconciler.finalizeListing(org, guard, listing, {
        attemptedCandidates: kind === 'source' ? 2 : names.length,
        successfulCandidates: 1,
        definitiveAbsent: kind === 'source' ? 1 : names.length - 1,
      });
      expect(effect.removed).toBe(kind === 'source' ? 1 : 6);
      expect(effect.restored).toBe(0);
      statements = effect.statements;
    }
    expect(statements).toBe({ package: 15, source: 11, absent: 9 }[kind]);
    expect(statements).toBeLessThanOrEqual(100);
    const after = await blobState();
    expect(after).toEqual(
      before.map((blob) =>
        ['removed', 'expired', 'shared'].some((name) => blob['id'] === `B-${PACKAGE}-${name}`)
          ? { ...blob, refetchable: 0 }
          : blob,
      ),
    );
    expect(
      await scalar('SELECT status AS v FROM version WHERE id = ?', `V-${PACKAGE_B}-shared`),
    ).toBe('active');
    const revisions = await scalar('SELECT count(*) AS v FROM version_revision');
    if (kind === 'absent') {
      expect(await reconciler.markPackageAbsent(org, guard, { packageId: PACKAGE })).toMatchObject({
        changed: false,
      });
    } else {
      await reconciler.finalizeListing(
        org,
        guard,
        kind === 'source' ? await sourceListing(['acme/two']) : await packageListing(['stays']),
        {
          attemptedCandidates: kind === 'source' ? 2 : names.length,
          successfulCandidates: 1,
          definitiveAbsent: kind === 'source' ? 1 : names.length - 1,
        },
      );
    }
    expect(await blobState()).toEqual(after);
    expect(await scalar('SELECT count(*) AS v FROM version_revision')).toBe(revisions);
  },
);

it('restoration preserves non-refetchability and a later removal narrows re-fetched bytes again', async () => {
  reconciler = createCatalogueReconciler(database.executor, { maxAbsenceShare: 0.5 });
  await seedVersions(PACKAGE, '1.0.0', '2.0.0');
  await attachBlob('1.0.0');
  await attachBlob('2.0.0');
  const removalEvidence = {
    attemptedCandidates: 2,
    successfulCandidates: 1,
    definitiveAbsent: 1,
  };
  await reconciler.finalizeListing(org, guard, await packageListing(['1.0.0']), removalEvidence);
  await reconciler.finalizeListing(org, guard, await packageListing(['1.0.0', '2.0.0']), {
    attemptedCandidates: 2,
    successfulCandidates: 2,
    definitiveAbsent: 0,
  });
  expect(await scalar('SELECT refetchable AS v FROM blob WHERE id = ?', `B-${PACKAGE}-2.0.0`)).toBe(
    0,
  );
  await run(stmt('UPDATE blob SET refetchable = 1 WHERE id = ?', `B-${PACKAGE}-2.0.0`));
  await run(stmt('UPDATE version SET updated_at = ? WHERE id = ?', OLD, `V-${PACKAGE}-2.0.0`));
  const listing = await packageListing(['1.0.0']);
  expect(await reconciler.finalizeListing(org, guard, listing, removalEvidence)).toMatchObject({
    removed: 1,
  });
  expect(await scalar('SELECT refetchable AS v FROM blob WHERE id = ?', `B-${PACKAGE}-2.0.0`)).toBe(
    0,
  );
  const before = await blobState();
  expect(await reconciler.finalizeListing(org, guard, listing, removalEvidence)).toMatchObject({
    removed: 0,
  });
  expect(await blobState()).toEqual(before);
});

describe('revival and the blob purge lease', () => {
  const scope = { kind: 'package', packageId: PACKAGE } as const;
  const LIVE = '2099-01-01T00:00:00.000Z';
  const digest = (n: number) => n.toString(16).padStart(64, '0');

  async function blobFor(owner: OrgContext, n: number, leaseUntil: string | null, sha = n) {
    const id = `BLOB${String(n)}${owner.orgId}`;
    await run(
      stmt(
        `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_lease_until)
          VALUES (?, ?, ?, 1, ?, ?)`,
        id,
        owner.orgId,
        digest(sha),
        `k${String(n)}${owner.orgId}`,
        leaseUntil,
      ),
    );
    return id;
  }

  async function removedVersion(name: string, blobId: string | null): Promise<string> {
    await seedVersions(PACKAGE, name);
    const id = `V-${PACKAGE}-${name}`;
    await run(
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ?, blob_id = ? WHERE id = ?",
        OLD,
        blobId,
        id,
      ),
    );
    return id;
  }

  async function finalizeWith(
    present: readonly string[],
    executor = reconciler,
    definitiveAbsent = 0,
  ) {
    const { stamp } = await executor.openListing(org, guard, scope);
    await executor.markListing(org, guard, { scope, stamp, present });
    return executor.finalizeListing(
      org,
      guard,
      completeVersionListing({ packageId: PACKAGE, stamp, count: present.length }),
      {
        attemptedCandidates: present.length + definitiveAbsent,
        successfulCandidates: present.length,
        definitiveAbsent,
      },
    );
  }

  const statusOf = (id: string) => scalar('SELECT status AS v FROM version WHERE id = ?', id);
  const revisionCount = () => scalar('SELECT count(*) AS v FROM version_revision');

  it('1: an unleased blob revives with its revision row and epoch bump', async () => {
    const id = await removedVersion('1.0.0', await blobFor(org, 1, null));
    await run(stmt("UPDATE source SET removal_policy = 'exclude' WHERE id = ?", SOURCE));
    const before = await epoch();
    const result = await finalizeWith(['1.0.0']);
    expect(result).toMatchObject({ restored: 1, leaseHeldBack: 0 });
    expect(await statusOf(id)).toBe('active');
    expect(await revisionCount()).toBe(1);
    expect(await epoch()).not.toBe(before);
  });

  it('1: a live lease keeps the version removed_upstream with no revision, event or epoch bump', async () => {
    const id = await removedVersion('1.0.0', await blobFor(org, 1, LIVE));
    await run(stmt("UPDATE source SET removal_policy = 'exclude' WHERE id = ?", SOURCE));
    const before = await epoch();
    const rev = await scalar('SELECT revision AS v FROM version WHERE id = ?', id);
    const result = await finalizeWith(['1.0.0']);
    expect(result).toMatchObject({ restored: 0, removed: 0, leaseHeldBack: 1 });
    expect(await statusOf(id)).toBe('removed_upstream');
    expect(await revisionCount()).toBe(0);
    expect(await epoch()).toBe(before);
    expect(await scalar('SELECT revision AS v FROM version WHERE id = ?', id)).toBe(rev);
    expect(await scalar('SELECT count(*) AS v FROM version WHERE last_op_id IS NOT NULL')).toBe(0);
  });

  it('2: after the lease expires a fresh finalize revives; before expiry it is held back each time', async () => {
    const blobId = await blobFor(org, 1, LIVE);
    const id = await removedVersion('1.0.0', blobId);
    expect(await finalizeWith(['1.0.0'])).toMatchObject({ leaseHeldBack: 1, restored: 0 });
    expect(await finalizeWith(['1.0.0'])).toMatchObject({ leaseHeldBack: 1, restored: 0 });
    expect(await statusOf(id)).toBe('removed_upstream');
    await run(stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', OLD, blobId));
    expect(await finalizeWith(['1.0.0'])).toMatchObject({ leaseHeldBack: 0, restored: 1 });
    expect(await statusOf(id)).toBe('active');
  });

  it.each([
    { change: 'starts', before: null, after: LIVE, held: 0, restored: 1 },
    { change: 'ends', before: LIVE, after: OLD, held: 1, restored: 0 },
  ])(
    'reports the batch decision when a lease $change immediately afterward',
    async ({ before, after, held, restored }) => {
      const blobId = await blobFor(org, 1, before);
      const id = await removedVersion('1.0.0', blobId);
      let interleaved = false;
      const wrapped = createCatalogueReconciler({
        ...database.executor,
        all: () => {
          throw new Error('reconciliation must not read after the batch');
        },
        batch: async (statements) => {
          const results = await database.executor.batch(statements);
          if (statements.some((s) => /^UPDATE version SET status = 'active'/.test(s.sql.trim()))) {
            await run(stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', after, blobId));
            interleaved = true;
          }
          return results;
        },
      });
      expect(await finalizeWith(['1.0.0'], wrapped)).toMatchObject({
        removed: 0,
        restored,
        leaseHeldBack: held,
        statements: 15,
      });
      expect(interleaved).toBe(true);
      expect(await scalar('SELECT purge_lease_until AS v FROM blob WHERE id = ?', blobId)).toBe(
        after,
      );
      expect(await statusOf(id)).toBe(restored === 1 ? 'active' : 'removed_upstream');
      expect(await revisionCount()).toBe(restored);
    },
  );

  it('a revive UPDATE that matches nothing writes no revision or epoch and reports held-back rows', async () => {
    const id = await removedVersion('1.0.0', await blobFor(org, 1, null));
    await run(stmt("UPDATE source SET removal_policy = 'exclude' WHERE id = ?", SOURCE));
    const before = await epoch();
    let reviveAttempted = false;
    const spy = createCatalogueReconciler({
      ...database.executor,
      batch: (statements) =>
        database.executor.batch(
          statements.map((statement) => {
            if (!/^UPDATE version SET status = 'active'/.test(statement.sql.trim())) {
              return statement;
            }
            reviveAttempted = true;
            return { ...statement, sql: `${statement.sql} AND 0` };
          }),
        ),
    });
    const result = await finalizeWith(['1.0.0'], spy);
    expect(reviveAttempted).toBe(true);
    expect(await revisionCount()).toBe(0);
    expect(await epoch()).toBe(before);
    expect(result).toMatchObject({ removed: 0, restored: 0, leaseHeldBack: 1 });
    expect(await statusOf(id)).toBe('removed_upstream');
    expect(await scalar('SELECT last_op_id AS v FROM version WHERE id = ?', id)).toBeNull();
    expect(await scalar('SELECT rev AS v FROM package WHERE id = ?', PACKAGE)).toBe(1);
  });

  it('3: a version without a blob revives; a lease on an unrelated blob does not hold it back', async () => {
    await blobFor(org, 9, LIVE);
    const id = await removedVersion('1.0.0', null);
    const result = await finalizeWith(['1.0.0']);
    expect(result).toMatchObject({ restored: 1, leaseHeldBack: 0 });
    expect(await statusOf(id)).toBe('active');
  });

  it('4: a lease on the same sha256 in another organization does not hold back revival; its own does', async () => {
    await blobFor(other, 1, LIVE, 1);
    const own = await blobFor(org, 2, null, 1);
    const id = await removedVersion('1.0.0', own);
    expect(await finalizeWith(['1.0.0'])).toMatchObject({ restored: 1, leaseHeldBack: 0 });
    expect(await statusOf(id)).toBe('active');

    await run(
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = ?",
        OLD,
        id,
      ),
      stmt('UPDATE blob SET purge_lease_until = ? WHERE id = ?', LIVE, own),
    );
    expect(await finalizeWith(['1.0.0'])).toMatchObject({ restored: 0, leaseHeldBack: 1 });
    expect(await statusOf(id)).toBe('removed_upstream');
  });

  it('5: flagging an active version with a leased blob is unaffected and its SQL has no lease predicate', async () => {
    await seedVersions(PACKAGE, '1.0.0', '2.0.0');
    const blobId = await blobFor(org, 1, LIVE);
    await run(stmt('UPDATE version SET blob_id = ? WHERE id = ?', blobId, `V-${PACKAGE}-2.0.0`));
    const captured: Statement[] = [];
    const spy = createCatalogueReconciler(
      {
        ...database.executor,
        batch: (statements) => {
          captured.push(...statements);
          return database.executor.batch(statements);
        },
      },
      { maxAbsenceShare: 0.5 },
    );
    const result = await finalizeWith(['1.0.0'], spy, 1);
    expect(result).toMatchObject({ removed: 1, restored: 0 });
    expect(await statusOf(`V-${PACKAGE}-2.0.0`)).toBe('removed_upstream');
    const flag = captured.filter((s) =>
      /^UPDATE version SET status = 'removed_upstream'/.test(s.sql.trim()),
    );
    expect(flag).toHaveLength(1);
    expect(flag[0]?.sql).not.toContain('purge_lease_until');
    const revive = captured.filter((s) =>
      /^UPDATE version SET status = 'active'/.test(s.sql.trim()),
    );
    expect(revive).toHaveLength(1);
    expect(revive[0]?.sql).toContain('purge_lease_until');
    expect(
      captured.filter(
        (s) => s.sql.trim().startsWith('UPDATE version') && s.sql.includes('purge_lease_until'),
      ),
    ).toEqual(revive);
  });

  it('4: a foreign leased blob reference behaves like an absent blob reference', async () => {
    const foreign = await removedVersion('1.0.0', await blobFor(other, 1, LIVE));
    const absent = await removedVersion('2.0.0', null);
    expect(await finalizeWith(['1.0.0', '2.0.0'])).toMatchObject({
      restored: 2,
      leaseHeldBack: 0,
    });
    expect(await statusOf(foreign)).toBe('active');
    expect(await statusOf(absent)).toBe('active');
  });
});
