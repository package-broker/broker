import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeMigrationContract } from '@package-broker/db-sqlite/contract/migration-contract';
import { describeMigrationLockContract } from '@package-broker/db-sqlite/contract/migration-lock-contract';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function openPair() {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-migration-'));
  const path = join(directory, 'contract.db');
  const connections: ReturnType<typeof openBetterSqliteExecutor>[] = [];

  const connect = (): ReturnType<typeof openBetterSqliteExecutor> => {
    const opened = openBetterSqliteExecutor(path);
    connections.push(opened);
    return opened;
  };

  try {
    const primary = connect();
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
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function core0001() {
  return loadMigrationSource(
    'core',
    '0001_init.sql',
    await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'),
  );
}

describeMigrationContract('better-sqlite3', openPair, core0001);
describeMigrationLockContract('better-sqlite3', openPair, core0001);
