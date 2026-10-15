import { afterEach, describe, expect, it, vi } from 'vitest';
import { reauthenticateWithIdentity as reauthenticate } from './identity-reauth.js';
import type {
  IdentityReauthDeps,
  ReauthLoginState,
  ReauthRefusal,
  ReauthResult,
} from './identity-reauth.js';
import type { AuthenticatedSession } from './session.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession, SessionRepository } from '../db/sessions.js';
import type { StoredIdentity, UserRepository } from '../db/users.js';
import type { Clock } from '../ids.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import type { Registration } from '../kernel/registry.js';
import type { HookMap } from '../plugin.js';

const NOW_MS = Date.parse('2026-10-15T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const CTX = orgContext('01J0ORG0000000000000000001');
const USER_ID = '01J0USERA0000000000000000A';
const IDENTITY_ID = '01J0IDENTITY000000000000I1';
const SESSION_ID = '01J0SESSION00000000000000S1';
const EMAIL = 'ada@example.test';
const LOGIN_STATE_ISSUED_AT = NOW_MS - 150_000;

type ResolveHook = Registration['hooks']['auth.resolveIdentity'][number];
type ResolveHandler = HookMap['auth.resolveIdentity'];

const clock: Clock = { now: () => new Date(NOW_MS) };

function iso(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function sessionOf(
  identityId: string | null = IDENTITY_ID,
  sessionId: string = SESSION_ID,
): AuthenticatedSession {
  const session: ActiveSession = {
    id: sessionId,
    userId: USER_ID,
    identityId,
    csrfHash: 'a'.repeat(64),
    createdAt: iso(-3_600_000),
    expiresAt: iso(3_600_000),
    lastSeenAt: iso(-60_000),
    reauthAt: null,
    user: { id: USER_ID, email: EMAIL, displayName: 'Ada' },
  };
  return { session, principal: { kind: 'user', id: USER_ID } };
}

function storedIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  return {
    id: IDENTITY_ID,
    userId: USER_ID,
    provider: 'oidc-main',
    subject: 'subject-1',
    email: EMAIL,
    validatedAt: iso(-86_400_000),
    ...overrides,
  };
}

function providerOf(overrides: Partial<IdentityProvider> = {}): IdentityProvider {
  return {
    id: 'oidc-main',
    kind: 'oidc',
    displayName: 'Main',
    trustAnchor: 'oidc:https://idp.example.test',
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
    supportsReauth: true,
    start: () => Promise.reject(new Error('unexpected start')),
    finish: () => Promise.reject(new Error('unexpected finish')),
    ...overrides,
  };
}

function verified(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    provider: 'oidc-main',
    subject: 'subject-1',
    email: EMAIL,
    emailVerified: true,
    displayName: 'Ada',
    groups: ['staff'],
    issuedAt: iso(-30_000),
    authTime: iso(-120_000),
    ...overrides,
  };
}

function loginStateOf(overrides: Partial<ReauthLoginState> = {}): ReauthLoginState {
  return {
    provider: 'oidc-main',
    purpose: 'reauth',
    sessionId: SESSION_ID,
    issuedAt: LOGIN_STATE_ISSUED_AT,
    ...overrides,
  };
}

function run(
  deps: IdentityReauthDeps,
  ctx: typeof CTX,
  session: AuthenticatedSession,
  provider: IdentityProvider,
  identity: VerifiedIdentity,
  loginState: ReauthLoginState = loginStateOf(),
): Promise<ReauthResult> {
  return reauthenticate(deps, ctx, session, provider, identity, loginState);
}

function resolving(plugin: string, handler: ResolveHandler): ResolveHook {
  return { plugin, handler };
}

interface MarkInput {
  readonly sessionId: string;
  readonly identityId: string | null;
  readonly authTime: string;
  readonly now: string;
}

interface Setup {
  readonly stored?: StoredIdentity | null;
  readonly hooks?: readonly ResolveHook[];
  readonly onHookError?: (event: { readonly plugin: string; readonly error: unknown }) => void;
  readonly storedReauthAt?: string | null;
  readonly onDenied?: IdentityReauthDeps['onDenied'];
}

function setup(options: Setup = {}) {
  const stored = options.stored === undefined ? storedIdentity() : options.stored;
  const reauthAtBySession = new Map<string, string>();
  if (options.storedReauthAt != null) reauthAtBySession.set(SESSION_ID, options.storedReauthAt);
  const getIdentity = vi.fn(() => Promise.resolve(stored));
  const mark = vi.fn((_ctx: unknown, input: MarkInput) => {
    const current = reauthAtBySession.get(input.sessionId) ?? null;
    const changed =
      input.identityId === IDENTITY_ID &&
      input.authTime <= input.now &&
      (current === null || input.authTime > current);
    if (changed) reauthAtBySession.set(input.sessionId, input.authTime);
    return Promise.resolve(changed);
  });
  const unexpected = (name: string) => vi.fn(() => Promise.reject(new Error(`unexpected ${name}`)));
  const users = {
    getIdentity,
    lookupForLogin: unexpected('lookupForLogin'),
    get: unexpected('get'),
    list: unexpected('list'),
  } as unknown as UserRepository;
  const sessions = {
    markReauthenticatedByIdentity: mark,
    findActive: unexpected('findActive'),
    touch: unexpected('touch'),
    revoke: unexpected('revoke'),
    revokeBySecretHash: unexpected('revokeBySecretHash'),
    deleteExpired: unexpected('deleteExpired'),
  } as unknown as SessionRepository;
  const hooks = { 'auth.resolveIdentity': options.hooks ?? [] };
  const deps: IdentityReauthDeps = {
    users,
    sessions,
    clock,
    hooks,
    ...(options.onHookError === undefined ? {} : { onHookError: options.onHookError }),
    ...(options.onDenied === undefined ? {} : { onDenied: options.onDenied }),
  };
  return {
    deps,
    getIdentity,
    mark,
    storedReauthAt: (sessionId: string = SESSION_ID) => reauthAtBySession.get(sessionId) ?? null,
  };
}

describe('reauthenticateWithIdentity', () => {
  describe('success', () => {
    it('marks the session with the provider authTime, not the clock', async () => {
      const fixture = setup();
      const identity = verified({ authTime: iso(-120_000) });

      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);

      expect(result).toEqual({ ok: true });
      expect(fixture.getIdentity).toHaveBeenCalledTimes(1);
      expect(fixture.getIdentity).toHaveBeenCalledWith(CTX, IDENTITY_ID);
      expect(fixture.mark).toHaveBeenCalledTimes(1);
      expect(fixture.mark).toHaveBeenCalledWith(CTX, {
        sessionId: SESSION_ID,
        identityId: IDENTITY_ID,
        authTime: iso(-120_000),
        now: NOW.toISOString(),
      });
      expect(fixture.storedReauthAt()).toBe(iso(-120_000));
    });

    it('accepts an authTime of exactly ten minutes ago', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: iso(-600_000) }),
        loginStateOf({ issuedAt: NOW_MS - 600_000 }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('accepts an authTime equal to the clock', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: NOW.toISOString() }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('runs the resolveIdentity hooks with the session user id', async () => {
      const handler = vi.fn(() => undefined);
      const fixture = setup({ hooks: [resolving('plugin-a', handler)] });
      const identity = verified();

      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);

      expect(result).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(1);
      const input = (handler.mock.calls[0] as unknown[])[0] as {
        org: unknown;
        userId: unknown;
        identity: unknown;
      };
      expect(input.org).toEqual(CTX);
      expect(input.userId).toBe(USER_ID);
      expect(input.identity).toEqual(identity);
    });
  });

  describe('not_sso_session', () => {
    it('refuses a session without an identity before any repository call', async () => {
      const fixture = setup();
      const result = await run(fixture.deps, CTX, sessionOf(null), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'not_sso_session' });
      expect(fixture.getIdentity).not.toHaveBeenCalled();
      expect(fixture.mark).not.toHaveBeenCalled();
    });
  });

  describe('identity_mismatch', () => {
    it.each([
      ['another subject', verified({ subject: 'subject-2' }), providerOf()],
      ['another provider on the identity', verified({ provider: 'oidc-other' }), providerOf()],
      ['a provider object with another id', verified(), providerOf({ id: 'oidc-other' })],
      ['a subject differing only in case', verified({ subject: 'Subject-1' }), providerOf()],
    ])('refuses %s', async (_label, identity, provider) => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        provider,
        identity,
        loginStateOf({ provider: provider.id }),
      );
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('refuses when the stored identity does not exist in this organization', async () => {
      const fixture = setup({ stored: null });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('is decided before authTime is looked at', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ subject: 'subject-2', authTime: null }),
      );
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
    });
  });

  describe('no_auth_time', () => {
    it('refuses a fresh issuedAt without an authTime', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ issuedAt: NOW.toISOString(), authTime: null }),
      );
      expect(result).toEqual({ ok: false, reason: 'no_auth_time' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });
  });

  describe('stale_auth_time', () => {
    it.each([
      ['ten minutes and one millisecond old', iso(-600_001)],
      ['an hour old', iso(-3_600_000)],
      ['one millisecond in the future', iso(1)],
      ['a minute in the future', iso(60_000)],
      ['far in the future', iso(86_400_000)],
      ['not a timestamp', 'yesterday'],
      ['an empty string', ''],
      ['a timestamp with an offset', '2026-10-15T13:58:00.000+02:00'],
      ['a timestamp without milliseconds', '2026-10-15T11:58:00Z'],
      ['a calendar date that does not exist', '2026-02-31T11:58:00.000Z'],
    ])('refuses an authTime that is %s', async (_label, authTime) => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime }),
      );
      expect(result).toEqual({ ok: false, reason: 'stale_auth_time' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('does not run hooks for a stale authTime', async () => {
      const handler = vi.fn(() => undefined);
      const fixture = setup({ hooks: [resolving('plugin-a', handler)] });
      await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: iso(-700_000) }),
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('policy', () => {
    it.each([
      ['an unverified e-mail', verified({ emailVerified: false }), providerOf()],
      [
        'an e-mail outside the verified domains',
        verified({ email: 'ada@other.test' }),
        providerOf(),
      ],
      [
        'a provider with no verified domain',
        verified(),
        providerOf({ policy: { verifiedDomains: [], autoJoin: false } }),
      ],
    ])('refuses %s', async (_label, identity, provider) => {
      const handler = vi.fn(() => undefined);
      const fixture = setup({
        stored: storedIdentity({ email: identity.email }),
        hooks: [resolving('plugin-a', handler)],
      });
      const result = await run(fixture.deps, CTX, sessionOf(), provider, identity);
      expect(result).toEqual({ ok: false, reason: 'policy' });
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.mark).not.toHaveBeenCalled();
    });
  });

  describe('hook_denied', () => {
    it('refuses when a hook denies and never marks the session', async () => {
      const fixture = setup({
        hooks: [resolving('plugin-a', () => ({ deny: true, reason: 'blocked by plugin-a' }))],
      });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'hook_denied' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('fails closed when a hook throws, and reports the error through onHookError', async () => {
      const onHookError = vi.fn();
      const failure = new Error('hook exploded');
      const fixture = setup({
        hooks: [
          resolving('plugin-a', () => {
            throw failure;
          }),
        ],
        onHookError,
      });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'hook_denied' });
      expect(onHookError).toHaveBeenCalledWith({ plugin: 'plugin-a', error: failure });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('fails closed on a malformed hook result', async () => {
      const fixture = setup({
        hooks: [resolving('plugin-a', (() => ({ allow: true })) as unknown as ResolveHandler)],
      });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'hook_denied' });
    });
  });

  describe('not_updated', () => {
    it('refuses the same authentication event the second time (C9)', async () => {
      const fixture = setup();
      const identity = verified({ authTime: iso(-120_000) });
      const first = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);
      const second = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);
      expect(first).toEqual({ ok: true });
      expect(second).toEqual({ ok: false, reason: 'not_updated' });
      expect(fixture.mark).toHaveBeenCalledTimes(2);
      expect(fixture.storedReauthAt()).toBe(iso(-120_000));
    });

    it('refuses an authTime older than the stored reauth_at and accepts a later one', async () => {
      const fixture = setup({ storedReauthAt: iso(-100_000) });
      const older = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: iso(-200_000) }),
      );
      const later = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: iso(-50_000) }),
      );
      expect(older).toEqual({ ok: false, reason: 'not_updated' });
      expect(later).toEqual({ ok: true });
      expect(fixture.storedReauthAt()).toBe(iso(-50_000));
    });

    it('keeps the monotonic state per session', async () => {
      const other = '01J0SESSION00000000000000S2';
      const fixture = setup();
      const identity = verified({ authTime: iso(-120_000) });
      const otherState = loginStateOf({ sessionId: other });

      const first = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);
      const second = await run(
        fixture.deps,
        CTX,
        sessionOf(IDENTITY_ID, other),
        providerOf(),
        identity,
        otherState,
      );
      const firstAgain = await run(fixture.deps, CTX, sessionOf(), providerOf(), identity);

      expect(first).toEqual({ ok: true });
      expect(second).toEqual({ ok: true });
      expect(firstAgain).toEqual({ ok: false, reason: 'not_updated' });
      expect(fixture.storedReauthAt(other)).toBe(iso(-120_000));
    });
  });

  describe('not_supported', () => {
    it('refuses a provider without re-authentication support before any lookup', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf({ supportsReauth: false }),
        verified(),
      );
      expect(result).toEqual({ ok: false, reason: 'not_supported' });
      expect(fixture.getIdentity).not.toHaveBeenCalled();
      expect(fixture.mark).not.toHaveBeenCalled();
    });
  });

  describe('login state', () => {
    it.each([
      ['another provider id', loginStateOf({ provider: 'oidc-other' })],
      ['a login purpose', loginStateOf({ purpose: 'login' })],
      ['an unknown purpose', loginStateOf({ purpose: 'REAUTH' })],
      ['another session id', loginStateOf({ sessionId: '01J0SESSION00000000000000S2' })],
      ['no session id', loginStateOf({ sessionId: null })],
      ['a fractional issuedAt', loginStateOf({ issuedAt: LOGIN_STATE_ISSUED_AT + 0.5 })],
      ['a NaN issuedAt', loginStateOf({ issuedAt: Number.NaN })],
    ])('refuses %s before any lookup', async (_label, loginState) => {
      const handler = vi.fn(() => undefined);
      const fixture = setup({ hooks: [resolving('plugin-a', handler)] });
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified(),
        loginState,
      );
      expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
      expect(fixture.getIdentity).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('refuses a login state of another provider even when the identity matches it', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ provider: 'oidc-other' }),
        loginStateOf({ provider: 'oidc-other' }),
      );
      expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
    });

    it('refuses an authTime before the re-authentication started', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: iso(-200_000) }),
        loginStateOf({ issuedAt: NOW_MS - 100_000 }),
      );
      expect(result).toEqual({ ok: false, reason: 'stale_auth_time' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('allows an authTime exactly a minute before the re-authentication started', async () => {
      const fixture = setup();
      const issuedAt = NOW_MS - 100_000;
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: new Date(issuedAt - 60_000).toISOString() }),
        loginStateOf({ issuedAt }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('refuses an authTime one millisecond more than a minute before the start', async () => {
      const fixture = setup();
      const issuedAt = NOW_MS - 100_000;
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ authTime: new Date(issuedAt - 60_001).toISOString() }),
        loginStateOf({ issuedAt }),
      );
      expect(result).toEqual({ ok: false, reason: 'stale_auth_time' });
    });
  });

  describe('session creation', () => {
    function sessionCreatedAt(createdAt: string): AuthenticatedSession {
      const base = sessionOf();
      return { ...base, session: { ...base.session, createdAt } };
    }
    const earlyStart = loginStateOf({ issuedAt: NOW_MS - 400_000 });

    it.each([
      ['one second before', -1_000, false],
      ['exactly at', 0, false],
      ['one millisecond after', 1, true],
    ])('authTime %s the session createdAt', async (_label, delta, accepted) => {
      const createdAtMs = NOW_MS - 300_000;
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionCreatedAt(new Date(createdAtMs).toISOString()),
        providerOf(),
        verified({ authTime: new Date(createdAtMs + delta).toISOString() }),
        earlyStart,
      );
      expect(result).toEqual(accepted ? { ok: true } : { ok: false, reason: 'stale_auth_time' });
      expect(fixture.mark).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });

    it('refuses a session whose createdAt is not a canonical timestamp', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionCreatedAt('yesterday'),
        providerOf(),
        verified(),
      );
      expect(result).toEqual({ ok: false, reason: 'stale_auth_time' });
    });
  });

  describe('stored identity binding', () => {
    it('refuses an identity that belongs to another user than the session', async () => {
      const fixture = setup({ stored: storedIdentity({ userId: '01J0USERB0000000000000000B' }) });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('refuses an identity whose e-mail differs from the stored one', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ email: 'grace@example.test' }),
      );
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('refuses a stored identity with an empty e-mail', async () => {
      const fixture = setup({ stored: storedIdentity({ email: '' }) });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it.each([
      ['not an e-mail address', 'not-an-address'],
      ['empty', ''],
      ['two at signs', 'a@b@example.test'],
    ])('refuses an identity e-mail that is %s', async (_label, email) => {
      const fixture = setup({ stored: storedIdentity({ email }) });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified({ email }));
      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('compares the normalized e-mail', async () => {
      const fixture = setup();
      const result = await run(
        fixture.deps,
        CTX,
        sessionOf(),
        providerOf(),
        verified({ email: '  Ada@Example.TEST ' }),
      );
      expect(result).toEqual({ ok: true });
    });
  });

  describe('hook observers and deadlines', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports the denying plugin and code to onDenied, not in the result', async () => {
      const onDenied = vi.fn();
      const fixture = setup({
        hooks: [
          resolving('plugin-a', () => undefined),
          resolving('plugin-b', () => ({ deny: true, reason: 'private text' })),
        ],
        onDenied,
      });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'hook_denied' });
      expect(onDenied).toHaveBeenCalledTimes(1);
      expect(onDenied).toHaveBeenCalledWith({ plugin: 'plugin-b', code: 'denied' });
    });

    it('does not call onDenied when every hook allows', async () => {
      const onDenied = vi.fn();
      const fixture = setup({ hooks: [resolving('plugin-a', () => undefined)], onDenied });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: true });
      expect(onDenied).not.toHaveBeenCalled();
    });

    it('keeps the refusal and raises no unhandled rejection when onDenied rejects', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const calls = vi.fn(() => Promise.reject(new Error('observer failed')));
        const fixture = setup({
          hooks: [resolving('plugin-a', () => ({ deny: true }))],
          onDenied: calls,
        });
        const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(result).toEqual({ ok: false, reason: 'hook_denied' });
        expect(calls).toHaveBeenCalledTimes(1);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('keeps the refusal when onDenied throws', async () => {
      const fixture = setup({
        hooks: [resolving('plugin-a', () => ({ deny: true }))],
        onDenied: () => {
          throw new Error('observer failed');
        },
      });
      const result = await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      expect(result).toEqual({ ok: false, reason: 'hook_denied' });
    });

    it('denies a hook that never settles once the deadline passes', async () => {
      vi.useFakeTimers();
      const onDenied = vi.fn();
      const fixture = setup({
        hooks: [resolving('plugin-a', () => new Promise<never>(() => undefined))],
        onDenied,
      });
      let settled: ReauthResult | null = null;
      const pending = run(fixture.deps, CTX, sessionOf(), providerOf(), verified()).then(
        (value) => {
          settled = value;
        },
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(2);
      await pending;

      expect(settled).toEqual({ ok: false, reason: 'hook_denied' });
      expect(onDenied).toHaveBeenCalledWith({ plugin: 'plugin-a', code: 'hook_error' });
      expect(fixture.mark).not.toHaveBeenCalled();
    });
  });

  describe('what a refusal carries', () => {
    const secretText = 'secret reason text from plugin';
    const providerFailure = 'provider said: invalid_grant for ada@example.test';

    const everyRefusal: Record<ReauthRefusal, () => Promise<ReauthResult>> = {
      not_sso_session: () => run(setup().deps, CTX, sessionOf(null), providerOf(), verified()),
      not_supported: () =>
        run(setup().deps, CTX, sessionOf(), providerOf({ supportsReauth: false }), verified()),
      state_mismatch: () =>
        run(
          setup().deps,
          CTX,
          sessionOf(),
          providerOf(),
          verified(),
          loginStateOf({ purpose: 'login' }),
        ),
      identity_mismatch: () =>
        run(setup().deps, CTX, sessionOf(), providerOf(), verified({ subject: 'subject-2' })),
      no_auth_time: () =>
        run(setup().deps, CTX, sessionOf(), providerOf(), verified({ authTime: null })),
      stale_auth_time: () =>
        run(setup().deps, CTX, sessionOf(), providerOf(), verified({ authTime: providerFailure })),
      policy: () =>
        run(setup().deps, CTX, sessionOf(), providerOf(), verified({ emailVerified: false })),
      hook_denied: () =>
        run(
          setup({ hooks: [resolving('plugin-a', () => ({ deny: true, reason: secretText }))] })
            .deps,
          CTX,
          sessionOf(),
          providerOf(),
          verified(),
        ),
      not_updated: async () => {
        const fixture = setup();
        await run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
        return run(fixture.deps, CTX, sessionOf(), providerOf(), verified());
      },
    };

    it.each(Object.entries(everyRefusal))(
      '%s carries only the reason code',
      async (kind, produce) => {
        const result = await produce();
        expect(result).toEqual({ ok: false, reason: kind });
        expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
        const text = JSON.stringify(result);
        for (const forbidden of [EMAIL, 'example.test', secretText, providerFailure, 'plugin-a']) {
          expect(text).not.toContain(forbidden);
        }
      },
    );
  });

  describe('repository failures', () => {
    it('propagates a failing getIdentity without marking anything', async () => {
      const fixture = setup();
      fixture.getIdentity.mockRejectedValueOnce(new Error('database down'));
      await expect(run(fixture.deps, CTX, sessionOf(), providerOf(), verified())).rejects.toThrow(
        'database down',
      );
      expect(fixture.mark).not.toHaveBeenCalled();
    });

    it('propagates a failing markReauthenticatedByIdentity', async () => {
      const fixture = setup();
      fixture.mark.mockRejectedValueOnce(new Error('database down'));
      await expect(run(fixture.deps, CTX, sessionOf(), providerOf(), verified())).rejects.toThrow(
        'database down',
      );
    });
  });
});
