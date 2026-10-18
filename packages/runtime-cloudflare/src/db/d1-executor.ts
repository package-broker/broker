import {
  assertBatchStatementCount,
  DbError,
  classifySqliteError,
} from '@package-broker/core/db/errors';
import type {
  SqlExecutor,
  SqlValue,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result as WorkersD1Result,
} from '@cloudflare/workers-types';

export type D1Result = Partial<Pick<WorkersD1Result, 'results'>> & {
  readonly meta?: Partial<Pick<WorkersD1Result['meta'], 'changes'>>;
};

type D1PortValue<T> = T extends D1PreparedStatement
  ? D1PreparedStatementLike
  : T extends WorkersD1Result
    ? D1Result
    : T extends Promise<infer Value>
      ? Promise<D1PortValue<Value>>
      : T extends (infer Value)[]
        ? D1PortValue<Value>[]
        : T;

// Preserve method variance so the real binding can accept the reduced statement port.
type D1PortMethods<T> = {
  [Key in keyof T]: T[Key] extends (...args: infer Args) => infer Result
    ? {
        method(...args: { [Index in keyof Args]: D1PortValue<Args[Index]> }): D1PortValue<Result>;
      }['method']
    : never;
};

export type D1PreparedStatementLike = D1PortMethods<Pick<D1PreparedStatement, 'bind' | 'all'>>;

export type D1DatabaseLike = D1PortMethods<Pick<D1Database, 'prepare' | 'batch'>>;

export const D1_MAX_BOUND_PARAMETERS = 100;

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
  if (params.length > D1_MAX_BOUND_PARAMETERS) {
    throw new DbError(
      'too_big',
      `too_big: statement binds ${params.length} parameters, D1 allows at most ${D1_MAX_BOUND_PARAMETERS}`,
    );
  }
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
      assertBatchStatementCount(statements.length);
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
