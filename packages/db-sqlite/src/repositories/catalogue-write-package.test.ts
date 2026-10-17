import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { catalogueWriteGuard, type CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  MAX_DESCRIPTION_BYTES,
  createCatalogueWriteGuard,
  packageUpsertStatements,
  type PackageUpsertInput,
} from './catalogue-write-package.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S01';
const NPM_SOURCE = '01J0SRC0000000000000000S02';
const FOREIGN_SOURCE = '01J0SRC0000000000000000S0B';
const P1 = '01J0PRJ0000000000000000P01';
const P2 = '01J0PRJ0000000000000000P02';
const P3 = '01J0PRJ0000000000000000P03';
const PB = '01J0PRJ0000000000000000P0B';
const KEY = 'acme/widget';

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
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'b', 'composer', 'composer_repository')",
      FOREIGN_SOURCE,
      other.orgId,
    ),
    stmt("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p1', 'P1')", P1, org.orgId),
    stmt("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p2', 'P2')", P2, org.orgId),
    stmt("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p3', 'P3')", P3, org.orgId),
    stmt("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'pb', 'PB')", PB, other.orgId),
    stmt(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      org.orgId,
      P1,
      SOURCE,
    ),
    stmt(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      org.orgId,
      P2,
      SOURCE,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
});

afterEach(async () => {
  await database.close();
});

const input = (overrides: Partial<PackageUpsertInput> = {}): PackageUpsertInput => ({
  sourceId: SOURCE,
  ecosystem: 'composer',
  key: KEY,
  description: 'A widget',
  ...overrides,
});

interface PackageRow {
  id: string;
  description: string | null;
  visible: number;
  rev: number;
  modifiedAt: string;
  lastSyncedAt: string | null;
}

async function packages(): Promise<PackageRow[]> {
  return database.executor.all<PackageRow>({
    sql: `SELECT id, description, visible_to_new_projects AS visible, rev,
            modified_at AS modifiedAt, last_synced_at AS lastSyncedAt
          FROM package ORDER BY id`,
    params: [],
  });
}

async function memberships(): Promise<string[]> {
  const rows = await database.executor.all<{ p: string; o: string }>({
    sql: 'SELECT project_id AS p, origin AS o FROM project_package ORDER BY project_id',
    params: [],
  });
  return rows.map((r) => `${r.p}:${r.o}`);
}

async function upsert(
  value: PackageUpsertInput,
  using: CatalogueWriteGuard = guard,
  ctx: OrgContext = org,
): Promise<{ candidateId: string; changes: number }> {
  const plan = packageUpsertStatements(ctx, using, value);
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = await database.executor.batch(plan.statements);
  const changes = results.slice(using.length).reduce((sum, r) => sum + r.changes, 0);
  return { candidateId: plan.candidateId, changes };
}

describe('packageUpsertStatements', () => {
  it('1: materializes a new package into both attached projects in the creating batch', async () => {
    const { candidateId } = await upsert(input());
    const rows = await packages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: candidateId, visible: 1, rev: 1, description: 'A widget' });
    expect(await memberships()).toEqual([`${P1}:subscription`, `${P2}:subscription`]);
  });

  it('1: a replay changes nothing and keeps rev', async () => {
    const first = await upsert(input());
    const before = await packages();
    const replay = await upsert(input());
    expect(replay.candidateId).not.toBe(first.candidateId);
    expect(replay.changes).toBe(0);
    expect(await packages()).toEqual(before);
    expect(await memberships()).toEqual([`${P1}:subscription`, `${P2}:subscription`]);
  });

  it('1: an existing package is not re-materialized where it was removed', async () => {
    await upsert(input());
    await database.executor.batch([stmt('DELETE FROM project_package WHERE project_id = ?', P2)]);
    await upsert(input({ description: 'Changed' }));
    expect(await memberships()).toEqual([`${P1}:subscription`]);
  });

  it('1: an include pattern that does not match keeps the new package out of that project', async () => {
    await database.executor.batch([
      stmt(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('pat1', ?, ?, ?, 'other/*', 'include')",
        org.orgId,
        P2,
        SOURCE,
      ),
    ]);
    await upsert(input());
    expect(await memberships()).toEqual([`${P1}:subscription`]);
  });

  it('initial flag follows source.default_visible_to_new_projects = 0 and materializes nothing', async () => {
    await database.executor.batch([
      stmt('UPDATE source SET default_visible_to_new_projects = 0 WHERE id = ?', SOURCE),
    ]);
    await upsert(input());
    expect((await packages())[0]?.visible).toBe(0);
    expect(await memberships()).toEqual([]);
  });

  it('2: existing flags are never overwritten', async () => {
    await upsert(input());
    await database.executor.batch([stmt('UPDATE package SET visible_to_new_projects = 0')]);
    await upsert(input());
    expect((await packages())[0]?.visible).toBe(0);
    await database.executor.batch([
      stmt('UPDATE package SET visible_to_new_projects = 1'),
      stmt('UPDATE source SET default_visible_to_new_projects = 0 WHERE id = ?', SOURCE),
    ]);
    await upsert(input({ description: 'Changed' }));
    expect((await packages())[0]?.visible).toBe(1);
  });

  it('2: a description change bumps rev once, an identical description does not', async () => {
    await upsert(input());
    const changed = await upsert(input({ description: 'New text' }));
    expect(changed.changes).toBe(1);
    expect((await packages())[0]).toMatchObject({ rev: 2, description: 'New text' });
    const same = await upsert(input({ description: 'New text' }));
    expect(same.changes).toBe(0);
    expect((await packages())[0]?.rev).toBe(2);
    await upsert(input({ description: null }));
    expect((await packages())[0]).toMatchObject({ rev: 3, description: null });
    await upsert(input({ description: null }));
    expect((await packages())[0]?.rev).toBe(3);
  });

  it('2: modified_at moves to at least previous + 1 ms and last_synced_at stays untouched', async () => {
    await upsert(input());
    const ahead = '2098-06-01T12:00:00.123Z';
    await database.executor.batch([
      stmt(
        'UPDATE package SET modified_at = ?, last_synced_at = ?',
        ahead,
        '2020-01-01T00:00:00.000Z',
      ),
    ]);
    await upsert(input({ description: 'Later' }));
    const row = (await packages())[0];
    expect(row?.modifiedAt).toBe('2098-06-01T12:00:00.124Z');
    expect(row?.lastSyncedAt).toBe('2020-01-01T00:00:00.000Z');

    await database.executor.batch([
      stmt('UPDATE package SET modified_at = ?', '2000-01-01T00:00:00.000Z'),
    ]);
    const start = Date.now();
    await upsert(input({ description: 'Now' }));
    const now = Date.parse((await packages())[0]?.modifiedAt ?? '');
    expect(now).toBeGreaterThanOrEqual(start - 5);
    expect(now).toBeLessThanOrEqual(Date.now() + 5);
  });

  it.each([
    ['fence advanced', { id: JOB_ID, owner: OWNER, fence: 4 }],
    ['other owner', { id: JOB_ID, owner: '01J0WWWWWWWWWWWWWWWWWW0C02', fence: 3 }],
  ])('3: a stale job guard (%s) rolls back creation and materialization', async (_label, stale) => {
    const staleGuard = createCatalogueWriteGuard(org, stale);
    await expect(upsert(input(), staleGuard)).rejects.toThrow();
    expect(await packages()).toEqual([]);
    expect(await memberships()).toEqual([]);
  });

  it('3: a stale job guard rolls back a description change', async () => {
    await upsert(input());
    await database.executor.batch([stmt("UPDATE job SET state = 'succeeded'")]);
    await expect(upsert(input({ description: 'Stale' }))).rejects.toThrow();
    expect((await packages())[0]).toMatchObject({ rev: 1, description: 'A widget' });
  });

  it('a guard built for another organization fails the batch', async () => {
    const foreignGuard = createCatalogueWriteGuard(other, { id: JOB_ID, owner: OWNER, fence: 3 });
    await expect(upsert(input(), foreignGuard)).rejects.toThrow();
    expect(await packages()).toEqual([]);
  });

  it('refuses a guard holding a valid lease of another organization before building SQL', async () => {
    const FOREIGN_JOB = '01J0JOB00000000000000000C2';
    await database.executor.batch([
      stmt(
        `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
          VALUES (?, ?, 'catalogue:sync:v1', ?, 'running', ?, ?, 3)`,
        FOREIGN_JOB,
        other.orgId,
        `k:${FOREIGN_JOB}`,
        OWNER,
        FUTURE,
      ),
    ]);
    const foreignLease = createCatalogueWriteGuard(other, {
      id: FOREIGN_JOB,
      owner: OWNER,
      fence: 3,
    });
    expect(() => packageUpsertStatements(org, foreignLease, input())).toThrow(TypeError);
    expect(() => packageUpsertStatements(org, catalogueWriteGuard([...guard]), input())).toThrow(
      TypeError,
    );
    expect(await packages()).toEqual([]);
  });

  it('refuses a source outside the context organization', async () => {
    await expect(upsert(input({ sourceId: FOREIGN_SOURCE }))).rejects.toThrow();
    expect(await packages()).toEqual([]);
    expect(await memberships()).toEqual([]);
  });

  it('refuses a source of another ecosystem', async () => {
    await expect(upsert(input({ sourceId: NPM_SOURCE }))).rejects.toThrow();
    await expect(upsert(input({ ecosystem: 'npm', key: 'widget' }))).rejects.toThrow();
    expect(await packages()).toEqual([]);
  });

  it('a forged cross-organization attachment does not materialize the package', async () => {
    await database.executor.batch([
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        org.orgId,
        PB,
        SOURCE,
      ),
    ]);
    await upsert(input());
    expect(await memberships()).toEqual([`${P1}:subscription`, `${P2}:subscription`]);
  });

  it('a project-level source materializes only into its owner', async () => {
    await database.executor.batch([
      stmt('UPDATE source SET project_id = ? WHERE id = ?', P1, SOURCE),
    ]);
    await upsert(input());
    expect(await memberships()).toEqual([`${P1}:subscription`]);
  });

  it('accepts a description of exactly 4 KiB and refuses a longer one before any SQL', () => {
    expect(MAX_DESCRIPTION_BYTES).toBe(4096);
    expect(() =>
      packageUpsertStatements(org, guard, input({ description: 'a'.repeat(4096) })),
    ).not.toThrow();
    expect(() =>
      packageUpsertStatements(org, guard, input({ description: 'a'.repeat(4097) })),
    ).toThrow(RangeError);
    expect(() =>
      packageUpsertStatements(org, guard, input({ description: 'é'.repeat(2049) })),
    ).toThrow(RangeError);
  });

  it.each([
    ['empty key', { key: '' }],
    ['upper-case key', { key: 'Acme/Widget' }],
    ['unknown ecosystem', { ecosystem: 'pypi' as never }],
    ['empty source id', { sourceId: '' }],
    ['source id over 512 characters', { sourceId: 's'.repeat(513) }],
    ['control character in key', { key: 'acme/wid\u0000get' }],
    ['newline in key', { key: 'acme/widget\n' }],
    ['delete character in key', { key: 'acme/widget\u007f' }],
    ['non-string description', { description: 7 as never }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => packageUpsertStatements(org, guard, input(overrides))).toThrow(RangeError);
  });

  it('registers repository-built guards for their organization and rejects empty statements', async () => {
    const registered = registerCatalogueWriteGuard(org, [...guard]);
    await upsert(input(), registered);
    expect(await packages()).toHaveLength(1);
    expect(() => packageUpsertStatements(other, registered, input())).toThrow(TypeError);
    expect(() => registerCatalogueWriteGuard(org, [])).toThrow(TypeError);
  });

  it('keeps the job guard first in the batch', () => {
    const plan = packageUpsertStatements(org, guard, input());
    expect(plan.statements.slice(0, guard.length)).toEqual([...guard]);
  });
});
