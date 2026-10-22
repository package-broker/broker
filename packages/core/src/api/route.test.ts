import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { VALIDATION_CODES, type ValidationDetail } from './validate.js';
import type { RequestContext } from '../plugin.js';
import {
  apiRoute,
  defineApi,
  type ApiOutcome,
  type ApiRouteSpec,
  type RouteOutcome,
} from './route.js';
import { SERVICE_ERROR_TABLE } from './response.js';

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

describe('apiRoute allowArchived', () => {
  it('copies allowArchived only when the spec sets it', () => {
    const plain = apiRoute(defineApi(spec()), () => Promise.resolve(ok));
    expect(Object.hasOwn(plain, 'allowArchived')).toBe(false);
    const flagged = apiRoute(defineApi(spec({ boundary: 'project', allowArchived: true })), () =>
      Promise.resolve(ok),
    );
    expect(flagged).toMatchObject({ allowArchived: true });
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

describe.each(['POST', 'PUT', 'PATCH'] as const)('%s concurrency', (method) => {
  const runForMethod: typeof run = (options = {}, handler, overrides = {}) =>
    run({ ...options, method }, handler, { ...overrides, method });
  it('answers 428 without If-Match', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    const response = await runForMethod({}, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(428);
    expect((await envelope(response)).error.code).toBe('precondition_required');
  });

  it('passes If-Match "r2" as expectedRevision 2', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    await runForMethod({ headers: rev }, handler);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }));
  });

  it.each(['abc', '"r0"', '"r-1"', '"r1.5"', 'r2', '"r2", "r3"', '"r99999999999999999999"'])(
    'answers 400 without details for If-Match %s',
    async (value) => {
      const response = await runForMethod({ headers: { 'if-match': value } });
      expect(response.status).toBe(400);
      const { error } = await envelope(response);
      expect(error.code).toBe('invalid_request');
      expect(error.details).toBeUndefined();
    },
  );

  it('answers 412 for a handler conflict', async () => {
    const response = await runForMethod({ headers: rev }, () =>
      Promise.resolve({ error: 'conflict' }),
    );
    expect(response.status).toBe(412);
    expect((await envelope(response)).error.code).toBe('precondition_failed');
  });

  it('answers 409 for a conflict without concurrency', async () => {
    const plain = omit(spec({ method }), 'concurrency');
    const route = apiRoute(defineApi(plain), () => Promise.resolve({ error: 'conflict' }));
    const response = (await route.handler(context({ method }))) as Response;
    expect(response.status).toBe(409);
    expect((await envelope(response)).error.code).toBe('conflict');
  });

  it.each([undefined, 'invalid', '"r2"'])(
    'passes null expectedRevision without concurrency with header %s',
    async (header) => {
      const plain = omit(spec({ method }), 'concurrency');
      const handler = vi.fn(() => Promise.resolve(ok));
      await (apiRoute(defineApi(plain), handler).handler(
        context({ method, headers: header === undefined ? {} : { 'if-match': header } }),
      ) as Promise<Response>);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: null }));
    },
  );
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

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('accepts concurrency on %s', (method) => {
    expect(defineApi(spec({ method, api: omit(slot, 'body') })).concurrency).toBe('if-match');
  });

  it('throws for concurrency on a GET', () => {
    expect(() => defineApi(spec({ method: 'GET', api: omit(slot, 'body') }))).toThrow(
      /concurrency/,
    );
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

describe('apiRoute follow-ups', () => {
  it('validates 40,000 repeated query keys in under 500ms', async () => {
    const ctx = context({ query: `?${Array(40000).fill('limit=a').join('&')}`, headers: rev });
    const route = apiRoute(spec(), () => Promise.resolve(ok));
    const started = performance.now();
    const response = (await route.handler(ctx)) as Response;
    expect(performance.now() - started).toBeLessThan(500);
    expect((await envelope(response)).error.details).toEqual([
      { path: '/query/limit', code: 'invalid_type' },
    ]);
  });

  it('reads the request URL once without a query schema', async () => {
    const ctx = context({ body: null, query: '?extra=1' });
    const url = ctx.request.url;
    const read = vi.fn(() => url);
    Object.defineProperty(ctx.request, 'url', { get: read });
    const parse = vi.spyOn(globalThis, 'URL');
    const response = (await apiRoute(spec({ api: omit(omit(slot, 'body'), 'query') }), () =>
      Promise.resolve(ok),
    ).handler(ctx)) as Response;
    expect(response.status).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('does not copy a non-string handler detail path', async () => {
    const details = [
      { path: { value: 'private' }, code: 'invalid' },
    ] as unknown as ValidationDetail[];
    const response = await run({ headers: rev }, () =>
      Promise.resolve({ error: 'invalid_request', details }),
    );
    expect((await envelope(response)).error.details).toEqual([{ path: '', code: 'invalid' }]);
  });

  it.each(['invalid_json', 'invalid_encoding', 'too_deep'] as const)(
    'preserves shared handler validation code %s',
    async (code) => {
      const details: ValidationDetail[] = [{ path: '/body', code }];
      const response = await run({ headers: rev }, () =>
        Promise.resolve({ error: 'invalid_request', details }),
      );
      expect((await envelope(response)).error.details).toEqual(details);
    },
  );

  it('uses the shared validation set for handler details', async () => {
    const has = vi.spyOn(VALIDATION_CODES, 'has');
    await run({ headers: rev }, () =>
      Promise.resolve({ error: 'invalid_request', details: [{ path: '', code: 'invalid' }] }),
    );
    expect(has).toHaveBeenCalledWith('invalid');
  });

  it('rejects an unknown handler validation code', async () => {
    const details = [{ path: '', code: 'unknown_code' }] as unknown as ValidationDetail[];
    const response = await run({ headers: rev }, () =>
      Promise.resolve({ error: 'invalid_request', details }),
    );
    expect((await envelope(response)).error.details).toEqual([{ path: '', code: 'invalid' }]);
  });

  it('rejects an empty object on a body-less route before invoking the handler', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    const response = await run({ body: '{}', headers: rev }, handler, { api: omit(slot, 'body') });
    expect(response.status).toBe(400);
    expect((await envelope(response)).error.details).toEqual([{ path: '/body', code: 'invalid' }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects raw upload bytes on a body-less route', async () => {
    const handler = vi.fn(() => Promise.resolve(ok));
    const response = await run(
      { body: 'raw upload', contentType: 'application/octet-stream', headers: rev },
      handler,
      { api: omit(slot, 'body') },
    );
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('service error outcomes', () => {
  type AdminSpec = ApiRouteSpec & { readonly service: 'AdminError' };

  const adminTable = SERVICE_ERROR_TABLE.AdminError;
  const adminKeys = Object.keys(adminTable) as (keyof typeof adminTable)[];

  function serviceRun(
    key: unknown,
    options: Options = {},
    overrides: Partial<ApiRouteSpec> = { service: 'AdminError' },
    handler?: () => Promise<unknown>,
    plain = false,
  ): Promise<Response> {
    const base = spec(overrides);
    const route = apiRoute(
      defineApi(plain ? omit(base, 'concurrency') : base),
      (handler ?? (() => Promise.resolve({ serviceError: key }))) as never,
    );
    return route.handler(context(options)) as Promise<Response>;
  }

  it('covers every AdminError key in the table', () => {
    expect(adminKeys.length).toBe(16);
  });

  it.each(adminKeys)('maps AdminError %s without concurrency', async (key) => {
    const { code, status } = adminTable[key];
    const response = await serviceRun(key, {}, undefined, undefined, true);
    expect(response.status).toBe(status);
    const { error } = await envelope(response);
    expect(error.code).toBe(code);
    expect(error.requestId).toBe('req-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('req-1');
    if (key !== code) expect(await dump(response)).not.toContain(`"${key}"`);
  });

  it.each(adminKeys)('maps AdminError %s with If-Match', async (key) => {
    const { code, status } = adminTable[key];
    const response = await serviceRun(key, { headers: rev });
    if (key === 'conflict') {
      expect(response.status).toBe(412);
      expect((await envelope(response)).error.code).toBe('precondition_failed');
    } else {
      expect(response.status).toBe(status);
      expect((await envelope(response)).error.code).toBe(code);
    }
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('req-1');
    if (key !== code) expect(await dump(response)).not.toContain(`"${key}"`);
  });

  it('turns only the declared stale-revision error into 412', async () => {
    for (const key of ['system_role', 'in_use', 'locked']) {
      const response = await serviceRun(key, { headers: rev });
      expect(response.status).toBe(409);
      expect((await envelope(response)).error.code).toBe('conflict');
    }
  });

  it('answers a family without a stale-revision error with 409 under If-Match', async () => {
    const response = await serviceRun(
      'conflict',
      { headers: rev },
      { service: 'PersonalTokenError' },
    );
    expect(response.status).toBe(409);
    expect((await envelope(response)).error.code).toBe('conflict');
  });

  it.each([
    ['AdminError', 412],
    ['ServicePrincipalError', 412],
    ['ProjectError', 409],
    ['SourceError', 409],
    ['VisibilityError', 409],
    ['PersonalTokenError', 409],
    ['ServiceTokenError', 409],
  ] as const)('maps %s conflict under If-Match to %i', async (service, status) => {
    const response = await serviceRun('conflict', { headers: rev }, { service });
    expect(response.status).toBe(status);
    const code = status === 412 ? 'precondition_failed' : 'conflict';
    expect((await envelope(response)).error.code).toBe(code);
  });

  it.each([
    ['an unknown key', 'nope'],
    ['a prototype key', 'toString'],
    ['a non-string', 42],
    ['an object', { a: 1 }],
    ['undefined', undefined],
  ])('fails closed for %s', async (_name, key) => {
    await expect(serviceRun(key, { headers: rev })).rejects.toThrow(TypeError);
  });

  it('fails closed without service and does not echo the key', async () => {
    const error: unknown = await serviceRun(SENTINEL, { headers: rev }, {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(SENTINEL);
    const unknown: unknown = await serviceRun(SENTINEL, { headers: rev }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(TypeError);
    expect((unknown as Error).message).not.toContain(SENTINEL);
  });

  it('never calls the handler on 428, malformed If-Match or validation failure', async () => {
    const handler = vi.fn(() => Promise.resolve({ serviceError: 'system_role' }));
    const missing = await serviceRun(null, {}, undefined, handler);
    expect(missing.status).toBe(428);
    const malformed = await serviceRun(
      null,
      { headers: { 'if-match': 'abc' } },
      undefined,
      handler,
    );
    expect(malformed.status).toBe(400);
    const invalid = await serviceRun(null, { headers: rev, body: '{"x":1}' }, undefined, handler);
    expect(invalid.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('types serviceError against the declared service', () => {
    const admin: RouteOutcome<AdminSpec> = { serviceError: 'system_role' };
    expect(admin).toBeDefined();
    type ProjectSpec = ApiRouteSpec & { readonly service: 'ProjectError' };
    // @ts-expect-error family mismatch
    const mismatch: RouteOutcome<ProjectSpec> = { serviceError: 'system_role' };
    expect(mismatch).toBeDefined();
    // @ts-expect-error no declared service
    const none: RouteOutcome<ApiRouteSpec> = { serviceError: 'conflict' };
    expect(none).toBeDefined();
    const routeSpec = { ...spec(), service: 'ProjectError' } as const;
    // @ts-expect-error family mismatch through apiRoute
    apiRoute(routeSpec, () => Promise.resolve({ serviceError: 'system_role' }));
  });
});
