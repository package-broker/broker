import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  CatalogueReader,
  VersionCursor,
  PageBinding,
  EdgeCursor,
  EdgeRow,
  ListedPackage,
} from '@package-broker/core/db/catalogue';
import { orgContext, type ScalarStatement } from '@package-broker/core/db/port';
import {
  admitProxy,
  rankCandidates,
  resolveWinner,
} from '@package-broker/core/catalogue/visibility';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  seedCatalogue,
  toVisibilityInputs,
  type CatalogueConfig,
  type FixtureVersion,
} from '../testing/catalogue-fixture.js';
import { countCalls } from './count-calls.js';

const orgId = 'scale-org';
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const baseConfig: CatalogueConfig = {
  organizations: [{ id: orgId, slug: 'scale', name: 'Scale' }],
  projects: range(50).map((i) => ({
    id: `p${i}`,
    orgId,
    slug: `p${i}`,
    name: `P${i}`,
    status: i === 49 ? 'archived' : 'active',
  })),
  sources: range(20).map((i) => ({
    id: `s${i}`,
    orgId,
    projectId: i < 4 ? `p${i}` : null,
    name: `S${i}`,
    ecosystem: [1, 5, 19].includes(i) ? 'composer' : 'npm',
    type:
      i === 19
        ? 'packagist_proxy'
        : i === 18
          ? 'npmjs_proxy'
          : [1, 5].includes(i)
            ? 'composer_repository'
            : 'npm_registry',
    defaultVisible: 1,
    removalPolicy: i % 2 ? 'exclude' : 'flag',
  })),
  attachments: range(50).flatMap((i) =>
    [i < 4 ? i : 4 + (i % 14), 18 + (i % 2)].map((s) => ({
      orgId,
      projectId: `p${i}`,
      sourceId: `s${s}`,
      precedence: 100,
    })),
  ),
  packages: range(1000).map((i) => ({
    id: `k${i}`,
    orgId,
    sourceId: `s${Math.floor(i / 50)}`,
    ecosystem: [1, 5, 19].includes(Math.floor(i / 50)) ? 'composer' : 'npm',
    key: `${i >= 900 && i % 50 >= 40 ? 'proxy' : 'pkg'}-${i % 50}`,
    visible: i >= 900 && i < 950 ? 0 : i % 7 ? 1 : 0,
    status: i % 11 ? 'active' : 'removed_upstream',
  })),
  versions: range(20000).map((i) => ({
    id: `v${String(i).padStart(5, '0')}`,
    orgId,
    packageId: `k${Math.floor(i / 20)}`,
    version: `${[1, 5, 19].includes(Math.floor(i / 1000)) ? 'v' : ''}${(i % 20) + 1}.0.0`,
    normalized: `${(i % 20) + 1}.0.0${[1, 5, 19].includes(Math.floor(i / 1000)) ? '.0' : ''}`,
    stability: i % 3 === 0 ? 'dev' : i % 3 === 1 ? 'beta' : 'stable',
    status:
      i % 19 === 0
        ? 'quarantined'
        : i % 17 === 0
          ? 'tombstoned'
          : i % 13 === 0
            ? 'removed_upstream'
            : 'active',
    publishedAt: new Date(Date.UTC(2020, 0, Math.floor((i % 20) / 5) + 1)).toISOString(),
  })),
  patterns: range(50).map((i) => ({
    id: `pattern${i}`,
    orgId,
    projectId: `p${i}`,
    sourceId: `s${18 + (i % 2)}`,
    pattern: 'reserved-*',
    effect: 'exclude',
  })),
  explicit: range(50).flatMap((i) =>
    [i < 4 ? i : 4 + (i % 14), 18 + (i % 2)].flatMap((s) =>
      range(50).map((k) => ({ orgId, projectId: `p${i}`, packageId: `k${s * 50 + k}` })),
    ),
  ),
  registeredNames: range(20).map((i) => ({
    id: `registered${i}`,
    orgId,
    sourceId: `s${4 + (i % 14)}`,
    ecosystem: i % 14 === 1 ? 'composer' : 'npm',
    pattern: `private-${i}`,
  })),
};
const config: CatalogueConfig = {
  ...baseConfig,
  attachments: [
    ...baseConfig.attachments,
    { orgId, projectId: 'p4', sourceId: 's0', precedence: 0 },
  ],
  explicit: baseConfig.explicit.map((e) =>
    e.projectId === 'p4' && Number(e.packageId.slice(1)) >= 900
      ? { ...e, packageId: `k${Number(e.packageId.slice(1)) % 50}` }
      : e,
  ),
};
const metadata = {
  require: { 'vendor/dependency': '^1.0' },
  dependencies: { dependency: '^2.0' },
  dist: {
    type: 'tgz',
    tarball: 'https://registry.example/archive.tgz',
    url: 'https://registry.example/archive.zip',
    shasum: 'abc',
    integrity: 'sha512-fixture',
  },
};
const historicalIds = new Set(['v00039', 'v01039']);
function versionPayload(v: FixtureVersion) {
  return {
    versionId: v.id,
    revision: historicalIds.has(v.id) ? 2 : 1,
    version: v.version,
    versionNormalized: v.normalized,
    stability: v.stability,
    status: v.status,
    publishedAt: v.publishedAt,
    upstreamReleasedAt: '2019-12-01T00:00:00.000Z',
    license: 'MIT',
    distType: 'tgz',
    composerShasum: 'abc',
    npmIntegrity: 'sha512-fixture',
    deprecatedMessage: 'fixture deprecation',
    metadataJson: JSON.stringify(metadata),
  };
}
const blob = (history: boolean) => ({
  id: history ? 'history-blob' : 'current-blob',
  sha256: (history ? 'a' : 'b').repeat(64),
  sizeBytes: history ? 123 : 456,
  mediaType: 'application/gzip',
  refetchable: !history,
});
let database: MigratedDatabase;

beforeAll(async () => {
  database = await openMigratedDatabase({ d1PatternLimit: true });
  await seedCatalogue(database.executor, config, { maxStatements: Infinity });
  await database.executor.batch([
    {
      sql: "UPDATE version SET metadata_json = ?, upstream_released_at = ?, license = 'MIT', dist_type = 'tgz', composer_shasum = 'abc', npm_integrity = 'sha512-fixture', deprecated_message = 'fixture deprecation', source_ref = 'current-ref' WHERE org_id = ?",
      params: [JSON.stringify(metadata), '2019-12-01T00:00:00.000Z', orgId],
    },
    ...[false, true].map((history): ScalarStatement => ({
      sql: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [
        blob(history).id,
        orgId,
        blob(history).sha256,
        blob(history).sizeBytes,
        blob(history).id,
        blob(history).mediaType,
        Number(blob(history).refetchable),
      ],
    })),
    ...[...historicalIds].flatMap((id): ScalarStatement[] => [
      {
        sql: 'UPDATE version SET revision = 2, blob_id = ? WHERE org_id = ? AND id = ?',
        params: [blob(false).id, orgId, id],
      },
      {
        sql: "INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason) VALUES (?, ?, ?, 1, ?, 'history-ref', ?, 'dist')",
        params: [
          `history-${id}`,
          orgId,
          id,
          blob(true).id,
          JSON.stringify({
            dist: {
              type: 'zip',
              url: 'https://registry.example/old.zip',
              tarball: 'https://registry.example/old.tgz',
              shasum: 'def',
              integrity: 'sha512-history',
            },
          }),
        ],
      },
    ]),
  ]);
  const tags: ScalarStatement[] = config.packages.map((pkg, i) => ({
    sql: "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, 'latest', ?)",
    params: [orgId, pkg.id, config.versions[i * 20 + 19]!.id],
  }));
  for (let i = 0; i < tags.length; i += 200) await database.executor.batch(tags.slice(i, i + 200));
}, 30000);
afterAll(async () => {
  await database?.close();
});

function assertIndexed(statement: ScalarStatement, details: readonly string[]): void {
  const aliases = new Set(['package', 'version', 'project_package']);
  for (const match of statement.sql.matchAll(
    /\b(?:from|join)\s+"?(package|version|project_package)"?\s+(?:as\s+)?"?(\w+)"?/gi,
  ))
    aliases.add(match[2]!);
  const scans = details.filter((detail) => {
    const alias = /^SCAN\s+(?:TABLE\s+)?(\w+)/i.exec(detail)?.[1];
    return alias !== undefined && aliases.has(alias);
  });
  expect(scans, details.join('\n')).toEqual([]);
}

async function checked<T>(call: (reader: CatalogueReader) => Promise<T>): Promise<T> {
  const counted = countCalls(database.executor);
  const captured: ScalarStatement[] = [];
  const executor = new Proxy(counted.executor, {
    get(target, property, receiver) {
      if (property === 'all')
        return async (statement: ScalarStatement) => {
          captured.push(statement);
          return target.all(statement);
        };
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const result = await call(createCatalogueReader(executor));
  expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  for (const statement of captured) {
    expect(statement.params.length).toBeLessThanOrEqual(100);
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    assertIndexed(
      statement,
      plan.map((row) => row.detail),
    );
  }
  return result;
}

it('seeds the required scale', async () => {
  for (const [table, count] of Object.entries({
    project: 50,
    source: 20,
    package: 1000,
    version: 20000,
    project_package: 5000,
    project_package_pattern: 50,
    registered_name: 20,
  })) {
    expect(
      await database.executor.all({ sql: `SELECT count(*) AS n FROM ${table}`, params: [] }),
    ).toEqual([{ n: count }]);
  }
});

it.each([false, true])(
  'all catalogue reads use one indexed statement and match the oracle (ANALYZE=%s)',
  async (analyzed) => {
    if (analyzed) await database.executor.batch([{ sql: 'ANALYZE', params: [] }]);
    for (const [projectId, ctx] of ['p0', 'p1', 'p4', 'p49', 'foreign-project']
      .map((id) => [id, orgContext(orgId)] as const)
      .concat([['p0', orgContext('foreign-org')]])) {
      const visibility = toVisibilityInputs({
        ...config,
        projects: config.projects.filter((p) => p.orgId === ctx.orgId),
      });
      for (const ecosystem of ['npm', 'composer'] as const) {
        const scope = { projectId, ecosystem } as const;
        const keys = [
          'pkg-0',
          'pkg-1',
          'pkg-49',
          'proxy-49',
          'unseen',
          'private-0',
          'reserved-name',
        ];
        const winner = (key: string) => resolveWinner(visibility, projectId, ecosystem, key);
        const available = (key: string) => {
          const w = winner(key);
          const source = config.sources.find((s) => s.id === w?.sourceId);
          return config.versions.filter(
            (v) =>
              v.packageId === w?.packageId &&
              (v.status === 'active' ||
                (v.status === 'removed_upstream' && source?.removalPolicy === 'flag')),
          );
        };
        for (const key of keys) {
          const ref = { ...scope, key };
          const w = winner(key);
          const versions = available(key);
          for (const stability of ecosystem === 'composer'
            ? (['dev', 'stable'] as const)
            : [undefined]) {
            for (const publishedAtMost of [undefined, '2020-01-03T00:00:00.000Z']) {
              const ordered = versions
                .filter(
                  (v) =>
                    (publishedAtMost === undefined || v.publishedAt <= publishedAtMost) &&
                    (stability === undefined ||
                      (stability === 'dev' ? v.stability === 'dev' : v.stability !== 'dev')),
                )
                .sort(
                  (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id),
                );
              const collected = [];
              let after: VersionCursor | undefined;
              let binding: PageBinding | undefined;
              for (let offset = 0; ; offset += 7) {
                const resolution = await checked((r) =>
                  r.resolveVersions(ctx, {
                    ...ref,
                    limit: 7,
                    ...(publishedAtMost === undefined ? {} : { publishedAtMost }),
                    ...(stability === undefined ? {} : { stability }),
                    ...(after === undefined ? {} : { after }),
                    ...(binding === undefined ? {} : { binding }),
                  }),
                );
                if (!w) {
                  expect(resolution).toBeNull();
                  break;
                }
                expect(resolution).toMatchObject({ pkg: w });
                if (!resolution || !('versions' in resolution))
                  throw new Error('expected version page');
                const slice = ordered.slice(offset, offset + 7);
                expect(resolution.versions).toEqual(slice.map(versionPayload));
                collected.push(...resolution.versions);
                const last = slice.at(-1);
                expect(resolution.next).toEqual(
                  offset + 7 < ordered.length && last
                    ? { publishedAt: last.publishedAt, id: last.id }
                    : null,
                );
                expect(resolution.binding).toEqual({ ...w, rev: 1 });
                if (resolution.next === null) break;
                after = resolution.next;
                binding = resolution.binding;
              }
              expect(collected).toEqual(ordered.map(versionPayload));
            }
          }
          const versionNormalized = ecosystem === 'composer' ? '20.0.0.0' : '20.0.0';
          const expected = versions.find((v) => v.normalized === versionNormalized);
          for (const tagged of [false, true]) {
            const result = await checked((r) =>
              tagged
                ? r.lookupTag(ctx, { ...ref, tag: 'latest' })
                : r.lookupVersion(ctx, { ...ref, versionNormalized }),
            );
            if (expected && (!tagged || ecosystem === 'npm')) {
              expect(result).toMatchObject({ pkg: w });
              expect(result?.version).toEqual(versionPayload(expected));
            } else expect(result).toBeNull();
          }
          const tags = await checked((r) => r.distTags(ctx, ref));
          if (w) {
            expect(tags).toMatchObject({ pkg: w });
            expect(tags?.tags).toEqual(expected && ecosystem === 'npm' ? { latest: '20.0.0' } : {});
          } else expect(tags).toBeNull();
          const dist = await checked((r) =>
            r.resolveDist(ctx, { ...ref, by: 'version', versionNormalized }),
          );
          if (expected) {
            const target = {
              ...w,
              versionId: expected.id,
              revision: versionPayload(expected).revision,
              current: true,
              status: expected.status,
              blob: historicalIds.has(expected.id) ? blob(false) : null,
              fetch: {
                sourceRef: 'current-ref',
                upstreamDistUrl: ecosystem === 'npm' ? metadata.dist.tarball : metadata.dist.url,
                distType: 'tgz',
                composerShasum: 'abc',
                npmIntegrity: 'sha512-fixture',
                npmShasum: ecosystem === 'npm' ? 'abc' : null,
              },
            };
            expect(dist).toEqual(target);
            expect(
              await checked((r) =>
                r.resolveDist(ctx, {
                  ...ref,
                  by: 'id',
                  versionId: expected.id,
                  revision: target.revision,
                }),
              ),
            ).toEqual(target);
            if (historicalIds.has(expected.id)) {
              expect(
                await checked((r) =>
                  r.resolveDist(ctx, { ...ref, by: 'id', versionId: expected.id, revision: 1 }),
                ),
              ).toEqual({
                ...target,
                revision: 1,
                current: false,
                blob: blob(true),
                fetch: {
                  sourceRef: 'history-ref',
                  upstreamDistUrl:
                    ecosystem === 'npm'
                      ? 'https://registry.example/old.tgz'
                      : 'https://registry.example/old.zip',
                  distType: 'zip',
                  composerShasum: ecosystem === 'composer' ? 'def' : null,
                  npmIntegrity: ecosystem === 'npm' ? 'sha512-history' : null,
                  npmShasum: ecosystem === 'npm' ? 'def' : null,
                },
              });
            }
          } else expect(dist).toBeNull();
          expect(
            await checked((r) =>
              r.resolveDist(ctx, {
                ...ref,
                by: 'version',
                versionNormalized,
                expect: { versionId: expected?.id ?? 'absent', revision: 3 },
              }),
            ),
          ).toBeNull();
          const loser = config.packages.find((p) => p.key === key && p.id !== w?.packageId);
          if (loser)
            expect(
              await checked((r) =>
                r.resolveDist(ctx, {
                  ...ref,
                  by: 'id',
                  versionId: config.versions.find((v) => v.packageId === loser.id)!.id,
                  revision: 1,
                }),
              ),
            ).toBeNull();
          expect(await checked((r) => r.admitProxy(ctx, ref))).toEqual(
            admitProxy(visibility, projectId, ecosystem, key),
          );
          expect(await checked((r) => r.previewWinners(ctx, ref))).toEqual(
            rankCandidates(visibility, projectId, ecosystem, key),
          );
        }
        const listed = [
          ...new Set(config.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.key)),
        ]
          .sort()
          .flatMap((key) => {
            const w = winner(key);
            return w ? [{ key, ...w, description: null }] : [];
          });
        const items: ListedPackage[] = [];
        let listingAfter: string | undefined;
        for (let offset = 0; ; offset += 17) {
          const page = await checked((r) =>
            r.listVisible(ctx, {
              ...scope,
              limit: 17,
              ...(listingAfter === undefined ? {} : { after: listingAfter }),
            }),
          );
          expect(page.items).toEqual(listed.slice(offset, offset + 17));
          expect(page.next).toEqual(offset + 17 < listed.length ? listed[offset + 16]!.key : null);
          expect(page.openNamespace).toBe(
            ctx.orgId === orgId &&
              (ecosystem === 'npm' ? ['p0', 'p4'] : ['p1']).includes(projectId),
          );
          items.push(...page.items);
          if (page.next === null) break;
          listingAfter = page.next;
        }
        expect(items).toEqual(listed);
        expect(await checked((r) => r.search(ctx, { ...scope, text: 'pkg-1', limit: 50 }))).toEqual(
          listed.filter((p) => p.key.includes('pkg-1')),
        );
        expect(await checked((r) => r.classifyWinners(ctx, { ...scope, keys }))).toEqual(
          keys.map((key) => {
            const w = winner(key);
            return {
              key,
              winner: w
                ? {
                    sourceId: w.sourceId,
                    sourceType: config.sources.find((s) => s.id === w.sourceId)!.type,
                  }
                : null,
            };
          }),
        );
        expect(await checked((r) => r.classify(ctx, { ...scope, keys }))).toEqual(
          keys.map((key) => ({
            key,
            class: admitProxy(visibility, projectId, ecosystem, key).length
              ? 'proxy_admissible'
              : config.projects.some(
                    (p) => p.orgId === ctx.orgId && p.id === projectId && p.status === 'active',
                  ) &&
                  config.packages.some(
                    (p) =>
                      p.key === key &&
                      p.ecosystem === ecosystem &&
                      config.sources.some(
                        (s) =>
                          s.id === p.sourceId &&
                          s.projectId === null &&
                          !['npmjs_proxy', 'packagist_proxy'].includes(s.type) &&
                          (p.status === 'active' || s.removalPolicy === 'flag'),
                      ),
                  )
                ? 'attachable'
                : 'not_available',
          })),
        );
        const edges = listed
          .flatMap((p) =>
            available(p.key).map((v) => ({
              requirerKey: p.key,
              versionId: v.id,
              version: v.version,
              deps:
                ecosystem === 'composer'
                  ? JSON.stringify(metadata.require)
                  : JSON.stringify({
                      dependencies: metadata.dependencies,
                      optionalDependencies: null,
                      peerDependencies: null,
                      peerDependenciesMeta: null,
                    }),
            })),
          )
          .sort(
            (a, b) =>
              a.requirerKey.localeCompare(b.requirerKey) || a.versionId.localeCompare(b.versionId),
          );
        const rows: EdgeRow[] = [];
        let edgeAfter: EdgeCursor | undefined;
        for (let offset = 0; ; offset += 137) {
          const page = await checked((r) =>
            r.pageEdges(ctx, {
              ...scope,
              limit: 137,
              ...(edgeAfter === undefined ? {} : { after: edgeAfter }),
            }),
          );
          const slice = edges.slice(offset, offset + 137);
          expect(page.rows).toEqual(slice);
          const last = slice.at(-1);
          expect(page.next).toEqual(
            offset + 137 < edges.length && last
              ? { requirerKey: last.requirerKey, versionId: last.versionId }
              : null,
          );
          rows.push(...page.rows);
          if (page.next === null) break;
          edgeAfter = page.next;
        }
        expect(rows).toEqual(edges);
      }
    }
  },
  30000,
);
