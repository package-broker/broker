import { describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from './cookies.js';
import { openLoginState, sealLoginState } from './login-state.js';
import type { LoginOutcome } from './identity-login.js';
import { createSsoRoutes } from './routes-sso.js';
import type { ReauthOutcome, SsoRouteDeps } from './routes-sso.js';
import { createSessionService, newSessionSecrets } from './session.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession, SessionRepository } from '../db/sessions.js';
import type { Clock } from '../ids.js';
import type {
  IdentityProvider,
  IdentityResult,
  StartResult,
  VerifiedIdentity,
} from '../identity/port.js';
import { createKernel } from '../kernel/kernel.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createKeyring } from '../secrets/keyring.js';
import { documented } from '../test-support/documented-routes.js';

const ORIGIN = 'https://broker.test';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ORG = orgContext('01J0ORGA00000000000000000A');
const USER_ID = '01J0USERA0000000000000000A';
const EMAIL = 'ada@example.test';
const PROVIDER_ERROR_TEXT = 'upstream said: super-secret-detail';

type Log = Readonly<Record<string, unknown>>;

const identity: VerifiedIdentity = Object.freeze({
  provider: 'dex',
  subject: 'sub-1',
  email: EMAIL,
  emailVerified: true,
  displayName: 'Ada',
  groups: Object.freeze([]),
  issuedAt: new Date(NOW).toISOString(),
  authTime: new Date(NOW).toISOString(),
});

function makeProvider(
  id: string,
  overrides: Partial<{
    supportsReauth: boolean;
    start: IdentityProvider['start'];
    finish: IdentityProvider['finish'];
  }> = {},
): IdentityProvider {
  return {
    id,
    kind: 'oidc',
    displayName: `Provider ${id}`,
    trustAnchor: `oidc:https://${id}.example.test`,
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
    supportsReauth: overrides.supportsReauth ?? true,
    start:
      overrides.start ??
      (() =>
        Promise.resolve<StartResult>({
          kind: 'redirect',
          location: `https://${id}.example.test/authorize?client_id=pb`,
          state: { nonce: 'n-1', verifier: 'v-1' },
        })),
    finish:
      overrides.finish ??
      ((input) =>
        Promise.resolve<IdentityResult>(
          new URL(input.request.url).searchParams.get('code') === 'good'
            ? { ok: true, identity: { ...identity, provider: id } }
            : { ok: false, reason: 'invalid_token' },
        )),
  };
}

function activeSession(id: string, csrfHash: string, expiresAt: string): ActiveSession {
  return {
    id,
    userId: USER_ID,
    identityId: '01J0IDENT0000000000000000I',
    csrfHash,
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt,
    lastSeenAt: new Date(NOW).toISOString(),
    reauthAt: null,
    user: { id: USER_ID, email: EMAIL, displayName: 'Ada' },
  };
}

interface Options {
  readonly providers?: readonly IdentityProvider[];
  readonly localLoginAvailable?: boolean;
  readonly loginRefusal?: string;
  readonly reauthRefusal?: string;
  readonly reauthRaw?: unknown;
  readonly logThrows?: boolean;
}

async function build(options: Options = {}) {
  const logs: Log[] = [];
  let now = NOW;
  const clock: Clock = { now: () => new Date(now) };
  const rows = new Map<string, { session: ActiveSession; revoked: boolean }>();
  let revokeFails = false;
  let findFails = false;
  let cipherFails = false;
  let sealFails = false;
  const repository: SessionRepository = {
    findActive: (_ctx, hash, cutoffs) => {
      if (findFails) return Promise.reject(new Error('database offline'));
      const row = rows.get(hash);
      return Promise.resolve(
        row !== undefined && !row.revoked && row.session.expiresAt > cutoffs.now
          ? row.session
          : null,
      );
    },
    findActiveById: (ctx, id, cutoffs) => {
      const entry = [...rows].find(([, row]) => row.session.id === id);
      return repository.findActive(ctx, entry?.[0] ?? '', cutoffs);
    },
    touch: () => Promise.resolve(),
    revokeBySecretHash: (_ctx, hash) => {
      if (revokeFails) return Promise.reject(new Error('database offline'));
      const row = rows.get(hash);
      if (row !== undefined) row.revoked = true;
      return Promise.resolve(row !== undefined);
    },
    revoke: () => Promise.reject(new Error('unexpected revoke')),
    markReauthenticatedByIdentity: () => Promise.reject(new Error('unexpected mark')),
    deleteExpired: () => Promise.reject(new Error('unexpected deleteExpired')),
  };
  const sessions = createSessionService({ sessions: repository, clock, publicOrigin: ORIGIN });
  const cipher = createSecretCipher(
    createKeyring([{ version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) }]),
    'login-state',
  );
  const stateCipher = {
    ...cipher,
    seal: (...args: Parameters<typeof cipher.seal>) => {
      if (sealFails) return Promise.reject(new Error('keyring offline'));
      return cipher.seal(...args);
    },
    open: (...args: Parameters<typeof cipher.open>) => {
      if (cipherFails) return Promise.reject(new TypeError('cipher offline'));
      return cipher.open(...args);
    },
  };
  let counter = 0;

  async function seed(): Promise<{ cookie: string; csrf: string; id: string }> {
    const secrets = await newSessionSecrets();
    counter += 1;
    const id = `01J0SESSION0000000000000S${String(counter)}`;
    const expiresAt = new Date(now + 3_600_000).toISOString();
    rows.set(secrets.secretHash, {
      session: activeSession(id, secrets.csrfHash, expiresAt),
      revoked: false,
    });
    return { cookie: `${SESSION_COOKIE}=${secrets.secret}`, csrf: secrets.csrf, id };
  }

  const login = vi.fn(async (): Promise<LoginOutcome> => {
    if (options.loginRefusal !== undefined) {
      return { ok: false, reason: options.loginRefusal as never };
    }
    const secrets = await newSessionSecrets();
    counter += 1;
    const id = `01J0SESSION0000000000000S${String(counter)}`;
    const expiresAt = new Date(now + 3_600_000).toISOString();
    rows.set(secrets.secretHash, {
      session: activeSession(id, secrets.csrfHash, expiresAt),
      revoked: false,
    });
    return Object.freeze({
      ok: true,
      userId: USER_ID,
      sessionId: id,
      cookies: Object.freeze(sessions.setCookies(secrets, expiresAt)),
    });
  });
  const reauth = vi.fn((): Promise<ReauthOutcome> =>
    Promise.resolve(
      'reauthRaw' in options
        ? (options.reauthRaw as ReauthOutcome)
        : options.reauthRefusal === undefined
          ? { ok: true }
          : { ok: false, reason: options.reauthRefusal },
    ),
  );

  const providers = new Map(
    (options.providers ?? [makeProvider('dex'), makeProvider('other')]).map((p) => [p.id, p]),
  );
  const deps: SsoRouteDeps = {
    providers,
    sessions,
    login,
    reauth,
    stateCipher,
    clock,
    publicOrigin: ORIGIN,
    localLoginAvailable: options.localLoginAvailable ?? false,
    log: (entry) => {
      logs.push(entry);
      if (options.logThrows === true) throw new Error('log sink offline');
    },
  };
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock,
      ids: { ulid: () => '01J0A0000000000000000000000'.slice(0, 26) },
    },
    resolveOrg: () => Promise.resolve(ORG),
    health: () => Promise.resolve(true),
    coreRoutes: documented(createSsoRoutes(deps)),
    log: (entry) => {
      logs.push(entry);
    },
  });
  return {
    kernel,
    logs,
    login,
    reauth,
    seed,
    cipher,
    deps,
    advance: (ms: number) => {
      now += ms;
    },
    failRevoke: () => {
      revokeFails = true;
    },
    failFind: () => {
      findFails = true;
    },
    failSeal: () => {
      sealFails = true;
    },
    failCipher: () => {
      cipherFails = true;
    },
  };
}

type Built = Awaited<ReturnType<typeof build>>;

function pairOf(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(';'));
}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return pairOf(header).slice(name.length + 1);
  }
  return null;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function startRequest(
  provider: string,
  body: unknown = { purpose: 'login', returnTo: '/projects/a' },
  headers: Record<string, string> = {},
): Request {
  return post(`/_pb/auth/sso/${provider}/start`, body, headers);
}

function callback(provider: string, cookie: string | null, query = 'code=good&state=s'): Request {
  return new Request(`${ORIGIN}/_pb/auth/sso/${provider}/callback?${query}`, {
    headers: cookie === null ? {} : { cookie },
  });
}

async function loginCookieOf(
  app: Built,
  provider = 'dex',
  body: unknown = { purpose: 'login', returnTo: '/projects/a' },
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await app.kernel.fetch(startRequest(provider, body, headers));
  expect(response.status).toBe(303);
  return `${LOGIN_COOKIE}=${cookieValue(response, LOGIN_COOKIE) ?? ''}`;
}

async function signedIn(app: Built) {
  const login = await loginCookieOf(app);
  const response = await app.kernel.fetch(callback('dex', login));
  expect(response.status).toBe(303);
  const session = cookieValue(response, SESSION_COOKIE) ?? '';
  const csrf = cookieValue(response, CSRF_COOKIE) ?? '';
  return { cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function genericRefusal(body: Record<string, unknown>): unknown {
  const { error } = body as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

function refusals(app: Built): Log[] {
  return app.logs.filter((entry) => entry['event'] === 'auth.login.refused');
}

describe('GET /_pb/auth/providers', () => {
  it('lists the provider summary and the local flag without secrets', async () => {
    const app = await build({ localLoginAvailable: true });

    const response = await app.kernel.fetch(new Request(`${ORIGIN}/_pb/auth/providers`));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      providers: [
        { id: 'dex', kind: 'oidc', displayName: 'Provider dex', supportsReauth: true },
        { id: 'other', kind: 'oidc', displayName: 'Provider other', supportsReauth: true },
      ],
      local: true,
    });
  });
});

describe('route table', () => {
  it('keeps needsOrg false only on the provider list', async () => {
    const app = await build();

    const routes = createSsoRoutes(app.deps);

    const byPath = Object.fromEntries(
      routes.map((route) => [`${route.method} ${route.path}`, route]),
    );
    expect(byPath['GET /_pb/auth/providers']?.needsOrg).toBe(false);
    for (const [key, route] of Object.entries(byPath)) {
      if (key !== 'GET /_pb/auth/providers') expect(route.needsOrg).toBeUndefined();
      expect(route.permission).toBeNull();
    }
    expect(routes).toHaveLength(5);
  });

  it('logs the provider id from the URL only when it is a valid id', async () => {
    const app = await build();

    await app.kernel.fetch(
      startRequest('Evil%0Aid', undefined, { 'sec-fetch-site': 'cross-site' }),
    );
    await app.kernel.fetch(startRequest('dex', undefined, { 'sec-fetch-site': 'cross-site' }));

    expect(refusals(app).map((entry) => entry['provider'])).toEqual([null, 'dex']);
  });
});

describe('SSO login through start and callback', () => {
  it('starts with 303 and a sealed login cookie, then creates a session and 303s to returnTo', async () => {
    const app = await build();

    const start = await app.kernel.fetch(startRequest('dex'));
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('https://dex.example.test/authorize?client_id=pb');
    expect(start.headers.get('cache-control')).toBe('no-store');
    const loginSetCookie = start.headers
      .getSetCookie()
      .find((header) => header.startsWith(`${LOGIN_COOKIE}=`));
    expect(loginSetCookie).toMatch(/Secure/);
    expect(loginSetCookie).toMatch(/HttpOnly/);
    expect(app.login).not.toHaveBeenCalled();

    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;
    const done = await app.kernel.fetch(callback('dex', login));

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/projects/a');
    expect(done.headers.get('cache-control')).toBe('no-store');
    expect(cookieValue(done, SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(done, CSRF_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(done, LOGIN_COOKIE)).toBe('');
    expect(app.login).toHaveBeenCalledTimes(1);
    const [ctx, provider, verified, meta] = app.login.mock.calls[0] as unknown as [
      unknown,
      IdentityProvider,
      VerifiedIdentity,
      { previousSecretHash: string | null },
    ];
    expect(ctx).toBe(ORG);
    expect(provider.id).toBe('dex');
    expect(verified.subject).toBe('sub-1');
    expect(meta.previousSecretHash).toBeNull();
    expect(app.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.login.succeeded', provider: 'dex' }),
    );
  });

  it('seals a login state without a challenge field', async () => {
    const app = await build();
    const start = await app.kernel.fetch(startRequest('dex'));
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;
    const state = await openLoginState(
      app.cipher,
      new Request(`${ORIGIN}/`, { headers: { cookie: login } }),
      { provider: 'dex', sessionId: null },
      NOW,
    );
    expect(state).not.toBeNull();
    expect(Object.keys(state ?? {}).sort()).toEqual([
      'data',
      'issuedAt',
      'provider',
      'purpose',
      'returnTo',
      'sessionId',
    ]);
  });

  it('passes the sealed provider state to finish and a callback URL from the public origin', async () => {
    const finish = vi.fn(
      (input: Parameters<IdentityProvider['finish']>[0]): Promise<IdentityResult> => {
        void input;
        return Promise.resolve({ ok: true, identity });
      },
    );
    const start = vi.fn((input: Parameters<IdentityProvider['start']>[0]): Promise<StartResult> => {
      void input;
      return Promise.resolve({
        kind: 'redirect',
        location: 'https://dex.example.test/authorize',
        state: { nonce: 'n-1' },
      });
    });
    const app = await build({ providers: [makeProvider('dex', { start, finish })] });

    const login = await loginCookieOf(app, 'dex', undefined, { host: 'evil.test' });
    await app.kernel.fetch(callback('dex', login));

    const callbackUrl = `${ORIGIN}/_pb/auth/sso/dex/callback`;
    expect(start.mock.calls[0]?.[0]).toMatchObject({ purpose: 'login', callbackUrl });
    expect(finish.mock.calls[0]?.[0]).toMatchObject({ state: { nonce: 'n-1' }, callbackUrl });
  });

  it('serves the session after the callback', async () => {
    const app = await build();
    const { cookie } = await signedIn(app);

    const response = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/session`, { headers: { cookie } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      user: { id: USER_ID, email: EMAIL, displayName: 'Ada' },
      reauthFresh: false,
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  it('does not mutate the login outcome or its cookies', async () => {
    const app = await build();
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.status).toBe(303);
    const outcome = (await app.login.mock.results[0]?.value) as {
      cookies: readonly string[];
    };
    expect(outcome.cookies).toHaveLength(2);
  });

  it('falls back to / for an unsafe returnTo', async () => {
    const app = await build();
    const login = await loginCookieOf(app, 'dex', { purpose: 'login', returnTo: '//evil.test' });

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.headers.get('location')).toBe('/');
  });

  it('defaults returnTo to / when it is absent', async () => {
    const app = await build();
    const login = await loginCookieOf(app, 'dex', { purpose: 'login' });

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.headers.get('location')).toBe('/');
  });

  it('passes the previous session secret hash when a session cookie is present', async () => {
    const app = await build();
    const existing = await app.seed();
    const login = await loginCookieOf(app, 'dex', undefined, { cookie: existing.cookie });

    await app.kernel.fetch(callback('dex', `${login}; ${existing.cookie}`));

    const meta = app.login.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      { previousSecretHash: string },
    ];
    expect(meta[3].previousSecretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('start refusals', () => {
  it('refuses a cross-site start with 403 and no state cookie', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { 'sec-fetch-site': 'cross-site' }),
    );

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'forbidden' } });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a foreign Origin and a start without Origin or Sec-Fetch-Site', async () => {
    const app = await build();

    const foreign = await app.kernel.fetch(
      startRequest('dex', undefined, { origin: 'https://evil.test' }),
    );
    const bare = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/auth/sso/dex/start`, {
        method: 'POST',
        body: JSON.stringify({ purpose: 'login' }),
      }),
    );

    expect(foreign.status).toBe(403);
    expect(bare.status).toBe(403);
    expect(foreign.headers.getSetCookie()).toEqual([]);
    expect(bare.headers.getSetCookie()).toEqual([]);
  });

  it('checks the origin before the provider lookup', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('nope', undefined, { origin: 'https://evil.test' }),
    );

    expect(response.status).toBe(403);
  });

  it('answers a GET to the start path with 404 and creates no session', async () => {
    const app = await build();

    const response = await app.kernel.fetch(new Request(`${ORIGIN}/_pb/auth/sso/dex/start`));

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider', async () => {
    const app = await build();

    const response = await app.kernel.fetch(startRequest('nope'));

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['a missing purpose', '{"returnTo":"/"}'],
    ['an unknown purpose', '{"purpose":"admin"}'],
    ['a non-string returnTo', '{"purpose":"login","returnTo":5}'],
    ['an oversized body', JSON.stringify({ purpose: 'login', returnTo: `/${'a'.repeat(9000)}` })],
  ])('answers 400 for %s', async (_name, body) => {
    const app = await build();

    const response = await app.kernel.fetch(startRequest('dex', body));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('answers a fixed 502 provider_error when start throws, logging only name and detail', async () => {
    class OidcProviderError extends Error {
      readonly detail = 'discovery_failed';
      constructor() {
        super(PROVIDER_ERROR_TEXT);
        this.name = 'OidcProviderError';
      }
    }
    const app = await build({
      providers: [
        makeProvider('dex', {
          start: () => Promise.reject(new OidcProviderError()),
        }),
      ],
    });

    const response = await app.kernel.fetch(startRequest('dex'));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'provider_error' } });
    expect(text).not.toContain(PROVIDER_ERROR_TEXT);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(refusals(app)).toEqual([
      expect.objectContaining({
        level: 'warn',
        provider: 'dex',
        reason: 'provider_error',
        error: 'OidcProviderError',
        detail: 'discovery_failed',
      }),
    ]);
    expect(JSON.stringify(app.logs)).not.toContain(PROVIDER_ERROR_TEXT);
  });

  it('maps an oversized sealed state to provider_error', async () => {
    const app = await build({
      providers: [
        makeProvider('dex', {
          start: () =>
            Promise.resolve({
              kind: 'redirect',
              location: 'https://dex.example.test/authorize',
              state: { verifier: 'v'.repeat(5000) },
            }),
        }),
      ],
    });

    const response = await app.kernel.fetch(startRequest('dex'));

    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('lets an infrastructure failure while sealing reach the kernel error response', async () => {
    const app = await build();
    app.failSeal();

    const response = await app.kernel.fetch(startRequest('dex'));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal' } });
    expect(text).not.toContain('keyring offline');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(JSON.stringify(app.logs)).not.toContain('keyring offline');
  });

  it.each([
    'javascript:alert(1)',
    'http://idp.example.test/authorize',
    'http://127.0.0.1.example.test/authorize',
    'ftp://localhost/authorize',
    '/relative',
  ])('refuses a start result with the location %s', async (location) => {
    const app = await build({
      providers: [
        makeProvider('dex', {
          start: () => Promise.resolve({ kind: 'redirect', location, state: {} }),
        }),
      ],
    });

    const response = await app.kernel.fetch(startRequest('dex'));

    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(['http://localhost:5556/dex/auth', 'http://127.0.0.1:5556/auth', 'http://[::1]:5556/a'])(
    'accepts the loopback http location %s',
    async (location) => {
      const app = await build({
        providers: [
          makeProvider('dex', {
            start: () => Promise.resolve({ kind: 'redirect', location, state: {} }),
          }),
        ],
      });

      const response = await app.kernel.fetch(startRequest('dex'));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(location);
    },
  );

  it('logs a detail only from the fixed start failure codes', async () => {
    const throwing = (detail: unknown) =>
      makeProvider('dex', {
        start: () => Promise.reject(Object.assign(new Error('x'), { detail })),
      });
    const allowed = await build({ providers: [throwing('discovery_timeout')] });
    const unknown = await build({ providers: [throwing('ada@example.test token=eyJabc')] });
    const nonString = await build({ providers: [throwing({ toString: () => 'eyJabc' })] });

    await allowed.kernel.fetch(startRequest('dex'));
    await unknown.kernel.fetch(startRequest('dex'));
    await nonString.kernel.fetch(startRequest('dex'));

    expect(refusals(allowed)[0]).toMatchObject({ detail: 'discovery_timeout' });
    expect(refusals(unknown)[0]).toMatchObject({ detail: null });
    expect(refusals(nonString)[0]).toMatchObject({ detail: null });
    expect(JSON.stringify(unknown.logs)).not.toContain('eyJabc');
    expect(JSON.stringify(nonString.logs)).not.toContain('eyJabc');
  });

  it('never logs plugin text from a thrown start value', async () => {
    const leak = { detail: 'ada@example.test token=eyJabc', message: 'ada@example.test eyJabc' };
    class Named extends Error {
      constructor() {
        super('ada@example.test token=eyJabc');
        this.name = 'ada@example.test token=eyJabc';
      }
    }
    for (const thrown of [leak, new Named(), 'ada@example.test token=eyJabc']) {
      const app = await build({
        providers: [makeProvider('dex', { start: () => Promise.reject(thrown as Error) })],
      });

      const response = await app.kernel.fetch(startRequest('dex'));

      expect(response.status).toBe(502);
      const text = JSON.stringify(app.logs) + (await response.text());
      expect(text).not.toContain('ada@example.test');
      expect(text).not.toContain('eyJabc');
    }
  });
});

describe('callback refusals', () => {
  it('refuses a callback without the login cookie', async () => {
    const app = await build();

    const response = await app.kernel.fetch(callback('dex', null));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'login_failed' } });
    expect(app.login).not.toHaveBeenCalled();
    expect(refusals(app)).toEqual([
      expect.objectContaining({ level: 'warn', provider: 'dex', reason: 'state_invalid' }),
    ]);
  });

  it('refuses an expired login state', async () => {
    const app = await build();
    const login = await loginCookieOf(app);
    app.advance(11 * 60_000);

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.status).toBe(401);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('refuses a callback for another provider than the sealed one', async () => {
    const app = await build();
    const login = await loginCookieOf(app, 'dex');

    const response = await app.kernel.fetch(callback('other', login));

    expect(response.status).toBe(401);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('refuses a tampered login cookie', async () => {
    const app = await build();
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', `${login}A`));

    expect(response.status).toBe(401);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider', async () => {
    const app = await build();

    const response = await app.kernel.fetch(callback('nope', null));

    expect(response.status).toBe(404);
  });

  it('clears the login cookie on a refusal after the state was read', async () => {
    const app = await build();
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login, 'code=bad'));

    expect(response.status).toBe(401);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(cookieValue(response, SESSION_COOKIE)).toBeNull();
  });

  it('turns a provider failure result into the generic refusal with the reason in the log', async () => {
    const app = await build();
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login, 'code=bad'));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'login_failed' } });
    expect(refusals(app)).toEqual([
      expect.objectContaining({ provider: 'dex', reason: 'invalid_token' }),
    ]);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('turns a finish exception into provider_error without reading the message', async () => {
    const throwing = {
      get message(): string {
        throw new Error('message must not be read');
      },
      name: 'Error',
    };
    const app = await build({
      providers: [
        makeProvider('dex', {
          finish: () => Promise.reject(throwing as unknown as Error),
        }),
      ],
    });
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'login_failed' } });
    expect(refusals(app)).toEqual([
      expect.objectContaining({ provider: 'dex', reason: 'provider_error' }),
    ]);
  });

  it('never puts an Error message from finish into a body or a log', async () => {
    const app = await build({
      providers: [
        makeProvider('dex', {
          finish: () => Promise.reject(new Error(PROVIDER_ERROR_TEXT)),
        }),
      ],
    });
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login));

    expect(await response.text()).not.toContain(PROVIDER_ERROR_TEXT);
    expect(JSON.stringify(app.logs)).not.toContain(PROVIDER_ERROR_TEXT);
  });

  it('never logs plugin text or a detail from a thrown finish value', async () => {
    const leak = { detail: 'ada@example.test token=eyJabc', message: 'ada@example.test eyJabc' };
    class Named extends Error {
      readonly detail = 'discovery_timeout';
      constructor() {
        super('ada@example.test token=eyJabc');
        this.name = 'ada@example.test token=eyJabc';
      }
    }
    for (const thrown of [leak, new Named(), 'ada@example.test token=eyJabc']) {
      const app = await build({
        providers: [makeProvider('dex', { finish: () => Promise.reject(thrown as Error) })],
      });
      const login = await loginCookieOf(app);

      const response = await app.kernel.fetch(callback('dex', login));

      expect(response.status).toBe(401);
      const text = JSON.stringify(app.logs) + (await response.text());
      expect(text).not.toContain('ada@example.test');
      expect(text).not.toContain('eyJabc');
      expect(text).not.toContain('discovery_timeout');
      expect(refusals(app)[0]).not.toHaveProperty('detail');
    }
  });

  it('refuses a malformed finish result', async () => {
    const app = await build({
      providers: [makeProvider('dex', { finish: () => Promise.resolve({ ok: true } as never) })],
    });
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.status).toBe(401);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('answers admin linking and not-invited refusals identically', async () => {
    const responses: Response[] = [];
    for (const reason of ['not_invited', 'link_requires_admin']) {
      const app = await build({ loginRefusal: reason });
      const login = await loginCookieOf(app);
      responses.push(await app.kernel.fetch(callback('dex', login)));
      expect(refusals(app)).toEqual([expect.objectContaining({ reason })]);
    }
    const [baseline, linking] = responses as [Response, Response];
    expect(linking.status).toBe(baseline.status);
    const baselineId = baseline.headers.get('x-request-id') as string;
    const linkingId = linking.headers.get('x-request-id') as string;
    linking.headers.delete('x-request-id');
    baseline.headers.delete('x-request-id');
    expect([...linking.headers]).toEqual([...baseline.headers]);
    expect((await linking.text()).replace(linkingId, 'request-id')).toBe(
      (await baseline.text()).replace(baselineId, 'request-id'),
    );
  });

  it.each([
    'email_missing',
    'email_unverified',
    'domain_not_verified',
    'not_invited',
    'link_requires_admin',
    'user_suspended',
    'hook_denied',
    'too_many_groups',
    'already_linked',
    'invalid_identity',
    'provider_rebound',
    'email_changed',
    'conflict',
  ])('answers the same generic 401 for the login refusal %s', async (reason) => {
    const refused = await build({ loginRefusal: reason });
    const login = await loginCookieOf(refused);
    const response = await refused.kernel.fetch(callback('dex', login));
    const body = await bodyOf(response);

    const missing = await build();
    const baseline = await bodyOf(await missing.kernel.fetch(callback('dex', null)));

    expect(response.status).toBe(401);
    expect(genericRefusal(body)).toEqual(genericRefusal(baseline));
    expect(JSON.stringify(body)).not.toContain(reason);
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(response.headers.getSetCookie().filter((c) => c.startsWith(SESSION_COOKIE))).toEqual([]);
    expect(refusals(refused)).toEqual([expect.objectContaining({ provider: 'dex', reason })]);
    expect(JSON.stringify(refused.logs)).not.toContain(EMAIL);
  });
});

describe('callback failures clear the login state', () => {
  it('clears the cookie on an unknown provider', async () => {
    const app = await build();

    const response = await app.kernel.fetch(callback('nope', null));

    expect(response.status).toBe(404);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
  });

  it('clears the cookie when login rejects and hides the error text', async () => {
    const app = await build();
    app.login.mockRejectedValueOnce(new Error(PROVIDER_ERROR_TEXT));
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', login));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(cookieValue(response, SESSION_COOKIE)).toBeNull();
    expect(text).not.toContain(PROVIDER_ERROR_TEXT);
    expect(JSON.stringify(app.logs)).not.toContain(PROVIDER_ERROR_TEXT);
  });

  it('clears the cookie when reauth rejects', async () => {
    const app = await build();
    app.reauth.mockRejectedValueOnce(new Error(PROVIDER_ERROR_TEXT));
    const { cookie, csrf } = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', { purpose: 'reauth' }, { cookie, 'x-csrf-token': csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(500);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(await response.text()).not.toContain(PROVIDER_ERROR_TEXT);
  });

  it('clears the cookie when authenticate throws', async () => {
    const app = await build();
    const { cookie } = await app.seed();
    const login = await loginCookieOf(app);
    app.failFind();

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(500);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(app.login).not.toHaveBeenCalled();
  });

  it('clears the cookie when opening the state throws', async () => {
    const app = await build();
    const login = await loginCookieOf(app);
    app.failCipher();

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.status).toBe(500);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(app.login).not.toHaveBeenCalled();
  });

  it('clears the cookie even when the log sink throws', async () => {
    const app = await build({ logThrows: true });

    const response = await app.kernel.fetch(callback('dex', null));

    expect(response.status).toBe(401);
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
  });
});

describe('direct providers', () => {
  const direct = (): IdentityProvider =>
    makeProvider('access', {
      supportsReauth: false,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: (input) => {
        expect(input.state).toBeNull();
        return Promise.resolve({ ok: true, identity: { ...identity, provider: 'access' } });
      },
    });

  it('logs in through POST start with session cookies and 303 to returnTo', async () => {
    const app = await build({ providers: [direct()] });

    const response = await app.kernel.fetch(startRequest('access'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/projects/a');
    expect(cookieValue(response, SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(response, CSRF_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(app.login).toHaveBeenCalledTimes(1);
  });

  it('refuses a cross-site direct start without calling the provider or login', async () => {
    const app = await build({ providers: [direct()] });

    const response = await app.kernel.fetch(
      startRequest('access', undefined, { 'sec-fetch-site': 'cross-site' }),
    );

    expect(response.status).toBe(403);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('refuses a direct provider answering a reauth start', async () => {
    const app = await build({
      providers: [{ ...direct(), supportsReauth: true }],
    });
    const { cookie, csrf } = await (async () => {
      const seeded = await app.seed();
      return { cookie: seeded.cookie, csrf: seeded.csrf };
    })();

    const response = await app.kernel.fetch(
      startRequest(
        'access',
        { purpose: 'reauth', returnTo: '/' },
        { cookie, 'x-csrf-token': csrf },
      ),
    );

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().filter((c) => c.startsWith(SESSION_COOKIE))).toEqual([]);
    expect(app.login).not.toHaveBeenCalled();
  });

  it('logs the fallback, never the text, for a login refusal that is not a known code', async () => {
    const app = await build({ providers: [direct()], loginRefusal: 'ada@example.test' });

    const response = await app.kernel.fetch(startRequest('access'));

    expect(response.status).toBe(401);
    expect(refusals(app)).toEqual([expect.objectContaining({ reason: 'login_refused' })]);
    expect(JSON.stringify(app.logs)).not.toContain('ada@example.test');
  });

  it('turns a direct login refusal into the generic 401', async () => {
    const app = await build({ providers: [direct()], loginRefusal: 'not_invited' });

    const response = await app.kernel.fetch(startRequest('access'));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'login_failed' } });
    expect(refusals(app)).toEqual([
      expect.objectContaining({ provider: 'access', reason: 'not_invited' }),
    ]);
  });
});

describe('re-authentication', () => {
  const reauthBody = { purpose: 'reauth', returnTo: '/tokens/new' };

  it('refuses a reauth start without a session', async () => {
    const app = await build();

    const response = await app.kernel.fetch(startRequest('dex', reauthBody));

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a reauth start without the CSRF token and sets no state cookie', async () => {
    const app = await build();
    const { cookie } = await app.seed();

    const response = await app.kernel.fetch(startRequest('dex', reauthBody, { cookie }));

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'forbidden' } });
    expect(cookieValue(response, LOGIN_COOKIE)).toBeNull();
  });

  it('refuses a reauth start with a wrong CSRF token', async () => {
    const app = await build();
    const { cookie } = await app.seed();

    const response = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': 'A'.repeat(43) }),
    );

    expect(response.status).toBe(403);
  });

  it('answers 400 reauth_unsupported when the provider does not support it', async () => {
    const app = await build({ providers: [makeProvider('dex', { supportsReauth: false })] });
    const { cookie, csrf } = await app.seed();

    const response = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'reauth_unsupported' } });
    expect(cookieValue(response, LOGIN_COOKIE)).toBeNull();
  });

  it('seals the session id into the state and calls reauth with the same session', async () => {
    const app = await build();
    const { cookie, csrf, id } = await app.seed();

    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );
    expect(start.status).toBe(303);
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const done = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/tokens/new');
    expect(cookieValue(done, LOGIN_COOKIE)).toBe('');
    expect(app.login).not.toHaveBeenCalled();
    expect(app.reauth).toHaveBeenCalledTimes(1);
    const [ctx, session, provider, verified, state] = app.reauth.mock.calls[0] as unknown as [
      unknown,
      { session: { id: string } },
      IdentityProvider,
      VerifiedIdentity,
      { purpose: string; sessionId: string; provider: string },
    ];
    expect(ctx).toBe(ORG);
    expect(session.session.id).toBe(id);
    expect(provider.id).toBe('dex');
    expect(verified.subject).toBe('sub-1');
    expect(state).toMatchObject({ purpose: 'reauth', sessionId: id, provider: 'dex' });
    expect(app.logs).toContainEqual(
      expect.objectContaining({ event: 'auth.reauth.succeeded', provider: 'dex' }),
    );
  });

  it('refuses a callback presented in another session and does not call reauth', async () => {
    const app = await build();
    const first = await app.seed();
    const second = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie: first.cookie, 'x-csrf-token': first.csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', `${login}; ${second.cookie}`));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'login_failed' } });
    expect(app.reauth).not.toHaveBeenCalled();
    expect(app.login).not.toHaveBeenCalled();
  });

  it('refuses a reauth callback without any session', async () => {
    const app = await build();
    const { cookie, csrf } = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', login));

    expect(response.status).toBe(401);
    expect(app.reauth).not.toHaveBeenCalled();
  });

  it('answers the generic 401 when the reauth service refuses', async () => {
    const app = await build({ reauthRefusal: 'stale_auth_time' });
    const { cookie, csrf } = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'login_failed' } });
    expect(refusals(app)).toEqual([
      expect.objectContaining({ provider: 'dex', reason: 'stale_auth_time' }),
    ]);
  });

  it.each([
    ['ok is not the boolean true', { ok: 'yes' }],
    ['the outcome is a boolean', true],
    ['the outcome is null', null],
  ])('treats a reauth outcome where %s as a refusal', async (_name, raw) => {
    const app = await build({ reauthRaw: raw });
    const { cookie, csrf } = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(401);
    expect(refusals(app)).toEqual([expect.objectContaining({ reason: 'reauth_refused' })]);
  });

  it('logs the fallback, never the text, for a reauth reason that is not a known code', async () => {
    const app = await build({ reauthRefusal: 'ada@example.test' });
    const { cookie, csrf } = await app.seed();
    const start = await app.kernel.fetch(
      startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
    );
    const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(401);
    expect(refusals(app)).toEqual([expect.objectContaining({ reason: 'reauth_refused' })]);
    expect(JSON.stringify(app.logs)).not.toContain('ada@example.test');
    expect(await response.text()).not.toContain('ada@example.test');
  });

  it('logs every known reauth refusal code as given', async () => {
    for (const code of ['no_auth_time', 'stale_auth_time', 'identity_mismatch', 'hook_denied']) {
      const app = await build({ reauthRefusal: code });
      const { cookie, csrf } = await app.seed();
      const start = await app.kernel.fetch(
        startRequest('dex', reauthBody, { cookie, 'x-csrf-token': csrf }),
      );
      const login = `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`;

      await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

      expect(refusals(app)).toEqual([expect.objectContaining({ reason: code })]);
    }
  });

  it('does not accept a login-purpose state as a reauth and vice versa', async () => {
    const app = await build();
    const { cookie } = await app.seed();
    const login = await loginCookieOf(app);

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(303);
    expect(app.reauth).not.toHaveBeenCalled();
    expect(app.login).toHaveBeenCalledTimes(1);
  });

  it('refuses a hand-built reauth state sealed for a session that is not the current one', async () => {
    const app = await build();
    const { cookie } = await app.seed();
    const setCookie = await sealLoginState(app.cipher, {
      provider: 'dex',
      purpose: 'reauth',
      returnTo: '/',
      issuedAt: NOW,
      sessionId: '01J0SESSIONOTHER0000000000',
      data: {},
    });
    const login = pairOf(setCookie);

    const response = await app.kernel.fetch(callback('dex', `${login}; ${cookie}`));

    expect(response.status).toBe(401);
    expect(app.reauth).not.toHaveBeenCalled();
  });
});

describe('POST /_pb/auth/logout', () => {
  it('refuses logout without a session and clears the cookies', async () => {
    const app = await build();

    const response = await app.kernel.fetch(post('/_pb/auth/logout', ''));

    expect(response.status).toBe(401);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
    expect(cookieValue(response, CSRF_COOKIE)).toBe('');
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
  });

  it('clears the cookies for a stale session secret', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` }),
    );

    expect(response.status).toBe(401);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
  });

  it('clears the cookies when authenticate throws', async () => {
    const app = await build({ logThrows: true });
    const { cookie, csrf } = await app.seed();
    app.failFind();

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { cookie, 'x-csrf-token': csrf }),
    );

    expect(response.status).toBe(500);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
    expect(cookieValue(response, CSRF_COOKIE)).toBe('');
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(await response.text()).not.toContain('database offline');
  });

  it('refuses a cross-site logout without a session and sets no cookie', async () => {
    const app = await build();

    const cross = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { 'sec-fetch-site': 'cross-site' }),
    );
    const foreign = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { origin: 'https://evil.test' }),
    );
    const bare = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/auth/logout`, { method: 'POST' }),
    );

    for (const response of [cross, foreign, bare]) {
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it('refuses a cross-site logout whose authenticate would throw, without cookies', async () => {
    const app = await build();
    const { cookie, csrf } = await app.seed();
    app.failFind();

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', {
        cookie,
        'x-csrf-token': csrf,
        'sec-fetch-site': 'cross-site',
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('does not clear the cookies on a CSRF refusal', async () => {
    const app = await build();
    const { cookie } = await app.seed();

    const response = await app.kernel.fetch(post('/_pb/auth/logout', '', { cookie }));

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('refuses logout without the CSRF token and keeps the session', async () => {
    const app = await build();
    const { cookie, csrf } = await signedIn(app);

    const response = await app.kernel.fetch(post('/_pb/auth/logout', '', { cookie }));

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'forbidden' } });
    const still = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/session`, { headers: { cookie } }),
    );
    expect(still.status).toBe(200);
    expect(csrf).toHaveLength(43);
  });

  it('refuses a cross-site logout', async () => {
    const app = await build();
    const { cookie, csrf } = await signedIn(app);

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', {
        cookie,
        'x-csrf-token': csrf,
        'sec-fetch-site': 'cross-site',
      }),
    );

    expect(response.status).toBe(403);
  });

  it('revokes the session with 204 and cleared cookies, and the session is refused afterwards', async () => {
    const app = await build();
    const { cookie, csrf } = await signedIn(app);

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { cookie, 'x-csrf-token': csrf }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
    expect(cookieValue(response, CSRF_COOKIE)).toBe('');
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    const after = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/session`, { headers: { cookie } }),
    );
    expect(after.status).toBe(401);
  });

  it('still clears the cookies when revocation fails', async () => {
    const app = await build();
    const { cookie, csrf } = await signedIn(app);
    app.failRevoke();

    const response = await app.kernel.fetch(
      post('/_pb/auth/logout', '', { cookie, 'x-csrf-token': csrf }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
    expect(cookieValue(response, CSRF_COOKIE)).toBe('');
    expect(cookieValue(response, LOGIN_COOKIE)).toBe('');
    expect(text).not.toContain('database offline');
    expect(JSON.stringify(app.logs)).not.toContain('database offline');
  });
});

describe('GET /_pb/session', () => {
  it('answers 401 without a session', async () => {
    const app = await build();

    const response = await app.kernel.fetch(new Request(`${ORIGIN}/_pb/session`));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 401 for an unknown session secret', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      new Request(`${ORIGIN}/_pb/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe('no refusal text leaks', () => {
  it('keeps provider reasons and provider error text out of every refusal body', async () => {
    const app = await build({
      providers: [
        makeProvider('dex', { finish: () => Promise.reject(new Error(PROVIDER_ERROR_TEXT)) }),
      ],
    });
    const login = await loginCookieOf(app);
    const responses = [
      await app.kernel.fetch(callback('dex', login)),
      await app.kernel.fetch(callback('dex', null)),
      await app.kernel.fetch(startRequest('dex', undefined, { 'sec-fetch-site': 'cross-site' })),
    ];

    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(PROVIDER_ERROR_TEXT);
      expect(text).not.toContain('provider_error');
      expect(text).not.toContain('state_invalid');
      expect(text).not.toContain('cross_site');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('SSO start location response', () => {
  const AUTHORIZE = 'https://dex.example.test/authorize?client_id=pb';

  function attributesOf(response: Response): string[] {
    const header = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`));
    return (header ?? '')
      .split(';')
      .slice(1)
      .map((part) => part.trim());
  }

  it('answers 200 with only the location when Accept is application/json', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ location: AUTHORIZE });
  });

  it('returns the same location as the 303 mode', async () => {
    const app = await build();

    const json = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );
    const redirected = await app.kernel.fetch(startRequest('dex'));

    expect((await bodyOf(json))['location']).toBe(redirected.headers.get('location'));
  });

  it('serves the JSON mode for a media-range list that prefers application/json', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json, text/plain;q=0.5' }),
    );

    expect(response.status).toBe(200);
  });

  it('keeps the 303 for a request without Accept', async () => {
    const app = await build();

    const response = await app.kernel.fetch(startRequest('dex'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(AUTHORIZE);
  });

  it('keeps the 303 for Accept */*', async () => {
    const app = await build();

    const response = await app.kernel.fetch(startRequest('dex', undefined, { accept: '*/*' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(AUTHORIZE);
  });

  it('keeps the 303 for Accept text/html', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'text/html' }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(AUTHORIZE);
  });

  it('keeps the 303 when text/html is listed before application/json', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'text/html, application/json' }),
    );

    expect(response.status).toBe(303);
  });

  it('keeps the 303 when application/json has quality zero', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json;q=0, text/html' }),
    );

    expect(response.status).toBe(303);
  });

  it('puts no key other than location in the JSON body', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );
    const cookie = cookieValue(response, LOGIN_COOKIE) ?? '';
    const body = await bodyOf(response);

    expect(Object.keys(body)).toEqual(['location']);
    expect(cookie).not.toBe('');
    expect(JSON.stringify(body)).not.toContain(cookie);
  });

  it('sets the same login cookie attributes and cache header in both modes', async () => {
    const app = await build();

    const json = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );
    const redirected = await app.kernel.fetch(startRequest('dex'));

    expect(attributesOf(json)).toEqual(attributesOf(redirected));
    expect(attributesOf(json).length).toBeGreaterThan(0);
    expect(json.headers.get('cache-control')).toBe('no-store');
    expect(json.headers.getSetCookie()).toHaveLength(redirected.headers.getSetCookie().length);
  });

  it('seals a login cookie in the JSON mode that the callback accepts', async () => {
    const app = await build();

    const start = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );
    const done = await app.kernel.fetch(
      callback('dex', `${LOGIN_COOKIE}=${cookieValue(start, LOGIN_COOKIE) ?? ''}`),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/projects/a');
  });

  it('matches Accept case-insensitively', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'Application/JSON' }),
    );

    expect(response.status).toBe(200);
  });

  it('accepts application/json with a charset parameter', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json; charset=utf-8' }),
    );

    expect(response.status).toBe(200);
  });

  it('treats an unparsable quality as unacceptable', async () => {
    const app = await build();

    const response = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json;q=abc' }),
    );

    expect(response.status).toBe(303);
  });

  it('answers a reauth start in the JSON mode with the location', async () => {
    const app = await build();
    const { cookie, csrf } = await app.seed();

    const response = await app.kernel.fetch(
      startRequest(
        'dex',
        { purpose: 'reauth', returnTo: '/tokens/new' },
        { cookie, 'x-csrf-token': csrf, accept: 'application/json' },
      ),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ location: AUTHORIZE });
    expect(cookieValue(response, LOGIN_COOKIE)).not.toBeNull();
  });

  it('varies both start success responses on Accept', async () => {
    const app = await build();

    const json = await app.kernel.fetch(
      startRequest('dex', undefined, { accept: 'application/json' }),
    );
    const redirected = await app.kernel.fetch(startRequest('dex'));

    expect(json.headers.get('vary')).toBe('Accept');
    expect(redirected.headers.get('vary')).toBe('Accept');
  });

  it('answers a direct provider in the JSON mode with the return location and the 303 cookies', async () => {
    const access = makeProvider('access', {
      supportsReauth: false,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: () => Promise.resolve({ ok: true, identity: { ...identity, provider: 'access' } }),
    });
    const app = await build({ providers: [access] });

    const json = await app.kernel.fetch(
      startRequest('access', undefined, { accept: 'application/json' }),
    );
    const redirected = await app.kernel.fetch(startRequest('access'));

    expect(json.status).toBe(200);
    expect(await bodyOf(json)).toEqual({ location: '/projects/a' });
    expect(redirected.status).toBe(303);
    const names = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((c) => c.replace(/=[^;]*/, ''))
        .sort();
    expect(names(json)).toEqual(names(redirected));
    expect(names(json).length).toBeGreaterThan(0);
  });

  it('refuses a foreign Origin with the same envelope in the JSON mode', async () => {
    const app = await build();
    const headers = { origin: 'https://evil.test' };

    const json = await app.kernel.fetch(
      startRequest('dex', undefined, { ...headers, accept: 'application/json' }),
    );
    const plain = await app.kernel.fetch(startRequest('dex', undefined, headers));

    expect(json.status).toBe(403);
    expect(plain.status).toBe(403);
    expect(genericRefusal(await bodyOf(json))).toEqual(genericRefusal(await bodyOf(plain)));
    expect(json.headers.getSetCookie()).toEqual([]);
  });

  it('answers an unknown provider with the same error in both modes', async () => {
    const app = await build();

    const json = await app.kernel.fetch(
      startRequest('nope', undefined, { accept: 'application/json' }),
    );
    const plain = await app.kernel.fetch(startRequest('nope'));

    expect(json.status).toBe(404);
    expect(plain.status).toBe(404);
    expect(genericRefusal(await bodyOf(json))).toEqual(genericRefusal(await bodyOf(plain)));
  });
});
