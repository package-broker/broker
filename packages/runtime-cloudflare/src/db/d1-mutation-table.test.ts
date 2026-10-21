import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { createIngestSessions } from '@package-broker/db-sqlite/repositories/ingest-session';
import { createUpstreamStateRepository } from '@package-broker/db-sqlite/repositories/upstream-state';
import { createSourceRepository } from '@package-broker/db-sqlite/repositories/source';
import { createDistResolver } from '@package-broker/db-sqlite/repositories/catalogue-dist';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const FUTURE = '2099-01-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const bindings = Array.from({ length: 16 }, (_, index) => `MUTATION${index}`);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;
afterAll(() => mf.dispose());

interface Fixture {
  readonly own: OrgContext;
  readonly foreign: OrgContext;
  readonly executor: SqlExecutor;
  seed(sql: string, ...params: (string | number | null)[]): Promise<void>;
}
interface IsolationCase {
  readonly factory: string;
  readonly predicate: RegExp;
  run(fixture: Fixture): Promise<void>;
}

const cases: readonly IsolationCase[] = [
  {
    factory: 'createIngestSessions',
    predicate: /ingest_session\.org_id = \?/,
    async run({ own, foreign, executor, seed }) {
      await seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'source', 'npm', 'npm_registry')",
        own.orgId,
      );
      await seed(
        "INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, generation, owner, fence, lease_until, state, started_at, updated_at) VALUES ('I', ?, 'source', ?, 'S', 1, 'worker', 3, ?, 'running', ?, ?)",
        foreign.orgId,
        HASH,
        FUTURE,
        FUTURE,
        FUTURE,
      );
      const handle = {
        id: 'I',
        owner: 'worker',
        fence: 3,
        scopeKey: HASH,
        leaseSeconds: 60,
        generation: 1,
        stamp: null,
        snapshotId: null,
        snapshotBlobSha256: null,
        cursor: null,
        seenCount: 0,
        pagesSoFar: 0,
        pendingValidators: null,
      };
      expect(
        await createIngestSessions(executor).start(own, handle, {
          stamp: 'stamp',
          snapshot: { id: 'snapshot' },
        }),
      ).toBe(false);
    },
  },
  {
    factory: 'createUpstreamStateRepository',
    predicate: /"org_id" = \?/,
    async run({ own, foreign, executor, seed }) {
      await seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'source', 'npm', 'npm_registry')",
        own.orgId,
      );
      await seed(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K', ?, 'S', 'npm', 'widget')",
        own.orgId,
      );
      await seed(
        "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until) VALUES (?, 'K', 'npm-packument', ?, ?)",
        foreign.orgId,
        FUTURE,
        FUTURE,
      );
      expect(
        await createUpstreamStateRepository(executor).get(own, 'K', 'npm-packument'),
      ).toBeNull();
    },
  },
  {
    factory: 'createSourceRepository',
    predicate: /"org_id" = \?/,
    async run({ own, foreign, executor, seed }) {
      await seed(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'P')",
        own.orgId,
      );
      await seed(
        "INSERT INTO source (id, org_id, project_id, name, ecosystem, type) VALUES ('S', ?, 'P', 'source', 'npm', 'npm_registry')",
        foreign.orgId,
      );
      expect(await createSourceRepository(executor).get(own, 'S')).toBeNull();
    },
  },
  {
    factory: 'createDistResolver',
    predicate: /b\.org_id = \?/,
    async run({ own, foreign, executor, seed }) {
      await seed(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'P')",
        own.orgId,
      );
      await seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'source', 'npm', 'npm_registry')",
        own.orgId,
      );
      await seed(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K', ?, 'S', 'npm', 'widget')",
        own.orgId,
      );
      await seed(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('V', ?, 'K', '1.0.0', '1.0.0', '2020-01-01T00:00:00.000Z', 'upstream', '{}')",
        own.orgId,
      );
      await seed(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        own.orgId,
      );
      await seed(
        "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P' AS project_id, 'K' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.org_id = input.org_id AND p.id = input.package_id",
        own.orgId,
      );
      await seed(
        "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('B', ?, ?, 10, 'b')",
        foreign.orgId,
        HASH,
      );
      await seed("UPDATE version SET blob_id = 'B' WHERE id = 'V'");
      expect(
        await createDistResolver(executor).resolveDist(own, {
          projectId: 'P',
          ecosystem: 'npm',
          key: 'widget',
          by: 'version',
          versionNormalized: '1.0.0',
        }),
      ).toMatchObject({ versionId: 'V', blob: null });
    },
  },
];

async function run(contractCase: IsolationCase, strip: boolean): Promise<void> {
  const binding = bindings[next++];
  if (binding === undefined) throw new Error('out of D1 mutation bindings');
  const executor = createD1Executor((await mf.getD1Database(binding)) as unknown as D1DatabaseLike);
  await migrate(executor, await discoveredMigrations(), { holder: 'mutation-table' });
  const orgs = await seedTwoOrganizations(executor);
  let seen = 0;
  const mutate = (statement: Statement): Statement => {
    const sql = statement.sql.replace(new RegExp(contractCase.predicate.source, 'g'), (found) => {
      seen += 1;
      return strip ? '(? is not null)' : found;
    });
    return { sql, params: statement.params };
  };
  await contractCase.run({
    own: orgs.a,
    foreign: orgs.b,
    executor: {
      driver: executor.driver,
      all: (statement) => executor.all(mutate(statement)),
      batch: (statements) => executor.batch(statements.map(mutate)),
    },
    async seed(sql, ...params) {
      const [result] = await executor.batch([{ sql, params }]);
      if (/^INSERT INTO project_package \(/i.test(sql)) expect(result?.changes).toBe(1);
    },
  });
  expect(seen).toBe(1);
}

describe('D1 production factory child isolation', () => {
  for (const contractCase of cases) {
    it(`${contractCase.factory} rejects a mismatched child organization`, async () => {
      await run(contractCase, false);
      await expect(run(contractCase, true)).rejects.toMatchObject({ name: 'AssertionError' });
    }, 120_000);
  }
});
