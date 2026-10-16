import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  JobError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_PAYLOAD_BYTES,
  assertJobOwnedBy,
  canonicalPayload,
  parseQualifiedJobName,
  validateWithDefinition,
  defineJob,
  hashPayload,
  jobErrorCode,
  normalizeRunAt,
  qualifyJobName,
  retryDelaySeconds,
  storedIdempotencyKey,
  validateIdempotencyKey,
  validateJobPayload,
  validateSchedule,
} from './jobs.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof JobError) return error.code;
    throw error;
  }
  throw new Error('expected a JobError');
}

describe('qualifyJobName', () => {
  it('qualifies as plugin:name:vN', () => {
    expect(qualifyJobName('sessions', 'cleanup-expired', 1)).toBe('sessions:cleanup-expired:v1');
    expect(qualifyJobName('p1', 'a', 12)).toBe('p1:a:v12');
  });

  it('rejects the reserved core name and core plugin id', () => {
    expect(codeOf(() => qualifyJobName('p', 'core', 1))).toBe('invalid_name');
    expect(codeOf(() => qualifyJobName('core', 'x', 1))).toBe('invalid_name');
  });

  it.each(['', 'Upper', 'has_underscore', '1lead', '-lead', 'a b', 'a:b', 'ünï'])(
    'rejects name %j',
    (name) => {
      expect(codeOf(() => qualifyJobName('p', name, 1))).toBe('invalid_name');
    },
  );

  it('rejects over-long names', () => {
    expect(() => qualifyJobName('p', 'a'.repeat(64), 1)).not.toThrow();
    expect(codeOf(() => qualifyJobName('p', 'a'.repeat(65), 1))).toBe('invalid_name');
  });

  it('rejects plugin ids containing a colon, uppercase or empty', () => {
    expect(codeOf(() => qualifyJobName('a:b', 'x', 1))).toBe('invalid_name');
    expect(codeOf(() => qualifyJobName('', 'x', 1))).toBe('invalid_name');
    expect(codeOf(() => qualifyJobName('Plug', 'x', 1))).toBe('invalid_name');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects version %s',
    (version) => {
      expect(codeOf(() => qualifyJobName('p', 'x', version))).toBe('invalid_version');
    },
  );
});

describe('validateJobPayload', () => {
  it('accepts plain JSON and returns canonical key-sorted text', () => {
    const text = validateJobPayload({ b: 1, a: { d: [1, 'x', null, true], c: 'é' } });
    expect(text).toBe('{"a":{"c":"é","d":[1,"x",null,true]},"b":1}');
    expect(canonicalPayload({ a: 1, b: 2 })).toBe(canonicalPayload({ b: 2, a: 1 }));
  });

  it('accepts null-prototype objects and primitives', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.k = 1;
    expect(validateJobPayload(o)).toBe('{"k":1}');
    expect(validateJobPayload('s')).toBe('"s"');
  });

  it('rejects undefined at top level and nested, including in arrays', () => {
    expect(codeOf(() => validateJobPayload(undefined))).toBe('invalid_payload');
    expect(codeOf(() => validateJobPayload({ a: undefined }))).toBe('invalid_payload');
    expect(codeOf(() => validateJobPayload([undefined]))).toBe('invalid_payload');
  });

  it('rejects cycles', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(codeOf(() => validateJobPayload(a))).toBe('invalid_payload');
    const arr: unknown[] = [];
    arr.push(arr);
    expect(codeOf(() => validateJobPayload(arr))).toBe('invalid_payload');
  });

  it('accepts a shared (non-cyclic) reference', () => {
    const shared = { x: 1 };
    expect(validateJobPayload({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite number %s',
    (value) => {
      expect(codeOf(() => validateJobPayload({ n: value }))).toBe('invalid_payload');
      expect(codeOf(() => validateJobPayload(value))).toBe('invalid_payload');
    },
  );

  it('rejects accessors without invoking them', () => {
    let called = false;
    const o = {};
    Object.defineProperty(o, 'g', {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });
    expect(codeOf(() => validateJobPayload(o))).toBe('invalid_payload');
    expect(called).toBe(false);
    const setter = {};
    Object.defineProperty(setter, 's', { enumerable: true, set() {} });
    expect(codeOf(() => validateJobPayload(setter))).toBe('invalid_payload');
  });

  it('rejects functions, symbols, bigint, class instances, dates, maps and sparse arrays', () => {
    class Box {
      v = 1;
    }
    for (const bad of [
      () => 1,
      Symbol('s'),
      10n,
      new Box(),
      new Date(),
      new Map(),
      new Uint8Array(2),
      [1, , 3], // eslint-disable-line no-sparse-arrays
      { [Symbol('k')]: 1 },
    ]) {
      expect(codeOf(() => validateJobPayload(bad))).toBe('invalid_payload');
    }
  });

  it('rejects non-enumerable own properties and excessive depth', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'h', { value: 1, enumerable: false });
    expect(codeOf(() => validateJobPayload(hidden))).toBe('invalid_payload');
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(codeOf(() => validateJobPayload(deep))).toBe('invalid_payload');
  });

  it('enforces 16 KiB of UTF-8 on the canonical JSON', () => {
    const overhead = '"'.length * 2;
    const fits = 'a'.repeat(MAX_PAYLOAD_BYTES - overhead);
    expect(new TextEncoder().encode(validateJobPayload(fits)).length).toBe(MAX_PAYLOAD_BYTES);
    expect(codeOf(() => validateJobPayload(fits + 'a'))).toBe('payload_too_large');
    const multi = 'é'.repeat(MAX_PAYLOAD_BYTES / 2);
    expect(codeOf(() => validateJobPayload(multi))).toBe('payload_too_large');
  });

  it('rejects __proto__, constructor and prototype keys', () => {
    expect(codeOf(() => validateJobPayload(JSON.parse('{"__proto__":{"x":1}}')))).toBe(
      'invalid_payload',
    );
    expect(codeOf(() => validateJobPayload({ constructor: 1 }))).toBe('invalid_payload');
    expect(codeOf(() => validateJobPayload({ prototype: 1 }))).toBe('invalid_payload');
  });

  it.each([
    'password',
    'Secret',
    'TOKEN',
    'authorization',
    'cookie',
    'api_key',
    'apikey',
    'ApiKey',
  ])('rejects credential-named key %s', (key) => {
    expect(codeOf(() => validateJobPayload({ nested: [{ [key]: 'x' }] }))).toBe('invalid_payload');
  });

  it.each(['email', 'E_Mail', 'EMAIL'])('rejects e-mail-named key %s', (key) => {
    expect(codeOf(() => validateJobPayload({ [key]: 'x' }))).toBe('invalid_payload');
  });

  it('rejects e-mail-shaped string values and keeps ids and cursors', () => {
    expect(codeOf(() => validateJobPayload({ ref: 'someone@example.com' }))).toBe(
      'invalid_payload',
    );
    expect(codeOf(() => validateJobPayload(['a.b@c.d']))).toBe('invalid_payload');
    expect(validateJobPayload({ id: '01HZX', cursor: 'a@b', note: 'x y@z.q' })).toBe(
      '{"cursor":"a@b","id":"01HZX","note":"x y@z.q"}',
    );
  });

  it('keeps keys that merely contain a credential word', () => {
    expect(validateJobPayload({ tokenId: 'x', secretRef: 'y' })).toBe(
      '{"secretRef":"y","tokenId":"x"}',
    );
  });

  it('accepts depth 32 and refuses depth 33', () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i += 1) value = [value];
      return value;
    };
    expect(() => validateJobPayload(nest(32))).not.toThrow();
    expect(codeOf(() => validateJobPayload(nest(33)))).toBe('invalid_payload');
  });

  it('rejects an array with an extra own property and an array subclass', () => {
    const extra = [1, 2] as unknown[] & { x?: number };
    extra.x = 1;
    expect(codeOf(() => validateJobPayload(extra))).toBe('invalid_payload');
    class Sub extends Array<number> {}
    expect(codeOf(() => validateJobPayload(Sub.from([1])))).toBe('invalid_payload');
  });

  it('refuses a shared-reference DAG quickly instead of expanding it', () => {
    let node: unknown = 'x';
    for (let i = 0; i < 22; i += 1) node = [node, node];
    const started = performance.now();
    expect(codeOf(() => validateJobPayload(node))).toBe('payload_too_large');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuses a 200 MB string without stringifying it', () => {
    const huge = 'a'.repeat(200 * 1024 * 1024);
    const started = performance.now();
    expect(codeOf(() => validateJobPayload(huge))).toBe('payload_too_large');
    expect(codeOf(() => validateJobPayload({ k: huge }))).toBe('payload_too_large');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuses more than 10 000 nodes', () => {
    expect(codeOf(() => validateJobPayload(new Array(10_001).fill(0)))).toBe('payload_too_large');
  });
});

describe('validateWithDefinition', () => {
  it('hands the validator a plain JSON copy, not the caller object', () => {
    const def = defineJob({
      name: 'x',
      version: 1,
      validate: (input: unknown) => input,
      handler: async () => {},
    });
    const input = { a: [1], b: { c: 2 } };
    const seen = validateWithDefinition(def, input);
    expect(seen).toEqual(input);
    expect(seen).not.toBe(input);
    expect(codeOf(() => validateWithDefinition(def, { a: undefined }))).toBe('invalid_payload');
  });
});

describe('hashPayload', () => {
  it('is key-order independent and differs for different payloads', async () => {
    const h1 = await hashPayload({ a: 1, b: [1, 2] });
    const h2 = await hashPayload({ b: [1, 2], a: 1 });
    const h3 = await hashPayload({ a: 1, b: [2, 1] });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an invalid payload', async () => {
    await expect(hashPayload({ a: undefined })).rejects.toBeInstanceOf(JobError);
  });
});

describe('idempotency keys', () => {
  it('accepts 1..160 characters', () => {
    expect(() => validateIdempotencyKey('k')).not.toThrow();
    expect(() => validateIdempotencyKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).not.toThrow();
  });

  it.each([
    '',
    'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
    'schedule:x',
    'schedule:',
    'a\u007fb',
    'a\u2028b',
    'a\u202eb',
    'a\ud800b',
    'é',
  ])('rejects %#', (key) => {
    expect(codeOf(() => validateIdempotencyKey(key))).toBe('invalid_idempotency_key');
  });

  it('rejects non-strings and control characters', () => {
    expect(codeOf(() => validateIdempotencyKey(undefined as unknown as string))).toBe(
      'invalid_idempotency_key',
    );
    expect(codeOf(() => validateIdempotencyKey('a\nb'))).toBe('invalid_idempotency_key');
  });

  it('namespaces the stored key by the qualified type', () => {
    const a = storedIdempotencyKey('p:x:v1', 'k');
    const b = storedIdempotencyKey('p:x:v2', 'k');
    expect(a).not.toBe(b);
    expect(a).toBe('p:x:v1:k');
    expect(codeOf(() => storedIdempotencyKey('p:x:v1', 'schedule:y'))).toBe(
      'invalid_idempotency_key',
    );
  });

  it('validates the qualified type and bounds the stored key', () => {
    for (const bad of [
      '',
      'p:x',
      'p:x:v0',
      'P:x:v1',
      'p:x:1',
      'p:x:v1:extra',
      'core',
      'p:core:v1',
      'core:core:v1',
    ]) {
      expect(codeOf(() => storedIdempotencyKey(bad, 'k'))).toBe('invalid_name');
    }
    expect(storedIdempotencyKey('core:session-cleanup:v1', 'k')).toBe('core:session-cleanup:v1:k');
    const longest = qualifyJobName('p'.repeat(64), 'n'.repeat(64), Number.MAX_SAFE_INTEGER);
    const stored = storedIdempotencyKey(longest, 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH));
    expect(stored.length).toBeLessThanOrEqual(320);
  });

  it('parses and checks ownership of qualified names', () => {
    expect(parseQualifiedJobName('sessions:cleanup:v3')).toEqual({
      pluginId: 'sessions',
      name: 'cleanup',
      version: 3,
    });
    expect(() => assertJobOwnedBy('sessions', 'sessions:cleanup:v3')).not.toThrow();
    expect(codeOf(() => assertJobOwnedBy('other', 'sessions:cleanup:v3'))).toBe('invalid_name');
    expect(codeOf(() => assertJobOwnedBy('core', 'core:x:v1'))).toBe('invalid_name');
    expect(codeOf(() => assertJobOwnedBy('p', 'p:core:v1'))).toBe('invalid_name');
    expect(codeOf(() => parseQualifiedJobName('p:core:v1'))).toBe('invalid_name');
  });
});

describe('normalizeRunAt', () => {
  it('accepts the exact DB format', () => {
    expect(normalizeRunAt('2026-10-16T12:30:45.123Z')).toBe('2026-10-16T12:30:45.123Z');
  });

  it.each([
    '2026-10-16T12:30:45Z',
    '2026-10-16T12:30:45.12Z',
    '2026-10-16T12:30:45.123+02:00',
    '2026-10-16T12:30:45.123+00:00',
    '2026-10-16 12:30:45.123Z',
    '2026-10-16T12:30:45.123',
    '2026-02-30T12:30:45.123Z',
    '2026-10-16T24:00:00.000Z',
    '  2026-10-16T12:30:45.123Z',
    '',
  ])('rejects %j', (value) => {
    expect(codeOf(() => normalizeRunAt(value))).toBe('invalid_run_at');
  });

  it('rejects non-strings', () => {
    expect(codeOf(() => normalizeRunAt(123 as unknown as string))).toBe('invalid_run_at');
  });
});

describe('validateSchedule', () => {
  it.each([60, 120, 3600, 86400])('accepts %s', (everySeconds) => {
    expect(() => validateSchedule({ everySeconds })).not.toThrow();
  });

  it.each([0, 30, 59, 61, 90, 119, -60, 60.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s',
    (everySeconds) => {
      expect(codeOf(() => validateSchedule({ everySeconds }))).toBe('invalid_schedule');
    },
  );
});

describe('retryDelaySeconds', () => {
  it('is 5*2^(attempt-1) at full jitter and caps at 3600', () => {
    const one = () => 1;
    expect(retryDelaySeconds(1, one)).toBe(5);
    expect(retryDelaySeconds(2, one)).toBe(10);
    expect(retryDelaySeconds(3, one)).toBe(20);
    expect(retryDelaySeconds(10, one)).toBe(2560);
    expect(retryDelaySeconds(11, one)).toBe(3600);
    expect(retryDelaySeconds(500, one)).toBe(3600);
  });

  it('maps random in [0,1] onto jitter [0.8,1.0]', () => {
    expect(retryDelaySeconds(3, () => 0)).toBeCloseTo(16, 10);
    expect(retryDelaySeconds(3, () => 0.5)).toBeCloseTo(18, 10);
    expect(retryDelaySeconds(20, () => 0)).toBeCloseTo(2880, 10);
  });

  it('is deterministic for a fixed random and stays within bounds by default', () => {
    expect(retryDelaySeconds(4, () => 0.25)).toBe(retryDelaySeconds(4, () => 0.25));
    for (let i = 0; i < 100; i += 1) {
      const d = retryDelaySeconds(3);
      expect(d).toBeGreaterThanOrEqual(16);
      expect(d).toBeLessThanOrEqual(20);
    }
  });

  it('rejects invalid attempts and out-of-range random', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf(() => retryDelaySeconds(attempt))).toBe('invalid_attempt');
    }
    expect(codeOf(() => retryDelaySeconds(1, () => 1.5))).toBe('invalid_attempt');
    expect(codeOf(() => retryDelaySeconds(1, () => -0.1))).toBe('invalid_attempt');
    expect(codeOf(() => retryDelaySeconds(1, () => Number.NaN))).toBe('invalid_attempt');
  });
});

describe('defineJob', () => {
  const base = {
    name: 'cleanup',
    version: 1,
    validate: (input: unknown) => input as { id: string },
    handler: async () => {},
  };

  it('returns a frozen definition with defaults left to the registry', () => {
    const def = defineJob(base);
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.maxAttempts).toBeUndefined();
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it('accepts a valid schedule and maxAttempts', () => {
    const def = defineJob({ ...base, schedule: { everySeconds: 300 }, maxAttempts: 3 });
    expect(def.schedule).toEqual({ everySeconds: 300 });
    expect(Object.isFrozen(def.schedule)).toBe(true);
  });

  it('rejects accessor properties and reads each field once', () => {
    let reads = 0;
    const hostile = { ...base };
    Object.defineProperty(hostile, 'name', {
      enumerable: true,
      get() {
        reads += 1;
        return 'cleanup';
      },
    });
    expect(codeOf(() => defineJob(hostile))).toBe('invalid_definition');
    expect(reads).toBe(0);
    const sched = { ...base, schedule: {} as { everySeconds: number } };
    Object.defineProperty(sched.schedule, 'everySeconds', { get: () => 60 });
    expect(codeOf(() => defineJob(sched))).toBe('invalid_definition');
  });

  it('rejects bad names, versions, non-functions, intervals and maxAttempts', () => {
    expect(codeOf(() => defineJob({ ...base, name: 'core' }))).toBe('invalid_name');
    expect(codeOf(() => defineJob({ ...base, name: 'Bad' }))).toBe('invalid_name');
    expect(codeOf(() => defineJob({ ...base, version: 0 }))).toBe('invalid_version');
    expect(codeOf(() => defineJob({ ...base, validate: 1 as never }))).toBe('invalid_definition');
    expect(codeOf(() => defineJob({ ...base, handler: null as never }))).toBe('invalid_definition');
    expect(codeOf(() => defineJob({ ...base, schedule: { everySeconds: 59 } }))).toBe(
      'invalid_schedule',
    );
    expect(codeOf(() => defineJob({ ...base, schedule: { everySeconds: 90 } }))).toBe(
      'invalid_schedule',
    );
    for (const maxAttempts of [0, -1, 1.5, 101]) {
      expect(codeOf(() => defineJob({ ...base, maxAttempts }))).toBe('invalid_definition');
    }
  });
});

describe('JobError', () => {
  it('carries only a fixed code and no caller text', () => {
    const error = new JobError('invalid_payload');
    expect(error.name).toBe('JobError');
    expect(error.message).toBe('invalid_payload');
    expect(jobErrorCode(error)).toBe('invalid_payload');
  });

  it('ignores a forged code on a look-alike error and accepts the new codes', () => {
    const forged = Object.assign(new Error('x'), { code: 'invalid_payload' });
    expect(jobErrorCode(forged)).toBe('handler_error');
    for (const code of [
      'unknown_job_type',
      'idempotency_conflict',
      'lease_lost',
      'timeout',
      'aborted',
    ] as const) {
      expect(jobErrorCode(new JobError(code))).toBe(code);
    }
    const tampered = new JobError('timeout');
    Object.defineProperty(tampered, 'code', { value: 'sk_live_SECRET' });
    expect(jobErrorCode(tampered)).toBe('handler_error');
  });

  it('reads code once through a data descriptor and never leaks getter text', () => {
    let reads = 0;
    const getter = new JobError('timeout');
    Object.defineProperty(getter, 'code', {
      get() {
        reads += 1;
        return reads === 1 ? 'timeout' : 'sk_live_SECRET';
      },
    });
    expect(jobErrorCode(getter)).toBe('handler_error');
    expect(reads).toBe(0);
    const throwing = new JobError('timeout');
    Object.defineProperty(throwing, 'code', {
      get() {
        throw new Error('boom');
      },
    });
    expect(jobErrorCode(throwing)).toBe('handler_error');
    const { proxy, revoke } = Proxy.revocable(new JobError('timeout'), {});
    revoke();
    expect(jobErrorCode(proxy)).toBe('handler_error');
  });

  it('maps any other thrown value to a fixed code, never its message', () => {
    const secret = 'sk_live_TOP-SECRET';
    expect(jobErrorCode(new Error(secret))).toBe('handler_error');
    expect(jobErrorCode(secret)).toBe('handler_error');
    expect(jobErrorCode(null)).toBe('handler_error');
    const spoof = Object.assign(new Error('x'), { code: secret, name: 'JobError' });
    expect(jobErrorCode(spoof)).toBe('handler_error');
  });
});
