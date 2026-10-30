import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from '../testing/node-sqlite-executor.js';
import {
  describeMigrationContract,
  describeNpmPublishMigrationContract,
  describeNpmIdentityMigrationContract,
  type OpenedPair,
} from './migration-contract.js';

async function openPair(): Promise<OpenedPair> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-migration-contract-'));
  const path = join(directory, 'contract.sqlite');
  const first = openNodeSqliteExecutor(path, { d1PatternLimit: true });
  const opened: OpenedExecutor[] = [first];

  return {
    executor: first.executor,
    async second() {
      const second = openNodeSqliteExecutor(path, { d1PatternLimit: true });
      opened.push(second);
      return second.executor;
    },
    async close() {
      await Promise.all(opened.map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeMigrationContract('node:sqlite', openPair, async () =>
  loadMigrationSource(
    'core',
    '0001_init.sql',
    await readFile(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'),
  ),
);

it('registers npm publish contracts explicitly at every backend entrypoint', async () => {
  const shared = await readFile(new URL('./migration-contract.ts', import.meta.url), 'utf8');
  expect(shared).not.toContain('describeNpmPublishMigrationContract(name, open)');
  expect(shared.startsWith("import { readFileSync } from 'node:fs';")).toBe(true);
  for (const path of [
    '../../../runtime-node/src/db/better-sqlite3-executor.migration-contract.test.ts',
    '../../../runtime-cloudflare/src/db/d1-executor.migration-contract.test.ts',
  ]) {
    expect(await readFile(new URL(path, import.meta.url), 'utf8')).toMatch(
      /describeNpmPublishMigrationContract\('(?:better-sqlite3|d1)', openPair\)/,
    );
  }
});

describeNpmPublishMigrationContract('node:sqlite', openPair);

describeNpmIdentityMigrationContract('node:sqlite', openPair);
