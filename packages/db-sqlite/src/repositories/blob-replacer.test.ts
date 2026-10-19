import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createBlobReplacer } from './blob-replacer.js';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let guard: ReturnType<typeof createCatalogueWriteGuard>;
let writer: ReturnType<typeof createCatalogueWriter>;
let replacer: ReturnType<typeof createBlobReplacer>;
let batches: Statement[][];
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const input = (n: number) => ({
  version: `1.0.${String(n)}`,
  versionNormalized: `1.0.${String(n)}`,
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  history: { at: '2020-01-01T00:00:00.000Z', basis: 'release_date' as const },
  metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
});
const sync = (versions: ReturnType<typeof input>[]) =>
  writer.syncPackage(org, guard, {
    sourceId: 'source',
    ecosystem: 'npm',
    key: 'widget',
    description: null,
    versions,
  });
async function scalar(sql: string, ...params: Statement['params']) {
  return (await database.executor.all(stmt(sql, ...params)))[0]?.['value'];
}
const versionId = () =>
  scalar(
    'SELECT id AS value FROM version WHERE org_id = ? ORDER BY version LIMIT 1',
    org.orgId,
  ) as Promise<string>;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  org = database.orgs!.a;
  other = database.orgs!.b;
  await database.executor.batch([
    stmt(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
      org.orgId,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
  writer = createCatalogueWriter(database.executor);
  batches = [];
  replacer = createBlobReplacer({
    driver: database.executor.driver,
    all: () => {
      throw new Error('replacement must use a batch');
    },
    async batch(statements) {
      batches.push([...statements]);
      return database.executor.batch(statements);
    },
  });
});
afterEach(() => database.close());

describe('catalogue blob replacement adapter', () => {
  const hash = (letter: string) => letter.repeat(64) as Sha256;

  async function seedReplacement() {
    await sync([input(0), input(1)]);
    await database.executor.batch([
      stmt(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('other-job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
        other.orgId,
      ),
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('other-source', ?, 'main', 'npm', 'npm_registry')",
        other.orgId,
      ),
      ...[org, other].flatMap((ctx, index) =>
        ['a', 'b'].map((letter) =>
          stmt(
            'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
            `${letter}-${String(index)}`,
            ctx.orgId,
            hash(letter),
            `${letter}-${String(index)}`,
          ),
        ),
      ),
    ]);
    const foreignGuard = createCatalogueWriteGuard(other, {
      id: 'other-job',
      owner: 'worker',
      fence: 1,
    });
    await writer.syncPackage(other, foreignGuard, {
      sourceId: 'other-source',
      ecosystem: 'npm',
      key: 'widget',
      description: null,
      versions: [input(0)],
    });
    const id = await versionId();
    const foreignId = (await scalar(
      'SELECT id AS value FROM version WHERE org_id = ?',
      other.orgId,
    )) as string;
    await writer.attachDist(org, guard, { versionId: id, revision: 1, sha256: hash('a') });
    await writer.attachDist(other, foreignGuard, {
      versionId: foreignId,
      revision: 1,
      sha256: hash('a'),
    });
    batches.length = 0;
    return {
      versionId: id,
      expectedRevision: 1,
      oldBlobId: 'a-0',
      newSha256: hash('b'),
      reason: 'refetch_changed' as const,
    };
  }

  async function snapshot(ctx?: OrgContext) {
    return Promise.all(
      ['package', 'version', 'version_revision', 'blob', 'cache_epoch', 'job'].map((table) =>
        database.executor.all(
          stmt(
            `SELECT * FROM ${table}${ctx ? ' WHERE org_id = ?' : ''} ORDER BY rowid`,
            ...(ctx ? [ctx.orgId] : []),
          ),
        ),
      ),
    );
  }

  it('replaces in one bounded batch without change counts and preserves the other organization', async () => {
    const request = await seedReplacement();
    const foreignBefore = await snapshot(other);
    const otherVersions = () =>
      database.executor.all(
        stmt(
          'SELECT * FROM version WHERE org_id = ? AND id <> ? ORDER BY id',
          org.orgId,
          request.versionId,
        ),
      );
    const otherVersionsBefore = await otherVersions();
    const packageRev = await scalar('SELECT rev AS value FROM package WHERE org_id = ?', org.orgId);
    const checked = createBlobReplacer({
      driver: database.executor.driver,
      all: () => {
        throw new Error('replacement must use a batch');
      },
      async batch(statements) {
        batches.push([...statements]);
        for (const statement of statements)
          expect(statement.params.length).toBeLessThanOrEqual(100);
        return (await database.executor.batch(statements)).map((result) => ({
          ...result,
          changes: 0,
        }));
      },
    });
    expect(await checked.replaceBlob(org, guard, request)).toEqual({
      changed: true,
      statements: 6,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(6);
    expect(
      await database.executor.all(
        stmt(
          'SELECT blob_id, revision FROM version WHERE org_id = ? AND id = ?',
          org.orgId,
          request.versionId,
        ),
      ),
    ).toEqual([{ blob_id: 'b-0', revision: 2 }]);
    expect(
      await database.executor.all(
        stmt(
          'SELECT blob_id, revision, reason FROM version_revision WHERE org_id = ? AND version_id = ?',
          org.orgId,
          request.versionId,
        ),
      ),
    ).toEqual([{ blob_id: 'a-0', revision: 1, reason: 'refetch_changed' }]);
    expect(await scalar('SELECT rev AS value FROM package WHERE org_id = ?', org.orgId)).toBe(
      Number(packageRev) + 1,
    );
    expect(await snapshot(other)).toEqual(foreignBefore);
    expect(await otherVersions()).toEqual(otherVersionsBefore);
  });

  it.each(['stale fence', 'foreign version', 'stale revision'] as const)(
    'refuses a %s without writes',
    async (failure) => {
      const request = await seedReplacement();
      const lease =
        failure === 'stale fence'
          ? createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 2 })
          : guard;
      if (failure === 'foreign version') {
        request.versionId = (await scalar(
          'SELECT id AS value FROM version WHERE org_id = ?',
          other.orgId,
        )) as string;
        request.oldBlobId = 'a-1';
      }
      if (failure === 'stale revision') request.expectedRevision = 2;
      const before = await snapshot();
      await expect(replacer.replaceBlob(org, lease, request)).rejects.toThrow(
        ACCESS_MUTATION_GUARD_CONSTRAINT,
      );
      expect(batches).toHaveLength(1);
      expect(await snapshot()).toEqual(before);
    },
  );
});
