import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { db } from '../kysely.js';
import {
  DEFAULT_IDLE_SECONDS,
  liveSessionCondition,
  requireIdleSeconds,
} from './session-liveness.js';

const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function nowOffset(seconds: string): RawBuilder<string> {
  return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${sql.lit(`${seconds} seconds`)})`;
}

interface Row {
  readonly revokedAt?: RawBuilder<unknown>;
  readonly expiresAt?: RawBuilder<unknown>;
  readonly createdAt?: RawBuilder<unknown>;
  readonly lastSeenAt?: RawBuilder<unknown>;
}

const textForm = sql`(s.revoked_at is null
  and s.expires_at > ${NOW}
  and coalesce(s.last_seen_at, s.created_at) > ${nowOffset('-3600')})`;

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(':memory:');
});

afterEach(() => {
  database.close();
});

function evaluate(row: Row): { readonly shared: number; readonly text: number } {
  const query = sql<{ shared: number; text: number }>`select
      ${liveSessionCondition('s', DEFAULT_IDLE_SECONDS)} as shared,
      ${textForm} as text
    from (select
      ${row.revokedAt ?? sql`null`} as revoked_at,
      ${row.expiresAt ?? nowOffset('+3600')} as expires_at,
      ${row.createdAt ?? nowOffset('-7200')} as created_at,
      ${row.lastSeenAt ?? sql`null`} as last_seen_at) as s`.compile(db);
  expect(query.parameters).toHaveLength(0);
  const result = database.prepare(query.sql).get() as { shared: unknown; text: unknown };
  return { shared: Number(result.shared ?? 0), text: Number(result.text ?? 0) };
}

describe('requireIdleSeconds', () => {
  it('defaults to one hour', () => {
    expect(DEFAULT_IDLE_SECONDS).toBe(3600);
  });

  it.each([60, 3600, 86400])('accepts %s', (value) => {
    expect(requireIdleSeconds(value)).toBe(value);
  });

  it.each([59, 86401, 90.5, Number.NaN, Number.POSITIVE_INFINITY, -3600])(
    'throws RangeError for %s',
    (value) => {
      expect(() => requireIdleSeconds(value)).toThrow(RangeError);
    },
  );
});

describe('liveSessionCondition', () => {
  it('binds no parameters', () => {
    const compiled = sql`select ${liveSessionCondition('s', 600)}`.compile(db);
    expect(compiled.parameters).toHaveLength(0);
    expect(compiled.sql).toContain('600');
  });

  it.each([59, 86401, 90.5, Number.NaN])('throws RangeError for idleSeconds %s', (value) => {
    expect(() => liveSessionCondition('s', value)).toThrow(RangeError);
  });

  it('agrees with the text form when last seen exactly one idle window ago', () => {
    expect(evaluate({ lastSeenAt: nowOffset('-3600') })).toEqual({ shared: 0, text: 0 });
  });

  it('agrees with the text form when last seen one millisecond inside the idle window', () => {
    expect(evaluate({ lastSeenAt: nowOffset('-3599.999') })).toEqual({ shared: 1, text: 1 });
  });

  it('agrees with the text form when last seen one millisecond past the idle window', () => {
    expect(evaluate({ lastSeenAt: nowOffset('-3600.001') })).toEqual({ shared: 0, text: 0 });
  });

  it('agrees with the text form when a never-seen session was created exactly one idle window ago', () => {
    expect(evaluate({ createdAt: nowOffset('-3600') })).toEqual({ shared: 0, text: 0 });
  });

  it('agrees with the text form when a never-seen session was created one millisecond inside the idle window', () => {
    expect(evaluate({ createdAt: nowOffset('-3599.999') })).toEqual({ shared: 1, text: 1 });
  });

  it('agrees with the text form when the session expires exactly now', () => {
    expect(evaluate({ lastSeenAt: NOW, expiresAt: NOW })).toEqual({ shared: 0, text: 0 });
  });

  it('agrees with the text form when the session expires one millisecond from now', () => {
    expect(evaluate({ lastSeenAt: NOW, expiresAt: nowOffset('+0.001') })).toEqual({
      shared: 1,
      text: 1,
    });
  });

  it('agrees with the text form for a revoked session', () => {
    expect(evaluate({ lastSeenAt: NOW, revokedAt: NOW })).toEqual({ shared: 0, text: 0 });
  });

  it('fails closed on a malformed last_seen_at the text form accepts', () => {
    expect(evaluate({ lastSeenAt: sql`'not-a-timestamp'` })).toEqual({ shared: 0, text: 1 });
  });

  it('fails closed on a malformed created_at the text form accepts', () => {
    expect(evaluate({ createdAt: sql`'not-a-timestamp'` })).toEqual({ shared: 0, text: 1 });
  });

  it('fails closed on a malformed expires_at the text form accepts', () => {
    expect(evaluate({ lastSeenAt: NOW, expiresAt: sql`'not-a-timestamp'` })).toEqual({
      shared: 0,
      text: 1,
    });
  });

  describe('absolute lifetime', () => {
    const future = { expiresAt: nowOffset('+86400'), lastSeenAt: NOW };

    it('refuses a session created 12 h and 1 s ago', () => {
      expect(evaluate({ ...future, createdAt: nowOffset('-43201') }).shared).toBe(0);
    });

    it('refuses a session created exactly 12 h ago', () => {
      expect(evaluate({ ...future, createdAt: nowOffset('-43200') }).shared).toBe(0);
    });

    it('accepts a session created 12 h minus 1 s ago', () => {
      expect(evaluate({ ...future, createdAt: nowOffset('-43199') }).shared).toBe(1);
    });

    it('refuses a malformed created_at even when last_seen_at is fresh', () => {
      expect(evaluate({ ...future, createdAt: sql`'not-a-timestamp'` }).shared).toBe(0);
    });
  });
});
