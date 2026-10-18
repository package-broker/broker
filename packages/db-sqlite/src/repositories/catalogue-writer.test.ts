import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type {
  CatalogueWriter,
  VisibilityStore,
  VersionInput,
  SyncPackageInput,
  VisibilityWriteResult,
} from '@package-broker/core/db/catalogue';
import {
  normalizeVersionMetadata,
  type NormalizedJson,
} from '@package-broker/core/catalogue/metadata';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createCatalogueWriter, createVisibilityStore, subsetOutcome } from './catalogue-writer.js';
import type {
  AddPatternResult,
  RemovePatternResult,
  AddExplicitResult,
  RemoveExplicitResult,
} from './visibility-subset.js';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let writer: CatalogueWriter;
let store: VisibilityStore;
let guard: ReturnType<typeof createCatalogueWriteGuard>;
let batches: Statement[][];
let epochMutation: 'none' | 'strip' | 'inject';
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const fence = () =>
  mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {});
const input = (n: number, extra: Partial<VersionInput> = {}): VersionInput => ({
  version: `1.0.${String(n)}`,
  versionNormalized: `1.0.${String(n)}`,
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  history: { at: '2020-01-01T00:00:00.000Z', basis: 'release_date' },
  metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
  ...extra,
});
const sync = (versions: readonly VersionInput[], extra: Partial<SyncPackageInput> = {}) =>
  writer.syncPackage(org, guard, {
    sourceId: 'source',
    ecosystem: 'npm',
    key: 'widget',
    description: null,
    versions,
    ...extra,
  });
async function scalar(sql: string, ...params: Statement['params']) {
  return (await database.executor.batch([stmt(sql, ...params)]))[0]?.rows[0]?.['value'];
}
const epoch = () => scalar('SELECT version AS value FROM cache_epoch WHERE org_id = ?', org.orgId);
const versionId = () =>
  scalar('SELECT id AS value FROM version WHERE org_id = ? LIMIT 1', org.orgId) as Promise<string>;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  org = database.orgs!.a;
  other = database.orgs!.b;
  const now = new Date().toISOString();
  const address = ['admin', 'example.test'].join('@');
  await database.executor.batch([
    stmt(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
      org.orgId,
      address,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'subject', ?, 1, ?)",
      org.orgId,
      address,
      now,
    ),
    stmt(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      org.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
      now,
      now,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
      org.orgId,
    ),
    ...['org:sources:write', 'project:sources:write', 'project:packages:manage'].map((p) =>
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', ?)",
        org.orgId,
        p,
      ),
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES ('grant', ?, 'email', ?, 'organization', 'role', ?, ?)",
      org.orgId,
      address,
      now,
      now,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
  batches = [];
  epochMutation = 'none';
  const executor: SqlExecutor = {
    driver: database.executor.driver,
    all: () => {
      throw new Error('adapter must use batches');
    },
    async batch(statements) {
      batches.push([...statements]);
      expect(statements.length).toBeLessThanOrEqual(200);
      for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(100);
      const changed = statements.map((s) =>
        epochMutation === 'strip' && /update ["\s]*cache_epoch/i.test(s.sql) ? stmt('SELECT 1') : s,
      );
      if (epochMutation === 'inject')
        changed.push(
          stmt('UPDATE cache_epoch SET version = hex(randomblob(16)) WHERE org_id = ?', org.orgId),
        );
      return database.executor.batch(changed);
    },
  };
  writer = createCatalogueWriter(executor);
  const providerAnchors = [
    {
      provider: 'oidc',
      anchor: 'oidc:https://idp.example.test',
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test'],
    },
  ];
  store = createVisibilityStore(executor, { providerAnchors });
});
afterEach(async () => {
  await database.close();
});

describe('catalogue adapter', () => {
  it('implements the ports and covers every subset outcome at the type level', () => {
    expectTypeOf(writer).toMatchTypeOf<CatalogueWriter>();
    expectTypeOf(store).toMatchTypeOf<VisibilityStore>();
    expectTypeOf<
      AddPatternResult | RemovePatternResult | AddExplicitResult | RemoveExplicitResult
    >().toEqualTypeOf<Parameters<typeof subsetOutcome>[0]>();
    expectTypeOf<ReturnType<typeof subsetOutcome>>().toEqualTypeOf<VisibilityWriteResult>();
  });
  it('inserts 120 versions in three calls and three batches, then replays unchanged', async () => {
    const versions = Array.from({ length: 120 }, (_, n) => input(n));
    for (const offset of [0, 50, 100]) {
      const slice = versions.slice(offset, offset + 50);
      const result = await sync(slice);
      expect(result).toMatchObject({
        inserted: slice.length,
        updated: 0,
        unchanged: 0,
        refused: [],
        conflicts: [],
      });
      expect(result.statements).toBe(batches.at(-1)!.length);
    }
    expect(batches).toHaveLength(3);
    for (const offset of [0, 50, 100]) {
      const slice = versions.slice(offset, offset + 50);
      expect(await sync(slice)).toMatchObject({ inserted: 0, updated: 0, unchanged: slice.length });
    }
    expect(await scalar('SELECT count(*) AS value FROM version')).toBe(120);
  });
  it('refuses excessive versions, tags and parameter payload before execution', async () => {
    await expect(sync(Array.from({ length: 51 }, (_, n) => input(n)))).rejects.toThrow(RangeError);
    await expect(
      sync([], {
        tags: Object.fromEntries(
          Array.from({ length: 101 }, (_, n) => [`tag${String(n)}`, '1.0.0']),
        ),
      }),
    ).rejects.toThrow(RangeError);
    const large = input(0, {
      metadata: {
        ...input(0).metadata,
        json: JSON.stringify({ data: 'x'.repeat(200_000) }) as NormalizedJson,
      },
    });
    await expect(
      sync(
        Array.from({ length: 50 }, (_, n) => ({
          ...large,
          version: `1.0.${String(n)}`,
          versionNormalized: `1.0.${String(n)}`,
        })),
      ),
    ).rejects.toThrow(RangeError);
    expect(batches).toHaveLength(0);
  });
  it('reports invalid, oversized and tombstoned inputs without counting them unchanged', async () => {
    await sync([input(0)]);
    const id = await versionId();
    await store.tombstoneVersion(org, fence(), { versionId: id, reason: 'admin_tombstone' });
    const result = await sync([
      input(0),
      input(1, { versionNormalized: 'bad' }),
      input(2, { metadata: { ...input(2).metadata, json: 'x'.repeat(262145) as NormalizedJson } }),
    ]);
    expect(result).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      refused: [
        { version: '1.0.0', reason: 'tombstoned' },
        { version: '1.0.1', reason: 'invalid' },
        { version: '1.0.2', reason: 'too_large' },
      ],
    });
  });
  it('reports npm conflicts and skipped tags, and preserves published_at', async () => {
    await sync([input(0)]);
    const date = await scalar('SELECT published_at AS value FROM version');
    expect(
      await sync(
        [input(0, { metadata: normalizeVersionMetadata('npm', { name: 'widget', other: true }) })],
        { tags: { latest: '1.0.0', bad: '9.0.0', '1.0.0': '1.0.0' } },
      ),
    ).toMatchObject({ conflicts: ['1.0.0'], unchanged: 0, skippedTags: ['1.0.0', 'bad'] });
    expect(await scalar('SELECT published_at AS value FROM version')).toBe(date);
  });
  it('syncs 100 npm tags in guarded batches with atomic history/write pairs', async () => {
    await sync([input(0)], { tags: { tag0: '1.0.0', obsolete: '1.0.0' } });
    const previousId = await versionId();
    const tags = Object.fromEntries(
      Array.from({ length: 100 }, (_, n) => [`tag${String(n)}`, '1.0.1']),
    );
    batches.length = 0;
    const result = await sync([input(1)], { tags });
    expect(result).toMatchObject({ inserted: 1, unchanged: 0, refused: [], skippedTags: [] });
    expect(batches.length).toBeGreaterThan(1);
    expect(result.statements).toBe(batches.reduce((n, batch) => n + batch.length, 0));
    expect(result.statements).toBeLessThanOrEqual(500);
    for (const batch of batches) {
      expect(batch.slice(0, guard.length)).toEqual([...guard]);
      batch.forEach((statement, index) => {
        if (/^insert into "dist_tag_history" /i.test(statement.sql))
          expect(batch[index + 1]?.sql).toMatch(
            /^(insert into "dist_tag" |delete from "dist_tag" )/i,
          );
      });
    }
    expect(batches.flat().filter((s) => /^delete from "dist_tag" /i.test(s.sql))).toHaveLength(1);
    const rows = await database.executor.batch([
      stmt(
        'SELECT tag, version_id FROM dist_tag WHERE org_id = ? AND package_id = ?',
        org.orgId,
        result.packageId,
      ),
      stmt(
        'SELECT tag, action, version_id, previous_version_id FROM dist_tag_history WHERE org_id = ? AND package_id = ?',
        org.orgId,
        result.packageId,
      ),
    ]);
    const targetId = await scalar(
      'SELECT id AS value FROM version WHERE org_id = ? AND version_normalized = ?',
      org.orgId,
      '1.0.1',
    );
    expect(rows[0]!.rows).toHaveLength(100);
    expect(rows[0]!.rows.map((row) => row['tag']).sort()).toEqual(Object.keys(tags).sort());
    expect(rows[0]!.rows.every((row) => row['version_id'] === targetId)).toBe(true);
    const history = rows[1]!.rows;
    expect(history).toHaveLength(103);
    expect(history.filter((row) => row['version_id'] === targetId)).toHaveLength(100);
    expect(history).toEqual(
      expect.arrayContaining([
        { tag: 'tag0', action: 'set', version_id: targetId, previous_version_id: previousId },
        { tag: 'obsolete', action: 'remove', version_id: null, previous_version_id: previousId },
      ]),
    );
    expect(await sync([], { tags })).toMatchObject({ refused: [], skippedTags: [] });
    expect(
      await scalar('SELECT count(*) AS value FROM dist_tag_history WHERE org_id = ?', org.orgId),
    ).toBe(103);
  });
  it.each(['node-sqlite', 'd1'] as const)(
    '%s keeps published tag revisions consistent after a second-batch failure and between batches',
    async (driver) => {
      let executor = database.executor;
      const ctx = org;
      if (driver === 'd1') {
        const { createD1Executor } = (await import(
          new URL('../../../runtime-cloudflare/src/db/d1-executor.ts', import.meta.url).href
        )) as { createD1Executor(binding: unknown): SqlExecutor };
        type Prepared = {
          statement: Statement;
          bind(...params: Statement['params']): Prepared;
          all(): Promise<{ results: Record<string, unknown>[]; meta: { changes: number } }>;
        };
        const prepare = (sql: string, params: Statement['params'] = []): Prepared => ({
          statement: { sql, params },
          bind: (...values) => prepare(sql, values),
          async all() {
            const [result] = await database.executor.batch([{ sql, params }]);
            return { results: result!.rows, meta: { changes: result!.changes } };
          },
        });
        // Exercise the production D1 adapter through a transactional SQLite-backed binding.
        executor = createD1Executor({
          prepare,
          async batch(statements: Prepared[]) {
            const results = await database.executor.batch(statements.map((s) => s.statement));
            return results.map((result) => ({
              results: result.rows,
              meta: { changes: result.changes },
            }));
          },
        });
      }
      expect(executor.driver).toBe(driver);
      const lease = createCatalogueWriteGuard(ctx, { id: 'job', owner: 'worker', fence: 1 });
      const request: SyncPackageInput = {
        sourceId: 'source',
        ecosystem: 'npm',
        key: 'widget',
        description: null,
        versions: [input(0), input(1)],
        tags: { latest: '1.0.0' },
      };
      const { packageId } = await createCatalogueWriter(executor).syncPackage(ctx, lease, request);
      const read = async () => {
        const results = await executor.batch([
          stmt(
            'SELECT rev, modified_at FROM package WHERE org_id = ? AND id = ?',
            ctx.orgId,
            packageId,
          ),
          stmt(
            'SELECT tag, version_id FROM dist_tag WHERE org_id = ? AND package_id = ? ORDER BY tag',
            ctx.orgId,
            packageId,
          ),
        ]);
        return {
          rev: Number(results[0]!.rows[0]!['rev']),
          modified_at: String(results[0]!.rows[0]!['modified_at']),
          tags: results[1]!.rows,
        };
      };
      const initial = await read();
      let previous = initial;
      let failAt = 2;
      let batchNumber = 0;
      let tagCommits = 0;
      const plannedBatches: Statement[][] = [];
      const checked = createCatalogueWriter({
        driver,
        all: executor.all.bind(executor),
        async batch(statements) {
          plannedBatches.push([...statements]);
          if (++batchNumber === failAt) throw new Error('injected batch failure');
          const result = await executor.batch(statements);
          // Read after commit and before the next batch can publish any further tags.
          const visible = await read();
          if (failAt === 0 && JSON.stringify(visible.tags) !== JSON.stringify(previous.tags)) {
            expect(visible.rev).toBeGreaterThan(previous.rev);
            expect(visible.modified_at > previous.modified_at).toBe(true);
            tagCommits++;
          }
          previous = visible;
          return result;
        },
      });
      const tags = Object.fromEntries(
        Array.from({ length: 100 }, (_, n) => [`tag${String(n)}`, '1.0.1']),
      );
      await expect(
        checked.syncPackage(ctx, lease, { ...request, versions: [], tags }),
      ).rejects.toThrow('injected batch failure');
      const partial = await read();
      expect(batchNumber).toBe(2);
      expect(partial.tags).not.toEqual(initial.tags);
      expect(partial.rev).toBeGreaterThan(initial.rev);
      expect(partial.modified_at > initial.modified_at).toBe(true);

      failAt = 0;
      batchNumber = 0;
      tagCommits = 0;
      plannedBatches.length = 0;
      const replacement = Object.fromEntries(Object.keys(tags).map((tag) => [tag, '1.0.0']));
      const result = await checked.syncPackage(ctx, lease, {
        ...request,
        versions: [],
        tags: replacement,
      });
      expect(tagCommits).toBeGreaterThan(1);
      expect(result.statements).toBe(plannedBatches.reduce((sum, batch) => sum + batch.length, 0));
      for (const batch of plannedBatches) {
        expect(batch.length).toBeLessThanOrEqual(200);
        expect(batch.slice(0, lease.length)).toEqual([...lease]);
        expect(batch.every((statement) => statement.params.length <= 100)).toBe(true);
        const bytes = batch
          .flatMap((statement) => statement.params)
          .reduce<number>(
            (sum, value) =>
              sum +
              (typeof value === 'string'
                ? new TextEncoder().encode(value).length
                : value instanceof Uint8Array
                  ? value.byteLength
                  : value === null
                    ? 0
                    : 8),
            0,
          );
        expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      }
      const complete = await read();
      expect(complete.tags).toHaveLength(100);
      const target = await executor.all<{ id: string }>(
        stmt(
          'SELECT id FROM version WHERE org_id = ? AND package_id = ? AND version_normalized = ?',
          ctx.orgId,
          packageId,
          '1.0.0',
        ),
      );
      expect(complete.tags.every((row) => row['version_id'] === target[0]!.id)).toBe(true);
      await checked.syncPackage(ctx, lease, { ...request, versions: [], tags: replacement });
      expect(await read()).toEqual(complete);
    },
    120_000,
  );
  it('reports update-builder refusals without counting them unchanged', async () => {
    await sync([input(0)]);
    const result = await sync([
      input(0, {
        metadata: normalizeVersionMetadata('npm', { name: 'widget', deprecated: 'é'.repeat(513) }),
      }),
      input(1),
    ]);
    expect(result).toMatchObject({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      conflicts: [],
      refused: [{ version: '1.0.0', reason: 'invalid' }],
    });
    expect(
      await scalar(
        'SELECT deprecated_message AS value FROM version WHERE org_id = ? AND version_normalized = ?',
        org.orgId,
        '1.0.0',
      ),
    ).toBeNull();
  });
  it('rejects future dates, expired leases, foreign guards and unbranded listings', async () => {
    await expect(
      sync([input(0, { history: { at: '2999-01-01T00:00:00.000Z', basis: 'release_date' } })]),
    ).rejects.toThrow();
    expect(await scalar('SELECT count(*) AS value FROM package')).toBe(0);
    await expect(
      writer.syncPackage(other, guard, {
        sourceId: 'source',
        ecosystem: 'npm',
        key: 'widget',
        description: null,
        versions: [],
      }),
    ).rejects.toThrow();
    await expect(
      writer.finalizeListing(org, guard, {
        packageId: 'missing',
        stamp: new Date().toISOString(),
        count: 0,
      } as never),
    ).rejects.toThrow();
    await database.executor.batch([
      stmt("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z'"),
    ]);
    await expect(sync([input(0)])).rejects.toThrow();
  });
});

const adminCases = [
  'attachSource',
  'detachSource',
  'setPrecedence',
  'setPackageFlag',
  'addPattern',
  'removePattern',
  'addExplicit',
  'removeExplicit',
  'quarantineVersion',
  'releaseQuarantine',
  'tombstoneVersion',
] as const;
describe('epoch contract', () => {
  it.each(adminCases.flatMap((method) => [[method, false] as const, [method, true] as const]))(
    '%s epoch contract, mutation=%s',
    async (method, mutation) => {
      const { packageId } = await sync([input(0)]);
      const id = await versionId();
      await store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source' });
      if (method === 'removePattern')
        await store.addPattern(org, fence(), {
          projectId: 'project',
          sourceId: 'source',
          pattern: '*',
          effect: 'include',
        });
      if (method === 'removeExplicit')
        await store.addExplicit(org, fence(), { projectId: 'project', packageId });
      if (method === 'releaseQuarantine')
        await store.quarantineVersion(org, fence(), { versionId: id, reason: 'admin_quarantine' });
      const before = await epoch();
      batches.length = 0;
      const calls = {
        attachSource: () =>
          store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source' }),
        detachSource: () =>
          store.detachSource(org, fence(), { projectId: 'project', sourceId: 'source' }),
        setPrecedence: () =>
          store.setPrecedence(org, fence(), {
            projectId: 'project',
            sourceId: 'source',
            precedence: 42,
          }),
        setPackageFlag: () =>
          store.setPackageFlag(org, fence(), { packageId, visibleToNewProjects: false }),
        addPattern: () =>
          store.addPattern(org, fence(), {
            projectId: 'project',
            sourceId: 'source',
            pattern: '*',
            effect: 'exclude',
          }),
        removePattern: () =>
          store.removePattern(org, fence(), {
            projectId: 'project',
            sourceId: 'source',
            pattern: '*',
          }),
        addExplicit: () => store.addExplicit(org, fence(), { projectId: 'project', packageId }),
        removeExplicit: () =>
          store.removeExplicit(org, fence(), { projectId: 'project', packageId }),
        quarantineVersion: () =>
          store.quarantineVersion(org, fence(), { versionId: id, reason: 'admin_quarantine' }),
        releaseQuarantine: () => store.releaseQuarantine(org, fence(), { versionId: id }),
        tombstoneVersion: () =>
          store.tombstoneVersion(org, fence(), { versionId: id, reason: 'admin_tombstone' }),
      };
      const contract = async () => {
        expect(await calls[method]()).toMatchObject({ ok: true });
        expect(await epoch()).not.toBe(before);
        expect(
          batches.filter((batch) => batch.some((s) => /update ["\s]*cache_epoch/i.test(s.sql))),
        ).toHaveLength(1);
      };
      if (mutation) {
        epochMutation = 'strip';
        await expect(contract()).rejects.toThrow();
      } else await contract();
    },
  );
  it('new catalogue content and replay do not bump; integrity quarantine does', async () => {
    const before = await epoch();
    await sync([input(0)]);
    expect(await epoch()).toBe(before);
    await sync([input(0)]);
    expect(await epoch()).toBe(before);
    expect(
      await writer.quarantine(org, guard, {
        versionId: await versionId(),
        reason: 'digest_mismatch',
      }),
    ).toMatchObject({ changed: true });
    expect(await epoch()).not.toBe(before);
  });
  it('maps every subset failure distinctly', () => {
    for (const reason of [
      'invalid_pattern',
      'too_many_patterns',
      'not_attached',
      'not_eligible',
      'indeterminate',
      'conflict',
      'not_found',
    ] as const)
      expect(subsetOutcome(reason)).toEqual({ ok: false, reason });
    expect(subsetOutcome('forbidden')).toEqual({ ok: false, reason: 'authority' });
    expect(subsetOutcome('failed')).toEqual({ ok: false, reason: 'unclassified' });
  });
});

const jobCases = [
  ['new catalogue rows', false],
  ['description', false],
  ['metadata update', false],
  ['tags', false],
  ['dist attach', false],
  ['quarantine', true],
  ['source removal exclude', true],
  ['source removal flag', false],
  ['source restoration exclude', true],
  ['source restoration flag', false],
  ['version removal exclude', true],
  ['version removal flag', false],
  ['version restoration exclude', true],
  ['version restoration flag', false],
  ['upstream absence exclude', true],
  ['upstream absence flag', false],
] as const;
it.each(
  jobCases.flatMap(([name, bump]) => [[name, bump, false] as const, [name, bump, true] as const]),
)('%s epoch bump=%s, mutation=%s', async (name, bump, mutation) => {
  const { packageId } = await sync([input(0), input(1)]);
  const id = await versionId();
  const excluded = name.endsWith('exclude');
  await database.executor.batch([
    stmt(
      'UPDATE source SET removal_policy = ? WHERE id = ?',
      excluded ? 'exclude' : 'flag',
      'source',
    ),
  ]);
  let action: () => Promise<unknown>;
  if (name.startsWith('source ') || name.startsWith('version ')) {
    const source = name.startsWith('source ');
    const restore = name.includes('restoration');
    const scope = source
      ? { kind: 'source' as const, sourceId: 'source' }
      : { kind: 'package' as const, packageId };
    if (source) await sync([], { key: 'other' });
    await database.executor.batch([
      stmt(
        `UPDATE ${source ? 'package' : 'version'} SET updated_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ?`,
        org.orgId,
      ),
    ]);
    const { stamp } = await writer.openListing(org, guard, scope);
    if (restore)
      await database.executor.batch([
        stmt(
          `UPDATE ${source ? 'package' : 'version'} SET status = 'removed_upstream', removed_upstream_at = '2020-01-01T00:00:00.000Z' WHERE org_id = ?`,
          org.orgId,
        ),
      ]);
    await writer.markListing(org, guard, {
      scope,
      stamp,
      present: source ? ['widget'] : ['1.0.0'],
    });
    if (restore)
      await database.executor.batch([
        stmt(
          `UPDATE ${source ? 'package' : 'version'} SET updated_at = ? WHERE org_id = ?`,
          stamp,
          org.orgId,
        ),
      ]);
    action = () =>
      writer.finalizeListing(
        org,
        guard,
        source
          ? completeSourceListing({ sourceId: 'source', stamp, count: 1 })
          : completeVersionListing({ packageId, stamp, count: 1 }),
      );
  } else if (name.startsWith('upstream absence')) {
    await database.executor.batch([
      stmt(
        "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at) VALUES (?, ?, 'npm-packument', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 2, '2020-01-01T00:00:00.000Z')",
        org.orgId,
        packageId,
      ),
    ]);
    action = () => writer.markPackageAbsent(org, guard, { packageId });
  } else if (name === 'quarantine')
    action = () => writer.quarantine(org, guard, { versionId: id, reason: 'manifest_conflict' });
  else if (name === 'description') action = () => sync([], { description: 'changed' });
  else if (name === 'metadata update')
    action = () =>
      sync([
        input(0, {
          metadata: normalizeVersionMetadata('npm', { name: 'widget', deprecated: 'old' }),
        }),
      ]);
  else if (name === 'tags') action = () => sync([], { tags: { latest: '1.0.0' } });
  else if (name === 'dist attach') {
    await database.executor.batch([
      stmt(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, media_type, refetchable) VALUES ('blob', ?, ?, 1, 'blob', 'application/octet-stream', 1)",
        org.orgId,
        'a'.repeat(64),
      ),
    ]);
    action = () =>
      writer.attachDist(org, guard, {
        versionId: id,
        revision: 1,
        sha256: 'a'.repeat(64) as import('@package-broker/core/platform/blob').Sha256,
      });
  } else action = () => sync([input(2)]);
  const before = await epoch();
  batches.length = 0;
  const contract = async () => {
    await action();
    if (bump) {
      expect(await epoch()).not.toBe(before);
      expect(
        batches.some(
          (batch) =>
            batch.some((s) => /update ["\s]*cache_epoch/i.test(s.sql)) &&
            batch.some((s) => /update ("?(version|package)"?) /i.test(s.sql)),
        ),
      ).toBe(true);
    } else expect(await epoch()).toBe(before);
  };
  if (mutation) {
    epochMutation = bump ? 'strip' : 'inject';
    await expect(contract()).rejects.toThrow();
  } else await contract();
});

it('rejects a duplicate slot once, leaving the first input counted', async () => {
  expect(await sync([input(0), input(0)])).toMatchObject({
    inserted: 1,
    updated: 0,
    unchanged: 0,
    refused: [{ version: '1.0.0', reason: 'invalid' }],
  });
});
it('splits a 50-version Composer update into guarded batches with exact counts', async () => {
  await database.executor.batch([
    stmt(
      "UPDATE source SET ecosystem = 'composer', type = 'composer_repository' WHERE id = 'source'",
    ),
  ]);
  const versions = Array.from({ length: 50 }, (_, n) =>
    input(n, {
      versionNormalized: `1.0.${String(n)}.0`,
      metadata: normalizeVersionMetadata('composer', { name: 'acme/widget' }),
    }),
  );
  const request = {
    sourceId: 'source',
    ecosystem: 'composer' as const,
    key: 'acme/widget',
    description: null,
    versions,
  };
  expect(await writer.syncPackage(org, guard, request)).toMatchObject({
    inserted: 50,
    unchanged: 0,
  });
  batches.length = 0;
  const result = await writer.syncPackage(org, guard, {
    ...request,
    versions: versions.map((v) => ({ ...v, sourceRef: 'new' })),
  });
  expect(result).toMatchObject({ inserted: 0, updated: 50, unchanged: 0 });
  expect(result.statements).toBe(batches.reduce((n, b) => n + b.length, 0));
  expect(batches.length).toBeGreaterThan(1);
});
it('rejects credential-bearing metadata at normalization and blob replacement at the adapter', async () => {
  expect(() =>
    normalizeVersionMetadata('npm', {
      dist: { tarball: 'https://registry.example.test/file?token=redacted' },
    }),
  ).toThrow();
  await sync([input(0)]);
  const id = await versionId();
  await database.executor.batch(
    ['a', 'b'].map((letter) =>
      stmt(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        letter,
        org.orgId,
        letter.repeat(64),
        letter,
      ),
    ),
  );
  const hash = (letter: string) =>
    letter.repeat(64) as import('@package-broker/core/platform/blob').Sha256;
  await writer.attachDist(org, guard, { versionId: id, revision: 1, sha256: hash('a') });
  await expect(
    writer.attachDist(org, guard, { versionId: id, revision: 1, sha256: hash('b') }),
  ).rejects.toThrow();
  await expect(
    writer.attachDist(org, guard, { versionId: id, revision: 2, sha256: hash('a') }),
  ).rejects.toThrow();
});
it('denies a project actor organization authority, hidden explicit admission and foreign ids', async () => {
  const { packageId } = await sync([input(0)]);
  await store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source' });
  await store.setPackageFlag(org, fence(), { packageId, visibleToNewProjects: false });
  await database.executor.batch([
    stmt(
      "DELETE FROM role_permission WHERE org_id = ? AND permission = 'org:sources:write'",
      org.orgId,
    ),
    stmt(
      "UPDATE access_grant SET scope = 'project', project_id = 'project' WHERE org_id = ?",
      org.orgId,
    ),
    stmt("UPDATE role SET scope = 'project' WHERE org_id = ?", org.orgId),
  ]);
  expect(
    await store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source' }),
  ).toMatchObject({ ok: false });
  expect(await store.addExplicit(org, fence(), { projectId: 'project', packageId })).toEqual({
    ok: false,
    reason: 'authority',
  });
  expect(
    await store.quarantineVersion(org, fence(), {
      versionId: await versionId(),
      reason: 'admin_quarantine',
    }),
  ).toEqual({ ok: false, reason: 'authority' });
  expect(
    await store.setPackageFlag(other, fence(), { packageId, visibleToNewProjects: true }),
  ).toMatchObject({ ok: false });
});
it('keeps explicit rows after exclusion and flag narrowing, and removes them on detach', async () => {
  const { packageId } = await sync([input(0)]);
  await store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source' });
  await store.addExplicit(org, fence(), { projectId: 'project', packageId });
  await store.addPattern(org, fence(), {
    projectId: 'project',
    sourceId: 'source',
    pattern: '*',
    effect: 'exclude',
  });
  await store.setPackageFlag(org, fence(), { packageId, visibleToNewProjects: false });
  expect(
    await scalar('SELECT origin AS value FROM project_package WHERE org_id = ?', org.orgId),
  ).toBe('explicit');
  await store.detachSource(org, fence(), { projectId: 'project', sourceId: 'source' });
  expect(
    await scalar('SELECT count(*) AS value FROM project_package WHERE org_id = ?', org.orgId),
  ).toBe(0);
});
it('counts an npm conflict with a deprecation change only once toward unchanged', async () => {
  await sync([input(0)]);
  expect(
    await sync([
      input(0, {
        metadata: normalizeVersionMetadata('npm', {
          name: 'widget',
          extra: true,
          deprecated: 'old',
        }),
      }),
    ]),
  ).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, conflicts: ['1.0.0'] });
});
