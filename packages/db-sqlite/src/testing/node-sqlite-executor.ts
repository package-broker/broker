import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DbError, classifySqliteError } from '@package-broker/core/db/errors';
import type {
  SqlExecutor,
  SqlValue,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';

export interface OpenedExecutor {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

export interface NodeSqliteExecutorOptions {
  readonly d1PatternLimit?: boolean;
}

export const D1_MAX_BOUND_PARAMETERS = 100;
export const D1_MAX_PATTERN_LENGTH = 50;

const RETURNING = /returning/i;

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

function toPlainValue(value: unknown): unknown {
  if (value instanceof Uint8Array && value.constructor !== Uint8Array) {
    return new Uint8Array(value);
  }
  return value;
}

function toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toPlainValue(value)]));
}

function openDatabase(path: string, options: NodeSqliteExecutorOptions): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      timeout: 5000,
      limits: {
        variableNumber: D1_MAX_BOUND_PARAMETERS,
        ...(options.d1PatternLimit === true ? { likePatternLength: D1_MAX_PATTERN_LENGTH } : {}),
      },
    });
    if (
      options.d1PatternLimit === true &&
      database.limits?.likePatternLength !== D1_MAX_PATTERN_LENGTH
    ) {
      throw new Error('this Node version cannot limit the LIKE/GLOB pattern length');
    }
    database.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') {
      database.exec('PRAGMA journal_mode = WAL');
    }
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // the connection is already gone; the original error wins
    }
    throw classifySqliteError(error);
  }
}

export function openNodeSqliteExecutor(
  path = ':memory:',
  options: NodeSqliteExecutorOptions = {},
): OpenedExecutor {
  const database = openDatabase(path, options);

  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    const cached = cache.get(sql);
    if (cached !== undefined) return cached;
    const statement = database.prepare(sql);
    cache.set(sql, statement);
    return statement;
  };

  function runStatement(statement: Statement): StatementResult {
    const prepared = prepare(statement.sql);
    if (prepared.columns().length === 0) {
      const { changes } = prepared.run(...statement.params);
      return { changes: Number(changes), rows: [] };
    }
    const rows = prepared.all(...statement.params).map(toPlainRow);
    return { changes: RETURNING.test(statement.sql) ? rows.length : 0, rows };
  }

  const executor: SqlExecutor = {
    driver: 'node-sqlite',
    async all<R = Record<string, unknown>>(statement: Statement): Promise<R[]> {
      assertParams(statement.params);
      try {
        const prepared = prepare(statement.sql);
        if (prepared.columns().length === 0) {
          prepared.run(...statement.params);
          return [];
        }
        return prepared.all(...statement.params).map(toPlainRow) as R[];
      } catch (error) {
        throw classifySqliteError(error);
      }
    },
    async batch(statements: readonly Statement[]): Promise<StatementResult[]> {
      if (statements.length === 0) return [];
      for (const statement of statements) assertParams(statement.params);
      try {
        database.exec('BEGIN IMMEDIATE');
        const results = statements.map((statement) => runStatement(statement));
        database.exec('COMMIT');
        return results;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // the transaction never opened or already ended; the original error wins
        }
        throw classifySqliteError(error);
      }
    },
  };

  return {
    executor,
    close: async () => {
      cache.clear();
      database.close();
    },
  };
}
