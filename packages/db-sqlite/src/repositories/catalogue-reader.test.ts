import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { CatalogueReader } from '@package-broker/core/db/catalogue';
import type { OrgContext } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReader } from './catalogue.js';

let database: MigratedDatabase;
let ctx: OrgContext;

const T0 = '2020-01-01T00:00:00.000Z';

async function exec(sql: string, params: (string | number | null)[] = []): Promise<void> {
  await database.executor.batch([{ sql, params }]);
}

async function seed(): Promise<void> {
  await exec('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    'P1',
    ctx.orgId,
    'p1',
    'P1',
  ]);
  await exec(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ['S1', ctx.orgId, 'S1', 'npm', 'npm_registry', 'flag'],
  );
  await exec(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [ctx.orgId, 'P1', 'S1', 100],
  );
  await exec(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    ['K1', ctx.orgId, 'S1', 'npm', 'left-pad'],
  );
  await exec(
    'INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
    [ctx.orgId, 'P1', 'K1', 'subscription'],
  );
  await exec(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json)
     VALUES ('V1', ?, 'K1', '1.0.0', '1.0.0', ?, 'import_time', '{}')`,
    [ctx.orgId, T0],
  );
  await exec('INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)', [
    ctx.orgId,
    'K1',
    'latest',
    'V1',
  ]);
}

const scope = { projectId: 'P1', ecosystem: 'npm' } as const;
const ref = { ...scope, key: 'left-pad' } as const;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('orgs missing');
  ctx = database.orgs.a;
  await seed();
});

afterEach(async () => {
  await database.close();
});

describe('createCatalogueReader', () => {
  it('1: the result satisfies CatalogueReader', () => {
    const reader = createCatalogueReader(database.executor);
    expectTypeOf(reader).toExtend<CatalogueReader>();
    expectTypeOf(createCatalogueReader).returns.toEqualTypeOf<CatalogueReader>();
    expect(Object.keys(reader).sort()).toEqual(
      [
        'admitProxy',
        'classify',
        'classifyWinners',
        'distTags',
        'listVisible',
        'lookupTag',
        'lookupVersion',
        'pageEdges',
        'previewWinners',
        'resolveDist',
        'resolveVersions',
        'search',
      ].sort(),
    );
  });

  it('2: each method is one executor call and returns the delegated data', async () => {
    const counted = countCalls(database.executor);
    const reader = createCatalogueReader(counted.executor);
    const total = () => counted.counts().all + counted.counts().batch;
    const calls: Record<keyof CatalogueReader, () => Promise<unknown>> = {
      resolveVersions: () => reader.resolveVersions(ctx, { ...ref, limit: 10 }),
      lookupVersion: () => reader.lookupVersion(ctx, { ...ref, versionNormalized: '1.0.0' }),
      lookupTag: () => reader.lookupTag(ctx, { ...ref, tag: 'latest' }),
      distTags: () => reader.distTags(ctx, ref),
      listVisible: () => reader.listVisible(ctx, { ...scope, limit: 10 }),
      search: () => reader.search(ctx, { ...scope, text: 'left', limit: 10 }),
      resolveDist: () =>
        reader.resolveDist(ctx, { ...ref, by: 'version', versionNormalized: '1.0.0' }),
      admitProxy: () => reader.admitProxy(ctx, ref),
      pageEdges: () => reader.pageEdges(ctx, { ...scope, limit: 10 }),
      classify: () => reader.classify(ctx, { ...scope, keys: ['left-pad', 'absent'] }),
      classifyWinners: () => reader.classifyWinners(ctx, { ...scope, keys: ['left-pad'] }),
      previewWinners: () => reader.previewWinners(ctx, ref),
    };
    for (const [name, call] of Object.entries(calls)) {
      const before = total();
      await call();
      expect(total() - before, name).toBe(1);
    }

    const resolution = await reader.resolveVersions(ctx, { ...ref, limit: 10 });
    expect(resolution !== null && 'versions' in resolution && resolution.versions).toHaveLength(1);
    expect(await reader.lookupVersion(ctx, { ...ref, versionNormalized: '1.0.0' })).toMatchObject({
      pkg: { packageId: 'K1', sourceId: 'S1', key: 'left-pad' },
      version: { versionId: 'V1', version: '1.0.0' },
    });
    expect(await reader.lookupTag(ctx, { ...ref, tag: 'latest' })).toMatchObject({
      pkg: { packageId: 'K1', sourceId: 'S1', key: 'left-pad' },
      version: { versionId: 'V1', version: '1.0.0' },
    });
    expect(await reader.distTags(ctx, ref)).toMatchObject({
      pkg: { packageId: 'K1', sourceId: 'S1', key: 'left-pad' },
      tags: { latest: '1.0.0' },
    });
    expect(
      (await reader.listVisible(ctx, { ...scope, limit: 10 })).items.map((i) => i.key),
    ).toEqual(['left-pad']);
    expect(await reader.search(ctx, { ...scope, text: 'left', limit: 10 })).toEqual([
      { key: 'left-pad', packageId: 'K1', sourceId: 'S1', description: null },
    ]);
    expect(
      await reader.resolveDist(ctx, { ...ref, by: 'version', versionNormalized: '1.0.0' }),
    ).toMatchObject({ versionId: 'V1', packageId: 'K1', sourceId: 'S1', current: true });
    expect(await reader.admitProxy(ctx, ref)).toEqual([]);
    expect(await reader.pageEdges(ctx, { ...scope, limit: 10 })).toEqual({
      rows: [{ requirerKey: 'left-pad', versionId: 'V1', version: '1.0.0', deps: null }],
      next: null,
    });
    expect(await reader.classify(ctx, { ...scope, keys: ['left-pad', 'absent'] })).toEqual([
      { key: 'left-pad', class: 'attachable' },
      { key: 'absent', class: 'not_available' },
    ]);
    expect(await reader.classifyWinners(ctx, { ...scope, keys: ['left-pad'] })).toEqual([
      { key: 'left-pad', winner: { sourceId: 'S1', sourceType: 'npm_registry' } },
    ]);
    expect(await reader.previewWinners(ctx, ref)).toEqual([
      {
        sourceId: 'S1',
        sourceType: 'npm_registry',
        projectLevel: false,
        precedence: 100,
        packageId: 'K1',
        eligible: true,
      },
    ]);
  });

  it('rejects an out-of-range limit or key list before touching the database', async () => {
    const counted = countCalls(database.executor);
    const reader = createCatalogueReader(counted.executor);
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
    const bad: Promise<unknown>[] = [
      reader.resolveVersions(ctx, { ...ref, limit: 201 }),
      reader.listVisible(ctx, { ...scope, limit: 0 }),
      reader.search(ctx, { ...scope, text: 'x', limit: 51 }),
      reader.pageEdges(ctx, { ...scope, limit: 201 }),
      reader.classify(ctx, { ...scope, keys: keys(1001) }),
      reader.classifyWinners(ctx, { ...scope, keys: keys(201) }),
    ];
    for (const result of await Promise.allSettled(bad)) {
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(TypeError) });
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('accepts the maximum limit or key-list size for each limited method', async () => {
    const reader = createCatalogueReader(database.executor);
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
    await expect(reader.resolveVersions(ctx, { ...ref, limit: 200 })).resolves.toMatchObject({
      versions: [{ versionId: 'V1' }],
    });
    await expect(reader.listVisible(ctx, { ...scope, limit: 200 })).resolves.toMatchObject({
      items: [{ key: 'left-pad' }],
    });
    await expect(reader.search(ctx, { ...scope, text: 'left', limit: 50 })).resolves.toMatchObject([
      { key: 'left-pad' },
    ]);
    await expect(reader.pageEdges(ctx, { ...scope, limit: 200 })).resolves.toMatchObject({
      rows: [{ versionId: 'V1' }],
    });
    await expect(reader.classify(ctx, { ...scope, keys: keys(1000) })).resolves.toEqual(
      keys(1000).map((key) => ({ key, class: 'not_available' })),
    );
    await expect(reader.classifyWinners(ctx, { ...scope, keys: keys(200) })).resolves.toEqual(
      keys(200).map((key) => ({ key, winner: null })),
    );
  });

  it('shows nothing of another organization', async () => {
    if (database.orgs === null) throw new Error('orgs missing');
    const reader = createCatalogueReader(database.executor);
    const foreign = database.orgs.b;
    expect(await reader.resolveVersions(foreign, { ...ref, limit: 10 })).toBeNull();
    expect(await reader.lookupVersion(foreign, { ...ref, versionNormalized: '1.0.0' })).toBeNull();
    expect(await reader.lookupTag(foreign, { ...ref, tag: 'latest' })).toBeNull();
    expect(await reader.distTags(foreign, ref)).toBeNull();
    expect(await reader.listVisible(foreign, { ...scope, limit: 10 })).toEqual({
      items: [],
      next: null,
      openNamespace: false,
    });
    expect(await reader.search(foreign, { ...scope, text: 'left', limit: 10 })).toEqual([]);
    expect(
      await reader.resolveDist(foreign, { ...ref, by: 'version', versionNormalized: '1.0.0' }),
    ).toBeNull();
    expect(await reader.admitProxy(foreign, ref)).toEqual([]);
    expect(await reader.pageEdges(foreign, { ...scope, limit: 10 })).toEqual({
      rows: [],
      next: null,
    });
    expect(await reader.classify(foreign, { ...scope, keys: ['left-pad', 'absent'] })).toEqual([
      { key: 'left-pad', class: 'not_available' },
      { key: 'absent', class: 'not_available' },
    ]);
    expect(await reader.classifyWinners(foreign, { ...scope, keys: ['left-pad'] })).toEqual([
      { key: 'left-pad', winner: null },
    ]);
    expect(await reader.previewWinners(foreign, ref)).toEqual([]);
  });
});
