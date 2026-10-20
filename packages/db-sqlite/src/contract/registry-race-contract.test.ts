import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import {
  describeRegistryRaceContract,
  runRegistryRaceCase,
  type RegistryRaceFixture,
} from './registry-race-contract.js';

async function open(): Promise<RegistryRaceFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-registry-race-'));
  const database = await openMigratedDatabase({
    file: join(directory, 'race.sqlite'),
    d1PatternLimit: true,
  });
  return {
    a: database.executor,
    b: await database.second(),
    barrier() {
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
    },
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeRegistryRaceContract('node:sqlite (two connections, WAL)', open);

for (const order of ['a-first', 'b-first', 'reads-first'] as const) {
  it(`allows acquisition preflight reads before the write barrier (${order})`, async () => {
    const phases: string[] = [];
    const preflight = (executor: SqlExecutor): SqlExecutor => ({
      ...executor,
      async batch(statements) {
        if (!statements[0]?.sql.startsWith('insert into "ingest_session"'))
          return executor.batch(statements);
        const live = await executor.all({
          sql: `SELECT id FROM ingest_session WHERE org_id = ? AND state = 'running'
            AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          params: ['01J00000000000000000000A0A'],
        });
        phases.push('read');
        if (live.length > 0) return statements.map(() => ({ rows: [], changes: 0 }));
        const results = await executor.batch(statements);
        phases.push('write');
        return results;
      },
    });
    await runRegistryRaceCase(open, 'twoFillers', order, preflight);
    expect(phases).toEqual(
      order === 'reads-first' ? ['read', 'read', 'write', 'write'] : ['read', 'write', 'read'],
    );
  });
}

it('detects a dropped session guard on an expired filler batch', async () => {
  let changed = 0;
  const weaken = (executor: SqlExecutor): SqlExecutor => ({
    ...executor,
    batch(statements) {
      return executor.batch(
        statements.map((s) => {
          if (!s.sql.startsWith('with "guard_cond"') || !s.sql.includes('ingest_session')) return s;
          changed += 1;
          return { sql: 'SELECT 1', params: [] };
        }),
      );
    },
  });
  await expect(runRegistryRaceCase(open, 'expiredFiller', 'b-first', weaken)).rejects.toThrow(
    /promise resolved/,
  );
  expect(changed).toBeGreaterThan(0);
});

it('exports the shared race suite', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> };
  expect(manifest.exports['./contract/registry-race-contract']).toEqual({
    types: './dist/contract/registry-race-contract.d.ts',
    default: './dist/contract/registry-race-contract.js',
  });
});
