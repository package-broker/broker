import { DbError, assertBatchStatementCount } from '@package-broker/core/db/errors';
import type {
  ScalarSqlExecutor,
  ScalarStatement,
  StatementResult,
} from '@package-broker/core/db/port';
import { scanSql } from '@package-broker/db-sqlite/sql/scan';
import { splitStatements } from '@package-broker/db-sqlite/migrations/split';
import { parseD1Response } from './d1-http-response.js';

export interface D1HttpOptions {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface WireStatement {
  readonly sql: string;
  readonly params: readonly (string | number | null)[];
}

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 35_000;
const MAX_TIMEOUT_MS = 600_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const ROUTE_ID = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100_000;

const encoder = new TextEncoder();

export class D1LostResponseError extends DbError {
  readonly lostResponse = true;
}

export function isLostResponse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof D1LostResponseError) return true;
    current = current.cause;
  }
  return false;
}

function typeLabel(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  try {
    if (Array.isArray(value)) return 'array';
  } catch {
    return 'object';
  }
  return ArrayBuffer.isView(value) ? 'binary' : 'object';
}

function checkParam(value: unknown, at: string): void {
  if (value === null || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${at} must be a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${at} must be a safe integer`);
    }
    return;
  }
  throw new TypeError(`${at} has unsupported type ${typeLabel(value)}`);
}

function singleStatement(sql: string, label: string): string {
  let segments;
  try {
    segments = scanSql(sql);
  } catch (error) {
    throw new TypeError(`${label} cannot be scanned: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const uncommented = segments
    .map((segment) => (segment.kind === 'comment' ? ' ' : segment.text))
    .join('');
  if (/^\s*CREATE\s+TRIGGER\b/i.test(uncommented)) {
    let statements: string[];
    try {
      statements = splitStatements(sql);
    } catch (error) {
      throw new TypeError(`${label} must be a single statement`, { cause: error });
    }
    if (statements.length !== 1) throw new TypeError(`${label} must be a single statement`);
    return sql;
  }
  const semicolons: number[] = [];
  let hasContent = false;
  for (const segment of segments) {
    if (segment.kind === 'comment') continue;
    if (segment.kind !== 'code' || segment.text.replace(/;/g, '').trim() !== '') hasContent = true;
    if (segment.kind !== 'code') continue;
    for (
      let index = segment.text.indexOf(';');
      index !== -1;
      index = segment.text.indexOf(';', index + 1)
    ) {
      semicolons.push(segment.start + index);
    }
  }
  if (!hasContent) throw new TypeError(`${label} is empty`);
  const [only] = semicolons;
  if (only === undefined) return sql;
  if (semicolons.length === 1 && sql.slice(only + 1).trim() === '') return sql.slice(0, only);
  throw new TypeError(`${label} must be a single statement`);
}

function toWire(statement: ScalarStatement | undefined, label: string): WireStatement {
  if (typeof statement !== 'object' || statement === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const { sql, params } = statement;
  if (typeof sql !== 'string') throw new TypeError(`${label} sql must be a string`);
  if (!Array.isArray(params)) throw new TypeError(`${label} params must be an array`);
  if (params.length > MAX_PARAMS) {
    throw new TypeError(`${label} has ${params.length} parameters, at most ${MAX_PARAMS}`);
  }
  const values: (string | number | null)[] = [];
  for (let index = 0; index < params.length; index += 1) {
    const value: unknown = params[index];
    checkParam(value, `${label} parameter ${index}`);
    values.push(value as string | number | null);
  }
  const single = singleStatement(sql, label);
  const bytes = encoder.encode(single).length;
  if (bytes > MAX_SQL_BYTES) {
    throw new TypeError(`${label} is ${bytes} bytes of SQL, at most ${MAX_SQL_BYTES}`);
  }
  return { sql: single, params: values };
}

function queryBase(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an absolute URL');
  }
  const secure =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!secure) throw new TypeError('baseUrl must use https (http only for loopback hosts)');
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('baseUrl must not carry credentials, a query or a fragment');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function timeoutOf(value: number | undefined): number {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_MS
  ) {
    return value;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * `ScalarSqlExecutor` over the D1 HTTP query API: `all()` sends `{ sql, params }`, `batch()` sends
 * the atomic `batch` form. Values are only ever bound, never written into SQL text.
 *
 * Argument validation fails with a `TypeError`, and a synchronous throw from `fetch` fails with a
 * plain `DbError`; in both cases nothing was sent. Every asynchronous transport failure after the
 * request was handed to `fetch` rejects with `D1LostResponseError` (a `DbError` of kind
 * `unknown`; test it with `isLostResponse`) and one of two fixed messages:
 * - `d1 http request failed`: no response arrived (connection error, redirect, timeout, abort).
 *   `fetch` cannot say whether the body reached D1, so the outcome is unknown.
 * - `d1 http response read failed`: a response started but its body could not be read.
 *
 * The statement or batch may have committed, so callers must not retry it automatically.
 */
export function createD1HttpExecutor(options: D1HttpOptions): ScalarSqlExecutor {
  const { accountId, databaseId, apiToken } = options;
  if (typeof accountId !== 'string' || !ROUTE_ID.test(accountId)) {
    throw new TypeError('accountId must match [A-Za-z0-9-]{1,64}');
  }
  if (typeof databaseId !== 'string' || !ROUTE_ID.test(databaseId)) {
    throw new TypeError('databaseId must match [A-Za-z0-9-]{1,64}');
  }
  if (typeof apiToken !== 'string' || !HEADER_SAFE_TOKEN.test(apiToken)) {
    throw new TypeError('apiToken must be a non-empty string of visible ASCII characters');
  }

  const send = options.fetch ?? globalThis.fetch;
  const url = `${queryBase(options.baseUrl ?? DEFAULT_BASE_URL)}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const timeoutMs = timeoutOf(options.timeoutMs);
  const secrets = [apiToken, accountId, databaseId];

  async function post(body: unknown, expectedResults: number): Promise<StatementResult[]> {
    let pending: Promise<Response>;
    try {
      pending = send(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DbError('unknown', 'd1 http request failed', { cause: null });
    }
    let response: Response;
    try {
      response = await pending;
    } catch {
      throw new D1LostResponseError('unknown', 'd1 http request failed', { cause: null });
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new D1LostResponseError('unknown', 'd1 http response read failed', { cause: null });
    }
    return parseD1Response(response.status, text, expectedResults, secrets);
  }

  return Object.freeze({
    driver: 'd1-http' as const,
    async all<R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> {
      const wire = toWire(statement, 'statement');
      const [result] = await post({ sql: wire.sql, params: wire.params }, 1);
      return (result?.rows ?? []) as R[];
    },
    async batch(statements: readonly ScalarStatement[]): Promise<StatementResult[]> {
      assertBatchStatementCount(statements.length);
      if (statements.length === 0) return [];
      const batch: WireStatement[] = [];
      for (let index = 0; index < statements.length; index += 1) {
        batch.push(toWire(statements[index], `statement ${index}`));
      }
      return post({ batch }, batch.length);
    },
  });
}
