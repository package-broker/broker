import { DbError, classifySqliteError, type DbErrorKind } from '@package-broker/core/db/errors';
import type { StatementResult } from '@package-broker/core/db/port';

type JsonObject = Record<string, unknown>;

const REDACTED = '[redacted]';
const TRUNCATED = ' [truncated]';
const MAX_MESSAGE_LENGTH = 500;
const D1_ROUTE = /\/accounts\/[^/\s]+\/d1\/database\/[^/\s]+/g;

export function redact(text: string, secrets: readonly string[]): string {
  const literals = secrets
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const withoutSecrets =
    literals.length === 0 ? text : text.replace(new RegExp(literals.join('|'), 'g'), REDACTED);
  return withoutSecrets.replace(D1_ROUTE, `/accounts/${REDACTED}/d1/database/${REDACTED}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChangeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cap(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - TRUNCATED.length) + TRUNCATED;
}

class Thrower {
  constructor(
    private readonly status: number,
    private readonly secrets: readonly string[],
  ) {}

  error(kind: DbErrorKind, message: string, constraint?: string): DbError {
    return new DbError(kind, cap(redact(message, this.secrets)), {
      cause: null,
      constraint: constraint === undefined ? undefined : redact(constraint, this.secrets),
    });
  }

  bareStatus(): DbError {
    return this.error('unknown', `d1 http ${this.status}`);
  }

  malformed(): DbError {
    return this.error('unknown', 'd1 http malformed response');
  }

  failure(body: unknown, statementFailed: boolean): DbError {
    const messages: string[] = [];
    if (isObject(body)) {
      if (Array.isArray(body.errors)) {
        for (const entry of body.errors) {
          if (isObject(entry) && typeof entry.message === 'string') messages.push(entry.message);
        }
      }
      if (Array.isArray(body.result)) {
        for (const entry of body.result) {
          if (isObject(entry) && typeof entry.error === 'string') messages.push(entry.error);
        }
      }
    }
    const texts = messages.filter((message) => message !== '');
    if (texts.length === 0) {
      if (statementFailed) return this.error('unknown', `d1 http ${this.status} statement failed`);
      return this.bareStatus();
    }
    const classified = texts
      .map((text) => classifySqliteError(new Error(text)))
      .find((error) => error.kind !== 'unknown');
    const kind = classified?.kind ?? 'unknown';
    return this.error(kind, `${kind}: ${texts.join('; ')}`, classified?.constraint);
  }
}

function statementResult(entry: unknown, thrower: Thrower): StatementResult {
  if (!isObject(entry)) throw thrower.malformed();
  const { meta } = entry;
  if (meta !== undefined && !isObject(meta)) throw thrower.malformed();
  const changes = meta === undefined ? 0 : meta.changes;
  if (!isChangeCount(changes)) throw thrower.malformed();

  let rows: unknown;
  if (entry.results !== undefined) rows = entry.results;
  else if (entry.success === true && meta !== undefined) rows = [];
  if (!Array.isArray(rows) || !rows.every(isObject)) throw thrower.malformed();

  return { rows, changes };
}

export function parseD1Response(
  status: number,
  bodyText: string,
  expectedResults: number,
  secrets: readonly string[],
): StatementResult[] {
  const thrower = new Thrower(status, secrets);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw thrower.bareStatus();
  }

  const ok = status >= 200 && status < 300;
  if (!ok || !isObject(body) || body.success !== true) throw thrower.failure(body, false);

  const { result } = body;
  if (!Array.isArray(result)) throw thrower.malformed();
  if (result.some((entry) => isObject(entry) && entry.success === false)) {
    throw thrower.failure(body, true);
  }
  if (result.length !== expectedResults) throw thrower.malformed();
  return result.map((entry) => statementResult(entry, thrower));
}
