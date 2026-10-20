import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { describeRegistryContract } from '@package-broker/db-sqlite/contract/registry-contract';
import {
  describeRegistryRaceContract,
  type RegistryRaceFixture,
} from '@package-broker/db-sqlite/contract/registry-race-contract';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

async function openPair() {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-registry-'));
  const path = join(directory, 'contract.db');
  const connections: ReturnType<typeof openBetterSqliteExecutor>[] = [];
  const connect = () => {
    const opened = openBetterSqliteExecutor(path, { busyTimeoutMs: 5000 });
    connections.push(opened);
    return opened.executor;
  };
  const close = async () => {
    try {
      for (const connection of connections) await connection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    return { executor: connect(), second: async () => connect(), close };
  } catch (error) {
    await close();
    throw error;
  }
}

const barrier: RegistryRaceFixture['barrier'] = () => {
  let arrive = () => undefined as void;
  let release = () => undefined as void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async wait() {
      arrive();
      await released;
    },
  };
};

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrateRace(executor: RegistryRaceFixture['a']) {
  const sources = await Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
  await migrate(executor, sources, { holder: 'registry-race-contract' });
}

async function openRace(): Promise<RegistryRaceFixture> {
  const opened = await openPair();
  try {
    await migrateRace(opened.executor);
    return { a: opened.executor, b: await opened.second(), barrier, close: opened.close };
  } catch (error) {
    await opened.close();
    throw error;
  }
}

describeRegistryContract('better-sqlite3', openPair);
describeRegistryRaceContract('better-sqlite3 (two connections, WAL)', openRace);
