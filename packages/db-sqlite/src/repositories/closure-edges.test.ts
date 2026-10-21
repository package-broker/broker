import { DatabaseSync } from 'node:sqlite';
import { sql, type RawBuilder } from 'kysely';
import { compile, db } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import { visibleRowsCondition, winnerOrder } from './catalogue-predicates.js';
import type { CatalogueReader, EdgePage } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { describe, expect, it } from 'vitest';
import {
  admitProxy,
  rankCandidates,
  resolveWinner,
  type VisibilityConfig,
} from '@package-broker/core/catalogue/visibility';
import { patternAdmits } from '@package-broker/core/catalogue/patterns';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import {
  validateLimit,
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

function expectNoWholeMetadata(text: string): void {
  const stripped = text.replace(
    /json_(?:extract|type)\([a-z_][a-z0-9_]*\.metadata_json, (\?|'\$\.[^']+')\)/gi,
    '',
  );
  expect(stripped).not.toContain('metadata_json');
}

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

  it('rejects a bare metadata_json select alongside allowed path reads', () => {
    expect(() =>
      expectNoWholeMetadata(
        "select v.metadata_json, json_extract(v.metadata_json, '$.require'), json_type(v.metadata_json, '$.require') from version as v",
      ),
    ).toThrow();
  });

  it('3: no statement selects metadata_json whole', async () => {
    expectNoWholeMetadata(
      "select json_extract(ev.metadata_json, '$.require'), json_type(ev.metadata_json, '$.require') from version as ev",
    );
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
        expectNoWholeMetadata(text);
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
                    patternAdmits(
                      {
                        flag: p.visible,
                        includes:
                          inputs.attachments.find(
                            (a) => a.projectId === project.id && a.sourceId === p.sourceId,
                          )?.includes ?? [],
                        excludes:
                          inputs.attachments.find(
                            (a) => a.projectId === project.id && a.sourceId === p.sourceId,
                          )?.excludes ?? [],
                      },
                      key,
                    ) &&
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
      let versionView = false;
      const closure = createClosureEdges({
        ...database.executor,
        all: async (query) => {
          statement = query;
          return database.executor.all(
            versionView
              ? {
                  ...query,
                  sql: query.sql.replace(
                    'version as ev indexed by version_package_id',
                    'version as ev',
                  ),
                }
              : query,
          );
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
      expect(details).toContain('SEARCH v USING INDEX version_org_id (id=? AND org_id=?)');
      expect(details.indexOf('MATERIALIZE key_page')).toBeLessThan(
        details.lastIndexOf('SEARCH v USING INDEX version_org_id (id=? AND org_id=?)'),
      );
      await database.executor.all({
        sql: `CREATE TEMP VIEW version AS SELECT id, org_id, package_id, version, status,
          CASE WHEN package_id = '${config.packages.at(-1)?.id ?? ''}'
            THEN json_extract('invalid', '$') ELSE metadata_json END AS metadata_json
          FROM main.version indexed by version_package_id`,
        params: [],
      });
      versionView = true;
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

interface EdgeSqlRow {
  requirer_key: string;
  version_id: string;
  version: string;
  deps: string | null;
}

// Frozen pre-0024 SQL oracle.
const NPM_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
] as const;

function toStatement(raw: RawBuilder<unknown>): ScalarStatement {
  return compile({ compile: () => raw.compile(db) }) as ScalarStatement;
}

function visibleFrom(): RawBuilder<unknown> {
  return sql`from project_package as pp
    join package as pkg on pkg.id = pp.package_id
    join source as src on src.id = pkg.source_id
    join project_source as ps on ps.project_id = pp.project_id and ps.source_id = pkg.source_id`;
}

function rankedWinners(
  ctx: OrgContext,
  projectId: string,
  ecosystem: NameEcosystem,
  filter: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`select pkg.name as key, pkg.id as package_id, pkg.source_id, src.type as source_type,
    src.removal_policy,
    row_number() over (partition by pkg.name order by ${sql.join(winnerOrder({ source: 'src', attachment: 'ps' }))}) as rn
  ${visibleFrom()}
  where pp.project_id = ${projectId} and pkg.ecosystem = ${ecosystem} and ${filter}
    and ${visibleRowsCondition(ctx, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}`;
}

function depsExpression(ecosystem: NameEcosystem): RawBuilder<unknown> {
  if (ecosystem === 'composer') {
    return sql`case when json_type(v.metadata_json, '$.require') in ('object', 'array')
      then json_extract(v.metadata_json, '$.require') else null end`;
  }
  const extract = (field: string) => sql`json_extract(v.metadata_json, ${`$.${field}`})`;
  const absent = sql.join(
    NPM_DEPENDENCY_FIELDS.map((field) => sql`${extract(field)} is null`),
    sql` and `,
  );
  const members = sql.join(NPM_DEPENDENCY_FIELDS.map((field) => sql`${field}, ${extract(field)}`));
  return sql`case when ${absent} then null else json_object(${members}) end`;
}

function legacyClosure(executor: ScalarSqlExecutor): Pick<CatalogueReader, 'pageEdges'> {
  return {
    async pageEdges(ctx, query): Promise<EdgePage> {
      const limit = validateLimit(query?.limit, CATALOGUE_PAGE_MAX);
      const { after } = query;
      if (
        after !== undefined &&
        (typeof after.requirerKey !== 'string' || typeof after.versionId !== 'string')
      ) {
        throw new TypeError('after must be an edge cursor');
      }
      const keyFrom = after === undefined ? sql`1 = 1` : sql`kp.name >= ${after.requirerKey}`;
      const versionFrom = (key: string, version: string) =>
        after === undefined
          ? sql`1 = 1`
          : sql`(${sql.ref(key)}, ${sql.ref(version)}) > (${after.requirerKey}, ${after.versionId})`;
      const raw = sql`with key_page as materialized (
  select kp.name
  from package as kp indexed by package_by_name
  where kp.org_id = ${ctx.orgId} and kp.ecosystem = ${query.ecosystem} and ${keyFrom}
    and exists (
      select 1
      from (${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name = kp.name`)}) as w
      join version as ev on ev.package_id = w.package_id and ev.org_id = ${ctx.orgId}
        and (ev.status = 'active' or (ev.status = 'removed_upstream' and w.removal_policy = 'flag'))
      where w.rn = 1 and ${versionFrom('w.key', 'ev.id')}
    )
  group by kp.name
  order by kp.name
  limit ${limit + 1}
), c as materialized (
  ${rankedWinners(ctx, query.projectId, query.ecosystem, sql`pkg.name in (select name from key_page)`)}
), edge_page as materialized (
  select c.key as requirer_key, v.id as version_id
  from c
  join version as v on v.id in (
    select ev.id from version as ev
    where ev.package_id = c.package_id and ev.org_id = ${ctx.orgId}
      and (ev.status = 'active' or (ev.status = 'removed_upstream' and c.removal_policy = 'flag'))
      and ${versionFrom('c.key', 'ev.id')}
    order by ev.id
    limit ${limit + 1}
  )
  where c.rn = 1
  order by c.key, v.id
  limit ${limit + 1}
)
select edge_page.requirer_key, edge_page.version_id, v.version,
  ${depsExpression(query.ecosystem)} as deps
from edge_page
join version as v on v.id = edge_page.version_id and v.org_id = ${ctx.orgId}
order by edge_page.requirer_key, edge_page.version_id`;
      const rows = await executor.all<EdgeSqlRow>(toStatement(raw));
      const more = rows.length > limit;
      const page = (more ? rows.slice(0, limit) : rows).map((row): EdgeRow => ({
        requirerKey: row.requirer_key,
        versionId: row.version_id,
        version: row.version,
        deps: row.deps,
      }));
      const last = page.at(-1);
      return {
        rows: page,
        next: more && last ? { requirerKey: last.requirerKey, versionId: last.versionId } : null,
      };
    },
  };
}

async function instrumentedDatabase() {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys = ON');
  const run = (statement: Statement) => {
    const prepared = native.prepare(statement.sql);
    if (prepared.columns().length === 0) {
      return { changes: Number(prepared.run(...statement.params).changes), rows: [] };
    }
    return { changes: 0, rows: prepared.all(...statement.params) };
  };
  const executor: SqlExecutor = {
    driver: 'node-sqlite',
    async all<R>(statement: Statement) {
      return run(statement).rows as R[];
    },
    async batch(statements) {
      native.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(run);
        native.exec('COMMIT');
        return results;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  await migrate(executor, await discoveredMigrations(), { holder: 'edge-count-test' });
  return { native, executor };
}

function largeEdgeConfig(firstVersions = 1000): CatalogueConfig {
  const base = edgeConfig();
  const packages = Array.from({ length: 210 }, (_, n) =>
    pkg(n + 10, ORG_A, ORG_SRC, `edge/p${String(n).padStart(3, '0')}`),
  );
  return {
    ...base,
    packages,
    versions: packages.flatMap((p, n) =>
      Array.from(
        { length: n === 0 ? firstVersions : n === 1 && firstVersions === 199 ? 1000 : 1 },
        (_, v) => ({
          id: `V${String(n).padStart(3, '0')}-${String(v).padStart(4, '0')}`,
          orgId: ORG_A,
          packageId: p.id,
          version: `${v}.0.0`,
          normalized: `${v}.0.0.0`,
          stability: 'stable' as const,
          status: 'active' as const,
          publishedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ),
  };
}

describe('closure edge index bounds', () => {
  it.each([1000, 199])(
    'reads only the remaining page budget with %i versions in the first key',
    async (firstVersions) => {
      const { native, executor } = await instrumentedDatabase();
      try {
        const config = largeEdgeConfig(firstVersions);
        await seedCatalogue(executor, config, { maxStatements: Infinity });
        await seedDerivedRows(executor, config);
        const reads = new Map<string, number>();
        native.function('count_version', (packageId, status) => {
          const key = String(packageId);
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return status;
        });
        native.exec(`CREATE TEMP VIEW version AS SELECT id, org_id, package_id, version,
        count_version(package_id, status) AS status, metadata_json FROM main.version indexed by version_package_id`);
        let captured: ScalarStatement | undefined;
        const closure = createClosureEdges({
          ...executor,
          async all(query) {
            captured = query;
            return executor.all({
              ...query,
              sql: query.sql.replace(
                'version as ev indexed by version_package_id',
                'version as ev',
              ),
            });
          },
        });
        const page = await closure.pageEdges(orgContext(ORG_A), {
          projectId: P1,
          ecosystem: 'composer',
          limit: 200,
        });
        expect(page.rows).toHaveLength(200);
        expect(page.next).not.toBeNull();
        const boundary = firstVersions === 1000 ? 0 : 1;
        expect(reads.get(config.packages[boundary]!.id)).toBe(
          201 - (boundary === 0 ? 0 : firstVersions),
        );
        for (const p of config.packages.slice(boundary + 1)) expect(reads.get(p.id) ?? 0).toBe(0);
        expect([...reads.values()].reduce((a, b) => a + b, 0)).toBe(201);
        const statement = captured!;
        const plan = await executor.all<{ detail: string }>({
          sql: `EXPLAIN QUERY PLAN ${statement.sql.replaceAll('version as', 'main.version as')}`,
          params: statement.params,
        });
        const details = plan.map((r) => r.detail).join('\n');
        expect(details).toContain('version_package_id');
        expect(details).toContain('project_package_name');
      } finally {
        native.close();
      }
    },
    120_000,
  );

  it('does not read package rows for 20000 invisible preceding names', async () => {
    const { native, executor } = await instrumentedDatabase();
    try {
      const base = edgeConfig();
      const visible = pkg(10, ORG_A, ORG_SRC, 'zz/visible');
      const config: CatalogueConfig = {
        ...base,
        packages: [visible],
        versions: [{ ...base.versions[0]!, packageId: visible.id }],
      };
      await seedCatalogue(executor, config);
      await seedDerivedRows(executor, config);
      native.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20000)
        INSERT INTO package (id, org_id, source_id, ecosystem, name)
        SELECT 'hidden-' || x, '${ORG_A}', '${ORG_SRC}', 'composer', printf('aa/p%05d', x) FROM n`);
      let hiddenReads = 0;
      native.function('count_package', (id, name) => {
        if (String(id).startsWith('hidden-')) {
          hiddenReads++;
          throw new Error('read an invisible package row');
        }
        return name;
      });
      const columns = native.prepare("SELECT name FROM pragma_table_info('package')").all() as {
        name: string;
      }[];
      native.exec(
        `CREATE TEMP VIEW counted_package AS SELECT ${columns.map(({ name }) => (name === 'name' ? 'count_package(id, name) AS name' : name)).join(', ')} FROM main.package`,
      );
      const trapped: ScalarSqlExecutor = {
        ...executor,
        all(statement) {
          return executor.all({
            ...statement,
            // Hints target tables; each package alias instead reads the counting view.
            sql: statement.sql.replace(
              /\bpackage as ("[^"]+"|\w+)(?: indexed by package_by_name)?/gi,
              'counted_package as $1',
            ),
          });
        },
      };
      const page = await createClosureEdges(trapped).pageEdges(orgContext(ORG_A), {
        projectId: P1,
        ecosystem: 'composer',
        limit: 200,
      });
      expect(page.rows.map((r) => r.requirerKey)).toEqual(['zz/visible']);
      expect(hiddenReads).toBe(0);
    } finally {
      native.close();
    }
  }, 120_000);

  it.each([false, true])(
    'matches the frozen old SQL byte-for-byte on fixed randomized catalogues (empty version ID: %s)',
    async (withEmptyVersionId) => {
      let emptyRows = 0;
      let emptyCursors = 0;
      for (let seed = 601; seed <= 606; seed++) {
        const base = randomCatalogueConfig(seed, 6, { forged: true });
        const inputs = toVisibilityInputs(base);
        const emptyVersion = base.projects.flatMap((project) =>
          ECOSYSTEMS.flatMap((ecosystem) => expectedEdges(base, inputs, project.id, ecosystem)),
        )[0];
        if (withEmptyVersionId) expect(emptyVersion).toBeDefined();
        const config: CatalogueConfig = {
          ...base,
          versions: base.versions.map((version) =>
            withEmptyVersionId && version.id === emptyVersion?.versionId
              ? { ...version, id: '' }
              : version,
          ),
        };
        const database = await openMigratedDatabase({ d1PatternLimit: true });
        try {
          await seedCatalogue(database.executor, config, { maxStatements: Infinity });
          await seedDerivedRows(database.executor, config);
          await seedMetadata(database.executor, config);
          for (const project of config.projects)
            for (const ecosystem of ECOSYSTEMS)
              for (const limit of [1, 3, 200])
                for (const initialAfter of [
                  undefined,
                  { requirerKey: '', versionId: 'past-all-versions' },
                ]) {
                  let after: EdgeCursor | undefined = initialAfter;
                  do {
                    const query = {
                      projectId: project.id,
                      ecosystem,
                      limit,
                      ...(after === undefined ? {} : { after }),
                    };
                    const expected = await legacyClosure(database.executor).pageEdges(
                      orgContext(project.orgId),
                      query,
                    );
                    const actual = await createClosureEdges(database.executor).pageEdges(
                      orgContext(project.orgId),
                      query,
                    );
                    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
                    emptyRows += expected.rows.filter((row) => row.versionId === '').length;
                    if (expected.next?.versionId === '') emptyCursors++;
                    after = actual.next ?? undefined;
                  } while (after !== undefined);
                }
        } finally {
          await database.close();
        }
      }
      if (withEmptyVersionId) {
        expect(emptyRows).toBeGreaterThan(0);
        expect(emptyCursors).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
