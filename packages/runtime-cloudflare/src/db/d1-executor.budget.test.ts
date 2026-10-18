import { describe, expect, it, vi } from 'vitest';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './d1-executor.js';

function fakeDb(overrides: Partial<D1DatabaseLike> = {}): D1DatabaseLike {
  const statement: D1PreparedStatementLike = {
    bind: () => statement,
    all: async () => ({ results: [] }),
  };
  return {
    prepare: () => statement,
    batch: async (statements) => statements.map(() => ({ results: [] })),
    ...overrides,
  };
}

describe('D1 statement budget before binding', () => {
  it('rejects an oversized batch before preparing or binding any SQL', async () => {
    const prepare = vi.fn(fakeDb().prepare);
    const batch = vi.fn(fakeDb().batch);
    await expect(
      createD1Executor(fakeDb({ prepare, batch })).batch(
        Array.from({ length: 201 }, () => ({ sql: 'private SQL', params: ['private-value'] })),
      ),
    ).rejects.toMatchObject({ name: 'DbError', kind: 'too_big' });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('accepts exactly 200 statements without splitting the batch', async () => {
    const db = fakeDb();
    const batch = vi.fn(db.batch);
    const results = await createD1Executor({ ...db, batch }).batch(
      Array.from({ length: 200 }, () => ({ sql: 'SELECT 1', params: [] })),
    );
    expect(results).toHaveLength(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(200);
  });
});
