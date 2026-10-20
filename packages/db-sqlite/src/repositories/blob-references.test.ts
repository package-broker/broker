import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  blobEligibleCondition,
  createBlobReferenceReader,
  RETENTION_CANDIDATE_LIMIT,
} from './blob-references.js';
import { withForeignKeysOff } from '../testing/foreign-keys-off.js';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let reader: ReturnType<typeof createBlobReferenceReader>;

const digest = (n: number) => n.toString(16).padStart(64, '0');
const shaOf = (id: string) => digest(Number(id.slice(4)));
const blobId = (n: number) => `BLOB${String(n).padStart(4, '0')}`;
let counter = 0;

beforeEach(async () => {
  counter = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  reader = createBlobReferenceReader(executor);
});

afterEach(async () => {
  await database.close();
});

async function run(sql: string, params: (string | number | null)[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function source(
  org: OrgContext,
  id: string,
  type = 'npmjs_proxy',
  override: number | null = null,
): Promise<void> {
  await run(
    'INSERT INTO source (id, org_id, name, ecosystem, type, retention_days_override) VALUES (?, ?, ?, ?, ?, ?)',
    [id, org.orgId, id, 'npm', type, override],
  );
}

async function pkg(org: OrgContext, id: string, sourceId: string, status = 'active') {
  await run(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name, status, removed_upstream_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      org.orgId,
      sourceId,
      'npm',
      id.toLowerCase(),
      status,
      status === 'active' ? null : '2026-01-01T00:00:00.000Z',
    ],
  );
}

async function blob(org: OrgContext, n: number, extra = ''): Promise<string> {
  await run(
    `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)`,
    [blobId(n), org.orgId, digest(n), `k${n}`],
  );
  if (extra !== '') await run(`UPDATE blob SET ${extra} WHERE id = ?`, [blobId(n)]);
  return blobId(n);
}

const forgedSeed =
  <A extends unknown[], R>(seed: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    withForeignKeysOff(executor, () => seed(...args));

async function version(
  org: OrgContext,
  packageId: string,
  blob: string | null,
  status = 'active',
): Promise<string> {
  counter += 1;
  const id = `VER${String(counter).padStart(4, '0')}`;
  await run(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, blob_id, status, removed_upstream_at, tombstoned_at)
VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'upstream', '{}', ?, ?, ?, ?)`,
    [
      id,
      org.orgId,
      packageId,
      `1.0.${counter}`,
      String(counter).padStart(5, '0'),
      blob,
      status,
      status === 'removed_upstream' ? '2026-01-01T00:00:00.000Z' : null,
      status === 'tombstoned' ? '2026-01-01T00:00:00.000Z' : null,
    ],
  );
  return id;
}

const versionForged = forgedSeed(version);

async function revision(org: OrgContext, versionId: string, blob: string, n = 2) {
  await run(
    `INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, metadata_json, reason) VALUES (?, ?, ?, ?, ?, '{}', 'test')`,
    [`REV${versionId}${n}`, org.orgId, versionId, n, blob],
  );
}

async function shas(org = a, limit = 50): Promise<string[]> {
  return (await reader.candidates(org, { limit })).map((c) => c.sha256).sort();
}

describe('blob reference check', () => {
  beforeEach(async () => {
    await source(a, 'SRC1');
    await pkg(a, 'PKG1', 'SRC1');
  });

  it('blob referenced by an active and a removed version is not a candidate', async () => {
    const id = await blob(a, 1);
    await version(a, 'PKG1', id, 'active');
    await version(a, 'PKG1', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
  });

  it('blob referenced only by removed or tombstoned versions is a candidate', async () => {
    const one = await blob(a, 1);
    const two = await blob(a, 2);
    await version(a, 'PKG1', one, 'removed_upstream');
    await version(a, 'PKG1', two, 'tombstoned');
    expect(await shas()).toEqual([digest(1), digest(2)]);
    expect(await reader.stillEligible(a, shaOf(one))).toBe(true);
  });

  it.each(['quarantined', 'yanked'])('a %s version keeps its blob', async (status) => {
    const id = await blob(a, 1);
    await version(a, 'PKG1', id, status);
    expect(await shas()).toEqual([]);
  });

  it('a version of a removed_upstream package releases its blob', async () => {
    await pkg(a, 'PKG2', 'SRC1', 'removed_upstream');
    const id = await blob(a, 1);
    await version(a, 'PKG2', id, 'active');
    expect(await shas()).toEqual([digest(1)]);
  });

  it('a revision reference of an active version keeps the blob', async () => {
    const old = await blob(a, 1);
    const current = await blob(a, 2);
    const v = await version(a, 'PKG1', current, 'active');
    await revision(a, v, old);
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(old))).toBe(false);
  });

  it('a revision reference of a removed version does not keep the blob', async () => {
    const old = await blob(a, 1);
    const v = await version(a, 'PKG1', null, 'removed_upstream');
    await revision(a, v, old);
    expect(await shas()).toEqual([digest(1)]);
  });

  it('a version back to active makes the blob ineligible', async () => {
    const id = await blob(a, 1);
    const v = await version(a, 'PKG1', id, 'removed_upstream');
    expect(await reader.stillEligible(a, shaOf(id))).toBe(true);
    await run("UPDATE version SET status = 'active', removed_upstream_at = NULL WHERE id = ?", [v]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
    expect(await shas()).toEqual([]);
  });

  it('hosted-source blobs are never eligible', async () => {
    await source(a, 'HOST', 'hosted');
    await pkg(a, 'PKGH', 'HOST');
    const id = await blob(a, 1);
    await version(a, 'PKGH', id, 'tombstoned');
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
  });

  it('a blob shared with a hosted source is not eligible', async () => {
    await source(a, 'HOST', 'hosted');
    await pkg(a, 'PKGH', 'HOST');
    const id = await blob(a, 1);
    await version(a, 'PKG1', id, 'removed_upstream');
    await version(a, 'PKGH', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
  });

  it('a blob nothing references is not eligible', async () => {
    const id = await blob(a, 1);
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
  });

  it('purge_after set still passes stillEligible but is not a candidate', async () => {
    const id = await blob(a, 1, "purge_after = '2026-02-01T00:00:00.000Z'");
    await version(a, 'PKG1', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(true);
  });

  it('deleted blobs are not candidates', async () => {
    const id = await blob(a, 1, "deleted_at = '2026-02-01T00:00:00.000Z'");
    await version(a, 'PKG1', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
  });

  it('returns the source retention override', async () => {
    await source(a, 'SRC2', 'npmjs_proxy', 90);
    await pkg(a, 'PKG2', 'SRC2');
    const withOverride = await blob(a, 1);
    const without = await blob(a, 2);
    await version(a, 'PKG2', withOverride, 'removed_upstream');
    await version(a, 'PKG1', without, 'removed_upstream');
    const rows = await reader.candidates(a, { limit: 50 });
    expect(rows.find((r) => r.sha256 === digest(1))?.retentionDaysOverride).toBe(90);
    expect(rows.find((r) => r.sha256 === digest(2))?.retentionDaysOverride).toBeNull();
  });

  it('keeps the largest override when sources share a blob', async () => {
    await source(a, 'SRC2', 'npmjs_proxy', 90);
    await source(a, 'SRC3', 'npmjs_proxy', 30);
    await pkg(a, 'PKG2', 'SRC2');
    await pkg(a, 'PKG3', 'SRC3');
    const id = await blob(a, 1);
    await version(a, 'PKG2', id, 'removed_upstream');
    await version(a, 'PKG3', id, 'removed_upstream');
    const rows = await reader.candidates(a, { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.retentionDaysOverride).toBe(90);
  });

  it('does not see another organization', async () => {
    await source(b, 'SRCB');
    await pkg(b, 'PKGB', 'SRCB');
    const id = await blob(b, 1);
    await version(b, 'PKGB', id, 'removed_upstream');
    expect(await shas(a)).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
    expect(await shas(b)).toEqual([digest(1)]);
  });

  it('caps and validates the limit', async () => {
    for (let n = 1; n <= 3; n += 1) {
      await version(a, 'PKG1', await blob(a, n), 'removed_upstream');
    }
    expect(await reader.candidates(a, { limit: 2 })).toHaveLength(2);
    for (const bad of [0, -1, 1.5, RETENTION_CANDIDATE_LIMIT + 1, Number.NaN]) {
      await expect(reader.candidates(a, { limit: bad })).rejects.toThrow(TypeError);
    }
    await expect(reader.stillEligible(a, 'BLOB0001')).rejects.toThrow(TypeError);
  });

  it('a version in another organization referencing the blob id protects it', async () => {
    await source(b, 'SRCB');
    await pkg(b, 'PKGB', 'SRCB');
    const id = await blob(a, 1);
    await version(a, 'PKG1', id, 'removed_upstream');
    expect(await shas()).toEqual([digest(1)]);
    await version(b, 'PKGB', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
  });

  it('a version pointing at a package of another organization is live', async () => {
    await source(b, 'SRCB');
    await pkg(b, 'PKGB', 'SRCB');
    const id = await blob(a, 1);
    await versionForged(a, 'PKGB', id, 'removed_upstream');
    expect(await shas()).toEqual([]);
  });

  it('a revision under a removed_upstream package releases the blob', async () => {
    await pkg(a, 'PKG2', 'SRC1', 'removed_upstream');
    const old = await blob(a, 1);
    const v = await version(a, 'PKG2', null, 'active');
    await revision(a, v, old);
    expect(await shas()).toEqual([digest(1)]);
  });

  it('a removed-version revision plus an active direct reference keeps the blob', async () => {
    const id = await blob(a, 1);
    const removed = await version(a, 'PKG1', null, 'removed_upstream');
    await revision(a, removed, id);
    await version(a, 'PKG1', id, 'active');
    expect(await shas()).toEqual([]);
  });

  it('pages candidates with a cursor until drained', async () => {
    for (let n = 1; n <= 5; n += 1) {
      await version(a, 'PKG1', await blob(a, n), 'removed_upstream');
    }
    const seen: string[] = [];
    let after: { createdAt: string; id: string } | null = null;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page: Awaited<ReturnType<typeof reader.candidates>> = await reader.candidates(a, {
        limit: 2,
        after,
      });
      if (page.length === 0) break;
      seen.push(...page.map((c) => c.id));
      const last = page.at(-1);
      after = last === undefined ? null : { createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map(blobId));
  });

  describe('unexpired import before-images', () => {
    async function beforeImage(id: string, expiresAt: string | null): Promise<void> {
      await run(
        "INSERT INTO import_run (id, org_id, source_system, before_image_expires_at) VALUES ('RUN1', ?, 'x', ?)",
        [a.orgId, expiresAt],
      );
      await run(
        `INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json)
VALUES ('REF1', ?, 'RUN1', 'version', 'VERX', 'ext', 'update', ?)`,
        [a.orgId, JSON.stringify({ blob_id: id })],
      );
    }

    it('keeps the blob while the before-image has not expired', async () => {
      const id = await blob(a, 1);
      await version(a, 'PKG1', id, 'removed_upstream');
      await beforeImage(id, '2999-01-01T00:00:00.000Z');
      expect(await shas()).toEqual([]);
      expect(await reader.stillEligible(a, shaOf(id))).toBe(false);
    });

    it('keeps the blob while the import run has no expiry', async () => {
      const id = await blob(a, 1);
      await version(a, 'PKG1', id, 'removed_upstream');
      await beforeImage(id, null);
      expect(await shas()).toEqual([]);
    });

    it('releases the blob once the before-image has expired', async () => {
      const id = await blob(a, 1);
      await version(a, 'PKG1', id, 'removed_upstream');
      await beforeImage(id, '2000-01-01T00:00:00.000Z');
      expect(await shas()).toEqual([digest(1)]);
    });
  });

  describe('scheduledIneligible', () => {
    const scheduled = "purge_after = '2026-02-01T00:00:00.000Z'";

    it('lists scheduled blobs that became referenced again', async () => {
      const id = await blob(a, 1, scheduled);
      const v = await version(a, 'PKG1', id, 'removed_upstream');
      expect(await reader.scheduledIneligible(a, { limit: 50 })).toEqual([]);
      await run("UPDATE version SET status = 'active' WHERE id = ?", [v]);
      const rows = await reader.scheduledIneligible(a, { limit: 50 });
      expect(rows.map((r) => r.sha256)).toEqual([digest(1)]);
      expect(rows[0]?.id).toBe(id);
    });

    it('ignores blobs without a schedule and eligible scheduled blobs', async () => {
      await version(a, 'PKG1', await blob(a, 1), 'active');
      await version(a, 'PKG1', await blob(a, 2, scheduled), 'removed_upstream');
      expect(await reader.scheduledIneligible(a, { limit: 50 })).toEqual([]);
    });
  });

  it('drives both reference branches through their indexes', async () => {
    const eligible = blobEligibleCondition(a, 'b');
    const [plan] = await executor.batch([
      {
        sql: `EXPLAIN QUERY PLAN SELECT b.id FROM blob b WHERE b.sha256 = ? AND ${eligible.sql}`,
        params: [digest(1), ...eligible.params],
      },
    ]);
    const details = (plan?.rows ?? []).map((row) => String((row as { detail: string }).detail));
    expect(details.some((d) => d.includes('INDEX version_blob'))).toBe(true);
    expect(details.some((d) => d.includes('INDEX version_revision_blob'))).toBe(true);
    expect(details.filter((d) => /^SCAN (v|r|version|version_revision)\b/.test(d))).toEqual([]);
  });

  it('walks only unexpired import runs and indexes every branch in the real candidates query', async () => {
    let captured: { sql: string; params: readonly (string | number | null)[] } | null = null;
    const spying = createBlobReferenceReader({
      driver: executor.driver,
      all: async (statement) => {
        captured = statement;
        return executor.all(statement);
      },
      batch: (statements) => executor.batch(statements),
    });
    await spying.candidates(a, { limit: 5 });
    if (captured === null) throw new Error('no statement captured');
    const { sql, params } = captured as { sql: string; params: (string | number | null)[] };
    const [plan] = await executor.batch([{ sql: `EXPLAIN QUERY PLAN ${sql}`, params }]);
    const details = (plan?.rows ?? []).map((row) => String((row as { detail: string }).detail));
    const text = details.join('\n');
    expect(text).toContain('INDEX version_blob');
    expect(text).toContain('INDEX version_revision_blob');
    expect(text).toContain('INDEX import_ref_run_external');
    expect(text).toContain('INDEX upstream_state_content');
    expect(text).toContain(
      'INDEX ingest_session_snapshot_blob (org_id=? AND snapshot_blob_sha256=?)',
    );
    expect(text.indexOf('import_run')).toBeGreaterThan(-1);
    expect(text.indexOf('import_run')).toBeLessThan(text.indexOf('import_ref_run_external'));
    expect(
      details.filter((d) => /^SCAN (bref_\w+|version|version_revision|import_ref)\b/.test(d)),
    ).toEqual([]);
  });

  it.each(['V', 'IR'])('accepts %s as the outer blob alias and resolves it', async (alias) => {
    const id = await blob(a, 1);
    await version(a, 'PKG1', id, 'removed_upstream');
    const eligible = blobEligibleCondition(a, alias);
    const [result] = await executor.batch([
      {
        sql: `SELECT ${alias}.id AS id FROM blob ${alias} WHERE ${eligible.sql}`,
        params: [...eligible.params],
      },
    ]);
    expect(result?.rows).toEqual([{ id }]);
  });

  it('rejects an unsafe blob reference', () => {
    expect(() => blobEligibleCondition(a, 'b; DROP TABLE blob')).toThrow(TypeError);
    for (const alias of ['bref_v', 'BREF_V', 'Bref_Ru']) {
      expect(() => blobEligibleCondition(a, alias)).toThrow(TypeError);
    }
  });
});

describe('orphan retention', () => {
  const aged = (days: number) =>
    `refetchable = 1, published_at = NULL, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')`;

  beforeEach(async () => {
    await source(a, 'SRC1');
    await pkg(a, 'PKG1', 'SRC1');
  });

  it('returns an eight-day-old refetchable orphan with its flag and no override', async () => {
    const id = await blob(a, 1, aged(8));
    expect(await reader.candidates(a, { limit: 50 })).toEqual([
      expect.objectContaining({ id, orphan: true, retentionDaysOverride: null }),
    ]);
    expect(await reader.stillEligible(a, digest(1))).toBe(true);
  });

  it('keeps an old orphan re-published one minute ago', async () => {
    await blob(
      a,
      1,
      `${aged(30)}, published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute')`,
    );
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it.each(['version', 'revision'])(
    'keeps an aged blob referenced by a cross-org %s',
    async (kind) => {
      await source(b, 'SRCB');
      await pkg(b, 'PKGB', 'SRCB');
      const id = await blob(a, 1, aged(8));
      if (kind === 'version') await version(b, 'PKGB', id);
      else await revision(b, await version(b, 'PKGB', null), id);
      expect(await shas()).toEqual([]);
      expect(await reader.stillEligible(a, digest(1))).toBe(false);
    },
  );

  it('compares publication instants across timestamp formats', async () => {
    await blob(
      a,
      1,
      `${aged(30)}, published_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-6 days', '+14 hours') || '+14:00'`,
    );
    expect(await shas()).toEqual([]);
    await run(
      "UPDATE blob SET published_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-8 days', '-12 hours') || '-12:00'",
      [],
    );
    expect(await shas()).toEqual([digest(1)]);
  });

  it('keeps a six-day-old refetchable orphan', async () => {
    await blob(a, 1, aged(6));
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it('keeps a thirty-day-old non-refetchable orphan', async () => {
    await blob(a, 1, `${aged(30)}, refetchable = 0`);
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it.each(['running', 'complete', 'abandoned'])(
    'keeps a snapshot of a %s ingest session',
    async (state) => {
      await blob(a, 1, aged(8));
      await run(
        `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, snapshot_blob_sha256, started_at, updated_at)
VALUES ('ING1', ?, 'source', ?, 'SRC1', 1, 'worker', 1, '2000-01-01T00:00:00.000Z', ?, ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
        [a.orgId, digest(2), state, digest(1)],
      );
      expect(await shas()).toEqual([]);
      expect(await reader.stillEligible(a, digest(1))).toBe(false);
    },
  );

  it('keeps an upstream-state content blob', async () => {
    await blob(a, 1, aged(8));
    await run(
      `INSERT INTO upstream_state (org_id, package_id, form, content_sha256, checked_at, fresh_until)
VALUES (?, 'PKG1', 'npm-packument', ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      [a.orgId, digest(1)],
    );
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it.each(['2999-01-01T00:00:00.000Z', null])(
    'keeps an import before-image expiring at %s',
    async (expiry) => {
      const id = await blob(a, 1, aged(8));
      await run(
        "INSERT INTO import_run (id, org_id, source_system, before_image_expires_at) VALUES ('RUN1', ?, 'x', ?)",
        [a.orgId, expiry],
      );
      await run(
        `INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json)
VALUES ('REF1', ?, 'RUN1', 'version', 'VERX', 'ext', 'update', ?)`,
        [a.orgId, JSON.stringify({ blob_id: id })],
      );
      expect(await shas()).toEqual([]);
      expect(await reader.stillEligible(a, digest(1))).toBe(false);
    },
  );

  it('keeps an aged blob with an active version reference', async () => {
    const id = await blob(a, 1, aged(8));
    await version(a, 'PKG1', id);
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it('keeps an aged blob with an active revision reference', async () => {
    const id = await blob(a, 1, aged(8));
    await revision(a, await version(a, 'PKG1', null), id);
    expect(await shas()).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
  });

  it('finds a scheduled orphan that gains an active reference', async () => {
    const id = await blob(a, 1, aged(8));
    await run("UPDATE blob SET purge_after = '2999-01-01T00:00:00.000Z' WHERE id = ?", [id]);
    expect(await reader.stillEligible(a, digest(1))).toBe(true);
    expect(await reader.scheduledIneligible(a, { limit: 50 })).toEqual([]);
    await version(a, 'PKG1', id);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
    expect(await reader.scheduledIneligible(a, { limit: 50 })).toEqual([
      expect.objectContaining({ id }),
    ]);
  });

  it('never returns another organization’s orphan', async () => {
    await blob(b, 1, aged(8));
    expect(await shas(a)).toEqual([]);
    expect(await reader.stillEligible(a, digest(1))).toBe(false);
    expect(await shas(b)).toEqual([digest(1)]);
  });

  it('pages mixed orphan and released candidates by created_at and id', async () => {
    await blob(a, 2, aged(8));
    const released = await blob(a, 3, `${aged(8)}, refetchable = 0`);
    await version(a, 'PKG1', released, 'removed_upstream');
    await blob(a, 1, aged(9));
    await run(
      'UPDATE blob SET created_at = (SELECT created_at FROM blob WHERE id = ?) WHERE id = ?',
      [blobId(2), released],
    );
    const first = await reader.candidates(a, { limit: 2 });
    expect(first.map((row) => row.id)).toEqual([blobId(1), blobId(2)]);
    const after = first[1];
    if (after === undefined) throw new Error('missing first-page cursor');
    const second = await reader.candidates(a, { limit: 2, after });
    expect(second).toEqual([expect.objectContaining({ id: released, orphan: false })]);
  });

  it('keeps the eligibility parameter list unchanged and uses the seven-day literal', () => {
    const condition = blobEligibleCondition(a, 'b');
    expect(condition.params).toEqual([a.orgId]);
    expect(condition.sql).toContain("julianday('now', '-7 days')");
  });
});
