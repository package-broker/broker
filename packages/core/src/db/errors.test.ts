import { describe, expect, it } from 'vitest';
import {
  ACCESS_MUTATION_GUARD_CONSTRAINT,
  DbError,
  assertBatchStatementCount,
  classifySqliteError,
} from './errors.js';
import { D1_STATEMENTS_PER_BATCH, D1_STATEMENTS_PER_INVOCATION } from './port.js';
import type { DbErrorKind } from './errors.js';

const cases: readonly (readonly [string, DbErrorKind, string | undefined])[] = [
  [
    'D1_ERROR: UNIQUE constraint failed: version.package_id, version.normalized: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
    'unique',
    'version.package_id, version.normalized',
  ],
  [
    'UNIQUE constraint failed: t.v: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE) [code: 7500]',
    'unique',
    't.v',
  ],
  [
    'UNIQUE constraint failed: version.package_id, version.normalized',
    'unique',
    'version.package_id, version.normalized',
  ],
  ['NOT NULL constraint failed: audit_event.action', 'not_null', 'audit_event.action'],
  ['FOREIGN KEY constraint failed', 'foreign_key', undefined],
  ['CHECK constraint failed: singleton = 1', 'check', undefined],
  ['database is locked', 'busy', undefined],
  ['SQLITE_BUSY', 'busy', undefined],
  ['too many SQL variables', 'too_big', undefined],
  ['D1_ERROR: string or blob too big: SQLITE_TOOBIG', 'too_big', undefined],
];

describe('classifySqliteError', () => {
  it.each(cases)('classifies %j as %s', (message, kind, constraint) => {
    const error = classifySqliteError(new Error(message));

    expect(error.kind).toBe(kind);
    expect(error.constraint).toBe(constraint);
    expect(error.message).toBe(`${kind}: ${message}`);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(message);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DbError');
  });

  it('classifies through the cause when the message carries no marker', () => {
    const cause = new Error('database is locked');
    const error = classifySqliteError(new Error('executor failed', { cause }));

    expect(error.kind).toBe('busy');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('executor failed');
    expect(error.message).toBe('busy: executor failed');
  });

  it('returns a DbError input unchanged', () => {
    const original = new DbError('unique', 'unique: boom', { cause: new Error('boom') });

    expect(classifySqliteError(original)).toBe(original);
  });

  it('classifies a raw string as unknown and keeps it as cause', () => {
    const error = classifySqliteError('boom');

    expect(error.kind).toBe('unknown');
    expect(error.constraint).toBeUndefined();
    expect(error.cause).toBe('boom');
    expect(error.message).toBe('unknown: boom');
    expect(error).toBeInstanceOf(DbError);
    expect(error).toBeInstanceOf(Error);
  });

  it('classifies a non-Error object with a marker message as unknown', () => {
    const error = classifySqliteError({ code: 5 });

    expect(error.kind).toBe('unknown');
    expect(error.cause).toEqual({ code: 5 });
    expect(error).toBeInstanceOf(DbError);
  });

  it.each(cases.map(([message]) => message))(
    'classifies a non-Error object carrying %j as unknown',
    (message) => {
      const input = { message, sql: 'select 1' };

      const error = classifySqliteError(input);

      expect(error.kind).toBe('unknown');
      expect(error.constraint).toBeUndefined();
      expect(error.cause).toBe(input);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toBeInstanceOf(Error);
    },
  );

  it.each(cases.map(([message]) => message))(
    'classifies a non-Error object whose cause carries %j as unknown',
    (message) => {
      const input = { code: 7500, cause: { message } };

      const error = classifySqliteError(input);

      expect(error.kind).toBe('unknown');
      expect(error.constraint).toBeUndefined();
      expect(error.cause).toBe(input);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toBeInstanceOf(Error);
    },
  );
});

describe('ACCESS_MUTATION_GUARD_CONSTRAINT', () => {
  it.each([
    'D1_ERROR: UNIQUE constraint failed: access_mutation_guard.key: SQLITE_CONSTRAINT',
    'UNIQUE constraint failed: access_mutation_guard.key',
    'UNIQUE constraint failed: access_mutation_guard.key: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY) [code: 1555]',
  ])('is the constraint parsed from %j', (message) => {
    const error = classifySqliteError(new Error(message));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe(ACCESS_MUTATION_GUARD_CONSTRAINT);
  });
});

describe('assertBatchStatementCount', () => {
  it('pins the D1 budgets', () => {
    expect(D1_STATEMENTS_PER_BATCH).toBe(200);
    expect(D1_STATEMENTS_PER_INVOCATION).toBe(500);
  });

  it('accepts counts up to the per-batch budget', () => {
    expect(() => assertBatchStatementCount(0)).not.toThrow();
    expect(() => assertBatchStatementCount(D1_STATEMENTS_PER_BATCH)).not.toThrow();
  });

  it('rejects a count above the per-batch budget as too_big without request data', () => {
    let thrown: unknown;
    try {
      assertBatchStatementCount(D1_STATEMENTS_PER_BATCH + 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DbError);
    expect(thrown).toMatchObject({ kind: 'too_big' });
    expect((thrown as DbError).message).toBe(
      'too_big: batch holds 201 statements, D1 allows at most 200',
    );
  });
});
