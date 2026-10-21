import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthModule } from '@package-broker/core/auth/module';
import type { AuthModule, AuthRepositories } from '@package-broker/core/auth/module';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Clock } from '@package-broker/core/ids';
import type {
  IdentityProvider,
  IdentityResult,
  VerifiedIdentity,
} from '@package-broker/core/identity/port';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { NotBootstrappedError } from '@package-broker/core/kernel/org';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { SecretDecryptError, createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import type { HookMap } from '@package-broker/core/plugin';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { bootstrapAdmin } from './admin-bootstrap.js';
import { createAuthRepositories } from './auth.js';

const ORIGIN = 'https://broker.test';
const START = Date.parse('2026-10-15T12:00:00.000Z');
const ADMIN_EMAIL = 'admin@example.test';
const SSO_EMAIL = 'ada@example.test';
const PASSWORD = 'correct horse battery staple';
const TOKEN = 'S'.repeat(43);
const NINE_ROUTES = [
  'GET /_pb/auth/providers',
  'POST /_pb/auth/sso/:provider/start',
  'GET /_pb/auth/sso/:provider/callback',
  'POST /_pb/auth/local/setup/start',
  'POST /_pb/auth/local/setup/finish',
  'POST /_pb/auth/local/login',
  'POST /_pb/auth/local/reauth',
  'POST /_pb/auth/logout',
  'GET /_pb/session',
];

const ROLE_IDS: Readonly<Record<DefaultRoleKey, string>> = {
  organization_admin: '01J0ROLEADMIN00000000000R1',
  organization_auditor: '01J0ROLEORGAUDITOR00000R2',
  project_owner: '01J0ROLEPROJOWNER00000000R3',
  project_developer: '01J0ROLEPROJDEV00000000R4',
  project_auditor: '01J0ROLEPROJAUDITOR000R5',
};

type Log = Readonly<Record<string, unknown>>;
type ResolveIdentityHook = HookMap['auth.resolveIdentity'];

interface Harness {
  readonly kernel: Kernel;
  readonly module: AuthModule;
  readonly repositories: AuthRepositories;
  readonly keyring: ReturnType<typeof createKeyring>;
  readonly logs: Log[];
  readonly jar: Map<string, string>;
  now: number;
  authTime: string | null;
  advance(ms: number): void;
  call(
    method: string,
    path: string,
    options?: { body?: unknown; csrf?: boolean; headers?: Record<string, string> },
  ): Promise<Response>;
}

let database: MigratedDatabase;
let executor: SqlExecutor;
let org: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  org = database.orgs.a;
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

function identityAt(authTime: string | null, now: number): VerifiedIdentity {
  return {
    provider: 'dex',
    subject: 'sub-ada',
    email: SSO_EMAIL,
    emailVerified: true,
    displayName: 'Ada',
    groups: [],
    issuedAt: new Date(now).toISOString(),
    authTime,
  };
}

function fakeProvider(state: { now: number; authTime: string | null }): IdentityProvider {
  return {
    id: 'dex',
    kind: 'oidc',
    displayName: 'Dex',
    trustAnchor: 'oidc:https://dex.example.test',
    policy: { verifiedDomains: ['example.test'], autoJoin: true },
    supportsReauth: true,
    start: () =>
      Promise.resolve({
        kind: 'redirect' as const,
        location: 'https://dex.example.test/authorize?client_id=pb',
        state: { nonce: 'n-1' },
      }),
    finish: (input) =>
      Promise.resolve<IdentityResult>(
        new URL(input.request.url).searchParams.get('code') === 'good'
          ? { ok: true, identity: identityAt(state.authTime, state.now) }
          : { ok: false, reason: 'invalid_token' },
      ),
  };
}

function applyCookies(jar: Map<string, string>, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === '' || attributes.includes('Max-Age=0')) jar.delete(name);
    else jar.set(name, value);
  }
}

async function build(
  options: {
    hooks?: readonly ResolveIdentityHook[];
    resolveOrg?: () => Promise<OrgContext>;
    succeedFails?: { active: boolean };
  } = {},
): Promise<Harness> {
  const logs: Log[] = [];
  const jar = new Map<string, string>();
  const state = { now: START, authTime: null as string | null };
  const clock: Clock = { now: () => new Date(state.now) };
  const ids = { ulid: () => ulid(state.now) };
  const keyring = createKeyring([
    { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
  ]);
  const base = createAuthRepositories(executor);
  const failure = options.succeedFails;
  const repositories: AuthRepositories = {
    ...base,
    localSuccess: {
      replacePasswordHash: (ctx, input) => base.localSuccess.replacePasswordHash(ctx, input),
      succeed: (ctx, input) =>
        failure?.active === true
          ? Promise.reject(new Error('writer down'))
          : base.localSuccess.succeed(ctx, input),
    },
  };
  const hooks = {
    'access.check': [],
    'auth.mapGroups': [],
    'auth.resolveIdentity': (options.hooks ?? []).map((handler, index) => ({
      plugin: `hook-${String(index)}`,
      handler,
    })),
  };
  const module = createAuthModule({
    repositories,
    keyring,
    clock,
    ids,
    publicOrigin: ORIGIN,
    providers: new Map([['dex', fakeProvider(state)]]),
    hooks,
    log: (entry) => {
      logs.push(entry);
    },
  });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: { organizations: { get: () => Promise.resolve(null) }, clock, ids },
    resolveOrg: options.resolveOrg ?? (() => Promise.resolve(org)),
    health: () => Promise.resolve(true),
    coreRoutes: module.coreRoutes,
    log: (entry) => {
      logs.push(entry);
    },
  });
  const harness: Harness = {
    kernel,
    module,
    repositories,
    keyring,
    logs,
    jar,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    get authTime() {
      return state.authTime;
    },
    set authTime(value: string | null) {
      state.authTime = value;
    },
    advance(ms) {
      state.now += ms;
    },
    async call(method, path, callOptions = {}) {
      const headers = new Headers(callOptions.headers);
      if (method === 'POST') headers.set('origin', ORIGIN);
      if (callOptions.body !== undefined) headers.set('content-type', 'application/json');
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
      }
      const csrf = jar.get('__Host-pb_csrf');
      if (callOptions.csrf === true && csrf !== undefined) headers.set('x-csrf-token', csrf);
      const response = await kernel.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
        }),
      );
      applyCookies(jar, response);
      return response;
    },
  };
  return harness;
}

async function bootstrap(): Promise<void> {
  const result = await bootstrapAdmin(executor, org, {
    email: ADMIN_EMAIL,
    userId: '01J0USERADMIN00000000000U1',
    setupHash: await sha256Hex(TOKEN),
    setupExpiresAt: new Date(START + 86_400_000).toISOString(),
    grantId: '01J0GRANTADMIN0000000000G1',
    roleIds: ROLE_IDS,
    opId: '01J0OP000000000000000000O1',
    now: new Date(START).toISOString(),
  });
  expect(result).toBe('created');
}

async function codeNow(harness: Harness, secret: Uint8Array): Promise<string> {
  return totpCode(secret, Math.floor(harness.now / 30_000));
}

async function setUp(harness: Harness): Promise<Uint8Array> {
  const started = await harness.call('POST', '/_pb/auth/local/setup/start', {
    body: { token: TOKEN },
  });
  expect(started.status).toBe(200);
  const { secret } = (await started.json()) as { secret: string };
  const bytes = base32Decode(secret);
  const finished = await harness.call('POST', '/_pb/auth/local/setup/finish', {
    body: { token: TOKEN, password: PASSWORD, code: await codeNow(harness, bytes) },
  });
  expect(finished.status).toBe(204);
  return bytes;
}

async function rows<R>(sql: string, ...params: string[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

function logged(harness: Harness): string {
  return JSON.stringify(harness.logs);
}

describe('createAuthRepositories', () => {
  it('returns the seven repositories the module needs', () => {
    const repositories = createAuthRepositories(executor);

    expect(Object.keys(repositories).sort()).toEqual([
      'credentials',
      'localReader',
      'localSetup',
      'localSuccess',
      'login',
      'sessions',
      'users',
    ]);
    for (const repository of Object.values(repositories)) {
      expect(typeof repository).toBe('object');
    }
  });
});

describe('createAuthModule routes', () => {
  it('3: exposes exactly the nine routes of the design, all self-authenticating', async () => {
    const { module } = await build();

    expect(module.coreRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [...NINE_ROUTES].sort(),
    );
    for (const route of module.coreRoutes) expect(route.permission).toBeNull();
  });

  it('3: decides needsOrg per route: only the provider list skips the organization lookup', async () => {
    const { module } = await build();

    const flags = Object.fromEntries(
      module.coreRoutes.map((route) => [`${route.method} ${route.path}`, route.needsOrg]),
    );

    expect(flags).toEqual({
      'GET /_pb/auth/providers': false,
      'POST /_pb/auth/sso/:provider/start': true,
      'GET /_pb/auth/sso/:provider/callback': true,
      'POST /_pb/auth/local/setup/start': true,
      'POST /_pb/auth/local/setup/finish': true,
      'POST /_pb/auth/local/login': true,
      'POST /_pb/auth/local/reauth': true,
      'POST /_pb/auth/logout': true,
      'GET /_pb/session': true,
    });
  });

  const ORG_BOUND: Array<[string, string]> = [
    ['POST', '/_pb/auth/sso/dex/start'],
    ['GET', '/_pb/auth/sso/dex/callback?code=good'],
    ['POST', '/_pb/auth/local/setup/start'],
    ['POST', '/_pb/auth/local/setup/finish'],
    ['POST', '/_pb/auth/local/login'],
    ['POST', '/_pb/auth/local/reauth'],
    ['POST', '/_pb/auth/logout'],
    ['GET', '/_pb/session'],
  ];

  it('3: a failing organization lookup is a 500 on the eight org-bound routes and the provider list stays up', async () => {
    const harness = await build({ resolveOrg: () => Promise.reject(new Error('org lookup down')) });

    const providers = await harness.call('GET', '/_pb/auth/providers');
    expect(providers.status).toBe(200);
    const body = (await providers.json()) as { providers: unknown[]; local: boolean };
    expect(body.local).toBe(true);
    expect(body.providers).toHaveLength(1);

    for (const [method, path] of ORG_BOUND) {
      const response = await harness.call(method, path, {
        body: method === 'POST' ? { purpose: 'login', token: TOKEN } : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(500);
    }
    expect(logged(harness)).not.toContain('org lookup down');
  });

  it('3: an organization that is not bootstrapped is a 503 not_bootstrapped on the eight org-bound routes', async () => {
    const harness = await build({ resolveOrg: () => Promise.reject(new NotBootstrappedError()) });

    expect((await harness.call('GET', '/_pb/auth/providers')).status).toBe(200);
    for (const [method, path] of ORG_BOUND) {
      const response = await harness.call(method, path, {
        body: method === 'POST' ? { purpose: 'login', token: TOKEN } : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'not_bootstrapped' } });
    }
  });
});

describe('local setup, session and logout (criterion 1)', () => {
  it('1: setup start, finish, session 200, logout 204, session 401', async () => {
    await bootstrap();
    const harness = await build();

    await setUp(harness);

    const session = await harness.call('GET', '/_pb/session');
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      user: { email: string };
      reauthFresh: boolean;
      expiresAt: string;
    };
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.expiresAt).toBe(new Date(START + 43_200_000).toISOString());

    const cookie = [...harness.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const loggedOut = await harness.call('POST', '/_pb/auth/logout', { csrf: true });
    expect(loggedOut.status).toBe(204);

    const after = await harness.kernel.fetch(
      new Request(`${ORIGIN}/_pb/session`, { headers: { cookie } }),
    );
    expect(after.status).toBe(401);
    expect(await rows('SELECT id FROM session WHERE revoked_at IS NULL')).toHaveLength(0);
  });

  it('1: refuses a setup token nobody was given', async () => {
    await bootstrap();
    const harness = await build();

    const response = await harness.call('POST', '/_pb/auth/local/setup/start', {
      body: { token: 'W'.repeat(43) },
    });

    expect(response.status).toBe(401);
    expect(logged(harness)).toContain('auth.local.setup.refused');
  });

  it('1: local login after setup, with a fresh code, creates a second session', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await setUp(harness);
    harness.jar.clear();
    harness.advance(60_000);

    const ok = await harness.call('POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await codeNow(harness, secret) },
    });

    expect(ok.status).toBe(204);
    expect((await harness.call('GET', '/_pb/session')).status).toBe(200);
    expect(await rows('SELECT id FROM session')).toHaveLength(2);
  });

  const lockEvents = (harness: Harness): Log[] =>
    harness.logs.filter((entry) => entry['event'] === 'auth.local.locked');

  async function wrongLogin(harness: Harness): Promise<void> {
    const refused = await harness.call('POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: 'wrong password entirely', code: '000000' },
    });
    expect(refused.status).toBe(401);
  }

  it('1: five wrong login attempts log exactly one lock event, without the e-mail', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await setUp(harness);
    harness.jar.clear();
    harness.advance(60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) await wrongLogin(harness);

    expect(lockEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.local.locked',
        request_id: expect.any(String),
        reason: 'attempts',
        userId: '01J0USERADMIN00000000000U1',
      },
    ]);
    const blocked = await harness.call('POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await codeNow(harness, secret) },
    });
    expect(blocked.status).toBe(401);
    await wrongLogin(harness);
    expect(lockEvents(harness)).toHaveLength(1);
    expect(logged(harness)).not.toContain(ADMIN_EMAIL);
    expect(logged(harness)).not.toContain(PASSWORD);
  });

  it('1: four wrong attempts and a correct fifth log no lock event and sign in', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await setUp(harness);
    harness.jar.clear();
    harness.advance(60_000);

    for (let attempt = 0; attempt < 4; attempt += 1) await wrongLogin(harness);
    const fifth = await harness.call('POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await codeNow(harness, secret) },
    });

    expect(fifth.status).toBe(204);
    expect(lockEvents(harness)).toHaveLength(0);
    expect((await harness.call('GET', '/_pb/session')).status).toBe(200);
  });

  it('1: a fifth attempt that fails with an exception after writing the lock still logs it', async () => {
    await bootstrap();
    const succeedFails = { active: false };
    const harness = await build({ succeedFails });
    const secret = await setUp(harness);
    harness.jar.clear();
    harness.advance(60_000);
    for (let attempt = 0; attempt < 4; attempt += 1) await wrongLogin(harness);
    succeedFails.active = true;

    const fifth = await harness.call('POST', '/_pb/auth/local/login', {
      body: { email: ADMIN_EMAIL, password: PASSWORD, code: await codeNow(harness, secret) },
    });

    expect(fifth.status).toBe(500);
    expect(lockEvents(harness)).toHaveLength(1);
    expect(logged(harness)).not.toContain('writer down');
  });

  async function lockedUntil(): Promise<string | null> {
    const found = await rows<{ locked_until: string | null }>(
      'SELECT locked_until FROM local_login',
    );
    return found[0]?.locked_until ?? null;
  }

  it.each(['wrong first', 'correct first'])(
    '1: concurrent wrong and correct fifth attempts on one shared ctx log the lock only when it stands (%s)',
    async (order) => {
      await bootstrap();
      const harness = await build();
      const secret = await setUp(harness);
      harness.jar.clear();
      harness.advance(60_000);
      for (let attempt = 0; attempt < 4; attempt += 1) await wrongLogin(harness);
      const code = await codeNow(harness, secret);
      const wrong = (): Promise<Response> =>
        harness.call('POST', '/_pb/auth/local/login', {
          body: { email: ADMIN_EMAIL, password: 'wrong password entirely', code: '000000' },
        });
      const correct = (): Promise<Response> =>
        harness.call('POST', '/_pb/auth/local/login', {
          body: { email: ADMIN_EMAIL, password: PASSWORD, code },
        });

      const responses =
        order === 'wrong first'
          ? await Promise.all([wrong(), correct()])
          : (await Promise.all([correct(), wrong()])).reverse();

      const stands = (await lockedUntil()) !== null;
      expect(lockEvents(harness)).toHaveLength(stands ? 1 : 0);
      expect(responses.map((response) => response.status).sort()).toContain(401);
      if (!stands) expect(responses.map((response) => response.status)).toContain(204);
    },
  );

  it('1: five wrong local re-authentications log exactly one lock event', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await setUp(harness);
    harness.advance(60_000);
    const wrongReauth = async (): Promise<void> => {
      const refused = await harness.call('POST', '/_pb/auth/local/reauth', {
        body: { password: 'wrong password entirely', code: await wrongCode(harness, secret) },
        csrf: true,
      });
      expect(refused.status).toBe(401);
    };

    for (let attempt = 0; attempt < 5; attempt += 1) await wrongReauth();
    expect(lockEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.local.locked',
        request_id: expect.any(String),
        reason: 'attempts',
        userId: '01J0USERADMIN00000000000U1',
      },
    ]);
    await wrongReauth();
    expect(lockEvents(harness)).toHaveLength(1);
  });

  async function startSetup(harness: Harness): Promise<Uint8Array> {
    const started = await harness.call('POST', '/_pb/auth/local/setup/start', {
      body: { token: TOKEN },
    });
    expect(started.status).toBe(200);
    return base32Decode(((await started.json()) as { secret: string }).secret);
  }

  async function wrongCode(harness: Harness, secret: Uint8Array): Promise<string> {
    const step = Math.floor(harness.now / 30_000);
    const accepted = new Set<string>();
    for (let offset = -3; offset <= 3; offset += 1) {
      accepted.add(await totpCode(secret, step + offset));
    }
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const code = String(candidate).padStart(6, '0');
      if (!accepted.has(code)) return code;
    }
    throw new Error('no wrong code left');
  }

  async function wrongFinish(harness: Harness, secret: Uint8Array): Promise<void> {
    const refused = await harness.call('POST', '/_pb/auth/local/setup/finish', {
      body: { token: TOKEN, password: PASSWORD, code: await wrongCode(harness, secret) },
    });
    expect(refused.status).toBe(401);
  }

  it('1: five wrong setup finishes log exactly one lock event', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await startSetup(harness);

    for (let attempt = 0; attempt < 5; attempt += 1) await wrongFinish(harness, secret);

    expect(lockEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.local.locked',
        request_id: expect.any(String),
        reason: 'attempts',
        userId: '01J0USERADMIN00000000000U1',
      },
    ]);
    expect(logged(harness)).not.toContain(ADMIN_EMAIL);
  });

  it('1: four wrong setup finishes and a correct fifth log no lock event and sign in', async () => {
    await bootstrap();
    const harness = await build();
    const secret = await startSetup(harness);

    for (let attempt = 0; attempt < 4; attempt += 1) await wrongFinish(harness, secret);
    const fifth = await harness.call('POST', '/_pb/auth/local/setup/finish', {
      body: { token: TOKEN, password: PASSWORD, code: await codeNow(harness, secret) },
    });

    expect(fifth.status).toBe(204);
    expect(lockEvents(harness)).toHaveLength(0);
    expect((await harness.call('GET', '/_pb/session')).status).toBe(200);
  });
});

describe('SSO login and re-authentication (criteria 2 and 3)', () => {
  async function ssoLogin(harness: Harness): Promise<Response> {
    const started = await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'login' },
    });
    expect(started.status).toBe(303);
    return harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');
  }

  it('2: SSO login creates the user, identity and session through the real repositories', async () => {
    const harness = await build();

    const callback = await ssoLogin(harness);

    expect(callback.status).toBe(303);
    const session = await harness.call('GET', '/_pb/session');
    expect(session.status).toBe(200);
    expect(await rows('SELECT email FROM user_account')).toEqual([{ email: SSO_EMAIL }]);
    expect(await rows('SELECT provider, subject FROM identity')).toEqual([
      { provider: 'dex', subject: 'sub-ada' },
    ]);
    expect(await rows('SELECT id FROM session')).toHaveLength(1);
  });

  it('2: re-auth through POST start and callback sets reauth_at to the provider authTime', async () => {
    const harness = await build();
    await ssoLogin(harness);
    harness.advance(120_000);
    const authTime = new Date(harness.now).toISOString();
    harness.authTime = authTime;

    const started = await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'reauth' },
      csrf: true,
    });
    expect(started.status).toBe(303);
    const finished = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(finished.status).toBe(303);
    expect(await rows('SELECT reauth_at FROM session')).toEqual([{ reauth_at: authTime }]);
    const session = (await (await harness.call('GET', '/_pb/session')).json()) as {
      reauthFresh: boolean;
    };
    expect(session.reauthFresh).toBe(true);
  });

  it('2: re-auth without an authTime is refused and leaves reauth_at alone', async () => {
    const harness = await build();
    await ssoLogin(harness);
    const before = await rows<{ reauth_at: string | null }>('SELECT reauth_at FROM session');
    harness.advance(120_000);
    harness.authTime = null;
    await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'reauth' },
      csrf: true,
    });

    const finished = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(finished.status).toBe(401);
    expect(await rows('SELECT reauth_at FROM session')).toEqual(before);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.refused', reason: 'no_auth_time' }),
    );
  });

  it('3: structured events carry ULIDs and reason codes and never an e-mail', async () => {
    const harness = await build();
    await ssoLogin(harness);
    harness.advance(120_000);
    harness.authTime = new Date(harness.now).toISOString();
    await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'reauth' },
      csrf: true,
    });
    await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');
    harness.jar.clear();
    await harness.call('GET', '/_pb/auth/sso/dex/callback?code=bad');

    const events = harness.logs.map((entry) => entry['event']);
    expect(events).toContain('auth.login.succeeded');
    expect(events).toContain('auth.reauth.succeeded');
    expect(events).toContain('auth.login.refused');
    const succeeded = harness.logs.find((entry) => entry['event'] === 'auth.login.succeeded');
    expect(succeeded?.['userId']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(succeeded?.['sessionId']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(logged(harness)).not.toContain(SSO_EMAIL);
    expect(logged(harness)).not.toContain('@');
  });

  it('3: the module logs each success once: events are owned by the routes', async () => {
    const harness = await build();

    await ssoLogin(harness);

    expect(harness.logs.filter((entry) => entry['event'] === 'auth.login.succeeded')).toHaveLength(
      1,
    );
  });
});

describe('hooks', () => {
  it('stores null for an auth record emitted without a request context', async () => {
    const { createObservability } = await import('@package-broker/core/platform/observability');
    const records: unknown[] = [];
    const log = createObservability(
      { emit: (record) => void records.push(record) },
      { deploymentId: 'test-deployment', runtime: 'node', requestId: null },
      {
        events: new Set(['auth.hook.error']),
        reasonCodes: new Set(),
        routeTemplates: new Set(),
      },
    );

    log.log({ level: 'warn', event: 'auth.hook.error', error_name: 'TypeError' });

    expect(records).toEqual([
      {
        kind: 'log',
        record: {
          level: 'warn',
          event: 'auth.hook.error',
          error_name: 'TypeError',
          service: 'package-broker',
          deployment_id: 'test-deployment',
          runtime: 'node',
          request_id: null,
          timestamp: expect.any(String),
        },
      },
    ]);
  });

  async function loginWithHook(error: Error): Promise<Harness> {
    const harness = await build({
      hooks: [
        () => {
          throw error;
        },
      ],
    });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });
    const callback = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');
    expect(callback.status).toBe(401);
    return harness;
  }

  it('logs a throwing hook with plugin id and a standard error name only', async () => {
    const harness = await loginWithHook(new TypeError('boom with ada@example.test inside'));

    expect(harness.logs).toContainEqual({
      level: 'warn',
      event: 'auth.hook.error',
      request_id: expect.any(String),
      pluginId: 'hook-0',
      error: 'TypeError',
    });
    expect(logged(harness)).not.toContain('boom');
    expect(logged(harness)).not.toContain(SSO_EMAIL);
    expect(await rows('SELECT id FROM session')).toHaveLength(0);
  });

  it('logs an error whose name carries data as plain Error', async () => {
    const leaky = new Error('message');
    leaky.name = 'Failure for ada@example.test token=abc123';

    const harness = await loginWithHook(leaky);

    expect(harness.logs).toContainEqual({
      level: 'warn',
      event: 'auth.hook.error',
      request_id: expect.any(String),
      pluginId: 'hook-0',
      error: 'Error',
    });
    expect(logged(harness)).not.toContain('abc123');
    expect(logged(harness)).not.toContain(SSO_EMAIL);
  });

  it('logs a throwing hook during re-authentication and leaves reauth_at alone', async () => {
    let failing = false;
    const harness = await build({
      hooks: [
        () => {
          if (failing) throw new RangeError('hook down');
          return undefined;
        },
      ],
    });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });
    expect((await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good')).status).toBe(303);
    const before = await rows<{ reauth_at: string | null }>('SELECT reauth_at FROM session');
    harness.advance(120_000);
    harness.authTime = new Date(harness.now).toISOString();
    failing = true;
    await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'reauth' },
      csrf: true,
    });

    const finished = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(finished.status).toBe(401);
    expect(harness.logs).toContainEqual({
      level: 'warn',
      event: 'auth.hook.error',
      request_id: expect.any(String),
      pluginId: 'hook-0',
      error: 'RangeError',
    });
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.refused', reason: 'hook_denied' }),
    );
    expect(await rows('SELECT reauth_at FROM session')).toEqual(before);
    expect(logged(harness)).not.toContain('hook down');
  });

  it.each([
    ['denied', () => ({ deny: true, reason: 'free text ada@example.test token=abc123' })],
    ['invalid_hook_result', () => ({ deny: 'yes', note: 'secret text abc123' })],
    [
      'hook_error',
      () => {
        throw new Error('free text ada@example.test token=abc123');
      },
    ],
  ])('logs only the plugin id and %s code for a refused login', async (code, hook) => {
    const harness = await build({ hooks: [hook as ResolveIdentityHook] });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });
    const callback = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(callback.status).toBe(401);
    expect(await callback.json()).toMatchObject({ error: { code: 'login_failed' } });
    expect(deniedEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: 'hook-0',
        code,
        request_id: expect.any(String),
      },
    ]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.refused', reason: 'hook_denied' }),
    );
    if (code === 'hook_error') {
      expect(harness.logs).toContainEqual(
        expect.objectContaining({ level: 'warn', event: 'auth.hook.error', pluginId: 'hook-0' }),
      );
      expect(harness.logs.filter((entry) => 'plugin' in entry)).toEqual([]);
    }
    expect(logged(harness)).not.toContain('free text');
    expect(logged(harness)).not.toContain('secret text');
    expect(logged(harness)).not.toContain('abc123');
    expect(logged(harness)).not.toContain(SSO_EMAIL);
    expect(await rows('SELECT id FROM session')).toHaveLength(0);
  });

  it('attributes the denial to the second hook and keeps the hook text out of every log line', async () => {
    const harness = await build({
      hooks: [
        () => undefined,
        (() => ({
          deny: true,
          reason: 'free text ada@example.test token=abc123',
        })) as ResolveIdentityHook,
      ],
    });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });
    const callback = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(callback.status).toBe(401);
    expect(deniedEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: 'hook-1',
        code: 'denied',
        request_id: expect.any(String),
      },
    ]);
    expect(logged(harness)).not.toContain('free text');
    expect(logged(harness)).not.toContain('abc123');
    expect(logged(harness)).not.toContain(SSO_EMAIL);
    expect(await rows('SELECT id FROM session')).toHaveLength(0);
  });

  async function reauthWithHook(result: unknown): Promise<Harness> {
    const answer = { value: undefined as unknown };
    const harness = await build({ hooks: [() => answer.value as ReturnType<ResolveIdentityHook>] });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });
    expect((await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good')).status).toBe(303);
    harness.advance(120_000);
    harness.authTime = new Date(harness.now).toISOString();
    answer.value = result;
    await harness.call('POST', '/_pb/auth/sso/dex/start', {
      body: { purpose: 'reauth' },
      csrf: true,
    });
    const finished = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');
    expect(finished.status).toBe(401);
    expect(await rows('SELECT reauth_at FROM session')).toEqual([{ reauth_at: null }]);
    return harness;
  }

  const deniedEvents = (harness: Harness): Log[] =>
    harness.logs.filter((entry) => entry['event'] === 'auth.hook.denied');

  it('logs the plugin id and fixed code when a hook denies re-authentication, never its reason', async () => {
    const harness = await reauthWithHook({
      deny: true,
      reason: 'free text for ada@example.test token=abc123',
    });

    expect(deniedEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: 'hook-0',
        code: 'denied',
        request_id: expect.any(String),
      },
    ]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.refused', reason: 'hook_denied' }),
    );
    expect(logged(harness)).not.toContain('free text');
    expect(logged(harness)).not.toContain('abc123');
    expect(logged(harness)).not.toContain(SSO_EMAIL);
  });

  it('logs a malformed hook result during re-authentication as invalid_hook_result without free text', async () => {
    const harness = await reauthWithHook({ deny: 'yes', note: 'secret text abc123' });

    expect(deniedEvents(harness)).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: 'hook-0',
        code: 'invalid_hook_result',
        request_id: expect.any(String),
      },
    ]);
    expect(logged(harness)).not.toContain('secret text');
    expect(logged(harness)).not.toContain('abc123');
  });

  it('a hook that denies refuses the login with the fixed envelope', async () => {
    const harness = await build({ hooks: [() => ({ deny: true, reason: 'blocked' })] });
    await harness.call('POST', '/_pb/auth/sso/dex/start', { body: { purpose: 'login' } });

    const callback = await harness.call('GET', '/_pb/auth/sso/dex/callback?code=good');

    expect(callback.status).toBe(401);
    expect(await callback.json()).toMatchObject({ error: { code: 'login_failed' } });
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.refused', reason: 'hook_denied' }),
    );
  });
});

describe('module construction', () => {
  it('rejects a public origin that is not canonical', () => {
    expect(() =>
      createAuthModule({
        repositories: createAuthRepositories(executor),
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32) }]),
        clock: { now: () => new Date(START) },
        ids: { ulid: () => ulid() },
        publicOrigin: 'https://broker.test/',
        providers: new Map(),
        hooks: { 'access.check': [], 'auth.mapGroups': [], 'auth.resolveIdentity': [] },
        log: () => undefined,
      }),
    ).toThrow(TypeError);
  });

  it('seals credentials under a purpose the login-state cipher cannot open', async () => {
    const harness = await build();
    const plaintext = new TextEncoder().encode('provider-client-secret');

    const id = await harness.module.credentials.put(org, {
      kind: 'oidc-client',
      projectId: null,
      plaintext,
    });

    expect(await harness.module.credentials.read(org, id)).toEqual(plaintext);
    const record = await harness.repositories.credentials.get(org, id);
    if (record === null) throw new Error('credential row missing');
    const loginStateCipher = createSecretCipher(harness.keyring, 'login-state');
    await expect(loginStateCipher.open(record.sealed, record.aad)).rejects.toBeInstanceOf(
      SecretDecryptError,
    );
  });

  it('exposes the session service and the credential store', async () => {
    const { module } = await build();

    expect(typeof module.sessions.authenticate).toBe('function');
    expect(typeof module.credentials.read).toBe('function');
  });
});
