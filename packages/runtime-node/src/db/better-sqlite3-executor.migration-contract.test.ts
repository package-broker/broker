import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeMigrationContract,
  describeVulnerabilityMigrationContract,
} from '@package-broker/db-sqlite/contract/migration-contract';
import { describeMigrationLockContract } from '@package-broker/db-sqlite/contract/migration-lock-contract';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

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

async function firstCoreMigration() {
  const [first] = await discoveredMigrations();
  if (first === undefined) throw new Error('no core migrations were discovered');
  return first;
}

describeMigrationContract('better-sqlite3', openPair, firstCoreMigration);
describeMigrationLockContract('better-sqlite3', openPair, firstCoreMigration);

describeVulnerabilityMigrationContract('better-sqlite3', openPair);
