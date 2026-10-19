import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { catalogueWriteGuard, type CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import {
  parseStatusRevisionReason,
  type StatusReason,
  type VersionStatus,
} from '@package-broker/core/catalogue/version-rules';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import {
  createCatalogueStatusRepository,
  quarantineStatements,
  QUARANTINE_STATEMENTS,
} from './catalogue-status.js';
import {
  versionStatusStatements,
  type StatusPlan,
} from '../internal/catalogue-status-statements.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S01';
const PACKAGE = '01J0PKG0000000000000000K01';
const VERSION = '01J0VER0000000000000000V01';
const OTHER_VERSION = '01J0VER0000000000000000V02';
const META = '{"name":"acme/widget","version":"1.0.0"}';

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
      'INSERT INTO cache_epoch (org_id, version) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING',
      org.orgId,
      'epoch-0',
    ),
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
  ]);
  await seedVersion(VERSION, '1.0.0.0');
  await seedVersion(OTHER_VERSION, '2.0.0.0');
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

function seedVersion(id: string, normalized: string, status: VersionStatus = 'active') {
  return database.executor.batch([
    stmt(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
         published_at_basis, metadata_json, status, source_ref, last_op_id)
        VALUES (?, ?, ?, ?, ?, '2020-01-01T00:00:00.000Z', 'release_date', ?, ?, 'ref-1', 'seed')`,
      id,
      org.orgId,
      PACKAGE,
      normalized.replace(/\.0$/, ''),
      normalized,
      META,
      status,
    ),
  ]);
}

interface State {
  status: string;
  revision: number;
  tombstonedAt: string | null;
  tombstoneReason: string | null;
  removedUpstreamAt: string | null;
}

async function state(id = VERSION): Promise<State> {
  const rows = await database.executor.all<State>({
    sql: `SELECT status, revision, tombstoned_at AS tombstonedAt, tombstone_reason AS tombstoneReason,
          removed_upstream_at AS removedUpstreamAt
          FROM version WHERE id = ?`,
    params: [id],
  });
  const row = rows[0];
  if (row === undefined) throw new Error('version missing');
  return row;
}

const revisions = (id = VERSION) =>
  database.executor.all<{
    revision: number;
    reason: string;
    metadata: string;
    sourceRef: string | null;
    opId: string | null;
  }>({
    sql: `SELECT revision, reason, metadata_json AS metadata, source_ref AS sourceRef, op_id AS opId
          FROM version_revision WHERE version_id = ? ORDER BY revision`,
    params: [id],
  });

const pkg = async () =>
  (
    await database.executor.all<{ rev: number; modifiedAt: string }>({
      sql: 'SELECT rev, modified_at AS modifiedAt FROM package WHERE id = ?',
      params: [PACKAGE],
    })
  )[0];

const epoch = async (ctx = org) =>
  (
    await database.executor.all<{ version: string }>({
      sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
      params: [ctx.orgId],
    })
  )[0]?.version;

async function apply(plan: StatusPlan) {
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  return plan.result(await database.executor.batch(plan.statements));
}

const quarantine = (
  versionId = VERSION,
  reason: 'digest_mismatch' | 'manifest_conflict' = 'digest_mismatch',
  using = guard,
) => apply(quarantineStatements(org, using, { versionId, reason }));

const transition = (to: VersionStatus, reason: StatusReason, versionId = VERSION) =>
  apply(versionStatusStatements(org, { versionId, to, reason }));

describe('quarantineStatements', () => {
  it('1: quarantines an active version with one reason-coded revision row', async () => {
    const before = await epoch();
    const rev = (await pkg())?.rev ?? 0;
    const result = await quarantine();
    expect(result.changed).toBe(true);
    expect(await state()).toMatchObject({ status: 'quarantined', revision: 2 });
    expect(await revisions()).toEqual([
      {
        revision: 1,
        reason: 'status:active>quarantined:digest_mismatch',
        metadata: META,
        sourceRef: 'ref-1',
        opId: expect.any(String),
      },
    ]);
    expect(await epoch()).not.toBe(before);
    expect((await pkg())?.rev).toBe(rev + 1);
  });

  it('1: quarantines a removed_upstream version for manifest_conflict', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    await quarantine(VERSION, 'manifest_conflict');
    expect((await revisions())[0]?.reason).toBe(
      'status:removed_upstream>quarantined:manifest_conflict',
    );
  });

  it('1: the package clock moves monotonically', async () => {
    const before = (await pkg())?.modifiedAt ?? '';
    await quarantine();
    expect(Date.parse((await pkg())?.modifiedAt ?? '')).toBeGreaterThan(Date.parse(before));
  });

  it.each(['quarantined', 'tombstoned', 'yanked'] as const)(
    '1: refuses without change from %s',
    async (status) => {
      await database.executor.batch([
        stmt(
          "UPDATE version SET status = ?, tombstoned_at = CASE WHEN ? = 'tombstoned' THEN '2021-01-01T00:00:00.000Z' END WHERE id = ?",
          status,
          status,
          VERSION,
        ),
      ]);
      const before = await epoch();
      const rev = (await pkg())?.rev;
      const result = await quarantine();
      expect(result.changed).toBe(false);
      expect(await state()).toMatchObject({ status, revision: 1 });
      expect(await revisions()).toEqual([]);
      expect(await epoch()).toBe(before);
      expect((await pkg())?.rev).toBe(rev);
    },
  );

  it('refuses an unknown version without change', async () => {
    const before = await epoch();
    const beforePackage = await pkg();
    expect((await quarantine('01J0VER0000000000000000X99')).changed).toBe(false);
    expect(await revisions()).toEqual([]);
    expect(await epoch()).toBe(before);
    expect(await pkg()).toEqual(beforePackage);
  });

  it('isolates a foreign version even with a valid organization lease', async () => {
    const otherJob = '01J0JOB00000000000000000C2';
    await database.executor.batch([
      stmt(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
        otherJob,
        other.orgId,
        `k:${otherJob}`,
        OWNER,
        FUTURE,
      ),
      stmt(
        'INSERT INTO cache_epoch (org_id, version) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING',
        other.orgId,
        'other-epoch-0',
      ),
    ]);
    const otherGuard = createCatalogueWriteGuard(other, { id: otherJob, owner: OWNER, fence: 3 });
    await database.executor.batch(otherGuard);
    const before = await epoch();
    const otherBefore = await epoch(other);
    const beforePackage = await pkg();
    const beforeVersion = await state();
    const foreign = quarantineStatements(other, otherGuard, {
      versionId: VERSION,
      reason: 'digest_mismatch',
    });
    expect((await apply(foreign)).changed).toBe(false);
    expect(await revisions()).toEqual([]);
    expect(await state()).toEqual(beforeVersion);
    expect(await epoch()).toBe(before);
    expect(await epoch(other)).toBe(otherBefore);
    expect(await pkg()).toEqual(beforePackage);
  });

  it.each([VERSION, 'missing-version'])(
    'reports the complete batch count for %s',
    async (versionId) => {
      const plan = quarantineStatements(org, guard, { versionId, reason: 'digest_mismatch' });
      expect(QUARANTINE_STATEMENTS).toBe(4);
      expect(plan.statements).toHaveLength(guard.length + QUARANTINE_STATEMENTS);
      const results = await database.executor.batch(plan.statements);
      expect(plan.result(results).statements).toBe(plan.statements.length);
    },
  );

  it('rejects an admin reason on the job-guarded path', () => {
    expect(() =>
      quarantineStatements(org, guard, {
        versionId: VERSION,
        reason: 'admin_quarantine' as 'digest_mismatch',
      }),
    ).toThrow(RangeError);
  });

  it('rejects a guard not built for the organization', () => {
    const forged = catalogueWriteGuard([stmt('SELECT 1')]);
    expect(() =>
      quarantineStatements(org, forged, { versionId: VERSION, reason: 'digest_mismatch' }),
    ).toThrow(TypeError);
  });

  it('rolls back completely when the job lease is stale', async () => {
    await database.executor.batch([stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID)]);
    await expect(quarantine()).rejects.toThrow();
    expect(await state()).toMatchObject({ status: 'active', revision: 1 });
    expect(await revisions()).toEqual([]);
  });

  it('leaves other versions untouched', async () => {
    await quarantine();
    expect(await state(OTHER_VERSION)).toMatchObject({ status: 'active', revision: 1 });
  });

  it('replays as a no-op', async () => {
    await quarantine();
    const epochAfter = await epoch();
    expect((await quarantine()).changed).toBe(false);
    expect(await revisions()).toHaveLength(1);
    expect(await epoch()).toBe(epochAfter);
  });
});

describe('versionStatusStatements', () => {
  it('tombstones and records the tombstone columns, never touching the epoch itself', async () => {
    const before = await epoch();
    const result = await transition('tombstoned', 'admin_tombstone');
    expect(result.changed).toBe(true);
    const row = await state();
    expect(row).toMatchObject({
      status: 'tombstoned',
      revision: 2,
      tombstoneReason: 'admin_tombstone',
    });
    expect(row.tombstonedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await epoch()).toBe(before);
  });

  it.each(['active', 'removed_upstream', 'quarantined'] as const)(
    'tombstones from %s',
    async (from) => {
      await database.executor.batch([
        stmt(
          "UPDATE version SET status = ?, removed_upstream_at = CASE WHEN ? = 'removed_upstream' THEN '2021-01-01T00:00:00.000Z' END WHERE id = ?",
          from,
          from,
          VERSION,
        ),
      ]);
      await transition('tombstoned', 'admin_tombstone');
      expect((await revisions())[0]?.reason).toBe(`status:${from}>tombstoned:admin_tombstone`);
    },
  );

  it.each([
    ['active', 'admin_release'],
    ['quarantined', 'admin_quarantine'],
    ['tombstoned', 'admin_tombstone'],
  ] as const)('refuses to leave tombstoned (to %s, %s)', async (to, reason) => {
    await transition('tombstoned', 'admin_tombstone');
    const rev = (await pkg())?.rev;
    expect((await transition(to, reason)).changed).toBe(false);
    expect(await state()).toMatchObject({ status: 'tombstoned', revision: 2 });
    expect(await revisions()).toHaveLength(1);
    expect((await pkg())?.rev).toBe(rev);
  });

  it('releases a quarantined version without a tombstone and without touching the epoch', async () => {
    await quarantine();
    const before = await epoch();
    const result = await transition('active', 'admin_release');
    expect(result.changed).toBe(true);
    expect(await state()).toMatchObject({
      status: 'active',
      revision: 3,
      tombstonedAt: null,
      tombstoneReason: null,
    });
    expect(await epoch()).toBe(before);
  });

  it('leaves version.updated_at to reconciliation across status transitions', async () => {
    const stamp = '2001-02-03T04:05:06.000Z';
    await database.executor.batch([
      stmt('UPDATE version SET updated_at = ? WHERE id = ?', stamp, VERSION),
    ]);
    await quarantine();
    await transition('active', 'admin_release');
    const rows = await database.executor.all(
      stmt('SELECT updated_at FROM version WHERE id = ?', VERSION),
    );
    expect(rows).toEqual([{ updated_at: stamp }]);
  });

  it('clears removed_upstream_at when releasing a previously removed version', async () => {
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'removed_upstream', removed_upstream_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    await quarantine();
    expect((await state()).removedUpstreamAt).not.toBeNull();
    const before = await epoch();
    expect((await transition('active', 'admin_release')).changed).toBe(true);
    expect(await state()).toMatchObject({ status: 'active', removedUpstreamAt: null });
    expect(await epoch()).toBe(before);
  });

  it('refuses releasing an active version', async () => {
    expect((await transition('active', 'admin_release')).changed).toBe(false);
    expect(await revisions()).toEqual([]);
  });

  it('throws for a reason that no transition into the status allows', () => {
    expect(() =>
      versionStatusStatements(org, { versionId: VERSION, to: 'active', reason: 'digest_mismatch' }),
    ).toThrow();
    expect(() =>
      versionStatusStatements(org, {
        versionId: VERSION,
        to: 'tombstoned',
        reason: 'admin_release',
      }),
    ).toThrow();
  });

  it('3: the revision reasons reconstruct the applied sequence', async () => {
    await quarantine();
    await transition('active', 'admin_release');
    await quarantine(VERSION, 'manifest_conflict');
    await transition('tombstoned', 'admin_tombstone');
    const parsed = (await revisions()).map((r) => parseStatusRevisionReason(r.reason));
    expect(parsed).toEqual([
      { from: 'active', to: 'quarantined', reason: 'digest_mismatch' },
      { from: 'quarantined', to: 'active', reason: 'admin_release' },
      { from: 'active', to: 'quarantined', reason: 'manifest_conflict' },
      { from: 'quarantined', to: 'tombstoned', reason: 'admin_tombstone' },
    ]);
    expect((await revisions()).map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(await state()).toMatchObject({ status: 'tombstoned', revision: 5 });
  });
});

describe('releaseQuarantine', () => {
  const ANCHORS = [
    {
      provider: 'oidc',
      anchor: 'oidc:https://idp.example.test',
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test'],
    },
  ];
  const BLOB = '01J0BLOB0000000000000000B1';
  let recorded: Statement[];

  async function actor(ctx: OrgContext, tag: string, permitted: boolean) {
    const userId = `01J0USER00000000000000${tag}`;
    const sessionId = `01J0SESS00000000000000${tag}`;
    const roleId = `01J0ROLE00000000000000${tag}`;
    const email = `${tag.toLowerCase()}@example.test`;
    const hash = tag
      .toLowerCase()
      .padEnd(64, '0')
      .replace(/[^0-9a-f]/g, 'a');
    const now = new Date().toISOString();
    await database.executor.batch([
      stmt(
        'INSERT OR IGNORE INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        ctx.orgId,
        'oidc',
        'oidc:https://idp.example.test',
      ),
      stmt(
        'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
        roleId,
        ctx.orgId,
        roleId.toLowerCase(),
        roleId,
        'organization',
      ),
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        ctx.orgId,
        roleId,
        permitted ? 'org:sources:write' : 'org:sources:read',
      ),
      stmt(
        'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
        userId,
        ctx.orgId,
        email,
        'active',
      ),
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        `01J0IDEN00000000000000${tag}`,
        ctx.orgId,
        userId,
        'oidc',
        `subject-${tag}`,
        email,
        new Date(Date.now() - 60_000).toISOString(),
      ),
      stmt(
        'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId,
        ctx.orgId,
        userId,
        hash,
        hash,
        now,
        now,
        '2999-01-01T00:00:00.000Z',
      ),
      stmt(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)',
        `01J0GRNT00000000000000${tag}`,
        ctx.orgId,
        'email',
        email,
        'organization',
        roleId,
        now,
        now,
      ),
    ]);
    return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
  }

  function repository() {
    return createCatalogueStatusRepository(
      {
        driver: database.executor.driver,
        all: (statement) => database.executor.all(statement),
        batch: (statements) => {
          recorded.push(...statements);
          return database.executor.batch(statements);
        },
      },
      { providerAnchors: ANCHORS },
    );
  }

  async function quarantined(lease: string | null, blobbed = true) {
    if (blobbed) {
      await database.executor.batch([
        stmt(
          'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
          BLOB,
          org.orgId,
          'b'.repeat(64),
          'storage-key-1',
        ),
        stmt('UPDATE version SET blob_id = ? WHERE id = ?', BLOB, VERSION),
      ]);
      if (lease !== null) await setLease(lease);
    }
    await database.executor.batch([
      stmt("UPDATE version SET status = 'quarantined' WHERE id = ?", VERSION),
    ]);
  }

  const setLease = (modifier: string | null) =>
    database.executor.batch([
      stmt(
        modifier === null
          ? 'UPDATE blob SET purge_lease_until = NULL WHERE id = ?'
          : `UPDATE blob SET purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${modifier}') WHERE id = ?`,
        BLOB,
      ),
    ]);

  async function untouched(run: () => Promise<unknown>) {
    const before = [await state(), await revisions(), await epoch(), await pkg()];
    await run();
    expect([await state(), await revisions(), await epoch(), await pkg()]).toEqual(before);
  }

  beforeEach(() => {
    recorded = [];
  });

  it.each([
    ['a version without a blob', async () => quarantined(null, false)],
    ['a blob that was never leased', async () => quarantined(null)],
  ])('1: releases %s with one revision row and no epoch bump', async (_name, seed) => {
    await seed();
    const admin = await actor(org, 'AD0001', true);
    const before = await epoch();
    const result = await repository().releaseQuarantine(org, admin, { versionId: VERSION });
    expect(result).toEqual({ ok: true, opId: expect.any(String) });
    expect(await state()).toMatchObject({ status: 'active', revision: 2 });
    expect((await revisions()).map((r) => r.reason)).toEqual([
      'status:quarantined>active:admin_release',
    ]);
    expect(await epoch()).toBe(before);
    for (const s of recorded) expect(s.params.length).toBeLessThanOrEqual(100);
  });

  it('1: refuses with blob_busy while the blob lease is live and changes nothing', async () => {
    await quarantined('+900 seconds');
    const admin = await actor(org, 'AD0001', true);
    await untouched(async () => {
      const result = await repository().releaseQuarantine(org, admin, { versionId: VERSION });
      expect(result).toEqual({ ok: false, reason: 'blob_busy' });
    });
    expect(await state()).toMatchObject({ status: 'quarantined', revision: 1 });
    expect(await revisions()).toEqual([]);
  });

  it('2: succeeds once the lease has expired', async () => {
    await quarantined('+900 seconds');
    const admin = await actor(org, 'AD0001', true);
    expect(await repository().releaseQuarantine(org, admin, { versionId: VERSION })).toEqual({
      ok: false,
      reason: 'blob_busy',
    });
    await setLease('-1 seconds');
    expect(await repository().releaseQuarantine(org, admin, { versionId: VERSION })).toMatchObject({
      ok: true,
    });
    expect(await state()).toMatchObject({ status: 'active' });
  });

  it.each(['after the failed batch', 'between the probe and refusal re-read'] as const)(
    'returns blob_busy when the lease expires %s',
    async (timing) => {
      await quarantined('+900 seconds');
      const admin = await actor(org, 'AD0001', true);
      let reads = 0;
      let expired = false;
      const racing = createCatalogueStatusRepository(
        {
          driver: database.executor.driver,
          async all<R = Record<string, unknown>>(statement: Statement) {
            const rows = await database.executor.all<R>(statement);
            reads += 1;
            if (timing === 'between the probe and refusal re-read' && reads === 2) {
              await setLease('-1 seconds');
              expired = true;
            }
            return rows;
          },
          async batch(statements) {
            try {
              return await database.executor.batch(statements);
            } catch (error) {
              if (timing === 'after the failed batch') {
                await setLease('-1 seconds');
                expired = true;
              }
              throw error;
            }
          },
        },
        { providerAnchors: ANCHORS },
      );
      await untouched(async () => {
        expect(await racing.releaseQuarantine(org, admin, { versionId: VERSION })).toEqual({
          ok: false,
          reason: 'blob_busy',
        });
      });
      expect(expired).toBe(true);
      expect(reads).toBe(3);
      expect(await state()).toMatchObject({ status: 'quarantined', revision: 1 });
      expect(await revisions()).toEqual([]);
    },
  );

  it('2: a second release of an active version is a conflict, not blob_busy, even with a live lease', async () => {
    await quarantined(null);
    const admin = await actor(org, 'AD0001', true);
    await repository().releaseQuarantine(org, admin, { versionId: VERSION });
    await setLease('+900 seconds');
    await untouched(async () => {
      expect(await repository().releaseQuarantine(org, admin, { versionId: VERSION })).toEqual({
        ok: false,
        reason: 'conflict',
      });
    });
  });

  it('2: a tombstoned version is a conflict, not blob_busy', async () => {
    await quarantined('+900 seconds');
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = '2021-01-01T00:00:00.000Z' WHERE id = ?",
        VERSION,
      ),
    ]);
    const admin = await actor(org, 'AD0001', true);
    expect(await repository().releaseQuarantine(org, admin, { versionId: VERSION })).toEqual({
      ok: false,
      reason: 'conflict',
    });
  });

  it('3: an actor without org:sources:write is refused as authority, leased or not', async () => {
    const reader = await actor(org, 'RD0001', false);
    await quarantined(null);
    const unleased = await repository().releaseQuarantine(org, reader, { versionId: VERSION });
    await setLease('+900 seconds');
    await untouched(async () => {
      const leased = await repository().releaseQuarantine(org, reader, { versionId: VERSION });
      expect(leased).toEqual({ ok: false, reason: 'authority' });
      expect(leased).toEqual(unleased);
    });
  });

  it('3: an unauthorized actor gets authority for an absent version too', async () => {
    const reader = await actor(org, 'RD0001', false);
    expect(
      await repository().releaseQuarantine(org, reader, {
        versionId: '01J0VER0000000000000000X99',
      }),
    ).toEqual({ ok: false, reason: 'authority' });
  });

  it('4: a version of another organization is not_found, identical to an absent id, leased or not', async () => {
    const foreign = await actor(other, 'FA0001', true);
    await quarantined(null);
    const absent = await repository().releaseQuarantine(other, foreign, {
      versionId: '01J0VER0000000000000000X99',
    });
    const unleased = await repository().releaseQuarantine(other, foreign, { versionId: VERSION });
    await setLease('+900 seconds');
    await untouched(async () => {
      const leased = await repository().releaseQuarantine(other, foreign, { versionId: VERSION });
      expect(leased).toEqual({ ok: false, reason: 'not_found' });
      expect(leased).toEqual(absent);
      expect(unleased).toEqual(absent);
    });
  });

  it('4: an absent id with authority is not_found', async () => {
    const admin = await actor(org, 'AD0001', true);
    expect(
      await repository().releaseQuarantine(org, admin, { versionId: '01J0VER0000000000000000X99' }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('5: the blob_busy refusal carries nothing but its reason', async () => {
    await quarantined('+900 seconds');
    const admin = await actor(org, 'AD0001', true);
    const result = await repository().releaseQuarantine(org, admin, { versionId: VERSION });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
    expect(JSON.stringify(result)).not.toContain(BLOB);
  });

  it('a lease on another blob does not hold the release', async () => {
    await quarantined(null);
    await database.executor.batch([
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_lease_until) VALUES ('01J0BLOB0000000000000000B2', ?, ?, 1, 'storage-key-2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+900 seconds'))",
        org.orgId,
        'c'.repeat(64),
      ),
    ]);
    const admin = await actor(org, 'AD0001', true);
    expect(await repository().releaseQuarantine(org, admin, { versionId: VERSION })).toMatchObject({
      ok: true,
    });
  });
});
