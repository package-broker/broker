import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createPackageIdReads } from '@package-broker/db-sqlite/repositories/package-id';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['PACKAGE_ID'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describe('D1 package id read', () => {
  it('returns the own-organization id and null for another organization', async () => {
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
      (await mf.getD1Database('PACKAGE_ID')) as unknown as D1DatabaseLike,
    );
    await migrate(d1, sources, { holder: 'package-id-test' });
    const { a: ctx, b: other } = await seedTwoOrganizations(d1);
    const run = (sql: string, ...params: (string | number)[]) => d1.all({ sql, params });
    await run(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S1', ?, 'S1', 'composer', 'vcs')",
      ctx.orgId,
    );
    await run(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('K1', ?, 'S1', 'composer', 'acme/widget')",
      ctx.orgId,
    );
    const reads = createPackageIdReads(d1);
    expect(await reads.packageId(ctx, 'S1', 'acme/widget')).toBe('K1');
    expect(await reads.packageId(other, 'S1', 'acme/widget')).toBeNull();
  });
});
