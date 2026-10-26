import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Result,
} from './d1-executor.js';
import { bridgedD1Database, D1_BRIDGE_SCRIPT } from './d1-bridge.test.support.js';

interface WorkerBridge {
  fetch(request: Request, env: Record<string, D1DatabaseLike>): Promise<Response>;
}

function bridge(native: D1DatabaseLike) {
  const worker = runInNewContext(
    D1_BRIDGE_SCRIPT.replace('export default', 'globalThis.worker ='),
    {
      Response,
      Uint8Array,
      atob,
    },
  ) as WorkerBridge;
  const dispatch = vi.fn((body: string) =>
    worker.fetch(new Request('http://catalogue.test/', { method: 'POST', body }), { CDB0: native }),
  );
  return { database: bridgedD1Database('CDB0', dispatch), dispatch };
}

function nativeDatabase() {
  const bound = new WeakMap<D1PreparedStatementLike, { sql: string; params: unknown[] }>();
  const all = vi.fn(async (sql: string, params: unknown[]): Promise<D1Result> => ({
    results: [{ sql, params }],
  }));
  const batch = vi.fn(async (statements: D1PreparedStatementLike[]): Promise<D1Result[]> =>
    statements.map((statement, index) => ({
      results: [{ sql: bound.get(statement)!.sql }],
      meta: { changes: index + 1 },
    })),
  );
  const prepare = vi.fn((sql: string): D1PreparedStatementLike => {
    const make = (params: unknown[]): D1PreparedStatementLike => {
      const statement: D1PreparedStatementLike = {
        bind: (...values) => make(values),
        all: () => all(sql, params),
      };
      bound.set(statement, { sql, params });
      return statement;
    };
    return make([]);
  });
  return { prepare, batch, all, bound };
}

it('prepares and binds locally without dispatch, retaining independent bound statements', async () => {
  const native = nativeDatabase();
  const { database, dispatch } = bridge(native);
  const unbound = database.prepare('SELECT ?');
  const first = unbound.bind(1);
  const second = unbound.bind(2);
  expect(dispatch).not.toHaveBeenCalled();
  expect(native.prepare).not.toHaveBeenCalled();
  expect((await first.all()).results).toEqual([{ sql: 'SELECT ?', params: [1] }]);
  expect((await second.all()).results).toEqual([{ sql: 'SELECT ?', params: [2] }]);
  expect(native.batch).not.toHaveBeenCalled();
  expect(native.all).toHaveBeenCalledTimes(2);
});

it('sends one native D1 batch with ordered statements and lossless binary parameters', async () => {
  const native = nativeDatabase();
  const { database, dispatch } = bridge(native);
  const bytes = new Uint8Array([0, 128, 255]);
  const results = await database.batch([
    database.prepare('INSERT INTO t VALUES (?, ?, ?, ?)').bind(bytes, null, 3, 'value'),
    database.prepare('SELECT 1'),
  ]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(native.batch).toHaveBeenCalledTimes(1);
  expect(native.all).not.toHaveBeenCalled();
  expect(native.batch.mock.calls[0]![0].map((statement) => native.bound.get(statement))).toEqual([
    { sql: 'INSERT INTO t VALUES (?, ?, ?, ?)', params: [bytes, null, 3, 'value'] },
    { sql: 'SELECT 1', params: [] },
  ]);
  expect(results).toEqual([
    {
      results: [{ sql: 'INSERT INTO t VALUES (?, ?, ?, ?)' }],
      meta: { changes: 1 },
    },
    { results: [{ sql: 'SELECT 1' }], meta: { changes: 2 } },
  ]);
  expect(JSON.parse(dispatch.mock.calls[0]![0]).binding).toBe('CDB0');
});

it('keeps concurrent replies attached to their calls when they complete in reverse order', async () => {
  const waiting: (() => void)[] = [];
  const database = bridgedD1Database(
    'CDB0',
    (body) =>
      new Promise((resolve) => {
        const { statements } = JSON.parse(body) as { statements: { sql: string }[] };
        waiting.push(() =>
          resolve(
            Response.json({
              ok: true,
              result: [{ results: [{ sql: statements[0]!.sql }] }],
            }),
          ),
        );
      }),
  );
  const first = database.prepare('SELECT 1').all();
  const second = database.prepare('SELECT 2').all();
  expect(waiting).toHaveLength(2);
  waiting[1]!();
  expect(await second).toEqual({ results: [{ sql: 'SELECT 2' }] });
  waiting[0]!();
  expect(await first).toEqual({ results: [{ sql: 'SELECT 1' }] });
});

for (const nested of [false, true]) {
  it(`preserves D1 constraint classification through the bridge (nested: ${nested})`, async () => {
    const native = nativeDatabase();
    const constraint = new Error('UNIQUE constraint failed: access_mutation_guard.key');
    native.batch.mockRejectedValueOnce(
      nested ? new Error('D1_ERROR', { cause: constraint }) : constraint,
    );
    const { database } = bridge(native);
    const result = createD1Executor(database).batch([{ sql: 'SELECT 1', params: [] }]);
    await expect(result).rejects.toBeInstanceOf(DbError);
    await expect(result).rejects.toMatchObject({
      kind: 'unique',
      constraint: 'access_mutation_guard.key',
    });
  });
}

it('reports a failed bridge request without returning the HTTP response body', async () => {
  const database = bridgedD1Database(
    'CDB0',
    async () => new Response('private data', { status: 500 }),
  );
  await expect(database.prepare('SELECT 1').all()).rejects.toThrow('D1 test bridge request failed');
});
