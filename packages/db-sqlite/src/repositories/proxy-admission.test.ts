import { describe, expect, it } from 'vitest';
import { admitProxy } from '@package-broker/core/catalogue/visibility';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import { orgContext, type ScalarStatement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  toVisibilityInputs,
  type CatalogueConfig,
  type FixtureSource,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { sql } from 'kysely';
import { compile, db } from '../kysely.js';
import { admittedProxySources, createProxyAdmission } from './proxy-admission.js';

const ORG_A = '01J00000000000000000000A0A';
const ORG_B = '01J00000000000000000000B0B';

describe('admit against the oracle', () => {
  it('equals admitProxy on 200 random configurations, one executor.all per call', async () => {
    let admitted = 0;
    let refused = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const config = randomCatalogueConfig(seed, 6, { forged: seed % 2 === 0 });
      const database = await openMigratedDatabase();
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        const inputs = toVisibilityInputs(config);
        const keys = new Map<string, { ecosystem: NameEcosystem; key: string }>();
        for (const p of config.packages) keys.set(`${p.ecosystem}\0${p.key}`, p);
        keys.set('composer\0unseen/name', { ecosystem: 'composer', key: 'unseen/name' });
        keys.set('npm\0unseen', { ecosystem: 'npm', key: 'unseen' });
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const { ecosystem, key } of keys.values()) {
            const counted = countCalls(database.executor);
            const actual = await createProxyAdmission(counted.executor).admitProxy(ctx, {
              projectId: project.id,
              ecosystem,
              key,
            });
            const expected = admitProxy(inputs, project.id, ecosystem, key);
            expect(actual, `${seed} ${project.id} ${ecosystem} ${key}`).toEqual(expected);
            expect(counted.counts()).toEqual({ all: 1, batch: 0 });
            if (expected.length > 0) admitted += 1;
            else refused += 1;
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(admitted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  }, 120_000);
});

function source(
  id: string,
  orgId: string,
  type: FixtureSource['type'],
  projectId: string | null = null,
): FixtureSource {
  return {
    id,
    orgId,
    projectId,
    name: `source-${id.slice(-4)}`,
    ecosystem: 'composer',
    type,
    defaultVisible: 1,
    removalPolicy: 'flag',
  };
}

const P1 = '01JPR000000000000000000001';
const P2 = '01JPR000000000000000000002';
const P3 = '01JPR000000000000000000003';
const PB = '01JPR000000000000000000004';
const PROXY = '01JSC000000000000000000001';
const OWN_PROXY = '01JSC000000000000000000002';
const FOREIGN_PROXY = '01JSC000000000000000000003';
const PRIVATE = '01JSC000000000000000000004';
const PROXY_LATE = '01JSC000000000000000000005';

const NEGATIVE: CatalogueConfig = {
  organizations: [
    { id: ORG_A, slug: 'org-a', name: 'Organization A' },
    { id: ORG_B, slug: 'org-b', name: 'Organization B' },
  ],
  projects: [
    { id: P1, orgId: ORG_A, slug: 'p1', name: 'P1', status: 'active' },
    { id: P2, orgId: ORG_A, slug: 'p2', name: 'P2', status: 'active' },
    { id: P3, orgId: ORG_A, slug: 'p3', name: 'P3', status: 'archived' },
    { id: PB, orgId: ORG_B, slug: 'pb', name: 'PB', status: 'active' },
  ],
  sources: [
    source(PROXY, ORG_A, 'packagist_proxy'),
    source(PROXY_LATE, ORG_A, 'packagist_proxy'),
    source(OWN_PROXY, ORG_A, 'packagist_proxy', P2),
    source(FOREIGN_PROXY, ORG_B, 'packagist_proxy'),
    source(PRIVATE, ORG_A, 'vcs'),
  ],
  attachments: [
    { orgId: ORG_A, projectId: P1, sourceId: PROXY_LATE, precedence: 1000 },
    { orgId: ORG_A, projectId: P1, sourceId: PROXY, precedence: 10 },
    { orgId: ORG_A, projectId: P1, sourceId: OWN_PROXY, precedence: 0 },
    { orgId: ORG_A, projectId: P1, sourceId: FOREIGN_PROXY, precedence: 0 },
    { orgId: ORG_A, projectId: P2, sourceId: OWN_PROXY, precedence: 5 },
    { orgId: ORG_A, projectId: P3, sourceId: PROXY, precedence: 10 },
    { orgId: ORG_B, projectId: PB, sourceId: FOREIGN_PROXY, precedence: 10 },
  ],
  patterns: [],
  packages: [
    {
      id: '01JPK000000000000000000001',
      orgId: ORG_A,
      sourceId: PRIVATE,
      ecosystem: 'composer',
      key: 'acme/hidden',
      visible: 0,
      status: 'active',
    },
    {
      id: '01JPK000000000000000000002',
      orgId: ORG_A,
      sourceId: PRIVATE,
      ecosystem: 'composer',
      key: 'acme/removed',
      visible: 1,
      status: 'removed_upstream',
    },
  ],
  explicit: [],
  registeredNames: [
    {
      id: '01JRN000000000000000000001',
      orgId: ORG_A,
      sourceId: PRIVATE,
      ecosystem: 'composer',
      pattern: 'acme/reg-*',
    },
  ],
  versions: [],
};

describe('admit refusals', () => {
  async function admitted(projectId: string, key: string, orgId = ORG_A) {
    const database = await openMigratedDatabase();
    try {
      await seedCatalogue(database.executor, NEGATIVE);
      const actual = await createProxyAdmission(database.executor).admitProxy(orgContext(orgId), {
        projectId,
        ecosystem: 'composer',
        key,
      });
      if (orgId === ORG_A) {
        expect(actual).toEqual(
          admitProxy(toVisibilityInputs(NEGATIVE), projectId, 'composer', key),
        );
      }
      return actual;
    } finally {
      await database.close();
    }
  }

  it('admits an unseen name through the organization proxies in precedence order only', async () => {
    expect(await admitted(P1, 'vendor/free')).toEqual([PROXY, PROXY_LATE]);
  });

  it('refuses a key held by a hidden private package', async () => {
    expect(await admitted(P1, 'acme/hidden')).toEqual([]);
  });

  it('refuses a key held by a removed private package', async () => {
    expect(await admitted(P1, 'acme/removed')).toEqual([]);
  });

  it('refuses a key matching a registered name', async () => {
    expect(await admitted(P1, 'acme/reg-1')).toEqual([]);
  });

  it("does not admit through a forged attachment of another project's proxy", async () => {
    expect(await admitted(P2, 'vendor/free')).toEqual([OWN_PROXY]);
    expect(await admitted(P1, 'vendor/free')).not.toContain(OWN_PROXY);
  });

  it("does not admit through another organization's proxy", async () => {
    expect(await admitted(P1, 'vendor/free')).not.toContain(FOREIGN_PROXY);
    expect(await admitted(P1, 'vendor/free', ORG_B)).toEqual([]);
  });

  it('refuses an archived project', async () => {
    expect(await admitted(P3, 'vendor/free')).toEqual([]);
  });
});

describe('admittedProxySources composed in a caller query', () => {
  it('matches admitProxy whatever alias the caller gives the key row', async () => {
    const aliases = ['k', 'src', 'ps', 'prj', 'guard_ps', 'guard_src', 'guard_q', 'guard_r'];
    let admitted = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const config = randomCatalogueConfig(seed, 6);
      const database = await openMigratedDatabase();
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        const inputs = toVisibilityInputs(config);
        const keys = new Map<string, { ecosystem: NameEcosystem; key: string }>();
        for (const p of config.packages) keys.set(`${p.ecosystem}\0${p.key}`, p);
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const { ecosystem, key } of keys.values()) {
            const expected = admitProxy(inputs, project.id, ecosystem, key);
            if (expected.length > 0) admitted += 1;
            for (const alias of aliases) {
              const inner = admittedProxySources(ctx, project.id, ecosystem, alias);
              const raw = sql<{ admitted: number; first: string | null }>`select
  exists ${inner} as admitted,
  ${inner.limit(1)} as first
from (select ${project.orgId} as org_id, ${ecosystem} as ecosystem, ${key} as name) as ${sql.id(alias)}`;
              const statement = compile({ compile: () => raw.compile(db) }) as ScalarStatement;
              const [row] = await database.executor.all<{ admitted: number; first: string | null }>(
                statement,
              );
              expect(row, `${seed} ${project.id} ${key} ${alias}`).toEqual({
                admitted: expected.length > 0 ? 1 : 0,
                first: expected[0] ?? null,
              });
            }
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(admitted).toBeGreaterThan(50);
  }, 120_000);

  it('rejects a key-row alias that is not a plain identifier', () => {
    expect(() => admittedProxySources(orgContext(ORG_A), P1, 'composer', 'k.name')).toThrow(
      TypeError,
    );
  });
});
