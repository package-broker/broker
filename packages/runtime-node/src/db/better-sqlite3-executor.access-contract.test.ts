import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import {
  describeAccessContract,
  revokeLatch,
  runAccessContract,
  type OpenedAccessDatabase,
} from '@package-broker/db-sqlite/contract/access-contract';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

async function openMigrated(): Promise<OpenedAccessDatabase & { readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-access-'));
  const path = join(directory, 'contract.db');
  const connections: ReturnType<typeof openBetterSqliteExecutor>[] = [];
  const connect = (): ReturnType<typeof openBetterSqliteExecutor> => {
    const opened = openBetterSqliteExecutor(path);
    connections.push(opened);
    return opened;
  };

  try {
    const primary = connect();
    await migrate(primary.executor, await discoveredMigrations(), { holder: 'access-contract' });
    return {
      path,
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

describeAccessContract('better-sqlite3', openMigrated);

describe('access contract: better-sqlite3 double revoke latch', () => {
  for (const order of ['arrival', 'reverse'] as const) {
    it(`releases the competing revokes in ${order} order`, async () => {
      const latch = revokeLatch(order);
      await runAccessContract('doubleRevoke', openMigrated, latch.wrap);
      expect(latch.released()).toEqual(order === 'arrival' ? [0, 1] : [1, 0]);
    }, 120_000);
  }
});

describe('better-sqlite3 fenced batch transaction', () => {
  it('takes the write lock up front: a batch of reads is refused while another connection holds it', async () => {
    const database = await openMigrated();
    const holder = new Database(database.path);
    try {
      const contender = openBetterSqliteExecutor(database.path, { busyTimeoutMs: 50 });
      holder.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      const error = await contender.executor
        .batch([{ sql: 'SELECT 1 AS one', params: [] }])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).kind).toBe('busy');
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      holder.exec('ROLLBACK');
      expect(await contender.executor.batch([{ sql: 'SELECT 1 AS one', params: [] }])).toHaveLength(
        1,
      );
      await contender.close();
    } finally {
      holder.close();
      await database.close();
    }
  });

  it('rolls back every earlier statement when a later one fails', async () => {
    const database = await openMigrated();
    try {
      const guard = {
        sql: 'INSERT INTO access_mutation_guard (key) VALUES (?)',
        params: ['K1'],
      };
      const error = await database.executor
        .batch([guard, guard])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).kind).toBe('unique');
      expect(
        await database.executor.all({ sql: 'SELECT key FROM access_mutation_guard', params: [] }),
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
