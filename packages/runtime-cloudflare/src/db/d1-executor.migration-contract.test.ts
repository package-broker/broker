import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describeMigrationContract } from '@package-broker/db-sqlite/contract/migration-contract';
import { describeMigrationLockContract } from '@package-broker/db-sqlite/contract/migration-lock-contract';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 64 }, (_, index) => `MDB${index}`);

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

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function core0001() {
  return loadMigrationSource(
    'core',
    '0001_init.sql',
    await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'),
  );
}

describeMigrationContract('d1', openPair, core0001);
describeMigrationLockContract('d1', openPair, core0001);
