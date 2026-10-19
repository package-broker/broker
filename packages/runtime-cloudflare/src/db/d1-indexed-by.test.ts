import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext, ScalarStatement, SqlExecutor } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { compile, db } from '@package-broker/db-sqlite/kysely';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createBlobReferenceReader } from '@package-broker/db-sqlite/repositories/blob-references';
import { createCatalogueList } from '@package-broker/db-sqlite/repositories/catalogue-list';
import { createClosureEdges } from '@package-broker/db-sqlite/repositories/closure-edges';
import { createCatalogueLookup } from '@package-broker/db-sqlite/repositories/catalogue-lookup';
import { proxyEligibleCondition } from '@package-broker/db-sqlite/repositories/catalogue-predicates';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import { createCatalogueReader } from '@package-broker/db-sqlite/repositories/catalogue-read';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['DB'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

const SHA = 'a'.repeat(64);
const PAGE = { limit: 10 };
const PACKAGE = { projectId: 'P1', ecosystem: 'composer', key: 'acme/a' } as const;

let executor: SqlExecutor;
let a: OrgContext;

beforeAll(async () => {
  executor = createD1Executor((await mf.getD1Database('DB')) as unknown as D1DatabaseLike);
  await migrate(executor, await loadSources(), { holder: 'indexed-by' });
  ({ a } = await seedTwoOrganizations(executor));
  await executor.batch([
    {
      sql: 'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
      params: ['BLOB1', a.orgId, SHA, 'key-1'],
    },
    {
      sql: "INSERT INTO import_run (id, org_id, source_system, before_image_expires_at) VALUES ('RUN1', ?, 'x', NULL)",
      params: [a.orgId],
    },
    {
      sql: `INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json)
        VALUES ('REF1', ?, 'RUN1', 'version', 'V1', 'ext-1', 'update', ?)`,
      params: [a.orgId, JSON.stringify({ blob_id: 'BLOB1' })],
    },
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S1', ?, 'S1', 'composer', 'packagist_proxy')",
      params: [a.orgId],
    },
    {
      sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name, status) VALUES ('K1', ?, 'S1', 'composer', 'acme/a', 'active')",
      params: [a.orgId],
    },
    {
      sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('P1', ?, 'alpha', 'Alpha')",
      params: [a.orgId],
    },
    {
      sql: "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P1', 'S1')",
      params: [a.orgId],
    },
    {
      sql: "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P1', 'K1', 'subscription')",
      params: [a.orgId],
    },
    {
      sql: `INSERT INTO version (id, org_id, package_id, version, version_normalized,
        published_at, published_at_basis, metadata_json)
        VALUES ('V1', ?, 'K1', '1.0.0', '1.0.0', '2026-10-15T12:00:00.000Z', 'import_time', '{}')`,
      params: [a.orgId],
    },
  ]);
});

describe('INDEXED BY statements on D1', () => {
  async function keyringPlan(index: string): Promise<void> {
    const statements: ScalarStatement[] = [];
    const store = createKeyringVerifierStore({
      driver: executor.driver,
      all: (statement) => {
        statements.push(statement);
        return executor.all(statement);
      },
      batch: (queries) => executor.batch(queries),
    });
    expect(await store.checkUsedVersions([1, 2, 3, 4])).toBe(false);
    const statement = statements.find((query) => query.sql.includes(`INDEXED BY ${index}`));
    expect(statement).toBeDefined();
    if (statement === undefined) throw new Error('Missing keyring check');
    const plan = await executor.all<{ detail: string }>({
      ...statement,
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    });
    expect(plan.map((row) => row.detail).join(' ')).toContain(index);
  }
  it('keyring credential versions (credential_version_in_use)', async () => {
    await keyringPlan('credential_version_in_use');
  });
  it('keyring token versions (token_pepper_version)', async () => {
    await keyringPlan('token_pepper_version');
  });

  it('catalogue visible listing (package_by_name)', async () => {
    const result = await createCatalogueList(executor).listVisible(a, { ...PACKAGE, ...PAGE });
    expect(result.items.map((item) => item.packageId)).toEqual(['K1']);
  });

  it('catalogue search (package_by_name)', async () => {
    const rows = await createCatalogueList(executor).search(a, {
      ...PACKAGE,
      ...PAGE,
      text: 'acme',
    });
    expect(rows.map((item) => item.packageId)).toEqual(['K1']);
  });

  it('catalogue version lookup (version_identity)', async () => {
    const result = await createCatalogueLookup(executor).lookupVersion(a, {
      ...PACKAGE,
      versionNormalized: '1.0.0',
    });
    expect(result?.version.versionId).toBe('V1');
  });

  it('catalogue version pagination (version_by_published)', async () => {
    const result = await createCatalogueReader(executor).resolveVersions(a, {
      ...PACKAGE,
      ...PAGE,
    });
    expect(result).not.toBeNull();
    if (result === null || 'changed' in result) throw new Error('expected a version page');
    expect(result.versions.map((version) => version.versionId)).toEqual(['V1']);
  });

  it('blob-references retention candidates (import_ref_run_external)', async () => {
    const rows = await createBlobReferenceReader(executor).candidates(a, PAGE);
    expect(rows).toEqual([]);
  });

  it('blob-references scheduled ineligible (import_ref_run_external)', async () => {
    const rows = await createBlobReferenceReader(executor).scheduledIneligible(a, PAGE);
    expect(rows).toEqual([]);
  });

  it('blob-references still eligible (import_ref_run_external)', async () => {
    expect(await createBlobReferenceReader(executor).stillEligible(a, SHA)).toBe(false);
  });

  it('catalogue proxy eligibility (package_by_name)', async () => {
    const rows = await executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('package as pkg')
          .innerJoin('source as src', 'src.id', 'pkg.source_id')
          .select('pkg.id')
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    );
    expect(rows.map((row) => row.id)).toEqual(['K1']);
  });

  async function planOf(run: (recording: SqlExecutor) => Promise<unknown>): Promise<string> {
    const statements: ScalarStatement[] = [];
    await run({
      driver: executor.driver,
      all: async (statement) => {
        statements.push(statement as ScalarStatement);
        return executor.all(statement);
      },
      batch: (queries) => executor.batch(queries),
    });
    expect(statements).toHaveLength(1);
    const statement = statements[0] as ScalarStatement;
    const plan = await executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    return plan.map((row) => row.detail).join('\n');
  }

  it('closure edges page (package_by_name)', async () => {
    let page: Awaited<ReturnType<ReturnType<typeof createClosureEdges>['pageEdges']>> | undefined;
    const details = await planOf(async (recording) => {
      page = await createClosureEdges(recording).pageEdges(a, {
        projectId: 'P1',
        ecosystem: 'composer',
        limit: 10,
      });
    });
    expect(page?.rows.map((row) => row.versionId)).toEqual(['V1']);
    expect(details).toContain('USING INDEX package_by_name');
  });

  it('closure edges classify (package_by_name)', async () => {
    let classes: Awaited<ReturnType<ReturnType<typeof createClosureEdges>['classify']>> | undefined;
    const details = await planOf(async (recording) => {
      classes = await createClosureEdges(recording).classify(a, {
        projectId: 'P1',
        ecosystem: 'composer',
        keys: ['acme/a'],
      });
    });
    expect(classes).toEqual([{ key: 'acme/a', class: 'proxy_admissible' }]);
    expect(details).toContain('USING INDEX package_by_name');
  });
});
