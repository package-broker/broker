import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import { describeMigrationLockContract } from './migration-lock-contract.js';

const initUrl = new URL('../../migrations/0001_init.sql', import.meta.url);

describeMigrationLockContract(
  'node:sqlite',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-migration-lock-'));
    const connections: OpenedExecutor[] = [];
    const connect = (): OpenedExecutor => {
      const opened = openNodeSqliteExecutor(join(directory, 'database.sqlite'));
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
  },
  async () => loadMigrationSource('core', '0001_init.sql', await readFile(initUrl, 'utf8')),
);
