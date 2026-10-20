import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { describeCatalogueRaceContract } from '@package-broker/db-sqlite/contract/catalogue-race-contract';
import { describeCatalogueReadContract } from '@package-broker/db-sqlite/contract/catalogue-read-contract';
import { describeCatalogueWriteContract } from '@package-broker/db-sqlite/contract/catalogue-write-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 96 }, (_, index) => `CDB${index}`);

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

async function database(): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  return (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
}

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

async function openPair() {
  const db = await database();
  const executor = createD1Executor(db);
  await migrate(executor, await loadSources(), { holder: 'catalogue-contract' });
  return {
    executor,
    second: async () => createD1Executor(db),
    close: async () => {},
  };
}

const wrap = (executor: SqlExecutor): SqlExecutor => ({
  ...executor,
  all: (statement) => executor.all(statement),
  batch: (statements) => executor.batch(statements),
});

describeCatalogueReadContract('d1', openPair, wrap, { d1: true });
describeCatalogueWriteContract('d1', openPair);
describeCatalogueRaceContract('d1', openPair);
