import { classifySqliteError } from '@package-broker/core/db/errors';
import type {
  SqlExecutor,
  SqlValue,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';

export interface D1Result {
  readonly results?: unknown[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(): Promise<D1Result>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1Result[]>;
}

const SELECT = /^\s*select\b/i;

function assertParam(value: unknown, index: number): void {
  if (value === null || typeof value === 'string' || value instanceof Uint8Array) return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`parameter ${index} must be a finite number`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`parameter ${index} must be a safe integer`);
    }
    return;
  }

  throw new TypeError(`parameter ${index} is not a SQL value`);
}

function assertParams(params: readonly SqlValue[]): void {
  for (let index = 0; index < params.length; index += 1) {
    assertParam(params[index], index);
  }
}

function toRow<R>(row: unknown): R {
  if (row === null || typeof row !== 'object') return row as R;
  const entries = Object.entries(row).map(([key, value]) => [
    key,
    Array.isArray(value) ? Uint8Array.from(value as number[]) : value,
  ]);
  return Object.fromEntries(entries) as R;
}

export function createD1Executor(db: D1DatabaseLike): SqlExecutor {
  const prepare = (statement: Statement): D1PreparedStatementLike =>
    db.prepare(statement.sql).bind(...statement.params);

  return {
    driver: 'd1',
    async all<R = Record<string, unknown>>(statement: Statement): Promise<R[]> {
      assertParams(statement.params);
      try {
        const result = await prepare(statement).all();
        return (result.results ?? []).map((row) => toRow<R>(row));
      } catch (error) {
        throw classifySqliteError(error);
      }
    },
    async batch(statements: readonly Statement[]): Promise<StatementResult[]> {
      if (statements.length === 0) return [];
      for (const statement of statements) assertParams(statement.params);
      try {
        const results = await db.batch(statements.map(prepare));
        return results.map((result, index) => ({
          rows: (result.results ?? []).map((row) => toRow<Record<string, unknown>>(row)),
          changes: SELECT.test(statements[index]?.sql ?? '') ? 0 : (result.meta?.changes ?? 0),
        }));
      } catch (error) {
        throw classifySqliteError(error);
      }
    },
  };
}
