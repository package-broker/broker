import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PackageRef } from '@package-broker/core/db/catalogue';
import type { OrgContext, ScalarStatement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueLookup } from './catalogue-lookup.js';

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function project(id: string, orgId = ctx.orgId): Promise<void> {
  await exec('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    id,
    orgId,
    id.toLowerCase(),
    id,
  ]);
}

async function source(
  id: string,
  type: string,
  options: { project?: string; ecosystem?: string; policy?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      ctx.orgId,
      options.project ?? null,
      id,
      options.ecosystem ?? 'npm',
      type,
      options.policy ?? 'flag',
    ],
  );
}

async function pkg(id: string, sourceId: string, name: string, ecosystem = 'npm'): Promise<void> {
  await exec(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    [id, ctx.orgId, sourceId, ecosystem, name],
  );
}

async function attach(projectId: string, sourceId: string, precedence = 100): Promise<void> {
  await exec(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [ctx.orgId, projectId, sourceId, precedence],
  );
}

async function admit(projectId: string, packageId: string, origin = 'subscription'): Promise<void> {
  await exec(
    'INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
    [ctx.orgId, projectId, packageId, origin],
  );
}

async function version(
  id: string,
  packageId: string,
  normalized: string,
  options: { status?: string; publishedAt?: string } = {},
): Promise<void> {
  const status = options.status ?? 'active';
  await exec(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at)
     VALUES (?, ?, ?, ?, ?, ?, 'import_time', '{}', ?, ?, ?)`,
    [
      id,
      ctx.orgId,
      packageId,
      `v${normalized}`,
      normalized,
      options.publishedAt ?? T0,
      status,
      status === 'removed_upstream' ? T0 : null,
      status === 'tombstoned' ? T0 : null,
    ],
  );
}

async function tag(packageId: string, name: string, versionId: string): Promise<void> {
  await exec('INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)', [
    ctx.orgId,
    packageId,
    name,
    versionId,
  ]);
}

const T0 = '2020-01-01T00:00:00.000Z';

function ref(key: string, extra: Partial<PackageRef> = {}): PackageRef {
  return { projectId: 'P1', ecosystem: 'npm', key, ...extra };
}

function lookup() {
  return createCatalogueLookup(database.executor);
}

async function singleNpmPackage(): Promise<void> {
  await source('S1', 'npm_registry');
  await attach('P1', 'S1');
  await pkg('K1', 'S1', 'left-pad');
  await admit('P1', 'K1');
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  other = database.orgs.b;
  await project('P1');
});

afterEach(async () => {
  await database.close();
});

describe('lookupVersion', () => {
  it('1: finds a version beyond the first 200 by published_at and maps the winner header', async () => {
    await singleNpmPackage();
    const statements: ScalarStatement[] = [];
    for (let n = 0; n < 250; n += 1) {
      const id = `V-${String(n).padStart(3, '0')}`;
      statements.push({
        sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
              VALUES (?, ?, 'K1', ?, ?, ?, 'import_time', '{}')`,
        params: [
          id,
          ctx.orgId,
          `1.0.${n}`,
          `1.0.${n}`,
          new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString(),
        ],
      });
    }
    await database.executor.batch(statements);
    const found = await lookup().lookupVersion(ctx, {
      ...ref('left-pad'),
      versionNormalized: '1.0.249',
    });
    expect(found?.version).toMatchObject({ versionId: 'V-249', version: '1.0.249', revision: 1 });
    expect(found?.pkg).toMatchObject({
      projectId: 'P1',
      ecosystem: 'npm',
      key: 'left-pad',
      packageId: 'K1',
      sourceId: 'S1',
      rev: 1,
      listingComplete: false,
    });
    expect(found?.pkg.cacheEpoch).toMatch(/^[0-9A-F]{32}$/);
    expect(
      await lookup().lookupVersion(ctx, { ...ref('left-pad'), versionNormalized: '9.9.9' }),
    ).toBeNull();
  });

  it('returns only available versions of the winner', async () => {
    await source('S1', 'npm_registry', { policy: 'flag' });
    await source('S2', 'npm_registry', { policy: 'exclude' });
    await attach('P1', 'S1', 10);
    await attach('P1', 'S2', 20);
    await pkg('K1', 'S1', 'left-pad');
    await pkg('K2', 'S2', 'left-pad');
    await admit('P1', 'K1');
    await admit('P1', 'K2');
    await version('V-A', 'K1', '1.0.0');
    await version('V-R', 'K1', '1.0.1', { status: 'removed_upstream' });
    await version('V-Q', 'K1', '1.0.2', { status: 'quarantined' });
    await version('V-T', 'K1', '1.0.3', { status: 'tombstoned' });
    await version('V-Y', 'K1', '1.0.4', { status: 'yanked' });
    await version('V-LOSER', 'K2', '2.0.0');
    const id = async (v: string) =>
      (await lookup().lookupVersion(ctx, { ...ref('left-pad'), versionNormalized: v }))?.version
        .versionId ?? null;
    expect(await id('1.0.0')).toBe('V-A');
    expect(await id('1.0.1')).toBe('V-R');
    expect(await id('1.0.2')).toBeNull();
    expect(await id('1.0.3')).toBeNull();
    expect(await id('1.0.4')).toBeNull();
    expect(await id('2.0.0')).toBeNull();
    await exec("DELETE FROM project_source WHERE source_id = 'S1'");
    expect(await id('2.0.0')).toBe('V-LOSER');
    await version('V-R2', 'K2', '2.0.1', { status: 'removed_upstream' });
    expect(await id('2.0.1')).toBeNull();
  });
});

describe('tags', () => {
  it('2: omits a tag whose target is unavailable and ignores a forged tag to another package', async () => {
    await singleNpmPackage();
    await source('S-EXCL', 'npm_registry', { policy: 'exclude' });
    await attach('P1', 'S-EXCL');
    await pkg('K-EXCL', 'S-EXCL', 'right-pad');
    await admit('P1', 'K-EXCL');
    await pkg('K-OTHER', 'S1', 'other-pkg');
    await admit('P1', 'K-OTHER');
    await version('V-A', 'K1', '1.0.0');
    await version('V-R', 'K1', '1.0.1', { status: 'removed_upstream' });
    await version('V-Q', 'K1', '1.0.2', { status: 'quarantined' });
    await version('V-T', 'K1', '1.0.3', { status: 'tombstoned' });
    await version('V-Y', 'K1', '1.0.4', { status: 'yanked' });
    await version('V-OTHER', 'K-OTHER', '3.0.0');
    await version('V-EA', 'K-EXCL', '1.0.0');
    await version('V-ER', 'K-EXCL', '1.0.1', { status: 'removed_upstream' });
    await tag('K1', 'latest', 'V-A');
    await tag('K1', 'legacy', 'V-R');
    await tag('K1', 'held', 'V-Q');
    await tag('K1', 'gone', 'V-T');
    await tag('K1', 'yanked', 'V-Y');
    await tag('K1', 'forged', 'V-OTHER');
    await tag('K-EXCL', 'latest', 'V-EA');
    await tag('K-EXCL', 'legacy', 'V-ER');

    const tags = await lookup().distTags(ctx, ref('left-pad'));
    expect(tags?.pkg).toMatchObject({ packageId: 'K1', sourceId: 'S1' });
    expect(tags?.tags).toEqual({ latest: 'v1.0.0', legacy: 'v1.0.1' });
    expect((await lookup().distTags(ctx, ref('right-pad')))?.tags).toEqual({ latest: 'v1.0.0' });

    const target = async (key: string, name: string) =>
      (await lookup().lookupTag(ctx, { ...ref(key), tag: name }))?.version.versionId ?? null;
    expect(await target('left-pad', 'latest')).toBe('V-A');
    expect(await target('left-pad', 'legacy')).toBe('V-R');
    for (const name of ['held', 'gone', 'yanked', 'forged', 'missing']) {
      expect(await target('left-pad', name), name).toBeNull();
    }
    expect(await target('right-pad', 'legacy')).toBeNull();
  });

  it('returns the header with no tags when none are available, and nothing for Composer', async () => {
    await singleNpmPackage();
    await version('V-Q', 'K1', '1.0.0', { status: 'quarantined' });
    await tag('K1', 'latest', 'V-Q');
    expect(await lookup().distTags(ctx, ref('left-pad'))).toMatchObject({
      pkg: { packageId: 'K1' },
      tags: {},
    });
    await source('S-C', 'vcs', { ecosystem: 'composer' });
    await attach('P1', 'S-C');
    await pkg('K-C', 'S-C', 'acme/a', 'composer');
    await admit('P1', 'K-C');
    await version('V-C', 'K-C', '1.0.0.0');
    await tag('K-C', 'latest', 'V-C');
    const composer = ref('acme/a', { ecosystem: 'composer' });
    expect(await lookup().distTags(ctx, composer)).toMatchObject({
      pkg: { packageId: 'K-C' },
      tags: {},
    });
    expect(await lookup().lookupTag(ctx, { ...composer, tag: 'latest' })).toBeNull();
  });
});

describe('statement and isolation', () => {
  it('3: one executor.all per call, bounded parameters and index searches only', async () => {
    await singleNpmPackage();
    await version('V-A', 'K1', '1.0.0');
    await tag('K1', 'latest', 'V-A');
    for (let n = 0; n < 30; n += 1) {
      await project(`PX${n}`);
      await attach(`PX${n}`, 'S1');
    }
    for (let n = 0; n < 40; n += 1) {
      await pkg(`K-${n}`, 'S1', `pad-${n}`);
      await admit('P1', `K-${n}`);
      for (let v = 0; v < 5; v += 1) await version(`V${n}-${v}`, `K-${n}`, `1.0.${v}`);
      await tag(`K-${n}`, 'latest', `V${n}-4`);
    }
    await database.analyze();
    const captured: ScalarStatement[] = [];
    const counted = countCalls(database.executor);
    const capturing = new Proxy(counted.executor, {
      get(target, property, receiver) {
        if (property === 'all') {
          return async (statement: ScalarStatement) => {
            captured.push(statement);
            return target.all(statement);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const l = createCatalogueLookup(capturing);
    expect(
      await l.lookupVersion(ctx, { ...ref('left-pad'), versionNormalized: '1.0.0' }),
    ).not.toBeNull();
    expect(await l.lookupTag(ctx, { ...ref('left-pad'), tag: 'latest' })).not.toBeNull();
    expect(await l.distTags(ctx, ref('left-pad'))).not.toBeNull();
    expect(await l.lookupVersion(ctx, { ...ref('absent'), versionNormalized: '1.0.0' })).toBeNull();
    expect(await l.lookupTag(ctx, { ...ref('absent'), tag: 'latest' })).toBeNull();
    expect(await l.distTags(ctx, ref('absent'))).toBeNull();
    expect(counted.counts()).toEqual({ all: 6, batch: 0 });
    for (const statement of captured) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
      const plan = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      const details = plan.map((row) => row.detail);
      expect(
        details.filter((d) => /^SCAN (v|pkg|dt|version|package|dist_tag)\b/.test(d)),
        details.join('\n'),
      ).toEqual([]);
    }
  });

  it('an invisible package is null: other project level source, forged rows, other organization', async () => {
    await project('P2');
    await source('S-P2', 'npm_registry', { project: 'P2' });
    await attach('P2', 'S-P2');
    await attach('P1', 'S-P2');
    await pkg('K-P2', 'S-P2', 'secret');
    await admit('P2', 'K-P2');
    await admit('P1', 'K-P2', 'explicit');
    await version('V-P2', 'K-P2', '1.0.0');
    await tag('K-P2', 'latest', 'V-P2');
    const query = ref('secret');
    expect(
      (await lookup().lookupVersion(ctx, { ...query, projectId: 'P2', versionNormalized: '1.0.0' }))
        ?.version.versionId,
    ).toBe('V-P2');
    expect(await lookup().lookupVersion(ctx, { ...query, versionNormalized: '1.0.0' })).toBeNull();
    expect(await lookup().lookupTag(ctx, { ...query, tag: 'latest' })).toBeNull();
    expect(await lookup().distTags(ctx, query)).toBeNull();
    const p2 = ref('secret', { projectId: 'P2' });
    expect(await lookup().lookupVersion(other, { ...p2, versionNormalized: '1.0.0' })).toBeNull();
    expect(await lookup().lookupTag(other, { ...p2, tag: 'latest' })).toBeNull();
    expect(await lookup().distTags(other, p2)).toBeNull();
  });

  it('a private key hidden from the project never falls through to a proxy row', async () => {
    await source('S-PRIV', 'npm_registry');
    await source('S-PROXY', 'npmjs_proxy');
    await attach('P1', 'S-PROXY');
    await pkg('K-PRIV', 'S-PRIV', 'left-pad');
    await pkg('K-PROXY', 'S-PROXY', 'left-pad');
    await admit('P1', 'K-PROXY');
    await version('V-PROXY', 'K-PROXY', '1.0.0');
    await tag('K-PROXY', 'latest', 'V-PROXY');
    expect(
      await lookup().lookupVersion(ctx, { ...ref('left-pad'), versionNormalized: '1.0.0' }),
    ).toBeNull();
    expect(await lookup().lookupTag(ctx, { ...ref('left-pad'), tag: 'latest' })).toBeNull();
    expect(await lookup().distTags(ctx, ref('left-pad'))).toBeNull();
  });

  it('refuses non-string lookup values before touching the database', async () => {
    const counted = countCalls(database.executor);
    const l = createCatalogueLookup(counted.executor);
    await expect(
      l.lookupVersion(ctx, { ...ref('left-pad'), versionNormalized: 1 as unknown as string }),
    ).rejects.toThrow(TypeError);
    await expect(
      l.lookupTag(ctx, { ...ref('left-pad'), tag: null as unknown as string }),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});
