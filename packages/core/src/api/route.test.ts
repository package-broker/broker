import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { ValidationDetail } from './validate.js';
import type { RequestContext } from '../plugin.js';
import { apiRoute, defineApi, type ApiOutcome, type ApiRouteSpec } from './route.js';

const SENTINEL = 'S3CR3T-SENTINEL';

const slot = {
  operationId: 'updateThing',
  summary: 'Update a thing',
  tags: ['things'],
  params: z.strictObject({ id: z.string().regex(/^[a-z]+$/) }),
  query: z.strictObject({ limit: z.string().optional() }),
  body: z.strictObject({ name: z.string() }),
  responses: { 200: z.strictObject({ ok: z.boolean() }), 204: null },
};

function spec(overrides: Partial<ApiRouteSpec> = {}): ApiRouteSpec {
  return {
    method: 'PUT',
    path: '/_pb/things/:id',
    permission: 'org:things:write',
    boundary: 'organization',
    concurrency: 'if-match',
    api: slot,
    ...overrides,
  };
}

interface Options {
  readonly params?: Record<string, string>;
  readonly query?: string;
  readonly body?: string | null;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
  readonly method?: string;
}

function context(options: Options = {}): RequestContext {
  const headers = new Headers(options.headers);
  const body = options.body === undefined ? '{"name":"a"}' : options.body;
  if (body !== null && options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  return {
    request: new Request(`https://broker.test/_pb/things/abc${options.query ?? ''}`, {
      method: options.method ?? 'PUT',
      headers,
      body,
    }),
    requestId: 'req-1',
    org: null,
    principal: null,
    projectId: null,
    params: options.params ?? { id: 'abc' },
    ports: {} as RequestContext['ports'],
  };
}

const ok: ApiOutcome = { status: 200, body: { ok: true } };

async function run(
  options: Options = {},
  handler: Parameters<typeof apiRoute>[1] = () => Promise.resolve(ok),
  overrides: Partial<ApiRouteSpec> = {},
): Promise<Response> {
  return apiRoute(defineApi(spec(overrides)), handler).handler(
    context(options),
  ) as Promise<Response>;
}

async function dump(response: Response): Promise<string> {
  return JSON.stringify([...response.headers.entries()]) + (await response.clone().text());
}

async function envelope(response: Response): Promise<{
  error: { code: string; requestId: string; details?: { path: string; code: string }[] };
}> {
  return (await response.clone().json()) as never;
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;
}

const rev = { 'if-match': '"r2"' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiRoute definition', () => {
  it('rejects an invalid raw spec without defineApi', () => {
    const raw = spec({ api: { ...slot, responses: { 200: null, 600: null } } });
    expect(() => apiRoute(raw, () => Promise.resolve(ok))).toThrow(TypeError);
  });

  it('copies method, path, permission and boundary and sets api', () => {
    const route = apiRoute(defineApi(spec()), () => Promise.resolve(ok));
    expect(route).toMatchObject({
      method: 'PUT',
      path: '/_pb/things/:id',
      permission: 'org:things:write',
      boundary: 'organization',
      api: slot,
    });
  });
});

describe('input validation', () => {
  it('rejects a wrong-typed param under /params', async () => {
    const response = await run({ params: { id: '123' }, headers: rev });
    expect(response.status).toBe(400);
    const { error } = await envelope(response);
    expect(error.code).toBe('invalid_request');
    expect(error.details?.[0]?.path).toMatch(/^\/params/);
  });

  it('rejects a wrong-typed query value under /query', async () => {
    const response = await run({ query: '?limit=a&limit=b', headers: rev });
    const { error } = await envelope(response);
    expect(response.status).toBe(400);
    expect(error.details?.[0]?.path).toMatch(/^\/query/);
  });

  it('rejects a wrong-typed body field under /body', async () => {
    const response = await run({ body: '{"name":5}', headers: rev });
    const { error } = await envelope(response);
    expect(response.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.details?.[0]?.path).toMatch(/^\/body/);
  });

  it('rejects an unknown query key without naming it', async () => {
    const response = await run({ query: `?${SENTINEL}=1`, headers: rev });
    const { error } = await envelope(response);
    expect(response.status).toBe(400);
    expect(error.details).toEqual([{ path: '/query', code: 'unrecognized_keys' }]);
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it('rejects an unknown body property without naming it', async () => {
    const response = await run({ body: `{"name":"a","${SENTINEL}":1}`, headers: rev });
    const { error } = await envelope(response);
    expect(response.status).toBe(400);
    expect(error.details).toEqual([{ path: '/body', code: 'unrecognized_keys' }]);
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it('merges params, query and body details in order up to 20', async () => {
    const wide = z.strictObject(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, z.string()])),
    );
    const response = await run({ params: {}, body: '{}', headers: rev }, undefined, {
      api: { ...slot, params: wide, query: wide, body: wide },
    });
    const { error } = await envelope(response);
    expect(response.status).toBe(400);
    expect(error.details).toEqual(
      ['params', 'query', 'body']
        .flatMap((location) =>
          Array.from({ length: 8 }, (_, i) => ({
            path: `/${location}/k${i}`,
            code: 'invalid_type',
          })),
        )
        .slice(0, 20),
    );
  });

  it('rejects query input when no query schema is declared', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    const response = await run({ query: `?${SENTINEL}=1`, headers: rev }, handler, {
      api: omit(slot, 'query'),
    });
    expect(response.status).toBe(400);
    expect((await envelope(response)).error).toMatchObject({
      code: 'invalid_request',
      details: [{ path: '/query', code: 'unrecognized_keys' }],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it('validates 4,000 repeated query keys in under 500ms', async () => {
    const started = performance.now();
    const response = await run({
      query: `?${Array(4000).fill('limit=a').join('&')}`,
      headers: rev,
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(response.status).toBe(400);
    expect((await envelope(response)).error.details).toEqual([
      { path: '/query/limit', code: 'invalid_type' },
    ]);
  });

  it('passes validated params, query and body to the handler', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    await run({ query: '?limit=5', headers: rev }, handler);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { id: 'abc' },
        query: { limit: '5' },
        body: { name: 'a' },
        expectedRevision: 2,
      }),
    );
  });
});

describe('body reading', () => {
  it('answers 415 for text/plain', async () => {
    const response = await run({ contentType: 'text/plain', headers: rev });
    expect(response.status).toBe(415);
    expect((await envelope(response)).error.code).toBe('unsupported_media_type');
  });

  it('answers 413 for a 65537-byte body', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const body = 'x'.repeat(65537);
    const response = await run({ body, headers: rev });
    expect(response.status).toBe(413);
    expect(parse.mock.calls.some(([text]) => text === body)).toBe(false);
  });

  it('answers 400 too_deep for nesting depth 17', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const body = '['.repeat(17) + ']'.repeat(17);
    const response = await run({ body, headers: rev });
    expect(response.status).toBe(400);
    expect((await envelope(response)).error.details).toEqual([{ path: '/body', code: 'too_deep' }]);
    expect(parse.mock.calls.some(([text]) => text === body)).toBe(false);
  });

  it('answers 400 invalid_json for malformed JSON', async () => {
    const response = await run({ body: '{', headers: rev });
    expect((await envelope(response)).error.details).toEqual([
      { path: '/body', code: 'invalid_json' },
    ]);
  });

  it('rejects a non-empty body when no body schema is declared', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    const response = await run(
      { body: SENTINEL, contentType: 'text/plain', headers: rev },
      handler,
      {
        api: omit(slot, 'body'),
      },
    );
    expect(response.status).toBe(400);
    expect((await envelope(response)).error).toMatchObject({
      code: 'invalid_request',
      details: [{ path: '/body', code: 'invalid' }],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it.each([null, ''])('accepts an empty body %s without a body schema', async (body) => {
    const response = await run({ body, headers: rev }, undefined, { api: omit(slot, 'body') });
    expect(response.status).toBe(200);
  });
});

describe('concurrency', () => {
  it('answers 428 without If-Match', async () => {
    const response = await run();
    expect(response.status).toBe(428);
    expect((await envelope(response)).error.code).toBe('precondition_required');
  });

  it('passes If-Match "r2" as expectedRevision 2', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    await run({ headers: rev }, handler);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }));
  });

  it.each(['abc', '"r0"', '"r-1"', '"r1.5"', 'r2', '"r2", "r3"', '"r99999999999999999999"'])(
    'answers 400 without details for If-Match %s',
    async (value) => {
      const response = await run({ headers: { 'if-match': value } });
      expect(response.status).toBe(400);
      const { error } = await envelope(response);
      expect(error.code).toBe('invalid_request');
      expect(error.details).toBeUndefined();
    },
  );

  it('answers 412 for a handler conflict', async () => {
    const response = await run({ headers: rev }, () => Promise.resolve({ error: 'conflict' }));
    expect(response.status).toBe(412);
    expect((await envelope(response)).error.code).toBe('precondition_failed');
  });

  it('answers 409 for a conflict without concurrency', async () => {
    const plain = omit(spec(), 'concurrency');
    const route = apiRoute(defineApi(plain), () => Promise.resolve({ error: 'conflict' }));
    const response = (await route.handler(context())) as Response;
    expect(response.status).toBe(409);
    expect((await envelope(response)).error.code).toBe('conflict');
  });

  it('passes null expectedRevision without concurrency', async () => {
    const plain = omit(spec(), 'concurrency');
    const handler = vi.fn(() => Promise.resolve(ok));
    await (apiRoute(defineApi(plain), handler).handler(context()) as Promise<Response>);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: null }));
  });
});

describe('no-echo', () => {
  it('never reflects sentinels from param, query, unknown key or body field', async () => {
    const response = await run({
      params: { id: SENTINEL },
      query: `?limit=${SENTINEL}&${SENTINEL}=1`,
      body: `{"name":{"${SENTINEL}":"${SENTINEL}"},"${SENTINEL}":1}`,
      headers: { ...rev, 'x-other': SENTINEL },
    });
    expect(response.status).toBe(400);
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it('does not echo a bad If-Match value', async () => {
    const response = await run({ headers: { 'if-match': SENTINEL } });
    expect(await dump(response)).not.toContain(SENTINEL);
  });
});

describe('outcomes', () => {
  it('throws TypeError for an undeclared success status', async () => {
    await expect(
      run({ headers: rev }, () => Promise.resolve({ status: 201, body: {} })),
    ).rejects.toThrow(TypeError);
  });

  it('serialises a declared success with its ETag', async () => {
    const response = await run({ headers: rev }, () =>
      Promise.resolve({ status: 200, body: { ok: true }, etag: 3 }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"r3"');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers a declared 204 without a body', async () => {
    const response = await run({ headers: rev }, () => Promise.resolve({ status: 204 }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('sets no-store, no CORS and x-request-id on success and error', async () => {
    for (const response of [
      await run({ headers: rev }),
      await run(),
      await run({ headers: rev }, () => Promise.resolve({ error: 'forbidden' })),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('x-request-id')).toBe('req-1');
    }
  });

  it('maps a handler error outcome and keeps details only for invalid_request', async () => {
    const details = [{ path: '/body/name', code: 'invalid_value' }] as const;
    const bad = await run({ headers: rev }, () =>
      Promise.resolve({ error: 'invalid_request', details }),
    );
    expect((await envelope(bad)).error.details).toEqual(details);
    const other = await run({ headers: rev }, () =>
      Promise.resolve({ error: 'forbidden', details }),
    );
    expect((await envelope(other)).error.details).toBeUndefined();
  });

  it('caps and sanitizes handler error details', async () => {
    const details = Array.from({ length: 25 }, (_, i) => ({
      path: `/body/k${i}`,
      location: 'body',
      code: i === 0 ? SENTINEL : 'invalid_value',
      received: SENTINEL,
      message: SENTINEL,
    })) as unknown as readonly ValidationDetail[];
    const response = await run({ headers: rev }, () =>
      Promise.resolve({ error: 'invalid_request', details }),
    );
    expect(response.status).toBe(400);
    expect((await envelope(response)).error.details).toEqual(
      Array.from({ length: 20 }, (_, i) => ({
        path: `/body/k${i}`,
        location: 'body',
        code: i === 0 ? 'invalid' : 'invalid_value',
      })),
    );
    expect(await dump(response)).not.toContain(SENTINEL);
  });

  it('answers the same not_found bytes for two resources', async () => {
    const first = await run({ headers: rev, params: { id: 'one' } }, () =>
      Promise.resolve({ error: 'not_found' }),
    );
    const second = await run({ headers: rev, params: { id: 'two' } }, () =>
      Promise.resolve({ error: 'not_found' }),
    );
    expect(first.status).toBe(404);
    expect(await first.text()).toBe(await second.text());
    expect([...first.headers.entries()]).toEqual([...second.headers.entries()]);
  });

  it('uses the context request id in the envelope', async () => {
    const response = await run();
    expect((await envelope(response)).error.requestId).toBe('req-1');
  });
});

describe('defineApi', () => {
  it('throws for a body on a GET', () => {
    const plain = omit(spec(), 'concurrency');
    expect(() => defineApi({ ...plain, method: 'GET' })).toThrow(/body/);
  });

  it('throws for concurrency on a POST', () => {
    expect(() => defineApi(spec({ method: 'POST' }))).toThrow(/concurrency/);
  });

  it('throws for a non-representable schema', () => {
    const bad = { ...slot, body: z.strictObject({ at: z.date() }) };
    expect(() => defineApi(spec({ api: bad }))).toThrow(/body/);
  });

  it('throws for a non-representable response schema', () => {
    const bad = { ...slot, responses: { 200: z.strictObject({ at: z.date() }) } };
    expect(() => defineApi(spec({ api: bad }))).toThrow();
  });

  it('throws when no 2xx response is declared', () => {
    expect(() => defineApi(spec({ api: { ...slot, responses: { 404: null } } }))).toThrow(/2xx/);
  });

  it('returns the spec unchanged', () => {
    const value = spec();
    expect(defineApi(value)).toBe(value);
  });
});
