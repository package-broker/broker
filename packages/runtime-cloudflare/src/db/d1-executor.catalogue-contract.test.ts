import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  describeCatalogueRaceContract,
  runCatalogueRaceCase,
} from '@package-broker/db-sqlite/contract/catalogue-race-contract';
import { describeCatalogueReadContract } from '@package-broker/db-sqlite/contract/catalogue-read-contract';
import {
  describeCatalogueWriteContract,
  describeBlobSupersededContract,
  describeNpmPublishWriterContract,
} from '@package-broker/db-sqlite/contract/catalogue-write-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';
import { bridgedD1Database, D1_BRIDGE_SCRIPT } from './d1-bridge.test.support.js';

const bindings = Array.from({ length: 256 }, (_, index) => `CDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: D1_BRIDGE_SCRIPT,
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

function database(): D1DatabaseLike {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  return bridgedD1Database(binding, (body) =>
    mf.dispatchFetch('http://catalogue.test/', { method: 'POST', body }),
  );
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
  const db = database();
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

for (const order of ['first-then-second', 'second-then-first'] as const) {
  it(`D1 restore and discovery complete in the requested order (${order})`, async () => {
    const completed: string[] = [];
    await runCatalogueRaceCase(openPair, 'projectRestoreVsDiscovery', order, (executor) => ({
      ...executor,
      async batch(statements) {
        const result = await executor.batch(statements);
        if (statements.some((s) => s.sql.startsWith("UPDATE project SET status = 'active'"))) {
          completed.push('restore');
        }
        if (
          statements.some(
            (s) => /^insert into "package" /i.test(s.sql) && s.params.includes('fresh'),
          )
        ) {
          completed.push('discovery');
        }
        return result;
      },
    }));
    expect(completed).toEqual(
      order === 'first-then-second' ? ['restore', 'discovery'] : ['discovery', 'restore'],
    );
  });
}

describeNpmPublishWriterContract('d1', openPair);

describeBlobSupersededContract('d1', openPair);
