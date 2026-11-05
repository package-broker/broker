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
    import { LoginScreen, ReauthScreen, SetupScreen, createReauthFlow } from './auth';
    const client = createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined });
    const screen = globalThis.fixtureScreen;
    const props = { client, onSignedIn: () => {} };
    createRoot(document.getElementById('root')).render(screen === 'reauth'
      ? <ReauthScreen client={client} flow={createReauthFlow({ client, storage: sessionStorage, now: Date.now, navigate: () => {} })} onDone={() => {}} />
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
            await browserExpect(
              page.getByRole('heading', { name: "Sign in with your organization's account" }),
            ).toBeVisible();
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
      if (screen === 'setup' || screen === 'standalone')
        await browserExpect(
          page.getByRole('heading', { name: 'Setup is unavailable' }),
        ).toBeVisible();
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

for (const screen of ['login', 'reauth', 'setup', 'standalone'] as const) {
  for (const step of screen === 'setup' || screen === 'standalone'
    ? ['start', 'finish']
    : ['submit']) {
    it(`${screen} switches to disabled when ${step} reports a policy change`, async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.route('**/_pb/auth/providers', (route: BrowserRoute) =>
        route.fulfill({
          json: {
            local: true,
            providers: ['Dex', 'Okta'].map((displayName) => ({
              ...provider,
              id: displayName,
              displayName,
            })),
          },
        }),
      );
      await page.route(
        '**/_pb/auth/local/**',
        (route: BrowserRoute & { request(): { url(): string } }) => {
          if (step === 'finish' && route.request().url().endsWith('/start'))
            return route.fulfill({
              json: { provisioningUri: 'otpauth://totp/test?secret=ABC', secret: 'ABC' },
            });
          return route.fulfill({ status: 403, json: { error: { code: 'local_auth_disabled' } } });
        },
      );
      try {
        await fixture!.mount(screen === 'standalone' ? setupScript : authScript, {
          fixtureScreen: screen,
        });
        if (screen === 'setup' || screen === 'standalone') {
          await page.getByLabel('Setup token', { exact: true }).fill('T'.repeat(43));
          await page.locator('button[type="submit"]').click();
          if (step === 'finish') {
            await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
            await page
              .getByLabel('Confirm password', { exact: true })
              .fill('correct horse battery staple');
            await page
              .getByLabel(
                screen === 'standalone'
                  ? 'Six digit code from your authenticator'
                  : 'Authenticator code',
                { exact: true },
              )
              .fill('123456');
            await page.locator('button[type="submit"]').click();
          }
          await browserExpect(
            page.getByRole('heading', { name: "Sign in with your organization's account" }),
          ).toBeVisible();
          await browserExpect(page.getByText(/Password setup is unavailable/)).toBeVisible();
        } else {
          if (screen === 'login')
            await page.getByLabel('E-mail', { exact: true }).fill('a@example.test');
          await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
          await page.getByLabel('Authenticator code', { exact: true }).fill('123456');
          await page.locator('button[type="submit"]').click();
          await browserExpect(
            page.getByRole('button', {
              name: screen === 'login' ? 'Sign in with Dex' : 'Confirm with Dex',
            }),
          ).toBeVisible();
          if (screen === 'reauth') {
            const hint = page.getByText(
              'Signed in with a password? Sign out and sign in with Dex or Okta to continue.',
              { exact: true },
            );
            await browserExpect(hint).toHaveCount(1);
          }
        }
        await browserExpect(page.locator('input')).toHaveCount(0);
        await browserExpect(page.locator('body')).not.toContainText('Check your details');
        await browserExpect(page.locator('body')).not.toContainText('different address');
      } finally {
        await page.unroute('**/_pb/auth/providers');
        await page.unroute('**/_pb/auth/local/**');
      }
    });
  }
}
