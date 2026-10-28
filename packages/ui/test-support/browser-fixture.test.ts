import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { UI_CSP } from '@package-broker/core/kernel/ui-routes';
import {
  browserRequired,
  closeFixtureResources,
  createBrowserFixture,
  launchFixtureBrowser,
  startAssetServer,
  writeFixtureHeaders,
  safeRequestHeaders,
} from './browser-fixture.js';

it('rejects a missing browser in required mode and stops the server', async () => {
  const stop = vi.fn(async () => {});
  await expect(
    launchFixtureBrowser({
      required: true,
      launch: async () => {
        throw new Error("Executable doesn't exist");
      },
      stop,
    }),
  ).rejects.toThrow('UI browser launch failed');
  expect(stop).toHaveBeenCalledOnce();
});

it('stops resources on optional unavailable browsers and unexpected launch failures', async () => {
  for (const message of ["Executable doesn't exist", 'Unexpected launch error']) {
    const stop = vi.fn(async () => {});
    const launch = launchFixtureBrowser({
      required: false,
      launch: async () => {
        throw new Error(message);
      },
      stop,
    });
    if (message.startsWith('Executable')) await expect(launch).resolves.toBeUndefined();
    else await expect(launch).rejects.toThrow('UI browser launch failed');
    expect(stop).toHaveBeenCalledOnce();
  }
});

it('serves CSP assets and mocked API requests, then closes its listening socket', async (context) => {
  const api = vi.fn(async (request: Request) =>
    Response.json({ method: request.method, body: await request.json() }),
  );
  const server = await startAssetServer({
    assets: new Map([['/_pb/ui/', { body: '<div id="root"></div>', contentType: 'text/html' }]]),
    api,
  }).catch((error: NodeJS.ErrnoException) => {
    if (!browserRequired() && error.code === 'EPERM')
      context.skip('Sandbox cannot bind a local server');
    throw error;
  });
  try {
    const response = await fetch(`${server.origin}/_pb/ui/`);
    expect(response.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toContain('id="root"');
    expect(
      await (
        await fetch(`${server.origin}/_pb/mock`, {
          method: 'POST',
          body: JSON.stringify({ fixture: true }),
        })
      ).json(),
    ).toEqual({ method: 'POST', body: { fixture: true } });
    expect(api).toHaveBeenCalledOnce();
    api.mockImplementationOnce(async () => {
      throw new Error('private fixture request data');
    });
    const failed = await fetch(`${server.origin}/_pb/failure`);
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('Fixture request failed');
    expect((await fetch(`${server.origin}/missing`)).status).toBe(404);
  } finally {
    await server.close();
  }
  await expect(fetch(`${server.origin}/_pb/ui/`)).rejects.toThrow();
});

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
beforeAll(async () => {
  fixture = await createBrowserFixture({
    api: (request) => {
      switch (new URL(request.url).pathname) {
        case '/_pb/mock':
          return Response.json({ message: 'Mock response' });
        case '/_pb/auth/providers':
          return Response.json({ providers: [], local: true });
        default:
          return Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
      }
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

it('renders an external fixture script under production CSP with CSS and mocked API', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await fixture!.mount(`fetch('/_pb/mock').then(r => r.json()).then(data => {
    const heading = document.createElement('h1'); heading.textContent = data.message;
    document.getElementById('root').append(heading);
  });`);
  await browserExpect(page.getByRole('heading', { name: 'Mock response' })).toBeVisible();
  expect(
    await page
      .locator('link[rel="stylesheet"]')
      .evaluate((link: HTMLLinkElement) => Boolean(link.sheet)),
  ).toBe(true);
  await page
    .evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'globalThis.inlineExecuted = true';
      document.body.append(script);
    })
    .catch(() => {});
  expect(await page.evaluate('globalThis.inlineExecuted')).toBeUndefined();
});

it('renders the production application bundle under CSP', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const response = await fixture!.mount();
  expect(response!.headers()['content-security-policy']).toBe(UI_CSP);
  await fixture!
    .browserExpect(fixture!.page.getByRole('heading', { name: 'Sign in', exact: true }))
    .toBeVisible();
});

it('closes browser and server resources even when browser cleanup fails', async () => {
  for (const fails of [false, true]) {
    const closeBrowser = vi.fn(async () => {
      if (fails) throw new Error('Browser already stopped');
    });
    const stop = vi.fn(async () => {});
    const closing = closeFixtureResources(closeBrowser, stop);
    if (fails) await expect(closing).rejects.toThrow('Browser already stopped');
    else await closing;
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  }
});

it('copies every production UI security header and preserves separate cookies', () => {
  const writeHead = vi.fn();
  const headers = new Headers({
    'content-security-policy': UI_CSP,
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  const result = new Response(null);
  result.headers.append('set-cookie', 'first=one; Path=/');
  result.headers.append('set-cookie', 'second=two; Path=/');
  writeFixtureHeaders({ writeHead } as unknown as ServerResponse, result, headers);
  const pairs = writeHead.mock.calls[0]![1] as string[];
  for (const [name, value] of headers) {
    expect(pairs[pairs.indexOf(name) + 1]).toBe(value);
  }
  expect(pairs.filter((value) => value === 'set-cookie')).toHaveLength(2);
  expect(pairs).toContain('first=one; Path=/');
  expect(pairs).toContain('second=two; Path=/');
});

it('passes only safe request headers to mocked APIs', () => {
  const headers = safeRequestHeaders({
    accept: 'application/json',
    'content-type': 'application/json',
    'if-match': '"r4"',
    'if-none-match': '"fixture"',
    authorization: 'Bearer fixture-only',
    cookie: 'fixture-only=true',
    host: 'untrusted.example',
    connection: 'keep-alive',
    'x-forwarded-host': 'untrusted.example',
  });
  expect([...headers]).toEqual([
    ['accept', 'application/json'],
    ['content-type', 'application/json'],
    ['if-match', '"r4"'],
    ['if-none-match', '"fixture"'],
  ]);
});

it.for([
  'content-security-policy',
  'cross-origin-opener-policy',
  'x-content-type-options',
  'referrer-policy',
])('rejects a missing production header: %s', (missing) => {
  const headers = new Headers({
    'content-security-policy': UI_CSP,
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  headers.delete(missing);
  const writeHead = vi.fn();
  expect(() =>
    writeFixtureHeaders({ writeHead } as unknown as ServerResponse, new Response(null), headers),
  ).toThrow(`Missing production UI header: ${missing}`);
  expect(writeHead).not.toHaveBeenCalled();
});
