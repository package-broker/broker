import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { describeExecutorContract } from '@package-broker/db-sqlite/contract/executor-contract';
import { openBetterSqliteExecutor } from './better-sqlite3-executor.js';

describeExecutorContract('better-sqlite3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-'));
  const opened = openBetterSqliteExecutor(join(directory, 'test.db'));
  return {
    executor: opened.executor,
    close: async () => {
      try {
        await opened.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
});

async function pragma(
  executor: ReturnType<typeof openBetterSqliteExecutor>['executor'],
  name: string,
): Promise<unknown> {
  const rows = await executor.all<Record<string, unknown>>({
    sql: `PRAGMA ${name}`,
    params: [],
  });
  return Object.values(rows[0] ?? {})[0];
}

describe('openBetterSqliteExecutor', () => {
  it('reports the driver and applies pragmas on a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-better-sqlite3-'));
    const opened = openBetterSqliteExecutor(join(directory, 'pragmas.db'));
    try {
      expect(opened.executor.driver).toBe('better-sqlite3');
      expect(await pragma(opened.executor, 'journal_mode')).toBe('wal');
      expect(await pragma(opened.executor, 'foreign_keys')).toBe(1);
      expect(await pragma(opened.executor, 'busy_timeout')).toBe(5000);
    } finally {
      await opened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enables foreign keys on :memory: and honours busyTimeoutMs', async () => {
    const opened = openBetterSqliteExecutor(':memory:', { busyTimeoutMs: 1234 });
    try {
      expect(await pragma(opened.executor, 'foreign_keys')).toBe(1);
      expect(await pragma(opened.executor, 'busy_timeout')).toBe(1234);
    } finally {
      await opened.close();
    }
  });

  it('rejects all() after close()', async () => {
    const opened = openBetterSqliteExecutor(':memory:');
    await opened.close();
    await expect(opened.executor.all({ sql: 'SELECT 1', params: [] })).rejects.toBeDefined();
  });
});

describe('openBetterSqliteExecutor statement cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-prepares the least-recently-used statement when the cache is full', async () => {
    const spy = vi.spyOn(Database.prototype, 'prepare');
    const opened = openBetterSqliteExecutor(':memory:', { statementCacheSize: 2 });
    try {
      const first = 'SELECT 1 AS v';
      const statements = [first, 'SELECT 2 AS v', 'SELECT 3 AS v'];
      for (const sql of statements) {
        await opened.executor.all({ sql, params: [] });
      }
      await opened.executor.all({ sql: first, params: [] });

      const prepared = spy.mock.calls.map((call) => call[0] as string);
      expect(prepared.filter((sql) => sql === first)).toHaveLength(2);
      expect(prepared).toHaveLength(4);
    } finally {
      await opened.close();
    }
  });

  it('refreshes recency on a hit so the least-recently-used entry is evicted', async () => {
    const spy = vi.spyOn(Database.prototype, 'prepare');
    const opened = openBetterSqliteExecutor(':memory:', { statementCacheSize: 2 });
    try {
      const a = 'SELECT 1 AS v';
      const b = 'SELECT 2 AS v';
      const c = 'SELECT 3 AS v';
      // A, B, A, C: the second A is a hit and moves A ahead of B, so C evicts B.
      for (const sql of [a, b, a, c]) {
        await opened.executor.all({ sql, params: [] });
      }
      const prepared = (): string[] => spy.mock.calls.map((call) => call[0] as string);
      expect(prepared().filter((sql) => sql === a)).toHaveLength(1);

      const afterFill = spy.mock.calls.length;
      await opened.executor.all({ sql: a, params: [] });
      expect(spy.mock.calls.length).toBe(afterFill);

      await opened.executor.all({ sql: b, params: [] });
      expect(spy.mock.calls.length).toBe(afterFill + 1);
      expect(prepared().filter((sql) => sql === b)).toHaveLength(2);
    } finally {
      await opened.close();
    }
  });

  it('prepares a repeated statement once', async () => {
    const spy = vi.spyOn(Database.prototype, 'prepare');
    const opened = openBetterSqliteExecutor(':memory:', { statementCacheSize: 2 });
    try {
      await opened.executor.all({ sql: 'SELECT 1 AS v', params: [] });
      await opened.executor.all({ sql: 'SELECT 1 AS v', params: [] });

      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await opened.close();
    }
  });

  it('bounds the default cache at exactly the newest 256 statements', async () => {
    const spy = vi.spyOn(Database.prototype, 'prepare');
    const opened = openBetterSqliteExecutor(':memory:');
    try {
      const sqlAt = (index: number): string => `SELECT ${index} AS v`;
      for (let index = 0; index < 10_000; index += 1) {
        await opened.executor.all({ sql: sqlAt(index), params: [] });
      }
      expect(spy).toHaveBeenCalledTimes(10_000);

      // The 256 most recently used statements (9 744..9 999) are still cached,
      // so touching them again prepares nothing.
      for (let index = 9_744; index < 10_000; index += 1) {
        await opened.executor.all({ sql: sqlAt(index), params: [] });
      }
      expect(spy).toHaveBeenCalledTimes(10_000);

      // The 257th most recent (index 9 743) was evicted and is prepared again.
      await opened.executor.all({ sql: sqlAt(9_743), params: [] });
      expect(spy).toHaveBeenCalledTimes(10_001);
    } finally {
      await opened.close();
    }
  });

  it('rejects a non-positive or fractional statementCacheSize', () => {
    expect(() => openBetterSqliteExecutor(':memory:', { statementCacheSize: 0 })).toThrow(
      RangeError,
    );
    expect(() => openBetterSqliteExecutor(':memory:', { statementCacheSize: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('openBetterSqliteExecutor guard constraint', () => {
  it('a forced guard failure carries the guard constraint', async () => {
    const opened = openBetterSqliteExecutor(':memory:');
    try {
      await opened.executor.batch([
        {
          sql: 'CREATE TABLE access_mutation_guard (key TEXT NOT NULL PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64)) STRICT',
          params: [],
        },
      ]);
      const guard = {
        sql: 'INSERT INTO access_mutation_guard (key) SELECT ? WHERE (0) IS NOT 1',
        params: ['K1'],
      };

      const error = await opened.executor.batch([guard, guard]).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).kind).toBe('unique');
      expect((error as DbError).constraint).toBe(ACCESS_MUTATION_GUARD_CONSTRAINT);
    } finally {
      await opened.close();
    }
  });
});
