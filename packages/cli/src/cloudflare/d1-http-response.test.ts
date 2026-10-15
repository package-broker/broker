import { DbError } from '@package-broker/core/db/errors';
import { describe, expect, it } from 'vitest';
import { parseD1Response, redact } from './d1-http-response.js';

const meta = (changes: number) => ({
  served_by: 'v3-prod',
  duration: 0.1,
  changes,
  last_row_id: 9,
  changed_db: changes > 0,
  rows_read: 1,
  rows_written: changes,
});

const success = (result: unknown) =>
  JSON.stringify({ result, errors: [], messages: [], success: true });

const batchFailure = (message: string) =>
  JSON.stringify({ messages: [], result: [], success: false, errors: [{ code: 7500, message }] });

const UNIQUE_T83 =
  'UNIQUE constraint failed: t.v: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE) [code: 7500]';
const UNIQUE_BATCH =
  'UNIQUE constraint failed: t.v: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)';

function thrown(fn: () => unknown): DbError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    return error as DbError;
  }
  throw new Error('expected a DbError');
}

describe('parseD1Response', () => {
  it('maps rows and changes for a success with two results', () => {
    const body = success([
      { results: [], success: true, meta: meta(1) },
      { results: [{ n: 3, ids: '1,8,9' }], success: true, meta: meta(0) },
    ]);

    expect(parseD1Response(200, body, 2, [])).toEqual([
      { rows: [], changes: 1 },
      { rows: [{ n: 3, ids: '1,8,9' }], changes: 0 },
    ]);
  });

  it('maps a three-statement batch success', () => {
    const body = success([
      { results: [], success: true, meta: meta(1) },
      { results: [], success: true, meta: meta(1) },
      { results: [], success: true, meta: meta(1) },
    ]);

    expect(parseD1Response(200, body, 3, []).map((result) => result.changes)).toEqual([1, 1, 1]);
  });

  it('defaults changes to 0 when the result has no meta', () => {
    const body = success([{ results: [], success: true }]);

    expect(parseD1Response(200, body, 1, [])).toEqual([{ rows: [], changes: 0 }]);
  });

  it('treats missing results as no rows when the result has success true and meta', () => {
    const body = success([{ success: true, meta: meta(2) }]);

    expect(parseD1Response(200, body, 1, [])).toEqual([{ rows: [], changes: 2 }]);
  });

  it.each([
    [
      'one result when two are expected',
      success([{ results: [], success: true, meta: meta(0) }]),
      2,
    ],
    [
      'three results when two are expected',
      success([{}, {}, {}].map(() => ({ results: [], success: true, meta: meta(0) }))),
      2,
    ],
    ['result not an array', success({ results: [], success: true, meta: meta(0) }), 1],
    ['result missing', JSON.stringify({ errors: [], success: true }), 1],
    ['result entry not an object', success([null]), 1],
    ['result entry an array', success([[]]), 1],
    ['results not an array', success([{ results: {}, success: true, meta: meta(0) }]), 1],
    ['results missing without meta', success([{ success: true }]), 1],
    ['results missing without success', success([{ meta: meta(0) }]), 1],
    ['row not an object', success([{ results: [1], success: true, meta: meta(0) }]), 1],
    ['meta not an object', success([{ results: [], success: true, meta: 'x' }]), 1],
    ['meta null', success([{ results: [], success: true, meta: null }]), 1],
    ['meta.changes a string', success([{ results: [], success: true, meta: { changes: '1' } }]), 1],
    ['meta.changes null', success([{ results: [], success: true, meta: { changes: null } }]), 1],
    ['meta.changes missing', success([{ results: [], success: true, meta: {} }]), 1],
    ['meta.changes negative', success([{ results: [], success: true, meta: { changes: -1 } }]), 1],
    [
      'meta.changes fractional',
      success([{ results: [], success: true, meta: { changes: 1.5 } }]),
      1,
    ],
    [
      'meta.changes unsafe',
      success([{ results: [], success: true, meta: { changes: 2 ** 53 } }]),
      1,
    ],
  ])('rejects %s as malformed', (_label, body, expected) => {
    const error = thrown(() => parseD1Response(200, body, expected, []));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('d1 http malformed response');
    expect(error.cause).toBeNull();
  });

  it('classifies a per-result success false with an error', () => {
    const body = success([
      { results: [], success: true, meta: meta(1) },
      { success: false, error: UNIQUE_T83 },
    ]);

    const error = thrown(() => parseD1Response(200, body, 2, []));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
    expect(error.message).toContain(UNIQUE_T83);
    expect(error.cause).toBeNull();
  });

  it('classifies success false with the T83 message as a unique violation on t.v', () => {
    const error = thrown(() => parseD1Response(400, batchFailure(UNIQUE_T83), 2, []));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
    expect(error.cause).toBeNull();
  });

  it('classifies the batch-form failure whose message lacks the code suffix', () => {
    const error = thrown(() => parseD1Response(400, batchFailure(UNIQUE_BATCH), 2, []));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
    expect(error.cause).toBeNull();
  });

  it('joins several error messages with a semicolon', () => {
    const body = JSON.stringify({
      success: false,
      errors: [{ code: 1, message: 'first' }, { code: 2 }, { message: 'second' }],
      result: [{ success: false, error: 'third' }],
    });

    const error = thrown(() => parseD1Response(400, body, 1, []));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('unknown: first; second; third');
  });

  it('treats a non-2xx status as a failure even when success is true', () => {
    const body = JSON.stringify({
      success: true,
      errors: [{ message: 'database is locked' }],
      result: [],
    });

    expect(thrown(() => parseD1Response(503, body, 1, [])).kind).toBe('busy');
  });

  it('reports the status when a failure carries no message text', () => {
    const body = JSON.stringify({ success: false, errors: [], result: [] });

    const error = thrown(() => parseD1Response(400, body, 1, []));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('d1 http 400');
    expect(error.cause).toBeNull();
  });

  it.each(['[]', 'null', '42', '"text"', 'true'])(
    'reports the status for the non-object JSON body %s on 2xx',
    (body) => {
      const error = thrown(() => parseD1Response(200, body, 1, []));

      expect(error.kind).toBe('unknown');
      expect(error.message).toBe('d1 http 200');
      expect(error.cause).toBeNull();
    },
  );

  it('reports a failed statement that carries no error text', () => {
    const body = success([{ results: [], success: true, meta: meta(1) }, { success: false }]);

    const error = thrown(() => parseD1Response(200, body, 2, []));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('d1 http 200 statement failed');
    expect(error.cause).toBeNull();
  });

  it('takes the constraint from the first message that names one, not the joined text', () => {
    const body = JSON.stringify({
      success: false,
      result: [],
      errors: [{ message: 'UNIQUE constraint failed: t.v' }, { message: 'second' }],
    });

    const error = thrown(() => parseD1Response(400, body, 1, []));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
    expect(error.message).toBe('unique: UNIQUE constraint failed: t.v; second');
  });

  it('classifies a later message when the first one names no SQLite error', () => {
    const body = JSON.stringify({
      success: false,
      result: [],
      errors: [{ message: 'statement 2 failed' }, { message: UNIQUE_T83 }],
    });

    const error = thrown(() => parseD1Response(400, body, 2, []));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
  });

  it('classifies on the raw text before redacting', () => {
    const error = thrown(() =>
      parseD1Response(400, batchFailure(UNIQUE_T83), 2, ['constraint failed']),
    );

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('t.v');
    expect(error.message).not.toContain('constraint failed');
  });

  it('redacts the constraint separately', () => {
    const message = 'UNIQUE constraint failed: tok-secret-123.v: SQLITE_CONSTRAINT';

    const error = thrown(() => parseD1Response(400, batchFailure(message), 1, ['tok-secret-123']));

    expect(error.kind).toBe('unique');
    expect(error.constraint).toBe('[redacted].v');
    expect(error.message).not.toContain('tok-secret-123');
  });

  it('redacts a secret that spans the kind prefix of the classified message', () => {
    const error = thrown(() => parseD1Response(400, batchFailure('boom'), 1, ['unknown: boom']));

    expect(error.message).not.toContain('unknown: boom');
    expect(error.message).toContain('[redacted]');
  });

  it('redacts a secret that spans two joined messages', () => {
    const body = JSON.stringify({
      success: false,
      result: [],
      errors: [{ message: 'tok-se' }, { message: 'cret' }],
    });

    const error = thrown(() => parseD1Response(400, body, 1, ['tok-se; cret']));

    expect(error.message).not.toContain('tok-se; cret');
    expect(error.message).toContain('[redacted]');
  });

  it('redacts the malformed-response message', () => {
    const error = thrown(() => parseD1Response(200, success({}), 1, ['malformed']));

    expect(error.message).not.toContain('malformed');
    expect(error.message).toContain('[redacted]');
  });

  it('redacts the bare status message', () => {
    const error = thrown(() => parseD1Response(502, '<html></html>', 1, ['502']));

    expect(error.message).toBe('d1 http [redacted]');
  });

  it('strips account and database ids from Cloudflare API routes', () => {
    const message =
      'A request to the Cloudflare API (/accounts/0a1b2c3d/d1/database/5f0e-77aa-uuid/query) failed.';

    const error = thrown(() => parseD1Response(400, batchFailure(message), 1, []));

    expect(error.message).toContain('/accounts/[redacted]/d1/database/[redacted]/query');
    expect(error.message).not.toContain('0a1b2c3d');
    expect(error.message).not.toContain('5f0e-77aa-uuid');
  });

  it('caps the message at 500 characters with a visible marker', () => {
    const long = `${'x'.repeat(480)} tok-secret-123 ${'y'.repeat(2000)}`;

    const error = thrown(() => parseD1Response(400, batchFailure(long), 1, ['tok-secret-123']));

    expect(error.message.length).toBeLessThanOrEqual(500);
    expect(error.message.endsWith('[truncated]')).toBe(true);
    expect(error.message).not.toContain('tok-secret');
  });

  it('reports the status for an HTML body', () => {
    const error = thrown(() =>
      parseD1Response(502, '<html><body>502 Bad Gateway</body></html>', 1, []),
    );

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('d1 http 502');
    expect(error.cause).toBeNull();
  });

  it('reports the status for a non-object JSON body on a non-2xx status', () => {
    expect(thrown(() => parseD1Response(500, 'null', 1, [])).message).toBe('d1 http 500');
  });

  it('redacts a secret echoed in errors[].message and drops the cause', () => {
    const body = JSON.stringify({
      success: false,
      result: [],
      errors: [{ code: 10000, message: 'Authentication error: token tok-secret-123 is invalid' }],
    });

    const error = thrown(() => parseD1Response(403, body, 1, ['tok-secret-123']));

    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('tok-secret-123');
    expect(error.cause).toBeNull();
  });

  it('redacts a secret echoed in a per-result error', () => {
    const body = success([{ success: false, error: 'near "tok-secret-123": syntax error' }]);

    const error = thrown(() => parseD1Response(200, body, 1, ['tok-secret-123']));

    expect(error.message).not.toContain('tok-secret-123');
    expect(error.cause).toBeNull();
  });
});

describe('redact', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redact('a s1 b s2 c s1', ['s1', 's2'])).toBe('a [redacted] b [redacted] c [redacted]');
  });

  it('ignores empty secrets', () => {
    expect(redact('abc', ['', 'b'])).toBe('a[redacted]c');
  });

  it('treats secrets literally, not as patterns', () => {
    expect(redact('x a.c y abc', ['a.c'])).toBe('x [redacted] y abc');
  });

  it('redacts the longer of two overlapping secrets whole', () => {
    expect(redact('key=abcdef', ['abc', 'abcdef'])).toBe('key=[redacted]');
  });

  it('strips Cloudflare D1 route segments without a secret list', () => {
    expect(redact('see /accounts/abc/d1/database/def/query here', [])).toBe(
      'see /accounts/[redacted]/d1/database/[redacted]/query here',
    );
  });

  it('returns the text unchanged without secrets', () => {
    expect(redact('plain', [])).toBe('plain');
  });
});
