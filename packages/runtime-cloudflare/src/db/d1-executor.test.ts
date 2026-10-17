import { afterAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { describeExecutorContract } from '@package-broker/db-sqlite/contract/executor-contract';
import {
  D1_MAX_BOUND_PARAMETERS,
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Result,
} from './d1-executor.js';

const bindings = Array.from({ length: 16 }, (_, index) => `DB${index}`);

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

describeExecutorContract('d1 on miniflare', async () => {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  return { executor: createD1Executor(db), close: async () => {} };
});

function fakeDb(overrides: Partial<D1DatabaseLike> = {}): D1DatabaseLike {
  const statement: D1PreparedStatementLike = {
    bind: () => statement,
    all: async () => ({ results: [] }),
  };
  return { prepare: () => statement, batch: async () => [], ...overrides };
}

describe('createD1Executor with a fake database', () => {
  it('reports the d1 driver', () => {
    expect(createD1Executor(fakeDb()).driver).toBe('d1');
  });

  it('batch([]) never calls db.batch', async () => {
    const batch = vi.fn(async () => [] as D1Result[]);

    const results = await createD1Executor(fakeDb({ batch })).batch([]);

    expect(results).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  });

  it('classifies a D1 unique rejection as DbError unique', async () => {
    const batch = vi.fn(async () => {
      throw new Error('D1_ERROR: UNIQUE constraint failed: t.a: SQLITE_CONSTRAINT');
    });

    const error = await createD1Executor(fakeDb({ batch }))
      .batch([{ sql: 'INSERT INTO t (a) VALUES (?)', params: [1] }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('unique');
  });

  it('classifies an all() rejection too', async () => {
    const statement: D1PreparedStatementLike = {
      bind: () => statement,
      all: async () => {
        throw new Error('D1_ERROR: UNIQUE constraint failed: t.a: SQLITE_CONSTRAINT');
      },
    };

    const error = await createD1Executor(fakeDb({ prepare: () => statement }))
      .all({ sql: 'INSERT INTO t (a) VALUES (?)', params: [1] })
      .catch((caught: unknown) => caught);

    expect((error as DbError).kind).toBe('unique');
  });

  it('maps array-valued fields to Uint8Array and counts changes outside SELECT', async () => {
    const batch = vi.fn(async () => [
      { results: [{ bin: [1, 2, 255] }], meta: { changes: 1 } },
      { results: [], meta: { changes: 7 } },
    ]);

    const results = await createD1Executor(fakeDb({ batch })).batch([
      { sql: 'INSERT INTO t (bin) VALUES (?) RETURNING bin', params: [new Uint8Array([1])] },
      { sql: '  select 1', params: [] },
    ]);

    expect(results[0]?.changes).toBe(1);
    expect(results[0]?.rows[0]?.['bin']).toBeInstanceOf(Uint8Array);
    expect(Array.from(results[0]?.rows[0]?.['bin'] as Uint8Array)).toEqual([1, 2, 255]);
    expect(results[1]?.changes).toBe(0);
  });
});

function sumOf(count: number): { sql: string; params: number[] } {
  return {
    sql: `SELECT ${Array.from({ length: count }, () => '?').join(' + ')} AS total`,
    params: Array.from({ length: count }, () => 1),
  };
}

async function freshD1(): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  return (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
}

describe('createD1Executor bound parameter limit', () => {
  it('runs exactly 100 bound parameters on miniflare D1', async () => {
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100);
    const executor = createD1Executor(await freshD1());

    await expect(executor.all(sumOf(100))).resolves.toEqual([{ total: 100 }]);
    await expect(executor.batch([sumOf(100)])).resolves.toHaveLength(1);
  });

  it('refuses 101 bound parameters before preparing anything, naming the count only', async () => {
    const prepare = vi.fn();
    const batch = vi.fn(async () => [] as D1Result[]);
    const executor = createD1Executor(fakeDb({ prepare, batch }));
    const secret = 'secret-value';
    const statement = {
      sql: `SELECT ${Array.from({ length: 101 }, () => '?').join(', ')}`,
      params: Array.from({ length: 101 }, () => secret),
    };

    for (const attempt of [executor.all(statement), executor.batch([sumOf(1), statement])]) {
      const error: unknown = await attempt.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).kind).toBe('too_big');
      expect((error as DbError).message).toContain('101');
      expect((error as DbError).message).not.toContain(secret);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('createD1Executor guard constraint on miniflare', () => {
  it('a forced guard failure carries the guard constraint', async () => {
    const binding = bindings[next];
    next += 1;
    if (binding === undefined) throw new Error('out of D1 bindings');
    const executor = createD1Executor(
      (await mf.getD1Database(binding)) as unknown as D1DatabaseLike,
    );
    await executor.batch([
      {
        sql: 'CREATE TABLE access_mutation_guard (key TEXT NOT NULL PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64)) STRICT',
        params: [],
      },
    ]);
    const guard = {
      sql: 'INSERT INTO access_mutation_guard (key) SELECT ? WHERE (0) IS NOT 1',
      params: ['K1'],
    };

    const error = await executor.batch([guard, guard]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).kind).toBe('unique');
    expect((error as DbError).constraint).toBe(ACCESS_MUTATION_GUARD_CONSTRAINT);
  });
});
