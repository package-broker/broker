import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { ScalarStatement } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createRegistryReads } from '@package-broker/db-sqlite/repositories/registry-reads';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['REGISTRY_READS'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describe('D1 registry reads', () => {
  it('answers covers and versionById over many rows within the parameter bound', async () => {
    const require = createRequire(import.meta.url);
    const directory = join(
      dirname(require.resolve('@package-broker/db-sqlite/package.json')),
      'migrations',
    );
    const sources = await Promise.all(
      readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) =>
          loadMigrationSource('core', name, readFileSync(join(directory, name), 'utf8')),
        ),
    );
    const d1 = createD1Executor(
      (await mf.getD1Database('REGISTRY_READS')) as unknown as D1DatabaseLike,
    );
    await migrate(d1, sources, { holder: 'registry-reads-test' });
    const { a: ctx, b: other } = await seedTwoOrganizations(d1);
    const seen: ScalarStatement[] = [];
    const executor = {
      all: async (statement: ScalarStatement) => {
        seen.push(statement);
        return d1.all(statement);
      },
      batch: (statements: readonly ScalarStatement[]) => d1.batch(statements),
    } as typeof d1;
    const run = (sql: string, ...params: (string | number)[]) => d1.all({ sql, params });
    await run(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S1', ?, 'S1', 'composer', 'vcs')",
      ctx.orgId,
    );
    await run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern)
       SELECT 'R' || i, ?, 'S1', 'composer', 'vendor' || i || '/*' FROM n`,
      500,
      ctx.orgId,
    );
    await run(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K1', ?, 'S1', 'composer', 'vendor9/pkg')",
      ctx.orgId,
    );
    await run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                            published_at_basis, metadata_json)
       SELECT 'V' || i, ?, 'K1', '1.0.' || i, '1.0.' || i || '.0', '2020-01-01T00:00:00.000Z',
              'import_time', '{}' FROM n`,
      300,
      ctx.orgId,
    );
    const reads = createRegistryReads(executor);
    expect(await reads.covers(ctx, 'S1', 'vendor437/pkg')).toBe(true);
    expect(await reads.covers(ctx, 'S1', 'vendor501/pkg')).toBe(false);
    expect(await reads.covers(other, 'S1', 'vendor437/pkg')).toBe(false);
    expect(await reads.versionById(ctx, { packageId: 'K1', versionId: 'V250' })).toEqual({
      packageName: 'vendor9/pkg',
      version: '1.0.250',
    });
    expect(await reads.versionById(other, { packageId: 'K1', versionId: 'V250' })).toBeNull();
    expect(await reads.versionById(ctx, { packageId: 'K1', versionId: 'V301' })).toBeNull();
    expect(seen.length).toBe(6);
    for (const statement of seen) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});
