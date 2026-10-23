import type { APIResponse, BrowserContext, Route } from '@playwright/test';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { hotp } from './browser/totp.js';

const origin = 'http://127.0.0.1:41001';
const other = 'http://127.0.0.1:41002';
let fixture: {
  authCode(secret: Uint8Array, offset?: number): Promise<string>;
  guardContext(context: BrowserContext, origin: string): Promise<() => Promise<void>>;
};

beforeAll(async () => {
  vi.stubEnv('PB_UI_E2E_OTHER_ORIGIN', other);
  try {
    const path = new URL('../tests/fixture.ts', import.meta.url).pathname;
    fixture = await import(path);
  } finally {
    vi.unstubAllEnvs();
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UI setup TOTP timing', () => {
  const secret = new TextEncoder().encode('12345678901234567890');
  for (const [now, wait, counter] of [
    [325_000, 0, 9],
    [325_001, 4_999, 10],
    [329_999, 1, 10],
    [330_000, 0, 10],
  ] as const) {
    test(`previous-step setup code at ${now}ms waits ${wait}ms`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const code = fixture.authCode(secret, -1);
      expect(vi.getTimerCount()).toBe(wait === 0 ? 0 : 1);
      await vi.advanceTimersByTimeAsync(wait);
      expect(await code).toBe(await hotp(secret, counter));
      expect(Date.now()).toBe(now + wait);
      expect(await fixture.authCode(secret)).toBe(await hotp(secret, counter + 1));
    });
  }
});

function response(status: number, location?: string): APIResponse {
  return {
    status: () => status,
    headers: () => (location ? { location } : {}),
    dispose: vi.fn(async () => {}),
  } as unknown as APIResponse;
}

async function guardedRequest(
  responses: APIResponse[],
  method = 'GET',
  headers: Record<string, string> = { 'content-type': 'text/plain' },
) {
  let handler!: (route: Route) => Promise<void>;
  let next = 0;
  const fetch = vi.fn(async () => {
    const result = responses[next++];
    if (!result) throw new Error('unexpected fixture fetch');
    return result;
  });
  const context = {
    exposeBinding: async () => {},
    addInitScript: async () => {},
    on: () => {},
    route: async (_pattern: string, callback: typeof handler) => {
      handler = callback;
    },
    routeWebSocket: async () => {},
    pages: () => [],
    request: { fetch },
  } as unknown as BrowserContext;
  const route = {
    request: () => ({
      url: () => `${origin}/start`,
      method: () => method,
      allHeaders: async () => ({ ...headers }),
      postDataBuffer: () => (method === 'POST' ? Buffer.from('fixture body') : null),
    }),
    fetch,
    abort: vi.fn(async () => {}),
    fulfill: vi.fn(async () => {}),
  } as unknown as Route;
  const verify = await fixture.guardContext(context, origin);
  await handler(route);
  return { fetch, route, verify };
}

describe('UI context redirect guard', () => {
  test('keeps browser-selected authentication cookies through same-origin UI paths and hashes', async () => {
    const headers = { cookie: '__Host-pb_session=fixture-session', accept: 'text/html' };
    const responses = [
      response(303, '/'),
      response(303, '/_pb/ui'),
      response(303, '/_pb/ui/#/projects'),
      response(200),
    ];
    const { fetch, route, verify } = await guardedRequest(responses, 'GET', headers);
    expect(fetch.mock.calls).toEqual(
      ['/start', '/', '/_pb/ui', '/_pb/ui/#/projects'].map((path) => [
        `${origin}${path}`,
        expect.objectContaining({ headers, maxRedirects: 0 }),
      ]),
    );
    expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: responses[3] });
    expect(route.abort).not.toHaveBeenCalled();
    await verify();
  });

  test('does not forward browser credentials when a redirect crosses allowed origins', async () => {
    const headers = {
      cookie: '__Host-pb_session=fixture-session',
      authorization: 'Bearer fixture-authorization',
    };
    const { fetch, route, verify } = await guardedRequest(
      [response(302, `${other}/_pb/ui/#/projects`), response(200)],
      'GET',
      headers,
    );
    expect(fetch.mock.calls).toEqual([
      [`${origin}/start`, expect.objectContaining({ headers, maxRedirects: 0 })],
      [`${other}/_pb/ui/#/projects`, expect.objectContaining({ headers: {}, maxRedirects: 0 })],
    ]);
    expect(route.abort).not.toHaveBeenCalled();
    await verify();
  });

  test('blocks an external third hop even when it would return to loopback', async () => {
    const responses = [
      response(302, `${other}/middle`),
      response(307, 'https://example.invalid/return-to-loopback'),
      response(302, `${origin}/finish`),
      response(200),
    ];
    const { fetch, route, verify } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(
      responses.slice(0, 2).every((item) => vi.mocked(item.dispose).mock.calls.length === 1),
    ).toBe(true);
    await expect(verify()).rejects.toThrow(/redirect outside allowed origins/);
  });

  test('fulfills only after every hop across both allowed origins is checked', async () => {
    const responses = [
      response(302, `${other}/middle`),
      response(307, '/relative'),
      response(308, `${origin}/finish`),
      response(200),
    ];
    const { fetch, route, verify } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls).toEqual([
      [`${origin}/start`, expect.objectContaining({ maxRedirects: 0 })],
      [`${other}/middle`, expect.objectContaining({ maxRedirects: 0 })],
      [`${other}/relative`, expect.objectContaining({ maxRedirects: 0 })],
      [`${origin}/finish`, expect.objectContaining({ maxRedirects: 0 })],
    ]);
    expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: responses[3] });
    expect(route.abort).not.toHaveBeenCalled();
    for (const item of responses) expect(item.dispose).toHaveBeenCalledTimes(1);
    await verify();
  });

  for (const status of [301, 302, 303, 307, 308]) {
    test(`preserves HTTP method and body semantics for a ${status} POST redirect`, async () => {
      const { fetch, route, verify } = await guardedRequest(
        [response(status, '/finish'), response(200)],
        'POST',
      );
      const preservesBody = status === 307 || status === 308;
      expect(fetch.mock.calls).toEqual([
        [
          `${origin}/start`,
          expect.objectContaining({
            method: 'POST',
            data: Buffer.from('fixture body'),
            maxRedirects: 0,
          }),
        ],
        [
          `${origin}/finish`,
          {
            method: preservesBody ? 'POST' : 'GET',
            headers: preservesBody ? { 'content-type': 'text/plain' } : {},
            ...(preservesBody ? { data: Buffer.from('fixture body') } : {}),
            maxRedirects: 0,
          },
        ],
      ]);
      expect(route.fulfill).toHaveBeenCalledTimes(1);
      await verify();
    });
  }

  test('aborts a loopback redirect cycle without fulfilling a partial chain', async () => {
    const responses = Array.from({ length: 21 }, () => response(302, '/start'));
    const { fetch, route, verify } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    for (const item of responses) expect(item.dispose).toHaveBeenCalledTimes(1);
    await expect(verify()).rejects.toThrow(/loopback redirect limit exceeded/);
  });
});
