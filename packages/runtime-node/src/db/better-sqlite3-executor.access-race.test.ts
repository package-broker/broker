import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeAccessRace,
  type OpenedRaceDatabase,
} from '@package-broker/db-sqlite/contract/access-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

async function openMigrated(): Promise<OpenedRaceDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-race-'));
  const path = join(directory, 'contract.db');
  const connections: ReturnType<typeof openBetterSqliteExecutor>[] = [];
  const connect = (): ReturnType<typeof openBetterSqliteExecutor> => {
    const opened = openBetterSqliteExecutor(path);
    connections.push(opened);
    return opened;
  };

  try {
    const primary = connect();
    await migrate(primary.executor, await discoveredMigrations(), { holder: 'access-race' });
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

describeAccessRace('better-sqlite3', openMigrated);
