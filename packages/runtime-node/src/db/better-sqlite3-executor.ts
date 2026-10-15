import Database from 'better-sqlite3';
import { classifySqliteError } from '@package-broker/core/db/errors';
import type {
  SqlExecutor,
  SqlValue,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';

export interface BetterSqliteOptions {
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const RETURNING = /\breturning\b/i;

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

function bindParams(params: readonly SqlValue[]): unknown[] {
  return params.map((value, index) => {
    assertParam(value, index);
    return value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value;
  });
}

function toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      Buffer.isBuffer(value) ? new Uint8Array(value) : value,
    ]),
  );
}

function openDatabase(path: string, busyTimeoutMs: number): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(path);
    database.pragma('foreign_keys = ON');
    database.pragma(`busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    if (path !== ':memory:') {
      database.pragma('journal_mode = WAL');
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

export function openBetterSqliteExecutor(
  path: string,
  options: BetterSqliteOptions = {},
): { readonly executor: SqlExecutor; close(): Promise<void> } {
  const database = openDatabase(path, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);

  const cache = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    const cached = cache.get(sql);
    if (cached !== undefined) return cached;
    const statement = database.prepare(sql);
    cache.set(sql, statement);
    return statement;
  };

  function runStatement(statement: Statement, params: unknown[]): StatementResult {
    const prepared = prepare(statement.sql);
    if (prepared.reader) {
      const rows = (prepared.all(...params) as Record<string, unknown>[]).map(toPlainRow);
      return { changes: RETURNING.test(statement.sql) ? rows.length : 0, rows };
    }
    const info = prepared.run(...params);
    return { changes: info.changes, rows: [] };
  }

  const runBatch = database.transaction(
    (statements: readonly Statement[], bound: unknown[][]): StatementResult[] =>
      statements.map((statement, index) => runStatement(statement, bound[index] ?? [])),
  );

  const executor: SqlExecutor = {
    driver: 'better-sqlite3',
    async all<R = Record<string, unknown>>(statement: Statement): Promise<R[]> {
      const params = bindParams(statement.params);
      try {
        const prepared = prepare(statement.sql);
        if (prepared.reader) {
          return (prepared.all(...params) as Record<string, unknown>[]).map(toPlainRow) as R[];
        }
        prepared.run(...params);
        return [];
      } catch (error) {
        throw classifySqliteError(error);
      }
    },
    async batch(statements: readonly Statement[]): Promise<StatementResult[]> {
      if (statements.length === 0) return [];
      const bound = statements.map((statement) => bindParams(statement.params));
      try {
        return runBatch.immediate(statements, bound);
      } catch (error) {
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
