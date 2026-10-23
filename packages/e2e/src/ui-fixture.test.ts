import { afterEach, describe, expect, test, vi } from 'vitest';
import { hotp } from './browser/totp.js';
import {
  authCode,
  forwardRequest,
  type ForwardOptions,
  type RedirectResponse,
} from './browser/ui-fixture.js';

const origin = 'http://127.0.0.1:41001';
const other = 'http://127.0.0.1:41002';

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
      const code = authCode(secret, -1);
      expect(vi.getTimerCount()).toBe(wait === 0 ? 0 : 1);
      await vi.advanceTimersByTimeAsync(wait);
      expect(await code).toBe(await hotp(secret, counter));
      expect(Date.now()).toBe(now + wait);
      expect(await authCode(secret)).toBe(await hotp(secret, counter + 1));
    });
  }
});

function response(status: number, location?: string): RedirectResponse {
  return {
    status: () => status,
    headers: () => (location ? { location } : {}),
    dispose: vi.fn(async () => {}),
  };
}

async function guardedRequest(
  responses: RedirectResponse[],
  method = 'GET',
  headers: Record<string, string> = { 'content-type': 'text/plain' },
) {
  let next = 0;
  const fetch = vi.fn<(url: string, options: ForwardOptions) => Promise<RedirectResponse>>(
    async () => {
      const result = responses[next++];
      if (!result) throw new Error('unexpected fixture fetch');
      return result;
    },
  );
  const fulfill = vi.fn<(response: RedirectResponse) => Promise<void>>(async () => {});
  const failure = await forwardRequest(
    {
      url: `${origin}/start`,
      method,
      headers,
      data: method === 'POST' ? Buffer.from('fixture body') : null,
    },
    [origin, other],
    fetch,
    fulfill,
  );
  return { fetch, fulfill, failure };
}

describe('UI redirect forwarding', () => {
  test('keeps browser-selected authentication cookies through same-origin UI paths and hashes', async () => {
    const headers = { cookie: '__Host-pb_session=fixture-session', accept: 'text/html' };
    const responses = [
      response(303, '/'),
      response(303, '/_pb/ui'),
      response(303, '/_pb/ui/#/projects'),
      response(200),
    ];
    const { fetch, fulfill, failure } = await guardedRequest(responses, 'GET', headers);
    expect(fetch.mock.calls).toEqual(
      ['/start', '/', '/_pb/ui', '/_pb/ui/#/projects'].map((path) => [
        `${origin}${path}`,
        expect.objectContaining({ headers, maxRedirects: 0 }),
      ]),
    );
    expect(fulfill).toHaveBeenCalledExactlyOnceWith(responses[3]);
    expect(failure).toBeUndefined();
  });

  test('does not forward browser credentials when a redirect crosses allowed origins', async () => {
    const headers = {
      cookie: '__Host-pb_session=fixture-session',
      authorization: 'Bearer fixture-authorization',
    };
    const { fetch, failure } = await guardedRequest(
      [response(302, `${other}/_pb/ui/#/projects`), response(200)],
      'GET',
      headers,
    );
    expect(fetch.mock.calls).toEqual([
      [`${origin}/start`, expect.objectContaining({ headers, maxRedirects: 0 })],
      [`${other}/_pb/ui/#/projects`, expect.objectContaining({ headers: {}, maxRedirects: 0 })],
    ]);
    expect(failure).toBeUndefined();
  });

  test('blocks an external third hop even when it would return to loopback', async () => {
    const responses = [
      response(302, `${other}/middle`),
      response(307, 'https://example.invalid/return-to-loopback'),
      response(302, `${origin}/finish`),
      response(200),
    ];
    const { fetch, fulfill, failure } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fulfill).not.toHaveBeenCalled();
    expect(
      responses.slice(0, 2).every((item) => vi.mocked(item.dispose).mock.calls.length === 1),
    ).toBe(true);
    expect(failure).toBe('redirect outside allowed origins');
  });

  test('fulfills only after every hop across both allowed origins is checked', async () => {
    const responses = [
      response(302, `${other}/middle`),
      response(307, '/relative'),
      response(308, `${origin}/finish`),
      response(200),
    ];
    const { fetch, fulfill, failure } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls).toEqual([
      [`${origin}/start`, expect.objectContaining({ maxRedirects: 0 })],
      [`${other}/middle`, expect.objectContaining({ maxRedirects: 0 })],
      [`${other}/relative`, expect.objectContaining({ maxRedirects: 0 })],
      [`${origin}/finish`, expect.objectContaining({ maxRedirects: 0 })],
    ]);
    expect(fulfill).toHaveBeenCalledExactlyOnceWith(responses[3]);
    expect(failure).toBeUndefined();
    for (const item of responses) expect(item.dispose).toHaveBeenCalledTimes(1);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    test(`preserves HTTP method and body semantics for a ${status} POST redirect`, async () => {
      const { fetch, fulfill, failure } = await guardedRequest(
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
      expect(fulfill).toHaveBeenCalledTimes(1);
      expect(failure).toBeUndefined();
    });
  }

  test('aborts a loopback redirect cycle without fulfilling a partial chain', async () => {
    const responses = Array.from({ length: 21 }, () => response(302, '/start'));
    const { fetch, fulfill, failure } = await guardedRequest(responses);
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(fulfill).not.toHaveBeenCalled();
    for (const item of responses) expect(item.dispose).toHaveBeenCalledTimes(1);
    expect(failure).toBe('loopback redirect limit exceeded');
  });
});
