import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { distAttachStatements } from './catalogue-write-dist.js';

const JOB_ID = '01J0JOB00000000000000000D1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0D01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000D01';
const PACKAGE = '01J0PKG0000000000000000D01';
const VERSION = '01J0VER0000000000000000D01';
const OTHER_JOB = '01J0JOB00000000000000000D2';
const OTHER_BLOB = '01J0BLB0000000000000000C01';
const BLOB_A = '01J0BLB0000000000000000A01';
const BLOB_B = '01J0BLB0000000000000000B01';
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
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/widget')",
      PACKAGE,
      org.orgId,
      SOURCE,
    ),
    stmt(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
         published_at_basis, metadata_json, revision)
        VALUES (?, ?, ?, '1.0.0', '1.0.0.0', '2020-01-01T00:00:00.000Z', 'broker', '{}', 4)`,
      VERSION,
      org.orgId,
      PACKAGE,
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
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

interface State {
  blobId: string | null;
  revision: number;
  opId: string | null;
  rev: number;
  modifiedAt: string;
  updatedAt: string;
}

async function state(versionId = VERSION): Promise<State> {
  const rows = await database.executor.all<State>({
    sql: `SELECT version.blob_id AS blobId, version.revision AS revision, version.last_op_id AS opId,
            package.rev AS rev, package.modified_at AS modifiedAt, version.updated_at AS updatedAt
          FROM version JOIN package ON package.id = version.package_id WHERE version.id = ?`,
    params: [versionId],
  });
  const row = rows[0];
  if (row === undefined) throw new Error('version missing');
  return row;
}

async function attach(
  sha256: Sha256 = SHA_A,
  revision = 4,
  using: CatalogueWriteGuard = guard,
  ctx: OrgContext = org,
) {
  const plan = distAttachStatements(ctx, using, { versionId: VERSION, revision, sha256 });
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = await database.executor.batch(plan.statements);
  return plan.result(results);
}

describe('distAttachStatements', () => {
  it('2: attaches a live blob to a version without one, keeping the revision', async () => {
    const before = await state();
    const effect = await attach();
    const after = await state();
    expect(effect.changed).toBe(true);
    expect(after.blobId).toBe(BLOB_A);
    expect(after.revision).toBe(4);
    expect(after.rev).toBe(before.rev + 1);
    expect(after.modifiedAt > before.modifiedAt).toBe(true);
    const revisions = await database.executor.all<{ n: number }>({
      sql: 'SELECT count(*) AS n FROM version_revision WHERE version_id = ?',
      params: [VERSION],
    });
    expect(revisions[0]?.n).toBe(0);
  });

  it('keeps the listing timestamp after a successful attach', async () => {
    await database.executor.batch([
      stmt("UPDATE version SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", VERSION),
    ]);
    const before = await state();
    expect((await attach()).changed).toBe(true);
    expect((await state()).updatedAt).toBe(before.updatedAt);
  });

  it.each(['soft-deleted', 'leased'] as const)(
    'rejects replay after the attached blob becomes %s',
    async (unavailable) => {
      await attach();
      await database.executor.batch([
        unavailable === 'soft-deleted'
          ? stmt("UPDATE blob SET deleted_at = '2021-01-01T00:00:00.000Z' WHERE id = ?", BLOB_A)
          : stmt(
              "UPDATE blob SET purge_generation = 'g', purge_lease_until = ? WHERE id = ?",
              FUTURE,
              BLOB_A,
            ),
      ]);
      const before = await state();
      const blobs = await database.executor.all(stmt('SELECT * FROM blob ORDER BY id'));
      await expect(attach()).rejects.toThrow();
      expect(await state()).toEqual(before);
      expect(await database.executor.all(stmt('SELECT * FROM blob ORDER BY id'))).toEqual(blobs);
    },
  );

  it('keeps an unrelated package and version in the same organization unchanged', async () => {
    const unrelatedPackage = '01J0PKG0000000000000000D02';
    const unrelatedVersion = '01J0VER0000000000000000D02';
    await database.executor.batch([
      stmt(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, rev)
          VALUES (?, ?, ?, 'composer', 'acme/other', 7)`,
        unrelatedPackage,
        org.orgId,
        SOURCE,
      ),
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized,
          published_at, published_at_basis, metadata_json, revision, last_op_id)
          VALUES (?, ?, ?, '2.0.0', '2.0.0.0', '2020-01-01T00:00:00.000Z',
            'broker', '{}', 8, 'unrelated-op')`,
        unrelatedVersion,
        org.orgId,
        unrelatedPackage,
      ),
    ]);
    const before = await state(unrelatedVersion);
    expect((await attach()).changed).toBe(true);
    expect(await state(unrelatedVersion)).toEqual(before);
  });

  it('1: a second identical attach is a no-op', async () => {
    await attach();
    const first = await state();
    const effect = await attach();
    expect(effect.changed).toBe(false);
    expect(await state()).toEqual(first);
  });

  it('1: a different blob on a version that has one fails without change', async () => {
    await attach(SHA_A);
    const first = await state();
    await expect(attach(SHA_B)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a soft-deleted blob fails without change', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE blob SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        BLOB_A,
      ),
    ]);
    const first = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: an unknown digest fails without change', async () => {
    const first = await state();
    await expect(attach(SHA_MISSING)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a blob of another organization is not live for this one', async () => {
    await database.executor.batch([
      stmt('UPDATE blob SET org_id = ? WHERE id = ?', other.orgId, BLOB_A),
    ]);
    const first = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a blob under a live purge lease is unavailable', async () => {
    await database.executor.batch([
      stmt(
        `UPDATE blob SET purge_generation = 'g',
           purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+900 seconds') WHERE id = ?`,
        BLOB_A,
      ),
    ]);
    const first = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: an expired purge lease blocks the attach until put revokes it', async () => {
    await database.executor.batch([
      stmt(
        `UPDATE blob SET purge_generation = 'g',
           purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ?`,
        BLOB_A,
      ),
    ]);
    const before = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('2: a revision changed since resolve fails without change', async () => {
    const first = await state();
    await expect(attach(SHA_A, 3)).rejects.toThrow();
    await expect(attach(SHA_A, 5)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a tombstoned version fails without change, even when it already has the blob', async () => {
    await attach(SHA_A);
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    const first = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a tombstoned version without a blob fails without change', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    const first = await state();
    await expect(attach(SHA_A)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('2: a stale job guard rolls the whole batch back', async () => {
    const stale = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 2 });
    const first = await state();
    await expect(attach(SHA_A, 4, stale)).rejects.toThrow();
    expect(await state()).toEqual(first);
  });

  it('a version of another organization is not attached', async () => {
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
        SHA_A,
        SHA_A,
      ),
    ]);
    const otherGuard = createCatalogueWriteGuard(other, { id: OTHER_JOB, owner: OWNER, fence: 3 });
    await database.executor.batch(otherGuard);
    const before = await state();
    await expect(attach(SHA_A, 4, otherGuard, other)).rejects.toThrow();
    expect(await state()).toEqual(before);

    // Probe the UPDATE independently: the postcondition would roll back an unscoped write.
    const plan = distAttachStatements(other, otherGuard, {
      versionId: VERSION,
      revision: 4,
      sha256: SHA_A,
    });
    await database.executor.batch(plan.statements.slice(0, otherGuard.length + 1));
    expect(await state()).toEqual(before);

    // A cross-org reference is schema-valid; the postcondition must reject it on replay.
    await database.executor.batch([
      stmt('UPDATE version SET blob_id = ? WHERE id = ?', OTHER_BLOB, VERSION),
    ]);
    const linked = await state();
    await expect(attach(SHA_A, 4, otherGuard, other)).rejects.toThrow();
    expect(await state()).toEqual(linked);
  });

  it('scopes both live-blob reads in the attach UPDATE', async () => {
    await database.executor.batch([
      stmt('UPDATE blob SET org_id = ? WHERE id = ?', other.orgId, BLOB_A),
    ]);
    const plan = distAttachStatements(org, guard, {
      versionId: VERSION,
      revision: 4,
      sha256: SHA_A,
    });
    const update = plan.statements[guard.length];
    if (update === undefined) throw new Error('attach statement missing');
    const before = await state();
    const [result] = await database.executor.batch([update]);
    expect(result?.changes).toBe(0);
    expect(await state()).toEqual(before);
  });

  it('does not advance a foreign package referenced by an own version', async () => {
    await database.executor.batch([
      stmt('UPDATE package SET org_id = ? WHERE id = ?', other.orgId, PACKAGE),
    ]);
    const before = await state();
    expect((await attach()).changed).toBe(true);
    expect((await state()).rev).toBe(before.rev);
    expect((await state()).modifiedAt).toBe(before.modifiedAt);
  });

  it('refuses a guard built for another organization', () => {
    expect(() =>
      distAttachStatements(other, guard, { versionId: VERSION, revision: 4, sha256: SHA_A }),
    ).toThrow(TypeError);
  });

  it('refuses malformed input', () => {
    expect(() =>
      distAttachStatements(org, guard, { versionId: VERSION, revision: 0, sha256: SHA_A }),
    ).toThrow(RangeError);
    expect(() =>
      distAttachStatements(org, guard, {
        versionId: VERSION,
        revision: 4,
        sha256: 'ABC' as Sha256,
      }),
    ).toThrow(RangeError);
  });
});
