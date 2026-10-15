import { describe, expect, it } from 'vitest';
import { ORG_SLUG_PATTERN } from './organization.js';
import {
  orgContext,
  type OrgId,
  type ScalarSqlExecutor,
  type ScalarStatement,
  type SqlExecutor,
} from './port.js';

describe('orgContext', () => {
  it('returns a frozen context', () => {
    const ctx = orgContext('acme');
    expect(ctx.orgId).toBe('acme');
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('rejects an empty org id', () => {
    expect(() => orgContext('')).toThrow(TypeError);
    expect(() => orgContext('')).toThrow('orgId must be a non-empty string');
  });

  it('rejects a non-string org id', () => {
    expect(() => orgContext(42 as never)).toThrow(TypeError);
  });
});

describe('OrgId', () => {
  it('does not accept a plain string', () => {
    // @ts-expect-error a plain string is not an OrgId
    const id: OrgId = 'acme';
    expect(id).toBe('acme');
  });
});

describe('ScalarStatement', () => {
  it('rejects a Uint8Array parameter', () => {
    const params = [new Uint8Array([1])];
    // @ts-expect-error a Uint8Array is not a scalar parameter
    const statement: ScalarStatement = { sql: 'insert into t values (?)', params };
    expect(statement.params).toHaveLength(1);
  });
});

describe('ScalarSqlExecutor', () => {
  it('accepts a full SqlExecutor', () => {
    const full = null as unknown as SqlExecutor;
    const scalar: ScalarSqlExecutor = full;
    expect(scalar).toBe(full);
  });
});

describe('ORG_SLUG_PATTERN', () => {
  const valid = ['a', 'acme', 'acme-2', 'a'.repeat(64)];
  const invalid = ['', '-a', 'a-', 'A', 'a b', 'a/b', 'a'.repeat(65)];

  it.each(valid)('accepts %j', (slug) => {
    expect(ORG_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each(invalid)('rejects %j', (slug) => {
    expect(ORG_SLUG_PATTERN.test(slug)).toBe(false);
  });
});
