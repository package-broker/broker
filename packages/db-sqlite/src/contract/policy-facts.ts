import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { createVersionReader } from '../repositories/catalogue-read.js';
import { createCatalogueLookup } from '../repositories/catalogue-lookup.js';
import { createDistResolver } from '../repositories/catalogue-dist.js';
import { seeder, type Seed } from '../testing/mutation-table/harness.js';
import { seedPackage, seedProject, seedSource } from '../testing/mutation-table/fixtures.js';
import { seedTwoOrganizations } from './two-organizations.js';

type Open = () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>;

const RELEASED = '2026-01-01T00:00:00.000Z';
const CREATED = '2026-02-01T00:00:00.000Z';
const LEGACY_CREATED = '2026-03-01T00:00:00.000Z';
const SENTINEL = '1999-09-09T09:09:09.999Z';
const query = { projectId: 'P', ecosystem: 'npm', key: 'widget' } as const;

interface Seeded {
  readonly executor: SqlExecutor;
  readonly own: OrgContext;
  readonly foreign: OrgContext;
  readonly seed: Seed;
}

async function version(
  seed: Seed,
  row: {
    id: string;
    orgId: string;
    packageId: string;
    version: string;
    publishedAt: string;
    basis: string;
    createdAt: string;
    status?: string;
    revision?: number;
  },
): Promise<void> {
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
       published_at_basis, metadata_json, status, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    row.id,
    row.orgId,
    row.packageId,
    row.version,
    row.version,
    row.publishedAt,
    row.basis,
    row.status ?? 'active',
    row.revision ?? 1,
    row.createdAt,
  );
}

async function visible(seed: Seed, orgId: string, project: string, source: string, pkg: string) {
  await seedSource(seed, source, orgId, 'npm_registry', 'npm');
  await seedPackage(seed, pkg, orgId, source, 'widget', 'npm');
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    orgId,
    project,
    source,
    source === 'S2' ? 200 : 10,
  );
  await seed(
    'INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, ? AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1',
    orgId,
    project,
    pkg,
    'explicit',
  );
}

/**
 * The winner K (source S) holds a release-dated 1.0.0, a legacy 2.0.0 with an unknown basis and a
 * quarantined 3.0.0. A losing source S2 and another organization hold `widget` with sentinel dates.
 */
async function seedFacts(executor: SqlExecutor): Promise<Seeded> {
  const orgs = await seedTwoOrganizations(executor);
  const own = orgs.a;
  const foreign = orgs.b;
  const seed = seeder(executor);
  await seedProject(seed, 'P', own.orgId);
  await visible(seed, own.orgId, 'P', 'S', 'K');
  await visible(seed, own.orgId, 'P', 'S2', 'K2');
  await version(seed, {
    id: 'V1',
    orgId: own.orgId,
    packageId: 'K',
    version: '1.0.0',
    publishedAt: RELEASED,
    basis: 'release_date',
    createdAt: CREATED,
    revision: 2,
  });
  await version(seed, {
    id: 'V2',
    orgId: own.orgId,
    packageId: 'K',
    version: '2.0.0',
    publishedAt: '2026-01-02T00:00:00.000Z',
    basis: 'upstream',
    createdAt: LEGACY_CREATED,
  });
  await version(seed, {
    id: 'V3',
    orgId: own.orgId,
    packageId: 'K',
    version: '3.0.0',
    publishedAt: '2026-01-03T00:00:00.000Z',
    basis: 'broker',
    createdAt: CREATED,
    status: 'quarantined',
  });
  await version(seed, {
    id: 'L1',
    orgId: own.orgId,
    packageId: 'K2',
    version: '1.0.0',
    publishedAt: SENTINEL,
    basis: 'import_time',
    createdAt: SENTINEL,
  });
  await seed(
    "INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason) VALUES ('R1', ?, 'V1', 1, '{}', 'upstream_changed')",
    own.orgId,
  );
  for (const [tag, target] of [
    ['latest', 'V1'],
    ['legacy', 'V2'],
    ['next', 'V3'],
  ] as const) {
    await seed(
      'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)',
      own.orgId,
      'K',
      tag,
      target,
    );
  }
  await seedProject(seed, 'FP', foreign.orgId);
  await visible(seed, foreign.orgId, 'FP', 'FS', 'FK');
  await version(seed, {
    id: 'FV1',
    orgId: foreign.orgId,
    packageId: 'FK',
    version: '1.0.0',
    publishedAt: SENTINEL,
    basis: 'release_date',
    createdAt: SENTINEL,
  });
  return { executor, own, foreign, seed };
}

const V1_FACTS = { publishedAt: RELEASED, publishedAtBasis: 'release_date', createdAt: CREATED };
const V2_FACTS = {
  publishedAt: '2026-01-02T00:00:00.000Z',
  publishedAtBasis: 'upstream',
  createdAt: LEGACY_CREATED,
};

function withSeeded(
  open: Open,
  body: (get: () => Seeded, forged: boolean) => void,
  forged: boolean,
) {
  let database: Awaited<ReturnType<Open>>;
  let seeded: Seeded;
  beforeEach(async () => {
    database = await open();
    seeded = await seedFacts(database.executor);
  });
  afterEach(() => database.close());
  body(() => seeded, forged);
}

export function describePolicyPageFacts(name: string, open: Open, forged = true): void {
  describe(`policy facts on version pages: ${name}`, () => {
    withSeeded(
      open,
      (get, canForge) => {
        it('carries the stored basis and created_at of the winner, for visible versions only', async () => {
          const { executor, own } = get();
          const page = await createVersionReader(executor).resolveVersions(own, {
            ...query,
            limit: 10,
          });
          if (page === null || 'changed' in page) throw new Error('expected a page');
          expect(page.pkg).toMatchObject({ packageId: 'K', sourceId: 'S' });
          expect(
            page.versions.map((v) => [v.versionId, v.publishedAt, v.publishedAtBasis, v.createdAt]),
          ).toEqual([
            ['V1', V1_FACTS.publishedAt, V1_FACTS.publishedAtBasis, V1_FACTS.createdAt],
            ['V2', V2_FACTS.publishedAt, V2_FACTS.publishedAtBasis, V2_FACTS.createdAt],
          ]);
          expect(JSON.stringify(page)).not.toContain(SENTINEL);
        });

        it('keeps the facts across a continuation page', async () => {
          const { executor, own } = get();
          const reader = createVersionReader(executor);
          const first = await reader.resolveVersions(own, { ...query, limit: 1 });
          if (first === null || 'changed' in first || first.next === null) throw new Error('page');
          const second = await reader.resolveVersions(own, {
            ...query,
            limit: 1,
            binding: first.binding,
            after: first.next,
          });
          if (second === null || 'changed' in second) throw new Error('expected a page');
          expect(second.versions).toMatchObject([{ versionId: 'V2', ...V2_FACTS }]);
        });

        it.runIf(canForge)('never returns a forged row of another organization', async () => {
          const { executor, own, foreign, seed } = get();
          await version(seed.forged, {
            id: 'FORGED',
            orgId: foreign.orgId,
            packageId: 'K',
            version: '0.0.1',
            publishedAt: SENTINEL,
            basis: 'release_date',
            createdAt: SENTINEL,
          });
          const page = await createVersionReader(executor).resolveVersions(own, {
            ...query,
            limit: 10,
          });
          expect(JSON.stringify(page)).not.toContain(SENTINEL);
        });
      },
      forged,
    );
  });
}

export function describePolicyLookupFacts(name: string, open: Open, forged = true): void {
  describe(`policy facts on version and tag lookups: ${name}`, () => {
    withSeeded(
      open,
      (get, canForge) => {
        it('an exact version and a tag target carry identity and stored dates', async () => {
          const { executor, own } = get();
          const lookup = createCatalogueLookup(executor);
          expect(
            await lookup.lookupVersion(own, { ...query, versionNormalized: '1.0.0' }),
          ).toMatchObject({
            pkg: { packageId: 'K', sourceId: 'S' },
            version: { versionId: 'V1', revision: 2, versionNormalized: '1.0.0', ...V1_FACTS },
          });
          expect(await lookup.lookupTag(own, { ...query, tag: 'legacy' })).toMatchObject({
            version: { versionId: 'V2', versionNormalized: '2.0.0', ...V2_FACTS },
          });
        });

        it('a tag targeting a hidden version and another organization stay hidden', async () => {
          const { executor, own, foreign } = get();
          const lookup = createCatalogueLookup(executor);
          expect(await lookup.lookupTag(own, { ...query, tag: 'next' })).toBeNull();
          expect(
            await lookup.lookupVersion(own, { ...query, versionNormalized: '3.0.0' }),
          ).toBeNull();
          expect(
            await lookup.lookupVersion(foreign, { ...query, versionNormalized: '1.0.0' }),
          ).toBeNull();
          expect(
            await lookup.lookupVersion(foreign, {
              ...query,
              projectId: 'FP',
              versionNormalized: '1.0.0',
            }),
          ).toMatchObject({
            version: { versionId: 'FV1', createdAt: SENTINEL },
          });
        });

        it.runIf(canForge)('a forged foreign row never answers an own lookup', async () => {
          const { executor, own, foreign, seed } = get();
          await version(seed.forged, {
            id: 'FORGED',
            orgId: foreign.orgId,
            packageId: 'K',
            version: '0.0.1',
            publishedAt: SENTINEL,
            basis: 'release_date',
            createdAt: SENTINEL,
          });
          expect(
            await createCatalogueLookup(executor).lookupVersion(own, {
              ...query,
              versionNormalized: '0.0.1',
            }),
          ).toBeNull();
        });
      },
      forged,
    );
  });
}

export function describePolicyDistFacts(name: string, open: Open): void {
  describe(`policy facts on dist targets: ${name}`, () => {
    withSeeded(
      open,
      (get) => {
        const facts = { version: '1.0.0', versionNormalized: '1.0.0', ...V1_FACTS };

        it('current and historical revisions carry the current version identity and dates', async () => {
          const { executor, own } = get();
          const resolver = createDistResolver(executor);
          expect(
            await resolver.resolveDist(own, {
              ...query,
              by: 'version',
              versionNormalized: '1.0.0',
            }),
          ).toMatchObject({ versionId: 'V1', revision: 2, current: true, facts });
          expect(
            await resolver.resolveDist(own, { ...query, by: 'id', versionId: 'V1', revision: 1 }),
          ).toMatchObject({
            versionId: 'V1',
            revision: 1,
            current: false,
            status: 'active',
            facts,
          });
        });

        it('an old revision cannot evade the current quarantine of its version', async () => {
          const { executor, own } = get();
          await executor.batch([
            { sql: "UPDATE version SET status = 'quarantined' WHERE id = 'V1'", params: [] },
          ]);
          const resolver = createDistResolver(executor);
          expect(
            await resolver.resolveDist(own, { ...query, by: 'id', versionId: 'V1', revision: 1 }),
          ).toBeNull();
          expect(
            await resolver.resolveDist(own, { ...query, by: 'id', versionId: 'V1', revision: 2 }),
          ).toBeNull();
        });

        it('another organization cannot resolve the revision or see its facts', async () => {
          const { executor, foreign } = get();
          const resolver = createDistResolver(executor);
          expect(
            await resolver.resolveDist(foreign, {
              ...query,
              by: 'id',
              versionId: 'V1',
              revision: 1,
            }),
          ).toBeNull();
          expect(
            await resolver.resolveDist(foreign, {
              ...query,
              projectId: 'FP',
              by: 'id',
              versionId: 'V1',
              revision: 1,
            }),
          ).toBeNull();
        });
      },
      false,
    );
  });
}
