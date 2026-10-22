import { describe, expect, it, vi } from 'vitest';
import { CsrfError } from './csrf.js';
import type { LocalLoginService, LocalResult } from './local-login.js';
import type { LocalSetupService } from './local-setup.js';
import { sha256Hex } from './primitives.js';
import { createLocalRoutes } from './routes-local.js';
import { createSessionService } from './session.js';
import type { SessionService } from './session.js';
import { weakPasswordErrorResponse } from '../api/auth-schemas.js';
import { DbError } from '../db/errors.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession, SessionRepository } from '../db/sessions.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { KernelLog } from '../kernel/errors.js';
import type { PluginPorts } from '../plugin.js';
import {
  createObservability,
  type ObsRecord,
  type ObsRecordSink,
} from '../platform/observability.js';
import { documented } from '../test-support/documented-routes.js';

const ORIGIN = 'https://broker.example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const ORG = orgContext('01J0ORGA00000000000000000A');
const SESSION_SECRET = 'S'.repeat(43);
const CSRF_TOKEN = 'C'.repeat(43);

const SENTINEL = {
  email: 'sentinel-email-9f3a@leak.example',
  password: 'sentinel-password-9f3a',
  code: '948271',
  token: 'T'.repeat(43),
  secret: 'SENTINELSECRET9F3A',
  uri: 'otpauth://totp/sentinel-uri-9f3a',
};

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock(NOW),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

const COOKIES = [
  `__Host-pb_session=${SESSION_SECRET}; Path=/; Secure; SameSite=Lax; Max-Age=100; HttpOnly`,
  `__Host-pb_csrf=${CSRF_TOKEN}; Path=/; Secure; SameSite=Strict; Max-Age=100`,
];

const REFUSED: LocalResult = Object.freeze({ ok: false });
const GRANTED: LocalResult = { ok: true, cookies: COOKIES, userId: '01J0USERA0000000000000000A' };

type Entry = Readonly<Record<string, unknown>>;

function activeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: '01J0SESSION00000000000000S1',
    userId: '01J0USERA0000000000000000A',
    identityId: null,
    csrfHash: 'a'.repeat(64),
    createdAt: NOW,
    expiresAt: '2026-10-15T20:00:00.000Z',
    lastSeenAt: NOW,
    reauthAt: null,
    user: { id: '01J0USERA0000000000000000A', email: SENTINEL.email, displayName: null },
    ...overrides,
  };
}

interface Harness {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly login: ReturnType<typeof vi.fn>;
  readonly reauth: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly findActive: ReturnType<typeof vi.fn>;
  readonly entries: Entry[];
  readonly serviceCalls: () => number;
}

interface Options {
  readonly sink?: ObsRecordSink;
  readonly loginResult?: LocalResult;
  readonly reauthResult?: Awaited<ReturnType<LocalLoginService['reauth']>>;
  readonly startResult?: Awaited<ReturnType<LocalSetupService['start']>>;
  readonly finishResult?: Awaited<ReturnType<LocalSetupService['finish']>>;
  readonly session?: ActiveSession | null;
  readonly sessions?: SessionService;
}

async function harness(options: Options = {}): Promise<Harness> {
  const entries: Entry[] = [];
  const login = vi.fn(() => Promise.resolve(options.loginResult ?? GRANTED));
  const reauth = vi.fn(() => Promise.resolve(options.reauthResult ?? { ok: true }));
  const start = vi.fn(() =>
    Promise.resolve(
      options.startResult ?? { ok: true, provisioningUri: SENTINEL.uri, secret: SENTINEL.secret },
    ),
  );
  const finish = vi.fn(() => Promise.resolve(options.finishResult ?? GRANTED));
  const found =
    options.session === undefined
      ? activeSession({ csrfHash: await sha256Hex(CSRF_TOKEN) })
      : options.session;
  const findActive = vi.fn(() => Promise.resolve(found));
  const repository = {
    findActive,
    touch: vi.fn(() => Promise.resolve()),
  } as unknown as SessionRepository;
  const sessions =
    options.sessions ??
    createSessionService({
      sessions: repository,
      clock: fixedClock(NOW),
      publicOrigin: ORIGIN,
    });
  const obs =
    options.sink &&
    createObservability(
      options.sink,
      { deploymentId: 'test', runtime: 'node', requestId: null },
      {
        events: new Set([
          'auth.local.setup.completed',
          'auth.login.succeeded',
          'auth.reauth.succeeded',
        ]),
        reasonCodes: new Set(),
        routeTemplates: new Set(),
      },
    );
  const log: KernelLog = (entry) => {
    entries.push(entry);
    if (obs) obs.log(entry as Parameters<typeof obs.log>[0]);
  };
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports,
    resolveOrg: () => Promise.resolve(ORG),
    health: () => Promise.resolve(true),
    log,
    coreRoutes: documented(
      createLocalRoutes({
        local: { login, reauth } as unknown as LocalLoginService,
        setup: { start, finish } as unknown as LocalSetupService,
        sessions,
        publicOrigin: ORIGIN,
        log,
      }),
    ),
  });
  return {
    fetch: (request) => kernel.fetch(request),
    login,
    reauth,
    start,
    finish,
    findActive,
    entries,
    serviceCalls: () =>
      login.mock.calls.length +
      reauth.mock.calls.length +
      start.mock.calls.length +
      finish.mock.calls.length,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const LOGIN = '/_pb/auth/local/login';
const REAUTH = '/_pb/auth/local/reauth';
const START = '/_pb/auth/local/setup/start';
const FINISH = '/_pb/auth/local/setup/finish';

const loginBody = { email: SENTINEL.email, password: SENTINEL.password, code: SENTINEL.code };
const sessionHeaders = {
  cookie: `__Host-pb_session=${SESSION_SECRET}`,
  'x-csrf-token': CSRF_TOKEN,
};

function setCookies(response: Response): readonly string[] {
  return response.headers.getSetCookie();
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return body.error;
}

describe('createLocalRoutes', () => {
  it('declares four public POST routes under /_pb/auth/local', () => {
    const routes = createLocalRoutes({
      local: {} as LocalLoginService,
      setup: {} as LocalSetupService,
      sessions: {} as SessionService,
      publicOrigin: ORIGIN,
      log: () => undefined,
    });

    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [`POST ${FINISH}`, `POST ${LOGIN}`, `POST ${REAUTH}`, `POST ${START}`].sort(),
    );
    expect(routes.every((route) => route.permission === null)).toBe(true);
  });

  it('rejects a non-canonical public origin at construction', () => {
    expect(() =>
      createLocalRoutes({
        local: {} as LocalLoginService,
        setup: {} as LocalSetupService,
        sessions: {} as SessionService,
        publicOrigin: `${ORIGIN}/`,
        log: () => undefined,
      }),
    ).toThrow(TypeError);
  });

  it.each([
    [START, { token: SENTINEL.token }],
    [FINISH, { token: SENTINEL.token, password: SENTINEL.password, code: SENTINEL.code }],
    [LOGIN, loginBody],
    [REAUTH, { password: SENTINEL.password, code: SENTINEL.code }],
  ])(
    '%s validates fields before credential or session work without echoing input',
    async (path, body) => {
      const h = await harness();
      const field = Object.keys(body)[0]!;
      const cases = [
        [{ ...body, [SENTINEL.password]: SENTINEL.email }, '/body', 'unrecognized_keys'],
        [
          Object.fromEntries(Object.entries(body).filter(([key]) => key !== field)),
          `/body/${field}`,
          'invalid_type',
        ],
        [
          { ...body, [field]: { [SENTINEL.secret]: SENTINEL.password } },
          `/body/${field}`,
          'invalid_type',
        ],
        [{ ...body, [field]: 'x'.repeat(1025) }, `/body/${field}`, 'too_big'],
      ] as const;
      for (const [invalid, pointer, code] of cases) {
        const response = await h.fetch(post(path, invalid, sessionHeaders));
        expect(response.status).toBe(400);
        expect(setCookies(response)).toEqual([]);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const error = await errorOf(response);
        expect(error).toEqual({
          code: 'invalid_request',
          message: 'Invalid request',
          requestId: response.headers.get('x-request-id'),
          details: [{ path: pointer, code }],
        });
        for (const value of Object.values(SENTINEL)) {
          expect(JSON.stringify(error)).not.toContain(value);
        }
      }
      expect(h.serviceCalls()).toBe(0);
      expect(h.findActive).not.toHaveBeenCalled();
      for (const value of Object.values(SENTINEL)) {
        expect(JSON.stringify(h.entries)).not.toContain(value);
      }
      expect(h.entries.some((entry) => String(entry['event']).startsWith('auth.'))).toBe(false);
    },
  );

  describe('login', () => {
    it('answers 204 with both cookies and no-store on success', async () => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, loginBody, { 'user-agent': 'ua-test' }));

      expect(response.status).toBe(204);
      expect(setCookies(response)).toEqual(COOKIES);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(h.login).toHaveBeenCalledTimes(1);
      const calls = h.login.mock.calls as unknown as [unknown, unknown, unknown][];
      expect(calls[0]?.[0]).toBe(ORG);
      expect(calls[0]?.[1]).toEqual(loginBody);
      expect(calls[0]?.[2]).toMatchObject({ userAgent: 'ua-test', previousSecretHash: null });
    });

    it('answers schema-valid credential failures with one 401 invalid_credentials body', async () => {
      const refused = await harness({ loginResult: REFUSED });
      const bodies: Record<string, unknown>[] = [];
      for (const body of [
        loginBody,
        { ...loginBody, email: 'unknown@example.test' },
        { ...loginBody, password: 'wrong' },
        { ...loginBody, code: '000000' },
        { email: '', password: '', code: '' },
      ]) {
        const response = await refused.fetch(post(LOGIN, body));
        expect(response.status).toBe(401);
        expect(setCookies(response)).toEqual([]);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const error = await errorOf(response);
        delete error['requestId'];
        bodies.push(error);
      }
      expect(bodies[0]).toEqual({ code: 'invalid_credentials', message: 'Invalid credentials' });
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(refused.login).toHaveBeenCalledTimes(5);
    });

    it.each([
      ['array', '[]'],
      ['null', 'null'],
      ['number', '7'],
      ['string', '"x"'],
    ])('refuses a %s body with validation details', async (_name, raw) => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, raw));

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({
        code: 'invalid_request',
        details: [{ path: '/body', code: 'invalid_type' }],
      });
      expect(h.serviceCalls()).toBe(0);
    });

    it.each([
      ['email', { ...loginBody, email: null }],
      ['password', { ...loginBody, password: { a: 1 } }],
      ['code', { ...loginBody, code: 123456 }],
    ])('does not call the service for a non-string %s', async (_name, body) => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, body));

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({
        code: 'invalid_request',
        details: [{ path: `/body/${_name}`, code: 'invalid_type' }],
      });
      expect(h.serviceCalls()).toBe(0);
    });

    it('accepts fields of exactly 1024 characters', async () => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, { ...loginBody, password: 'p'.repeat(1024) }));

      expect(response.status).toBe(204);
      expect(h.login).toHaveBeenCalledTimes(1);
    });

    it('does not mutate a frozen service refusal', async () => {
      const h = await harness({ loginResult: REFUSED });

      const response = await h.fetch(post(LOGIN, loginBody));

      expect(response.status).toBe(401);
      expect(Object.isFrozen(REFUSED)).toBe(true);
      expect(REFUSED).toEqual({ ok: false });
    });
  });

  describe('transport checks', () => {
    it.each([LOGIN, START, FINISH, REAUTH])(
      '%s refuses a cross-site request with 403 before any service call',
      async (path) => {
        const h = await harness();

        const response = await h.fetch(
          post(path, loginBody, { 'sec-fetch-site': 'cross-site', ...sessionHeaders }),
        );

        expect(response.status).toBe(403);
        expect(await errorOf(response)).toMatchObject({ code: 'forbidden' });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(h.serviceCalls()).toBe(0);
        expect(h.findActive).not.toHaveBeenCalled();
      },
    );

    it('refuses a foreign Origin and a request without Origin or Sec-Fetch-Site', async () => {
      const h = await harness();

      const foreign = await h.fetch(post(LOGIN, loginBody, { origin: 'https://evil.example' }));
      const bare = await h.fetch(
        new Request(`${ORIGIN}${LOGIN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(loginBody),
        }),
      );

      expect(foreign.status).toBe(403);
      expect(bare.status).toBe(403);
      expect(h.serviceCalls()).toBe(0);
    });

    it('checks the origin before the body: an oversized cross-site body is 403', async () => {
      const h = await harness();

      const response = await h.fetch(
        post(LOGIN, 'x'.repeat(9 * 1024), { 'sec-fetch-site': 'cross-site' }),
      );

      expect(response.status).toBe(403);
    });

    it.each([LOGIN, START, FINISH])('%s refuses a 9 KiB body with 400', async (path) => {
      const h = await harness();
      const body = JSON.stringify({ ...loginBody, padding: 'x'.repeat(9 * 1024) });

      const response = await h.fetch(post(path, body));

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: 'bad_request' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(h.serviceCalls()).toBe(0);
    });

    it('accepts a body of exactly 8 KiB', async () => {
      const h = await harness();
      const base = JSON.stringify(loginBody);
      const padding = ' '.repeat(8192 - base.length);

      const response = await h.fetch(post(LOGIN, base + padding));

      expect(response.status).toBe(204);
    });

    it('caps a body that lies about its length', async () => {
      const h = await harness();
      const oversized = JSON.stringify({ ...loginBody, padding: 'x'.repeat(9 * 1024) });

      const response = await h.fetch(post(LOGIN, oversized, { 'content-length': '40' }));

      expect(response.status).toBe(400);
      expect(h.serviceCalls()).toBe(0);
    });

    it('refuses a body stream that errors while reading with 400', async () => {
      const h = await harness();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      });
      const request = new Request(`${ORIGIN}${LOGIN}`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body,
        duplex: 'half',
      } as RequestInit);

      const response = await h.fetch(request);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: 'bad_request' });
      expect(h.serviceCalls()).toBe(0);
    });

    it('rejects a declared oversized body without reading it', async () => {
      const h = await harness();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
      const request = new Request(`${ORIGIN}${LOGIN}`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': String(9 * 1024),
        },
        body,
        duplex: 'half',
      } as RequestInit);

      const response = await h.fetch(request);

      expect(response.status).toBe(400);
      expect(pull).not.toHaveBeenCalled();
      expect(h.serviceCalls()).toBe(0);
    });

    it('refuses a body that is not JSON with 400', async () => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, 'email=a&password=b'));

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: 'bad_request' });
      expect(h.serviceCalls()).toBe(0);
    });

    it('refuses invalid UTF-8 and an empty body with 400', async () => {
      const h = await harness();
      const bytes = new Request(`${ORIGIN}${LOGIN}`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
      });

      expect((await h.fetch(bytes)).status).toBe(400);
      expect((await h.fetch(post(LOGIN, ''))).status).toBe(400);
    });

    it.each([
      ['text/plain', 'text/plain'],
      ['form', 'application/x-www-form-urlencoded'],
    ])('refuses content-type %s with 400', async (_name, contentType) => {
      const h = await harness();

      const response = await h.fetch(post(LOGIN, loginBody, { 'content-type': contentType }));

      expect(response.status).toBe(400);
      expect(h.serviceCalls()).toBe(0);
    });

    it('refuses a missing content-type with 400', async () => {
      const h = await harness();
      const request = new Request(`${ORIGIN}${LOGIN}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        body: new Uint8Array(Buffer.from(JSON.stringify(loginBody))),
      });
      request.headers.delete('content-type');

      expect((await h.fetch(request)).status).toBe(400);
    });

    it('accepts application/json with a charset parameter', async () => {
      const h = await harness();

      const response = await h.fetch(
        post(LOGIN, loginBody, { 'content-type': 'Application/JSON; charset=utf-8' }),
      );

      expect(response.status).toBe(204);
    });
  });

  describe('setup', () => {
    it('start answers 200 with the provisioning data and no-store', async () => {
      const h = await harness();

      const response = await h.fetch(post(START, { token: SENTINEL.token }));

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        provisioningUri: SENTINEL.uri,
        secret: SENTINEL.secret,
      });
      expect(h.start).toHaveBeenCalledWith(ORG, SENTINEL.token);
    });

    it('start distinguishes credential refusals from invalid fields', async () => {
      const h = await harness({ startResult: Object.freeze({ ok: false as const }) });

      const refusal = await h.fetch(post(START, { token: SENTINEL.token }));
      const malformed = await h.fetch(post(START, { token: 5 }));
      const missing = await h.fetch(post(START, {}));

      expect(refusal.status).toBe(401);
      expect(await errorOf(refusal)).toMatchObject({ code: 'invalid_credentials' });
      for (const response of [malformed, missing]) {
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toMatchObject({
          code: 'invalid_request',
          details: [{ path: '/body/token', code: 'invalid_type' }],
        });
      }
      expect(h.start).toHaveBeenCalledTimes(1);
    });

    it('finish forwards the session meta of the request', async () => {
      const h = await harness();
      const body = { token: SENTINEL.token, password: SENTINEL.password, code: SENTINEL.code };

      await h.fetch(
        post(FINISH, body, {
          cookie: `__Host-pb_session=${SESSION_SECRET}`,
          'user-agent': 'ua-finish',
        }),
      );

      const calls = h.finish.mock.calls as unknown as [unknown, unknown, unknown][];
      expect(calls[0]?.[2]).toEqual({
        ip: null,
        userAgent: 'ua-finish',
        previousSecretHash: await sha256Hex(SESSION_SECRET),
      });
    });

    it('sets x-request-id on the setup responses it builds itself', async () => {
      const routes = createLocalRoutes({
        local: {} as LocalLoginService,
        setup: {
          start: () =>
            Promise.resolve({ ok: true, provisioningUri: SENTINEL.uri, secret: SENTINEL.secret }),
          finish: () => Promise.resolve({ ok: false, problems: ['too_short'] }),
        } as unknown as LocalSetupService,
        sessions: {} as SessionService,
        publicOrigin: ORIGIN,
        log: () => undefined,
      });
      const context = (path: string, body: unknown) => ({
        request: post(path, body),
        requestId: 'req-77',
        org: ORG,
        principal: null,
        projectId: null,
        params: {},
        ports,
      });

      const started = await routes
        .find((route) => route.path === START)!
        .handler(context(START, { token: SENTINEL.token }));
      const weak = await routes
        .find((route) => route.path === FINISH)!
        .handler(context(FINISH, { token: SENTINEL.token, password: 'x', code: SENTINEL.code }));

      expect(started.status).toBe(200);
      expect(started.headers.get('x-request-id')).toBe('req-77');
      expect(weak.status).toBe(400);
      expect(weak.headers.get('x-request-id')).toBe('req-77');
    });

    it('finish answers 204 with both cookies', async () => {
      const h = await harness();
      const body = { token: SENTINEL.token, password: SENTINEL.password, code: SENTINEL.code };

      const response = await h.fetch(post(FINISH, body));

      expect(response.status).toBe(204);
      expect(setCookies(response)).toEqual(COOKIES);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const calls = h.finish.mock.calls as unknown as [unknown, unknown, unknown][];
      expect(calls[0]?.[1]).toEqual(body);
    });

    it('finish answers 400 weak_password with the problems', async () => {
      const h = await harness({
        finishResult: Object.freeze({
          ok: false as const,
          problems: Object.freeze(['too_short', 'equals_email'] as const),
        }),
      });

      const response = await h.fetch(
        post(FINISH, { token: SENTINEL.token, password: 'x', code: SENTINEL.code }),
      );

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(weakPasswordErrorResponse.safeParse({ error }).success).toBe(true);
      expect(error).toMatchObject({
        code: 'weak_password',
        problems: ['too_short', 'equals_email'],
      });
      expect(setCookies(response)).toEqual([]);
    });

    it('finish distinguishes credential refusals from invalid fields', async () => {
      const h = await harness({ finishResult: Object.freeze({ ok: false as const }) });
      const body = { token: SENTINEL.token, password: SENTINEL.password, code: SENTINEL.code };

      const refusal = await h.fetch(post(FINISH, body));
      const badToken = await h.fetch(post(FINISH, { ...body, token: ['x'] }));
      const badPassword = await h.fetch(post(FINISH, { ...body, password: null }));
      const badCode = await h.fetch(post(FINISH, { ...body, code: 1 }));

      expect(refusal.status).toBe(401);
      expect(await errorOf(refusal)).toMatchObject({ code: 'invalid_credentials' });
      for (const [response, field] of [
        [badToken, 'token'],
        [badPassword, 'password'],
        [badCode, 'code'],
      ] as const) {
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toMatchObject({
          code: 'invalid_request',
          details: [{ path: `/body/${field}`, code: 'invalid_type' }],
        });
      }
      expect(h.finish).toHaveBeenCalledTimes(1);
    });
  });

  describe('reauth', () => {
    it('maps session_inactive to the existing inactive-session refusal byte-for-byte', async () => {
      const h = await harness({ reauthResult: { ok: false, reason: 'session_inactive' } });
      const requestId = '00000000-0000-4000-8000-000000000000';
      const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
      try {
        const response = await h.fetch(post(REAUTH, body, sessionHeaders));
        h.findActive.mockResolvedValue(null);
        const inactive = await h.fetch(post(REAUTH, body, sessionHeaders));

        expect(response.status).toBe(401);
        expect(response.status).toBe(inactive.status);
        expect([...response.headers]).toEqual([...inactive.headers]);
        expect(await response.clone().json()).toEqual({
          error: { code: 'unauthorized', message: 'Unauthorized', requestId },
        });
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          new Uint8Array(await inactive.arrayBuffer()),
        );
        expect(setCookies(response)).toEqual([]);
        expect(h.reauth).toHaveBeenCalledTimes(1);
        expect(h.entries).toContainEqual(
          expect.objectContaining({
            event: 'auth.reauth.refused',
            reason: 'session_inactive',
          }),
        );
      } finally {
        randomUUID.mockRestore();
      }
    });

    const body = { password: SENTINEL.password, code: SENTINEL.code };

    it('answers 204 for the session resolved through the session service', async () => {
      const h = await harness();

      const response = await h.fetch(post(REAUTH, body, sessionHeaders));

      expect(response.status).toBe(204);
      expect(setCookies(response)).toEqual([]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(h.findActive).toHaveBeenCalledTimes(1);
      const [, hash, cutoffs] = h.findActive.mock.calls[0] as unknown as [
        unknown,
        string,
        { now: string; idleSince: string },
      ];
      expect(hash).toBe(await sha256Hex(SESSION_SECRET));
      expect(cutoffs.now).toBe(NOW);
      expect(Date.parse(cutoffs.now) - Date.parse(cutoffs.idleSince)).toBe(3_600_000);
      const calls = h.reauth.mock.calls as unknown as [
        unknown,
        { session: ActiveSession },
        unknown,
      ][];
      expect(calls[0]?.[0]).toBe(ORG);
      expect(calls[0]?.[1].session.userId).toBe('01J0USERA0000000000000000A');
      expect(calls[0]?.[2]).toEqual(body);
    });

    it('answers 401 without a session and never calls the service', async () => {
      const h = await harness();

      const noCookie = await h.fetch(post(REAUTH, body, { 'x-csrf-token': CSRF_TOKEN }));
      const expired = await harness({ session: null });
      const unknown = await expired.fetch(post(REAUTH, body, sessionHeaders));

      expect(noCookie.status).toBe(401);
      expect(await errorOf(noCookie)).toMatchObject({ code: 'unauthorized' });
      expect(unknown.status).toBe(401);
      expect(h.reauth).not.toHaveBeenCalled();
      expect(expired.reauth).not.toHaveBeenCalled();
    });

    it('answers 403 without a CSRF token and with a wrong one', async () => {
      const h = await harness();

      const missing = await h.fetch(post(REAUTH, body, { cookie: sessionHeaders.cookie }));
      const wrong = await h.fetch(
        post(REAUTH, body, { cookie: sessionHeaders.cookie, 'x-csrf-token': 'W'.repeat(43) }),
      );

      expect(missing.status).toBe(403);
      expect(await errorOf(missing)).toMatchObject({ code: 'forbidden' });
      expect(wrong.status).toBe(403);
      expect(h.reauth).not.toHaveBeenCalled();
    });

    it('maps a CsrfError thrown by the session service to 403', async () => {
      const sessions = {
        authenticate: () =>
          Promise.resolve({ session: activeSession(), principal: { kind: 'user', id: 'u' } }),
        assertCsrf: () => Promise.reject(new CsrfError('token_mismatch')),
      } as unknown as SessionService;
      const h = await harness({ sessions });

      const response = await h.fetch(post(REAUTH, body, sessionHeaders));

      expect(response.status).toBe(403);
      expect(h.reauth).not.toHaveBeenCalled();
    });

    it('reauth distinguishes credential refusals from invalid fields', async () => {
      const h = await harness({ reauthResult: Object.freeze({ ok: false }) });

      const refused = await h.fetch(post(REAUTH, body, sessionHeaders));
      const malformed = await h.fetch(post(REAUTH, { ...body, code: 12 }, sessionHeaders));

      expect(refused.status).toBe(401);
      expect(await errorOf(refused)).toMatchObject({ code: 'invalid_credentials' });
      expect(malformed.status).toBe(400);
      expect(await errorOf(malformed)).toMatchObject({
        code: 'invalid_request',
        details: [{ path: '/body/code', code: 'invalid_type' }],
      });
      expect(h.reauth).toHaveBeenCalledTimes(1);
    });

    it('answers 400 for an oversized body once the session is valid', async () => {
      const h = await harness();

      const response = await h.fetch(
        post(REAUTH, JSON.stringify({ ...body, padding: 'x'.repeat(9 * 1024) }), sessionHeaders),
      );

      expect(response.status).toBe(400);
      expect(h.reauth).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('sends the setup user id to the observability sink', async () => {
      const records: ObsRecord[] = [];
      const h = await harness({ sink: { emit: (record) => void records.push(record) } });
      const response = await h.fetch(
        post(FINISH, {
          token: SENTINEL.token,
          password: SENTINEL.password,
          code: SENTINEL.code,
        }),
      );
      expect(response.status).toBe(204);
      expect(records).toContainEqual({
        kind: 'log',
        record: expect.objectContaining({
          event: 'auth.local.setup.completed',
          user_id: GRANTED.userId,
        }),
      });
    });

    it('sends the reauthentication session id to the observability sink', async () => {
      const records: ObsRecord[] = [];
      const h = await harness({ sink: { emit: (record) => void records.push(record) } });
      const response = await h.fetch(
        post(
          REAUTH,
          {
            password: SENTINEL.password,
            code: SENTINEL.code,
          },
          sessionHeaders,
        ),
      );
      expect(response.status).toBe(204);
      expect(records).toContainEqual({
        kind: 'log',
        record: expect.objectContaining({
          event: 'auth.reauth.succeeded',
          session_id: activeSession().id,
        }),
      });
    });

    function assertNoSentinels(entries: readonly Entry[]): void {
      const logged = JSON.stringify(entries);
      for (const value of Object.values(SENTINEL)) {
        expect(logged).not.toContain(value);
      }
      expect(logged).not.toContain(SESSION_SECRET);
      expect(logged).not.toContain(CSRF_TOKEN);
      expect(logged).not.toContain('__Host-pb');
    }

    it('never logs the body, the cookies or the setup response across every route and outcome', async () => {
      const ok = await harness();
      const refused = await harness({
        loginResult: REFUSED,
        reauthResult: { ok: false },
        startResult: { ok: false },
        finishResult: { ok: false, problems: ['too_short'] },
      });
      const body = { token: SENTINEL.token, password: SENTINEL.password, code: SENTINEL.code };
      const reauthBody = { password: SENTINEL.password, code: SENTINEL.code };

      for (const h of [ok, refused]) {
        await h.fetch(post(LOGIN, loginBody));
        await h.fetch(post(LOGIN, { ...loginBody, code: 5 }));
        await h.fetch(post(LOGIN, `not json ${SENTINEL.password}`));
        await h.fetch(post(START, body));
        await h.fetch(post(FINISH, body));
        await h.fetch(post(REAUTH, reauthBody, sessionHeaders));
        await h.fetch(post(LOGIN, loginBody, { 'sec-fetch-site': 'cross-site' }));
      }

      expect(ok.entries.length + refused.entries.length).toBeGreaterThan(0);
      assertNoSentinels(ok.entries);
      assertNoSentinels(refused.entries);
    });

    it('does not log service errors beyond the kernel error name', async () => {
      const h = await harness();
      h.login.mockRejectedValueOnce(
        new DbError('unknown', `failure for ${SENTINEL.email} ${SENTINEL.password}`),
      );

      const response = await h.fetch(post(LOGIN, loginBody));

      expect(response.status).toBe(500);
      assertNoSentinels(h.entries);
      expect(h.entries.some((entry) => entry['error_name'] === 'DbError')).toBe(true);
    });

    it('survives a throwing log sink', async () => {
      const routes = createLocalRoutes({
        local: {
          login: () => Promise.resolve(GRANTED),
          reauth: () => Promise.resolve({ ok: true }),
        } as unknown as LocalLoginService,
        setup: {} as LocalSetupService,
        sessions: {} as SessionService,
        publicOrigin: ORIGIN,
        log: () => {
          throw new Error('sink down');
        },
      });
      const login = routes.find((route) => route.path === LOGIN)!;
      const request = post(LOGIN, loginBody);

      const response = await login.handler({
        request,
        requestId: 'req-1',
        org: ORG,
        principal: null,
        projectId: null,
        params: {},
        ports,
      });

      expect(response.status).toBe(204);
    });
  });
});
