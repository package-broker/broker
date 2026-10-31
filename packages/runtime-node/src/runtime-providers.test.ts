import { createHash, randomBytes, type webcrypto } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode } from '@package-broker/core/auth/primitives';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import {
  bootstrapAdmin,
  bootstrapSsoAdmin,
} from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { rebindProvider } from '@package-broker/db-sqlite/repositories/provider-binding';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeBroker } from './index.js';
import { startNode } from './startup.js';

interface SsoOidcOptions {
  readonly providers?: readonly unknown[];
  readonly runtimeProviders?: boolean;
}

const OIDC_MODULE = '@package-broker/plugin-sso-oidc/oidc';
const oidcModule = (await import(OIDC_MODULE)) as {
  createOidcProvider: (...args: unknown[]) => unknown;
};
const PLUGIN_PACKAGE = '@package-broker/plugin-sso-oidc';
const { default: ssoOidc } = (await import(PLUGIN_PACKAGE)) as {
  default: (options?: SsoOidcOptions) => PluginDefinition;
};

const KEY = `pbmk_v1_${Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url')}`;
const PUBLIC = 'http://127.0.0.1';
const KID = 'runtime-key-1';
const SECRET = 'runtime-client-secret-5c2e';
const PASSWORD = 'correct horse battery staple 42';
const ADMIN_EMAIL = 'admin@example.test';
const encoder = new TextEncoder();

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

interface KeyPair {
  readonly publicKey: webcrypto.CryptoKey;
  readonly privateKey: webcrypto.CryptoKey;
}

let signer: KeyPair;
let jwk: Record<string, unknown>;

beforeAll(async () => {
  signer = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as KeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', signer.publicKey)) as Record<
    string,
    unknown
  >;
  jwk = { kty: 'RSA', n: exported['n'], e: exported['e'], kid: KID, alg: 'RS256', use: 'sig' };
});

function segment(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)));
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const input = `${segment({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${segment(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.privateKey, encoder.encode(input)),
  );
  return `${input}.${base64urlEncode(signature)}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class MockIdp {
  readonly requests: string[] = [];
  idToken = '';
  expectedClientId = '';

  constructor(readonly issuer: string) {}

  get origin(): string {
    return new URL(this.issuer).origin;
  }

  async mint(claims: {
    readonly clientId: string;
    readonly nonce: string;
    readonly subject: string;
    readonly email: string;
    readonly groups?: readonly string[];
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.idToken = await signToken({
      iss: this.issuer,
      sub: claims.subject,
      aud: claims.clientId,
      exp: now + 3600,
      iat: now - 5,
      auth_time: now - 8,
      nonce: claims.nonce,
      email: claims.email,
      email_verified: true,
      ...(claims.groups === undefined ? {} : { groups: claims.groups }),
      name: 'Ada Lovelace',
    });
  }

  handle(request: Request): Response {
    this.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/openid-configuration') {
      return jsonResponse({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/keys`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path === '/token') {
      const expected = `Basic ${btoa(`${this.expectedClientId}:${SECRET}`)}`;
      if (request.method !== 'POST' || request.headers.get('authorization') !== expected) {
        return new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonResponse({ access_token: 'at', token_type: 'bearer', id_token: this.idToken });
    }
    if (path === '/keys') return jsonResponse({ keys: [jwk] });
    return new Response('unexpected', { status: 404 });
  }
}

const idps = new Map<string, MockIdp>();
const stray: string[] = [];

function idp(issuer: string): MockIdp {
  const mock = new MockIdp(issuer);
  idps.set(mock.origin, mock);
  return mock;
}

function cookieHeader(responses: readonly Response[]): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] as string;
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

interface RuntimeDefinition {
  readonly id: string;
  readonly kind: 'oidc';
  readonly displayName?: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly policy: {
    readonly verifiedDomains: readonly string[];
    readonly autoJoin: boolean;
    readonly emailAuthoritativeDomains?: readonly string[];
  };
}

function definition(issuer: string, overrides: Partial<RuntimeDefinition> = {}): RuntimeDefinition {
  return {
    id: 'corp',
    kind: 'oidc',
    displayName: 'Corp SSO',
    issuer,
    clientId: 'broker-client',
    policy: { verifiedDomains: ['example.test'], autoJoin: true },
    ...overrides,
  };
}

function secretVariable(id: string): string {
  return `PB_IDP_${id.toUpperCase().replaceAll('-', '_')}_CLIENT_SECRET`;
}

describe('runtime SSO providers on the node runtime', () => {
  let directory: string;
  let path: string;
  let running: NodeBroker[];
  let logs: Array<Record<string, unknown>>;
  let warnings: string[];
  const issuerA = 'https://idp-a.example.test';
  const issuerB = 'https://idp-b.example.test';
  let idpA: MockIdp;
  let idpB: MockIdp;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-runtime-providers-'));
    path = join(directory, 'broker.sqlite');
    running = [];
    logs = [];
    warnings = [];
    idps.clear();
    stray.length = 0;
    idpA = idp(issuerA);
    idpB = idp(issuerB);
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const target = idps.get(new URL(request.url).origin);
      if (target === undefined) {
        stray.push(request.url);
        return Promise.resolve(new Response('unreachable', { status: 599 }));
      }
      return Promise.resolve(target.handle(request));
    });
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  function environment(
    definitions: unknown,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      PB_SQLITE_PATH: path,
      PB_ORG_SLUG: 'acme',
      PB_ORG_NAME: 'Acme',
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: PUBLIC,
      PB_IDP_PROVIDERS: typeof definitions === 'string' ? definitions : JSON.stringify(definitions),
      [secretVariable('corp')]: SECRET,
      [secretVariable('beta')]: SECRET,
      ...overrides,
    };
  }

  async function boot(
    env: Readonly<Record<string, string | undefined>>,
    compiled: SsoOidcOptions = { runtimeProviders: true },
  ): Promise<{ broker: NodeBroker; kernel: Kernel }> {
    const plugins: PluginDefinition[] = [ssoOidc(compiled)];
    const broker = await startNode({
      plugins,
      migrations: await migrationSources(),
      env,
      log: (entry) => {
        logs.push(entry as Record<string, unknown>);
      },
    });
    running.push(broker);
    return { broker, kernel: await broker.ready() };
  }

  async function stop(broker: NodeBroker): Promise<void> {
    running.splice(running.indexOf(broker), 1);
    await broker.close();
  }

  function call(
    kernel: Kernel,
    method: string,
    route: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return kernel.fetch(
      new Request(`${PUBLIC}${route}`, {
        method,
        headers: {
          origin: PUBLIC,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  }

  interface Providers {
    readonly providers: ReadonlyArray<{ id: string; displayName: string; kind: string }>;
    readonly local: boolean;
  }

  async function providerList(kernel: Kernel): Promise<Providers> {
    const response = await call(kernel, 'GET', '/_pb/auth/providers');
    expect(response.status).toBe(200);
    return (await response.json()) as Providers;
  }

  interface Started {
    readonly response: Response;
    readonly cookie: string;
    readonly state: string;
    readonly nonce: string;
    readonly clientId: string;
  }

  async function startLogin(kernel: Kernel, id: string): Promise<Started> {
    const response = await call(kernel, 'POST', `/_pb/auth/sso/${id}/start`, {
      body: { purpose: 'login' },
    });
    expect(response.status).toBe(200);
    const { location } = (await response.json()) as { location: string };
    const params = new URL(location).searchParams;
    return {
      response,
      cookie: cookieHeader([response]),
      state: params.get('state') as string,
      nonce: params.get('nonce') as string,
      clientId: params.get('client_id') as string,
    };
  }

  function callback(
    kernel: Kernel,
    id: string,
    started: Pick<Started, 'cookie' | 'state'>,
  ): Promise<Response> {
    return call(
      kernel,
      'GET',
      `/_pb/auth/sso/${id}/callback?code=the-code&state=${encodeURIComponent(started.state)}`,
      { cookie: started.cookie },
    );
  }

  async function login(
    kernel: Kernel,
    mock: MockIdp,
    options: {
      id?: string;
      email: string;
      subject: string;
      clientId?: string;
      groups?: readonly string[];
    },
  ): Promise<Response> {
    const id = options.id ?? 'corp';
    const started = await startLogin(kernel, id);
    mock.expectedClientId = started.clientId;
    await mock.mint({
      clientId: options.clientId ?? started.clientId,
      nonce: started.nonce,
      subject: options.subject,
      email: options.email,
      ...(options.groups === undefined ? {} : { groups: options.groups }),
    });
    return callback(kernel, id, started);
  }

  async function expectSession(kernel: Kernel, response: Response, email: string): Promise<void> {
    expect(response.status).toBe(303);
    const cookie = cookieHeader([response]);
    expect(cookie).toContain('__Host-pb_session=');
    const session = await call(kernel, 'GET', '/_pb/session', { cookie });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { user: { email: string } };
    expect(body.user.email).toBe(email);
  }

  function refusals(): Array<Record<string, unknown>> {
    return logs.filter((entry) => entry['event'] === 'auth.login.refused');
  }

  async function database<T>(
    run: (executor: ReturnType<typeof openBetterSqliteExecutor>['executor']) => Promise<T>,
  ): Promise<T> {
    const opened = openBetterSqliteExecutor(path);
    try {
      return await run(opened.executor);
    } finally {
      await opened.close();
    }
  }

  async function bindings(): Promise<Array<{ provider: string; anchor: string }>> {
    return database((executor) =>
      executor.all<{ provider: string; anchor: string }>({
        sql: 'SELECT provider, anchor FROM identity_provider_binding ORDER BY provider',
        params: [],
      }),
    );
  }

  async function seedAdmin(): Promise<string> {
    return database(async (executor) => {
      const org = await createOrganizationBootstrap(executor).findSingleton();
      if (org === null) throw new Error('organization missing');
      const token = randomBytes(32).toString('base64url');
      const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
        DefaultRoleKey,
        string
      >;
      const now = new Date();
      await bootstrapAdmin(executor, orgContext(org.id), {
        email: ADMIN_EMAIL,
        userId: ulid(),
        setupHash: createHash('sha256').update(token).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds,
        opId: ulid(),
        now: now.toISOString(),
      });
      return token;
    });
  }

  it.each(['email', 'group'] as const)(
    'a fresh disabled deployment bootstraps an SSO %s administrator and permits an admin action',
    async (subjectType) => {
      const email = 'admin@corp.example';
      const { kernel } = await boot(
        environment(
          [
            definition(issuerA, {
              policy: {
                verifiedDomains: ['corp.example'],
                emailAuthoritativeDomains: ['corp.example'],
                autoJoin: false,
              },
            }),
          ],
          { PB_AUTH_LOCAL: 'disabled' },
        ),
      );
      await database(async (executor) => {
        const org = await createOrganizationBootstrap(executor).findSingleton();
        if (org === null) throw new Error('organization missing');
        const roleIds = Object.fromEntries(
          DEFAULT_ROLES.map((role) => [role.key, ulid()]),
        ) as Record<DefaultRoleKey, string>;
        const common = { grantId: ulid(), roleIds, now: new Date().toISOString() };
        await bootstrapSsoAdmin(
          executor,
          orgContext(org.id),
          subjectType === 'email'
            ? { ...common, subject: { type: 'email', value: email }, userId: ulid() }
            : { ...common, subject: { type: 'group', provider: 'corp', value: 'broker-admins' } },
        );
        expect(
          await executor.all({
            sql: 'SELECT user_id FROM local_login WHERE org_id = ?',
            params: [org.id],
          }),
        ).toEqual([]);
      });
      expect((await providerList(kernel)).local).toBe(false);
      expect((await call(kernel, 'GET', '/_pb/projects')).status).toBe(401);
      const uninvited = await login(kernel, idpA, {
        email: 'uninvited@corp.example',
        subject: 'uninvited',
        groups: [],
      });
      expect(uninvited.status).toBe(401);
      const response = await login(kernel, idpA, {
        email,
        subject: 'admin',
        groups: subjectType === 'group' ? ['broker-admins'] : [],
      });
      await expectSession(kernel, response, email);
      const cookie = cookieHeader([response]);
      const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1];
      expect(csrf).toBeTruthy();
      const created = await call(kernel, 'POST', '/_pb/projects', {
        cookie,
        headers: { 'x-csrf-token': csrf!, 'idempotency-key': ulid() },
        body: { name: 'SSO project', slug: 'sso-project' },
      });
      expect(created.status).toBe(201);
      const listed = await call(kernel, 'GET', '/_pb/projects', { cookie });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        items: [expect.objectContaining({ slug: 'sso-project' })],
      });
    },
  );

  it('disabling local sign-in retains local and SSO sessions, local PATs and service tokens', async () => {
    const values = environment([
      definition(issuerA, { policy: { verifiedDomains: ['corp.example'], autoJoin: true } }),
    ]);
    const first = await boot(values);
    const token = await seedAdmin();
    const started = await call(first.kernel, 'POST', '/_pb/auth/local/setup/start', {
      body: { token },
    });
    expect(started.status).toBe(200);
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);
    const finished = await call(first.kernel, 'POST', '/_pb/auth/local/setup/finish', {
      body: { token, password: PASSWORD, code: await totpCode(totpSecret, step - 1) },
    });
    expect(finished.status).toBe(204);
    const local = await call(first.kernel, 'POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await totpCode(totpSecret, step) },
    });
    expect(local.status).toBe(204);
    const cookie = cookieHeader([local]);
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1];
    expect(csrf).toBeTruthy();
    const reauth = await call(first.kernel, 'POST', '/_pb/auth/local/reauth', {
      cookie,
      headers: { 'x-csrf-token': csrf! },
      body: { password: PASSWORD, code: await totpCode(totpSecret, step + 1) },
    });
    expect(reauth.status).toBe(204);
    const issue = (route: string, body: unknown) =>
      call(first.kernel, 'POST', route, {
        cookie,
        headers: { 'x-csrf-token': csrf!, 'idempotency-key': ulid() },
        body,
      });
    const pat = await issue('/_pb/me/tokens', {
      name: 'local-admin',
      scope: 'full',
      projectMode: 'all',
      projectIds: [],
    });
    expect(pat.status).toBe(201);
    const patBody = (await pat.json()) as { token: string };
    const principal = await issue('/_pb/service-principals', {
      name: 'automation',
      permissions: ['org:read'],
    });
    expect(principal.status).toBe(201);
    const { id } = (await principal.json()) as { id: string };
    const service = await issue('/_pb/tokens', {
      servicePrincipalId: id,
      name: 'automation',
      scope: 'full',
    });
    expect(service.status).toBe(201);
    const serviceBody = (await service.json()) as { token: string };
    const sso = await login(first.kernel, idpA, {
      email: 'member@corp.example',
      subject: 'member',
    });
    await expectSession(first.kernel, sso, 'member@corp.example');
    const ssoCookie = cookieHeader([sso]);
    const tokens = [patBody.token, serviceBody.token];
    for (const bearer of tokens) {
      const response = await call(first.kernel, 'GET', '/_pb/organization', {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ slug: 'acme' });
    }
    await stop(first.broker);
    const second = await boot({ ...values, PB_AUTH_LOCAL: 'disabled' });
    expect((await providerList(second.kernel)).local).toBe(false);
    for (const retained of [cookie, ssoCookie]) {
      expect((await call(second.kernel, 'GET', '/_pb/session', { cookie: retained })).status).toBe(
        200,
      );
      expect((await call(second.kernel, 'GET', '/_pb/projects', { cookie: retained })).status).toBe(
        200,
      );
    }
    for (const bearer of tokens) {
      const response = await call(second.kernel, 'GET', '/_pb/organization', {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ slug: 'acme' });
    }
    expect((await call(second.kernel, 'GET', '/_pb/organization')).status).toBe(401);
    const refused = await call(second.kernel, 'POST', '/_pb/auth/local/reauth', {
      cookie,
      headers: { 'x-csrf-token': csrf! },
      body: { password: PASSWORD, code: await totpCode(totpSecret, step + 2) },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'local_auth_disabled' } });
    const loginRefused = await call(second.kernel, 'POST', '/_pb/auth/local/login', { body: {} });
    expect(loginRefused.status).toBe(403);
    expect(await loginRefused.json()).toMatchObject({ error: { code: 'local_auth_disabled' } });
  });

  it.each(['runtime', 'compiled'] as const)(
    'disabled local auth accepts a constructed %s provider and keeps SSO login working',
    async (source) => {
      const configured = definition(issuerA);
      const { kernel } = await boot(
        environment(source === 'runtime' ? [configured] : undefined, {
          PB_AUTH_LOCAL: 'disabled',
        }),
        source === 'runtime' ? { runtimeProviders: true } : { providers: [configured] },
      );
      expect(await providerList(kernel)).toEqual({
        local: false,
        providers: [{ id: 'corp', displayName: 'Corp SSO', kind: 'oidc', supportsReauth: true }],
      });
      const refused = await call(kernel, 'POST', '/_pb/auth/local/login', { body: {} });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'local_auth_disabled' } });
      await expectSession(
        kernel,
        await login(kernel, idpA, { email: 'ada@example.test', subject: 'sub-ada' }),
        'ada@example.test',
      );
    },
  );

  it.each(['empty', 'rejected', 'construction-failed', 'suppressed-compiled'] as const)(
    'disabled local auth rejects an empty constructed map (%s)',
    async (scenario) => {
      const configured = definition(issuerA);
      if (scenario === 'construction-failed') {
        vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
          throw new Error(SECRET);
        });
      }
      const definitions =
        scenario === 'empty'
          ? []
          : scenario === 'construction-failed'
            ? [configured]
            : [{ ...configured, issuer: 'http://insecure.example.test' }];
      await expect(
        boot(
          environment(definitions, {
            PB_AUTH_LOCAL: 'disabled',
          }),
          scenario === 'suppressed-compiled'
            ? { runtimeProviders: true, providers: [configured] }
            : { runtimeProviders: true },
        ),
      ).rejects.toMatchObject({ problems: ['auth_no_sign_in_method'] });
      if (scenario === 'construction-failed') {
        expect(warnings.join('\n')).toContain('construction_failed');
        expect(warnings.join('\n')).not.toContain(SECRET);
      }
      expect(idpA.requests).toEqual([]);
      expect(JSON.stringify(logs)).not.toContain(SECRET);
    },
  );

  it('local policy is captured at start, not read again while the kernel is built', async () => {
    const live = environment([definition(issuerA)], { PB_AUTH_LOCAL: 'disabled' });
    const flip: PluginDefinition = {
      id: 'flip',
      package: '@test/flip',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
      register: () => {
        live['PB_AUTH_LOCAL'] = 'enabled';
      },
    };
    const broker = await startNode({
      plugins: [ssoOidc({ runtimeProviders: true }), flip],
      migrations: await migrationSources(),
      env: live,
      log: (entry) => {
        logs.push(entry as Record<string, unknown>);
      },
    });
    running.push(broker);
    expect(live['PB_AUTH_LOCAL']).toBe('enabled');
    expect((await providerList(await broker.ready())).local).toBe(false);
    await stop(broker);
    expect((await providerList((await boot(live)).kernel)).local).toBe(true);
  });

  it('1: a provider defined only in PB_IDP_PROVIDERS is listed and completes a login that binds its anchor', async () => {
    const { kernel } = await boot(environment([definition(issuerA)]));

    const listed = await providerList(kernel);
    expect(listed.providers).toEqual([
      expect.objectContaining({ id: 'corp', kind: 'oidc', displayName: 'Corp SSO' }),
    ]);
    expect(await bindings()).toEqual([]);

    const response = await login(kernel, idpA, { email: 'ada@example.test', subject: 'sub-ada' });
    await expectSession(kernel, response, 'ada@example.test');
    expect(await bindings()).toEqual([{ provider: 'corp', anchor: `oidc:${issuerA}` }]);
    expect(idpA.requests).toEqual([
      'GET /.well-known/openid-configuration',
      'POST /token',
      'GET /keys',
    ]);
    expect(stray).toEqual([]);
  });

  it('2: changed clientId, displayName and verifiedDomains take effect on the next start without a rebuild', async () => {
    const original = definition(issuerA, {
      policy: { verifiedDomains: ['example.test', 'other.test'], autoJoin: true },
    });
    const first = await boot(environment([original]));
    const entered = await login(first.kernel, idpA, {
      email: 'ada@other.test',
      subject: 'sub-ada',
    });
    await expectSession(first.kernel, entered, 'ada@other.test');
    expect((await providerList(first.kernel)).providers[0]?.displayName).toBe('Corp SSO');
    await stop(first.broker);

    const changed = definition(issuerA, {
      displayName: 'Renamed SSO',
      clientId: 'rotated-client',
      policy: { verifiedDomains: ['example.test'], autoJoin: true },
    });
    const second = await boot(environment([changed]));
    expect((await providerList(second.kernel)).providers[0]?.displayName).toBe('Renamed SSO');

    const started = await startLogin(second.kernel, 'corp');
    expect(started.clientId).toBe('rotated-client');

    idpA.expectedClientId = started.clientId;
    await idpA.mint({
      clientId: 'broker-client',
      nonce: started.nonce,
      subject: 'sub-linus',
      email: 'linus@example.test',
    });
    const stale = await callback(second.kernel, 'corp', started);
    expect(stale.status).toBe(401);
    expect(refusals().at(-1)).toMatchObject({ provider: 'corp', reason: 'invalid_token' });
    expect(idpA.requests).toContain('POST /token');

    const removed = await login(second.kernel, idpA, {
      email: 'ada@other.test',
      subject: 'sub-ada',
    });
    expect(removed.status).toBe(401);
    expect(removed.headers.getSetCookie().join('\n')).not.toContain('__Host-pb_session=v');
    expect(refusals().at(-1)).toMatchObject({ provider: 'corp', reason: 'domain_not_verified' });

    const kept = await login(second.kernel, idpA, {
      email: 'grace@example.test',
      subject: 'sub-grace',
    });
    await expectSession(second.kernel, kept, 'grace@example.test');
  });

  it('3: a changed issuer is refused before the IdP is contacted, and rebindProvider reopens login', async () => {
    const first = await boot(environment([definition(issuerA)]));
    const pending = await startLogin(first.kernel, 'corp');
    const entered = await login(first.kernel, idpA, {
      email: 'ada@example.test',
      subject: 'sub-ada',
    });
    await expectSession(first.kernel, entered, 'ada@example.test');
    expect(await bindings()).toEqual([{ provider: 'corp', anchor: `oidc:${issuerA}` }]);
    await stop(first.broker);

    idpA.requests.length = 0;
    idpB.requests.length = 0;
    const second = await boot(environment([definition(issuerB)]));

    const start = await call(second.kernel, 'POST', '/_pb/auth/sso/corp/start', {
      body: { purpose: 'login' },
    });
    expect(start.status).toBe(401);
    expect(refusals().at(-1)).toMatchObject({ provider: 'corp', reason: 'provider_rebound' });

    await idpB.mint({
      clientId: 'broker-client',
      nonce: pending.nonce,
      subject: 'sub-ada',
      email: 'ada@example.test',
    });
    const replay = await callback(second.kernel, 'corp', pending);
    expect(replay.status).toBe(401);
    expect(refusals().at(-1)).toMatchObject({ provider: 'corp', reason: 'provider_rebound' });

    expect(idpB.requests).toEqual([]);
    expect(idpA.requests).toEqual([]);
    expect(stray).toEqual([]);
    expect(await bindings()).toEqual([{ provider: 'corp', anchor: `oidc:${issuerA}` }]);

    const swap = await database(async (executor) => {
      const org = await createOrganizationBootstrap(executor).findSingleton();
      return rebindProvider(
        executor,
        orgContext(org!.id),
        'corp',
        `oidc:${issuerA}`,
        `oidc:${issuerB}`,
        new Date().toISOString(),
      );
    });
    expect(swap.swapped).toBe(true);

    const reopened = await login(second.kernel, idpB, {
      email: 'grace@example.test',
      subject: 'sub-grace-b',
    });
    await expectSession(second.kernel, reopened, 'grace@example.test');
    expect(await bindings()).toEqual([{ provider: 'corp', anchor: `oidc:${issuerB}` }]);
    expect(idpB.requests).toContain('POST /token');
    expect(idpA.requests).toEqual([]);
  });

  it('4: one invalid entry leaves the good provider and local login working', async () => {
    const good = definition(issuerA);
    const bad = { ...definition(issuerB, { id: 'beta' }), issuer: 'http://insecure.example.test' };
    const { kernel } = await boot(environment([bad, good]));

    const listed = await providerList(kernel);
    expect(listed.providers.map((provider) => provider.id)).toEqual(['corp']);
    expect(listed.local).toBe(true);
    expect(warnings.some((line) => line.includes('"id":"beta"'))).toBe(true);

    const missing = await call(kernel, 'POST', '/_pb/auth/sso/beta/start', {
      body: { purpose: 'login' },
    });
    expect(missing.status).toBe(404);

    const response = await login(kernel, idpA, { email: 'ada@example.test', subject: 'sub-ada' });
    await expectSession(kernel, response, 'ada@example.test');

    const token = await seedAdmin();
    const started = await call(kernel, 'POST', '/_pb/auth/local/setup/start', { body: { token } });
    expect(started.status).toBe(200);
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);
    const finished = await call(kernel, 'POST', '/_pb/auth/local/setup/finish', {
      body: { token, password: PASSWORD, code: await totpCode(totpSecret, step) },
    });
    expect(finished.status).toBe(204);
    const local = await call(kernel, 'POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await totpCode(totpSecret, step + 1) },
    });
    expect(local.status).toBe(204);
    expect(cookieHeader([local])).toContain('__Host-pb_session=');
  });

  it('5: an env entry replaces a compiled provider with the same id, and an invalid one removes it', async () => {
    const compiled = definition(issuerA, { displayName: 'Compiled SSO' });
    const options = { providers: [compiled], runtimeProviders: true };

    const plain = await boot(
      environment(undefined as unknown as string, {
        PB_IDP_PROVIDERS: undefined,
      }),
      options,
    );
    expect((await providerList(plain.kernel)).providers[0]?.displayName).toBe('Compiled SSO');
    await stop(plain.broker);

    const replaced = await boot(
      environment([definition(issuerB, { displayName: 'Env SSO' })]),
      options,
    );
    expect((await providerList(replaced.kernel)).providers).toEqual([
      expect.objectContaining({ id: 'corp', displayName: 'Env SSO' }),
    ]);
    const response = await login(replaced.kernel, idpB, {
      email: 'ada@example.test',
      subject: 'sub-ada',
    });
    await expectSession(replaced.kernel, response, 'ada@example.test');
    expect(await bindings()).toEqual([{ provider: 'corp', anchor: `oidc:${issuerB}` }]);
    expect(idpA.requests).toEqual([]);
    await stop(replaced.broker);

    const invalid = await boot(
      environment([{ ...definition(issuerB), issuer: 'http://insecure.example.test' }]),
      options,
    );
    expect((await providerList(invalid.kernel)).providers).toEqual([]);
    const gone = await call(invalid.kernel, 'POST', '/_pb/auth/sso/corp/start', {
      body: { purpose: 'login' },
    });
    expect(gone.status).toBe(404);
    expect(warnings.some((line) => line.includes('"suppressed":"corp"'))).toBe(true);
  });

  it('6: the env is copied at startup, so only a restart picks up a changed value', async () => {
    const live = environment([definition(issuerA, { displayName: 'First name' })]);
    const first = await boot(live);
    expect((await providerList(first.kernel)).providers[0]?.displayName).toBe('First name');

    live['PB_IDP_PROVIDERS'] = JSON.stringify([definition(issuerA, { displayName: 'Mutated' })]);
    expect((await providerList(first.kernel)).providers[0]?.displayName).toBe('First name');
    expect(
      (await login(first.kernel, idpA, { email: 'ada@example.test', subject: 'sub-ada' })).status,
    ).toBe(303);
    await stop(first.broker);

    const same = await boot(environment([definition(issuerA, { displayName: 'First name' })]));
    expect((await providerList(same.kernel)).providers[0]?.displayName).toBe('First name');
    await stop(same.broker);

    const restarted = await boot(live);
    expect((await providerList(restarted.kernel)).providers[0]?.displayName).toBe('Mutated');
  });

  it('6: a mutated process.env is not picked up without a restart', async () => {
    const values = environment([definition(issuerA, { displayName: 'First name' })]);
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) vi.stubEnv(name, value);
    }
    const first = await boot(process.env);
    expect((await providerList(first.kernel)).providers[0]?.displayName).toBe('First name');

    vi.stubEnv(
      'PB_IDP_PROVIDERS',
      JSON.stringify([definition(issuerA, { displayName: 'Mutated' })]),
    );
    expect((await providerList(first.kernel)).providers[0]?.displayName).toBe('First name');
    await stop(first.broker);

    const restarted = await boot(process.env);
    expect((await providerList(restarted.kernel)).providers[0]?.displayName).toBe('Mutated');
  });
});
