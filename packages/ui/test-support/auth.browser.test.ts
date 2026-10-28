import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let authScript: string;
let setupScript: string;
let posts = 0;
type BrowserRoute = { fulfill(options: { status?: number; json: unknown }): Promise<void> };

beforeAll(async () => {
  const bundle = async (contents: string) => {
    const result = await build({
      stdin: {
        contents,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    return result.outputFiles[0]!.text;
  };
  authScript = await bundle(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { createApiClient } from './api';
    import { LoginScreen, ReauthScreen, SetupScreen } from './auth';
    const client = createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined });
    const screen = globalThis.fixtureScreen;
    const props = { client, onSignedIn: () => {} };
    createRoot(document.getElementById('root')).render(screen === 'reauth'
      ? <ReauthScreen client={client} flow={{}} onDone={() => {}} />
      : screen === 'setup' ? <SetupScreen {...props} /> : <LoginScreen {...props} />);
  `);
  setupScript = await bundle("import './setup';");
  fixture = await createBrowserFixture({
    api: (request) => {
      if (request.method === 'POST') posts++;
      return Response.json({ providers: [], local: true });
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

const provider = { id: 'corp', displayName: 'Company', kind: 'oidc', supportsReauth: true };

describe('sign-in and setup availability in the browser', () => {
  for (const screen of ['login', 'reauth', 'setup', 'standalone'] as const) {
    it(`${screen} waits for availability, hides disabled forms and retains enabled forms`, async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      for (const local of [false, true]) {
        posts = 0;
        let release!: () => Promise<void>;
        await page.route('**/_pb/auth/providers', async (route: BrowserRoute) => {
          await new Promise<void>((resolve) => {
            release = async () => {
              await route.fulfill({ json: { local, providers: [provider] } });
              resolve();
            };
          });
        });
        await fixture!.mount(screen === 'standalone' ? setupScript : authScript, {
          fixtureScreen: screen,
        });
        await browserExpect(page.getByText(/(?:Loading|Checking) sign-in options/)).toBeVisible();
        await browserExpect(page.locator('input')).toHaveCount(0);
        await expect.poll(() => typeof release).toBe('function');
        await release();
        if (local) {
          await browserExpect(
            page.getByLabel(
              screen === 'login' || screen === 'reauth' ? 'Password' : 'Setup token',
              { exact: true },
            ),
          ).toBeVisible();
        } else {
          if (screen === 'login' || screen === 'reauth') {
            await browserExpect(
              page.getByRole('button', {
                name: screen === 'login' ? 'Sign in with Company' : 'Confirm with Company',
              }),
            ).toBeVisible();
            await browserExpect(
              page.getByText('Contact your administrator for help signing in.'),
            ).toHaveCount(0);
          } else {
            await browserExpect(page.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
              'href',
              '/_pb/ui/#/login',
            );
            await browserExpect(page.getByText(/Password setup is unavailable/)).toBeVisible();
          }
          await browserExpect(page.locator('input')).toHaveCount(0);
        }
        expect(posts).toBe(0);
        await page.unroute('**/_pb/auth/providers');
      }
    });

    it(`${screen} fails closed on provider errors`, async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.route('**/_pb/auth/providers', (route: BrowserRoute) =>
        route.fulfill({
          status: 503,
          json: { error: { code: 'unavailable', message: 'private-request-data' } },
        }),
      );
      await fixture!.mount(screen === 'standalone' ? setupScript : authScript, {
        fixtureScreen: screen,
      });
      await browserExpect(
        page.getByText('Sign-in options could not be loaded. Reload the page to try again.'),
      ).toBeVisible();
      await browserExpect(page.locator('input')).toHaveCount(0);
      await browserExpect(page.locator('body')).not.toContainText('private-request-data');
      await page.unroute('**/_pb/auth/providers');
    });
  }

  it('login shows plain administrator help when no provider is listed', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await page.route('**/_pb/auth/providers', (route: BrowserRoute) =>
      route.fulfill({ json: { local: false, providers: [] } }),
    );
    await fixture!.mount(authScript, { fixtureScreen: 'login' });
    await browserExpect(
      page.getByText('Contact your administrator for help signing in.'),
    ).toBeVisible();
    await browserExpect(page.locator('input, button')).toHaveCount(0);
    await page.unroute('**/_pb/auth/providers');
  });
});
