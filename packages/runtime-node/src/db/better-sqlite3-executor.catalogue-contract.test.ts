import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { describeCatalogueRaceContract } from '@package-broker/db-sqlite/contract/catalogue-race-contract';
import { describeCatalogueReadContract } from '@package-broker/db-sqlite/contract/catalogue-read-contract';
import { describeCatalogueWriteContract } from '@package-broker/db-sqlite/contract/catalogue-write-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

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
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-catalogue-'));
  const path = join(directory, 'contract.db');
  const connections: ReturnType<typeof openBetterSqliteExecutor>[] = [];

  const connect = (): ReturnType<typeof openBetterSqliteExecutor> => {
    const opened = openBetterSqliteExecutor(path);
    connections.push(opened);
    return opened;
  };

  try {
    const primary = connect();
    await migrate(primary.executor, await loadSources(), { holder: 'catalogue-contract' });
    return {
      executor: primary.executor,
      second: async () => connect().executor,
      close: async () => {
        try {
          for (const connection of connections) await connection.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    for (const connection of connections) await connection.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const wrap = (executor: SqlExecutor): SqlExecutor => ({
  ...executor,
  all: (statement) => executor.all(statement),
  batch: (statements) => executor.batch(statements),
});

describeCatalogueReadContract('better-sqlite3', openPair, wrap);
describeCatalogueWriteContract('better-sqlite3', openPair);
describeCatalogueRaceContract('better-sqlite3', openPair);
