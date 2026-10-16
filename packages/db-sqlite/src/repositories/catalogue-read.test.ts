import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWinner } from '@package-broker/core/catalogue/visibility';
import type {
  CatalogueVersion,
  PackageResolution,
  PageBinding,
  PageChanged,
  ResolveVersionsQuery,
  VersionCursor,
} from '@package-broker/core/db/catalogue';
import type { VersionStability } from '@package-broker/core/catalogue/versions';
import {
  orgContext,
  type OrgContext,
  type ScalarStatement,
  type SqlExecutor,
} from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
  type CatalogueConfig,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReader } from './catalogue-read.js';

type Result = PackageResolution | PageChanged | null;

function isPage(result: Result): result is PackageResolution {
  return result !== null && !('changed' in result);
}

function page(result: Result): PackageResolution {
  if (!isPage(result)) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result;
}

async function readAll(
  executor: SqlExecutor,
  ctx: OrgContext,
  query: Omit<ResolveVersionsQuery, 'binding' | 'after'>,
): Promise<{ first: PackageResolution | null; versions: CatalogueVersion[]; calls: number }> {
  const counted = countCalls(executor);
  const reader = createCatalogueReader(counted.executor);
  const first = await reader.resolveVersions(ctx, query);
  if (first === null) return { first: null, versions: [], calls: counted.counts().all };
  let current = page(first);
  const versions = [...current.versions];
  let pages = 1;
  while (current.next !== null) {
    current = page(
      await reader.resolveVersions(ctx, {
        ...query,
        binding: current.binding,
        after: current.next,
      }),
    );
    versions.push(...current.versions);
    pages += 1;
  }
  expect(counted.counts()).toEqual({ all: pages, batch: 0 });
  return { first: page(first), versions, calls: pages };
}

describe('resolveVersions against the oracle', () => {
  it('1: matches resolveWinner and the filtered version list on 200 random configurations', async () => {
    let winners = 0;
    let multiPage = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const config = randomCatalogueConfig(seed, 6, {
        longVersionLists: seed % 20 === 0,
        forged: seed % 2 === 1,
      });
      const database = await openMigratedDatabase();
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(database.executor, config);
        const inputs = toVisibilityInputs(config);
        const keys = new Map<string, { ecosystem: 'composer' | 'npm'; key: string }>();
        for (const p of config.packages) keys.set(`${p.ecosystem}\0${p.key}`, p);
        keys.set('composer\0absent/key', { ecosystem: 'composer', key: 'absent/key' });
        const stabilities: (VersionStability | undefined)[] = [undefined, 'dev', 'stable'];
        let n = 0;
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const { ecosystem, key } of keys.values()) {
            n += 1;
            const stability = stabilities[n % 3];
            const publishedAtMost = n % 4 === 0 ? '2020-01-03T00:00:00.000Z' : undefined;
            const limit = seed % 3 === 0 ? 200 : 1 + (n % 3);
            const query = {
              projectId: project.id,
              ecosystem,
              key,
              limit,
              ...(stability === undefined ? {} : { stability }),
              ...(publishedAtMost === undefined ? {} : { publishedAtMost }),
            };
            const expected = resolveWinner(inputs, project.id, ecosystem, key);
            const actual = await readAll(database.executor, ctx, query);
            if (expected === null) {
              expect(actual.first, `${seed} ${project.id} ${key}`).toBeNull();
              continue;
            }
            winners += 1;
            if (actual.calls > 1 && limit === 200) multiPage += 1;
            expect(actual.first?.pkg).toMatchObject({
              packageId: expected.packageId,
              sourceId: expected.sourceId,
              projectId: project.id,
              ecosystem,
              key,
              rev: 1,
              listingComplete: false,
            });
            expect(actual.first?.pkg.cacheEpoch).toMatch(/^[0-9A-F]{32}$/);
            expect(actual.versions.map((v) => v.versionId)).toEqual(
              expectedVersions(config, expected.packageId, ecosystem, stability, publishedAtMost),
            );
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(winners).toBeGreaterThan(500);
    expect(multiPage).toBeGreaterThan(0);
  }, 120_000);
});

function expectedVersions(
  config: CatalogueConfig,
  packageId: string,
  ecosystem: 'composer' | 'npm',
  stability: VersionStability | undefined,
  publishedAtMost: string | undefined,
): string[] {
  const pkg = config.packages.find((p) => p.id === packageId);
  const source = config.sources.find((s) => s.id === pkg?.sourceId);
  return config.versions
    .filter(
      (v) =>
        v.packageId === packageId &&
        (v.status === 'active' ||
          (v.status === 'removed_upstream' && source?.removalPolicy === 'flag')) &&
        (ecosystem !== 'composer' ||
          stability === undefined ||
          (stability === 'dev') === (v.stability === 'dev')) &&
        (publishedAtMost === undefined || v.publishedAt <= publishedAtMost),
    )
    .sort((a, b) =>
      a.publishedAt < b.publishedAt
        ? -1
        : a.publishedAt > b.publishedAt
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    )
    .map((v) => v.id);
}

let database: MigratedDatabase;
let ctx: OrgContext;
let other: OrgContext;

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function project(id: string, orgId = ctx.orgId, status = 'active'): Promise<void> {
  await exec('INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)', [
    id,
    orgId,
    id.toLowerCase(),
    id,
    status,
  ]);
}

async function source(
  id: string,
  type: string,
  options: { project?: string; ecosystem?: string; policy?: string; orgId?: string } = {},
): Promise<void> {
  await exec(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      options.orgId ?? ctx.orgId,
      options.project ?? null,
      id,
      options.ecosystem ?? 'composer',
      type,
      options.policy ?? 'flag',
    ],
  );
}

async function pkg(
  id: string,
  sourceId: string,
  name: string,
  options: { flag?: number; status?: string; ecosystem?: string; orgId?: string } = {},
): Promise<void> {
  await exec(
    `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status, removed_upstream_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId ?? ctx.orgId,
      sourceId,
      options.ecosystem ?? 'composer',
      name,
      options.flag ?? 1,
      options.status ?? 'active',
      options.status === 'removed_upstream' ? '2020-01-01T00:00:00.000Z' : null,
    ],
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
  publishedAt: string,
  options: { status?: string; stability?: string; metadata?: string; normalized?: string } = {},
): Promise<void> {
  const status = options.status ?? 'active';
  await exec(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at,
                          published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import_time', ?, ?, ?, ?)`,
    [
      id,
      ctx.orgId,
      packageId,
      options.normalized ?? id,
      options.normalized ?? id,
      options.stability ?? 'stable',
      publishedAt,
      options.metadata ?? '{}',
      status,
      status === 'removed_upstream' ? '2020-01-01T00:00:00.000Z' : null,
      status === 'tombstoned' ? '2020-01-01T00:00:00.000Z' : null,
    ],
  );
}

const T0 = '2020-01-01T00:00:00.000Z';
const day = (n: number): string => new Date(Date.UTC(2020, 0, 1 + n)).toISOString();

function reader() {
  return createCatalogueReader(database.executor);
}

function query(key: string, extra: Partial<ResolveVersionsQuery> = {}): ResolveVersionsQuery {
  return { projectId: 'P1', ecosystem: 'composer', key, limit: 200, ...extra };
}

async function continueWith(
  first: PackageResolution,
  key: string,
  extra: Partial<ResolveVersionsQuery> = {},
): Promise<Result> {
  return reader().resolveVersions(
    ctx,
    query(key, { ...extra, binding: first.binding, after: first.next as VersionCursor }),
  );
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

describe('resolveVersions statement', () => {
  it('2: one executor.all per call and a plan that searches the indexes without scanning version or package', async () => {
    await source('S1', 'vcs');
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S1');
    await attach('P1', 'S-PROXY');
    for (let n = 0; n < 30; n += 1) {
      await project(`PX${n}`);
      await attach(`PX${n}`, 'S1');
    }
    for (let n = 0; n < 40; n += 1) {
      await pkg(`K${n}`, 'S1', `acme/p${n}`);
      await admit('P1', `K${n}`);
      await pkg(`KP${n}`, 'S-PROXY', `vendor/p${n}`);
      await admit('P1', `KP${n}`);
      for (let v = 0; v < 5; v += 1) await version(`V${n}-${v}`, `K${n}`, day(v));
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
    const first = page(
      await createCatalogueReader(capturing).resolveVersions(ctx, query('acme/p7', { limit: 2 })),
    );
    await createCatalogueReader(capturing).resolveVersions(
      ctx,
      query('acme/p7', {
        limit: 2,
        stability: 'dev',
        publishedAtMost: day(4),
        binding: first.binding,
        after: first.next as VersionCursor,
      }),
    );
    expect(counted.counts()).toEqual({ all: 2, batch: 0 });
    for (const statement of captured) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
      const plan = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      const details = plan.map((row) => row.detail);
      const text = details.join('\n');
      expect(
        details.filter((d) => /^SCAN (v|pkg|q|version|package)\b/.test(d)),
        text,
      ).toEqual([]);
      expect(text).toMatch(/USING INDEX package_by_name/);
      expect(text).toMatch(/USING INDEX version_by_published/);
      expect(text).toMatch(/SEARCH pp USING (PRIMARY KEY|INDEX project_package_package)/);
      expect(text).toMatch(/SEARCH ps USING PRIMARY KEY/);
      expect(text).toMatch(/USING INDEX sqlite_autoindex_project_1/);
    }
  });

  it('returns the header with zero qualifying versions, and null for an absent key', async () => {
    await source('S1', 'vcs');
    await attach('P1', 'S1');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K1');
    await version('V1', 'K1', T0, { status: 'quarantined' });
    const result = page(await reader().resolveVersions(ctx, query('acme/a')));
    expect(result.pkg).toMatchObject({ packageId: 'K1', sourceId: 'S1', rev: 1 });
    expect(result.versions).toEqual([]);
    expect(result.next).toBeNull();
    expect(result.binding).toEqual({ packageId: 'K1', sourceId: 'S1', rev: 1 });
    expect(await reader().resolveVersions(ctx, query('acme/absent'))).toBeNull();
  });

  it('maps every version column', async () => {
    await source('S1', 'vcs');
    await attach('P1', 'S1');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K1');
    await exec(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at,
         published_at_basis, upstream_released_at, license, dist_type, composer_shasum, npm_integrity,
         metadata_json, deprecated_message, revision)
       VALUES ('V1', ?, 'K1', 'v1.0.0', '1.0.0.0', 'stable', ?, 'import_time', ?, 'MIT', 'zip', 'abc', NULL, '{"a":1}', 'old', 3)`,
      [ctx.orgId, T0, day(1)],
    );
    await exec("UPDATE package SET last_synced_at = ? WHERE id = 'K1'", [T0]);
    const result = page(await reader().resolveVersions(ctx, query('acme/a')));
    expect(result.pkg.listingComplete).toBe(true);
    expect(result.versions).toEqual([
      {
        versionId: 'V1',
        revision: 3,
        version: 'v1.0.0',
        versionNormalized: '1.0.0.0',
        stability: 'stable',
        status: 'active',
        publishedAt: T0,
        upstreamReleasedAt: day(1),
        license: 'MIT',
        distType: 'zip',
        composerShasum: 'abc',
        npmIntegrity: null,
        deprecatedMessage: 'old',
        metadataJson: '{"a":1}',
      },
    ]);
  });

  it('filters version status by the removal policy and Composer stability by class; npm ignores stability', async () => {
    await source('S-FLAG', 'vcs');
    await source('S-EXCL', 'vcs', { policy: 'exclude' });
    await source('S-NPM', 'npm_registry', { ecosystem: 'npm' });
    for (const s of ['S-FLAG', 'S-EXCL', 'S-NPM']) await attach('P1', s);
    await pkg('K-FLAG', 'S-FLAG', 'acme/flag');
    await pkg('K-EXCL', 'S-EXCL', 'acme/excl');
    await pkg('K-NPM', 'S-NPM', 'left-pad', { ecosystem: 'npm' });
    for (const k of ['K-FLAG', 'K-EXCL', 'K-NPM']) {
      await admit('P1', k);
      await version(`${k}-A`, k, day(1));
      await version(`${k}-R`, k, day(2), { status: 'removed_upstream' });
      await version(`${k}-Q`, k, day(3), { status: 'quarantined' });
      await version(`${k}-T`, k, day(4), { status: 'tombstoned' });
      await version(`${k}-D`, k, day(5), { stability: 'dev' });
      await version(`${k}-B`, k, day(6), { stability: 'beta' });
    }
    const ids = async (key: string, extra: Partial<ResolveVersionsQuery> = {}) =>
      page(await reader().resolveVersions(ctx, query(key, extra))).versions.map((v) => v.versionId);
    expect(await ids('acme/flag')).toEqual(['K-FLAG-A', 'K-FLAG-R', 'K-FLAG-D', 'K-FLAG-B']);
    expect(await ids('acme/excl')).toEqual(['K-EXCL-A', 'K-EXCL-D', 'K-EXCL-B']);
    expect(await ids('acme/flag', { stability: 'dev' })).toEqual(['K-FLAG-D']);
    expect(await ids('acme/flag', { stability: 'stable' })).toEqual([
      'K-FLAG-A',
      'K-FLAG-R',
      'K-FLAG-B',
    ]);
    expect(await ids('acme/flag', { publishedAtMost: day(2) })).toEqual(['K-FLAG-A', 'K-FLAG-R']);
    expect(await ids('left-pad', { ecosystem: 'npm', stability: 'dev' })).toEqual([
      'K-NPM-A',
      'K-NPM-R',
      'K-NPM-D',
      'K-NPM-B',
    ]);
  });

  it('hides a removed_upstream package under exclude, an archived project and another organization', async () => {
    await project('P-ARCH', ctx.orgId, 'archived');
    await source('S-EXCL', 'vcs', { policy: 'exclude' });
    await source('S1', 'vcs');
    await attach('P1', 'S-EXCL');
    await attach('P1', 'S1');
    await attach('P-ARCH', 'S1');
    await pkg('K-GONE', 'S-EXCL', 'acme/gone', { status: 'removed_upstream' });
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K-GONE');
    await admit('P1', 'K1');
    await admit('P-ARCH', 'K1');
    expect(await reader().resolveVersions(ctx, query('acme/gone'))).toBeNull();
    expect(
      await reader().resolveVersions(ctx, query('acme/a', { projectId: 'P-ARCH' })),
    ).toBeNull();
    expect(await reader().resolveVersions(other, query('acme/a'))).toBeNull();
  });

  it('never reaches another project level package, even through forged project_source and project_package rows', async () => {
    await project('P2');
    await source('S-P2', 'vcs', { project: 'P2' });
    await attach('P2', 'S-P2');
    await attach('P1', 'S-P2');
    await pkg('K-P2', 'S-P2', 'acme/secret');
    await admit('P2', 'K-P2');
    await admit('P1', 'K-P2', 'explicit');
    expect(
      page(await reader().resolveVersions(ctx, query('acme/secret', { projectId: 'P2' }))).pkg
        .packageId,
    ).toBe('K-P2');
    expect(await reader().resolveVersions(ctx, query('acme/secret'))).toBeNull();
  });

  it('refuses invalid queries before touching the database', async () => {
    const counted = countCalls(database.executor);
    const r = createCatalogueReader(counted.executor);
    await expect(r.resolveVersions(ctx, query('acme/a', { limit: 0 }))).rejects.toThrow(TypeError);
    await expect(r.resolveVersions(ctx, query('acme/a', { limit: 201 }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      r.resolveVersions(ctx, query('acme/a', { after: { publishedAt: T0, id: 'V1' } })),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('page binding', () => {
  async function twoSources(): Promise<PackageResolution> {
    await source('S1', 'vcs');
    await source('S2', 'vcs');
    await attach('P1', 'S1', 10);
    await attach('P1', 'S2', 20);
    await pkg('K1', 'S1', 'acme/a');
    await pkg('K2', 'S2', 'acme/a');
    await admit('P1', 'K1');
    await admit('P1', 'K2');
    for (let v = 0; v < 3; v += 1) {
      await version(`V1-${v}`, 'K1', day(v));
      await version(`V2-${v}`, 'K2', day(v));
    }
    const first = page(await reader().resolveVersions(ctx, query('acme/a', { limit: 1 })));
    expect(first.binding).toEqual<PageBinding>({ packageId: 'K1', sourceId: 'S1', rev: 1 });
    expect(first.next).toEqual({ publishedAt: day(0), id: 'V1-0' });
    return first;
  }

  it('3a: an unchanged binding continues the page', async () => {
    const first = await twoSources();
    const second = page(await continueWith(first, 'acme/a', { limit: 1 }));
    expect(second.versions.map((v) => v.versionId)).toEqual(['V1-1']);
  });

  it('3b: a precedence change reports changed', async () => {
    const first = await twoSources();
    await exec("UPDATE project_source SET precedence = 30 WHERE source_id = 'S1'");
    expect(await continueWith(first, 'acme/a', { limit: 1 })).toEqual({ changed: true });
  });

  it('3c: a quarantine with its rev bump reports changed', async () => {
    const first = await twoSources();
    await exec("UPDATE version SET status = 'quarantined' WHERE id = 'V1-1'");
    await exec("UPDATE package SET rev = rev + 1 WHERE id = 'K1'");
    expect(await continueWith(first, 'acme/a', { limit: 1 })).toEqual({ changed: true });
  });

  it('3d: an inserted version with its rev bump reports changed', async () => {
    const first = await twoSources();
    await version('V1-NEW', 'K1', day(9));
    await exec("UPDATE package SET rev = rev + 1 WHERE id = 'K1'");
    expect(await continueWith(first, 'acme/a', { limit: 1 })).toEqual({ changed: true });
  });

  it('3e: a detach reports changed, also when no winner is left', async () => {
    const first = await twoSources();
    await exec("DELETE FROM project_package WHERE package_id IN ('K1', 'K2')");
    await exec("DELETE FROM project_source WHERE project_id = 'P1'");
    expect(await continueWith(first, 'acme/a', { limit: 1 })).toEqual({ changed: true });
  });

  it('3f: equal published_at values page without loss or duplication', async () => {
    await source('S1', 'vcs');
    await attach('P1', 'S1');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K1');
    const expected: string[] = [];
    for (let v = 0; v < 7; v += 1) {
      await version(`V-${String(6 - v)}`, 'K1', T0);
      expected.push(`V-${String(v)}`);
    }
    await version('V-LATER', 'K1', day(1));
    expected.push('V-LATER');
    const seen = await readAll(database.executor, ctx, query('acme/a', { limit: 2 }));
    expect(seen.versions.map((v) => v.versionId)).toEqual(expected);
    expect(seen.calls).toBe(4);
  });
});

describe('page bounds and proxy safety', () => {
  it('4a: a page stops at 4 MiB of metadata even below 200 rows', async () => {
    await source('S1', 'vcs');
    await attach('P1', 'S1');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K1');
    const metadata = JSON.stringify({ x: 'a'.repeat(250_000 - 8) });
    expect(metadata.length).toBe(250_000);
    for (let v = 0; v < 20; v += 1) {
      await version(`V-${String(v).padStart(2, '0')}`, 'K1', day(v), { metadata });
    }
    const first = page(await reader().resolveVersions(ctx, query('acme/a')));
    expect(first.versions).toHaveLength(16);
    expect(first.next).toEqual({ publishedAt: day(15), id: 'V-15' });
    const second = page(await continueWith(first, 'acme/a'));
    expect(second.versions.map((v) => v.versionId)).toEqual(['V-16', 'V-17', 'V-18', 'V-19']);
    expect(second.next).toBeNull();
  });

  it('4b: a page stops at the row limit', async () => {
    await source('S1', 'vcs');
    await attach('P1', 'S1');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K1');
    const statements: ScalarStatement[] = [];
    for (let v = 0; v < 201; v += 1) {
      const id = `V-${String(v).padStart(3, '0')}`;
      statements.push({
        sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json)
              VALUES (?, ?, 'K1', ?, ?, ?, 'import_time', '{}')`,
        params: [id, ctx.orgId, id, id, T0],
      });
    }
    await database.executor.batch(statements);
    const first = page(await reader().resolveVersions(ctx, query('acme/a')));
    expect(first.versions).toHaveLength(200);
    expect(first.next).toEqual({ publishedAt: T0, id: 'V-199' });
    const second = page(await continueWith(first, 'acme/a'));
    expect(second.versions.map((v) => v.versionId)).toEqual(['V-200']);
  });

  it('4c: a private key hidden from the project never falls through to a proxy row', async () => {
    await source('S-PRIV', 'vcs');
    await source('S-PROXY', 'packagist_proxy');
    await attach('P1', 'S-PRIV');
    await attach('P1', 'S-PROXY');
    await pkg('K-PRIV', 'S-PRIV', 'acme/private', { flag: 0 });
    await pkg('K-PROXY', 'S-PROXY', 'acme/private');
    await admit('P1', 'K-PROXY');
    await version('V-PROXY', 'K-PROXY', T0);
    expect(await reader().resolveVersions(ctx, query('acme/private'))).toBeNull();
    await exec("DELETE FROM project_source WHERE source_id = 'S-PRIV'");
    expect(await reader().resolveVersions(ctx, query('acme/private'))).toBeNull();
  });

  it('a non-proxy source outranks a proxy at equal precedence', async () => {
    await source('S-PROXY', 'packagist_proxy');
    await source('S1', 'vcs');
    await attach('P1', 'S-PROXY', 10);
    await attach('P1', 'S1', 10);
    await pkg('K-PROXY', 'S-PROXY', 'acme/a');
    await pkg('K1', 'S1', 'acme/a');
    await admit('P1', 'K-PROXY');
    await admit('P1', 'K1');
    expect(page(await reader().resolveVersions(ctx, query('acme/a'))).pkg.sourceId).toBe('S1');
  });
});
