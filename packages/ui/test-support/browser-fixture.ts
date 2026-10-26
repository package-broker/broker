import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createUiRoutes } from '@package-broker/core/kernel/ui-routes';
import { prepareBrowserAssets } from './build-assets.js';
import type { RequestContext } from '@package-broker/core/plugin';

export const browserRequired = () => process.env.PB_UI_BROWSER_REQUIRED === '1';

export async function loadPlaywright() {
  const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
  const loaded = await import(require.resolve('@playwright/test'));
  return loaded.default ?? loaded;
}

async function productionHeaders() {
  const route = createUiRoutes(
    { manifest: async () => null, read: async () => null },
    { publicOrigin: 'http://localhost' },
  )[0]!;
  const response = await route.handler({
    request: new Request('http://localhost/_pb/ui'),
    requestId: 'fixture',
  } as RequestContext);
  return response.headers;
}

export function safeRequestHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'if-none-match']) {
    const value = input[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

export function writeFixtureHeaders(
  response: ServerResponse,
  result: Response,
  production: Headers,
) {
  const headers = new Headers(result.headers);
  for (const name of [
    'content-security-policy',
    'cross-origin-opener-policy',
    'x-content-type-options',
    'referrer-policy',
  ]) {
    const value = production.get(name);
    assert(value !== null, `Missing production UI header: ${name}`);
    headers.set(name, value);
  }
  headers.set('cache-control', 'no-store');
  const pairs: string[] = [];
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') pairs.push(name, value);
  }
  for (const cookie of headers.getSetCookie()) pairs.push('set-cookie', cookie);
  response.writeHead(result.status, pairs);
}

export async function startAssetServer(options: {
  assets: ReadonlyMap<string, { body: string | Uint8Array; contentType: string }>;
  api?: (request: Request) => Response | Promise<Response>;
}) {
  const headers = await productionHeaders();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const asset = options.assets.get(url.pathname);
      let result: Response;
      if (asset) {
        result = new Response(asset.body as BodyInit, {
          headers: { 'content-type': asset.contentType },
        });
      } else if (options.api && url.pathname.startsWith('/_pb/')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        result = await options.api(
          new Request(url, {
            method: request.method ?? 'GET',
            headers: safeRequestHeaders(request.headers),
            ...(body.length ? { body } : {}),
          }),
        );
      } else result = new Response(null, { status: 404 });
      writeFixtureHeaders(response, result, headers);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      writeFixtureHeaders(response, new Response(null, { status: 500 }), headers);
      response.end('Fixture request failed');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function launchFixtureBrowser<T>(options: {
  required: boolean;
  launch: () => Promise<T>;
  stop: () => Promise<void>;
}) {
  try {
    return await options.launch();
  } catch (error) {
    await options.stop();
    if (
      !options.required &&
      /bootstrap_check_in.*Permission denied|Executable doesn't exist/.test(String(error))
    )
      return undefined;
    throw new Error(
      'UI browser launch failed; install Chromium with the existing Playwright runner',
      {
        cause: error,
      },
    );
  }
}

export async function closeFixtureResources(
  closeBrowser: () => Promise<void>,
  stop: () => Promise<void>,
) {
  try {
    await closeBrowser();
  } finally {
    await stop();
  }
}

export async function createBrowserFixture(
  options: {
    required?: boolean;
    api?: (request: Request) => Response | Promise<Response>;
  } = {},
) {
  let server: Awaited<ReturnType<typeof startAssetServer>> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= server?.close() ?? Promise.resolve());
  try {
    const { chromium, expect: browserExpect } = await loadPlaywright();
    const launched = await launchFixtureBrowser({
      required: options.required === true || browserRequired(),
      launch: async () => ({ browser: await chromium.launch() }),
      stop,
    });
    if (!launched) return undefined;
    const { browser } = launched;
    try {
      const { inject } = await import('vitest');
      const workspace = inject('uiBrowserAssets');
      if (!workspace) throw new Error('UI browser assets were not prepared');
      await prepareBrowserAssets(workspace);
      const scratch = join(workspace, 'assets');
      const manifest = JSON.parse(await readFile(join(scratch, 'manifest.json'), 'utf8')) as {
        files: Record<string, { contentType: string }>;
      };
      const assets = new Map<string, { body: string | Uint8Array; contentType: string }>();
      for (const [name, { contentType }] of Object.entries(manifest.files)) {
        assets.set(`/_pb/ui/${name}`, { body: await readFile(join(scratch, name)), contentType });
      }
      const html = await readFile(join(scratch, 'index.html'), 'utf8');
      assets.set('/_pb/ui/', { body: html, contentType: 'text/html' });

      server = await startAssetServer({ assets, ...(options.api ? { api: options.api } : {}) });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // Prevent accidental live requests: every response comes from this fixture.
      await page.route(
        '**/*',
        (route: {
          request(): { url(): string };
          continue(): Promise<void>;
          abort(): Promise<void>;
        }) =>
          new URL(route.request().url()).origin === server!.origin
            ? route.continue()
            : route.abort(),
      );
      return {
        page,
        browserExpect,
        origin: server.origin,
        async mount(script?: string, globals: Record<string, unknown> = {}) {
          assets.set('/_pb/ui/fixture.js', {
            body: `Object.assign(globalThis, ${JSON.stringify(globals)});\n${script ?? ''}`,
            contentType: 'text/javascript',
          });
          assets.set('/_pb/ui/fixture.html', {
            body: html.replace(/src="[^"]+\.js"/, 'src="fixture.js"'),
            contentType: 'text/html',
          });
          return page.goto(`${server!.origin}/_pb/ui/${script ? 'fixture.html' : ''}`);
        },
        async close() {
          await closeFixtureResources(() => browser.close(), stop);
        },
      };
    } catch (error) {
      await closeFixtureResources(() => browser.close(), stop);
      throw error;
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
