import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, freePort, startNodeFixture, type Fixture } from '../src/browser/fixtures.js';

const CLIENT_ID = 'broker-client';
const CLIENT_SECRET = `secret-${randomBytes(12).toString('base64url')}`;
const KID = 'e2e-key-1';
const SUBJECT = 'e2e-admin-subject';

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

interface MockIdp {
  readonly issuer: string;
  readonly authorizations: () => number;
  close(): Promise<void>;
}

async function startMockIdp(): Promise<MockIdp> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };
  const issued = new Map<string, string>();
  let authorizations = 0;

  const sign = (claims: Record<string, unknown>): string => {
    const input = `${b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(createSign('RSA-SHA256').update(input).sign(privateKey))}`;
  };
  const reply = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      reply(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        code_challenge_methods_supported: ['S256'],
      });
    } else if (url.pathname === '/keys') {
      reply(response, 200, { keys: [jwk] });
    } else if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const nonce = url.searchParams.get('nonce');
      if (redirect === null || state === null || nonce === null) {
        reply(response, 400, { error: 'invalid_request' });
        return;
      }
      authorizations += 1;
      const code = randomBytes(16).toString('base64url');
      issued.set(code, nonce);
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      response.writeHead(302, { location: back.href });
      response.end();
    } else if (url.pathname === '/token' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
        const code = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('code') ?? '';
        const nonce = issued.get(code);
        if (request.headers.authorization !== expected || nonce === undefined) {
          reply(response, 401, { error: 'invalid_client' });
          return;
        }
        issued.delete(code);
        const now = Math.floor(Date.now() / 1000);
        reply(response, 200, {
          access_token: 'at',
          token_type: 'bearer',
          id_token: sign({
            iss: issuer,
            sub: SUBJECT,
            aud: CLIENT_ID,
            exp: now + 3600,
            iat: now - 5,
            auth_time: now - 8,
            nonce,
            email: ADMIN_EMAIL,
            email_verified: true,
            name: 'E2E Administrator',
          }),
        });
      });
    } else {
      reply(response, 404, { error: 'not_found' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    issuer,
    authorizations: () => authorizations,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

test.describe.serial('SSO-only sign-in with local authentication disabled on node', () => {
  let idp: MockIdp;
  let fixture: Fixture;

  test.beforeAll(async () => {
    idp = await startMockIdp();
    fixture = await startNodeFixture({
      ssoAdmin: true,
      env: {
        PB_AUTH_LOCAL: 'disabled',
        PB_IDP_PROVIDERS: JSON.stringify([
          {
            id: 'corp',
            kind: 'oidc',
            displayName: 'Corp SSO',
            issuer: idp.issuer,
            clientId: CLIENT_ID,
            policy: {
              verifiedDomains: ['e2e.example.test'],
              emailAuthoritativeDomains: ['e2e.example.test'],
              autoJoin: false,
            },
          },
        ]),
        PB_IDP_CORP_CLIENT_SECRET: CLIENT_SECRET,
      },
    });
  });

  test.afterAll(async () => {
    await fixture.stop();
    await idp.close();
  });

  test('hides the password form, signs in through SSO and creates a project', async ({
    browser,
  }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/_pb/ui/#/login`);
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      const sso = page.getByRole('button', { name: 'Sign in with Corp SSO', exact: true });
      await expect(sso).toBeVisible();
      await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Authenticator code', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);

      await sso.click();
      await expect.poll(() => idp.authorizations()).toBe(1);
      await expect
        .poll(async () => (await context.cookies()).some((c) => c.name === '__Host-pb_session'))
        .toBe(true);
      await page.goto(`${fixture.origin}/_pb/ui/#/projects`);
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

      await page.getByText('New project', { exact: true }).click();
      await page.getByLabel('Project name', { exact: true }).fill('SSO only project');
      await page.getByLabel('Project slug', { exact: true }).fill('sso-only-project');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(page.getByRole('link', { name: 'SSO only project', exact: true })).toBeVisible();

      const refused = await page.evaluate(async () => {
        const response = await fetch('/_pb/auth/local/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return { status: response.status, body: (await response.json()) as unknown };
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: 'local_auth_disabled' } });
    } finally {
      await context.close();
    }
  });
});
