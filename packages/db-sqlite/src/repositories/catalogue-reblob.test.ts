import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { replaceBlobStatements } from './catalogue-reblob.js';

const JOB_ID = '01J0JOB00000000000000000R1';
const OTHER_JOB = '01J0JOB00000000000000000R2';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0R01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000R01';
const NPM_SOURCE = '01J0SRC0000000000000000R02';
const PACKAGE = '01J0PKG0000000000000000R01';
const NPM_PACKAGE = '01J0PKG0000000000000000R02';
const VERSION = '01J0VER0000000000000000R01';
const NPM_VERSION = '01J0VER0000000000000000R02';
const BLOB_A = '01J0BLB0000000000000000A01';
const BLOB_B = '01J0BLB0000000000000000B01';
const OTHER_BLOB = '01J0BLB0000000000000000C01';
const SHA_A = 'a'.repeat(64) as Sha256;
const SHA_B = 'b'.repeat(64) as Sha256;
const SHA_MISSING = 'c'.repeat(64) as Sha256;

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let guard: CatalogueWriteGuard;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  await database.executor.batch([
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
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      NPM_SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/widget')",
      PACKAGE,
      org.orgId,
      SOURCE,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'widget')",
      NPM_PACKAGE,
      org.orgId,
      NPM_SOURCE,
    ),
    stmt(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
      BLOB_A,
      org.orgId,
      SHA_A,
      SHA_A,
    ),
    stmt(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
      BLOB_B,
      org.orgId,
      SHA_B,
      SHA_B,
    ),
    stmt(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
         published_at_basis, metadata_json, revision, blob_id)
        VALUES (?, ?, ?, '1.0.0', '1.0.0.0', '2020-01-01T00:00:00.000Z', 'broker', '{}', 4, ?)`,
      VERSION,
      org.orgId,
      PACKAGE,
      BLOB_A,
    ),
    stmt(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
         published_at_basis, metadata_json, revision, blob_id)
        VALUES (?, ?, ?, '1.0.0', '1.0.0', '2020-01-01T00:00:00.000Z', 'broker', '{}', 4, ?)`,
      NPM_VERSION,
      org.orgId,
      NPM_PACKAGE,
      BLOB_A,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

async function snapshot(): Promise<unknown> {
  return {
    versions: await database.executor.all(stmt('SELECT * FROM version ORDER BY id')),
    packages: await database.executor.all(stmt('SELECT * FROM package ORDER BY id')),
    revisions: await database.executor.all(stmt('SELECT * FROM version_revision ORDER BY id')),
    blobs: await database.executor.all(stmt('SELECT * FROM blob ORDER BY id')),
  };
}

async function replace(
  overrides: Partial<Parameters<typeof replaceBlobStatements>[2]> = {},
  using: CatalogueWriteGuard = guard,
  ctx: OrgContext = org,
) {
  const plan = replaceBlobStatements(ctx, using, {
    versionId: VERSION,
    expectedRevision: 4,
    oldBlobId: BLOB_A,
    newSha256: SHA_B,
    reason: 'refetch_changed',
    ...overrides,
  });
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  return plan.result(await database.executor.batch(plan.statements));
}

async function expectRefused(run: () => Promise<unknown>, before?: unknown): Promise<void> {
  const first = before ?? (await snapshot());
  await expect(run()).rejects.toThrow();
  expect(await snapshot()).toEqual(first);
}

describe('replaceBlobStatements', () => {
  it('replaces the blob of a Composer version with an empty shasum and keeps the old one referenced', async () => {
    const before = await snapshot();
    const effect = await replace();
    expect(effect.changed).toBe(true);
    const [version] = await database.executor.all<{
      blob_id: string;
      revision: number;
      updated_at: string;
    }>(stmt('SELECT blob_id, revision, updated_at FROM version WHERE id = ?', VERSION));
    expect(version?.blob_id).toBe(BLOB_B);
    expect(version?.revision).toBe(5);
    const revisions = await database.executor.all<{
      revision: number;
      blob_id: string;
      reason: string;
      org_id: string;
    }>(
      stmt(
        'SELECT revision, blob_id, reason, org_id FROM version_revision WHERE version_id = ?',
        VERSION,
      ),
    );
    expect(revisions).toEqual([
      { revision: 4, blob_id: BLOB_A, reason: 'refetch_changed', org_id: org.orgId },
    ]);
    const blobs = (before as { blobs: unknown }).blobs;
    expect(await database.executor.all(stmt('SELECT * FROM blob ORDER BY id'))).toEqual(blobs);
    const [pkg] = await database.executor.all<{ rev: number; modified_at: string }>(
      stmt('SELECT rev, modified_at FROM package WHERE id = ?', PACKAGE),
    );
    const [pkgBefore] = (
      before as { packages: { id: string; rev: number; modified_at: string }[] }
    ).packages.filter((p) => p.id === PACKAGE);
    expect(pkg?.rev).toBe((pkgBefore?.rev ?? 0) + 1);
    expect((pkg?.modified_at ?? '') > (pkgBefore?.modified_at ?? '')).toBe(true);
  });

  it.each(['active', 'removed_upstream'] as const)(
    'keeps the status and listing timestamp after a successful replace of a %s version',
    async (status) => {
      const updatedAt = '2020-01-01T00:00:00.000Z';
      await database.executor.batch([
        stmt(
          'UPDATE version SET status = ?, updated_at = ?, removed_upstream_at = ? WHERE id = ?',
          status,
          updatedAt,
          status === 'removed_upstream' ? updatedAt : null,
          VERSION,
        ),
      ]);
      expect((await replace()).changed).toBe(true);
      const [version] = await database.executor.all(
        stmt('SELECT blob_id, revision, status, updated_at FROM version WHERE id = ?', VERSION),
      );
      expect(version).toEqual({ blob_id: BLOB_B, revision: 5, status, updated_at: updatedAt });
    },
  );

  it('uses the before-image eligibility decision for the update and postcondition', async () => {
    const plan = replaceBlobStatements(org, guard, {
      versionId: VERSION,
      expectedRevision: 4,
      oldBlobId: BLOB_A,
      newSha256: SHA_B,
      reason: 'refetch_changed',
    });
    const statements = plan.statements.flatMap((statement) =>
      statement.sql.startsWith('update "version"')
        ? [
            stmt(
              "UPDATE blob SET purge_generation = 'g', purge_lease_until = ? WHERE id = ?",
              FUTURE,
              BLOB_B,
            ),
            statement,
          ]
        : [statement],
    );
    await database.executor.batch(statements);
    const [version] = await database.executor.all(
      stmt('SELECT blob_id, revision, last_op_id FROM version WHERE id = ?', VERSION),
    );
    expect(version).toEqual({ blob_id: BLOB_B, revision: 5, last_op_id: plan.opId });
  });

  it.each(['missing', 'another operation'])(
    'does not replace when the before-image is %s',
    async (beforeImage) => {
      await replace();
      const plan = replaceBlobStatements(org, guard, {
        versionId: VERSION,
        expectedRevision: 5,
        oldBlobId: BLOB_B,
        newSha256: SHA_A,
        reason: 'refetch_changed',
      });
      if (beforeImage === 'another operation') {
        const insert = plan.statements.find((entry) =>
          entry.sql.startsWith('insert into "version_revision"'),
        );
        if (insert === undefined) throw new Error('before-image insert missing');
        await database.executor.batch([
          {
            ...insert,
            params: insert.params.map((value) => (value === plan.opId ? 'other-op' : value)),
          },
        ]);
      }
      const statement = plan.statements.find((entry) => entry.sql.startsWith('update "version"'));
      if (statement === undefined) throw new Error('version update missing');
      const before = await snapshot();
      await database.executor.batch([statement]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('replaces the blob of an npm version without integrity or dist shasum', async () => {
    expect((await replace({ versionId: NPM_VERSION })).changed).toBe(true);
    const [version] = await database.executor.all<{ blob_id: string; revision: number }>(
      stmt('SELECT blob_id, revision FROM version WHERE id = ?', NPM_VERSION),
    );
    expect(version).toEqual({ blob_id: BLOB_B, revision: 5 });
  });

  it('1: a non-empty Composer shasum is refused and nothing changes', async () => {
    await database.executor.batch([
      stmt("UPDATE version SET composer_shasum = 'deadbeef' WHERE id = ?", VERSION),
    ]);
    await expectRefused(() => replace());
  });

  it('1: an npm integrity is refused and nothing changes', async () => {
    await database.executor.batch([
      stmt("UPDATE version SET npm_integrity = 'sha512-AAAA' WHERE id = ?", NPM_VERSION),
    ]);
    await expectRefused(() => replace({ versionId: NPM_VERSION }));
  });

  it('1: an npm dist.shasum in the metadata is refused and nothing changes', async () => {
    await database.executor.batch([
      stmt(
        `UPDATE version SET metadata_json = '{"dist":{"shasum":"abc123"}}' WHERE id = ?`,
        NPM_VERSION,
      ),
    ]);
    await expectRefused(() => replace({ versionId: NPM_VERSION }));
  });

  it('1: an empty npm dist.shasum counts as unpublished', async () => {
    await database.executor.batch([
      stmt(`UPDATE version SET metadata_json = '{"dist":{"shasum":""}}' WHERE id = ?`, NPM_VERSION),
    ]);
    expect((await replace({ versionId: NPM_VERSION })).changed).toBe(true);
  });

  it('1: the digest rule is per ecosystem', async () => {
    await database.executor.batch([
      stmt("UPDATE version SET composer_shasum = 'deadbeef' WHERE id = ?", NPM_VERSION),
    ]);
    expect((await replace({ versionId: NPM_VERSION })).changed).toBe(true);
    await database.executor.batch([
      stmt("UPDATE version SET npm_integrity = 'sha512-AAAA' WHERE id = ?", VERSION),
    ]);
    expect((await replace({ expectedRevision: 4 })).changed).toBe(true);
  });

  it('2: the old blob stays referenced by the revision row', async () => {
    await replace();
    const rows = await database.executor.all<{ n: number }>(
      stmt(
        'SELECT count(*) AS n FROM version_revision WHERE blob_id = ? AND org_id = ?',
        BLOB_A,
        org.orgId,
      ),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('a replay of the same request fails without change', async () => {
    await replace();
    await expectRefused(() => replace());
  });

  it.each([3, 5])('a stale expected revision %i fails without change', async (revision) => {
    await expectRefused(() => replace({ expectedRevision: revision }));
  });

  it('a different current blob fails without change', async () => {
    await expectRefused(() => replace({ oldBlobId: BLOB_B, newSha256: SHA_A }));
  });

  it('a tombstoned version fails without change', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    await expectRefused(() => replace());
  });

  it('a version without a blob fails without change', async () => {
    await database.executor.batch([
      stmt('UPDATE version SET blob_id = NULL WHERE id = ?', VERSION),
    ]);
    await expectRefused(() => replace());
  });

  it('replacing a blob with itself fails without change', async () => {
    await expectRefused(() => replace({ newSha256: SHA_A }));
  });

  it('an unknown digest fails without change', async () => {
    await expectRefused(() => replace({ newSha256: SHA_MISSING }));
  });

  it('a soft-deleted new blob fails without change', async () => {
    await database.executor.batch([
      stmt("UPDATE blob SET deleted_at = '2021-01-01T00:00:00.000Z' WHERE id = ?", BLOB_B),
    ]);
    await expectRefused(() => replace());
  });

  it('a new blob under a live purge lease fails without change', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE blob SET purge_generation = 'g', purge_lease_until = ? WHERE id = ?",
        FUTURE,
        BLOB_B,
      ),
    ]);
    await expectRefused(() => replace());
  });

  it('an expired purge lease does not block the replacement', async () => {
    await database.executor.batch([
      stmt(
        `UPDATE blob SET purge_generation = 'g',
           purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ?`,
        BLOB_B,
      ),
    ]);
    expect((await replace()).changed).toBe(true);
  });

  it('a stale job guard rolls the whole batch back', async () => {
    const stale = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 2 });
    await expectRefused(() => replace({}, stale));
  });

  it('a blob of another organization is not a live replacement', async () => {
    await database.executor.batch([
      stmt('UPDATE blob SET org_id = ? WHERE id = ?', other.orgId, BLOB_B),
    ]);
    await expectRefused(() => replace());
  });

  it('a version of another organization is not replaced', async () => {
    await database.executor.batch([
      stmt(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
        OTHER_JOB,
        other.orgId,
        `k:${OTHER_JOB}`,
        OWNER,
        FUTURE,
      ),
      stmt(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        OTHER_BLOB,
        other.orgId,
        SHA_B,
        SHA_B,
      ),
    ]);
    const otherGuard = createCatalogueWriteGuard(other, { id: OTHER_JOB, owner: OWNER, fence: 3 });
    await database.executor.batch(otherGuard);
    const before = await snapshot();
    await expectRefused(() => replace({}, otherGuard, other), before);

    const plan = replaceBlobStatements(other, otherGuard, {
      versionId: VERSION,
      expectedRevision: 4,
      oldBlobId: BLOB_A,
      newSha256: SHA_B,
      reason: 'refetch_changed',
    });
    const mutations = plan.statements.slice(otherGuard.length);
    for (const prefix of [
      'insert into "version_revision"',
      'update "version"',
      'update "package"',
    ]) {
      const statement = mutations.find((entry) => entry.sql.startsWith(prefix));
      if (statement === undefined) throw new Error('statement missing');
      await database.executor.batch([statement]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a guard built for another organization', () => {
    expect(() =>
      replaceBlobStatements(other, guard, {
        versionId: VERSION,
        expectedRevision: 4,
        oldBlobId: BLOB_A,
        newSha256: SHA_B,
        reason: 'refetch_changed',
      }),
    ).toThrow(TypeError);
  });

  it('refuses malformed input', () => {
    const base = {
      versionId: VERSION,
      expectedRevision: 4,
      oldBlobId: BLOB_A,
      newSha256: SHA_B,
      reason: 'refetch_changed',
    } as const;
    expect(() => replaceBlobStatements(org, guard, { ...base, expectedRevision: 0 })).toThrow(
      RangeError,
    );
    expect(() => replaceBlobStatements(org, guard, { ...base, oldBlobId: '' })).toThrow(RangeError);
    expect(() =>
      replaceBlobStatements(org, guard, { ...base, newSha256: 'ABC' as Sha256 }),
    ).toThrow(RangeError);
    expect(() =>
      replaceBlobStatements(org, guard, { ...base, reason: 'other' as 'refetch_changed' }),
    ).toThrow(RangeError);
  });
});
