import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { CatalogueSourceType } from '@package-broker/core/db/catalogue';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import { isValidPattern } from '@package-broker/core/catalogue/patterns';
import { withForeignKeysOff } from './foreign-keys-off.js';
import { deriveVisibility, type VisibilityConfig } from '@package-broker/core/catalogue/visibility';

export interface FixtureOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}
export interface FixtureProject {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
}
export interface FixtureSource {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly ecosystem: NameEcosystem;
  readonly type: CatalogueSourceType;
  readonly defaultVisible: 0 | 1;
  readonly removalPolicy: 'flag' | 'exclude';
}
export interface FixtureAttachment {
  readonly orgId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly precedence: number;
}
export interface FixturePattern {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly effect: 'include' | 'exclude';
}
export interface FixturePackage {
  readonly id: string;
  readonly orgId: string;
  readonly sourceId: string;
  readonly ecosystem: NameEcosystem;
  readonly key: string;
  readonly visible: 0 | 1;
  readonly status: 'active' | 'removed_upstream';
}
export interface FixtureExplicit {
  readonly orgId: string;
  readonly projectId: string;
  readonly packageId: string;
}
export interface FixtureRegisteredName {
  readonly id: string;
  readonly orgId: string;
  readonly sourceId: string;
  readonly ecosystem: NameEcosystem;
  readonly pattern: string;
}
export type FixtureVersionStatus = 'active' | 'removed_upstream' | 'quarantined' | 'tombstoned';
export type FixtureStability = 'dev' | 'alpha' | 'beta' | 'RC' | 'stable';
export interface FixtureVersion {
  readonly id: string;
  readonly orgId: string;
  readonly packageId: string;
  readonly version: string;
  readonly normalized: string;
  readonly stability: FixtureStability;
  readonly status: FixtureVersionStatus;
  readonly publishedAt: string;
}

export interface CatalogueConfig {
  readonly organizations: readonly FixtureOrganization[];
  readonly projects: readonly FixtureProject[];
  readonly sources: readonly FixtureSource[];
  readonly attachments: readonly FixtureAttachment[];
  readonly patterns: readonly FixturePattern[];
  readonly packages: readonly FixturePackage[];
  readonly explicit: readonly FixtureExplicit[];
  readonly registeredNames: readonly FixtureRegisteredName[];
  readonly versions: readonly FixtureVersion[];
}

const ORGANIZATIONS: readonly FixtureOrganization[] = [
  { id: '01J00000000000000000000A0A', slug: 'org-a', name: 'Organization A' },
  { id: '01J00000000000000000000B0B', slug: 'org-b', name: 'Organization B' },
];

const STATEMENTS_PER_BATCH = 200;
/** D1 allows 500 statements per invocation; seedCatalogue refuses a configuration that needs more unless told otherwise. */
export const D1_STATEMENTS_PER_INVOCATION = 500;
const FIXED_TIME = '2020-01-01T00:00:00.000Z';
const NON_PROXY_TYPES: Record<NameEcosystem, readonly CatalogueSourceType[]> = {
  composer: ['vcs', 'composer_repository', 'hosted'],
  npm: ['npm_registry', 'hosted'],
};
const STABILITIES: readonly FixtureStability[] = ['dev', 'alpha', 'beta', 'RC', 'stable'];
const VERSION_STATUSES: readonly FixtureVersionStatus[] = [
  'active',
  'active',
  'active',
  'removed_upstream',
  'quarantined',
  'tombstoned',
];
const ECOSYSTEMS: readonly NameEcosystem[] = ['composer', 'npm'];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function keyPool(ecosystem: NameEcosystem, size: number): string[] {
  const keys: string[] = [];
  for (let n = 0; n < size; n += 1) {
    keys.push(
      ecosystem === 'composer' ? `v${n % 3}/p${n}` : n % 2 === 1 ? `@s${n % 3}/p${n}` : `p${n}`,
    );
  }
  return keys;
}

export interface CatalogueOptions {
  /** Adds rows the oracle must exclude: foreign project-level attachments, explicit rows of unattached sources, rows whose org_id disagrees with the parent. */
  readonly forged?: boolean;
  /** Gives some packages 201 to 230 versions, enough to cross a 200-row page. */
  readonly longVersionLists?: boolean;
}

export function randomCatalogueConfig(
  seed: number,
  size: number,
  options: CatalogueOptions = {},
): CatalogueConfig {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('seed must be a safe integer');
  }
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError('size must be a positive integer');
  }
  const next = mulberry32(seed);
  const chance = (p: number): boolean => next() < p;
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const counters = new Map<string, number>();
  const id = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `01J${kind}${String(n).padStart(21, '0')}`;
  };
  const pools: Record<NameEcosystem, string[]> = {
    composer: keyPool('composer', size),
    npm: keyPool('npm', size),
  };

  const projects: FixtureProject[] = [];
  const sources: FixtureSource[] = [];
  const attachments: FixtureAttachment[] = [];
  const patterns: FixturePattern[] = [];
  const packages: FixturePackage[] = [];
  const explicit: FixtureExplicit[] = [];
  const registeredNames: FixtureRegisteredName[] = [];
  const versions: FixtureVersion[] = [];

  const publishedAt = (day: number, second: number): string =>
    new Date(Date.UTC(2020, 0, 1) + day * 86_400_000 + second * 1000).toISOString();

  const globFor = (key: string, starWeight: number): string => {
    if (chance(starWeight)) return '*';
    const choice = int(3);
    const slash = key.indexOf('/');
    if (choice === 0) return key;
    if (choice === 1) return slash > 0 ? `${key.slice(0, slash)}/*` : `${key.slice(0, 2)}*`;
    return `*${key.slice(-2)}`;
  };

  for (const org of ORGANIZATIONS) {
    const orgProjects: FixtureProject[] = [];
    for (let n = 0, count = 2 + int(3); n < count; n += 1) {
      const projectId = id('PR');
      const project: FixtureProject = {
        id: projectId,
        orgId: org.id,
        slug: `project-${projectId.slice(-6)}`,
        name: `Project ${projectId.slice(-6)}`,
        status: chance(0.25) ? 'archived' : 'active',
      };
      orgProjects.push(project);
      projects.push(project);
    }

    const makeSource = (
      ecosystem: NameEcosystem,
      type: CatalogueSourceType,
      projectId: string | null,
    ): FixtureSource => {
      const sourceId = id('SC');
      const source: FixtureSource = {
        id: sourceId,
        orgId: org.id,
        projectId,
        name: `source-${sourceId.slice(-6)}`,
        ecosystem,
        type,
        defaultVisible: chance(0.8) ? 1 : 0,
        removalPolicy: chance(0.5) ? 'flag' : 'exclude',
      };
      sources.push(source);
      return source;
    };
    const orgSources: FixtureSource[] = [
      makeSource('composer', 'packagist_proxy', null),
      makeSource('npm', 'npmjs_proxy', null),
    ];
    if (chance(0.5)) orgSources.push(makeSource('composer', 'packagist_proxy', null));
    if (chance(0.5)) orgSources.push(makeSource('npm', 'npmjs_proxy', null));
    for (let n = 0, count = 1 + int(3); n < count; n += 1) {
      const ecosystem = pick(ECOSYSTEMS);
      orgSources.push(makeSource(ecosystem, pick(NON_PROXY_TYPES[ecosystem]), null));
    }
    for (const project of orgProjects) {
      if (chance(0.5)) {
        const ecosystem = pick(ECOSYSTEMS);
        orgSources.push(makeSource(ecosystem, pick(NON_PROXY_TYPES[ecosystem]), project.id));
      }
    }

    const orgPackages: FixturePackage[] = [];
    for (const source of orgSources) {
      for (const key of pools[source.ecosystem]) {
        if (!chance(0.5)) continue;
        const pkg: FixturePackage = {
          id: id('PK'),
          orgId: org.id,
          sourceId: source.id,
          ecosystem: source.ecosystem,
          key,
          visible: chance(0.7) ? 1 : 0,
          status: chance(0.2) ? 'removed_upstream' : 'active',
        };
        orgPackages.push(pkg);
        for (let v = 1, count = 1 + int(3); v <= count; v += 1) {
          const stability = pick(STABILITIES);
          const suffix = stability === 'stable' ? '' : `-${stability}1`;
          versions.push({
            id: id('VE'),
            orgId: org.id,
            packageId: pkg.id,
            version: `${v}.0.0${suffix}`,
            normalized:
              source.ecosystem === 'composer' ? `${v}.0.0.0${suffix}` : `${v}.0.0${suffix}`,
            stability,
            status: pick(VERSION_STATUSES),
            publishedAt: publishedAt(v, int(86_400)),
          });
        }
      }
    }
    packages.push(...orgPackages);

    for (const project of orgProjects) {
      for (const source of orgSources) {
        if (source.projectId !== null && source.projectId !== project.id) continue;
        if (!chance(0.7)) continue;
        attachments.push({
          orgId: org.id,
          projectId: project.id,
          sourceId: source.id,
          precedence: int(4),
        });
        const used = new Set<string>();
        for (let n = 0, count = chance(0.5) ? 1 + int(2) : 0; n < count; n += 1) {
          const pattern = globFor(pick(pools[source.ecosystem]), 0.15);
          if (used.has(pattern) || !isValidPattern(pattern)) continue;
          used.add(pattern);
          patterns.push({
            id: id('PP'),
            orgId: org.id,
            projectId: project.id,
            sourceId: source.id,
            pattern,
            effect: chance(0.6) ? 'include' : 'exclude',
          });
        }
        for (const pkg of orgPackages) {
          if (pkg.sourceId === source.id && chance(0.1)) {
            explicit.push({ orgId: org.id, projectId: project.id, packageId: pkg.id });
          }
        }
      }
    }

    const owners = orgSources.filter((s) => !s.type.endsWith('_proxy'));
    const usedNames = new Set<string>();
    for (let n = 0, count = int(3); n < count && owners.length > 0; n += 1) {
      const owner = pick(owners);
      const pattern = globFor(pick(pools[owner.ecosystem]), 0.03);
      const identity = `${owner.ecosystem}\0${pattern}`;
      if (usedNames.has(identity) || !isValidPattern(pattern)) continue;
      usedNames.add(identity);
      registeredNames.push({
        id: id('RN'),
        orgId: org.id,
        sourceId: owner.id,
        ecosystem: owner.ecosystem,
        pattern,
      });
    }
  }

  const extra = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const extraChance = (p: number): boolean => extra() < p;
  const extraInt = (n: number): number => Math.floor(extra() * n);

  if (options.longVersionLists === true) {
    for (const pkg of [...packages]) {
      if (!extraChance(0.15)) continue;
      const have = versions.filter((v) => v.packageId === pkg.id).length;
      const total = 201 + extraInt(30);
      for (let v = have + 1; v <= total; v += 1) {
        versions.push({
          id: id('VE'),
          orgId: pkg.orgId,
          packageId: pkg.id,
          version: `${v}.0.0`,
          normalized: pkg.ecosystem === 'composer' ? `${v}.0.0.0` : `${v}.0.0`,
          stability: 'stable',
          status: 'active',
          publishedAt: publishedAt(v, extraInt(86_400)),
        });
      }
    }
  }

  if (options.forged === true) {
    const attachedPairs = new Set(attachments.map((a) => `${a.projectId}\0${a.sourceId}`));
    const explicitPairs = new Set(explicit.map((e) => `${e.projectId}\0${e.packageId}`));
    for (const project of projects) {
      const otherOrg = ORGANIZATIONS.find((o) => o.id !== project.orgId) as FixtureOrganization;
      for (const source of sources) {
        const pair = `${project.id}\0${source.id}`;
        if (attachedPairs.has(pair)) continue;
        const foreignOwner = source.projectId !== null && source.projectId !== project.id;
        if (source.orgId === project.orgId && foreignOwner && extraChance(0.6)) {
          attachments.push({
            orgId: project.orgId,
            projectId: project.id,
            sourceId: source.id,
            precedence: 0,
          });
          attachedPairs.add(pair);
        } else if (source.orgId === project.orgId && !foreignOwner && extraChance(0.15)) {
          attachments.push({
            orgId: otherOrg.id,
            projectId: project.id,
            sourceId: source.id,
            precedence: 1,
          });
          attachedPairs.add(pair);
        }
      }
    }
    const validAttached = new Set(
      attachments
        .filter((a) => projects.find((p) => p.id === a.projectId)?.orgId === a.orgId)
        .map((a) => `${a.projectId}\0${a.sourceId}`),
    );
    for (const project of projects) {
      const otherOrg = ORGANIZATIONS.find((o) => o.id !== project.orgId) as FixtureOrganization;
      for (const pkg of packages) {
        if (pkg.orgId !== project.orgId) continue;
        const slot = `${project.id}\0${pkg.id}`;
        if (explicitPairs.has(slot)) continue;
        if (!validAttached.has(`${project.id}\0${pkg.sourceId}`)) {
          if (extraChance(0.04)) {
            explicit.push({ orgId: project.orgId, projectId: project.id, packageId: pkg.id });
            explicitPairs.add(slot);
          }
        } else if (extraChance(0.04)) {
          explicit.push({ orgId: otherOrg.id, projectId: project.id, packageId: pkg.id });
          explicitPairs.add(slot);
        }
      }
    }
  }

  const config: CatalogueConfig = {
    organizations: ORGANIZATIONS,
    projects,
    sources,
    attachments,
    patterns,
    packages,
    explicit,
    registeredNames,
    versions,
  };
  if (options.forged !== true) return config;
  const derivedSlots = new Set(
    deriveVisibility(toVisibilityInputs(config))
      .filter((r) => r.origin !== 'explicit')
      .map((r) => `${r.projectId}\0${r.packageId}`),
  );
  const projectOrg = new Map(projects.map((p) => [p.id, p.orgId]));
  return {
    ...config,
    explicit: explicit.filter(
      (e) =>
        projectOrg.get(e.projectId) === e.orgId ||
        !derivedSlots.has(`${e.projectId}\0${e.packageId}`),
    ),
  };
}

function statements(config: CatalogueConfig): ScalarStatement[] {
  const out: ScalarStatement[] = [
    { sql: 'DROP INDEX IF EXISTS organization_singleton', params: [] },
  ];
  const add = (sql: string, params: ScalarStatement['params']): void => {
    out.push({ sql, params });
  };
  for (const o of config.organizations) {
    add('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', [
      o.id,
      o.slug,
      o.name,
    ]);
    add(
      'INSERT INTO cache_epoch (org_id, version) VALUES (?, hex(randomblob(16))) ON CONFLICT (org_id) DO NOTHING',
      [o.id],
    );
  }
  for (const p of config.projects) {
    add('INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)', [
      p.id,
      p.orgId,
      p.slug,
      p.name,
      p.status,
    ]);
  }
  for (const s of config.sources) {
    add(
      `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, default_visible_to_new_projects, removal_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.orgId, s.projectId, s.name, s.ecosystem, s.type, s.defaultVisible, s.removalPolicy],
    );
  }
  for (const a of config.attachments) {
    add(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
      [a.orgId, a.projectId, a.sourceId, a.precedence],
    );
  }
  for (const p of config.patterns) {
    add(
      'INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, ?)',
      [p.id, p.orgId, p.projectId, p.sourceId, p.pattern, p.effect],
    );
  }
  for (const p of config.packages) {
    add(
      `INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects, status, removed_upstream_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.id,
        p.orgId,
        p.sourceId,
        p.ecosystem,
        p.key,
        p.visible,
        p.status,
        p.status === 'removed_upstream' ? FIXED_TIME : null,
      ],
    );
  }
  for (const r of config.registeredNames) {
    add(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      [r.id, r.orgId, r.sourceId, r.ecosystem, r.pattern],
    );
  }
  for (const v of config.versions) {
    add(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at,
                            published_at_basis, metadata_json, status, removed_upstream_at, tombstoned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'import_time', '{}', ?, ?, ?)`,
      [
        v.id,
        v.orgId,
        v.packageId,
        v.version,
        v.normalized,
        v.stability,
        v.publishedAt,
        v.status,
        v.status === 'removed_upstream' ? FIXED_TIME : null,
        v.status === 'tombstoned' ? FIXED_TIME : null,
      ],
    );
  }
  for (const e of config.explicit) {
    add(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
      [e.orgId, e.projectId, e.packageId],
    );
  }
  return out;
}

export function catalogueStatementCount(config: CatalogueConfig): number {
  return statements(config).length;
}

export interface SeedOptions {
  /** Defaults to the D1 invocation budget; pass Infinity for Node-only tests. */
  readonly maxStatements?: number;
}

/**
 * Inserts directly, bypassing the writers, in batches of at most 200 statements. Works on a fresh
 * migrated database or on top of seedTwoOrganizations: it drops the organization_singleton index
 * so a second organization can be inserted. Refuses a configuration that needs more than
 * maxStatements (500 by default, the D1 per-invocation budget); randomCatalogueConfig(seed, size)
 * stays within it for size 12 or less (seeds 1 to 200, no options); larger configurations need { maxStatements: Infinity }.
 */
export async function seedCatalogue(
  executor: ScalarSqlExecutor,
  config: CatalogueConfig,
  options: SeedOptions = {},
): Promise<void> {
  const all = statements(config);
  const limit = options.maxStatements ?? D1_STATEMENTS_PER_INVOCATION;
  if (all.length > limit) {
    throw new RangeError(
      `the configuration needs ${all.length} statements, the budget is ${limit}`,
    );
  }
  const insert = async (): Promise<void> => {
    for (let at = 0; at < all.length; at += STATEMENTS_PER_BATCH) {
      await executor.batch(all.slice(at, at + STATEMENTS_PER_BATCH));
    }
  };
  if (hasCrossOrgRows(config)) await withForeignKeysOff(executor, insert);
  else await insert();
}

function hasCrossOrgRows(config: CatalogueConfig): boolean {
  const orgOf = (rows: readonly { id: string; orgId: string }[]): Map<string, string> =>
    new Map(rows.map((r) => [r.id, r.orgId]));
  const projects = orgOf(config.projects);
  const sources = orgOf(config.sources);
  const packages = orgOf(config.packages);
  const organizations = new Set(config.organizations.map((o) => o.id));
  let crossOrg = false;
  const check = (parents: Map<string, string>, id: string, orgId: string): void => {
    const parentOrg = parents.get(id);
    if (parentOrg === undefined) throw new RangeError('missing parent in catalogue configuration');
    if (parentOrg !== orgId) crossOrg = true;
  };
  for (const row of [
    ...config.projects,
    ...config.sources,
    ...config.attachments,
    ...config.patterns,
    ...config.packages,
    ...config.explicit,
    ...config.registeredNames,
    ...config.versions,
  ]) {
    if (!organizations.has(row.orgId)) {
      throw new RangeError('missing parent organization in catalogue configuration');
    }
  }
  for (const s of config.sources) {
    if (s.projectId !== null) check(projects, s.projectId, s.orgId);
  }
  for (const a of config.attachments) {
    check(projects, a.projectId, a.orgId);
    check(sources, a.sourceId, a.orgId);
  }
  for (const p of config.patterns) {
    check(projects, p.projectId, p.orgId);
    check(sources, p.sourceId, p.orgId);
  }
  for (const p of config.packages) check(sources, p.sourceId, p.orgId);
  for (const e of config.explicit) {
    check(projects, e.projectId, e.orgId);
    check(packages, e.packageId, e.orgId);
  }
  for (const r of config.registeredNames) check(sources, r.sourceId, r.orgId);
  for (const v of config.versions) check(packages, v.packageId, v.orgId);
  return crossOrg;
}

/** Inserts the oracle's non-explicit rows; explicit rows are already written by seedCatalogue. Fixtures only: production writes derived rows through T314. */
export async function seedDerivedRows(
  executor: ScalarSqlExecutor,
  config: CatalogueConfig,
): Promise<void> {
  const orgOf = new Map(config.packages.map((p) => [p.id, p.orgId]));
  const rows = deriveVisibility(toVisibilityInputs(config)).filter((r) => r.origin !== 'explicit');
  const held = new Set(config.explicit.map((e) => `${e.projectId}\0${e.packageId}`));
  const clash = rows.find((r) => held.has(`${r.projectId}\0${r.packageId}`));
  if (clash !== undefined) {
    throw new RangeError(
      `an explicit row already holds project ${clash.projectId}, package ${clash.packageId}`,
    );
  }
  const all: ScalarStatement[] = rows.map((r) => ({
    sql: 'INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, ?)',
    params: [orgOf.get(r.packageId) as string, r.projectId, r.packageId, r.origin],
  }));
  for (let at = 0; at < all.length; at += STATEMENTS_PER_BATCH) {
    await executor.batch(all.slice(at, at + STATEMENTS_PER_BATCH));
  }
}

export function toVisibilityInputs(config: CatalogueConfig): VisibilityConfig {
  const projectOrg = new Map(config.projects.map((p) => [p.id, p.orgId]));
  const sourceOrg = new Map(config.sources.map((s) => [s.id, s.orgId]));
  const packageOrg = new Map(config.packages.map((p) => [p.id, p.orgId]));
  const attachments = config.attachments.filter(
    (a) => projectOrg.get(a.projectId) === a.orgId && sourceOrg.get(a.sourceId) === a.orgId,
  );
  const explicit = config.explicit.filter(
    (e) => projectOrg.get(e.projectId) === e.orgId && packageOrg.get(e.packageId) === e.orgId,
  );
  return {
    projects: config.projects.map((p) => ({
      id: p.id,
      orgId: p.orgId,
      active: p.status === 'active',
    })),
    sources: config.sources.map((s) => ({
      id: s.id,
      orgId: s.orgId,
      ecosystem: s.ecosystem,
      type: s.type,
      ownerProjectId: s.projectId,
      removalPolicy: s.removalPolicy,
      defaultVisible: s.defaultVisible,
    })),
    packages: config.packages.map((p) => ({
      id: p.id,
      orgId: p.orgId,
      sourceId: p.sourceId,
      ecosystem: p.ecosystem,
      key: p.key,
      status: p.status,
      visible: p.visible,
    })),
    attachments: attachments.map((a) => {
      const own = config.patterns.filter(
        (p) => p.projectId === a.projectId && p.sourceId === a.sourceId,
      );
      return {
        projectId: a.projectId,
        sourceId: a.sourceId,
        precedence: a.precedence,
        includes: own.filter((p) => p.effect === 'include').map((p) => p.pattern),
        excludes: own.filter((p) => p.effect === 'exclude').map((p) => p.pattern),
      };
    }),
    explicit: explicit.map((e) => ({ projectId: e.projectId, packageId: e.packageId })),
    registeredNames: config.registeredNames.map((r) => ({
      orgId: r.orgId,
      ecosystem: r.ecosystem,
      pattern: r.pattern,
    })),
  };
}
