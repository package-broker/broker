import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
