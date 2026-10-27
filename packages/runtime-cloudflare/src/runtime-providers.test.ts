import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { rebindProvider } from '@package-broker/db-sqlite/repositories/provider-binding';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker } from './index.js';
import type { Env, Worker } from './index.js';
import type { webcrypto } from 'node:crypto';

const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function segment(value: unknown): string {
  return encode(encoder.encode(JSON.stringify(value)));
}

const KID = 'runtime-key-1';

interface Signer {
  readonly privateKey: webcrypto.CryptoKey;
  readonly jwk: Record<string, unknown>;
}

let signer: Promise<Signer> | undefined;

function signingKey(): Promise<Signer> {
  signer ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as webcrypto.CryptoKeyPair;
    const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<
      string,
      unknown
    >;
    return {
      privateKey: pair.privateKey,
      jwk: { kty: 'RSA', n: exported['n'], e: exported['e'], kid: KID, alg: 'RS256', use: 'sig' },
    };
  })();
  return signer;
}

async function signIdToken(payload: Record<string, unknown>): Promise<string> {
  const { privateKey } = await signingKey();
  const input = `${segment({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${segment(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(input)),
  );
  return `${input}.${encode(signature)}`;
}

interface MockIssuer {
  readonly issuer: string;
  readonly requests: Request[];
  idToken: string | null;
  clientId: string;
  clientSecret: string;
}

function mockIssuer(
  issuer: string,
  clientId = 'broker-client',
  clientSecret = 'corp-client-secret-value',
): MockIssuer {
  return { issuer, requests: [], idToken: null, clientId, clientSecret };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function answer(mock: MockIssuer, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.slice(new URL(mock.issuer).pathname.length);
  if (path === '/.well-known/openid-configuration') {
    return json({
      issuer: mock.issuer,
      authorization_endpoint: `${mock.issuer}/auth`,
      token_endpoint: `${mock.issuer}/token`,
      jwks_uri: `${mock.issuer}/keys`,
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (path === '/keys') return json({ keys: [(await signingKey()).jwk] });
  if (path === '/token') {
    const form = (value: string): string => encodeURIComponent(value).replaceAll('%20', '+');
    const expected = `Basic ${btoa(`${form(mock.clientId)}:${form(mock.clientSecret)}`)}`;
    if (request.method !== 'POST' || request.headers.get('authorization') !== expected) {
      return json({ error: 'invalid_client' }, 401);
    }
    if (mock.idToken === null) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: 'access', token_type: 'bearer', id_token: mock.idToken });
  }
  return new Response('unexpected', { status: 404 });
}

function installIssuers(...mocks: readonly MockIssuer[]): void {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    const mock = mocks.find((candidate) => request.url.startsWith(`${candidate.issuer}/`));
    if (mock === undefined) return original(input, init);
    mock.requests.push(request.clone());
    return answer(mock, request);
  });
}

function claims(
  mock: MockIssuer,
  fields: { nonce: string; audience: string; subject: string; email: string },
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: mock.issuer,
    sub: fields.subject,
    aud: fields.audience,
    exp: now + 3600,
    iat: now - 5,
    auth_time: now - 8,
    nonce: fields.nonce,
    email: fields.email,
    email_verified: true,
    name: fields.email,
  };
}

interface SsoOidcModule {
  default: (options?: { runtimeProviders?: boolean; providers?: unknown[] }) => PluginDefinition;
}
const ssoModule = '@package-broker/plugin-sso-oidc';
const { default: ssoOidc } = (await import(ssoModule)) as SsoOidcModule;

const KEY = `pbmk_v1_${Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url')}`;
const PUBLIC_URL = 'https://broker.test';
const ADMIN_EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'corp-client-secret-value';

const bindings = Array.from({ length: 16 }, (_, index) => `RPDB${index}`);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
let sources: MigrationSource[] | undefined;

async function coreMigrations(): Promise<MigrationSource[]> {
  sources ??= await Promise.all(
    ['0001_init.sql'].map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
  return sources;
}

interface Fixture {
  readonly db: D1DatabaseLike;
  readonly orgId: string;
  readonly token: string;
}

async function fixture(): Promise<Fixture> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await coreMigrations(), { holder: 'runtime-providers-test' });
  const orgId = ulid();
  const now = new Date();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: now.toISOString(),
  });
  const token = randomBytes(32).toString('base64url');
  const roleIds = {} as Record<DefaultRoleKey, string>;
  for (const { key } of DEFAULT_ROLES) roleIds[key] = ulid();
  await bootstrapAdmin(executor, orgContext(orgId), {
    email: ADMIN_EMAIL,
    userId: ulid(),
    setupHash: createHash('sha256').update(token).digest('hex'),
    setupExpiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    grantId: ulid(),
    roleIds,
    opId: ulid(),
    now: now.toISOString(),
  });
  return { db, orgId, token };
}

function env(db: D1DatabaseLike, definitions: readonly unknown[], secrets = true): Env {
  return {
    DB: db,
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: PUBLIC_URL,
    PB_IDP_PROVIDERS: JSON.stringify(definitions),
    ...(secrets ? { PB_IDP_CORP_CLIENT_SECRET: SECRET, PB_IDP_OTHER_CLIENT_SECRET: SECRET } : {}),
  } as unknown as Env;
}

function oidc(
  issuer: string,
  overrides: Record<string, unknown> = {},
  policy: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'corp',
    kind: 'oidc',
    issuer,
    clientId: 'broker-client',
    displayName: 'Corporate SSO',
    policy: { verifiedDomains: ['example.com'], autoJoin: true, ...policy },
    ...overrides,
  };
}

interface Harness {
  readonly worker: Worker;
  readonly log: Record<string, unknown>[];
  readonly builds: () => number;
}

function harness(compiled: unknown[] = []): Harness {
  const log: Record<string, unknown>[] = [];
  const plugin = ssoOidc({ runtimeProviders: true, providers: compiled });
  let builds = 0;
  const counted: PluginDefinition = {
    ...plugin,
    identityProviders: (ctx) => {
      builds += 1;
      return plugin.identityProviders!(ctx);
    },
  };
  const worker = createWorker([counted], { log: (entry) => void log.push({ ...entry }) });
  return { worker, log, builds: () => builds };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, { headers });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...headers },
    body: JSON.stringify(body),
  });
}

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

async function providerList(
  worker: Worker,
  environment: Env,
): Promise<{ id: string; displayName: string }[]> {
  const response = await worker.fetch(get('/_pb/auth/providers'), environment);
  expect(response.status).toBe(200);
  return ((await response.json()) as { providers: { id: string; displayName: string }[] })
    .providers;
}

interface Attempt {
  readonly start: Response;
  readonly callback: Response | null;
  readonly cookie: string;
  readonly reason: string | null;
}

function lastRefusal(log: readonly Record<string, unknown>[]): string | null {
  const refused = log.filter((entry) => entry['event'] === 'auth.login.refused');
  const reason = refused[refused.length - 1]?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

async function ssoLogin(
  h: Harness,
  environment: Env,
  mock: MockIssuer,
  who: { subject: string; email: string; provider?: string },
): Promise<Attempt> {
  const provider = who.provider ?? 'corp';
  const before = h.log.length;
  const start = await h.worker.fetch(
    post(`/_pb/auth/sso/${provider}/start`, { purpose: 'login' }, { accept: 'application/json' }),
    environment,
  );
  if (start.status !== 200) {
    return { start, callback: null, cookie: '', reason: lastRefusal(h.log.slice(before)) };
  }
  const { location } = (await start.json()) as { location: string };
  const query = new URL(location).searchParams;
  mock.idToken = await signIdToken(
    claims(mock, {
      nonce: query.get('nonce') as string,
      audience: query.get('client_id') as string,
      subject: who.subject,
      email: who.email,
    }),
  );
  const cookie = cookies(start);
  const callback = await h.worker.fetch(
    get(`/_pb/auth/sso/${provider}/callback?code=the-code&state=${query.get('state') as string}`, {
      cookie,
    }),
    environment,
  );
  return {
    start,
    callback,
    cookie: cookies(callback),
    reason: lastRefusal(h.log.slice(before)),
  };
}

async function session(h: Harness, environment: Env, cookie: string): Promise<Response> {
  return h.worker.fetch(get('/_pb/session', { cookie }), environment);
}

async function anchorOf(db: D1DatabaseLike, provider: string): Promise<string | null> {
  const rows = await db
    .prepare('SELECT anchor FROM identity_provider_binding WHERE provider = ?')
    .bind(provider)
    .all();
  const anchor = (rows.results?.[0] as { anchor?: string } | undefined)?.anchor;
  return anchor ?? null;
}

const ISSUER = 'https://idp-a.example.test/dex';
const OTHER_ISSUER = 'https://idp-b.example.test/dex';

describe('runtime SSO providers on Miniflare D1', () => {
  it('lists an env-only provider and completes a login that binds the anchor', async () => {
    const { db } = await fixture();
    const mock = mockIssuer(ISSUER);
    installIssuers(mock);
    const h = harness();
    const environment = env(db, [oidc(ISSUER)]);

    const providers = await providerList(h.worker, environment);
    expect(providers).toEqual([
      expect.objectContaining({ id: 'corp', kind: 'oidc', displayName: 'Corporate SSO' }),
    ]);
    expect(mock.requests).toHaveLength(0);

    const attempt = await ssoLogin(h, environment, mock, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });

    expect(attempt.callback?.status).toBe(303);
    expect(attempt.reason).toBeNull();
    expect((await session(h, environment, attempt.cookie)).status).toBe(200);
    expect(await anchorOf(db, 'corp')).toBe(`oidc:${ISSUER}`);
  });

  it('applies changed clientId, displayName and verifiedDomains without a rebuild step', async () => {
    const { db } = await fixture();
    const mock = mockIssuer(ISSUER);
    installIssuers(mock);
    const h = harness();
    const first = env(db, [oidc(ISSUER, {}, { verifiedDomains: ['example.com', 'removed.test'] })]);

    const ada = await ssoLogin(h, first, mock, { subject: 'sub-ada', email: 'ada@example.com' });
    expect(ada.callback?.status).toBe(303);
    const startedWith = (await ssoStartClient(h, first)) ?? '';
    expect(startedWith).toBe('broker-client');
    const bob = await ssoLogin(h, first, mock, { subject: 'sub-bob', email: 'bob@removed.test' });
    expect(bob.callback?.status).toBe(303);

    const second = env(db, [
      oidc(ISSUER, { clientId: 'renamed-client', displayName: 'Renamed SSO' }),
    ]);
    const providers = await providerList(h.worker, second);
    expect(providers.map((provider) => provider.displayName)).toEqual(['Renamed SSO']);
    expect(await ssoStartClient(h, second)).toBe('renamed-client');

    mock.clientId = 'renamed-client';
    const bobAgain = await ssoLogin(h, second, mock, {
      subject: 'sub-bob',
      email: 'bob@removed.test',
    });
    expect(bobAgain.callback?.status).toBe(401);
    expect(bobAgain.reason).toBe('domain_not_verified');
    const carol = await ssoLogin(h, second, mock, {
      subject: 'sub-carol',
      email: 'carol@removed.test',
    });
    expect(carol.callback?.status).toBe(401);
    expect(carol.reason).toBe('domain_not_verified');
    const dave = await ssoLogin(h, second, mock, {
      subject: 'sub-dave',
      email: 'dave@example.com',
    });
    expect(dave.callback?.status).toBe(303);
  });

  it('refuses a changed issuer before any IdP contact, then logs in after rebindProvider', async () => {
    const { db, orgId } = await fixture();
    const mock = mockIssuer(ISSUER);
    const moved = mockIssuer(OTHER_ISSUER);
    installIssuers(mock, moved);
    const h = harness();
    const authoritative = { emailAuthoritativeDomains: ['example.com'] };
    const environment = env(db, [oidc(ISSUER, {}, authoritative)]);
    const ada = await ssoLogin(h, environment, mock, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });
    expect(ada.callback?.status).toBe(303);
    expect(await anchorOf(db, 'corp')).toBe(`oidc:${ISSUER}`);
    const contacted = mock.requests.length;

    const rebound = env(db, [oidc(OTHER_ISSUER, {}, authoritative)]);
    expect(await providerList(h.worker, rebound)).toHaveLength(1);
    const refused = await ssoLogin(h, rebound, moved, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });
    expect(refused.start.status).toBe(401);
    expect(refused.reason).toBe('provider_rebound');
    expect(moved.requests).toHaveLength(0);
    expect(mock.requests).toHaveLength(contacted);

    const result = await rebindProvider(
      createD1Executor(db),
      orgContext(orgId),
      'corp',
      `oidc:${ISSUER}`,
      `oidc:${OTHER_ISSUER}`,
      new Date().toISOString(),
    );
    expect(result.swapped).toBe(true);
    expect(await anchorOf(db, 'corp')).toBe(`oidc:${OTHER_ISSUER}`);

    const after = await ssoLogin(h, rebound, moved, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });
    expect(after.reason).toBeNull();
    expect(after.callback?.status).toBe(303);
    expect(moved.requests.length).toBeGreaterThan(0);
  });

  it('keeps the good provider and local login working next to an invalid entry', async () => {
    const { db, token } = await fixture();
    const mock = mockIssuer(ISSUER);
    installIssuers(mock);
    const h = harness();
    const environment = env(db, [
      { id: 'broken', kind: 'oidc', issuer: 'http://not-https.example.test' },
      oidc(ISSUER),
    ]);

    expect((await providerList(h.worker, environment)).map((provider) => provider.id)).toEqual([
      'corp',
    ]);
    const attempt = await ssoLogin(h, environment, mock, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });
    expect(attempt.callback?.status).toBe(303);

    const started = await h.worker.fetch(
      post('/_pb/auth/local/setup/start', { token }),
      environment,
    );
    expect(started.status).toBe(200);
    const { secret } = (await started.json()) as { secret: string };
    const key = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);
    const finished = await h.worker.fetch(
      post('/_pb/auth/local/setup/finish', {
        token,
        password: PASSWORD,
        code: await totpCode(key, step),
      }),
      environment,
    );
    expect(finished.status).toBe(204);
    const loggedIn = await h.worker.fetch(
      post('/_pb/auth/local/login', {
        email: ADMIN_EMAIL,
        password: PASSWORD,
        code: await totpCode(key, step + 1),
      }),
      environment,
    );
    expect(loggedIn.status).toBe(204);
    expect((await session(h, environment, cookies(loggedIn))).status).toBe(200);
  });

  it('prefers the env version of a compiled id and drops the id when the env entry is invalid', async () => {
    const { db } = await fixture();
    const compiledIssuer = mockIssuer(ISSUER);
    const envIssuer = mockIssuer(OTHER_ISSUER);
    installIssuers(compiledIssuer, envIssuer);
    const h = harness([oidc(ISSUER, { displayName: 'Compiled SSO' })]);

    const compiledOnly = env(db, []);
    expect((await providerList(h.worker, compiledOnly)).map((p) => p.displayName)).toEqual([
      'Compiled SSO',
    ]);

    const overridden = env(db, [oidc(OTHER_ISSUER, { displayName: 'Env SSO' })]);
    expect(await providerList(h.worker, overridden)).toEqual([
      expect.objectContaining({ id: 'corp', displayName: 'Env SSO' }),
    ]);
    const attempt = await ssoLogin(h, overridden, envIssuer, {
      subject: 'sub-ada',
      email: 'ada@example.com',
    });
    expect(attempt.callback?.status).toBe(303);
    expect(await anchorOf(db, 'corp')).toBe(`oidc:${OTHER_ISSUER}`);
    expect(compiledIssuer.requests).toHaveLength(0);

    const invalid = env(db, [oidc(OTHER_ISSUER, { issuer: 'http://not-https.example.test' })]);
    expect(await providerList(h.worker, invalid)).toEqual([]);
    const refused = await h.worker.fetch(
      post('/_pb/auth/sso/corp/start', { purpose: 'login' }, { accept: 'application/json' }),
      invalid,
    );
    expect(refused.status).toBe(404);
  });

  it('rebuilds for a fresh env object with a changed value and ignores mutation of the same object', async () => {
    const { db } = await fixture();
    installIssuers(mockIssuer(ISSUER));
    const h = harness();
    const first = env(db, [oidc(ISSUER)]);

    expect((await providerList(h.worker, first))[0]?.displayName).toBe('Corporate SSO');
    expect(h.builds()).toBe(1);

    const same = env(db, [oidc(ISSUER)]);
    expect((await providerList(h.worker, same))[0]?.displayName).toBe('Corporate SSO');
    expect(h.builds()).toBe(1);

    const changed = env(db, [oidc(ISSUER, { displayName: 'Changed SSO' })]);
    expect((await providerList(h.worker, changed))[0]?.displayName).toBe('Changed SSO');
    expect(h.builds()).toBe(2);

    (changed as unknown as Record<string, string>)['PB_IDP_PROVIDERS'] = JSON.stringify([
      oidc(ISSUER, { displayName: 'Mutated SSO' }),
    ]);
    expect((await providerList(h.worker, changed))[0]?.displayName).toBe('Changed SSO');
    expect(h.builds()).toBe(2);

    const fresh = { ...changed };
    expect((await providerList(h.worker, fresh))[0]?.displayName).toBe('Mutated SSO');
    expect(h.builds()).toBe(3);
  });
});

async function ssoStartClient(h: Harness, environment: Env): Promise<string | null> {
  const start = await h.worker.fetch(
    post('/_pb/auth/sso/corp/start', { purpose: 'login' }, { accept: 'application/json' }),
    environment,
  );
  if (start.status !== 200) return null;
  const { location } = (await start.json()) as { location: string };
  return new URL(location).searchParams.get('client_id');
}
