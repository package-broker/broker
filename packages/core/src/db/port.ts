/** Shared portability limits; invocation scheduling remains the caller's responsibility. */
export const D1_STATEMENTS_PER_BATCH = 200;
export const D1_STATEMENTS_PER_INVOCATION = 500;
/** Leave room for reads, lease checks and completion outside the ingest chunk. */
export const D1_INVOCATION_STATEMENT_RESERVE = 50;

export type ScalarSqlValue = string | number | null; // number: finite; integers must be safe integers
export type SqlValue = ScalarSqlValue | Uint8Array;

export interface Statement<P extends SqlValue = SqlValue> {
  readonly sql: string;
  readonly params: readonly P[];
}
export type ScalarStatement = Statement<ScalarSqlValue>;

export interface StatementResult<R = Record<string, unknown>> {
  readonly rows: R[];
  /** Rows changed by INSERT/UPDATE/DELETE; 0 for SELECT. With RETURNING, equals rows.length. */
  readonly changes: number;
}

/** Executor restricted to scalar parameters. The migration runner and bootstrap accept this type. */
export interface ScalarSqlExecutor {
  readonly driver: 'd1' | 'd1-http' | 'better-sqlite3' | 'node-sqlite' | 'none';
  all<R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]>;
  batch(statements: readonly ScalarStatement[]): Promise<StatementResult[]>;
}

/** Full executor: also binds and returns BLOBs as Uint8Array. */
export interface SqlExecutor extends ScalarSqlExecutor {
  all<R = Record<string, unknown>>(statement: Statement): Promise<R[]>;
  batch(statements: readonly Statement[]): Promise<StatementResult[]>;
}

export type OrgId = string & { readonly __brand: 'OrgId' };

export interface OrgContext {
  readonly orgId: OrgId;
}

/** Only the kernel and tests call this. */
export function orgContext(orgId: string): OrgContext {
  if (typeof orgId !== 'string' || orgId === '') {
    throw new TypeError('orgId must be a non-empty string');
  }
  return Object.freeze({ orgId: orgId as OrgId });
}
