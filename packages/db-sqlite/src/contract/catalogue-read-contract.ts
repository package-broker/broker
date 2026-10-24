import { describe, expect, it } from 'vitest';
import type { CatalogueReader, EdgeRow } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { forgedItFor, withForeignKeysOff } from '../testing/foreign-keys-off.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedCatalogueDatabase {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedCatalogueDatabase>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
type Case = (open: Open, wrap?: Wrap) => Promise<void>;
type Param = string | number | null;

const T = (n: number) => `2020-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
const DIGEST_B = 'b'.repeat(64);
const DIGEST_X = 'c'.repeat(64);
const DIGEST_A = 'a'.repeat(64);
const DESCRIPTION_B = 'private-description-of-project-b';

const VISIBLE_A = [
  'm01-shared-lib',
  'm03-pkg-spa',
  'm05-dup',
  'm07-flag-removed',
  'm09-only-a',
  'm11-proxy-only',
] as const;
const FORGED_INTO_A = ['m00-eco-forged', 'm02-secret-b', 'm06-foreign', 'm99-secret-last'] as const;
const EXCLUDED_A = 'm04-excl-removed';
const ABSENT_KEY = 'nope-nothing';
const UNPARSEABLE_KEY = 'Not/A Valid..Name\u0000!';
const PRIVATE_MARKERS = [
  'm02-secret-b',
  'm99-secret-last',
  'K-m02',
  'K-m99',
  'V-m02',
  'V-m99',
  'S-PB',
  DIGEST_B,
  DESCRIPTION_B,
  'dep-of-b',
] as const;
const VISIBLE_EDGES_A = [
  ['m01-shared-lib', 'V-m01-100'],
  ['m01-shared-lib', 'V-m01-150'],
  ['m01-shared-lib', 'V-m01-400'],
  ['m03-pkg-spa', 'V-m03-100'],
  ['m05-dup', 'V-m05-100'],
  ['m07-flag-removed', 'V-m07-100'],
  ['m09-only-a', 'V-m09-100'],
  ['m11-proxy-only', 'V-m11-100'],
] as const;

interface World {
  readonly executor: SqlExecutor;
  readonly reader: CatalogueReader;
  readonly a: OrgContext;
  readonly b: OrgContext;
  close(): Promise<void>;
}

const st = (sql: string, ...params: Param[]): Statement => ({ sql, params });

function sourceRow(
  org: string,
  id: string,
  type: string,
  options: { project?: string; ecosystem?: string; policy?: string } = {},
): Statement {
  return st(
    `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    org,
    options.project ?? null,
    id,
    options.ecosystem ?? 'npm',
    type,
    options.policy ?? 'flag',
  );
}

function attach(org: string, project: string, source: string, precedence = 100): Statement {
  return st(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    org,
    project,
    source,
    precedence,
  );
}

function link(org: string, project: string, packageId: string): Statement {
  return st(
    "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, 'subscription' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
    org,
    project,
    packageId,
  );
}

function packageRow(
  org: string,
  id: string,
  source: string,
  name: string,
  options: { status?: string; description?: string; ecosystem?: string } = {},
): Statement {
  return st(
    `INSERT INTO package (id, org_id, source_id, ecosystem, name, status, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    org,
    source,
    options.ecosystem ?? 'npm',
    name,
    options.status ?? 'active',
    options.description ?? null,
  );
}

function versionRow(
  org: string,
  id: string,
  packageId: string,
  version: string,
  day: number,
  options: { status?: string; blob?: string; revision?: number; meta?: string } = {},
): Statement {
  const status = options.status ?? 'active';
  return st(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
       published_at_basis, metadata_json, status, blob_id, revision, removed_upstream_at, tombstoned_at)
     VALUES (?, ?, ?, ?, ?, ?, 'import_time', ?, ?, ?, ?, ?, ?)`,
    id,
    org,
    packageId,
    version,
    version,
    T(day),
    options.meta ?? '{}',
    status,
    options.blob ?? null,
    options.revision ?? 1,
    status === 'removed_upstream' ? T(day) : null,
    status === 'tombstoned' ? T(day) : null,
  );
}

function blobRow(org: string, id: string, digest: string): Statement {
  return st(
    "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 10, 'k-' || ?)",
    id,
    org,
    digest,
    id,
  );
}

function tagRow(org: string, packageId: string, tag: string, versionId: string): Statement {
  return st(
    'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)',
    org,
    packageId,
    tag,
    versionId,
  );
}

async function write(executor: SqlExecutor, statements: readonly Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 50) {
    const batch = statements.slice(i, i + 50);
    const results = await executor.batch(batch);
    for (const [index, statement] of batch.entries()) {
      if (/^INSERT INTO project_package \(/i.test(statement.sql))
        expect(results[index]?.changes).toBe(1);
    }
  }
}

async function writeForged(executor: SqlExecutor, statements: readonly Statement[]): Promise<void> {
  await withForeignKeysOff(executor, () => write(executor, statements));
}

function seedStatements(a: string, b: string): Statement[] {
  const meta = (deps: string) =>
    `{"dependencies":{"${deps}":"^1"},"dist":{"tarball":"https://u.test/x.tgz"}}`;
  return [
    st("INSERT INTO project (id, org_id, slug, name) VALUES ('PA', ?, 'pa', 'PA')", a),
    st("INSERT INTO project (id, org_id, slug, name) VALUES ('PB', ?, 'pb', 'PB')", a),
    st("INSERT INTO project (id, org_id, slug, name) VALUES ('PO', ?, 'po', 'PO')", b),
    sourceRow(a, 'S-O', 'npm_registry'),
    sourceRow(a, 'S-X', 'npm_registry', { policy: 'exclude' }),
    sourceRow(a, 'S-PB', 'npm_registry', { project: 'PB' }),
    sourceRow(a, 'S-PA', 'npm_registry', { project: 'PA' }),
    sourceRow(a, 'S-XP', 'npmjs_proxy'),
    sourceRow(a, 'S-COMP', 'composer_repository', { ecosystem: 'composer' }),
    sourceRow(b, 'S-B', 'npm_registry'),
    attach(a, 'PA', 'S-O'),
    attach(a, 'PB', 'S-O'),
    attach(a, 'PA', 'S-X'),
    attach(a, 'PB', 'S-PB'),
    attach(a, 'PA', 'S-PA'),
    attach(a, 'PA', 'S-XP'),
    attach(a, 'PA', 'S-COMP'),
    attach(b, 'PO', 'S-B'),
    blobRow(a, 'B-A', DIGEST_A),
    blobRow(a, 'B-B', DIGEST_B),
    blobRow(a, 'B-X', DIGEST_X),

    packageRow(a, 'K-m01', 'S-O', 'm01-shared-lib', { description: 'shared library' }),
    versionRow(a, 'V-m01-090', 'K-m01', '0.9.0', 1, { status: 'yanked' }),
    versionRow(a, 'V-m01-100', 'K-m01', '1.0.0', 2, { blob: 'B-A', revision: 2 }),
    versionRow(a, 'V-m01-150', 'K-m01', '1.5.0', 3, { status: 'removed_upstream' }),
    versionRow(a, 'V-m01-200', 'K-m01', '2.0.0', 4, { status: 'quarantined' }),
    versionRow(a, 'V-m01-300', 'K-m01', '3.0.0', 5, { status: 'tombstoned' }),
    versionRow(a, 'V-m01-400', 'K-m01', '4.0.0', 6),
    st(
      `INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason)
       VALUES ('R-m01-100', ?, 'V-m01-100', 1, '{}', 'sync')`,
      a,
    ),
    tagRow(a, 'K-m01', 'latest', 'V-m01-100'),
    tagRow(a, 'K-m01', 'held', 'V-m01-200'),
    tagRow(a, 'K-m01', 'gone', 'V-m01-300'),
    link(a, 'PA', 'K-m01'),
    link(a, 'PB', 'K-m01'),

    packageRow(a, 'K-m03', 'S-PA', 'm03-pkg-spa'),
    versionRow(a, 'V-m03-100', 'K-m03', '1.0.0', 2),
    tagRow(a, 'K-m03', 'latest', 'V-m03-100'),
    link(a, 'PA', 'K-m03'),

    packageRow(a, 'K-m05', 'S-O', 'm05-dup'),
    versionRow(a, 'V-m05-100', 'K-m05', '1.0.0', 2),
    tagRow(a, 'K-m05', 'latest', 'V-m05-100'),
    link(a, 'PA', 'K-m05'),
    link(a, 'PB', 'K-m05'),
    packageRow(a, 'K-m05-px', 'S-XP', 'm05-dup'),
    versionRow(a, 'V-m05-px', 'K-m05-px', '9.9.9', 2, { blob: 'B-X' }),
    versionRow(a, 'V-m05-px100', 'K-m05-px', '1.0.0', 3),
    tagRow(a, 'K-m05-px', 'latest', 'V-m05-px'),
    link(a, 'PA', 'K-m05-px'),

    packageRow(a, 'K-m07', 'S-O', 'm07-flag-removed', { status: 'removed_upstream' }),
    versionRow(a, 'V-m07-100', 'K-m07', '1.0.0', 2),
    link(a, 'PA', 'K-m07'),

    packageRow(a, 'K-m09', 'S-O', 'm09-only-a'),
    versionRow(a, 'V-m09-100', 'K-m09', '1.0.0', 2),
    link(a, 'PA', 'K-m09'),

    packageRow(a, 'K-m11', 'S-XP', 'm11-proxy-only'),
    versionRow(a, 'V-m11-100', 'K-m11', '1.0.0', 2),
    link(a, 'PA', 'K-m11'),

    packageRow(a, 'K-m04', 'S-X', EXCLUDED_A, { status: 'removed_upstream' }),
    versionRow(a, 'V-m04-100', 'K-m04', '1.0.0', 2),
    link(a, 'PA', 'K-m04'),

    packageRow(a, 'K-m02', 'S-PB', 'm02-secret-b', { description: DESCRIPTION_B }),
    versionRow(a, 'V-m02-100', 'K-m02', '1.0.0', 2, { blob: 'B-B', meta: meta('dep-of-b') }),
    tagRow(a, 'K-m02', 'latest', 'V-m02-100'),
    link(a, 'PB', 'K-m02'),
    packageRow(a, 'K-m99', 'S-PB', 'm99-secret-last', { description: DESCRIPTION_B }),
    versionRow(a, 'V-m99-100', 'K-m99', '1.0.0', 2, { blob: 'B-B', meta: meta('dep-of-b') }),
    link(a, 'PB', 'K-m99'),

    packageRow(b, 'K-m06', 'S-B', 'm06-foreign'),
    versionRow(b, 'V-m06-100', 'K-m06', '1.0.0', 2),
    link(b, 'PO', 'K-m06'),
  ];
}

function forgeStatements(a: string): { rows: Statement[]; sources: Statement[] } {
  return {
    rows: [link(a, 'PA', 'K-m02'), link(a, 'PA', 'K-m99'), link(a, 'PA', 'K-m06')],
    sources: [attach(a, 'PA', 'S-PB'), attach(a, 'PA', 'S-B')],
  };
}

async function openWorld(open: Open, wrap: Wrap = (e) => e): Promise<World> {
  const opened = await open();
  try {
    const orgs = await seedTwoOrganizations(opened.executor);
    await write(opened.executor, seedStatements(orgs.a.orgId, orgs.b.orgId));
    const world: World = {
      executor: opened.executor,
      reader: createCatalogueReader(wrap(opened.executor)),
      a: orgs.a,
      b: orgs.b,
      close: () => opened.close(),
    };
    await assertControls(world);
    return world;
  } catch (error) {
    await opened.close();
    throw error;
  }
}

const scope = (projectId: string) => ({ projectId, ecosystem: 'npm' }) as const;
const ref = (projectId: string, key: string) => ({ ...scope(projectId), key }) as const;

async function surface(world: World, ctx: OrgContext, projectId: string, key: string) {
  const r = world.reader;
  const q = ref(projectId, key);
  return {
    versions: await r.resolveVersions(ctx, { ...q, limit: 200 }),
    changed: await r.resolveVersions(ctx, {
      ...q,
      limit: 10,
      binding: { packageId: 'K-ghost', sourceId: 'S-ghost', rev: 1 },
    }),
    version: await r.lookupVersion(ctx, { ...q, versionNormalized: '1.0.0' }),
    tag: await r.lookupTag(ctx, { ...q, tag: 'latest' }),
    tags: await r.distTags(ctx, q),
    dist: await r.resolveDist(ctx, { ...q, by: 'version', versionNormalized: '1.0.0' }),
  };
}

async function collections(world: World, ctx: OrgContext, projectId: string) {
  const r = world.reader;
  const listing: { keys: string[]; nexts: (string | null)[]; open: boolean } = {
    keys: [],
    nexts: [],
    open: false,
  };
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await r.listVisible(ctx, {
      ...scope(projectId),
      limit: 1,
      ...(after === undefined ? {} : { after }),
    });
    listing.open = page.openNamespace;
    listing.keys.push(...page.items.map((item) => item.key));
    listing.nexts.push(page.next);
    if (page.next === null) break;
    after = page.next;
  }
  const full = await r.listVisible(ctx, { ...scope(projectId), limit: 200 });
  const edges: EdgeRow[] = [];
  const cursors: unknown[] = [];
  let cursor: { requirerKey: string; versionId: string } | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await r.pageEdges(ctx, {
      ...scope(projectId),
      limit: 2,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    edges.push(...page.rows);
    cursors.push(page.next);
    if (page.next === null) break;
    cursor = page.next;
  }
  const previews = [];
  for (const key of new Set([...full.items.map((item) => item.key), ...FORGED_INTO_A])) {
    previews.push(await r.previewWinners(ctx, ref(projectId, key)));
  }
  return {
    listing,
    full,
    edges,
    cursors,
    previews,
    search: await r.search(ctx, { ...scope(projectId), text: 'm', limit: 50 }),
    secretSearch: await r.search(ctx, { ...scope(projectId), text: 'secret', limit: 50 }),
    deps: await r.search(ctx, { ...scope(projectId), text: 'dep-of', limit: 50 }),
    descriptionSearch: await r.search(ctx, {
      ...scope(projectId),
      text: DESCRIPTION_B,
      limit: 50,
    }),
  };
}

const json = (value: unknown) => JSON.stringify(value);

function expectNoMarkers(value: unknown, markers: readonly string[] = PRIVATE_MARKERS): void {
  const text = json(value);
  for (const marker of markers) expect(text, marker).not.toContain(marker);
}

function expectAbsent(shape: Awaited<ReturnType<typeof surface>>): void {
  expect(shape.versions).toBeNull();
  expect(shape.changed).toEqual({ changed: true });
  expect(shape.version).toBeNull();
  expect(shape.tag).toBeNull();
  expect(shape.tags).toBeNull();
  expect(shape.dist).toBeNull();
}

async function expectUniformlyAbsent(
  world: World,
  ctx: OrgContext,
  projectId: string,
  key: string,
): Promise<void> {
  const hidden = await surface(world, ctx, projectId, key);
  expectAbsent(hidden);
  expect(json(hidden)).toBe(json(await surface(world, ctx, projectId, ABSENT_KEY)));
}

async function expectVisible(world: World, projectId: string, key: string): Promise<void> {
  const shape = await surface(world, world.a, projectId, key);
  expect(shape.versions, `${projectId}/${key}`).not.toBeNull();
  expect(shape.tags, `${projectId}/${key}`).not.toBeNull();
}

async function assertControls(world: World): Promise<void> {
  for (const key of VISIBLE_A) await expectVisible(world, 'PA', key);
  await expectVisible(world, 'PB', 'm01-shared-lib');
  await expectVisible(world, 'PB', 'm02-secret-b');
  await expectVisible(world, 'PB', 'm99-secret-last');
  const own = await world.reader.resolveVersions(world.b, {
    ...ref('PO', 'm06-foreign'),
    limit: 10,
  });
  expect(own, 'PO/m06-foreign').toMatchObject({ pkg: { packageId: 'K-m06' } });
  const listed = await world.reader.listVisible(world.a, { ...scope('PA'), limit: 200 });
  expect(listed.items.map((item) => item.key)).toEqual([...VISIBLE_A]);
  expect(await world.reader.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual(['S-XP']);
}

async function withWorld(open: Open, wrap: Wrap | undefined, body: (w: World) => Promise<void>) {
  const world = await openWorld(open, wrap);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}

async function expectPrivateToB(world: World): Promise<void> {
  for (const key of ['m02-secret-b', 'm99-secret-last']) {
    await expectUniformlyAbsent(world, world.a, 'PA', key);
  }
  const all = await collections(world, world.a, 'PA');
  expect(all.listing.keys).toEqual([...VISIBLE_A]);
  expect(all.listing.nexts.slice(0, -1)).toEqual(VISIBLE_A.slice(0, -1));
  expect(all.listing.nexts.at(-1)).toBeNull();
  expect(all.full.items.map((item) => item.key)).toEqual([...VISIBLE_A]);
  expect(all.search.map((item) => item.key)).toEqual([...VISIBLE_A]);
  expect(all.secretSearch).toEqual([]);
  expect(all.deps).toEqual([]);
  expect(all.descriptionSearch).toEqual([]);
  expect(all.edges.map((e) => [e.requirerKey, e.versionId])).toEqual(
    VISIBLE_EDGES_A.map((e) => [...e]),
  );
  expect(all.cursors.at(-1)).toBeNull();
  expectNoMarkers(all);
  const ids = await world.reader.classifyWinners(world.a, {
    ...scope('PA'),
    keys: [...FORGED_INTO_A, EXCLUDED_A],
  });
  expect(ids.every((entry) => entry.winner === null)).toBe(true);
  for (const key of ['m02-secret-b', 'm99-secret-last']) {
    expect(await world.reader.previewWinners(world.a, ref('PA', key))).toEqual([]);
  }
  const byId = await world.reader.resolveDist(world.a, {
    ...ref('PA', 'm02-secret-b'),
    by: 'id',
    versionId: 'V-m02-100',
    revision: 1,
  });
  expect(byId).toBeNull();
}

const isolationBetweenProjects: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await expectPrivateToB(world);
    const secret = await world.reader.resolveDist(world.a, {
      ...ref('PB', 'm02-secret-b'),
      by: 'version',
      versionNormalized: '1.0.0',
    });
    expect(secret?.blob?.sha256).toBe(DIGEST_B);
    const pb = await collections(world, world.a, 'PB');
    expect(pb.listing.keys).toEqual([
      'm01-shared-lib',
      'm02-secret-b',
      'm05-dup',
      'm99-secret-last',
    ]);
    expect(await world.reader.admitProxy(world.a, ref('PB', 'fresh-name'))).toEqual([]);
    const onlyA = await surface(world, world.a, 'PB', 'm09-only-a');
    expectAbsent(onlyA);
    expect(pb.listing.open).toBe(false);
  });

const forgedProjectPackage: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, forgeStatements(world.a.orgId).rows);
    await expectPrivateToB(world);
  });

const forgedProjectSource: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const forged = forgeStatements(world.a.orgId);
    await writeForged(world.executor, [...forged.rows, ...forged.sources.slice(0, 1)]);
    await expectPrivateToB(world);
    const edgesForPb = await world.reader.pageEdges(world.a, { ...scope('PA'), limit: 200 });
    expect(edgesForPb.rows.map((row) => row.requirerKey)).not.toContain('m02-secret-b');
    const classes = await world.reader.classify(world.a, {
      ...scope('PA'),
      keys: ['m02-secret-b', 'm99-secret-last'],
    });
    expect(classes.map((entry) => entry.class)).toEqual(['not_available', 'not_available']);
  });

const forgedEcosystem: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await expect(
      write(world.executor, [packageRow(world.a.orgId, 'K-m00', 'S-COMP', 'm00-eco-forged')]),
    ).rejects.toThrow('package ecosystem does not match source ecosystem');
    await expectUniformlyAbsent(world, world.a, 'PA', 'm00-eco-forged');
    const listed = await world.reader.listVisible(world.a, { ...scope('PA'), limit: 200 });
    expect(listed.items.map((item) => item.key)).not.toContain('m00-eco-forged');
    expect(await world.reader.previewWinners(world.a, ref('PA', 'm00-eco-forged'))).toEqual([]);
    const edges = await world.reader.pageEdges(world.a, { ...scope('PA'), limit: 200 });
    expect(edges.rows.map((row) => row.requirerKey)).not.toContain('m00-eco-forged');
  });

const otherOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const forged = forgeStatements(world.a.orgId);
    await writeForged(world.executor, [...forged.rows, ...forged.sources]);
    await writeForged(world.executor, [
      link(world.a.orgId, 'PO', 'K-m01'),
      attach(world.a.orgId, 'PO', 'S-O'),
    ]);
    await expectUniformlyAbsent(world, world.a, 'PA', 'm06-foreign');
    await expectUniformlyAbsent(world, world.a, 'PO', 'm01-shared-lib');
    await expectUniformlyAbsent(world, world.a, 'PO', 'm06-foreign');
    for (const projectId of ['PA', 'PB']) {
      for (const key of [...VISIBLE_A, 'm02-secret-b']) {
        await expectUniformlyAbsent(world, world.b, projectId, key);
      }
    }
    const foreignAll = await collections(world, world.b, 'PA');
    expect(foreignAll.listing.keys).toEqual([]);
    expect(foreignAll.full).toEqual({ items: [], next: null, openNamespace: false });
    expect(foreignAll.edges).toEqual([]);
    expect(foreignAll.search).toEqual([]);
    const intoB = await collections(world, world.a, 'PO');
    expect(intoB.listing.keys).toEqual([]);
    expect(intoB.edges).toEqual([]);
    expect(intoB.listing.open).toBe(false);
    const own = await collections(world, world.b, 'PO');
    expect(own.listing.keys).toEqual(['m06-foreign']);
    const listedA = await collections(world, world.a, 'PA');
    expect(listedA.listing.keys).toEqual([...VISIBLE_A]);

    await writeForged(world.executor, [
      st(
        "UPDATE project_package SET org_id = ? WHERE project_id = 'PA' AND package_id = 'K-m01'",
        world.b.orgId,
      ),
      st(
        "UPDATE project_source SET org_id = ? WHERE project_id = 'PA' AND source_id = 'S-O'",
        world.b.orgId,
      ),
    ]);
    for (const ctx of [world.a, world.b]) {
      await expectUniformlyAbsent(world, ctx, 'PA', 'm01-shared-lib');
      await expectUniformlyAbsent(world, ctx, 'PA', 'm09-only-a');
    }
    const afterFlip = await collections(world, world.a, 'PA');
    expect(afterFlip.listing.keys).toEqual(['m03-pkg-spa', 'm11-proxy-only']);
    expect(await world.reader.admitProxy(world.b, ref('PA', 'fresh-name'))).toEqual([]);
    expect(await world.reader.admitProxy(world.a, ref('PO', 'fresh-name'))).toEqual([]);
    const [foreign, absent] = await world.reader.classify(world.a, {
      ...scope('PA'),
      keys: ['m06-foreign', ABSENT_KEY],
    });
    expect(foreign?.class).toBe(absent?.class);
    expect(foreign?.class).not.toBe('attachable');
    const winners = await world.reader.classifyWinners(world.b, {
      ...scope('PA'),
      keys: [...VISIBLE_A],
    });
    expect(winners.every((entry) => entry.winner === null)).toBe(true);
    expect(await world.reader.previewWinners(world.b, ref('PA', 'm01-shared-lib'))).toEqual([]);
    expect(await world.reader.previewWinners(world.a, ref('PO', 'm01-shared-lib'))).toEqual([]);
  });

const digestOnlyViaB: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, forgeStatements(world.a.orgId).rows);
    await write(world.executor, [attach(world.a.orgId, 'PA', 'S-PB')]);
    const seen: unknown[] = [await collections(world, world.a, 'PA')];
    for (const key of [...VISIBLE_A, ...FORGED_INTO_A]) {
      seen.push(await surface(world, world.a, 'PA', key));
    }
    expectNoMarkers(seen);
    const viaVersion = await world.reader.resolveDist(world.a, {
      ...ref('PB', 'm02-secret-b'),
      by: 'version',
      versionNormalized: '1.0.0',
      expect: { versionId: 'V-m02-100', revision: 1 },
    });
    expect(viaVersion).toMatchObject({ versionId: 'V-m02-100', blob: { sha256: DIGEST_B } });
    for (const query of [
      { by: 'version', versionNormalized: '1.0.0' },
      { by: 'id', versionId: 'V-m02-100', revision: 1 },
    ] as const) {
      const target = await world.reader.resolveDist(world.a, {
        ...ref('PA', 'm02-secret-b'),
        ...query,
      });
      expect(target).toBeNull();
    }
    const probe = await world.reader.resolveDist(world.a, {
      ...ref('PA', 'm01-shared-lib'),
      by: 'id',
      versionId: 'V-m02-100',
      revision: 1,
    });
    expect(probe).toBeNull();
    const own = await world.reader.resolveDist(world.a, {
      ...ref('PA', 'm01-shared-lib'),
      by: 'version',
      versionNormalized: '1.0.0',
    });
    expect(own?.blob?.sha256).toBe(DIGEST_A);
    expect(json(own)).not.toContain(DIGEST_B);
  });

const forgedPackageOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const key = 'm08-org-b-package';
    await writeForged(world.executor, [
      packageRow(world.b.orgId, 'K-org-b', 'S-O', key, { description: 'org-b-description' }),
      versionRow(world.a.orgId, 'V-org-b-package', 'K-org-b', '1.0.0', 2),
      tagRow(world.a.orgId, 'K-org-b', 'latest', 'V-org-b-package'),
      link(world.a.orgId, 'PA', 'K-org-b'),
    ]);
    await expectUniformlyAbsent(world, world.a, 'PA', key);
    const preview = await world.reader.previewWinners(world.a, ref('PA', key));
    expect(preview).toEqual([]);
    expect(
      await world.reader.resolveDist(world.a, {
        ...ref('PA', key),
        by: 'id',
        versionId: 'V-org-b-package',
        revision: 1,
      }),
    ).toBeNull();
    expect(await world.reader.classifyWinners(world.a, { ...scope('PA'), keys: [key] })).toEqual([
      { key, winner: null },
    ]);
    expect(await world.reader.admitProxy(world.a, ref('PA', key))).toEqual(['S-XP']);
    expect(await world.reader.classify(world.a, { ...scope('PA'), keys: [key] })).toEqual([
      { key, class: 'proxy_admissible' },
    ]);
    const all = await collections(world, world.a, 'PA');
    expectNoMarkers(all);
    expectNoMarkers(all, [key, 'K-org-b', 'V-org-b-package', 'org-b-description']);
  });

const forgedVersionOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, [
      versionRow(world.b.orgId, 'V-org-b-version', 'K-m01', '8.8.8', 7, {
        meta: '{"dependencies":{"org-b-dependency":"^1"}}',
      }),
      tagRow(world.a.orgId, 'K-m01', 'org-b-version-tag', 'V-org-b-version'),
    ]);
    const q = ref('PA', 'm01-shared-lib');
    const r = world.reader;
    expect(await r.lookupVersion(world.a, { ...q, versionNormalized: '8.8.8' })).toBeNull();
    expect(await r.lookupTag(world.a, { ...q, tag: 'org-b-version-tag' })).toBeNull();
    expect((await r.distTags(world.a, q))?.tags).toEqual({ latest: '1.0.0' });
    for (const selector of [
      { by: 'version', versionNormalized: '8.8.8' },
      { by: 'id', versionId: 'V-org-b-version', revision: 1 },
    ] as const) {
      expect(await r.resolveDist(world.a, { ...q, ...selector })).toBeNull();
    }
    const seen = [
      await surface(world, world.a, 'PA', q.key),
      await collections(world, world.a, 'PA'),
    ];
    expectNoMarkers(seen);
    expectNoMarkers(seen, ['V-org-b-version', '8.8.8', 'org-b-dependency', 'org-b-version-tag']);
  });

const forgedBlobOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const digest = 'd'.repeat(64);
    await write(world.executor, [
      blobRow(world.b.orgId, 'B-org-b-blob', digest),
      st("UPDATE version SET blob_id = 'B-org-b-blob' WHERE id = 'V-m01-100'"),
      st("UPDATE version_revision SET blob_id = 'B-org-b-blob' WHERE id = 'R-m01-100'"),
    ]);
    const seen: unknown[] = [];
    for (const selector of [
      { by: 'version', versionNormalized: '1.0.0' },
      { by: 'id', versionId: 'V-m01-100', revision: 2 },
      { by: 'id', versionId: 'V-m01-100', revision: 1 },
    ] as const) {
      const dist = await world.reader.resolveDist(world.a, {
        ...ref('PA', 'm01-shared-lib'),
        ...selector,
      });
      expect(dist).toMatchObject({ versionId: 'V-m01-100', blob: null });
      seen.push(dist);
    }
    seen.push(
      await surface(world, world.a, 'PA', 'm01-shared-lib'),
      await collections(world, world.a, 'PA'),
    );
    expectNoMarkers(seen);
    expectNoMarkers(seen, ['B-org-b-blob', digest]);
  });

const forgedDistTagOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, [tagRow(world.b.orgId, 'K-m01', 'org-b-tag', 'V-m01-100')]);
    const q = ref('PA', 'm01-shared-lib');
    expect(await world.reader.lookupTag(world.a, { ...q, tag: 'org-b-tag' })).toBeNull();
    expect((await world.reader.distTags(world.a, q))?.tags).toEqual({ latest: '1.0.0' });
    const seen = [
      await surface(world, world.a, 'PA', q.key),
      await collections(world, world.a, 'PA'),
    ];
    expectNoMarkers(seen);
    expectNoMarkers(seen, ['org-b-tag']);
  });

const nonWinnerAndStaleExpect: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const r = world.reader;
    const dup = ref('PA', 'm05-dup');
    const winnerVersion = await r.resolveDist(world.a, {
      ...dup,
      by: 'version',
      versionNormalized: '1.0.0',
    });
    expect(winnerVersion).toMatchObject({ versionId: 'V-m05-100', sourceId: 'S-O' });
    const loserOnly = await r.resolveDist(world.a, {
      ...dup,
      by: 'version',
      versionNormalized: '9.9.9',
    });
    expect(loserOnly).toBeNull();
    const loserById = await r.resolveDist(world.a, {
      ...dup,
      by: 'id',
      versionId: 'V-m05-px',
      revision: 1,
    });
    expect(loserById).toBeNull();
    const loserLookup = await r.lookupVersion(world.a, { ...dup, versionNormalized: '9.9.9' });
    expect(loserLookup).toBeNull();
    expect(json(await surface(world, world.a, 'PA', 'm05-dup'))).not.toContain(DIGEST_X);
    const tags = await r.distTags(world.a, dup);
    expect(tags?.tags).toEqual({ latest: '1.0.0' });

    const shared = ref('PA', 'm01-shared-lib');
    const current = { versionId: 'V-m01-100', revision: 2 };
    const fresh = await r.resolveDist(world.a, {
      ...shared,
      by: 'version',
      versionNormalized: '1.0.0',
      expect: current,
    });
    expect(fresh).toMatchObject({ versionId: 'V-m01-100', revision: 2, current: true });
    for (const stale of [
      { versionId: 'V-m01-100', revision: 1 },
      { versionId: 'V-m01-100', revision: 3 },
      { versionId: 'V-m01-400', revision: 2 },
      { versionId: 'V-m05-100', revision: 1 },
    ]) {
      const result = await r.resolveDist(world.a, {
        ...shared,
        by: 'version',
        versionNormalized: '1.0.0',
        expect: stale,
      });
      expect(result, json(stale)).toBeNull();
    }
    const history = await r.resolveDist(world.a, {
      ...shared,
      by: 'id',
      versionId: 'V-m01-100',
      revision: 1,
    });
    expect(history).toMatchObject({ versionId: 'V-m01-100', revision: 1, current: false });
    expect(
      await r.resolveDist(world.a, {
        ...shared,
        by: 'id',
        versionId: 'V-m01-100',
        revision: 3,
      }),
    ).toBeNull();
    const foreignHistory = await r.resolveDist(world.a, {
      ...ref('PB', 'm05-dup'),
      by: 'id',
      versionId: 'V-m01-100',
      revision: 1,
    });
    expect(foreignHistory).toBeNull();
  });

async function hidePrivateTwin(world: World): Promise<void> {
  const a = world.a.orgId;
  await write(world.executor, [
    packageRow(a, 'K-twin', 'S-PB', 'm11-proxy-only'),
    versionRow(a, 'V-twin', 'K-twin', '1.0.0', 2),
    link(a, 'PB', 'K-twin'),
  ]);
}

async function expectProxyRefused(world: World, key: string): Promise<void> {
  await expectUniformlyAbsent(world, world.a, 'PA', key);
  const listed = await world.reader.listVisible(world.a, { ...scope('PA'), limit: 200 });
  expect(listed.items.map((item) => item.key)).not.toContain(key);
  const search = await world.reader.search(world.a, { ...scope('PA'), text: key, limit: 50 });
  expect(search).toEqual([]);
  expect(await world.reader.admitProxy(world.a, ref('PA', key))).toEqual([]);
  const [klass] = await world.reader.classify(world.a, { ...scope('PA'), keys: [key] });
  expect(klass?.class).not.toBe('proxy_admissible');
  const [winner] = await world.reader.classifyWinners(world.a, { ...scope('PA'), keys: [key] });
  expect(winner?.winner).toBeNull();
  const edges = await world.reader.pageEdges(world.a, { ...scope('PA'), limit: 200 });
  expect(edges.rows.map((row) => row.requirerKey)).not.toContain(key);
  const candidates = await world.reader.previewWinners(world.a, ref('PA', key));
  expect(candidates.every((candidate) => !candidate.eligible)).toBe(true);
}

const proxyIneligibleAfterHide: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await hidePrivateTwin(world);
    await expectProxyRefused(world, 'm11-proxy-only');
    const hide: [string, Statement][] = [
      ['unlinked', st("DELETE FROM project_package WHERE package_id = 'K-twin'")],
      [
        'removed upstream',
        st("UPDATE package SET status = 'removed_upstream' WHERE id = 'K-twin'"),
      ],
      ['source excludes', st("UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-PB'")],
      ['source detached', st("DELETE FROM project_source WHERE source_id = 'S-PB'")],
      ['project archived', st("UPDATE project SET status = 'archived' WHERE id = 'PB'")],
      [
        'versions quarantined',
        st("UPDATE version SET status = 'quarantined' WHERE package_id = 'K-twin'"),
      ],
    ];
    for (const [label, statement] of hide) {
      await write(world.executor, [statement]);
      await expectProxyRefused(world, 'm11-proxy-only').catch((error: unknown) => {
        throw new Error(`after ${label}: ${String(error)}`);
      });
    }
  });

const proxyDeniedByDelete: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await hidePrivateTwin(world);
    await expectProxyRefused(world, 'm11-proxy-only');
    await write(world.executor, [
      st("DELETE FROM version WHERE package_id = 'K-twin'"),
      st("DELETE FROM project_package WHERE package_id = 'K-twin'"),
    ]);
    await expectProxyRefused(world, 'm11-proxy-only');
    await write(world.executor, [st("DELETE FROM package WHERE id = 'K-twin'")]);
    await expectVisible(world, 'PA', 'm11-proxy-only');
  });

const registeredNames: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const a = world.a.orgId;
    const insert = (pattern: string) =>
      st(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('RN', ?, 'S-O', 'npm', ?)",
        a,
        pattern,
      );
    const drop = st("DELETE FROM registered_name WHERE id = 'RN'");

    await write(world.executor, [insert('m11-*')]);
    await expectProxyRefused(world, 'm11-proxy-only');
    expect(await world.reader.admitProxy(world.a, ref('PA', 'm11-other'))).toEqual([]);
    expect(await world.reader.admitProxy(world.a, ref('PA', 'm12-other'))).toEqual(['S-XP']);
    await write(world.executor, [drop]);
    await expectVisible(world, 'PA', 'm11-proxy-only');

    await write(world.executor, [insert('fresh-*')]);
    expect(await world.reader.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    const [klass] = await world.reader.classify(world.a, { ...scope('PA'), keys: ['fresh-name'] });
    expect(klass?.class).not.toBe('proxy_admissible');
    await write(world.executor, [drop]);
    expect(await world.reader.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual(['S-XP']);

    await write(world.executor, [insert('$invalid[')]);
    expect(await world.reader.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    await expectProxyRefused(world, 'm11-proxy-only');
  });

const registeredNamesOtherOrganization: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const snapshot = async () => ({
      proxy: await surface(world, world.a, 'PA', 'm11-proxy-only'),
      all: await collections(world, world.a, 'PA'),
      admission: await world.reader.admitProxy(world.a, ref('PA', 'fresh-name')),
      existingAdmission: await world.reader.admitProxy(world.a, ref('PA', 'm11-proxy-only')),
      classes: await world.reader.classify(world.a, {
        ...scope('PA'),
        keys: ['m11-proxy-only', 'fresh-name'],
      }),
      winners: await world.reader.classifyWinners(world.a, {
        ...scope('PA'),
        keys: ['m11-proxy-only'],
      }),
    });
    const before = await snapshot();
    expect(before.proxy.versions).not.toBeNull();
    expect(before.admission).toEqual(['S-XP']);
    expect(before.existingAdmission).toEqual(['S-XP']);
    expect(before.classes.map((entry) => entry.class)).toEqual([
      'proxy_admissible',
      'proxy_admissible',
    ]);
    for (const pattern of ['m11-*', 'fresh-*', '$invalid[']) {
      await write(world.executor, [
        st(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('RN-B', ?, 'S-B', 'npm', ?)",
          world.b.orgId,
          pattern,
        ),
      ]);
      expect(await snapshot(), pattern).toEqual(before);
      await write(world.executor, [st("DELETE FROM registered_name WHERE id = 'RN-B'")]);
    }
  });

const admissionRefusals: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const r = world.reader;
    const klass = async (ctx: OrgContext, projectId: string) =>
      (await r.classify(ctx, { ...scope(projectId), keys: ['fresh-name'] }))[0]?.class;
    expect(await klass(world.a, 'PA')).toBe('proxy_admissible');
    expect(await klass(world.a, 'PB')).toBe('not_available');
    expect(await klass(world.b, 'PA')).toBe('not_available');
    expect(await r.admitProxy(world.a, ref('PB', 'fresh-name'))).toEqual([]);
    expect(await r.admitProxy(world.a, ref('PA', 'm05-dup'))).toEqual([]);
    expect(await r.admitProxy(world.a, ref('PA', 'm02-secret-b'))).toEqual([]);

    await write(world.executor, [
      st(
        "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('PP1', ?, 'PA', 'S-XP', 'fresh-*', 'exclude')",
        world.a.orgId,
      ),
    ]);
    expect(await r.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    expect(await klass(world.a, 'PA')).not.toBe('proxy_admissible');
    await write(world.executor, [st("DELETE FROM project_package_pattern WHERE id = 'PP1'")]);
    expect(await r.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual(['S-XP']);

    await write(world.executor, [
      st("UPDATE source SET default_visible_to_new_projects = 0 WHERE id = 'S-XP'"),
    ]);
    expect(await r.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    await write(world.executor, [
      st("UPDATE source SET default_visible_to_new_projects = 1 WHERE id = 'S-XP'"),
      st("UPDATE project SET status = 'archived' WHERE id = 'PA'"),
    ]);
    expect(await r.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    expect(await klass(world.a, 'PA')).toBe('not_available');
  });

const nonProxyOutranksProxy: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const candidates = await world.reader.previewWinners(world.a, ref('PA', 'm05-dup'));
    expect(candidates.map((c) => [c.sourceId, c.eligible])).toEqual([
      ['S-O', true],
      ['S-XP', false],
    ]);
    expect(candidates[0]?.precedence).toBe(candidates[1]?.precedence);
    const [winner] = await world.reader.classifyWinners(world.a, {
      ...scope('PA'),
      keys: ['m05-dup'],
    });
    expect(winner?.winner).toEqual({ sourceId: 'S-O', sourceType: 'npm_registry' });

    await write(world.executor, [
      st("UPDATE project_source SET precedence = 0 WHERE source_id = 'S-XP' AND project_id = 'PA'"),
      st(
        "UPDATE project_source SET precedence = 900 WHERE source_id = 'S-O' AND project_id = 'PA'",
      ),
    ]);
    const swapped = await world.reader.previewWinners(world.a, ref('PA', 'm05-dup'));
    expect(swapped.map((c) => c.sourceId)).toEqual(['S-O', 'S-XP']);
    const resolution = await world.reader.resolveVersions(world.a, {
      ...ref('PA', 'm05-dup'),
      limit: 10,
    });
    expect(resolution).toMatchObject({ pkg: { sourceId: 'S-O', packageId: 'K-m05' } });
    expect(json(resolution)).not.toContain('9.9.9');

    await write(world.executor, [
      st(
        `INSERT INTO source (id, org_id, project_id, name, ecosystem, type)
         VALUES ('S-O2', ?, NULL, 'S-O2', 'npm', 'npm_registry')`,
        world.a.orgId,
      ),
      attach(world.a.orgId, 'PA', 'S-O2', 5),
      packageRow(world.a.orgId, 'K-m05-o2', 'S-O2', 'm05-dup'),
      versionRow(world.a.orgId, 'V-m05-o2', 'K-m05-o2', '7.7.7', 2),
      link(world.a.orgId, 'PA', 'K-m05-o2'),
    ]);
    const second = await world.reader.resolveVersions(world.a, {
      ...ref('PA', 'm05-dup'),
      limit: 10,
    });
    expect(second).toMatchObject({ pkg: { sourceId: 'S-O2' } });
    expect(
      await world.reader.lookupVersion(world.a, {
        ...ref('PA', 'm05-dup'),
        versionNormalized: '1.0.0',
      }),
    ).toBeNull();
    const listed = await world.reader.listVisible(world.a, { ...scope('PA'), limit: 200 });
    expect(listed.items.find((item) => item.key === 'm05-dup')?.sourceId).toBe('S-O2');
  });

const archivedProject: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await write(world.executor, [st("UPDATE project SET status = 'archived' WHERE id = 'PA'")]);
    for (const key of [...VISIBLE_A, ...FORGED_INTO_A]) {
      await expectUniformlyAbsent(world, world.a, 'PA', key);
      expect(await world.reader.previewWinners(world.a, ref('PA', key))).toEqual([]);
    }
    const all = await collections(world, world.a, 'PA');
    expect(all.listing.keys).toEqual([]);
    expect(all.listing.open).toBe(false);
    expect(all.full).toEqual({ items: [], next: null, openNamespace: false });
    expect(all.edges).toEqual([]);
    expect(all.search).toEqual([]);
    expect(await world.reader.admitProxy(world.a, ref('PA', 'fresh-name'))).toEqual([]);
    const classes = await world.reader.classify(world.a, { ...scope('PA'), keys: [...VISIBLE_A] });
    expect(classes.every((entry) => entry.class === 'not_available')).toBe(true);
    const winners = await world.reader.classifyWinners(world.a, {
      ...scope('PA'),
      keys: [...VISIBLE_A],
    });
    expect(winners.every((entry) => entry.winner === null)).toBe(true);
    await expectVisible(world, 'PB', 'm01-shared-lib');
  });

const removedUpstreamPolicy: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const r = world.reader;
    const flagged = await r.resolveVersions(world.a, {
      ...ref('PA', 'm07-flag-removed'),
      limit: 10,
    });
    expect(flagged).toMatchObject({ versions: [{ versionId: 'V-m07-100' }] });
    const shared = await r.resolveVersions(world.a, { ...ref('PA', 'm01-shared-lib'), limit: 200 });
    const statuses =
      shared !== null && 'versions' in shared ? shared.versions.map((v) => v.status) : [];
    expect(statuses).toEqual(['active', 'removed_upstream', 'active']);
    await expectUniformlyAbsent(world, world.a, 'PA', EXCLUDED_A);

    await write(world.executor, [
      st("UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-O'"),
    ]);
    await expectUniformlyAbsent(world, world.a, 'PA', 'm07-flag-removed');
    const pruned = await r.resolveVersions(world.a, { ...ref('PA', 'm01-shared-lib'), limit: 200 });
    expect(
      pruned !== null && 'versions' in pruned && pruned.versions.map((v) => v.versionId),
    ).toEqual(['V-m01-100', 'V-m01-400']);
    expect(
      await r.lookupVersion(world.a, {
        ...ref('PA', 'm01-shared-lib'),
        versionNormalized: '1.5.0',
      }),
    ).toBeNull();
    expect(
      await r.resolveDist(world.a, {
        ...ref('PA', 'm01-shared-lib'),
        by: 'version',
        versionNormalized: '1.5.0',
      }),
    ).toBeNull();
    const all = await collections(world, world.a, 'PA');
    expect(all.listing.keys).not.toContain('m07-flag-removed');
    expect(all.edges.map((e) => e.versionId)).not.toContain('V-m01-150');
    expect(all.edges.map((e) => e.versionId)).not.toContain('V-m07-100');

    await write(world.executor, [st("UPDATE source SET removal_policy = 'flag' WHERE id = 'S-X'")]);
    await expectVisible(world, 'PA', EXCLUDED_A);
    await write(world.executor, [
      st("UPDATE source SET removal_policy = 'exclude' WHERE id = 'S-X'"),
    ]);
    await expectUniformlyAbsent(world, world.a, 'PA', EXCLUDED_A);
  });

const versionStatuses: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    const r = world.reader;
    const shared = ref('PA', 'm01-shared-lib');
    const hiddenVersions = ['0.9.0', '2.0.0', '3.0.0'];
    for (const version of hiddenVersions) {
      expect(
        await r.lookupVersion(world.a, { ...shared, versionNormalized: version }),
        version,
      ).toBeNull();
      expect(
        await r.resolveDist(world.a, { ...shared, by: 'version', versionNormalized: version }),
        version,
      ).toBeNull();
    }
    for (const id of ['V-m01-090', 'V-m01-200', 'V-m01-300']) {
      expect(
        await r.resolveDist(world.a, { ...shared, by: 'id', versionId: id, revision: 1 }),
        id,
      ).toBeNull();
    }
    expect(await r.lookupTag(world.a, { ...shared, tag: 'held' })).toBeNull();
    expect(await r.lookupTag(world.a, { ...shared, tag: 'gone' })).toBeNull();
    expect((await r.distTags(world.a, shared))?.tags).toEqual({ latest: '1.0.0' });

    const pages: string[][] = [];
    const nexts: unknown[] = [];
    let after: { publishedAt: string; id: string } | undefined;
    let binding: { packageId: string; sourceId: string; rev: number } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await r.resolveVersions(world.a, {
        ...shared,
        limit: 1,
        ...(after === undefined || binding === undefined ? {} : { after, binding }),
      });
      if (page === null || 'changed' in page) throw new Error('page lost');
      pages.push(page.versions.map((v) => v.versionId));
      nexts.push(page.next);
      binding = page.binding;
      if (page.next === null) break;
      after = page.next;
    }
    expect(pages).toEqual([['V-m01-100'], ['V-m01-150'], ['V-m01-400']]);
    expect(nexts.at(-1)).toBeNull();
    expect(json(nexts)).not.toMatch(/V-m01-(090|200|300)/);

    const [first] = pages;
    expect(first).toEqual(['V-m01-100']);
    const afterVisibleLast = await r.resolveVersions(world.a, {
      ...shared,
      limit: 5,
      binding: binding as { packageId: string; sourceId: string; rev: number },
      after: { publishedAt: T(6), id: 'V-m01-400' },
    });
    expect(afterVisibleLast).toMatchObject({ versions: [], next: null });

    await write(world.executor, [
      st("UPDATE version SET status = 'quarantined' WHERE package_id = 'K-m09'"),
    ]);
    const quarantined = await r.resolveVersions(world.a, { ...ref('PA', 'm09-only-a'), limit: 10 });
    expect(quarantined).toMatchObject({ versions: [], next: null });
    const edges = await r.pageEdges(world.a, { ...scope('PA'), limit: 200 });
    expect(edges.rows.map((row) => row.requirerKey)).not.toContain('m09-only-a');
    const stable = await r.resolveVersions(world.a, {
      ...shared,
      limit: 200,
      publishedAtMost: T(3),
    });
    expect(
      stable !== null && 'versions' in stable && stable.versions.map((v) => v.versionId),
    ).toEqual(['V-m01-100', 'V-m01-150']);
  });

const historicalDistAfterStatusChange: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await write(world.executor, [
      st("UPDATE version SET revision = 2 WHERE id = 'V-m09-100'"),
      st(
        `INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, blob_id, reason)
         VALUES ('R-m09-100', ?, 'V-m09-100', 1,
           '{"dist":{"tarball":"https://u.test/historical-status.tgz"}}', 'B-X', 'sync')`,
        world.a.orgId,
      ),
    ]);
    const query = {
      ...ref('PA', 'm09-only-a'),
      by: 'id',
      versionId: 'V-m09-100',
      revision: 1,
    } as const;
    const history = await world.reader.resolveDist(world.a, query);
    expect(history).toMatchObject({
      versionId: 'V-m09-100',
      revision: 1,
      current: false,
      blob: { sha256: DIGEST_X },
      fetch: { upstreamDistUrl: 'https://u.test/historical-status.tgz' },
    });
    for (const status of ['quarantined', 'tombstoned']) {
      await write(world.executor, [
        st(
          "UPDATE version SET status = ?, tombstoned_at = ? WHERE id = 'V-m09-100'",
          status,
          status === 'tombstoned' ? T(8) : null,
        ),
      ]);
      const dist = await world.reader.resolveDist(world.a, query);
      expect(dist, status).toBeNull();
      const seen = [
        dist,
        await surface(world, world.a, 'PA', query.key),
        await collections(world, world.a, 'PA'),
      ];
      expectNoMarkers(seen);
      expectNoMarkers(seen, [DIGEST_X, 'historical-status.tgz', 'V-m09-100']);
    }
  });

const hiddenCursorAndDescriptionOracles: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, forgeStatements(world.a.orgId).rows);
    const r = world.reader;
    const hidden = 'm02-secret-b';
    const nonexistent = 'm02-secret-c';
    const listing = (after: string) => r.listVisible(world.a, { ...scope('PA'), after, limit: 2 });
    const listAfterHidden = await listing(hidden);
    expect(listAfterHidden.items.map((item) => item.key)).toEqual(['m03-pkg-spa', 'm05-dup']);
    expect(json(listAfterHidden)).toBe(json(await listing(nonexistent)));
    const edges = (requirerKey: string) =>
      r.pageEdges(world.a, {
        ...scope('PA'),
        after: { requirerKey, versionId: 'V-m02-100' },
        limit: 2,
      });
    const edgesAfterHidden = await edges(hidden);
    expect(edgesAfterHidden.rows.map((row) => row.requirerKey)).toEqual(['m03-pkg-spa', 'm05-dup']);
    expect(json(edgesAfterHidden)).toBe(json(await edges(nonexistent)));
    const description = { text: DESCRIPTION_B, limit: 50 } as const;
    const control = await r.listVisible(world.a, { ...scope('PB'), limit: 200 });
    expect(
      control.items.filter((item) => item.description === DESCRIPTION_B).map((item) => item.key),
    ).toEqual(['m02-secret-b', 'm99-secret-last']);
    expect(control.items.every((item) => !item.key.includes(DESCRIPTION_B))).toBe(true);
    const search = await r.search(world.a, { ...scope('PA'), ...description });
    expect(search).toEqual([]);
    expectNoMarkers([listAfterHidden, edgesAfterHidden, search]);
  });

const uniformAbsence: Case = (open, wrap) =>
  withWorld(open, wrap, async (world) => {
    await writeForged(world.executor, forgeStatements(world.a.orgId).rows);
    const reference = json(await surface(world, world.a, 'PA', ABSENT_KEY));
    const hiddenKeys = [
      'm02-secret-b',
      'm99-secret-last',
      'm06-foreign',
      'm00-eco-forged',
      EXCLUDED_A,
      UNPARSEABLE_KEY,
    ];
    for (const key of hiddenKeys) {
      expect(json(await surface(world, world.a, 'PA', key)), JSON.stringify(key)).toBe(reference);
    }
    for (const key of hiddenKeys) {
      expect(json(await surface(world, world.b, 'PA', key)), JSON.stringify(key)).toBe(reference);
    }
    const referenceDist = json(
      await world.reader.resolveDist(world.a, {
        ...ref('PA', ABSENT_KEY),
        by: 'id',
        versionId: 'V-none',
        revision: 1,
      }),
    );
    for (const key of ['m02-secret-b', UNPARSEABLE_KEY]) {
      const result = await world.reader.resolveDist(world.a, {
        ...ref('PA', key),
        by: 'id',
        versionId: 'V-m02-100',
        revision: 1,
      });
      expect(json(result)).toBe(referenceDist);
    }
  });

const missingSetupFails: Case = async (open, wrap) => {
  const opened = await open();
  try {
    const orgs = await seedTwoOrganizations(opened.executor);
    const empty: World = {
      executor: opened.executor,
      reader: createCatalogueReader((wrap ?? ((executor) => executor))(opened.executor)),
      a: orgs.a,
      b: orgs.b,
      close: async () => undefined,
    };
    await expect(assertControls(empty)).rejects.toThrow();
  } finally {
    await opened.close();
  }
};

export const catalogueReadContractCases = {
  isolationBetweenProjects,
  forgedProjectPackage,
  forgedProjectSource,
  forgedEcosystem,
  otherOrganization,
  forgedPackageOrganization,
  forgedVersionOrganization,
  forgedBlobOrganization,
  forgedDistTagOrganization,
  digestOnlyViaB,
  nonWinnerAndStaleExpect,
  proxyIneligibleAfterHide,
  proxyDeniedByDelete,
  registeredNames,
  registeredNamesOtherOrganization,
  admissionRefusals,
  nonProxyOutranksProxy,
  archivedProject,
  removedUpstreamPolicy,
  versionStatuses,
  historicalDistAfterStatusChange,
  hiddenCursorAndDescriptionOracles,
  uniformAbsence,
  missingSetupFails,
} as const;

const TIMEOUT = 60_000;

export function describeCatalogueReadContract(
  name: string,
  open: Open,
  wrap?: Wrap,
  options: { readonly d1?: boolean } = {},
): void {
  const forgedIt = forgedItFor(options.d1 === true);
  const c = catalogueReadContractCases;
  describe(`catalogue read contract: ${name}`, () => {
    it(
      '1. project B private package is absent from project A on every read surface',
      () => c.isolationBetweenProjects(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '2. a forged project_package row does not expose another project private package',
      () => c.forgedProjectPackage(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '3. forged project_package and project_source rows do not expose it either',
      () => c.forgedProjectSource(open, wrap),
      TIMEOUT,
    );
    it(
      '4. a package whose ecosystem differs from its source is refused and remains absent',
      () => c.forgedEcosystem(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '5. another organization sees nothing, including through forged cross-organization rows',
      () => c.otherOrganization(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '6. a digest reachable only through project B appears nowhere for project A',
      () => c.digestOnlyViaB(open, wrap),
      TIMEOUT,
    );
    it(
      '7. a non-winner version and a stale expect are absent from dist',
      () => c.nonWinnerAndStaleExpect(open, wrap),
      TIMEOUT,
    );
    it(
      '8. a proxy row stays ineligible after the private package of its key is hidden',
      () => c.proxyIneligibleAfterHide(open, wrap),
      TIMEOUT,
    );
    it(
      '9. a proxy row becomes eligible again only when no non-proxy package has the key',
      () => c.proxyDeniedByDelete(open, wrap),
      TIMEOUT,
    );
    it(
      '10. registered names refuse proxy rows and admission, invalid patterns fail closed',
      () => c.registeredNames(open, wrap),
      TIMEOUT,
    );
    it(
      '11. admission refusals: other project, other organization, excludes, flag, archived',
      () => c.admissionRefusals(open, wrap),
      TIMEOUT,
    );
    it(
      '12. a non-proxy source outranks a proxy at equal precedence and beyond',
      () => c.nonProxyOutranksProxy(open, wrap),
      TIMEOUT,
    );
    it(
      '13. an archived project reads as absent everywhere',
      () => c.archivedProject(open, wrap),
      TIMEOUT,
    );
    it(
      '14. removed_upstream follows the source removal policy',
      () => c.removedUpstreamPolicy(open, wrap),
      TIMEOUT,
    );
    it(
      '15. quarantined, tombstoned and yanked versions never appear in results or cursors',
      () => c.versionStatuses(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '16. hidden, absent and unparseable keys produce identical results',
      () => c.uniformAbsence(open, wrap),
      TIMEOUT,
    );
    it(
      '17. missing setup fails the controls instead of passing vacuously',
      () => c.missingSetupFails(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '18. an org-B package on an org-A source stays absent despite an org-A link and version',
      () => c.forgedPackageOrganization(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '19. an org-B version under an org-A package stays absent on every read surface',
      () => c.forgedVersionOrganization(open, wrap),
      TIMEOUT,
    );
    it(
      '20. an org-B blob referenced by current and historical org-A revisions is always null',
      () => c.forgedBlobOrganization(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '21. an org-B dist tag on an org-A package stays absent',
      () => c.forgedDistTagOrganization(open, wrap),
      TIMEOUT,
    );
    it(
      '22. matching and invalid org-B registrations leave org-A proxy reads and admission unchanged',
      () => c.registeredNamesOtherOrganization(open, wrap),
      TIMEOUT,
    );
    it(
      '23. historical dist becomes absent after quarantine and remains absent after tombstone',
      () => c.historicalDistAfterStatusChange(open, wrap),
      TIMEOUT,
    );
    forgedIt(
      '24. hidden cursors and description-only search reveal no private package',
      () => c.hiddenCursorAndDescriptionOracles(open, wrap),
      TIMEOUT,
    );
  });
}
