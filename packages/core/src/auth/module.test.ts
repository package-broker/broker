import { describe, expect, it, vi } from 'vitest';
import {
  createAuthModule,
  parseLocalAuthPolicy,
  validateLocalAuthPolicy,
  type AuthModuleOptions,
  type AuthRepositories,
} from './module.js';
import { sealLoginState } from './login-state.js';
import type { LocalLoginSnapshot } from '../db/local-login.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession } from '../db/sessions.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import { KernelConfigError } from '../kernel/registry.js';
import type { HookMap, RequestContext } from '../plugin.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createKeyring } from '../secrets/keyring.js';

const origin = 'https://broker.test';
const clock = fixedClock('2026-10-21T12:00:00.000Z');
const org = orgContext('org-1');
const identity: VerifiedIdentity = {
  provider: 'oidc',
  subject: 'subject-1',
  email: 'account@example.test',
  emailVerified: true,
  displayName: null,
  groups: [],
  issuedAt: clock.now().toISOString(),
  authTime: clock.now().toISOString(),
};
const provider: IdentityProvider = {
  id: 'oidc',
  kind: 'oidc',
  displayName: 'SSO',
  trustAnchor: 'oidc:https://identity.test',
  policy: { verifiedDomains: ['example.test'], autoJoin: true },
  supportsReauth: true,
  start: () => Promise.resolve({ kind: 'direct' }),
  finish: () => Promise.resolve({ ok: true, identity }),
};
const snapshot: LocalLoginSnapshot = {
  userId: 'user-1',
  email: identity.email,
  userActive: true,
  adminEligible: true,
  passwordHash: 'invalid-hash',
  totpCredentialId: 'credential-1',
  totpEnabled: true,
  totpState: 'enabled',
  totpLastStep: null,
  credentialRev: 1,
  failedCount: 4,
  lockedUntil: null,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  resolve?: HookMap['auth.resolveIdentity'],
  map?: HookMap['auth.mapGroups'],
  overrides: Partial<AuthModuleOptions> = {},
) {
  const log = vi.fn<(entry: Readonly<Record<string, unknown>>) => void>();
  const session: ActiveSession = {
    id: 'session-1',
    userId: 'user-1',
    identityId: 'identity-1',
    csrfHash: '',
    createdAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    lastSeenAt: clock.now().toISOString(),
    reauthAt: null,
    user: { id: 'user-1', email: identity.email, displayName: null },
  };
  const reserveAttempt = vi.fn<AuthRepositories['localReader']['reserveAttempt']>(
    (_ctx, _userId, _now, lockedUntil) =>
      Promise.resolve({ reserved: true, snapshot: { ...snapshot, failedCount: 5, lockedUntil } }),
  );
  const repositories = {
    bindings: { anchor: () => Promise.resolve(provider.trustAnchor) },
    sessions: { findActiveById: () => Promise.resolve(session) },
    localReader: {
      findByEmail: () => Promise.resolve(snapshot),
      reserveAttempt,
    },
    credentials: { get: () => Promise.resolve(null) },
    users: {
      getIdentity: () =>
        Promise.resolve({
          id: 'identity-1',
          userId: 'user-1',
          provider: provider.id,
          subject: identity.subject,
          email: identity.email,
          validatedAt: null,
        }),
      lookupForLogin: () =>
        Promise.resolve({
          boundAnchor: null,
          identity: null,
          identityUser: null,
          userByEmail: null,
          invited: false,
        }),
    },
    login: { commit: () => Promise.resolve('committed') },
  } as unknown as AuthRepositories;
  const options: AuthModuleOptions = {
    repositories,
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
    clock,
    ids: { ulid: () => '01K7R5V0000000000000000001' },
    publicOrigin: origin,
    clientIp: () => null,
    providers: new Map([[provider.id, provider]]),
    hooks: {
      'access.check': [],
      'auth.resolveIdentity':
        resolve === undefined ? [] : [{ plugin: 'resolve', handler: resolve }],
      'auth.mapGroups': map === undefined ? [] : [{ plugin: 'map', handler: map }],
    },
    log,
    ...overrides,
  };
  const auth = createAuthModule(options);
  const send = async (
    requestId: string,
    path = '/_pb/auth/sso/oidc/start',
    body: object = { purpose: 'login' },
    headers: Record<string, string> = {},
  ) => {
    const route = auth.coreRoutes.find(
      (route) => route.path === path.replace('/oidc/', '/:provider/'),
    );
    if (route === undefined) throw new Error('missing route');
    const ctx: RequestContext = {
      request: new Request(`${origin}${path}`, {
        method: route.method,
        headers: { origin, 'content-type': 'application/json', ...headers },
        ...(route.method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
      requestId,
      org,
      principal: null,
      projectId: null,
      params: { provider: provider.id },
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock,
        ids: options.ids,
      },
    };
    return route.handler(ctx);
  };
  const records = (event: string) =>
    log.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === event);
  const reauth = async (requestId: string) => {
    vi.spyOn(auth.sessions, 'authenticate').mockResolvedValue({
      principal: { kind: 'user', id: 'user-1' },
      session,
    });
    const cookie = await sealLoginState(createSecretCipher(options.keyring, 'login-state'), {
      provider: provider.id,
      purpose: 'reauth',
      sessionId: 'session-1',
      returnTo: '/',
      issuedAt: clock.now().getTime(),
      data: {},
    });
    return send(requestId, '/_pb/auth/sso/oidc/callback', {}, { cookie: cookie.split(';')[0]! });
  };
  return { send, reauth, records, reserveAttempt };
}

describe('local auth policy', () => {
  it.each([
    [undefined, 'enabled'],
    ['enabled', 'enabled'],
    ['disabled', 'disabled'],
  ] as const)('parses %s as %s', (value, expected) => {
    expect(parseLocalAuthPolicy(value)).toBe(expected);
  });

  it.each([
    '',
    'ENABLED',
    'Disabled',
    ' enabled',
    'disabled ',
    'enabled\n',
    'break-glass',
    'https://account:credential@example.test',
    null,
    true,
    false,
    0,
    1,
    {},
    ['enabled'],
    new String('enabled'),
    Symbol('credential'),
  ])('rejects invalid input %# with a safe configuration reason', (value) => {
    expect(() => parseLocalAuthPolicy(value)).toThrow(KernelConfigError);
    expect(() => parseLocalAuthPolicy(value)).toThrow(/^auth_local_invalid$/);
  });

  it('does not coerce an invalid binding', () => {
    const toString = vi.fn(() => {
      throw new Error('credential');
    });
    expect(() => parseLocalAuthPolicy({ toString })).toThrow(/^auth_local_invalid$/);
    expect(toString).not.toHaveBeenCalled();
  });

  it('requires a constructed provider only when disabled', () => {
    const empty = new Map<string, IdentityProvider>();
    expect(() => validateLocalAuthPolicy('enabled', empty)).not.toThrow();
    expect(() => validateLocalAuthPolicy('disabled', empty)).toThrow(KernelConfigError);
    expect(() => validateLocalAuthPolicy('disabled', empty)).toThrow(/^auth_no_sign_in_method$/);
    expect(() =>
      validateLocalAuthPolicy('disabled', new Map([[provider.id, provider]])),
    ).not.toThrow();
  });

  it.each([undefined, 'enabled'] as const)(
    'preserves local sign-in with %s policy and no SSO provider',
    async (localAuth) => {
      const app = fixture(undefined, undefined, {
        providers: new Map(),
        ...(localAuth === undefined ? {} : { localAuth }),
      });
      const response = await app.send('request-providers', '/_pb/auth/providers');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ local: true, providers: [] });
    },
  );

  it('validates disabled policy during module assembly', () => {
    expect(() => fixture(undefined, undefined, { localAuth: 'disabled' })).not.toThrow();
    expect(() =>
      fixture(undefined, undefined, { localAuth: 'disabled', providers: new Map() }),
    ).toThrow(/^auth_no_sign_in_method$/);
  });

  it('rejects invalid policy supplied by an untyped module caller', () => {
    expect(() =>
      fixture(undefined, undefined, {
        localAuth: '' as NonNullable<AuthModuleOptions['localAuth']>,
      }),
    ).toThrow(/^auth_local_invalid$/);
  });
});

describe('auth module request correlation', () => {
  it('attributes an account lockout to the login request', async () => {
    const app = fixture();
    expect(
      (
        await app.send('request-lock', '/_pb/auth/local/login', {
          email: identity.email,
          password: 'incorrect-password',
          code: '000000',
        })
      ).status,
    ).toBe(401);
    expect(app.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(app.records('auth.local.locked')).toEqual([
      {
        level: 'warn',
        event: 'auth.local.locked',
        reason: 'attempts',
        user_id: 'user-1',
        request_id: 'request-lock',
      },
    ]);
  });

  it('attributes a throwing identity hook to the request', async () => {
    const app = fixture(() => {
      throw new TypeError('hook failed');
    });
    expect((await app.send('request-error')).status).toBe(401);
    expect(app.records('auth.hook.error')).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.error',
        pluginId: 'resolve',
        error: 'TypeError',
        request_id: 'request-error',
      },
    ]);
  });

  it('attributes a denying identity hook to the request', async () => {
    const app = fixture(() => ({ deny: true }));
    expect((await app.send('request-denied')).status).toBe(401);
    expect(app.records('auth.hook.denied')).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.denied',
        pluginId: 'resolve',
        code: 'denied',
        request_id: 'request-denied',
      },
    ]);
  });

  it('attributes a throwing group hook to the request', async () => {
    const app = fixture(undefined, () => {
      throw new Error('hook failed');
    });
    expect((await app.send('request-groups')).status).toBe(401);
    expect(app.records('auth.hook.error')).toEqual([
      {
        level: 'warn',
        event: 'auth.hook.error',
        pluginId: 'map',
        error: 'Error',
        request_id: 'request-groups',
      },
    ]);
  });

  it.each(['throwing', 'denying'] as const)(
    'attributes a %s reauthentication hook to the callback request',
    async (mode) => {
      const app = fixture(() => {
        if (mode === 'throwing') throw new TypeError('hook failed');
        return { deny: true };
      });
      expect((await app.reauth('request-reauth')).status).toBe(401);
      if (mode === 'throwing') {
        expect(app.records('auth.hook.error')).toEqual([
          expect.objectContaining({
            request_id: 'request-reauth',
            pluginId: 'resolve',
            error: 'TypeError',
          }),
        ]);
      }
      expect(app.records('auth.hook.denied')).toEqual([
        expect.objectContaining({
          request_id: 'request-reauth',
          code: mode === 'throwing' ? 'hook_error' : 'denied',
        }),
      ]);
    },
  );

  it('keeps request ids separate when identity hooks finish out of order', async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const app = fixture(async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        throw new TypeError('hook failed');
      }
      return { deny: true };
    });
    const first = app.send('request-first');
    await entered.promise;
    try {
      expect((await app.send('request-second')).status).toBe(401);
    } finally {
      release.resolve();
    }
    expect((await first).status).toBe(401);
    expect(app.records('auth.hook.error')).toEqual([
      expect.objectContaining({ request_id: 'request-first' }),
    ]);
    expect(app.records('auth.hook.denied').map((entry) => [entry.code, entry.request_id])).toEqual([
      ['denied', 'request-second'],
      ['hook_error', 'request-first'],
    ]);
  });

  it('uses request_id for route events after a successful login', async () => {
    const app = fixture();
    expect((await app.send('01K7R5V0000000000000000002')).status).toBe(303);
    expect(app.records('auth.login.succeeded')).toEqual([
      {
        level: 'info',
        event: 'auth.login.succeeded',
        provider: 'oidc',
        userId: '01K7R5V0000000000000000001',
        sessionId: '01K7R5V0000000000000000001',
        request_id: '01K7R5V0000000000000000002',
      },
    ]);
  });
});
