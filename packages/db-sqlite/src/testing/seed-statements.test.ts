import { describe, expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { seedStatements } from './seed-statements.js';

describe('seedStatements', () => {
  it.each([
    [0, []],
    [200, [200]],
    [201, [200, 1]],
    [401, [200, 200, 1]],
  ])('seeds %i statements in ordered budget-sized batches', async (count, sizes) => {
    const statements: Statement[] = Array.from({ length: count }, (_, index) => ({
      sql: 'INSERT INTO fixture VALUES (?)',
      params: [index],
    }));
    const batches: (readonly Statement[])[] = [];
    const executor: Pick<SqlExecutor, 'batch'> = {
      async batch(batch) {
        batches.push(batch);
        return [];
      },
    };
    await seedStatements(executor, statements);
    expect(batches.map((batch) => batch.length)).toEqual(sizes);
    expect(batches.flat()).toEqual(statements);
  });

  it('stops seeding when a batch fails', async () => {
    const failure = new Error('fixture failure');
    let calls = 0;
    const executor: Pick<SqlExecutor, 'batch'> = {
      async batch() {
        calls += 1;
        throw failure;
      },
    };
    const statements = Array.from({ length: 401 }, () => ({ sql: 'SELECT 1', params: [] }));
    await expect(seedStatements(executor, statements)).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});
