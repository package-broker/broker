import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createApiClient, responseHeader } from './api.js';
import type { paths } from './api-types.js';

describe('response headers', () => {
  it('uses the last GET ETag verbatim as If-Match on the next mutation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"revision":7}', { headers: { ETag: '"revision-7"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    const result = await client.request('get', '/_pb/projects/{project}', {
      params: { project: 'acme' },
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { revision: 7 },
      headers: { etag: '"revision-7"' },
    });
    const etag = responseHeader(result, 'etag');
    expectTypeOf(etag).toEqualTypeOf<string | undefined>();
    if (etag === undefined) throw new Error('missing ETag');
    await client.request('patch', '/_pb/projects/{project}', {
      params: { project: 'acme' },
      headers: { 'If-Match': etag },
      body: { name: 'Renamed' },
    });
    expect(fetch.mock.calls[1]?.[1].headers['If-Match']).toBe('"revision-7"');
  });

  it.each([201, 204])('exposes ETag and Location on a %s success', async (status) => {
    const client = createApiClient<paths>({
      fetch: async () =>
        new Response(status === 204 ? null : '{"id":"new"}', {
          status,
          headers: { ETag: 'W/"revision-8"', Location: '/_pb/projects/new', 'X-Other': 'ignored' },
        }),
      readCookie: () => undefined,
    });
    const result = await client.request('post', '/_pb/projects', {
      body: { name: 'New', slug: 'new' },
    });
    expect(result.ok).toBe(true);
    expect(responseHeader(result, 'etag')).toBe('W/"revision-8"');
    expect(responseHeader(result, 'location')).toBe('/_pb/projects/new');
    if (result.ok) {
      expect(result.headers).toEqual({ etag: 'W/"revision-8"', location: '/_pb/projects/new' });
      if (status === 204) expect(result.data).toBeUndefined();
    }
    // @ts-expect-error only the headers used by pages are exposed
    expect(responseHeader(result, 'set-cookie')).toBeUndefined();
  });

  it('returns undefined for absent response headers', async () => {
    const client = createApiClient<paths>({
      fetch: async () => new Response('{"items":[]}'),
      readCookie: () => undefined,
    });
    const result = await client.request('get', '/_pb/projects');
    expect(responseHeader(result, 'etag')).toBeUndefined();
    expect(responseHeader(result, 'location')).toBeUndefined();
  });

  it.each([
    [304, null, 'unknown_error'],
    [412, '{"error":{"code":"precondition_failed"}}', 'precondition_failed'],
    [200, 'invalid json', 'unknown_error'],
  ] as const)(
    'keeps a %s failure unchanged even with response headers',
    async (status, body, code) => {
      const client = createApiClient<paths>({
        fetch: async () =>
          new Response(body, {
            status,
            headers: { ETag: '"unused"', Location: '/unused' },
          }),
        readCookie: () => undefined,
      });
      const result = await client.request('get', '/_pb/projects');
      expect(result).toEqual({
        ok: false,
        status,
        code,
        details: [],
        request: { method: 'GET', path: '/_pb/projects' },
      });
      expect(responseHeader(result, 'etag')).toBeUndefined();
      expect(responseHeader(result, 'location')).toBeUndefined();
    },
  );
});
