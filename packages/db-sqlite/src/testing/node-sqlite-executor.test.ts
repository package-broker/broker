import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarStatement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openNodeSqliteExecutor } from './node-sqlite-executor.js';

const CREATE_TABLE = {
  sql: 'CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
  params: [],
} as const;

describe('openNodeSqliteExecutor', () => {
  it('reports the node-sqlite driver and enables foreign keys', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      expect(opened.executor.driver).toBe('node-sqlite');
      const rows = await opened.executor.all<{ foreign_keys: number }>({
        sql: 'PRAGMA foreign_keys',
        params: [],
      });
      expect(rows).toEqual([{ foreign_keys: 1 }]);
    } finally {
      await opened.close();
    }
  });

  it('returns rows for a SELECT and [] for a write from all()', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      await opened.executor.batch([
        { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
      ]);

      const written = await opened.executor.all({
        sql: 'UPDATE sample SET name = ? WHERE id = ?',
        params: ['b', 1],
      });
      expect(written).toEqual([]);

      const rows = await opened.executor.all<{ name: string }>({
        sql: 'SELECT name FROM sample WHERE id = ?',
        params: [1],
      });
      expect(rows).toEqual([{ name: 'b' }]);
    } finally {
      await opened.close();
    }
  });

  it('round-trips a BLOB as a plain Uint8Array', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      await opened.executor.batch([
        { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
        { sql: 'ALTER TABLE sample ADD COLUMN payload BLOB', params: [] },
        {
          sql: 'UPDATE sample SET payload = ? WHERE id = ?',
          params: [new Uint8Array([1, 2, 3]), 1],
        },
      ]);

      const rows = await opened.executor.all<{ payload: Uint8Array }>({
        sql: 'SELECT payload FROM sample WHERE id = ?',
        params: [1],
      });
      const payload = rows[0]?.payload;
      expect(payload).toBeInstanceOf(Uint8Array);
      expect(Object.getPrototypeOf(payload)).toBe(Uint8Array.prototype);
      expect(payload).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await opened.close();
    }
  });

  it('reports changes per statement in a batch', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      const results = await opened.executor.batch([
        { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
        {
          sql: 'INSERT INTO sample (id, name) VALUES (?, ?) RETURNING id',
          params: [2, 'b'],
        },
        { sql: 'SELECT id FROM sample ORDER BY id', params: [] },
        { sql: 'UPDATE sample SET name = ?', params: ['c'] },
      ]);

      expect(results).toEqual([
        { rows: [], changes: 1 },
        { rows: [{ id: 2 }], changes: 1 },
        { rows: [{ id: 1 }, { id: 2 }], changes: 0 },
        { rows: [], changes: 2 },
      ]);
    } finally {
      await opened.close();
    }
  });

  it('leaves no rows when a batch fails and classifies the error', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([
        {
          sql: 'CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
          params: [],
        },
      ]);
      const failure = opened.executor.batch([
        { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
        { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [2, 'a'] },
      ]);

      await expect(failure).rejects.toBeInstanceOf(DbError);
      await expect(failure).rejects.toMatchObject({ kind: 'unique' });

      const rows = await opened.executor.all({ sql: 'SELECT id FROM sample', params: [] });
      expect(rows).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it('returns [] for an empty batch', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      expect(await opened.executor.batch([])).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a boolean', true],
    ['undefined', undefined],
  ])('rejects %s with a TypeError', async (_label, value) => {
    const opened = openNodeSqliteExecutor();
    try {
      await expect(
        opened.executor.all({ sql: 'SELECT ? AS value', params: [value as never] }),
      ).rejects.toThrow(TypeError);
    } finally {
      await opened.close();
    }
  });

  it('rejects an invalid batch parameter before opening a transaction', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      await expect(
        opened.executor.batch([
          { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
          { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [Number.NaN, 'b'] },
        ]),
      ).rejects.toThrow(TypeError);

      const rows = await opened.executor.all({ sql: 'SELECT id FROM sample', params: [] });
      expect(rows).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it('rejects a sparse parameter array in all()', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      await expect(
        opened.executor.all({ sql: 'SELECT ? AS value', params: new Array(1) }),
      ).rejects.toThrow(TypeError);
    } finally {
      await opened.close();
    }
  });

  it('rejects a sparse parameter array in batch() before opening a transaction', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      await opened.executor.batch([CREATE_TABLE]);
      await expect(
        opened.executor.batch([
          { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: [1, 'a'] },
          { sql: 'INSERT INTO sample (id, name) VALUES (?, ?)', params: new Array(1) },
        ]),
      ).rejects.toThrow(TypeError);

      const rows = await opened.executor.all({ sql: 'SELECT id FROM sample', params: [] });
      expect(rows).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it('keeps a __proto__ alias as an own data property', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      const viaAll = await opened.executor.all({ sql: 'SELECT 42 AS "__proto__"', params: [] });
      const allRow = viaAll[0] ?? {};
      expect(Object.keys(allRow)).toEqual(['__proto__']);
      expect(Object.getOwnPropertyDescriptor(allRow, '__proto__')?.value).toBe(42);
      expect(Object.getPrototypeOf(allRow)).toBe(Object.prototype);

      const viaBatch = await opened.executor.batch([
        { sql: 'SELECT 42 AS "__proto__"', params: [] },
      ]);
      const batchRow = viaBatch[0]?.rows[0] ?? {};
      expect(Object.keys(batchRow)).toEqual(['__proto__']);
      expect(Object.getOwnPropertyDescriptor(batchRow, '__proto__')?.value).toBe(42);
    } finally {
      await opened.close();
    }
  });
});

describe('openNodeSqliteExecutor with a file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-node-sqlite-'));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it('uses WAL for a file path', async () => {
    const opened = openNodeSqliteExecutor(join(dir, 'sample.db'));
    try {
      const rows = await opened.executor.all<{ journal_mode: string }>({
        sql: 'PRAGMA journal_mode',
        params: [],
      });
      expect(rows).toEqual([{ journal_mode: 'wal' }]);
    } finally {
      await opened.close();
    }
  });

  it('classifies a failing open instead of throwing a raw Error', () => {
    const missing = join(dir, 'missing-directory', 'sample.db');
    let caught: unknown;
    try {
      openNodeSqliteExecutor(missing);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DbError);
    expect((caught as DbError).kind).toBe('unknown');
    expect((caught as DbError).message).toContain('unable to open database file');
  });
});

describe('countCalls', () => {
  it('counts all and batch calls', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      const counted = countCalls(opened.executor);
      await counted.executor.all({ sql: 'SELECT 1 AS one', params: [] });
      await counted.executor.all({ sql: 'SELECT 2 AS two', params: [] });
      await counted.executor.batch([{ sql: 'SELECT 3 AS three', params: [] }]);

      expect(counted.counts()).toEqual({ all: 2, batch: 1 });
    } finally {
      await opened.close();
    }
  });

  it('counts an empty batch as one call', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      const counted = countCalls(opened.executor);
      await counted.executor.batch([]);

      expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    } finally {
      await opened.close();
    }
  });

  it('preserves extra members of the executor and binds them to it', async () => {
    const opened = openNodeSqliteExecutor();
    const subtype = {
      driver: opened.executor.driver,
      all: <R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> =>
        opened.executor.all<R>(statement),
      batch: (statements: readonly ScalarStatement[]) => opened.executor.batch(statements),
      close: () => opened.close(),
    };

    const counted = countCalls(subtype);
    await counted.executor.all({ sql: 'SELECT 1 AS one', params: [] });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });

    await counted.executor.close();
    await expect(
      counted.executor.all({ sql: 'SELECT 1 AS one', params: [] }),
    ).rejects.toBeInstanceOf(DbError);
  });
});
