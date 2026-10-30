import {
  D1_STATEMENTS_PER_BATCH,
  type ScalarSqlValue,
  type SqlExecutor,
  type Statement,
} from '@package-broker/core/db/port';
import { assertBatchStatementCount } from '@package-broker/core/db/errors';

export interface SnapshotStatement {
  sql: string;
  params: (ScalarSqlValue | { hex: string })[];
}

export function bindSnapshot(statements: readonly SnapshotStatement[]): Statement[] {
  return statements.map(({ sql, params }) => ({
    sql,
    params: params.map((value) =>
      value !== null && typeof value === 'object' ? Buffer.from(value.hex, 'hex') : value,
    ),
  }));
}

export async function restoreDatabase(
  executor: SqlExecutor,
  statements: readonly SnapshotStatement[],
): Promise<void> {
  const schema: SnapshotStatement[] = [];
  const data: SnapshotStatement[] = [];
  for (const statement of statements) {
    if (/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/i.test(statement.sql)) schema.push(statement);
    else data.push(statement);
  }
  assertBatchStatementCount(data.length);
  for (let offset = 0; offset < schema.length; offset += D1_STATEMENTS_PER_BATCH)
    await executor.batch(bindSnapshot(schema.slice(offset, offset + D1_STATEMENTS_PER_BATCH)));
  await executor.batch(bindSnapshot(data));
}
