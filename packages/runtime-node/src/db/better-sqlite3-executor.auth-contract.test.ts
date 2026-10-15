import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeAuthContract } from '@package-broker/db-sqlite/contract/auth-contract';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

async function openPair() {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-auth-'));
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

describeAuthContract('better-sqlite3', openPair);
