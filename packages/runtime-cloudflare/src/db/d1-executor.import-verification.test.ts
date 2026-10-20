import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describeImportVerificationContract } from '@package-broker/db-sqlite/contract/import-verification-contract';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 24 }, (_, i) => `VERIFY${i}`);
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

describeImportVerificationContract(async () => {
  const binding = bindings[next++];
  if (binding === undefined) throw new Error('out of D1 bindings');
  const executor = createD1Executor((await mf.getD1Database(binding)) as unknown as D1DatabaseLike);
  await migrate(executor, await discoveredMigrations(), { holder: 'verification-test' });
  const orgs = await seedTwoOrganizations(executor);
  return { executor, ctx: orgs.a, close: async () => undefined };
});
