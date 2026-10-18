import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import * as zm from 'zod/mini';
import {
  MAX_BODY_BYTES,
  MAX_BODY_DEPTH,
  readJsonBody,
  validateInput,
  VALIDATION_CODES,
} from './validate.js';

const SENTINEL = 'S3CR3T-SENTINEL';

function jsonRequest(
  body: string | Uint8Array | null,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://broker.test/_pb/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function nested(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateInput no-echo', () => {
  const rows: ReadonlyArray<readonly [string, z.ZodType, unknown]> = [
    ['wrong-typed field', z.object({ name: z.string() }), { name: { nested: SENTINEL } }],
    ['unknown key value', z.strictObject({ name: z.string() }), { name: 'a', extra: SENTINEL }],
    ['unknown key name', z.strictObject({ name: z.string() }), { name: 'a', [SENTINEL]: 1 }],
    [
      'record key',
      z.object({ map: z.record(z.string().max(3), z.number()) }),
      { map: { [SENTINEL]: 1 } },
    ],
    ['record value', z.object({ map: z.record(z.string(), z.number()) }), { map: { k: SENTINEL } }],
    ['enum mismatch', z.object({ kind: z.enum(['a', 'b']) }), { kind: SENTINEL }],
    ['too-long string', z.object({ name: z.string().max(5) }), { name: SENTINEL }],
    [
      'failing refinement',
      z.object({ name: z.string().refine(() => false, { message: 'bad' }) }),
      { name: SENTINEL },
    ],
    ['literal mismatch', z.object({ kind: z.literal('only') }), { kind: SENTINEL }],
    ['union mismatch', z.object({ v: z.union([z.number(), z.boolean()]) }), { v: SENTINEL }],
  ];

  it.each(rows)('never contains the sentinel: %s', (_name, schema, input) => {
    const result = validateInput(schema, input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('validateInput pointers', () => {
  it('points an unrecognized_keys issue at the parent without key names', () => {
    const schema = z.object({ inner: z.strictObject({ a: z.string() }) });
    const result = validateInput(schema, { inner: { a: 'x', leaked: 1, other: 2 } });
    expect(result).toEqual({
      ok: false,
      details: [{ path: '/inner', code: 'unrecognized_keys' }],
    });
  });

  it('stops at the record pointer for an issue under a record key', () => {
    const schema = z.object({ map: z.record(z.string(), z.number()) });
    const result = validateInput(schema, { map: { someKey: 'not a number' } });
    expect(result).toEqual({ ok: false, details: [{ path: '/map', code: 'invalid_type' }] });
  });

  it('escapes declared keys per RFC 6901', () => {
    const schema = z.object({ 'a/b~c': z.string() });
    const result = validateInput(schema, { 'a/b~c': 1 });
    expect(result).toEqual({ ok: false, details: [{ path: '/a~1b~0c', code: 'invalid_type' }] });
  });

  it('emits array indexes', () => {
    const schema = z.object({ list: z.array(z.number()) });
    const result = validateInput(schema, { list: [1, 'x'] });
    expect(result).toEqual({ ok: false, details: [{ path: '/list/1', code: 'invalid_type' }] });
  });

  it('uses an empty path for the root', () => {
    expect(validateInput(z.string(), 5)).toEqual({
      ok: false,
      details: [{ path: '', code: 'invalid_type' }],
    });
  });
});

describe('validateInput thrown errors', () => {
  it('returns a fixed detail when the schema throws', () => {
    const schema = z.string().transform(() => {
      throw new Error(`boom ${SENTINEL}`);
    });
    expect(validateInput(schema, 'x')).toEqual({
      ok: false,
      details: [{ path: '', code: 'invalid' }],
    });
  });

  it('returns a fixed detail for an async schema', () => {
    expect(
      validateInput(
        z.string().refine(async () => true),
        'x',
      ),
    ).toEqual({
      ok: false,
      details: [{ path: '', code: 'invalid' }],
    });
  });
});

describe('validateInput composite pointers', () => {
  it('follows the intersection branch that declares the segment', () => {
    const schema = z.intersection(
      z.object({ inner: z.object({ a: z.string() }) }),
      z.object({ inner: z.object({ b: z.number() }) }),
    );
    expect(validateInput(schema, { inner: { a: 'x', b: 'y' } })).toEqual({
      ok: false,
      details: [{ path: '/inner/b', code: 'invalid_type' }],
    });
  });

  it('descends into the matching discriminated union option', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.string() }),
    ]);
    expect(validateInput(schema, { kind: 'a', x: 1 })).toEqual({
      ok: false,
      details: [{ path: '/x', code: 'invalid_type' }],
    });
  });

  it('stops at the parent for a plain union', () => {
    const schema = z.object({
      v: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    });
    expect(validateInput(schema, { v: { a: 1 } })).toEqual({
      ok: false,
      details: [{ path: '/v', code: 'invalid_union' }],
    });
  });
});

describe('validateInput codes', () => {
  it.each([
    ['too_small', z.string().min(3), 'a'],
    ['too_big', z.string().max(1), 'abc'],
    ['invalid_format', z.string().regex(/^\d+$/), 'abc'],
    ['invalid_value', z.enum(['a']), 'b'],
    ['invalid_union', z.union([z.number(), z.boolean()]), 's'],
    ['invalid', z.number().multipleOf(2), 3],
    ['invalid', z.string().refine(() => false), 'x'],
  ] as const)('maps to %s', (code, schema, input) => {
    const result = validateInput(schema, input);
    expect(result).toEqual({ ok: false, details: [{ path: '', code }] });
  });
});

describe('validateInput results', () => {
  it('returns parsed data for a classic schema', () => {
    expect(validateInput(z.object({ n: z.number() }), { n: 1 })).toEqual({
      ok: true,
      data: { n: 1 },
    });
  });

  it('returns parsed data for a mini schema', () => {
    expect(validateInput(zm.object({ n: zm.number() }), { n: 1 })).toEqual({
      ok: true,
      data: { n: 1 },
    });
  });

  it('reports mini failures with the same shape as classic', () => {
    const classic = validateInput(z.object({ n: z.number() }), { n: 'x' });
    const mini = validateInput(zm.object({ n: zm.number() }), { n: 'x' });
    expect(mini).toEqual(classic);
    expect(mini).toEqual({ ok: false, details: [{ path: '/n', code: 'invalid_type' }] });
  });

  it('caps details at 20', () => {
    const schema = z.object({ list: z.array(z.number()) });
    const result = validateInput(schema, { list: Array.from({ length: 50 }, () => 'x') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toHaveLength(20);
      expect(result.details[0]?.path).toBe('/list/0');
      expect(result.details[19]?.path).toBe('/list/19');
    }
  });

  it('leaves the global Zod config untouched', () => {
    const before = z.config().customError;
    validateInput(z.string(), 1);
    expect(z.config().customError).toBe(before);
    const direct = z.string().safeParse(1);
    expect(direct.success).toBe(false);
    if (!direct.success) expect(direct.error.issues[0]?.message).toContain('expected string');
  });
});

describe('readJsonBody', () => {
  it('exports the limits', () => {
    expect(MAX_BODY_BYTES).toBe(65536);
    expect(MAX_BODY_DEPTH).toBe(16);
  });

  it('parses a valid body', async () => {
    expect(await readJsonBody(jsonRequest('{"a":[1,2]}'))).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it('accepts charset=utf-8', async () => {
    const result = await readJsonBody(
      jsonRequest('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }),
    );
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('answers 415 for text/plain', async () => {
    const result = await readJsonBody(jsonRequest('{}', { 'content-type': 'text/plain' }));
    expect(result).toEqual({ ok: false, status: 415, code: 'unsupported_media_type' });
  });

  it('answers 415 for another charset', async () => {
    const result = await readJsonBody(
      jsonRequest('{}', { 'content-type': 'application/json; charset=latin1' }),
    );
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it('answers 413 for 65537 bytes without parsing', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const body = `"${'a'.repeat(65537 - 2)}"`;
    expect(new TextEncoder().encode(body).length).toBe(65537);
    const request = jsonRequest(body);
    const result = await readJsonBody(request);
    expect(result).toEqual({ ok: false, status: 413, code: 'payload_too_large' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('accepts exactly 65536 bytes', async () => {
    const body = `"${'a'.repeat(65536 - 2)}"`;
    const result = await readJsonBody(jsonRequest(body));
    expect(result.ok).toBe(true);
  });

  it('answers 413 for a large Content-Length before reading', async () => {
    const getReader = vi.fn();
    const request = {
      headers: new Headers({ 'content-type': 'application/json', 'content-length': '1048576' }),
      body: { getReader },
    } as unknown as Request;
    const result = await readJsonBody(request);
    expect(result).toEqual({ ok: false, status: 413, code: 'payload_too_large' });
    expect(getReader).not.toHaveBeenCalled();
  });

  it('cancels the stream once the running cap is passed', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(40000).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      body: stream,
    } as unknown as Request;
    const result = await readJsonBody(request);
    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(cancel).toHaveBeenCalled();
  });

  it('answers 400 too_deep for depth 17 before parsing', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const result = await readJsonBody(jsonRequest(nested(17)));
    expect(result).toEqual({ ok: false, status: 400, code: 'invalid_request', detail: 'too_deep' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('accepts depth 16', async () => {
    expect((await readJsonBody(jsonRequest(nested(16)))).ok).toBe(true);
  });

  it('does not count brackets inside strings', async () => {
    const body = JSON.stringify({ s: '['.repeat(100) + '\\"[' });
    expect(await readJsonBody(jsonRequest(body))).toMatchObject({ ok: true });
  });

  it('honours custom limits', async () => {
    const result = await readJsonBody(jsonRequest(nested(3)), { maxDepth: 2 });
    expect(result).toMatchObject({ ok: false, detail: 'too_deep' });
    const big = await readJsonBody(jsonRequest('"abcdef"'), { maxBytes: 4 });
    expect(big).toMatchObject({ ok: false, status: 413 });
  });

  it('answers 400 invalid_encoding for invalid UTF-8', async () => {
    const result = await readJsonBody(jsonRequest(new Uint8Array([0x22, 0xff, 0xfe, 0x22])));
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_request',
      detail: 'invalid_encoding',
    });
  });

  it('answers 400 invalid_json without echoing the body', async () => {
    const result = await readJsonBody(jsonRequest(`{"a": ${SENTINEL}}`));
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_request',
      detail: 'invalid_json',
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('answers 400 invalid_json for an empty body', async () => {
    expect(await readJsonBody(jsonRequest(null))).toMatchObject({
      ok: false,
      status: 400,
      detail: 'invalid_json',
    });
  });

  it('answers 413 for a cloned request without hanging', async () => {
    const original = jsonRequest(`"${'a'.repeat(70000)}"`);
    const result = await readJsonBody(original.clone());
    expect(result).toEqual({ ok: false, status: 413, code: 'payload_too_large' });
  });

  it('answers a fixed 400 when the stream errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`aborted ${SENTINEL}`));
      },
    });
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      body: stream,
    } as unknown as Request;
    const result = await readJsonBody(request);
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_request',
      detail: 'invalid_request',
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('drops __proto__ keys', async () => {
    const result = await readJsonBody(jsonRequest('{"a":1,"__proto__":{"x":1}}'));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    if (result.ok) expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  });

  it('rejects a lone surrogate value as invalid_encoding', async () => {
    expect(await readJsonBody(jsonRequest('"\\ud800"'))).toMatchObject({
      ok: false,
      status: 400,
      detail: 'invalid_encoding',
    });
  });

  it('rejects a lone surrogate object key as invalid_encoding', async () => {
    expect(await readJsonBody(jsonRequest('{"\\ud800":1}'))).toMatchObject({
      ok: false,
      status: 400,
      detail: 'invalid_encoding',
    });
  });

  it('accepts the literal text backslash-u-d800', async () => {
    expect(await readJsonBody(jsonRequest('"\\\\ud800"'))).toEqual({
      ok: true,
      value: '\\ud800',
    });
  });

  it('accepts a valid surrogate pair', async () => {
    expect(await readJsonBody(jsonRequest('"😀"'))).toEqual({ ok: true, value: '😀' });
    expect(await readJsonBody(jsonRequest('"\\ud83d\\ude00"'))).toEqual({
      ok: true,
      value: '😀',
    });
  });

  it('accepts a quoted charset and an empty parameter', async () => {
    for (const type of ['application/json; charset="UTF-8"', 'application/json;']) {
      const result = await readJsonBody(jsonRequest('{}', { 'content-type': type }));
      expect(result.ok).toBe(true);
    }
  });

  it('rejects a charset prefix match', async () => {
    const result = await readJsonBody(
      jsonRequest('{}', { 'content-type': 'application/json; charset=utf-8x' }),
    );
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it('enforces the cap when Content-Length understates the body', async () => {
    const body = `"${'a'.repeat(70000)}"`;
    const request = {
      headers: new Headers({ 'content-type': 'application/json', 'content-length': '10' }),
      body: jsonRequest(body).body,
    } as unknown as Request;
    expect(await readJsonBody(request)).toEqual({
      ok: false,
      status: 413,
      code: 'payload_too_large',
    });
  });
});

describe('shared validation codes', () => {
  it.each(['invalid_json', 'invalid_encoding', 'too_deep'])('includes body code %s', (code) => {
    expect(VALIDATION_CODES.has(code)).toBe(true);
  });
  it('rejects an unknown code from the shared set', () => {
    expect(VALIDATION_CODES.has('unknown_code')).toBe(false);
  });
});
