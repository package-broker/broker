import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';
import { isValidPattern, matchesPattern } from '@package-broker/core/catalogue/patterns';
import {
  admitProxy,
  deriveVisibility,
  resolveWinner,
  type VisibilityOrigin,
  type VisibilityPackageStatus,
} from '@package-broker/core/catalogue/visibility';
import {
  D1_STATEMENTS_PER_INVOCATION,
  catalogueStatementCount,
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
  type CatalogueConfig,
} from './catalogue-fixture.js';
import { openMigratedDatabase } from './migrated-database.js';

type Row = Record<string, unknown>;

const byJson = (a: unknown, b: unknown): number => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

async function select(executor: SqlExecutor, sql: string): Promise<Row[]> {
  return executor.all<Row>({ sql, params: [] });
}

async function readBack(executor: SqlExecutor): Promise<CatalogueConfig> {
  const q = (sql: string) => select(executor, sql);
  return {
    organizations: (await q('SELECT id, slug, name FROM organization')) as never,
    projects: (await q('SELECT id, org_id AS orgId, slug, name, status FROM project')) as never,
    sources: (
      await q(
        `SELECT id, org_id AS orgId, project_id AS projectId, name, ecosystem, type,
                default_visible_to_new_projects AS defaultVisible, removal_policy AS removalPolicy
         FROM source`,
      )
    ).sort(byJson) as never,
    attachments: (
      await q(
        'SELECT org_id AS orgId, project_id AS projectId, source_id AS sourceId, precedence FROM project_source',
      )
    ).sort(byJson) as never,
    patterns: (
      await q(
        `SELECT id, org_id AS orgId, project_id AS projectId, source_id AS sourceId, pattern, effect
         FROM project_package_pattern`,
      )
    ).sort(byJson) as never,
    packages: (
      await q(
        `SELECT id, org_id AS orgId, source_id AS sourceId, ecosystem, name AS key,
                visible_to_new_projects AS visible, status
         FROM package`,
      )
    ).sort(byJson) as never,
    explicit: (
      await q(
        `SELECT org_id AS orgId, project_id AS projectId, package_id AS packageId
         FROM project_package WHERE origin = 'explicit'`,
      )
    ).sort(byJson) as never,
    registeredNames: (
      await q(
        `SELECT id, org_id AS orgId, source_id AS sourceId, ecosystem, pattern FROM registered_name`,
      )
    ).sort(byJson) as never,
    versions: (
      await q(
        `SELECT id, org_id AS orgId, package_id AS packageId, version,
                version_normalized AS normalized, stability, status, published_at AS publishedAt
         FROM version`,
      )
    ).sort(byJson) as never,
  };
}

function normalized(config: CatalogueConfig): CatalogueConfig {
  const sort = <T>(rows: readonly T[]): T[] => [...rows].sort(byJson);
  return {
    organizations: sort(config.organizations),
    projects: sort(config.projects),
    sources: sort(config.sources),
    attachments: sort(config.attachments),
    patterns: sort(config.patterns),
    packages: sort(config.packages),
    explicit: sort(config.explicit),
    registeredNames: sort(config.registeredNames),
    versions: sort(config.versions),
  };
}

describe('catalogue fixture', () => {
  it('1: the same seed yields identical configurations and different seeds differ', () => {
    expect(randomCatalogueConfig(7, 6)).toEqual(randomCatalogueConfig(7, 6));
    expect(randomCatalogueConfig(7, 6)).not.toEqual(randomCatalogueConfig(8, 6));
  });

  it('2: seeding then reading back each table equals the config', async () => {
    for (const seed of [1, 2, 3, 42]) {
      const database = await openMigratedDatabase();
      try {
        const config = randomCatalogueConfig(seed, 8);
        await seedCatalogue(database.executor, config);
        const actual = await readBack(database.executor);
        expect(normalized(actual)).toEqual(normalized(config));
        const epochs = await select(database.executor, 'SELECT org_id FROM cache_epoch');
        expect(epochs.map((row) => row.org_id).sort()).toEqual(
          config.organizations.map((org) => org.id).sort(),
        );
      } finally {
        await database.close();
      }
    }
  });

  it('3: seeds on top of the two-organization database and a large size in batches', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    try {
      const config = randomCatalogueConfig(5, 40);
      await expect(seedCatalogue(database.executor, config)).rejects.toThrow(RangeError);
      await seedCatalogue(database.executor, config, { maxStatements: Infinity });
      const [row] = await select(database.executor, 'SELECT count(*) AS n FROM package');
      expect(row).toEqual({ n: config.packages.length });
      expect(config.packages.length).toBeGreaterThan(200);
    } finally {
      await database.close();
    }
  });

  it('4: generated configurations respect the structural rules', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const config = randomCatalogueConfig(seed, 6);
      expect(config.organizations).toHaveLength(2);
      for (const name of config.registeredNames) expect(isValidPattern(name.pattern)).toBe(true);
      for (const pattern of config.patterns) expect(isValidPattern(pattern.pattern)).toBe(true);
      const sources = new Map(config.sources.map((s) => [s.id, s]));
      for (const a of config.attachments) {
        const source = sources.get(a.sourceId);
        expect(source?.orgId).toBe(a.orgId);
        expect(source?.projectId === null || source?.projectId === a.projectId).toBe(true);
      }
      const attached = new Set(config.attachments.map((a) => `${a.projectId}\0${a.sourceId}`));
      for (const p of config.patterns)
        expect(attached.has(`${p.projectId}\0${p.sourceId}`)).toBe(true);
    }
  });

  it('5: deriveVisibility over 200 seeds covers every origin and package status', () => {
    const origins = new Set<VisibilityOrigin>();
    const statuses = new Set<VisibilityPackageStatus>();
    let collisions = 0;
    let archived = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const config = randomCatalogueConfig(seed, 6);
      const inputs = toVisibilityInputs(config);
      for (const row of deriveVisibility(inputs)) origins.add(row.origin);
      for (const pkg of inputs.packages) statuses.add(pkg.status);
      archived += inputs.projects.filter((p) => !p.active).length;
      const proxies = new Set(
        config.sources.filter((s) => s.type.endsWith('_proxy')).map((s) => s.id),
      );
      const privateKeys = new Set(
        config.packages
          .filter((p) => !proxies.has(p.sourceId))
          .map((p) => `${p.orgId}\0${p.ecosystem}\0${p.key}`),
      );
      collisions += config.packages.filter(
        (p) => proxies.has(p.sourceId) && privateKeys.has(`${p.orgId}\0${p.ecosystem}\0${p.key}`),
      ).length;
    }
    expect([...origins].sort()).toEqual(['explicit', 'pattern', 'subscription']);
    expect([...statuses].sort()).toEqual(['active', 'removed_upstream']);
    expect(collisions).toBeGreaterThan(0);
    expect(archived).toBeGreaterThan(0);
  });

  it('6: toVisibilityInputs maps patterns to includes and excludes per attachment', () => {
    const config = randomCatalogueConfig(11, 6);
    const inputs = toVisibilityInputs(config);
    expect(inputs.attachments).toHaveLength(config.attachments.length);
    const includes = inputs.attachments.reduce((n, a) => n + a.includes.length, 0);
    const excludes = inputs.attachments.reduce((n, a) => n + a.excludes.length, 0);
    expect(includes).toBe(config.patterns.filter((p) => p.effect === 'include').length);
    expect(excludes).toBe(config.patterns.filter((p) => p.effect === 'exclude').length);
  });
  it('7: seedCatalogue accepts configurations up to the D1 budget for sizes up to 12', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(catalogueStatementCount(randomCatalogueConfig(seed, 12))).toBeLessThanOrEqual(
        D1_STATEMENTS_PER_INVOCATION,
      );
    }
  });

  it('8: every generated id is a ULID, also with the options on', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const c = randomCatalogueConfig(seed, 6, { forged: true, longVersionLists: true });
      const ids = [
        ...c.organizations,
        ...c.projects,
        ...c.sources,
        ...c.patterns,
        ...c.packages,
        ...c.registeredNames,
        ...c.versions,
      ].map((row) => row.id);
      for (const id of ids) expect(isUlid(id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('9: without forged rows every child shares its parent organization', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const c = randomCatalogueConfig(seed, 6);
      const project = new Map(c.projects.map((p) => [p.id, p.orgId]));
      const source = new Map(c.sources.map((s) => [s.id, s.orgId]));
      const pkg = new Map(c.packages.map((p) => [p.id, p.orgId]));
      for (const s of c.sources) if (s.projectId) expect(project.get(s.projectId)).toBe(s.orgId);
      for (const a of c.attachments) {
        expect(project.get(a.projectId)).toBe(a.orgId);
        expect(source.get(a.sourceId)).toBe(a.orgId);
      }
      for (const p of c.patterns) {
        expect(project.get(p.projectId)).toBe(p.orgId);
        expect(source.get(p.sourceId)).toBe(p.orgId);
      }
      for (const p of c.packages) expect(source.get(p.sourceId)).toBe(p.orgId);
      for (const e of c.explicit) {
        expect(project.get(e.projectId)).toBe(e.orgId);
        expect(pkg.get(e.packageId)).toBe(e.orgId);
      }
      for (const r of c.registeredNames) expect(source.get(r.sourceId)).toBe(r.orgId);
      for (const v of c.versions) expect(pkg.get(v.packageId)).toBe(v.orgId);
    }
  });

  it('10: forged rows exist, seed, and never change what the oracle derives', async () => {
    let foreign = 0;
    let unattached = 0;
    let wrongOrg = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const plain = randomCatalogueConfig(seed, 6);
      const forged = randomCatalogueConfig(seed, 6, { forged: true });
      expect(deriveVisibility(toVisibilityInputs(forged))).toEqual(
        deriveVisibility(toVisibilityInputs(plain)),
      );
      const project = new Map(forged.projects.map((p) => [p.id, p.orgId]));
      const source = new Map(forged.sources.map((s) => [s.id, s]));
      const pkg = new Map(forged.packages.map((p) => [p.id, p]));
      const attached = new Set(forged.attachments.map((a) => `${a.projectId}\0${a.sourceId}`));
      for (const a of forged.attachments) {
        const s = source.get(a.sourceId);
        if (s?.projectId && s.projectId !== a.projectId) foreign += 1;
        if (project.get(a.projectId) !== a.orgId) wrongOrg += 1;
      }
      for (const e of forged.explicit) {
        const p = pkg.get(e.packageId);
        if (p && !attached.has(`${e.projectId}\0${p.sourceId}`)) unattached += 1;
        if (project.get(e.projectId) !== e.orgId) wrongOrg += 1;
      }
    }
    expect(foreign).toBeGreaterThan(0);
    expect(unattached).toBeGreaterThan(0);
    expect(wrongOrg).toBeGreaterThan(0);

    const database = await openMigratedDatabase();
    try {
      const config = randomCatalogueConfig(3, 6, { forged: true, longVersionLists: true });
      await seedCatalogue(database.executor, config, { maxStatements: Infinity });
      expect(normalized(await readBack(database.executor))).toEqual(normalized(config));
    } finally {
      await database.close();
    }
  });

  it('11: long version lists cross a 200-row page and only when asked for', () => {
    const longest = (c: CatalogueConfig): number => {
      const counts = new Map<string, number>();
      for (const v of c.versions) counts.set(v.packageId, (counts.get(v.packageId) ?? 0) + 1);
      return Math.max(0, ...counts.values());
    };
    expect(longest(randomCatalogueConfig(1, 6))).toBeLessThanOrEqual(3);
    expect(longest(randomCatalogueConfig(1, 6, { longVersionLists: true }))).toBeGreaterThan(200);
    const c = randomCatalogueConfig(2, 6);
    expect(new Set(c.versions.map((v) => v.publishedAt)).size).toBeGreaterThan(1);
  });

  it('12: seedDerivedRows writes exactly the oracle rows', async () => {
    for (const forged of [false, true]) {
      const database = await openMigratedDatabase();
      try {
        const config = randomCatalogueConfig(9, 6, { forged });
        await seedCatalogue(database.executor, config);
        await seedDerivedRows(database.executor, config);
        const rows = await select(
          database.executor,
          "SELECT project_id AS projectId, package_id AS packageId, origin FROM project_package WHERE origin <> 'explicit'",
        );
        const expected = deriveVisibility(toVisibilityInputs(config)).filter(
          (r) => r.origin !== 'explicit',
        );
        expect(rows.sort(byJson)).toEqual([...expected].sort(byJson));
        expect(expected.length).toBeGreaterThan(0);
      } finally {
        await database.close();
      }
    }
  });

  it('13: derived rows cover statuses, stabilities and the interesting resolution cases', () => {
    const packageStatuses = new Set<string>();
    const stabilities = new Set<string>();
    const versionStatuses = new Set<string>();
    const counters = {
      explicitOnFlag0: 0,
      excludeBeatsFlag1: 0,
      proxyBlockedByRegisteredNameOnly: 0,
      proxyWinner: 0,
      projectLevelWinner: 0,
      multiProxyAdmission: 0,
    };
    for (let seed = 1; seed <= 200; seed += 1) {
      const config = randomCatalogueConfig(seed, 6);
      const inputs = toVisibilityInputs(config);
      const rows = deriveVisibility(inputs);
      const packages = new Map(config.packages.map((p) => [p.id, p]));
      const sources = new Map(config.sources.map((s) => [s.id, s]));
      const derived = new Set(rows.map((r) => `${r.projectId}\0${r.packageId}`));
      const derivedPackages = new Set(rows.map((r) => r.packageId));
      for (const r of rows) {
        const p = packages.get(r.packageId);
        if (p) {
          packageStatuses.add(p.status);
          if (r.origin === 'explicit' && p.visible === 0) counters.explicitOnFlag0 += 1;
        }
      }
      for (const v of config.versions) {
        if (derivedPackages.has(v.packageId)) {
          stabilities.add(v.stability);
          versionStatuses.add(v.status);
        }
      }
      for (const a of inputs.attachments) {
        for (const p of config.packages) {
          if (
            p.sourceId === a.sourceId &&
            p.visible === 1 &&
            a.excludes.some((x) => matchesPattern(x, p.key)) &&
            !derived.has(`${a.projectId}\0${p.id}`)
          ) {
            counters.excludeBeatsFlag1 += 1;
          }
        }
      }
      for (const r of rows) {
        const p = packages.get(r.packageId);
        const s = p && sources.get(p.sourceId);
        if (!p || !s?.type.endsWith('_proxy')) continue;
        const heldPrivately = config.packages.some(
          (q) =>
            q.orgId === p.orgId &&
            q.key === p.key &&
            !sources.get(q.sourceId)?.type.endsWith('_proxy'),
        );
        const registered = config.registeredNames.some(
          (n) =>
            n.orgId === p.orgId && n.ecosystem === p.ecosystem && matchesPattern(n.pattern, p.key),
        );
        if (!heldPrivately && registered) counters.proxyBlockedByRegisteredNameOnly += 1;
        const winner = resolveWinner(inputs, r.projectId, p.ecosystem, p.key);
        if (winner?.packageId === p.id) counters.proxyWinner += 1;
        if (admitProxy(inputs, r.projectId, p.ecosystem, p.key).length >= 2) {
          counters.multiProxyAdmission += 1;
        }
      }
      for (const r of rows) {
        const p = packages.get(r.packageId);
        const s = p && sources.get(p.sourceId);
        if (p && s?.projectId) {
          if (resolveWinner(inputs, r.projectId, p.ecosystem, p.key)?.packageId === p.id) {
            counters.projectLevelWinner += 1;
          }
        }
      }
    }
    expect([...packageStatuses].sort()).toEqual(['active', 'removed_upstream']);
    expect([...stabilities].sort()).toEqual(['RC', 'alpha', 'beta', 'dev', 'stable']);
    expect([...versionStatuses].sort()).toEqual([
      'active',
      'quarantined',
      'removed_upstream',
      'tombstoned',
    ]);
    for (const [name, count] of Object.entries(counters)) {
      expect(count, name).toBeGreaterThan(0);
    }
  });

  it('14: refuses seeds that are not safe integers and keeps registered "*" rare', () => {
    expect(() => randomCatalogueConfig(1.5, 3)).toThrow(TypeError);
    expect(() => randomCatalogueConfig(Number.NaN, 3)).toThrow(TypeError);
    let stars = 0;
    let names = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const r of randomCatalogueConfig(seed, 6).registeredNames) {
        names += 1;
        if (r.pattern === '*') stars += 1;
      }
    }
    expect(stars / names).toBeLessThan(0.1);
  });
});
