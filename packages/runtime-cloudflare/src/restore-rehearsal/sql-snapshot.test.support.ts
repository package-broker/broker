/* eslint-disable no-restricted-syntax -- Isolated fixture seeding and full database snapshots require SQL; this module is rehearsal-only. */
import type { ScalarSqlValue, SqlExecutor, Statement } from '@package-broker/core/db/port';
const quoteId = (s: string) => `"${s.replaceAll('"', '""')}"`;
export interface SnapshotStatement {
  sql: string;
  params: (ScalarSqlValue | { hex: string })[];
}

const MAX_SQL_BYTES = 100_000;
const MAX_PARAMETERS = 100;

export function bindSnapshot(statements: readonly SnapshotStatement[]): Statement[] {
  return statements.map(({ sql, params }) => ({
    sql,
    params: params.map((value) =>
      value !== null && typeof value === 'object' ? Buffer.from(value.hex, 'hex') : value,
    ),
  }));
}

export async function exportDatabase(executor: SqlExecutor): Promise<SnapshotStatement[]> {
  const schema = await executor.all<{ name: string; type: string; sql: string }>({
    sql: "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid",
    params: [],
  });
  const statements = [
    'PRAGMA defer_foreign_keys = ON',
    ...schema.filter((row) => row.type === 'table').map((row) => row.sql),
    ...schema.filter((row) => row.type === 'index').map((row) => row.sql),
  ].map((sql) => ({ sql, params: [] }) as SnapshotStatement);
  for (const table of schema.filter((row) => row.type === 'table')) {
    const columns = await executor.all<{ name: string }>({
      sql: `PRAGMA table_info(${quoteId(table.name)})`,
      params: [],
    });
    const select = `SELECT ${columns
      .flatMap((col, i) => [
        `typeof(${quoteId(col.name)}) AS ${quoteId(`type${i}`)}`,
        `CASE WHEN typeof(${quoteId(col.name)}) IN ('text', 'blob') THEN hex(CAST(${quoteId(col.name)} AS BLOB)) ELSE ${quoteId(col.name)} END AS ${quoteId(String(i))}`,
      ])
      .join(',')} FROM ${quoteId(table.name)}`;
    const scopes = columns.some((col) => col.name === 'org_id')
      ? await executor.all<{ orgId: string }>({
          sql: `SELECT DISTINCT org_id AS orgId FROM ${quoteId(table.name)} ORDER BY org_id`,
          params: [],
        })
      : null;
    const rows: Record<string, ScalarSqlValue>[] = [];
    if (scopes === null)
      rows.push(
        ...(await executor.all<Record<string, ScalarSqlValue>>({ sql: select, params: [] })),
      );
    else
      for (const { orgId } of scopes)
        rows.push(
          ...(await executor.all<Record<string, ScalarSqlValue>>({
            sql: select + ' WHERE org_id IS ?',
            params: [orgId],
          })),
        );
    const prefix = `INSERT INTO ${quoteId(table.name)} (${columns.map((col) => quoteId(col.name)).join(',')}) VALUES `;
    let pending: SnapshotStatement = { sql: prefix, params: [] };
    for (const row of rows) {
      if (pending.params.length + columns.length > MAX_PARAMETERS) {
        statements.push(pending);
        pending = { sql: prefix, params: [] };
      }
      const expressions = columns.map((_, i) => {
        const type = row[`type${i}`];
        const value = row[String(i)]!;
        pending.params.push(type === 'text' || type === 'blob' ? { hex: String(value) } : value);
        const parameter = '?';
        return type === 'text'
          ? `CAST(${parameter} AS TEXT)`
          : type === 'real'
            ? `CAST(${parameter} AS REAL)`
            : parameter;
      });
      const values = `(${expressions.join(',')})`;
      pending.sql += (pending.sql === prefix ? '' : ',') + values;
    }
    if (pending.params.length) statements.push(pending);
  }
  statements.push(
    ...schema
      .filter((row) => row.type !== 'table' && row.type !== 'index')
      .map((row) => ({ sql: row.sql, params: [] })),
  );
  if (
    statements.some(
      ({ sql, params }) =>
        Buffer.byteLength(sql) >= MAX_SQL_BYTES || params.length > MAX_PARAMETERS,
    )
  )
    throw new Error('snapshot statement exceeds D1 limits');
  return statements;
}
