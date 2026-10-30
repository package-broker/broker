import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  describeMigrationContract,
  describeNpmPublishMigrationContract,
  describeSchemaEquivalenceContract,
  describeVulnerabilityMigrationContract,
} from '@package-broker/db-sqlite/contract/migration-contract';
import { describeMigrationLockContract } from '@package-broker/db-sqlite/contract/migration-lock-contract';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 200 }, (_, index) => `MDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

async function openPair() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  return {
    executor: createD1Executor(db),
    second: async () => createD1Executor(db),
    close: async () => {},
  };
}

async function firstCoreMigration() {
  const [first] = await discoveredMigrations();
  if (first === undefined) throw new Error('no core migrations were discovered');
  return first;
}

describeMigrationContract('d1', openPair, firstCoreMigration);
describeMigrationLockContract('d1', openPair, firstCoreMigration);

describeVulnerabilityMigrationContract('d1', openPair);

describeSchemaEquivalenceContract('d1', openPair);

describeNpmPublishMigrationContract('d1', openPair);
