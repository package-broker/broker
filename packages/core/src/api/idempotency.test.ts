import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AuditContext } from '../audit/actions.js';
import { formatToken } from '../secrets/token-format.js';
import { apiError } from './response.js';
import {
  IDEMPOTENCY_TTL_SECONDS,
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  replayResponse,
  requestHash,
  settleIdempotent,
  type ApiCall,
  type IdempotencyRecord,
} from './idempotency.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const principal = { kind: 'user', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } as const;
const input = {
  principal,
  key: 'create-1',
  route: '/api/projects',
  hash: 'hash-one',
  status: 201,
  response: { id: 'project-1' },
  now,
};
const record = (overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
  principalKey: `user:${principal.id}`,
  key: input.key,
  route: input.route,
  requestHash: input.hash,
  status: input.status,
  responseJson: JSON.stringify(input.response),
  createdAt: now.toISOString(),
  expiresAt: '2026-10-18T12:00:00.000Z',
  ...overrides,
});

it('carries audit and optional idempotency in ApiCall', () => {
  expectTypeOf<ApiCall['audit']>().toEqualTypeOf<AuditContext>();
  expectTypeOf<ApiCall['idempotency']>().toEqualTypeOf<IdempotencyRecord | undefined>();
});

describe('parseIdempotencyKey', () => {
  it('accepts the permitted alphabet', () => {
    expect(parseIdempotencyKey('abc_DEF-1')).toEqual({ ok: true, key: 'abc_DEF-1' });
  });
  it('accepts absence', () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, key: null });
  });
  it('accepts 128 characters', () => {
    expect(parseIdempotencyKey('a'.repeat(128))).toEqual({ ok: true, key: 'a'.repeat(128) });
  });
  it.each(['', 'a'.repeat(129), 'a b', 'a/b', 'abc\n'])('rejects invalid key row %#', (key) => {
    expect(parseIdempotencyKey(key)).toEqual({ ok: false });
  });
});

describe('requestHash', () => {
  const request = {
    method: 'POST',
    route: '/api/projects/:id',
    params: { id: 'one' },
    body: { z: [{ b: 2, a: 1 }], a: true },
  };
  it('sorts nested keys and returns lowercase SHA-256 hex', async () => {
    const hash = await requestHash(request);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await requestHash({ ...request, body: { a: true, z: [{ a: 1, b: 2 }] } })).toBe(hash);
    const sorted =
      '{"body":{"a":true,"z":[{"a":1,"b":2}]},"method":"POST","params":{"id":"one"},"route":"/api/projects/:id"}';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
    expect(hash).toBe(
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  });
  it.each([
    { body: { z: [{ b: 3, a: 1 }], a: true } },
    { method: 'PUT' },
    { route: '/api/other/:id' },
    { params: { id: 'two' } },
  ])('changes for request component row %#', async (change) => {
    expect(await requestHash({ ...request, ...change })).not.toBe(await requestHash(request));
  });
});

describe('principalKey', () => {
  it('distinguishes principal kinds', () => {
    expect(principalKey(principal)).toBe(`user:${principal.id}`);
    expect(principalKey({ ...principal, kind: 'service' })).not.toBe(principalKey(principal));
  });
  it('accepts exactly 80 characters', () => {
    expect(principalKey({ kind: 'user', id: 'a'.repeat(75) })).toHaveLength(80);
  });
  it('rejects a 100-character id', () => {
    expect(() => principalKey({ kind: 'user', id: 'a'.repeat(100) })).toThrow(TypeError);
  });
});

describe('buildIdempotencyRecord', () => {
  it('builds the record with sorted response keys and a 24-hour expiry', () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86400);
    expect(buildIdempotencyRecord({ ...input, response: { z: { b: 2, a: 1 }, a: true } })).toEqual(
      record({
        responseJson: '{"a":true,"z":{"a":1,"b":2}}',
      }),
    );
    expect(now.toISOString()).toBe('2026-10-17T12:00:00.000Z');
  });
  it('refuses a formatted broker token in a nested array', () => {
    const token = formatToken('pat', 'abcdefghijkl', new Uint8Array(32));
    expect(() =>
      buildIdempotencyRecord({ ...input, response: { nested: [{ value: token }] } }),
    ).toThrow(TypeError);
  });
  it('refuses a 9 KiB response made of individually safe values', () => {
    expect(() =>
      buildIdempotencyRecord({
        ...input,
        response: Array.from({ length: 9 }, () => 'a'.repeat(1024)),
      }),
    ).toThrow(TypeError);
  });
  it('measures UTF-8 bytes rather than character count', () => {
    expect(() =>
      buildIdempotencyRecord({ ...input, response: ['é'.repeat(2100), 'é'.repeat(2100)] }),
    ).toThrow(TypeError);
  });
  it('accepts exactly 8 KiB of JSON', () => {
    const response = ['a'.repeat(4090), 'b'.repeat(4095)];
    expect(
      new TextEncoder().encode(buildIdempotencyRecord({ ...input, response }).responseJson),
    ).toHaveLength(8192);
  });
});

describe('decideReplay', () => {
  it('proceeds without a record', () =>
    expect(decideReplay(null, input.hash, now)).toBe('proceed'));
  it('replays a matching hash', () =>
    expect(decideReplay(record(), input.hash, now)).toBe('replay'));
  it('refuses a different hash', () =>
    expect(decideReplay(record(), 'other', now)).toBe('mismatch'));
  it('proceeds for an expired record despite a different hash', () => {
    expect(decideReplay(record({ expiresAt: now.toISOString() }), 'other', now)).toBe('proceed');
  });
});

describe('replayResponse', () => {
  it('returns stored status and JSON with the replay header', async () => {
    const response = replayResponse(record(), 'request-2');
    expect(response.status).toBe(201);
    expect(response.headers.get('Idempotent-Replayed')).toBe('true');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(input.response);
  });
  it('returns only the already-issued envelope and id', async () => {
    const stored = record({
      status: 409,
      responseJson: JSON.stringify({ code: 'already_issued', id: 'token-1', ignored: 'discard' }),
    });
    const response = replayResponse(stored, 'request-2');
    expect(response.status).toBe(409);
    expect(response.headers.get('Idempotent-Replayed')).toBe('true');
    const body = await response.json();
    expect(body).toEqual({
      ...((await apiError('already_issued', 'request-2').json()) as object),
      id: 'token-1',
    });
    expect(Object.keys(body as object).sort()).toEqual(['error', 'id']);
  });
});

describe('settleIdempotent', () => {
  const error = new Error('Unique constraint failed');
  const failure = { ok: false };
  const setup = () => ({
    record: record(),
    hash: input.hash,
    now,
    find: vi.fn<() => Promise<IdempotencyRecord | null>>(),
    run: vi.fn<() => Promise<typeof failure>>(),
    failed: (result: typeof failure) => !result.ok,
  });
  it('replays the winner after a thrown unique error', async () => {
    const args = setup();
    args.run.mockRejectedValue(error);
    args.find.mockResolvedValue(record());
    expect(await settleIdempotent(args)).toEqual({ kind: 'replay', record: record() });
    expect(args.find).toHaveBeenCalledTimes(1);
  });
  it('returns mismatch when the winner has a different hash', async () => {
    const args = setup();
    args.run.mockRejectedValue(error);
    args.find.mockResolvedValue(record({ requestHash: 'other' }));
    expect(await settleIdempotent(args)).toEqual({ kind: 'mismatch' });
    expect(args.find).toHaveBeenCalledTimes(1);
  });
  it('rethrows the original error when no winner exists', async () => {
    const args = setup();
    args.run.mockRejectedValue(error);
    args.find.mockResolvedValue(null);
    await expect(settleIdempotent(args)).rejects.toBe(error);
    expect(args.find).toHaveBeenCalledTimes(1);
  });
  it('never finds after success', async () => {
    const args = setup();
    const result = { ok: true };
    args.run.mockResolvedValue(result);
    expect(await settleIdempotent(args)).toEqual({ kind: 'result', result });
    expect(args.find).not.toHaveBeenCalled();
  });
  it('settles a returned failure through the winner', async () => {
    const args = setup();
    args.run.mockResolvedValue(failure);
    args.find.mockResolvedValue(record());
    expect(await settleIdempotent(args)).toEqual({ kind: 'replay', record: record() });
    expect(args.find).toHaveBeenCalledTimes(1);
  });
  it('preserves a returned failure without a winner', async () => {
    const args = setup();
    args.run.mockResolvedValue(failure);
    args.find.mockResolvedValue(null);
    expect(await settleIdempotent(args)).toEqual({ kind: 'result', result: failure });
  });
  it('preserves the original error when the winner is expired', async () => {
    const args = setup();
    args.run.mockRejectedValue(error);
    args.find.mockResolvedValue(record({ expiresAt: now.toISOString() }));
    await expect(settleIdempotent(args)).rejects.toBe(error);
  });
  it('runs without settlement when no record was supplied', async () => {
    const args = setup();
    args.run.mockResolvedValue(failure);
    expect(await settleIdempotent({ ...args, record: undefined })).toEqual({
      kind: 'result',
      result: failure,
    });
    expect(args.find).not.toHaveBeenCalled();
  });
});
