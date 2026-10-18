import { D1_STATEMENTS_PER_BATCH } from '@package-broker/core/db/port';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';

/** Fixture setup only: batches commit independently and preserve statement order. */
export async function seedStatements(
  executor: Pick<SqlExecutor, 'batch'>,
  statements: readonly Statement[],
): Promise<void> {
  for (let start = 0; start < statements.length; start += D1_STATEMENTS_PER_BATCH) {
    await executor.batch(statements.slice(start, start + D1_STATEMENTS_PER_BATCH));
  }
}
