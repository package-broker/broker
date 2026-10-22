import {
  D1_STATEMENTS_PER_BATCH,
  type SqlExecutor,
  type Statement,
  type StatementResult,
} from '@package-broker/core/db/port';

export async function batchInChunks(
  executor: SqlExecutor,
  statements: readonly Statement[],
  size: number = D1_STATEMENTS_PER_BATCH,
): Promise<StatementResult[]> {
  const results: StatementResult[] = [];
  for (let offset = 0; offset < statements.length; offset += size) {
    results.push(...(await executor.batch(statements.slice(offset, offset + size))));
  }
  return results;
}
