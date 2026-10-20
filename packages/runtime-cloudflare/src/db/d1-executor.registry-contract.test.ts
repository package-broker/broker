import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { describeRegistryContract } from '@package-broker/db-sqlite/contract/registry-contract';
import {
  describeRegistryRaceContract,
  type RegistryRaceFixture,
} from '@package-broker/db-sqlite/contract/registry-race-contract';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 64 }, (_, index) => `RDB${index}`);
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

async function openPair() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  return {
    executor: createD1Executor(db),
    second: async () => createD1Executor(db),
    close: async () => {},
  };
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
  await migrateRace(opened.executor);
  return { a: opened.executor, b: await opened.second(), barrier, close: opened.close };
}

describeRegistryContract('d1', openPair);
describeRegistryRaceContract('d1 (two wrappers, one binding)', openRace);
