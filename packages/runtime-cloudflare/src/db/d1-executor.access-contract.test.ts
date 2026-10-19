import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  describeAccessContract,
  revokeLatch,
  runAccessContract,
  type OpenedAccessDatabase,
} from '@package-broker/db-sqlite/contract/access-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 64 }, (_, index) => `ACDB${index}`);

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

async function openMigrated(): Promise<OpenedAccessDatabase> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await loadSources(), { holder: 'access-contract' });
  return { executor, second: async () => createD1Executor(db), close: async () => {} };
}

describeAccessContract('d1', openMigrated);

describe('access contract: d1 double revoke latch', () => {
  for (const order of ['arrival', 'reverse'] as const) {
    it(`releases the competing revokes in ${order} order`, async () => {
      const latch = revokeLatch(order);
      await runAccessContract('doubleRevoke', openMigrated, latch.wrap);
      expect(latch.released()).toEqual(order === 'arrival' ? [0, 1] : [1, 0]);
    }, 120_000);
  }
});

async function guardKeys(executor: SqlExecutor): Promise<unknown[]> {
  return executor.all({ sql: 'SELECT key FROM access_mutation_guard ORDER BY key', params: [] });
}

describe('d1 fenced batch on miniflare', () => {
  it('a guard-key failure rolls back the statements before and after it', async () => {
    const { executor } = await openMigrated();
    const insert = (key: string) => ({
      sql: 'INSERT INTO access_mutation_guard (key) VALUES (?)',
      params: [key],
    });

    const error = await executor
      .batch([insert('K1'), insert('K2'), insert('K2'), insert('K3')])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('unique');
    expect(await guardKeys(executor)).toEqual([]);
  }, 60_000);

  it('enforces foreign keys', async () => {
    const { executor } = await openMigrated();
    const error = await executor
      .batch([
        {
          sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          params: ['user-x', 'missing-org', 'x@example.test'],
        },
      ])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('foreign_key');
  }, 60_000);
});
