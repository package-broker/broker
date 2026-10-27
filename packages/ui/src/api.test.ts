import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createApiClient, type ApiClientDeps, type ApiErrorCode, type ApiResult } from './api.js';
import type { paths } from './test-fixtures/api-types.js';

const SOURCES = '/_pb/projects/{project}/sources' as const;
const SEARCH = '/_pb/projects/{project}/sources/search' as const;
const SOURCE = '/_pb/projects/{project}/sources/{source}' as const;

function envelope(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ error: { code, message: 'm', requestId: 'req-1', ...extra } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function setup(respond: () => Response | Promise<Response> = () => envelope(500, 'unavailable')) {
  const fetch = vi.fn<ApiClientDeps['fetch']>(() => Promise.resolve(respond()));
  const readCookie = vi.fn((name: string) =>
    name === '__Host-pb_csrf' ? 'csrf-value' : undefined,
  );
  const client = createApiClient<paths>({ fetch, readCookie });
  const init = (): RequestInit => fetch.mock.calls[0]![1];
  const headers = (): Record<string, string> => init().headers as Record<string, string>;
  return { client, fetch, readCookie, init, headers };
}

describe('csrf and headers', () => {
  it('sends X-CSRF-Token from the cookie on an unsafe method', async () => {
    const { client, headers, readCookie } = setup(
      () => new Response(JSON.stringify({ id: 's1' }), { status: 201 }),
    );
    await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'https://example.test' },
    });
    expect(readCookie).toHaveBeenCalledWith('__Host-pb_csrf');
    expect(headers()['X-CSRF-Token']).toBe('csrf-value');
    expect(headers()['Content-Type']).toBe('application/json');
  });

  it('sends the CSRF token on DELETE with its If-Match header', async () => {
    const { client, headers, init } = setup(() => new Response(null, { status: 204 }));
    await client.request('delete', SOURCE, {
      params: { project: 'p', source: 's' },
      headers: { 'If-Match': '"r1"' },
    });
    expect(init().method).toBe('DELETE');
    expect(headers()['X-CSRF-Token']).toBe('csrf-value');
    expect(headers()['If-Match']).toBe('"r1"');
  });

  it('adds no CSRF token and no content type to a GET', async () => {
    const { client, headers, readCookie } = setup(
      () => new Response(JSON.stringify({ items: [], next: null }), { status: 200 }),
    );
    await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(headers()).toEqual({});
    expect(readCookie).not.toHaveBeenCalled();
  });

  it('sends the idempotency key header when given', async () => {
    const { client, headers } = setup(() => new Response('{"id":"s1"}', { status: 201 }));
    await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
      idempotencyKey: 'key-1',
    });
    expect(headers()['Idempotency-Key']).toBe('key-1');
  });

  it('sends no idempotency header when none is given', async () => {
    const { client, headers } = setup(() => new Response('{"id":"s1"}', { status: 201 }));
    await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
    });
    expect(headers()).not.toHaveProperty('Idempotency-Key');
  });
});

describe('request building', () => {
  it('fills the template with encoded params and serialises the query', async () => {
    const { client, fetch } = setup(
      () => new Response(JSON.stringify({ items: [], next: null }), { status: 200 }),
    );
    await client.request('get', SOURCES, {
      params: { project: 'a b/c' },
      query: { limit: 5, after: undefined },
    });
    expect(fetch.mock.calls[0]![0]).toBe('/_pb/projects/a%20b%2Fc/sources?limit=5');
  });

  it('sends the JSON body', async () => {
    const { client, init } = setup(() => new Response('{"id":"s1"}', { status: 201 }));
    await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
    });
    expect(init().body).toBe('{"name":"n","url":"u"}');
  });

  it('returns typed data on success', async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ items: [{ id: '1', name: 'a' }], next: null }), {
          status: 200,
        }),
    );
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { items: [{ id: '1', name: 'a' }], next: null },
    });
  });

  it('returns undefined data for 204', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    const result = await client.request('delete', SOURCE, {
      params: { project: 'p', source: 's' },
      headers: { 'If-Match': '"r1"' },
    });
    expect(result).toEqual({ ok: true, status: 204, data: undefined });
  });

  it('sets credentials and redirect on a GET', async () => {
    const { client, init } = setup(() => new Response('{"items":[],"next":null}'));
    await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(init().credentials).toBe('same-origin');
    expect(init().redirect).toBe('error');
  });

  it('sets credentials and redirect on a POST', async () => {
    const { client, init } = setup(() => new Response('{"id":"s1"}', { status: 201 }));
    await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
    });
    expect(init().credentials).toBe('same-origin');
    expect(init().redirect).toBe('error');
  });
});

describe('refused targets', () => {
  const refuse = async (template: string, params: Record<string, string> = {}) => {
    const { client, fetch } = setup();
    const result = await client.request('get', template as never, { params } as never);
    return { result, fetch };
  };

  it('refuses an absolute URL', async () => {
    const { result, fetch } = await refuse('https://evil.test/_pb/x');
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 0, code: 'refused_url' });
  });

  it('refuses a protocol-relative URL', async () => {
    const { result, fetch } = await refuse('//evil.test/_pb/x');
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'refused_url' });
  });

  it('refuses a path outside /_pb/', async () => {
    const { result, fetch } = await refuse('/other/x');
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'refused_url' });
  });

  it('refuses a param that would climb out of the path', async () => {
    const { result, fetch } = await refuse('/_pb/projects/{project}/sources', { project: '..' });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'refused_url' });
  });

  it('refuses a template whose param is missing', async () => {
    const { result, fetch } = await refuse('/_pb/projects/{project}/sources');
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'refused_url' });
  });
});

describe('typing', () => {
  it('rejects paths and methods the document does not define', () => {
    const { client } = setup();
    // @ts-expect-error the document has no such path
    void client.request('get', '/_pb/undocumented', {});
    // @ts-expect-error the path exists, but not with this method
    void client.request('put', SOURCES, { params: { project: 'p' } });
    // @ts-expect-error a documented path must be requested with its own method
    void client.request('get', SOURCE, { params: { project: 'p', source: 's' } });
    // @ts-expect-error a required path param is missing
    void client.request('get', SOURCES, { params: {} });
    // @ts-expect-error a required body is missing
    void client.request('post', SOURCES, { params: { project: 'p' } });
    // @ts-expect-error the init is required when the operation has path params
    void client.request('get', SOURCES);
    expect(true).toBe(true);
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [412, 'precondition_failed'],
    [413, 'payload_too_large'],
    [428, 'precondition_required'],
    [400, 'unsupported_package'],
    [400, 'unsupported_source_kind'],
    [404, 'package_not_found'],
    [409, 'source_paused'],
    [502, 'upstream_refused'],
    [502, 'bad_gateway'],
  ] as const)('maps %i to %s from the envelope', async (status, code) => {
    const { client } = setup(() => envelope(status, code));
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toMatchObject({ ok: false, status, code, details: [] });
  });

  it('maps an unknown code to unknown_error without echoing the body', async () => {
    const { client } = setup(() => envelope(409, 'leaky-secret-code', { message: 'secret-text' }));
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'unknown_error' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps a body that is not an envelope to unknown_error', async () => {
    const { client } = setup(() => new Response('<html>secret</html>', { status: 502 }));
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toMatchObject({ ok: false, status: 502, code: 'unknown_error', details: [] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps only well-formed validation details, at most 20', async () => {
    const details = [
      { path: '/name', code: 'too_small', location: 'body' },
      { path: '/x', code: 'not-a-code' },
      { path: 7, code: 'invalid_type' },
      ...Array.from({ length: 30 }, () => ({ path: '/y', code: 'invalid_type' })),
    ];
    const { client } = setup(() => envelope(400, 'invalid_request', { details }));
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    if (result.ok) throw new Error('unreachable');
    expect(result.details).toHaveLength(20);
    expect(result.details[0]).toEqual({ path: '/name', code: 'too_small', location: 'body' });
    expect(result.details.every((d) => d.code !== ('not-a-code' as never))).toBe(true);
  });

  it('returns reauth_required as an ordinary failure with the request description', async () => {
    const { client } = setup(() => envelope(403, 'reauth_required'));
    const result = await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
      idempotencyKey: 'key-1',
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'reauth_required' satisfies ApiErrorCode,
      details: [],
      request: {
        method: 'POST',
        path: '/_pb/projects/p/sources',
        idempotencyKey: 'key-1',
        body: { name: 'n', url: 'u' },
      },
    });
  });

  it('never throws when fetch rejects', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('redirect')));
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    const result = await client.request('get', SOURCES, { params: { project: 'p' } });
    expect(result).toMatchObject({ ok: false, status: 0, code: 'network_error' });
  });
});

describe('path confinement', () => {
  const refused = async (template: string) => {
    const { client, fetch } = setup();
    const result = await client.request('get', template as never, {} as never);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 0, code: 'refused_url' });
  };

  it('refuses a literal dot-dot segment', async () => {
    await refused('/_pb/../outside');
  });

  it('refuses an encoded dot-dot segment', async () => {
    await refused('/_pb/%2e%2e/outside');
  });

  it('refuses an upper-case encoded dot-dot segment after a valid segment', async () => {
    await refused('/_pb/projects/%2E%2E/outside');
  });

  it('refuses a literal single-dot segment', async () => {
    await refused('/_pb/./projects');
  });

  it('refuses a param that is a dot-dot segment', async () => {
    const { client, fetch } = setup();
    const result = await client.request('get', SOURCES, { params: { project: '..' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'refused_url' });
  });

  it('refuses a param with a lone surrogate and does not reject', async () => {
    const { client, fetch } = setup();
    const result = await client.request('get', SOURCES, { params: { project: '\ud800' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 0, code: 'refused_url' });
  });
});

describe('query handling', () => {
  it('serialises an array query as repeated entries', async () => {
    const { client, fetch } = setup(() => new Response('{"names":[]}', { status: 200 }));
    await client.request('get', SEARCH, {
      params: { project: 'p' },
      query: { q: 'x', kind: ['a', 'b'] },
    });
    expect(fetch.mock.calls[0]![0]).toBe('/_pb/projects/p/sources/search?q=x&kind=a&kind=b');
  });

  it('requires a documented required query param at compile time', () => {
    const { client } = setup();
    // @ts-expect-error q is required
    void client.request('get', SEARCH, { params: { project: 'p' } });
    // @ts-expect-error q is required and may not be undefined
    void client.request('get', SEARCH, { params: { project: 'p' }, query: { q: undefined } });
    // @ts-expect-error q is required even when kind is given
    void client.request('get', SEARCH, { params: { project: 'p' }, query: { kind: ['a'] } });
    void client.request('get', SEARCH, {
      params: { project: 'p' },
      query: { q: 'x', kind: undefined },
    });
    expect(true).toBe(true);
  });
});

describe('replay description', () => {
  it('keeps the query and documented headers, not the CSRF token', async () => {
    const { client } = setup(() => envelope(403, 'reauth_required'));
    const result = await client.request('delete', SOURCE, {
      params: { project: 'p', source: 's' },
      headers: { 'If-Match': '"r1"' },
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'reauth_required',
      request: {
        method: 'DELETE',
        path: '/_pb/projects/p/sources/s',
        headers: { 'If-Match': '"r1"' },
      },
    });
    if (result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.request)).not.toContain('csrf');
  });

  it('keeps the query of the original request', async () => {
    const { client } = setup(() => envelope(403, 'reauth_required'));
    const result = await client.request('get', SEARCH, {
      params: { project: 'p' },
      query: { q: 'x', kind: ['a', 'b'] },
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.request.query).toEqual({ q: 'x', kind: ['a', 'b'] });
  });
});

describe('response typing', () => {
  it('infers undefined for a no-content operation', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    const result = await client.request('delete', SOURCE, {
      params: { project: 'p', source: 's' },
      headers: { 'If-Match': '"r1"' },
    });
    expectTypeOf(result).toEqualTypeOf<ApiResult<undefined>>();
  });

  it('infers data or undefined for mixed JSON and no-content success', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    const result = await client.request('get', SEARCH, {
      params: { project: 'p' },
      query: { q: 'x' },
    });
    expectTypeOf(result).toEqualTypeOf<ApiResult<{ names: string[] } | undefined>>();
  });

  it('infers the JSON body for a JSON-only operation', async () => {
    const { client } = setup(() => new Response('{"id":"s"}', { status: 201 }));
    const result = await client.request('post', SOURCES, {
      params: { project: 'p' },
      body: { name: 'n', url: 'u' },
    });
    expectTypeOf(result).toEqualTypeOf<ApiResult<{ id: string }>>();
  });
});
