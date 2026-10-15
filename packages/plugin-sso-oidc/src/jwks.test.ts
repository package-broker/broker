import { base64urlEncode } from '@package-broker/core/auth/primitives';
import type { IdentityContext } from '@package-broker/core/identity/port';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoundedFetchError, fetchBounded } from './http.js';
import { createJwksCache } from './jwks.js';
import { type CryptoKey, JwtError, type JwtFailure, verifyJwt } from './jwt.js';

interface Hung {
  readonly resolve: (value: { readonly status: number; readonly json: unknown }) => void;
  readonly reject: (error: unknown) => void;
}

const hang = vi.hoisted(() => ({
  next: false,
  calls: 0,
  pending: null as Hung | null,
}));

vi.mock('./http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http.js')>();
  return {
    ...actual,
    fetchBounded: (...args: Parameters<typeof actual.fetchBounded>) => {
      hang.calls += 1;
      if (hang.next) {
        hang.next = false;
        return new Promise((resolve, reject) => {
          hang.pending = { resolve, reject };
        });
      }
      return actual.fetchBounded(...args);
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  hang.next = false;
  hang.calls = 0;
  hang.pending = null;
});

const URL_JWKS = 'https://team.example.cloudflareaccess.com/cdn-cgi/access/certs';
const MIN = 60_000;
const START = Date.parse('2026-10-15T08:00:00Z');
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Handler = (request: Request) => Promise<Response> | Response;

interface Harness {
  readonly ctx: IdentityContext;
  readonly requests: Request[];
  now: number;
  handler: Handler;
}

function harness(handler: Handler): Harness {
  const state: Harness = {
    requests: [],
    now: START,
    handler,
    ctx: undefined as unknown as IdentityContext,
  };
  (state as { ctx: IdentityContext }).ctx = {
    fetch: async (request) => {
      state.requests.push(request);
      return state.handler(request);
    },
    clock: { now: () => new Date(state.now) },
    env: () => undefined,
  };
  return state;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okJson(
  body: ConstructorParameters<typeof Response>[0],
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { headers: { 'content-type': 'application/json', ...headers } });
}

function streamOf(
  next: () => Uint8Array | null,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = next();
      if (chunk === null) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      return error.reason;
    }
    throw error;
  }
  return 'resolved';
}

async function failureOf(promise: Promise<unknown>): Promise<JwtFailure | 'resolved'> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JwtError) {
      return error.failure;
    }
    throw error;
  }
  return 'resolved';
}

describe('fetchBounded', () => {
  const limits = { maxBytes: 1024, timeoutMs: 80 };
  const get = () => new Request('https://idp.example/doc', { headers: { authorization: 'x' } });

  it('returns status and parsed JSON for a 2xx response', async () => {
    const h = harness(() => jsonResponse({ a: 1 }));
    await expect(fetchBounded(h.ctx, get(), limits)).resolves.toEqual({
      status: 200,
      json: { a: 1 },
    });
  });

  it('sends the request with manual redirects and a live deadline signal', async () => {
    let abortedDuringCall: boolean | null = null;
    const h = harness((request) => {
      abortedDuringCall = request.signal.aborted;
      return jsonResponse({});
    });
    await fetchBounded(h.ctx, get(), limits);
    const sent = h.requests[0] as Request;
    expect(sent.redirect).toBe('manual');
    expect(abortedDuringCall).toBe(false);
    expect(sent.url).toBe('https://idp.example/doc');
  });

  it.each([301, 302, 303, 307, 308])('refuses a %i response as redirect', async (status) => {
    const h = harness(
      () => new Response(null, { status, headers: { location: 'https://evil.example/' } }),
    );
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('redirect');
  });

  it('refuses an opaque redirect response', async () => {
    const response = new Response('{}', { status: 200 });
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    const h = harness(() => response);
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('redirect');
  });

  it.each([400, 404, 500, 503])('refuses a %i response as status', async (status) => {
    const h = harness(() => new Response('{}', { status }));
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('status');
  });

  it('aborts a body that streams past the limit without content-length', async () => {
    let cancelled = false;
    let pulled = 0;
    const h = harness(() =>
      okJson(
        streamOf(
          () => {
            pulled += 1;
            return new Uint8Array(256).fill(0x20);
          },
          () => {
            cancelled = true;
          },
        ),
      ),
    );
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('too_large');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it('aborts when content-length understates the body', async () => {
    const h = harness(() =>
      okJson(
        streamOf(() => new Uint8Array(512).fill(0x20)),
        { 'content-length': '10' },
      ),
    );
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('too_large');
  });

  it('accepts a body of exactly maxBytes', async () => {
    const body = `"${'a'.repeat(1022)}"`;
    expect(body.length).toBe(1024);
    const h = harness(() => okJson(body));
    await expect(fetchBounded(h.ctx, get(), limits)).resolves.toEqual({
      status: 200,
      json: 'a'.repeat(1022),
    });
  });

  it('reports a rejected fetch as network', async () => {
    const h = harness(() => Promise.reject(new TypeError('boom')));
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('network');
  });

  it('reports a failing body stream as network', async () => {
    const h = harness(() =>
      okJson(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('reset'));
          },
        }),
      ),
    );
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('network');
  });

  it.each(['', 'not json', '{"a":'])('reports %j as bad_json', async (text) => {
    const h = harness(() => okJson(text));
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('bad_json');
  });

  it('reports invalid UTF-8 as bad_json', async () => {
    const h = harness(() => okJson(new Uint8Array([0x22, 0xff, 0x22])));
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('bad_json');
  });

  it.each([
    ['maxBytes', { maxBytes: 0, timeoutMs: 80 }],
    ['maxBytes', { maxBytes: Number.NaN, timeoutMs: 80 }],
    ['maxBytes', { maxBytes: Number.POSITIVE_INFINITY, timeoutMs: 80 }],
    ['timeoutMs', { maxBytes: 10, timeoutMs: 0 }],
    ['timeoutMs', { maxBytes: 10, timeoutMs: -5 }],
    ['timeoutMs', { maxBytes: 10, timeoutMs: Number.NaN }],
  ])('rejects an invalid %s limit', async (_name, bad) => {
    const h = harness(() => jsonResponse({}));
    await expect(fetchBounded(h.ctx, get(), bad)).rejects.toThrow(RangeError);
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON',
    'application/jwk-set+json',
    'application/jwk-set+json;charset=UTF-8',
  ])('accepts content type %s', async (contentType) => {
    const h = harness(() => new Response('{}', { headers: { 'content-type': contentType } }));
    await expect(fetchBounded(h.ctx, get(), limits)).resolves.toEqual({ status: 200, json: {} });
  });

  it.each(['text/html', 'text/plain', 'application/jsonp', 'application/x-json', 'json'])(
    'refuses content type %s',
    async (contentType) => {
      let cancelled = false;
      const h = harness(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': contentType } },
          ),
      );
      expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('content_type');
      expect(cancelled).toBe(true);
    },
  );

  it('refuses a response without a content type', async () => {
    const h = harness(() => new Response(new Uint8Array([0x7b, 0x7d])));
    expect(await reasonOf(fetchBounded(h.ctx, get(), limits))).toBe('content_type');
  });

  it('cancels the body of a response that arrives after the deadline', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const h = harness(async () => {
      await sleep(150);
      return okJson(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const outcome = reasonOf(fetchBounded(h.ctx, get(), { maxBytes: 1024, timeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toBe('timeout');
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(cancelled).toBe(true);
  });

  it('covers headers and body with one deadline', async () => {
    vi.useFakeTimers();
    const h = harness(async () => {
      await sleep(180);
      return okJson(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await sleep(180);
            controller.enqueue(encoder.encode('{}'));
            controller.close();
          },
        }),
      );
    });
    const outcome = reasonOf(fetchBounded(h.ctx, get(), { maxBytes: 1024, timeoutMs: 300 }));
    await vi.advanceTimersByTimeAsync(700);
    expect(await outcome).toBe('timeout');
  });

  it('times out on a stalled body', async () => {
    vi.useFakeTimers();
    const h = harness(() =>
      okJson(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"a":'));
          },
        }),
      ),
    );
    const outcome = reasonOf(fetchBounded(h.ctx, get(), limits));
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    expect(await outcome).toBe('timeout');
  });

  it('times out on stalled headers even when the fetch ignores the signal', async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise<Response>(() => undefined));
    const outcome = reasonOf(fetchBounded(h.ctx, get(), limits));
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    expect(await outcome).toBe('timeout');
  });

  it('aborts the request signal when the deadline passes', async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise<Response>(() => undefined));
    const outcome = reasonOf(fetchBounded(h.ctx, get(), limits));
    expect((h.requests[0] as Request).signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    expect(await outcome).toBe('timeout');
    expect((h.requests[0] as Request).signal.aborted).toBe(true);
  });

  it('never exposes a message on the error', async () => {
    const h = harness(() => new Response(null, { status: 302 }));
    const error = await fetchBounded(h.ctx, get(), limits).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoundedFetchError);
    expect((error as Error).name).toBe('BoundedFetchError');
    expect((error as Error).message).toBe('redirect');
  });
});

interface TestKey {
  readonly kid: string;
  readonly jwk: { readonly n?: string; readonly e?: string };
  readonly privateKey: CryptoKey;
}

const keys: Record<string, TestKey> = {};

async function makeKey(kid: string, modulusLength = 2048): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, jwk, privateKey: pair.privateKey };
}

function entry(key: TestKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'RSA', n: key.jwk.n, e: key.jwk.e, kid: key.kid, ...extra };
}

function jwks(...entries: Record<string, unknown>[]): Response {
  return jsonResponse({ keys: entries });
}

beforeAll(async () => {
  for (const kid of ['k1', 'k2', 'k3']) {
    keys[kid] = await makeKey(kid);
  }
});

function key(kid: string): TestKey {
  return keys[kid] as TestKey;
}

function newCache(
  h: Harness,
  extra: { ttlMs?: number; graceMs?: number; timeoutMs?: number } = {},
) {
  return createJwksCache({ url: URL_JWKS, ctx: h.ctx, ...extra });
}

describe('createJwksCache', () => {
  it('imports an RSA JWK as a non-extractable public RS256 verification key', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const imported = await newCache(h).getKey('k1');
    expect(imported.type).toBe('public');
    expect(imported.extractable).toBe(false);
    expect(imported.usages).toEqual(['verify']);
    expect(imported.algorithm).toMatchObject({
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
      modulusLength: 2048,
    });
  });

  it('requests the JWKS URL with GET and without credentials', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    await newCache(h).getKey('k1');
    const sent = h.requests[0] as Request;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe(URL_JWKS);
    expect(sent.redirect).toBe('manual');
    expect(sent.headers.get('authorization')).toBeNull();
    expect(sent.headers.get('cookie')).toBeNull();
  });

  it('serves keys from a fresh cache without refetching', async () => {
    const h = harness(() => jwks(entry(key('k1')), entry(key('k2'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 5 * MIN;
    await cache.getKey('k2');
    await cache.getKey('k1');
    expect(h.requests).toHaveLength(1);
  });

  it('coalesces concurrent first lookups into one fetch', async () => {
    const h = harness(() => jwks(entry(key('k1')), entry(key('k2'))));
    const cache = newCache(h);
    await Promise.all([cache.getKey('k1'), cache.getKey('k2'), cache.getKey('k1')]);
    expect(h.requests).toHaveLength(1);
  });

  it('drops a removed key after the TTL', async () => {
    const h = harness(() => jwks(entry(key('k1')), entry(key('k2'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => jwks(entry(key('k2')));
    h.now += 9 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += 2 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('unknown_kid');
    await expect(cache.getKey('k2')).resolves.toBeDefined();
    expect(h.requests).toHaveLength(2);
  });

  it('honours custom ttlMs', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h, { ttlMs: MIN });
    await cache.getKey('k1');
    h.now += MIN - 1;
    await cache.getKey('k1');
    expect(h.requests).toHaveLength(1);
    h.now += 1;
    await cache.getKey('k1');
    expect(h.requests).toHaveLength(2);
  });

  it('refreshes once for a new kid and at most once per 60 seconds', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 2 * MIN;
    h.handler = () => jwks(entry(key('k1')), entry(key('k2')));
    await expect(cache.getKey('k2')).resolves.toBeDefined();
    expect(h.requests).toHaveLength(2);

    h.now += 10_000;
    expect(await failureOf(cache.getKey('k3'))).toBe('unknown_kid');
    h.now += 20_000;
    expect(await failureOf(cache.getKey('k3'))).toBe('unknown_kid');
    expect(h.requests).toHaveLength(2);

    h.now += 31_000;
    h.handler = () => jwks(entry(key('k1')), entry(key('k2')), entry(key('k3')));
    await expect(cache.getKey('k3')).resolves.toBeDefined();
    expect(h.requests).toHaveLength(3);
  });

  it('does not refetch right after the initial load for an unknown kid', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 1000;
    expect(await failureOf(cache.getKey('k2'))).toBe('unknown_kid');
    expect(h.requests).toHaveLength(1);
  });

  it('keeps known keys when a refresh fails within TTL plus grace', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => new Response('', { status: 500 });
    h.now += 11 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += 40 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += 18 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('k2'))).toBe('jwks_unavailable');
  });

  it('rejects every lookup with jwks_unavailable after TTL plus grace', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => Promise.reject(new TypeError('down'));
    h.now += 70 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
    expect(await failureOf(cache.getKey('k2'))).toBe('jwks_unavailable');
    h.now += 5 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
  });

  it('honours custom graceMs', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h, { ttlMs: MIN, graceMs: MIN });
    await cache.getKey('k1');
    h.handler = () => new Response('', { status: 503 });
    h.now += MIN + 1;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
  });

  it('recovers after the identity provider comes back', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => new Response('', { status: 500 });
    h.now += 80 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
    h.handler = () => jwks(entry(key('k1')), entry(key('k2')));
    h.now += 2 * MIN;
    await expect(cache.getKey('k2')).resolves.toBeDefined();
  });

  it('does not hammer a failing identity provider', async () => {
    const h = harness(() => new Response('', { status: 500 }));
    const cache = newCache(h);
    for (let i = 0; i < 5; i += 1) {
      expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
      h.now += 1000;
    }
    expect(h.requests).toHaveLength(1);
  });

  it('fails with jwks_unavailable when the first fetch fails', async () => {
    const h = harness(() => new Response(null, { status: 302 }));
    expect(await failureOf(newCache(h).getKey('k1'))).toBe('jwks_unavailable');
  });

  it('refuses an oversized JWKS', async () => {
    const padding = 'x'.repeat(70 * 1024);
    const h = harness(() => jsonResponse({ keys: [entry(key('k1'))], padding }));
    expect(await failureOf(newCache(h).getKey('k1'))).toBe('jwks_unavailable');
  });

  it('refuses an oversized JWKS streamed without content-length', async () => {
    const h = harness(() => okJson(streamOf(() => encoder.encode(' '.repeat(8192)))));
    expect(await failureOf(newCache(h).getKey('k1'))).toBe('jwks_unavailable');
  });

  it('accepts 20 keys and refuses 21', async () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => entry(key('k1'), { kid: `many-${i}` }));
    const h = harness(() => jwks(...many(20)));
    await expect(newCache(h).getKey('many-19')).resolves.toBeDefined();
    h.handler = () => jwks(...many(21));
    expect(await failureOf(newCache(h).getKey('many-0'))).toBe('jwks_unavailable');
  });

  it('counts ignored entries towards the 20-key limit', async () => {
    const entries = Array.from({ length: 21 }, (_, i) =>
      i === 0 ? entry(key('k1')) : { kty: 'EC', kid: `ec-${i}`, crv: 'P-256', x: 'a', y: 'b' },
    );
    const h = harness(() => jwks(...entries));
    expect(await failureOf(newCache(h).getKey('k1'))).toBe('jwks_unavailable');
  });

  it('ignores non-RSA, enc, non-RS256 and kid-less entries', async () => {
    const good = entry(key('k1'));
    const h = harness(() =>
      jwks(
        good,
        { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'a', y: 'b' },
        entry(key('k2'), { kid: 'enc', use: 'enc' }),
        entry(key('k2'), { kid: 'ps', alg: 'PS256' }),
        entry(key('k2'), { kid: 'rs512', alg: 'RS512' }),
        { kty: 'RSA', n: key('k2').jwk.n, e: key('k2').jwk.e },
        entry(key('k2'), { kid: 'sig', use: 'sig' }),
        entry(key('k2'), { kid: 'rs256', alg: 'RS256' }),
      ),
    );
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    await expect(cache.getKey('sig')).resolves.toBeDefined();
    await expect(cache.getKey('rs256')).resolves.toBeDefined();
    for (const kid of ['ec', 'enc', 'ps', 'rs512']) {
      h.now += 2 * MIN;
      expect(await failureOf(cache.getKey(kid))).toBe('unknown_kid');
    }
  });

  it('skips entries whose key material does not import', async () => {
    const h = harness(() =>
      jwks(entry(key('k1')), { kty: 'RSA', kid: 'broken', n: '!!', e: 'AQAB' }),
    );
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('broken'))).toBe('unknown_kid');
  });

  it('skips keys with a modulus under 2048 bits', async () => {
    const weak = await makeKey('weak', 1024);
    const h = harness(() => jwks(entry(key('k1')), entry(weak)));
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('weak'))).toBe('unknown_kid');
  });

  it.each([
    ['not an object', '[]'],
    ['no keys member', '{}'],
    ['keys not an array', '{"keys":{}}'],
  ])('treats a JWKS that is %s as a failed refresh', async (_name, body) => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => okJson(body);
    h.now += 11 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += 70 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('jwks_unavailable');
  });

  it('answers malformed kids as unknown_kid without fetching', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    for (const kid of ['', 'a'.repeat(257), 'a b', 'é']) {
      expect(await failureOf(cache.getKey(kid))).toBe('unknown_kid');
    }
    expect(h.requests).toHaveLength(0);
  });

  it('looks kids up as plain data', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    for (const kid of ['__proto__', 'constructor', 'toString']) {
      h.now += 2 * MIN;
      expect(await failureOf(cache.getKey(kid))).toBe('unknown_kid');
    }
  });

  it('rejects invalid configuration', () => {
    const h = harness(() => jwks());
    expect(() => createJwksCache({ url: 'not a url', ctx: h.ctx })).toThrow(RangeError);
    expect(() => createJwksCache({ url: URL_JWKS, ctx: h.ctx, ttlMs: 0 })).toThrow(RangeError);
    expect(() => createJwksCache({ url: URL_JWKS, ctx: h.ctx, graceMs: -1 })).toThrow(RangeError);
    expect(() => createJwksCache({ url: URL_JWKS, ctx: h.ctx, ttlMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => createJwksCache({ url: URL_JWKS, ctx: h.ctx, timeoutMs: 0 })).toThrow(RangeError);
  });

  it.each([
    'http://idp.example/certs',
    'http://localhost.example/certs',
    'http://127.0.0.1.example/certs',
    'ftp://localhost/certs',
    'file:///certs',
    'javascript:alert(1)',
  ])('refuses the URL %s', (url) => {
    const h = harness(() => jwks());
    expect(() => createJwksCache({ url, ctx: h.ctx })).toThrow(RangeError);
  });

  it.each([
    'https://idp.example/certs',
    'http://localhost:5556/keys',
    'http://127.0.0.1:5556/keys',
    'http://127.4.5.6/keys',
    'http://[::1]:5556/keys',
  ])('accepts the URL %s', (url) => {
    const h = harness(() => jwks());
    expect(() => createJwksCache({ url, ctx: h.ctx })).not.toThrow();
  });

  it('replaces the key set with a valid document that has no usable key', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => jsonResponse({ keys: [{ kty: 'oct', kid: 'a', k: 'AA' }] });
    h.now += 11 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('unknown_kid');
    expect(h.requests).toHaveLength(2);
  });

  it('stops serving an RSA key after rotation to an EC-only JWKS', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => jwks({ kty: 'EC', kid: 'ec-1', crv: 'P-256', x: 'a', y: 'b' });
    h.now += 11 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('unknown_kid');
    h.now += 2 * MIN;
    h.handler = () => jwks(entry(key('k2')));
    await expect(cache.getKey('k2')).resolves.toBeDefined();
  });

  it('accepts a valid empty key list as a replacement', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.handler = () => jsonResponse({ keys: [] });
    h.now += 11 * MIN;
    expect(await failureOf(cache.getKey('k1'))).toBe('unknown_kid');
  });

  it('skips a kid that appears on more than one usable entry', async () => {
    const h = harness(() =>
      jwks(
        entry(key('k1'), { kid: 'twin' }),
        entry(key('k2'), { kid: 'twin' }),
        entry(key('k3')),
        entry(key('k1'), { kid: 'once' }),
        entry(key('k2'), { kid: 'once', use: 'enc' }),
      ),
    );
    const cache = newCache(h);
    await expect(cache.getKey('k3')).resolves.toBeDefined();
    await expect(cache.getKey('once')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('twin'))).toBe('unknown_kid');
  });

  it('keeps a kid that appears twice with identical key material', async () => {
    const h = harness(() => jwks(entry(key('k1')), entry(key('k1')), entry(key('k2'))));
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    await expect(cache.getKey('k2')).resolves.toBeDefined();
  });

  it('skips keys whose public exponent is not 65537', async () => {
    const h = harness(() => jwks(entry(key('k1')), entry(key('k2'), { kid: 'e3', e: 'Aw' })));
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('e3'))).toBe('unknown_kid');
  });

  it('skips keys with a modulus over 8192 bits', async () => {
    const huge = new Uint8Array(1025).fill(0xff);
    const h = harness(() =>
      jwks(entry(key('k1')), entry(key('k1'), { kid: 'huge', n: base64urlEncode(huge) })),
    );
    const cache = newCache(h);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('huge'))).toBe('unknown_kid');
  });

  it('answers an unknown kid with jwks_unavailable after a failed refresh on a fresh cache', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 2 * MIN;
    h.handler = () => new Response('', { status: 500 });
    expect(await failureOf(cache.getKey('k2'))).toBe('jwks_unavailable');
    await expect(cache.getKey('k1')).resolves.toBeDefined();
  });

  it('fetches once for concurrent distinct unknown kids on a fresh cache', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 2 * MIN;
    const results = await Promise.all(
      ['x1', 'x2', 'x3'].map((kid) => failureOf(cache.getKey(kid))),
    );
    expect(results).toEqual(['unknown_kid', 'unknown_kid', 'unknown_kid']);
    expect(h.requests).toHaveLength(2);
  });

  it('keeps serving a warm cache when a refresh returns 21 keys or an oversized document', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    await cache.getKey('k1');
    h.now += 11 * MIN;
    h.handler = () =>
      jwks(...Array.from({ length: 21 }, (_, i) => entry(key('k2'), { kid: `many-${i}` })));
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    h.now += 2 * MIN;
    h.handler = () => jsonResponse({ keys: [entry(key('k2'))], padding: 'x'.repeat(70 * 1024) });
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(h.requests).toHaveLength(3);
    expect(await failureOf(cache.getKey('k2'))).toBe('jwks_unavailable');
  });

  it('starts one replacement refresh for 50 waiters on a hung refresh', async () => {
    vi.useFakeTimers();
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h, { timeoutMs: 80 });
    hang.next = true;
    const waiters = Array.from({ length: 50 }, () => cache.getKey('k1'));
    await vi.advanceTimersByTimeAsync(80);
    await expect(Promise.all(waiters)).resolves.toHaveLength(50);
    expect(hang.calls).toBe(2);
    expect(h.requests).toHaveLength(1);
  });

  it('lets arrivals during the replacement refresh join it', async () => {
    vi.useFakeTimers();
    let release: (response: Response) => void = () => undefined;
    const h = harness(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const cache = newCache(h, { timeoutMs: 80 });
    hang.next = true;
    const first = cache.getKey('k1');
    await vi.advanceTimersByTimeAsync(80);
    const arrival = cache.getKey('k1');
    await vi.advanceTimersByTimeAsync(10);
    release(jwks(entry(key('k1'))));
    await expect(Promise.all([first, arrival])).resolves.toHaveLength(2);
    expect(hang.calls).toBe(2);
    expect(h.requests).toHaveLength(1);
  });

  it('gives up on a replacement refresh after one more deadline', async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise<Response>(() => undefined));
    const cache = newCache(h, { timeoutMs: 80 });
    hang.next = true;
    const outcome = failureOf(cache.getKey('k1'));
    await vi.advanceTimersByTimeAsync(400);
    expect(await outcome).toBe('jwks_unavailable');
  });

  it('ignores a failure from an older refresh that settles after a newer success', async () => {
    vi.useFakeTimers();
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h, { timeoutMs: 80 });
    hang.next = true;
    const first = cache.getKey('k1');
    await vi.advanceTimersByTimeAsync(80);
    await first;
    const loadedAt = h.now;
    const older = hang.pending as Hung;
    older.reject(new BoundedFetchError('network'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await failureOf(cache.getKey('nope'))).toBe('unknown_kid');
    h.now = loadedAt + 9 * MIN;
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(h.requests).toHaveLength(1);
  });

  it('ignores a document from an older refresh that settles after a newer one', async () => {
    vi.useFakeTimers();
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h, { timeoutMs: 80 });
    hang.next = true;
    const first = cache.getKey('k1');
    await vi.advanceTimersByTimeAsync(80);
    await first;
    const older = hang.pending as Hung;
    older.resolve({ status: 200, json: { keys: [entry(key('k2'))] } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.getKey('k1')).resolves.toBeDefined();
    expect(await failureOf(cache.getKey('k2'))).toBe('unknown_kid');
  });

  it('verifies a signed token end to end and rejects it once the key is removed', async () => {
    const h = harness(() => jwks(entry(key('k1'))));
    const cache = newCache(h);
    const nowSeconds = Math.floor(START / 1000);
    const encode = (value: unknown) => base64urlEncode(encoder.encode(JSON.stringify(value)));
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${encode({
      iss: 'https://team.example.cloudflareaccess.com',
      aud: 'aud-1',
      sub: 'subject-1',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key('k1').privateKey,
        encoder.encode(signingInput),
      ),
    );
    const token = `${signingInput}.${base64urlEncode(signature)}`;
    const input = {
      keys: cache,
      issuer: 'https://team.example.cloudflareaccess.com',
      audience: 'aud-1',
      clock: h.ctx.clock,
    };
    await expect(verifyJwt(token, input)).resolves.toMatchObject({ sub: 'subject-1' });

    h.handler = () => jwks(entry(key('k2')));
    h.now += 11 * MIN;
    expect(await failureOf(verifyJwt(token, input))).toBe('unknown_kid');
  });
});
