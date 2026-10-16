import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWinner } from '@package-broker/core/catalogue/visibility';
import type { ResolveDistQuery } from '@package-broker/core/db/catalogue';
import { orgContext, type OrgContext, type ScalarStatement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createDistResolver } from './catalogue-dist.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const T0 = '2020-01-01T00:00:00.000Z';

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
  options: { ecosystem?: string; orgId?: string } = {},
): Promise<void> {
  await exec(
    `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status)
     VALUES (?, ?, ?, ?, ?, 1, 'active')`,
    [id, options.orgId ?? ctx.orgId, sourceId, options.ecosystem ?? 'composer', name],
  );
}

async function attach(projectId: string, sourceId: string, precedence = 100): Promise<void> {
  await exec(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [ctx.orgId, projectId, sourceId, precedence],
  );
}

async function admit(projectId: string, packageId: string): Promise<void> {
  await exec(
    "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
    [ctx.orgId, projectId, packageId],
  );
}

async function blob(id: string, sha256: string, deleted = false): Promise<void> {
  await exec(
    `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable, upstream_url, deleted_at)
     VALUES (?, ?, ?, 42, ?, 'application/zip', 1, 'https://u:p@example.test/x.zip', ?)`,
    [id, ctx.orgId, sha256, `key-${id}`, deleted ? T0 : null],
  );
}

interface VersionOptions {
  normalized?: string;
  status?: string;
  blobId?: string | null;
  metadata?: string;
  revision?: number;
  distType?: string | null;
  composerShasum?: string | null;
  npmIntegrity?: string | null;
  sourceRef?: string | null;
}

async function version(id: string, packageId: string, options: VersionOptions = {}): Promise<void> {
  const status = options.status ?? 'active';
  await exec(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis,
       metadata_json, status, removed_upstream_at, tombstoned_at, blob_id, revision, dist_type,
       composer_shasum, npm_integrity, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, 'import_time', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ctx.orgId,
      packageId,
      options.normalized ?? '1.0.0.0',
      options.normalized ?? '1.0.0.0',
      T0,
      options.metadata ?? '{}',
      status,
      status === 'removed_upstream' ? T0 : null,
      status === 'tombstoned' ? T0 : null,
      options.blobId ?? null,
      options.revision ?? 1,
      options.distType ?? null,
      options.composerShasum ?? null,
      options.npmIntegrity ?? null,
      options.sourceRef ?? null,
    ],
  );
}

async function revisionRow(
  versionId: string,
  revision: number,
  options: { blobId?: string | null; metadata?: string; sourceRef?: string | null } = {},
): Promise<void> {
  await exec(
    `INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'dist')`,
    [
      `${versionId}-r${revision}`,
      ctx.orgId,
      versionId,
      revision,
      options.blobId ?? null,
      options.sourceRef ?? null,
      options.metadata ?? '{}',
    ],
  );
}

function byVersion(
  projectId: string,
  key: string,
  extra: { versionNormalized?: string; expect?: { versionId: string; revision: number } } = {},
  ecosystem: 'composer' | 'npm' = 'composer',
): ResolveDistQuery {
  return {
    projectId,
    ecosystem,
    key,
    by: 'version',
    versionNormalized: extra.versionNormalized ?? '1.0.0.0',
    ...(extra.expect === undefined ? {} : { expect: extra.expect }),
  };
}

function byId(
  projectId: string,
  key: string,
  versionId: string,
  revision: number,
): ResolveDistQuery {
  return { projectId, ecosystem: 'composer', key, by: 'id', versionId, revision };
}

function resolver() {
  return createDistResolver(database.executor);
}

const COMPOSER_META = JSON.stringify({
  dist: {
    shasum: 'ABCDEF0123456789abcdef0123456789abcdef01',
    type: 'zip',
    url: 'https://up.test/acme-x-1.zip',
  },
});

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  other = database.orgs.b;
  await project('PA');
  await project('PB');
});

afterEach(async () => {
  await database.close();
});

describe('resolveDist isolation (AC1)', () => {
  it('a digest referenced only by project B is absent from A; the same digest through A is reachable', async () => {
    await source('SB', 'vcs', { project: 'PB' });
    await attach('PB', 'SB');
    await pkg('KB', 'SB', 'acme/secret');
    await admit('PB', 'KB');
    await blob('B1', SHA_A);
    await version('VB', 'KB', { blobId: 'B1' });

    expect(await resolver().resolveDist(ctx, byVersion('PA', 'acme/secret'))).toBeNull();
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/secret', 'VB', 1))).toBeNull();
    expect(
      await resolver().resolveDist(
        ctx,
        byVersion('PA', 'acme/secret', { expect: { versionId: 'VB', revision: 1 } }),
      ),
    ).toBeNull();
    const own = await resolver().resolveDist(ctx, byVersion('PB', 'acme/secret'));
    expect(own?.blob?.sha256).toBe(SHA_A);

    await source('SA', 'vcs', { project: 'PA' });
    await attach('PA', 'SA');
    await pkg('KA', 'SA', 'acme/mine');
    await admit('PA', 'KA');
    await version('VA', 'KA', { blobId: 'B1' });
    const shared = await resolver().resolveDist(ctx, byVersion('PA', 'acme/mine'));
    expect(shared).toMatchObject({
      versionId: 'VA',
      packageId: 'KA',
      sourceId: 'SA',
      current: true,
    });
    expect(shared?.blob).toEqual({
      id: 'B1',
      sha256: SHA_A,
      sizeBytes: 42,
      mediaType: 'application/zip',
      refetchable: true,
    });
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/mine', 'VB', 1))).toBeNull();
  });

  it('another organization, a forged project_package row and a detached source are absent', async () => {
    await source('S1', 'vcs');
    await attach('PB', 'S1');
    await pkg('K1', 'S1', 'acme/x');
    await admit('PB', 'K1');
    await admit('PA', 'K1');
    await version('V1', 'K1');
    expect(await resolver().resolveDist(ctx, byVersion('PA', 'acme/x'))).toBeNull();
    expect(await resolver().resolveDist(other, byVersion('PB', 'acme/x'))).toBeNull();
    expect(await resolver().resolveDist(ctx, byVersion('PB', 'acme/x'))).not.toBeNull();
    await exec("UPDATE project SET status = 'archived' WHERE id = 'PB'");
    expect(await resolver().resolveDist(ctx, byVersion('PB', 'acme/x'))).toBeNull();
  });
});

describe('resolveDist winner and identity (AC2)', () => {
  it('two projects get their own winners; a stale expect after a precedence change is absent', async () => {
    await source('S1', 'vcs');
    await source('S2', 'vcs');
    for (const p of ['PA', 'PB']) {
      await attach(p, 'S1', p === 'PA' ? 1 : 2);
      await attach(p, 'S2', p === 'PA' ? 2 : 1);
    }
    await pkg('K1', 'S1', 'acme/x');
    await pkg('K2', 'S2', 'acme/x');
    for (const p of ['PA', 'PB']) {
      await admit(p, 'K1');
      await admit(p, 'K2');
    }
    await version('V1', 'K1', { blobId: null, metadata: COMPOSER_META });
    await version('V2', 'K2');
    const a = await resolver().resolveDist(ctx, byVersion('PA', 'acme/x'));
    const b = await resolver().resolveDist(ctx, byVersion('PB', 'acme/x'));
    expect(a).toMatchObject({ versionId: 'V1', sourceId: 'S1' });
    expect(b).toMatchObject({ versionId: 'V2', sourceId: 'S2' });

    const stale = { versionId: 'V1', revision: 1 };
    expect(
      await resolver().resolveDist(ctx, byVersion('PA', 'acme/x', { expect: stale })),
    ).not.toBeNull();
    await exec(
      "UPDATE project_source SET precedence = 9 WHERE project_id = 'PA' AND source_id = 'S1'",
    );
    expect(
      await resolver().resolveDist(ctx, byVersion('PA', 'acme/x', { expect: stale })),
    ).toBeNull();
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'V1', 1))).toBeNull();
    expect(await resolver().resolveDist(ctx, byVersion('PA', 'acme/x'))).toMatchObject({
      versionId: 'V2',
    });
  });

  it('a Composer dist revision makes the old expect absent; by id serves the historical live blob', async () => {
    await source('S1', 'vcs');
    await attach('PA', 'S1');
    await pkg('K1', 'S1', 'acme/x');
    await admit('PA', 'K1');
    await blob('B-OLD', SHA_B);
    await blob('B-GONE', SHA_C, true);
    const oldMeta = JSON.stringify({
      dist: { shasum: '', type: 'zip', url: 'https://up.test/old.zip' },
    });
    await version('V1', 'K1', {
      revision: 3,
      blobId: null,
      metadata: COMPOSER_META,
      distType: 'zip',
      composerShasum: 'abcdef0123456789abcdef0123456789abcdef01',
      sourceRef: 'cafe',
    });
    await revisionRow('V1', 1, { blobId: 'B-GONE', metadata: oldMeta, sourceRef: 'old1' });
    await revisionRow('V1', 2, { blobId: 'B-OLD', metadata: oldMeta, sourceRef: 'old2' });

    expect(
      await resolver().resolveDist(
        ctx,
        byVersion('PA', 'acme/x', { expect: { versionId: 'V1', revision: 2 } }),
      ),
    ).toBeNull();
    expect(
      await resolver().resolveDist(
        ctx,
        byVersion('PA', 'acme/x', { expect: { versionId: 'other', revision: 3 } }),
      ),
    ).toBeNull();

    const current = await resolver().resolveDist(
      ctx,
      byVersion('PA', 'acme/x', { expect: { versionId: 'V1', revision: 3 } }),
    );
    expect(current).toEqual({
      versionId: 'V1',
      revision: 3,
      current: true,
      packageId: 'K1',
      sourceId: 'S1',
      status: 'active',
      blob: null,
      fetch: {
        sourceRef: 'cafe',
        upstreamDistUrl: 'https://up.test/acme-x-1.zip',
        distType: 'zip',
        composerShasum: 'abcdef0123456789abcdef0123456789abcdef01',
        npmIntegrity: null,
        npmShasum: null,
      },
    });
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'V1', 3))).toEqual(current);

    const historical = await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'V1', 2));
    expect(historical).toEqual({
      versionId: 'V1',
      revision: 2,
      current: false,
      packageId: 'K1',
      sourceId: 'S1',
      status: 'active',
      blob: {
        id: 'B-OLD',
        sha256: SHA_B,
        sizeBytes: 42,
        mediaType: 'application/zip',
        refetchable: true,
      },
      fetch: {
        sourceRef: 'old2',
        upstreamDistUrl: 'https://up.test/old.zip',
        distType: 'zip',
        composerShasum: null,
        npmIntegrity: null,
        npmShasum: null,
      },
    });
    const lost = await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'V1', 1));
    expect(lost).toMatchObject({ revision: 1, current: false, blob: null });
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'V1', 4))).toBeNull();
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/other', 'V1', 3))).toBeNull();
  });

  it('a non-winner version, a wrong version and unavailable statuses are absent', async () => {
    await source('S1', 'vcs', { policy: 'exclude' });
    await source('SP', 'packagist_proxy');
    await attach('PA', 'S1');
    await attach('PA', 'SP');
    await pkg('K1', 'S1', 'acme/x');
    await pkg('KP', 'SP', 'acme/x');
    await admit('PA', 'K1');
    await admit('PA', 'KP');
    await version('VP', 'KP', { normalized: '2.0.0.0' });
    expect(
      await resolver().resolveDist(
        ctx,
        byVersion('PA', 'acme/x', { versionNormalized: '2.0.0.0' }),
      ),
    ).toBeNull();
    expect(await resolver().resolveDist(ctx, byId('PA', 'acme/x', 'VP', 1))).toBeNull();
    expect(
      await resolver().resolveDist(
        ctx,
        byVersion('PA', 'acme/x', { versionNormalized: '9.0.0.0' }),
      ),
    ).toBeNull();
    for (const [id, status] of [
      ['VQ', 'quarantined'],
      ['VT', 'tombstoned'],
      ['VY', 'yanked'],
      ['VR', 'removed_upstream'],
    ] as const) {
      await version(id, 'K1', { normalized: `${id}.0`, status });
      expect(
        await resolver().resolveDist(
          ctx,
          byVersion('PA', 'acme/x', { versionNormalized: `${id}.0` }),
        ),
        id,
      ).toBeNull();
      await revisionRow(id, 1);
      await exec('UPDATE version SET revision = 2 WHERE id = ?', [id]);
      expect(await resolver().resolveDist(ctx, byId('PA', 'acme/x', id, 1)), id).toBeNull();
    }
    await exec("UPDATE source SET removal_policy = 'flag' WHERE id = 'S1'");
    expect(
      await resolver().resolveDist(ctx, byVersion('PA', 'acme/x', { versionNormalized: 'VR.0' })),
    ).toMatchObject({ versionId: 'VR', status: 'removed_upstream' });
  });

  it('a deleted current blob is not returned and no credential column is read', async () => {
    await source('S1', 'vcs');
    await attach('PA', 'S1');
    await pkg('K1', 'S1', 'acme/x');
    await admit('PA', 'K1');
    await blob('B1', SHA_A, true);
    await version('V1', 'K1', { blobId: 'B1' });
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
    const result = await createDistResolver(capturing).resolveDist(ctx, byVersion('PA', 'acme/x'));
    expect(result).toMatchObject({ versionId: 'V1', blob: null });
    expect(JSON.stringify(result)).not.toContain('u:p@');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).not.toMatch(/storage_key|upstream_url|credential/);
    for (const query of [
      byVersion('PA', 'acme/x', { expect: { versionId: 'V1', revision: 1 } }),
      byId('PA', 'acme/x', 'V1', 1),
    ]) {
      captured.length = 0;
      await createDistResolver(capturing).resolveDist(ctx, query);
      const statement = captured[0] as ScalarStatement;
      const plan = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      const details = plan.map((row) => row.detail);
      expect(
        details.filter((d) => /^SCAN (v|r|b|pkg|q|version|package|blob)\b/.test(d)),
        details.join('\n'),
      ).toEqual([]);
    }
  });
});

describe('resolveDist npm (AC3)', () => {
  it('a legacy npm version with only shasum returns it; one executor.all per call', async () => {
    await source('SN', 'npm_registry', { ecosystem: 'npm' });
    await attach('PA', 'SN');
    await pkg('KN', 'SN', 'left-pad', { ecosystem: 'npm' });
    await admit('PA', 'KN');
    await version('VN', 'KN', {
      normalized: '1.0.0',
      distType: 'tgz',
      metadata: JSON.stringify({
        dist: {
          shasum: 'abcdef0123456789abcdef0123456789abcdef01',
          tarball: 'https://registry.test/left-pad-1.0.0.tgz',
        },
      }),
    });
    const counted = countCalls(database.executor);
    const result = await createDistResolver(counted.executor).resolveDist(
      ctx,
      byVersion('PA', 'left-pad', { versionNormalized: '1.0.0' }, 'npm'),
    );
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    expect(result?.fetch).toEqual({
      sourceRef: null,
      upstreamDistUrl: 'https://registry.test/left-pad-1.0.0.tgz',
      distType: 'tgz',
      composerShasum: null,
      npmIntegrity: null,
      npmShasum: 'abcdef0123456789abcdef0123456789abcdef01',
    });
  });

  it('rejects malformed queries without touching the database', async () => {
    const counted = countCalls(database.executor);
    const r = createDistResolver(counted.executor);
    const bad = [
      { ...byVersion('PA', 'a/b'), by: 'sha256' },
      { ...byVersion('PA', 'a/b'), versionNormalized: '' },
      byVersion('PA', 'a/b', { expect: { versionId: 'v', revision: 0 } }),
      { ...byId('PA', 'a/b', 'v', 1), revision: 1.5 },
      { ...byId('PA', 'a/b', '', 1) },
    ] as unknown as ResolveDistQuery[];
    for (const query of bad) await expect(r.resolveDist(ctx, query)).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('resolveDist against the oracle', () => {
  it('returns exactly the winner versions that are available on 40 random configurations', async () => {
    let hits = 0;
    let n = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const config = randomCatalogueConfig(seed, 5);
      const db = await openMigratedDatabase();
      try {
        await seedCatalogue(db.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(db.executor, config);
        const inputs = toVisibilityInputs(config);
        const r = createDistResolver(db.executor);
        for (const project of config.projects) {
          const pctx = orgContext(project.orgId);
          for (const v of config.versions) {
            const p = config.packages.find((k) => k.id === v.packageId);
            if (p === undefined) continue;
            const winner = resolveWinner(inputs, project.id, p.ecosystem, p.key);
            const policy = config.sources.find((s) => s.id === winner?.sourceId)?.removalPolicy;
            const byVersionMode = n % 2 === 1;
            n += 1;
            const expected = config.versions.find(
              (c) =>
                c.packageId === winner?.packageId &&
                (byVersionMode ? c.normalized === v.normalized : c.id === v.id) &&
                (c.status === 'active' || (c.status === 'removed_upstream' && policy === 'flag')),
            );
            const result = await r.resolveDist(pctx, {
              projectId: project.id,
              ecosystem: p.ecosystem,
              key: p.key,
              ...(byVersionMode
                ? { by: 'version' as const, versionNormalized: v.normalized }
                : { by: 'id' as const, versionId: v.id, revision: 1 }),
            });
            expect(result?.versionId ?? null, `${seed} ${project.id} ${v.id}`).toBe(
              expected?.id ?? null,
            );
            if (expected !== undefined)
              expect(result).toMatchObject({
                packageId: winner?.packageId,
                sourceId: winner?.sourceId,
                current: true,
              });
            const available = expected !== undefined;
            if (available) hits += 1;
          }
        }
      } finally {
        await db.close();
      }
    }
    expect(hits).toBeGreaterThan(50);
  }, 120_000);
});
