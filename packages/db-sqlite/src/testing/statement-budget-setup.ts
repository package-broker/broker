import { afterEach, beforeEach, vi } from 'vitest';

const trips = vi.hoisted(() => [] as number[]);

vi.mock('@package-broker/core/db/errors', async (importOriginal) => {
  const original = await importOriginal<typeof import('@package-broker/core/db/errors')>();
  return {
    ...original,
    assertBatchStatementCount(count: number): void {
      try {
        original.assertBatchStatementCount(count);
      } catch (error) {
        trips.push(count);
        throw error;
      }
    },
  };
});

beforeEach(() => {
  trips.length = 0;
});

afterEach(({ task }) => {
  Object.assign(task.meta, { statementBudgetTrips: [...trips] });
});
