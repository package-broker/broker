import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { freePort, startFixture, type Fixture, type RuntimeName } from '../src/browser/fixtures.js';
import { base32Decode, msUntilStep, parseOtpauth, stepAt, totp } from '../src/browser/totp.js';

const RUNTIMES: readonly RuntimeName[] = (process.env['PB_E2E_RUNTIMES'] ?? 'node,workers')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is RuntimeName => name === 'node' || name === 'workers');

interface CanvasPixels {
  readonly width: number;
  readonly height: number;
  readonly data: number[];
}

async function fillCredential(page: Page, label: string, value: string, exact = false) {
  try {
    await page.getByLabel(label, { exact }).fill(value);
  } catch {
    // Playwright's fill failure call log includes the value supplied to the input.
    throw new Error('credential input could not be filled');
  }
}

async function decodeQr(page: Page): Promise<string> {
  const pixels = await page.evaluate((): CanvasPixels => {
    const canvas = document.getElementById('setup-qr');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no QR canvas');
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas context');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: image.width, height: image.height, data: Array.from(image.data) };
  });
  const found = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height, {
    inversionAttempts: 'dontInvert',
  });
  if (found === null) throw new Error('jsQR found no QR code in the canvas');
  return found.data;
}

function otherOrigin(): Promise<{ origin: string; close(): Promise<void> }> {
  return freePort().then(
    (port) =>
      new Promise((resolve, reject) => {
        const server = http.createServer((_, response) => {
          response.setHeader('content-type', 'text/html');
          response.end('<!doctype html><title>other origin</title>');
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          resolve({
            origin: `http://127.0.0.1:${port}`,
            close: () =>
              new Promise<void>((done) => {
                server.close(() => {
                  done();
                });
              }),
          });
        });
      }),
  );
}

interface PageReply {
  readonly status: number;
  readonly body: unknown;
}

async function inPage(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown; csrf?: boolean } = {},
): Promise<PageReply> {
  return page.evaluate(
    async ({ target, method, body, csrf }) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf) {
        const match = /(?:^|; )__Host-pb_csrf=([^;]+)/.exec(document.cookie);
        if (match?.[1] !== undefined) headers['x-csrf-token'] = match[1];
      }
      const response = await fetch(target, {
        method,
        headers,
        credentials: 'same-origin',
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed: unknown = await response.json().catch(() => null);
      return { status: response.status, body: parsed };
    },
    { target: path, method: init.method ?? 'GET', body: init.body, csrf: init.csrf ?? false },
  );
}

for (const runtime of RUNTIMES) {
  test.describe.serial(`first admin setup on ${runtime}`, () => {
    let fixture: Fixture;
    const password = `pw-${randomBytes(18).toString('base64url')}`;
    const attackerPassword = `pw-${randomBytes(18).toString('base64url')}`;

    test.beforeAll(async () => {
      fixture = await startFixture(runtime);
    });

    test.afterAll(async () => {
      await fixture.stop();
    });

    const json = (body: unknown, extra: Record<string, string> = {}) => ({
      headers: { 'content-type': 'application/json', origin: fixture.origin, ...extra },
      data: JSON.stringify(body),
    });

    test('serves a public setup shell while the ordinary UI stays behind a session', async ({
      playwright,
    }) => {
      const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
      try {
        for (const path of [
          '/_pb/ui/',
          '/_pb/ui',
          '/_pb/ui/manifest.json',
          '/_pb/ui/setup.html',
          '/_pb/session',
        ]) {
          const response = await anonymous.get(`${fixture.origin}${path}`, { maxRedirects: 0 });
          expect(response.status(), path).toBe(401);
        }
        const shell = await anonymous.get(`${fixture.origin}/_pb/ui/setup`);
        expect(shell.status()).toBe(200);
        expect(shell.headers()['cache-control']).toBe('no-store');
        expect(shell.headers()['referrer-policy']).toBe('no-referrer');
        expect(shell.headers()['content-security-policy']).toContain("script-src 'self'");
        expect(shell.headers()['set-cookie'] === undefined, 'setup shell sets no cookie').toBe(
          true,
        );
        const html = await shell.text();
        const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
        expect(references).toHaveLength(2);
        for (const reference of references) {
          expect(reference).toMatch(/^\/_pb\/ui\/setup\/assets\/[A-Za-z0-9._-]+$/);
          expect((await anonymous.get(`${fixture.origin}${reference}`)).status(), reference).toBe(
            200,
          );
        }
        for (const path of [
          '/_pb/ui/setup/assets/index.html',
          '/_pb/ui/setup/assets/setup.html',
          '/_pb/ui/setup/assets/manifest.json',
          '/_pb/ui/setup/assets/',
          '/_pb/ui/setup/assets/..%2Fmanifest.json',
          '/_pb/ui/setup/document',
        ]) {
          expect((await anonymous.get(`${fixture.origin}${path}`)).status(), path).toBe(404);
        }
      } finally {
        await anonymous.dispose();
      }
    });

    test('refuses cross-origin and malformed setup requests without using up the token', async ({
      browser,
      playwright,
    }) => {
      const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
      const other = await otherOrigin();
      try {
        const start = `${fixture.origin}/_pb/auth/local/setup/start`;
        const body = { token: fixture.token };
        const foreign = await anonymous.post(start, json(body, { origin: other.origin }));
        expect(foreign.status()).toBe(403);
        const crossSite = await anonymous.post(
          start,
          json(body, { 'sec-fetch-site': 'cross-site' }),
        );
        expect(crossSite.status()).toBe(403);
        const noOrigin = await anonymous.post(start, {
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify(body),
        });
        expect(noOrigin.status()).toBe(403);
        const finish = `${fixture.origin}/_pb/auth/local/setup/finish`;
        const foreignFinish = await anonymous.post(
          finish,
          json(
            { token: fixture.token, password: attackerPassword, code: '000000' },
            {
              origin: other.origin,
            },
          ),
        );
        expect(foreignFinish.status()).toBe(403);
        const notJson = await anonymous.post(start, {
          headers: { 'content-type': 'text/plain', origin: fixture.origin },
          data: JSON.stringify(body),
        });
        expect(notJson.status()).toBe(400);
        const wrongToken = await anonymous.post(start, json({ token: 'x'.repeat(43) }));
        expect(wrongToken.status()).toBe(401);

        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        try {
          const page = await context.newPage();
          await page.goto(other.origin);
          const outcome = await page.evaluate(
            async ({ target, token }) => {
              try {
                const response = await fetch(target, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ token }),
                  credentials: 'include',
                });
                return `status ${response.status}`;
              } catch {
                return 'blocked';
              }
            },
            { target: start, token: fixture.token },
          );
          expect(outcome).toBe('blocked');
        } finally {
          await context.close();
        }
      } finally {
        await other.close();
        await anonymous.dispose();
      }
    });

    test('enrolls through the QR code, finishes setup, signs out and back in, and refuses token reuse', async ({
      browser,
      playwright,
    }) => {
      const anonymous = await playwright.request.newContext({ ignoreHTTPSErrors: true });
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const violations: string[] = [];
      const foreignRequests: string[] = [];
      const loaded: { path: string; status: number }[] = [];
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === fixture.origin) {
          await route.continue();
          return;
        }
        foreignRequests.push(url.origin);
        await route.abort();
      });
      await context.addInitScript(() => {
        const sink: string[] = [];
        (window as unknown as { __csp: string[] }).__csp = sink;
        window.addEventListener('securitypolicyviolation', (event) => {
          sink.push(event.violatedDirective);
        });
      });
      const page = await context.newPage();
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === fixture.origin) {
          loaded.push({ path: url.pathname + url.search, status: response.status() });
        }
      });
      page.on('pageerror', (error) => {
        violations.push(`pageerror: ${error.name}`);
      });
      page.on('console', (message) => {
        if (/content security policy|trusted type/i.test(message.text())) {
          violations.push('console: csp');
        }
      });
      try {
        await page.goto(`${fixture.origin}/_pb/ui/setup`);
        await expect(
          page.getByRole('heading', { name: 'Set up the administrator account' }),
        ).toBeFocused();
        expect(page.url() === `${fixture.origin}/_pb/ui/setup`, 'credential-free setup URL').toBe(
          true,
        );
        const subresources = loaded.filter(
          (entry) => !entry.path.startsWith('/_pb/ui/setup') || entry.path === '/_pb/ui/setup',
        );
        expect(subresources.map((entry) => entry.status)).toEqual([200]);
        const assetResponses = loaded.filter((entry) =>
          entry.path.startsWith('/_pb/ui/setup/assets/'),
        );
        expect(assetResponses).toHaveLength(2);
        expect(assetResponses.every((entry) => entry.status === 200)).toBe(true);

        await fillCredential(page, 'Setup token', fixture.token);
        const started = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/_pb/auth/local/setup/start',
        );
        await page.getByLabel('Setup token').press('Enter');
        const startBody = (await (await started).json().catch(() => {
          throw new Error('setup start response is not valid JSON');
        })) as {
          provisioningUri: string;
          secret: string;
        };
        await expect(page.locator('#setup-qr')).toBeVisible();

        const payload = await decodeQr(page);
        expect(payload === startBody.provisioningUri, 'QR matches the setup response').toBe(true);
        let parsed: ReturnType<typeof parseOtpauth>;
        try {
          parsed = parseOtpauth(payload);
        } catch {
          throw new Error('QR contains an invalid TOTP URI');
        }
        expect(parsed.type).toBe('totp');
        expect(
          parsed.label === `Package Broker:${fixture.email}`,
          'QR uses the expected account label',
        ).toBe(true);
        expect(
          Object.keys(parsed.parameters).length === 5 &&
            parsed.parameters['secret'] === startBody.secret &&
            parsed.parameters['issuer'] === 'Package Broker' &&
            parsed.parameters['algorithm'] === 'SHA1' &&
            parsed.parameters['digits'] === '6' &&
            parsed.parameters['period'] === '30',
          'QR uses the expected TOTP parameters',
        ).toBe(true);
        expect(
          payload ===
            `otpauth://totp/Package%20Broker:${encodeURIComponent(fixture.email)}` +
              `?secret=${startBody.secret}&issuer=Package%20Broker&algorithm=SHA1&digits=6&period=30`,
          'QR uses the exact expected provisioning URI',
        ).toBe(true);
        const manualSecret = (await page.locator('#setup-secret').textContent()) ?? '';
        expect(manualSecret === parsed.parameters['secret'], 'manual key matches the QR key').toBe(
          true,
        );
        const secret = base32Decode(manualSecret);
        expect(secret.length === 20, 'TOTP key contains twenty bytes').toBe(true);
        expect(await page.locator('#setup-qr').boundingBox()).toMatchObject({
          width: expect.any(Number),
        });

        await fillCredential(page, 'Password', password, true);
        await fillCredential(page, 'Confirm password', password);
        const enrollmentTime = Date.now();
        const usedStep = stepAt(enrollmentTime);
        await fillCredential(
          page,
          'Six digit code from your authenticator',
          await totp(secret, enrollmentTime),
        );
        await page.getByLabel('Six digit code from your authenticator').press('Enter');
        await expect(page.getByRole('heading', { name: 'Setup complete' })).toBeVisible();

        expect(page.url() === `${fixture.origin}/_pb/ui/setup`, 'credential-free setup URL').toBe(
          true,
        );
        const stored = await page.evaluate(() => ({
          local: window.localStorage.length,
          session: window.sessionStorage.length,
          cookie: document.cookie,
          text: document.documentElement.outerHTML,
        }));
        expect(stored.local).toBe(0);
        expect(stored.session).toBe(0);
        expect(!/pb_session/.test(stored.cookie), 'session cookie is hidden from the page').toBe(
          true,
        );
        for (const sensitive of [fixture.token, password, manualSecret, 'otpauth']) {
          expect(!stored.text.includes(sensitive), 'completed page clears setup credentials').toBe(
            true,
          );
        }
        expect(await page.locator('#setup-qr').count()).toBe(0);

        const cookies = await context.cookies();
        const sessionCookie = cookies.find((entry) => entry.name === '__Host-pb_session');
        expect(sessionCookie?.httpOnly === true, 'session cookie is HttpOnly').toBe(true);
        expect(
          cookies.some((entry) => entry.name === '__Host-pb_csrf'),
          'CSRF cookie is present',
        ).toBe(true);
        const session = await inPage(page, '/_pb/session');
        expect(session.status).toBe(200);
        expect(
          (session.body as { user: { email: string } }).user.email === fixture.email,
          'session belongs to the expected account',
        ).toBe(true);

        await page.getByRole('button', { name: 'Open Package Broker' }).click();
        await page.waitForURL(`${fixture.origin}/_pb/ui/`);
        await expect(page.getByRole('heading', { name: 'Package Broker' })).toBeVisible();
        await page.goBack();
        await expect
          .poll(async () => (await page.getByLabel('Setup token').inputValue()) === '', {
            message: 'back navigation clears the setup token',
          })
          .toBe(true);
        expect(
          !(await page.content()).includes(manualSecret),
          'back navigation clears the manual key',
        ).toBe(true);

        expect((await inPage(page, '/_pb/ui/')).status).toBe(200);
        const loggedOut = await inPage(page, '/_pb/auth/logout', { method: 'POST', csrf: true });
        expect(loggedOut.status).toBe(204);
        expect((await inPage(page, '/_pb/session')).status).toBe(401);
        expect((await inPage(page, '/_pb/ui/')).status).toBe(401);

        const next = usedStep + 1;
        await page.waitForTimeout(msUntilStep(next, Date.now()) + 250);
        const freshCode = await totp(secret, Date.now());
        expect(stepAt(Date.now())).toBeGreaterThanOrEqual(next);
        const crossOriginLogin = await anonymous.post(
          `${fixture.origin}/_pb/auth/local/login`,
          json(
            { email: fixture.email, password, code: freshCode },
            { origin: 'http://127.0.0.1:1' },
          ),
        );
        expect(crossOriginLogin.status()).toBe(403);
        const login = await inPage(page, '/_pb/auth/local/login', {
          method: 'POST',
          body: { email: fixture.email, password, code: freshCode },
        });
        expect(login.status).toBe(204);
        expect((await inPage(page, '/_pb/session')).status).toBe(200);

        const loginStep = stepAt(Date.now());
        const nextCode = await totp(secret, (loginStep + 1) * 30_000);
        const reusedStart = await inPage(page, '/_pb/auth/local/setup/start', {
          method: 'POST',
          body: { token: fixture.token },
        });
        expect(reusedStart.status).toBe(401);
        const reusedFinish = await inPage(page, '/_pb/auth/local/setup/finish', {
          method: 'POST',
          body: { token: fixture.token, password: attackerPassword, code: nextCode },
        });
        expect(reusedFinish.status).toBe(401);

        await inPage(page, '/_pb/auth/logout', { method: 'POST', csrf: true });
        const attacker = await inPage(page, '/_pb/auth/local/login', {
          method: 'POST',
          body: { email: fixture.email, password: attackerPassword, code: nextCode },
        });
        expect(attacker.status).toBe(401);
        const original = await inPage(page, '/_pb/auth/local/login', {
          method: 'POST',
          body: { email: fixture.email, password, code: nextCode },
        });
        expect(original.status).toBe(204);
        expect((await inPage(page, '/_pb/session')).status).toBe(200);

        expect(violations.length === 0, 'no page errors or CSP violations').toBe(true);
        expect(foreignRequests.length === 0, 'no foreign requests').toBe(true);
        expect(
          await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp.length === 0),
          'no CSP violations after navigation',
        ).toBe(true);
      } finally {
        await context.close();
        await anonymous.dispose();
      }
    });
  });
}
