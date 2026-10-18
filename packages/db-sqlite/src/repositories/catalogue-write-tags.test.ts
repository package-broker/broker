import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { versionInsertStatements } from './catalogue-write-version-insert.js';
import {
  MAX_TAGS_PER_CALL,
  DistTagRefusedError,
  distTagStatements,
  type DistTagRequest,
} from './catalogue-write-tags.js';

const JOB_ID = '01J0JOB00000000000000000C1';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0C01';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOURCE = '01J0SRC0000000000000000S02';
const COMPOSER_SOURCE = '01J0SRC0000000000000000S01';
const PACKAGE = '01J0PKG0000000000000000K02';
const OTHER_PACKAGE = '01J0PKG0000000000000000K03';
const COMPOSER_PACKAGE = '01J0PKG0000000000000000K01';
const HISTORY = '2020-05-06T07:08:09.010Z';

let database: MigratedDatabase;
let org: OrgContext;
let guard: CatalogueWriteGuard;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
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
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
      SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
      COMPOSER_SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'widget')",
      PACKAGE,
      org.orgId,
      SOURCE,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'gadget')",
      OTHER_PACKAGE,
      org.orgId,
      SOURCE,
    ),
    stmt(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', 'acme/widget')",
      COMPOSER_PACKAGE,
      org.orgId,
      COMPOSER_SOURCE,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: JOB_ID, owner: OWNER, fence: 3 });
  for (const packageId of [PACKAGE, OTHER_PACKAGE]) {
    const plan = versionInsertStatements(org, guard, {
      packageId,
      ecosystem: 'npm',
      versions: ['1.0.0', '1.1.0', '2.0.0-beta.1'].map((version) => ({
        version,
        versionNormalized: version,
        history: { at: HISTORY, basis: 'release_date' as const },
        license: null,
        upstreamReleasedAt: HISTORY,
        distType: null,
        sourceRef: null,
        metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
      })),
    });
    await database.executor.batch(plan.statements);
  }
});

afterEach(async () => {
  await database.close();
});

interface TagRow {
  tag: string;
  version: string;
}
interface HistoryRow {
  tag: string;
  action: string;
  version: string | null;
  previous: string | null;
  actorType: string;
  actorId: string | null;
  opId: string | null;
}

const tags = (packageId = PACKAGE): Promise<TagRow[]> =>
  database.executor.all<TagRow>({
    sql: `SELECT t.tag, v.version_normalized AS version FROM dist_tag t
          JOIN version v ON v.id = t.version_id WHERE t.package_id = ? ORDER BY t.tag`,
    params: [packageId],
  });

const history = (packageId = PACKAGE): Promise<HistoryRow[]> =>
  database.executor.all<HistoryRow>({
    sql: `SELECT h.tag, h.action, v.version_normalized AS version, p.version_normalized AS previous,
            h.actor_type AS actorType, h.actor_id AS actorId, h.op_id AS opId
          FROM dist_tag_history h
          LEFT JOIN version v ON v.id = h.version_id
          LEFT JOIN version p ON p.id = h.previous_version_id
          WHERE h.package_id = ? ORDER BY h.rowid`,
    params: [packageId],
  });

async function clock(packageId = PACKAGE): Promise<{ rev: number; modifiedAt: string }> {
  const rows = await database.executor.all<{ rev: number; modifiedAt: string }>({
    sql: 'SELECT rev, modified_at AS modifiedAt FROM package WHERE id = ?',
    params: [packageId],
  });
  const row = rows[0];
  if (row === undefined) throw new Error('package missing');
  return row;
}

let counter = 0;
async function apply(
  map: Record<string, string>,
  overrides: Partial<DistTagRequest> = {},
  using: CatalogueWriteGuard = guard,
) {
  counter += 1;
  const plan = distTagStatements(org, using, {
    packageId: PACKAGE,
    ecosystem: 'npm',
    tags: map,
    actorType: 'sync',
    actorId: null,
    opId: `01J0OP${String(counter).padStart(20, '0')}`,
    ...overrides,
  });
  for (const s of plan.statements) expect(s.params.length).toBeLessThanOrEqual(100);
  const results = await database.executor.batch(plan.statements);
  return plan.result(results);
}

describe('distTagStatements', () => {
  it('1: a replay writes no history and does not move the package clock', async () => {
    await apply({ latest: '1.0.0', next: '2.0.0-beta.1' });
    const before = await clock();
    const rows = (await history()).length;
    const again = await apply({ latest: '1.0.0', next: '2.0.0-beta.1' });
    expect(await history()).toHaveLength(rows);
    expect(await clock()).toEqual(before);
    expect(again.updated).toBe(0);
    expect(await tags()).toEqual([
      { tag: 'latest', version: '1.0.0' },
      { tag: 'next', version: '2.0.0-beta.1' },
    ]);
  });

  it('1: the first write records a set row per tag with the actor and op id', async () => {
    const before = await clock();
    await apply({ latest: '1.0.0' }, { actorType: 'user', actorId: 'u-1', opId: 'op-first' });
    expect(await history()).toEqual([
      {
        tag: 'latest',
        action: 'set',
        version: '1.0.0',
        previous: null,
        actorType: 'user',
        actorId: 'u-1',
        opId: 'op-first',
      },
    ]);
    expect((await clock()).rev).toBe(before.rev + 1);
  });

  it('1: moving latest writes one set row with the previous version', async () => {
    await apply({ latest: '1.0.0' });
    const before = await clock();
    await apply({ latest: '1.1.0' });
    const rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      tag: 'latest',
      action: 'set',
      version: '1.1.0',
      previous: '1.0.0',
    });
    expect(await tags()).toEqual([{ tag: 'latest', version: '1.1.0' }]);
    const after = await clock();
    expect(after.rev).toBe(before.rev + 1);
    expect(after.modifiedAt > before.modifiedAt).toBe(true);
  });

  it('1: removing a tag writes one remove row and deletes the tag', async () => {
    await apply({ latest: '1.0.0', next: '2.0.0-beta.1' });
    const result = await apply({ latest: '1.0.0' });
    const rows = await history();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      tag: 'next',
      action: 'remove',
      version: null,
      previous: '2.0.0-beta.1',
    });
    expect(await tags()).toEqual([{ tag: 'latest', version: '1.0.0' }]);
    expect(result.updated).toBe(1);
  });

  it('1: an empty map removes every tag', async () => {
    await apply({ latest: '1.0.0', beta: '2.0.0-beta.1' });
    await apply({});
    expect(await tags()).toEqual([]);
    expect((await history()).filter((row) => row.action === 'remove')).toHaveLength(2);
  });

  it('2: an invalid upstream tag is skipped and reported while valid tags apply', async () => {
    const result = await apply({
      latest: '1.0.0',
      '1.2.3': '1.0.0',
      Bad: '1.0.0',
      'a b': '1.0.0',
      '-x': '1.0.0',
      ['a'.repeat(65)]: '1.0.0',
    });
    expect([...result.skippedTags].sort()).toEqual(
      ['-x', '1.2.3', 'Bad', 'a b', 'a'.repeat(65)].sort(),
    );
    expect(await tags()).toEqual([{ tag: 'latest', version: '1.0.0' }]);
  });

  it('2: the same tag from a user refuses the whole batch', () => {
    const inputTags = { latest: '1.0.0', '1.2.3': '1.0.0', 'invalid tag': '1.1.0' };
    const write = () =>
      distTagStatements(org, guard, {
        packageId: PACKAGE,
        ecosystem: 'npm',
        tags: inputTags,
        actorType: 'user',
        actorId: 'u-1',
        opId: 'op-user',
      });
    expect(write).toThrow(DistTagRefusedError);
    try {
      write();
    } catch (error) {
      if (!(error instanceof DistTagRefusedError)) throw error;
      expect(error.message).toBe('DIST_TAGS_REFUSED');
      expect(error.tags).toEqual(['1.2.3', 'invalid tag']);
      for (const value of [...Object.keys(inputTags), ...Object.values(inputTags)]) {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it('2: a user target that is not a live version refuses the batch and writes nothing', async () => {
    await expect(
      apply({ latest: '9.9.9' }, { actorType: 'user', actorId: 'u-1' }),
    ).rejects.toThrow();
    expect(await tags()).toEqual([]);
    expect(await history()).toEqual([]);
  });

  it('3: a tag targeting a version that exists only in another package is skipped', async () => {
    await database.executor.batch([
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability,
           published_at, published_at_basis, metadata_json)
         VALUES ('01J0VER00000000000000000X1', ?, ?, '3.0.0', '3.0.0', 'stable', ?, 'broker', '{}')`,
        org.orgId,
        OTHER_PACKAGE,
        HISTORY,
      ),
    ]);
    const result = await apply({ latest: '1.0.0', next: '3.0.0' });
    expect(result.skippedTags).toEqual(['next']);
    expect(await tags()).toEqual([{ tag: 'latest', version: '1.0.0' }]);
    expect(await tags(OTHER_PACKAGE)).toEqual([]);
  });

  it('3: a tombstoned target is skipped and an existing tag on it stays', async () => {
    await apply({ latest: '1.0.0' });
    await database.executor.batch([
      stmt(
        "UPDATE version SET status = 'tombstoned', tombstoned_at = '2021-01-01T00:00:00.000Z' WHERE package_id = ? AND version = '1.1.0'",
        PACKAGE,
      ),
    ]);
    const result = await apply({ latest: '1.1.0' });
    expect(result.skippedTags).toEqual(['latest']);
    expect(await tags()).toEqual([{ tag: 'latest', version: '1.0.0' }]);
    expect(await history()).toHaveLength(1);
  });

  it('refuses composer packages', () => {
    expect(() =>
      distTagStatements(org, guard, {
        packageId: COMPOSER_PACKAGE,
        ecosystem: 'composer',
        tags: {},
        actorType: 'sync',
        actorId: null,
        opId: 'op-c',
      }),
    ).toThrow(/composer/);
  });

  it('refuses more than the tag cap and a guard built for another organization', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_TAGS_PER_CALL + 1 }, (_, index) => [`t${String(index)}`, '1.0.0']),
    );
    expect(() =>
      distTagStatements(org, guard, {
        packageId: PACKAGE,
        ecosystem: 'npm',
        tags: many,
        actorType: 'sync',
        actorId: null,
        opId: 'op-many',
      }),
    ).toThrow(RangeError);
    const foreign = database.orgs?.b;
    if (foreign === undefined) throw new Error('second organization missing');
    expect(() =>
      distTagStatements(foreign, guard, {
        packageId: PACKAGE,
        ecosystem: 'npm',
        tags: {},
        actorType: 'sync',
        actorId: null,
        opId: 'op-foreign',
      }),
    ).toThrow(TypeError);
  });

  it('a lost job lease writes nothing', async () => {
    await database.executor.batch([stmt('UPDATE job SET fence = 4 WHERE id = ?', JOB_ID)]);
    await expect(apply({ latest: '1.0.0' })).rejects.toThrow();
    expect(await tags()).toEqual([]);
    expect(await history()).toEqual([]);
  });

  it('refuses an existing foreign package without changing its tags, history or clock', async () => {
    const foreign = database.orgs?.b;
    if (foreign === undefined) throw new Error('second organization missing');
    const foreignPackage = '01J0PKG0000000000000000ZZZ';
    const foreignSource = '01J0SRC0000000000000000ZZZ';
    const foreignVersion = '01J0VER0000000000000000ZZZ';
    await database.executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'npm', 'npm', 'npm_registry')",
        foreignSource,
        foreign.orgId,
      ),
      stmt(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'widget')",
        foreignPackage,
        foreign.orgId,
        foreignSource,
      ),
      stmt(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability,
           published_at, published_at_basis, metadata_json)
         VALUES (?, ?, ?, '1.0.0', '1.0.0', 'stable', ?, 'broker', '{}')`,
        foreignVersion,
        foreign.orgId,
        foreignPackage,
        HISTORY,
      ),
      stmt(
        "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, 'next', ?)",
        foreign.orgId,
        foreignPackage,
        foreignVersion,
      ),
      stmt(
        `INSERT INTO dist_tag_history
          (id, org_id, package_id, tag, version_id, action, actor_type, op_id)
         VALUES ('01J0HIS0000000000000000ZZZ', ?, ?, 'next', ?, 'set', 'sync', 'op-seed')`,
        foreign.orgId,
        foreignPackage,
        foreignVersion,
      ),
    ]);
    const beforeTags = await tags(foreignPackage);
    const beforeHistory = await history(foreignPackage);
    const beforeClock = await clock(foreignPackage);
    const plan = distTagStatements(org, guard, {
      packageId: foreignPackage,
      ecosystem: 'npm',
      tags: { latest: '1.0.0' },
      actorType: 'sync',
      actorId: null,
      opId: 'op-foreign-package',
    });
    await expect(database.executor.batch(plan.statements)).rejects.toThrow();
    expect(await tags(foreignPackage)).toEqual(beforeTags);
    expect(await history(foreignPackage)).toEqual(beforeHistory);
    expect(await clock(foreignPackage)).toEqual(beforeClock);
  });
});

it('rejects an oversized planned batch including its lease guard', () => {
  const oversized = registerCatalogueWriteGuard(
    org,
    Array.from({ length: 200 }, () => ({
      sql: 'SELECT 1',
      params: [],
    })),
  );
  expect(() =>
    distTagStatements(org, oversized, {
      packageId: PACKAGE,
      ecosystem: 'npm',
      actorType: 'sync',
      actorId: null,
      opId: 'budget-test',
      tags: { latest: '1.0.0' },
    }),
  ).toThrowError(expect.objectContaining({ name: 'DbError', kind: 'too_big' }));
});
