import { describe, expect, it } from 'vitest';
import {
  admitProxy,
  rankCandidates,
  resolveWinner,
  type VisibilityConfig,
} from '@package-broker/core/catalogue/visibility';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import {
  CATALOGUE_KEY_LIST_MAX,
  CATALOGUE_PAGE_MAX,
  CATALOGUE_WINNER_KEYS_MAX,
  type EdgeCursor,
  type EdgeRow,
  type KeyClass,
} from '@package-broker/core/db/catalogue';
import {
  orgContext,
  type ScalarSqlExecutor,
  type ScalarStatement,
} from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import {
  randomCatalogueConfig,
  seedCatalogue,
  seedDerivedRows,
  toVisibilityInputs,
  type CatalogueConfig,
  type FixtureSource,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { createClosureEdges } from './closure-edges.js';

const ECOSYSTEMS: readonly NameEcosystem[] = ['composer', 'npm'];
const ORG_A = '01J00000000000000000000A0A';
const ORG_B = '01J00000000000000000000B0B';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function metadataFor(ecosystem: NameEcosystem, n: number): string | null {
  if (n % 3 === 0) return null;
  if (ecosystem === 'composer') {
    return JSON.stringify({
      name: 'x/y',
      description: 'z'.repeat(50),
      require: { php: '>=8.1', [`dep/n${n}`]: '^1.0' },
      'require-dev': { 'dev/only': '*' },
    });
  }
  return JSON.stringify({
    name: 'x',
    dependencies: { [`d${n}`]: '^1' },
    peerDependencies: { peer: '*' },
    peerDependenciesMeta: { peer: { optional: true } },
    devDependencies: { 'dev-only': '*' },
  });
}

function expectedDeps(ecosystem: NameEcosystem, n: number): unknown {
  const raw = metadataFor(ecosystem, n);
  if (raw === null) return null;
  const meta = JSON.parse(raw) as Record<string, unknown>;
  if (ecosystem === 'composer') return meta['require'];
  return {
    dependencies: meta['dependencies'] ?? null,
    optionalDependencies: meta['optionalDependencies'] ?? null,
    peerDependencies: meta['peerDependencies'] ?? null,
    peerDependenciesMeta: meta['peerDependenciesMeta'] ?? null,
  };
}

async function seedMetadata(executor: ScalarSqlExecutor, config: CatalogueConfig) {
  const ecosystemOf = new Map(config.packages.map((p) => [p.id, p.ecosystem]));
  const statements: ScalarStatement[] = [];
  config.versions.forEach((v, n) => {
    const metadata = metadataFor(ecosystemOf.get(v.packageId) as NameEcosystem, n);
    if (metadata !== null) {
      statements.push({
        sql: 'UPDATE version SET metadata_json = ? WHERE id = ?',
        params: [metadata, v.id],
      });
    }
  });
  for (let at = 0; at < statements.length; at += 200) {
    await executor.batch(statements.slice(at, at + 200));
  }
}

interface ExpectedEdge {
  requirerKey: string;
  versionId: string;
  version: string;
  deps: unknown;
}

function expectedEdges(
  config: CatalogueConfig,
  inputs: VisibilityConfig,
  projectId: string,
  ecosystem: NameEcosystem,
): ExpectedEdge[] {
  const indexOf = new Map(config.versions.map((v, n) => [v.id, n]));
  const keys = [
    ...new Set(config.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.key)),
  ].sort(compare);
  const edges: ExpectedEdge[] = [];
  for (const key of keys) {
    const winner = resolveWinner(inputs, projectId, ecosystem, key);
    if (winner === null) continue;
    const source = config.sources.find((s) => s.id === winner.sourceId) as FixtureSource;
    for (const v of config.versions.filter((x) => x.packageId === winner.packageId)) {
      const qualifies =
        v.status === 'active' ||
        (v.status === 'removed_upstream' && source.removalPolicy === 'flag');
      if (qualifies) {
        edges.push({
          requirerKey: key,
          versionId: v.id,
          version: v.version,
          deps: expectedDeps(ecosystem, indexOf.get(v.id) as number),
        });
      }
    }
  }
  return edges.sort(
    (a, b) => compare(a.requirerKey, b.requirerKey) || compare(a.versionId, b.versionId),
  );
}

function parsed(row: EdgeRow): ExpectedEdge {
  return {
    requirerKey: row.requirerKey,
    versionId: row.versionId,
    version: row.version,
    deps: row.deps === null ? null : (JSON.parse(row.deps) as unknown),
  };
}

describe('pageEdges against the oracle', () => {
  it('1: pages cover exactly the visible winners qualifying versions, one executor.all per page', async () => {
    let edges = 0;
    let withDeps = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const config = randomCatalogueConfig(seed, 6, { forged: seed % 2 === 0 });
      const database = await openMigratedDatabase({ d1PatternLimit: true });
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(database.executor, config);
        await seedMetadata(database.executor, config);
        const inputs = toVisibilityInputs(config);
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const ecosystem of ECOSYSTEMS) {
            const expected = expectedEdges(config, inputs, project.id, ecosystem);
            for (const limit of [1 + (seed % 4), CATALOGUE_PAGE_MAX]) {
              const counted = countCalls(database.executor);
              const closure = createClosureEdges(counted.executor);
              const actual: ExpectedEdge[] = [];
              let after: EdgeCursor | undefined;
              let pages = 0;
              do {
                const page = await closure.pageEdges(ctx, {
                  projectId: project.id,
                  ecosystem,
                  limit,
                  ...(after === undefined ? {} : { after }),
                });
                pages += 1;
                expect(page.rows.length).toBeLessThanOrEqual(limit);
                actual.push(...page.rows.map(parsed));
                after = page.next ?? undefined;
              } while (after !== undefined);
              expect(actual, `${seed} ${project.id} ${ecosystem} ${limit}`).toEqual(expected);
              expect(counted.counts()).toEqual({ all: pages, batch: 0 });
            }
            edges += expected.length;
            withDeps += expected.filter((e) => e.deps !== null).length;
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(edges).toBeGreaterThan(300);
    expect(withDeps).toBeGreaterThan(150);
  }, 180_000);

  it('rejects a limit outside 1..200', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const closure = createClosureEdges(database.executor);
      const ctx = orgContext(ORG_A);
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        await expect(
          closure.pageEdges(ctx, { projectId: 'p', ecosystem: 'npm', limit }),
        ).rejects.toThrow(TypeError);
      }
    } finally {
      await database.close();
    }
  });

  it('3: no statement selects metadata_json whole', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const seen: string[] = [];
      const recording: ScalarSqlExecutor = {
        ...database.executor,
        all: async (statement) => {
          seen.push(statement.sql);
          return database.executor.all(statement);
        },
        batch: (statements) => database.executor.batch(statements),
      };
      const closure = createClosureEdges(recording);
      const ctx = orgContext(ORG_A);
      const base = { projectId: 'p', ecosystem: 'npm' as const };
      await closure.pageEdges(ctx, { ...base, limit: 5 });
      await closure.pageEdges(ctx, { ...base, ecosystem: 'composer', limit: 5 });
      await closure.classify(ctx, { ...base, keys: ['a'] });
      await closure.classifyWinners(ctx, { ...base, keys: ['a'] });
      await closure.previewWinners(ctx, { ...base, key: 'a' });
      expect(seen.length).toBe(5);
      for (const text of seen) {
        const stripped = text.replace(/json_extract\(v\.metadata_json, (\?|'[^']*')\)/g, '');
        expect(stripped).not.toContain('metadata_json');
      }
      expect(seen.some((text) => text.includes('metadata_json'))).toBe(true);
    } finally {
      await database.close();
    }
  });
});

describe('classify, classifyWinners and previewWinners against the oracle', () => {
  it('2: classify equals admission, then org-level holding, then not_available', async () => {
    const seen = new Set<KeyClass>();
    for (let seed = 1; seed <= 80; seed += 1) {
      const config = randomCatalogueConfig(seed, 6, { forged: seed % 2 === 0 });
      const database = await openMigratedDatabase({ d1PatternLimit: true });
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(database.executor, config);
        const inputs = toVisibilityInputs(config);
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const ecosystem of ECOSYSTEMS) {
            const keys = [
              ...new Set(
                config.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.key),
              ),
              ecosystem === 'npm' ? 'unseen' : 'unseen/name',
            ];
            const expected = keys.map((key) => {
              let cls: KeyClass = 'not_available';
              if (admitProxy(inputs, project.id, ecosystem, key).length > 0) {
                cls = 'proxy_admissible';
              } else if (
                project.status === 'active' &&
                config.packages.some(
                  (p) =>
                    p.orgId === project.orgId &&
                    p.ecosystem === ecosystem &&
                    p.key === key &&
                    config.sources.some(
                      (s) =>
                        s.id === p.sourceId &&
                        s.orgId === project.orgId &&
                        s.projectId === null &&
                        s.type !== 'packagist_proxy' &&
                        s.type !== 'npmjs_proxy' &&
                        (p.status === 'active' || s.removalPolicy === 'flag'),
                    ),
                )
              ) {
                cls = 'attachable';
              }
              seen.add(cls);
              return { key, class: cls };
            });
            const counted = countCalls(database.executor);
            const actual = await createClosureEdges(counted.executor).classify(ctx, {
              projectId: project.id,
              ecosystem,
              keys,
            });
            expect(actual, `${seed} ${project.id} ${ecosystem}`).toEqual(expected);
            expect(counted.counts()).toEqual({ all: 1, batch: 0 });
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(seen).toEqual(new Set(['proxy_admissible', 'attachable', 'not_available']));
  }, 180_000);

  it('classifyWinners equals resolveWinner and previewWinners equals rankCandidates', async () => {
    let ranked = 0;
    let multi = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      const config = randomCatalogueConfig(seed, 6, { forged: seed % 2 === 0 });
      const database = await openMigratedDatabase({ d1PatternLimit: true });
      try {
        await seedCatalogue(database.executor, config, { maxStatements: Infinity });
        await seedDerivedRows(database.executor, config);
        const inputs = toVisibilityInputs(config);
        const sourceType = new Map(config.sources.map((s) => [s.id, s.type]));
        const closure = createClosureEdges(database.executor);
        for (const project of config.projects) {
          const ctx = orgContext(project.orgId);
          for (const ecosystem of ECOSYSTEMS) {
            const keys = [
              ...new Set(
                config.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.key),
              ),
              'unseen',
            ];
            const expected = keys.map((key) => {
              const winner = resolveWinner(inputs, project.id, ecosystem, key);
              return {
                key,
                winner:
                  winner === null
                    ? null
                    : {
                        sourceId: winner.sourceId,
                        sourceType: sourceType.get(winner.sourceId),
                      },
              };
            });
            expect(
              await closure.classifyWinners(ctx, { projectId: project.id, ecosystem, keys }),
              `${seed} ${project.id} ${ecosystem}`,
            ).toEqual(expected);
            for (const key of keys) {
              const want = rankCandidates(inputs, project.id, ecosystem, key);
              const got = await closure.previewWinners(ctx, {
                projectId: project.id,
                ecosystem,
                key,
              });
              expect(got, `${seed} ${project.id} ${ecosystem} ${key}`).toEqual(want);
              expect(want.find((c) => c.eligible)?.sourceId ?? null).toBe(
                resolveWinner(inputs, project.id, ecosystem, key)?.sourceId ?? null,
              );
              ranked += want.length;
              if (want.length > 1) multi += 1;
            }
          }
        }
      } finally {
        await database.close();
      }
    }
    expect(ranked).toBeGreaterThan(300);
    expect(multi).toBeGreaterThan(20);
  }, 180_000);

  it('rejects oversized and malformed key lists', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const closure = createClosureEdges(database.executor);
      const ctx = orgContext(ORG_A);
      const base = { projectId: 'p', ecosystem: 'npm' as const };
      const many = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
      await expect(
        closure.classify(ctx, { ...base, keys: many(CATALOGUE_KEY_LIST_MAX + 1) }),
      ).rejects.toThrow(TypeError);
      await expect(
        closure.classifyWinners(ctx, { ...base, keys: many(CATALOGUE_WINNER_KEYS_MAX + 1) }),
      ).rejects.toThrow(TypeError);
      await expect(
        closure.classify(ctx, { ...base, keys: [1 as unknown as string] }),
      ).rejects.toThrow(TypeError);
      expect(
        await closure.classify(ctx, { ...base, keys: many(CATALOGUE_KEY_LIST_MAX) }),
      ).toHaveLength(CATALOGUE_KEY_LIST_MAX);
      expect(await closure.classify(ctx, { ...base, keys: [] })).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

const P1 = '01JPR000000000000000000001';
const PB = '01JPR000000000000000000002';
const PROXY = '01JSC000000000000000000001';
const ORG_SRC = '01JSC000000000000000000002';
const PB_PRIVATE = '01JSC000000000000000000003';
const OTHER_ORG_SRC = '01JSC000000000000000000004';

function composerSource(
  id: string,
  orgId: string,
  type: FixtureSource['type'],
  projectId: string | null,
) {
  const source: FixtureSource = {
    id,
    orgId,
    projectId,
    name: `source-${id.slice(-4)}`,
    ecosystem: 'composer',
    type,
    defaultVisible: 1,
    removalPolicy: 'flag',
  };
  return source;
}

const pkg = (n: number, orgId: string, sourceId: string, key: string) => ({
  id: `01JPK00000000000000000000${n}`,
  orgId,
  sourceId,
  ecosystem: 'composer' as const,
  key,
  visible: 1 as const,
  status: 'active' as const,
});

const NEGATIVE: CatalogueConfig = {
  organizations: [
    { id: ORG_A, slug: 'org-a', name: 'Organization A' },
    { id: ORG_B, slug: 'org-b', name: 'Organization B' },
  ],
  projects: [
    { id: P1, orgId: ORG_A, slug: 'p1', name: 'P1', status: 'active' },
    { id: PB, orgId: ORG_A, slug: 'pb', name: 'PB', status: 'active' },
  ],
  sources: [
    composerSource(PROXY, ORG_A, 'packagist_proxy', null),
    composerSource(ORG_SRC, ORG_A, 'vcs', null),
    composerSource(PB_PRIVATE, ORG_A, 'vcs', PB),
    composerSource(OTHER_ORG_SRC, ORG_B, 'vcs', null),
  ],
  attachments: [
    { orgId: ORG_A, projectId: P1, sourceId: PROXY, precedence: 1000 },
    { orgId: ORG_A, projectId: PB, sourceId: PB_PRIVATE, precedence: 100 },
  ],
  patterns: [],
  packages: [
    pkg(1, ORG_A, PB_PRIVATE, 'secret/only-b'),
    pkg(2, ORG_A, ORG_SRC, 'acme/org-held'),
    pkg(3, ORG_B, OTHER_ORG_SRC, 'other/org'),
  ],
  explicit: [],
  registeredNames: [
    {
      id: '01JRN000000000000000000001',
      orgId: ORG_A,
      sourceId: ORG_SRC,
      ecosystem: 'composer',
      pattern: 'acme/reg-*',
    },
  ],
  versions: [],
};

describe('classify refusals', () => {
  async function classify(keys: string[], projectId = P1, orgId = ORG_A) {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      await seedCatalogue(database.executor, NEGATIVE);
      return await createClosureEdges(database.executor).classify(orgContext(orgId), {
        projectId,
        ecosystem: 'composer',
        keys,
      });
    } finally {
      await database.close();
    }
  }

  it("2: a key held only by project B's project-level source is not_available for A", async () => {
    expect(await classify(['secret/only-b'])).toEqual([
      { key: 'secret/only-b', class: 'not_available' },
    ]);
  });

  it('2: held, registered and unseen keys', async () => {
    expect(await classify(['acme/org-held', 'acme/reg-1', 'vendor/free', 'other/org'])).toEqual([
      { key: 'acme/org-held', class: 'attachable' },
      { key: 'acme/reg-1', class: 'not_available' },
      { key: 'vendor/free', class: 'proxy_admissible' },
      { key: 'other/org', class: 'proxy_admissible' },
    ]);
  });

  it('returns not_available for every key when the project belongs to another organization', async () => {
    expect(await classify(['vendor/free', 'acme/org-held', 'other/org'], P1, ORG_B)).toEqual([
      { key: 'vendor/free', class: 'not_available' },
      { key: 'acme/org-held', class: 'not_available' },
      { key: 'other/org', class: 'not_available' },
    ]);
  });
});

describe('closure read regressions', () => {
  it('guards attachability for a missing project', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      await seedCatalogue(database.executor, NEGATIVE);
      expect(
        await createClosureEdges(database.executor).classify(orgContext(ORG_A), {
          projectId: 'missing',
          ecosystem: 'composer',
          keys: ['acme/org-held'],
        }),
      ).toEqual([{ key: 'acme/org-held', class: 'not_available' }]);
    } finally {
      await database.close();
    }
  });

  it('excludes proxy holders and upstream removals under exclude from attachability', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const config: CatalogueConfig = {
        ...NEGATIVE,
        attachments: [],
        sources: NEGATIVE.sources.map((s) =>
          s.id === ORG_SRC ? { ...s, removalPolicy: 'exclude' } : s,
        ),
        packages: [
          ...NEGATIVE.packages,
          pkg(4, ORG_A, PROXY, 'proxy/cached'),
          { ...pkg(5, ORG_A, ORG_SRC, 'removed/excluded'), status: 'removed_upstream' },
          { ...pkg(6, ORG_A, PB_PRIVATE, 'removed/private'), status: 'removed_upstream' },
        ],
      };
      await seedCatalogue(database.executor, config);
      const keys = ['proxy/cached', 'removed/excluded', 'removed/private', 'acme/org-held'];
      expect(
        await createClosureEdges(database.executor).classify(orgContext(ORG_A), {
          projectId: P1,
          ecosystem: 'composer',
          keys,
        }),
      ).toEqual(
        keys.map((key) => ({
          key,
          class: key === 'acme/org-held' ? 'attachable' : 'not_available',
        })),
      );
    } finally {
      await database.close();
    }
  });

  it('binds each key list once and preserves duplicate and non-round-tripping keys by position', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      await seedCatalogue(database.executor, NEGATIVE);
      await seedDerivedRows(database.executor, NEGATIVE);
      const statements: ScalarStatement[] = [];
      const closure = createClosureEdges({
        ...database.executor,
        all: async (statement) => {
          statements.push(statement);
          return database.executor.all(statement);
        },
        batch: (statements) => database.executor.batch(statements),
      });
      const keys = ['acme/org-held', 'secret/only-b', 'acme/org-held', '\ud800'];
      const query = { projectId: PB, ecosystem: 'composer' as const, keys };
      const classes = await closure.classify(orgContext(ORG_A), query);
      const winners = await closure.classifyWinners(orgContext(ORG_A), query);
      expect(classes.map((row) => row.key)).toEqual(keys);
      expect(winners.map((row) => row.key)).toEqual(keys);
      expect(classes[0]).toEqual(classes[2]);
      expect(winners[0]).toEqual(winners[2]);
      expect(winners[1]?.winner?.sourceId).toBe(PB_PRIVATE);
      for (const statement of statements) {
        expect(statement.params.filter((value) => value === JSON.stringify(keys))).toHaveLength(1);
      }
    } finally {
      await database.close();
    }
  });

  it('scopes all winner and edge reads to the project organization', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      await seedCatalogue(database.executor, NEGATIVE);
      await seedDerivedRows(database.executor, NEGATIVE);
      const closure = createClosureEdges(database.executor);
      const ctx = orgContext(ORG_B);
      const query = { projectId: PB, ecosystem: 'composer' as const };
      expect(await closure.pageEdges(ctx, { ...query, limit: 2 })).toEqual({
        rows: [],
        next: null,
      });
      expect(await closure.classifyWinners(ctx, { ...query, keys: ['secret/only-b'] })).toEqual([
        { key: 'secret/only-b', winner: null },
      ]);
      expect(await closure.previewWinners(ctx, { ...query, key: 'secret/only-b' })).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('rejects cursors with non-string fields', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const closure = createClosureEdges(database.executor);
      for (const after of [
        { requirerKey: 1, versionId: 'v' },
        { requirerKey: 'k', versionId: null },
      ]) {
        await expect(
          closure.pageEdges(orgContext(ORG_A), {
            projectId: P1,
            ecosystem: 'composer',
            limit: 2,
            after: after as unknown as EdgeCursor,
          }),
        ).rejects.toThrow(TypeError);
      }
    } finally {
      await database.close();
    }
  });
});

function edgeConfig(): CatalogueConfig {
  const packages = Array.from({ length: 24 }, (_, n) =>
    pkg(n + 10, ORG_A, ORG_SRC, `edge/p${String(n).padStart(2, '0')}`),
  );
  return {
    ...NEGATIVE,
    sources: NEGATIVE.sources.map((s) =>
      s.id === ORG_SRC ? { ...s, removalPolicy: 'exclude' } : s,
    ),
    attachments: [{ orgId: ORG_A, projectId: P1, sourceId: ORG_SRC, precedence: 1 }],
    packages,
    versions: packages.flatMap((p, n) =>
      Array.from({ length: n === 0 ? 8 : n === 1 ? 0 : 1 }, (_, v) => ({
        id: `01JVE${String(n * 10 + v).padStart(21, '0')}`,
        orgId: ORG_A,
        packageId: p.id,
        version: `${v + 1}.0.0`,
        normalized: `${v + 1}.0.0.0`,
        stability: 'stable' as const,
        status: 'active' as const,
        publishedAt: '2026-01-01T00:00:00.000Z',
      })),
    ),
  };
}

describe('bounded edge pages', () => {
  it('bounds winner ranking and version reads to the key page before extracting deps', async () => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    try {
      const config = edgeConfig();
      await seedCatalogue(database.executor, config);
      await seedDerivedRows(database.executor, config);
      let statement: ScalarStatement | undefined;
      const closure = createClosureEdges({
        ...database.executor,
        all: async (query) => {
          statement = query;
          return database.executor.all(query);
        },
        batch: (queries) => database.executor.batch(queries),
      });
      const query = { projectId: P1, ecosystem: 'composer' as const, limit: 2 };
      const page = await closure.pageEdges(orgContext(ORG_A), query);
      expect(page.rows).toHaveLength(2);
      expect(page.rows.every((row) => row.requirerKey === 'edge/p00')).toBe(true);
      expect(statement).toBeDefined();
      const compiled = statement as unknown as ScalarStatement;
      const plan = await database.executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${compiled.sql}`,
        params: compiled.params,
      });
      const details = plan.map((row) => row.detail).join('\n');
      expect(details).toContain('MATERIALIZE key_page');
      expect(details).toContain('package_by_name (org_id=? AND ecosystem=? AND name=?)');
      expect(details).toContain('MATERIALIZE edge_page');
      expect(details).toContain('SEARCH v USING INDEX sqlite_autoindex_version_1 (id=?)');
      expect(details.indexOf('MATERIALIZE key_page')).toBeLessThan(
        details.lastIndexOf('SEARCH v USING INDEX sqlite_autoindex_version_1 (id=?)'),
      );
      await database.executor.all({
        sql: `CREATE TEMP VIEW version AS SELECT id, org_id, package_id, version, status,
          CASE WHEN package_id = '${config.packages.at(-1)?.id ?? ''}'
            THEN json_extract('invalid', '$') ELSE metadata_json END AS metadata_json
          FROM main.version`,
        params: [],
      });
      expect(await closure.pageEdges(orgContext(ORG_A), query)).toEqual(page);
    } finally {
      await database.close();
    }
  });

  it('continues a full walk when the cursor key loses its winner or no longer exists', async () => {
    for (const remove of [false, true]) {
      const database = await openMigratedDatabase({ d1PatternLimit: true });
      try {
        const config = edgeConfig();
        await seedCatalogue(database.executor, config);
        await seedDerivedRows(database.executor, config);
        const closure = createClosureEdges(database.executor);
        const ctx = orgContext(ORG_A);
        const query = { projectId: P1, ecosystem: 'composer' as const, limit: 2 };
        const first = await closure.pageEdges(ctx, query);
        const cursor = first.next as EdgeCursor;
        const packageId = config.packages[0]?.id as string;
        await database.executor.all({
          sql: 'DELETE FROM project_package WHERE package_id = ?',
          params: [packageId],
        });
        if (remove) {
          await database.executor.all({
            sql: 'DELETE FROM version WHERE package_id = ?',
            params: [packageId],
          });
          await database.executor.all({
            sql: 'DELETE FROM package WHERE id = ?',
            params: [packageId],
          });
        }
        const actual: ExpectedEdge[] = [];
        let after: EdgeCursor | undefined = cursor;
        do {
          const page = await closure.pageEdges(ctx, {
            ...query,
            ...(after === undefined ? {} : { after }),
          });
          actual.push(...page.rows.map(parsed));
          after = page.next ?? undefined;
        } while (after !== undefined);
        const expected = expectedEdges(config, toVisibilityInputs(config), P1, 'composer')
          .filter((row) => row.requirerKey > cursor.requirerKey)
          .map((row) => ({ ...row, deps: null }));
        expect(actual).toEqual(expected);
        expect(actual).toHaveLength(22);
      } finally {
        await database.close();
      }
    }
  });
});
