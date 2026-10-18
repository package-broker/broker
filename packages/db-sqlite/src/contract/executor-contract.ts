import { describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { countCalls } from './count-calls.js';

export interface OpenedExecutor {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

async function withExecutor(
  open: () => Promise<OpenedExecutor>,
  body: (executor: SqlExecutor) => Promise<void>,
): Promise<void> {
  const opened = await open();
  try {
    await body(opened.executor);
  } finally {
    await opened.close();
  }
}

async function createTables(executor: SqlExecutor, ...ddl: string[]): Promise<void> {
  await executor.batch(ddl.map((sql) => ({ sql, params: [] })));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function expectDbError(promise: Promise<unknown>, kind: DbError['kind']): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).kind).toBe(kind);
}

export function describeExecutorContract(name: string, open: () => Promise<OpenedExecutor>): void {
  describe(`SqlExecutor contract: ${name}`, () => {
    it('1. all() returns plain objects keyed by alias', async () => {
      await withExecutor(open, async (executor) => {
        const rows = await executor.all({ sql: 'SELECT 1 AS one, ? AS word', params: ['x'] });

        expect(rows).toEqual([{ one: 1, word: 'x' }]);
        expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
      });
    });

    it('2. round-trips text, integers, null and bytes', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(
          executor,
          'CREATE TABLE value_row (id INTEGER PRIMARY KEY, txt TEXT, num INTEGER, nul TEXT, bin BLOB)',
        );
        const text = `it's "quoted" \\ zażółć 日本語 🙂`;
        const bytes = [0, 1, 2, 254, 255];

        await executor.all({
          sql: 'INSERT INTO value_row (id, txt, num, nul, bin) VALUES (?, ?, ?, ?, ?)',
          params: [1, text, Number.MAX_SAFE_INTEGER, null, new Uint8Array(bytes)],
        });
        const [row] = await executor.all<{
          txt: string;
          num: number;
          nul: string | null;
          bin: unknown;
        }>({ sql: 'SELECT txt, num, nul, bin FROM value_row WHERE id = ?', params: [1] });

        expect(row?.txt).toBe(text);
        expect(row?.num).toBe(Number.MAX_SAFE_INTEGER);
        expect(row?.nul).toBeNull();
        const value = row?.bin;
        expect(value instanceof Uint8Array).toBe(true);
        expect(Array.from(value as Uint8Array)).toEqual(bytes);
      });
    });

    it('3. batch() returns one result per statement with rows and changes', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');

        const results = await executor.batch([
          { sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id', params: [1, 'a'] },
          { sql: 'INSERT INTO item (id, label) VALUES (?, ?) RETURNING id', params: [2, 'b'] },
          { sql: 'UPDATE item SET label = ?', params: ['z'] },
          { sql: 'SELECT id, label FROM item ORDER BY id', params: [] },
        ]);

        expect(results).toHaveLength(4);
        expect(results[0]).toEqual({ changes: 1, rows: [{ id: 1 }] });
        expect(results[1]).toEqual({ changes: 1, rows: [{ id: 2 }] });
        expect(results[2]?.changes).toBe(2);
        expect(results[3]?.changes).toBe(0);
        expect(results[3]?.rows).toEqual([
          { id: 1, label: 'z' },
          { id: 2, label: 'z' },
        ]);
      });
    });

    it('4. all() of an UPDATE without RETURNING resolves to [] and changes the row', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');
        await executor.all({ sql: 'INSERT INTO item (id, label) VALUES (?, ?)', params: [1, 'a'] });

        const result = await executor.all({
          sql: 'UPDATE item SET label = ? WHERE id = ?',
          params: ['b', 1],
        });
        const rows = await executor.all({
          sql: 'SELECT label FROM item WHERE id = ?',
          params: [1],
        });

        expect(result).toEqual([]);
        expect(rows).toEqual([{ label: 'b' }]);
      });
    });

    it('5. a failing statement rolls the whole batch back', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(
          executor,
          'CREATE TABLE item (id INTEGER PRIMARY KEY, code TEXT UNIQUE)',
        );

        await expectDbError(
          executor.batch([
            { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [1, 'a'] },
            { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [2, 'b'] },
            { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [3, 'c'] },
            { sql: 'INSERT INTO item (id, code) VALUES (?, ?)', params: [4, 'a'] },
          ]),
          'unique',
        );
        const rows = await executor.all({ sql: 'SELECT id FROM item', params: [] });

        expect(rows).toEqual([]);
      });
    });

    it('6. classifies foreign_key, not_null and check violations', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(
          executor,
          'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
          "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id), req TEXT NOT NULL DEFAULT 'x', qty INTEGER CHECK (qty >= 0))",
        );

        await expectDbError(
          executor.all({ sql: 'INSERT INTO child (id, parent_id) VALUES (?, ?)', params: [1, 99] }),
          'foreign_key',
        );
        await expectDbError(
          executor.all({ sql: 'INSERT INTO child (id, req) VALUES (?, ?)', params: [2, null] }),
          'not_null',
        );
        await expectDbError(
          executor.all({ sql: 'INSERT INTO child (id, qty) VALUES (?, ?)', params: [3, -1] }),
          'check',
        );
      });
    });

    it('7. a batch sees its own earlier writes', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(executor, 'CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT)');

        const results = await executor.batch([
          { sql: 'INSERT INTO item (id, label) VALUES (?, ?)', params: [1, 'a'] },
          { sql: 'SELECT label FROM item WHERE id = ?', params: [1] },
        ]);

        expect(results[1]?.rows).toEqual([{ label: 'a' }]);
      });
    });

    it('8. batch([]) resolves to [] without error', async () => {
      await withExecutor(open, async (executor) => {
        const counted = countCalls(executor);

        const results = await counted.executor.batch([]);

        expect(results).toEqual([]);
      });
    });

    it('rejects 201 statements before executing any SQL, and accepts 200', async () => {
      await withExecutor(open, async (executor) => {
        await createTables(executor, 'CREATE TABLE batch_budget (value TEXT)');
        const insert = { sql: 'INSERT INTO batch_budget VALUES (?)', params: ['private-value'] };
        const error = await rejection(executor.batch(Array.from({ length: 201 }, () => insert)));
        expect(error).toBeInstanceOf(DbError);
        expect((error as DbError).kind).toBe('too_big');
        expect((error as Error).message).not.toContain('private-value');
        expect((error as Error).message).not.toContain(insert.sql);
        expect(await executor.all({ sql: 'SELECT * FROM batch_budget', params: [] })).toEqual([]);
        const results = await executor.batch(Array.from({ length: 200 }, () => insert));
        expect(results).toHaveLength(200);
        expect(results.every((result) => result.changes === 1)).toBe(true);
      });
    });

    it('9. an unsafe integer parameter rejects with TypeError', async () => {
      await withExecutor(open, async (executor) => {
        const unsafe = 2 ** 53;

        expect(
          await rejection(executor.all({ sql: 'SELECT ? AS n', params: [unsafe] })),
        ).toBeInstanceOf(TypeError);
        expect(
          await rejection(executor.batch([{ sql: 'SELECT ? AS n', params: [unsafe] }])),
        ).toBeInstanceOf(TypeError);
      });
    });
  });
}
