import { describe, expect, it, vi } from 'vitest';
import { CsrfError } from './csrf.js';
import { randomToken, sha256Hex } from './primitives.js';
import {
  REAUTH_WINDOW_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  authCallMetaOf,
  clientIpOf,
  createSessionService,
  newSessionSecrets,
  sessionMetaOf,
} from './session.js';
import type { AuthenticatedSession } from './session.js';
import * as auditActions from '../audit/actions.js';
import { isIpLiteral, type AuditEvent } from '../audit/actions.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession, SessionRepository } from '../db/sessions.js';
import { fixedClock } from '../ids.js';

const ORIGIN = 'https://broker.example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ctx = orgContext('01J0ORGA00000000000000000A');
const SESSION_NAME = '__Host-pb_session';
const CSRF_NAME = '__Host-pb_csrf';

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function activeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: '01J0SESSION00000000000000S1',
    userId: '01J0USERA0000000000000000A',
    identityId: null,
    csrfHash: 'a'.repeat(64),
    createdAt: isoAgo(2 * 3_600_000),
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    lastSeenAt: isoAgo(60_000),
    reauthAt: null,
    user: { id: '01J0USERA0000000000000000A', email: 'a@example.test', displayName: 'Ada' },
    ...overrides,
  };
}

interface Harness {
  readonly service: ReturnType<typeof createSessionService>;
  readonly findActive: ReturnType<typeof vi.fn>;
  readonly touch: ReturnType<typeof vi.fn>;
  readonly revokeBySecretHash: ReturnType<typeof vi.fn>;
  readonly repositoryCalls: () => number;
}

function harness(found: ActiveSession | null = activeSession()): Harness {
  const findActive = vi.fn(() => Promise.resolve(found));
  const touch = vi.fn(() => Promise.resolve());
  const revokeBySecretHash = vi.fn(() => Promise.resolve(true));
  const unexpected = (name: string) => vi.fn(() => Promise.reject(new Error(`unexpected ${name}`)));
  const sessions: SessionRepository = {
    findActive,
    findActiveById: () => findActive(),
    touch,
    revokeBySecretHash,
    revoke: unexpected('revoke'),
    markReauthenticatedByIdentity: unexpected('markReauthenticatedByIdentity'),
    deleteExpired: unexpected('deleteExpired'),
  };
  const service = createSessionService({
    sessions,
    clock: fixedClock(NOW),
    publicOrigin: ORIGIN,
  });
  return {
    service,
    findActive,
    touch,
    revokeBySecretHash,
    repositoryCalls: () =>
      findActive.mock.calls.length + touch.mock.calls.length + revokeBySecretHash.mock.calls.length,
  };
}

function requestWith(cookie: string | null, headers: Record<string, string> = {}): Request {
  const all: Record<string, string> = { ...headers };
  if (cookie !== null) {
    all.cookie = cookie;
  }
  return new Request(`${ORIGIN}/_pb/auth/me`, { headers: all });
}

function sessionCookie(value: string): string {
  return `${SESSION_NAME}=${value}`;
}

function authenticated(session: ActiveSession = activeSession()): AuthenticatedSession {
  return { session, principal: { kind: 'user', id: session.userId } };
}

describe('lifetime constants', () => {
  it('match the design', () => {
    expect(SESSION_ABSOLUTE_MS).toBe(12 * 3_600_000);
    expect(SESSION_IDLE_MS).toBe(3_600_000);
    expect(SESSION_TOUCH_MS).toBe(300_000);
    expect(REAUTH_WINDOW_MS).toBe(600_000);
  });
});

describe('newSessionSecrets', () => {
  it('returns 43-character tokens and their SHA-256 hex digests', async () => {
    const secrets = await newSessionSecrets();
    expect(secrets.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.secretHash).toBe(await sha256Hex(secrets.secret));
    expect(secrets.csrfHash).toBe(await sha256Hex(secrets.csrf));
    expect(secrets.secret).not.toBe(secrets.csrf);
  });

  it('returns different secrets on each call', async () => {
    const first = await newSessionSecrets();
    const second = await newSessionSecrets();
    expect(second.secret).not.toBe(first.secret);
    expect(second.csrf).not.toBe(first.csrf);
  });
});

describe('sessionMetaOf', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
      'test-request-id',
    );
    expect(meta.ip).toBe('203.0.113.7');
  });

  it('takes the first x-forwarded-for entry', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'x-forwarded-for': ' 198.51.100.1 , 192.0.2.9, 192.0.2.10' }),
      'test-request-id',
    );
    expect(meta.ip).toBe('198.51.100.1');
  });

  it('returns null ip when no header gives an address', async () => {
    expect((await sessionMetaOf(requestWith(null), 'test-request-id')).ip).toBeNull();
    expect(
      (
        await sessionMetaOf(
          requestWith(null, { 'x-forwarded-for': ' , 192.0.2.9' }),
          'test-request-id',
        )
      ).ip,
    ).toBeNull();
    expect(
      (await sessionMetaOf(requestWith(null, { 'cf-connecting-ip': '  ' }), 'test-request-id')).ip,
    ).toBeNull();
  });

  it('keeps only IP literals', async () => {
    const accepted = ['203.0.113.7', '2001:db8::1', '::ffff:192.0.2.1'];
    for (const ip of accepted) {
      expect(
        (await sessionMetaOf(requestWith(null, { 'cf-connecting-ip': ip }), 'test-request-id')).ip,
      ).toBe(ip);
    }
    const rejected = [
      'a'.repeat(64),
      'a'.repeat(65),
      'unknown',
      '1.2.3.4<script>',
      '203.0.113.7:80x',
      '1.2.3.4 5',
    ];
    for (const ip of rejected) {
      expect(
        (await sessionMetaOf(requestWith(null, { 'cf-connecting-ip': ip }), 'test-request-id')).ip,
      ).toBeNull();
      expect(
        (await sessionMetaOf(requestWith(null, { 'x-forwarded-for': ip }), 'test-request-id')).ip,
      ).toBeNull();
    }
  });

  it('keeps only an IP literal from a custom client IP resolver', async () => {
    const rejected: unknown[] = ['not-an-ip', '1.2.3.4:80', '', 42];
    for (const value of rejected) {
      const resolver = (): string | null => value as string | null;
      expect(authCallMetaOf(requestWith(null), 'test-request-id', resolver).ip).toBeNull();
      expect((await sessionMetaOf(requestWith(null), 'test-request-id', resolver)).ip).toBeNull();
    }
    for (const ip of ['203.0.113.7', '2001:db8::1']) {
      const resolver = (): string | null => ip;
      expect(authCallMetaOf(requestWith(null), 'test-request-id', resolver).ip).toBe(ip);
      expect((await sessionMetaOf(requestWith(null), 'test-request-id', resolver)).ip).toBe(ip);
    }
  });

  it('does not fall back to x-forwarded-for when cf-connecting-ip is present but invalid', async () => {
    const meta = await sessionMetaOf(
      requestWith(null, { 'cf-connecting-ip': 'unknown', 'x-forwarded-for': '198.51.100.1' }),
      'test-request-id',
    );
    expect(meta.ip).toBeNull();
  });

  it('returns the user agent or null', async () => {
    expect(
      (await sessionMetaOf(requestWith(null, { 'user-agent': 'TestAgent/1.0' }), 'test-request-id'))
        .userAgent,
    ).toBe('TestAgent/1.0');
    expect((await sessionMetaOf(requestWith(null), 'test-request-id')).userAgent).toBeNull();
  });

  it('returns the hash of a well-formed session cookie', async () => {
    const secret = randomToken(32);
    const meta = await sessionMetaOf(requestWith(sessionCookie(secret)), 'test-request-id');
    expect(meta.previousSecretHash).toBe(await sha256Hex(secret));
  });

  it('returns null previousSecretHash for malformed, missing and duplicated cookies', async () => {
    const secret = randomToken(32);
    const cookies = [
      null,
      sessionCookie('short'),
      sessionCookie(`${secret}x`),
      sessionCookie(`${secret.slice(0, 42)}.`),
      `${sessionCookie(secret)}; ${sessionCookie(secret)}`,
    ];
    for (const cookie of cookies) {
      expect(
        (await sessionMetaOf(requestWith(cookie), 'test-request-id')).previousSecretHash,
      ).toBeNull();
    }
  });
});

describe('authenticate', () => {
  it('returns null with zero repository calls for missing, malformed and duplicated cookies', async () => {
    const secret = randomToken(32);
    const cases: (string | null)[] = [
      null,
      '',
      `${SESSION_NAME}=`,
      sessionCookie('short'),
      sessionCookie(secret.slice(0, 42)),
      sessionCookie(`${secret}A`),
      sessionCookie(`${secret.slice(0, 42)}.`),
      sessionCookie(`${secret.slice(0, 42)}+`),
      `${sessionCookie(secret)}; ${sessionCookie(randomToken(32))}`,
      `other=${secret}`,
      `${CSRF_NAME}=${secret}`,
    ];
    for (const cookie of cases) {
      const h = harness();
      expect(await h.service.authenticate(ctx, requestWith(cookie))).toBeNull();
      expect(h.repositoryCalls()).toBe(0);
    }
  });

  it('looks the session up by the secret hash with cutoffs now and now - 1 h', async () => {
    const secret = randomToken(32);
    const h = harness();
    await h.service.authenticate(ctx, requestWith(sessionCookie(secret)));
    expect(h.findActive).toHaveBeenCalledTimes(1);
    expect(h.findActive).toHaveBeenCalledWith(ctx, await sha256Hex(secret), {
      now: NOW,
      idleSince: isoAgo(SESSION_IDLE_MS),
    });
    expect(isoAgo(SESSION_IDLE_MS)).toBe('2026-10-15T11:00:00.000Z');
  });

  it('returns null when the repository finds no active session', async () => {
    const h = harness(null);
    const result = await h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
    expect(result).toBeNull();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it('returns the session with a user principal', async () => {
    const found = activeSession();
    const h = harness(found);
    const result = await h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
    expect(result).toEqual({ session: found, principal: { kind: 'user', id: found.userId } });
  });

  it('touches at 5 min 1 s after last_seen_at', async () => {
    const found = activeSession({ lastSeenAt: isoAgo(SESSION_TOUCH_MS + 1000) });
    const h = harness(found);
    await h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
    expect(h.touch).toHaveBeenCalledTimes(1);
    expect(h.touch).toHaveBeenCalledWith(ctx, found.id, NOW, isoAgo(SESSION_TOUCH_MS));
  });

  it('does not touch at 4 min 59 s or exactly 5 min after last_seen_at', async () => {
    for (const age of [SESSION_TOUCH_MS - 1000, SESSION_TOUCH_MS]) {
      const h = harness(activeSession({ lastSeenAt: isoAgo(age) }));
      await h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
      expect(h.touch).not.toHaveBeenCalled();
    }
  });

  it('throws TypeError when the last sign of life is not a timestamp', async () => {
    const h = harness(activeSession({ lastSeenAt: 'garbage' }));
    await expect(
      h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32)))),
    ).rejects.toThrow(TypeError);
    const none = harness(activeSession({ lastSeenAt: null, createdAt: 'garbage' }));
    await expect(
      none.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32)))),
    ).rejects.toThrow(TypeError);
    expect(h.touch).not.toHaveBeenCalled();
  });

  it('fails the request when touch fails', async () => {
    const h = harness(activeSession({ lastSeenAt: isoAgo(SESSION_TOUCH_MS + 1000) }));
    h.touch.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32)))),
    ).rejects.toThrow('db down');
  });

  it('falls back to created_at when last_seen_at is null', async () => {
    const stale = harness(
      activeSession({ lastSeenAt: null, createdAt: isoAgo(SESSION_TOUCH_MS + 1000) }),
    );
    await stale.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
    expect(stale.touch).toHaveBeenCalledTimes(1);

    const fresh = harness(
      activeSession({ lastSeenAt: null, createdAt: isoAgo(SESSION_TOUCH_MS - 1000) }),
    );
    await fresh.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))));
    expect(fresh.touch).not.toHaveBeenCalled();
  });
  it('can authenticate for CSRF validation without touching an old live session', async () => {
    const session = activeSession({ lastSeenAt: isoAgo(SESSION_TOUCH_MS + 1) });
    const h = harness(session);
    const result = await h.service.authenticate(ctx, requestWith(sessionCookie(randomToken(32))), {
      touch: false,
    });
    expect(result).toEqual(authenticated(session));
    expect(h.findActive).toHaveBeenCalledTimes(1);
    expect(h.touch).not.toHaveBeenCalled();
  });
});

describe('assertCsrf', () => {
  async function csrfFixture(): Promise<{ token: string; session: AuthenticatedSession }> {
    const token = randomToken(32);
    return { token, session: authenticated(activeSession({ csrfHash: await sha256Hex(token) })) };
  }

  it('accepts a same-origin request with the matching token', async () => {
    const { token, session } = await csrfFixture();
    const request = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-csrf-token': token },
    });
    await expect(harness().service.assertCsrf(request, session)).resolves.toBeUndefined();
  });

  it('rejects a foreign origin before looking at the token', async () => {
    const { token, session } = await csrfFixture();
    const request = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.test', 'x-csrf-token': token },
    });
    await expect(harness().service.assertCsrf(request, session)).rejects.toMatchObject({
      name: 'CsrfError',
      reason: 'origin_mismatch',
    });
  });

  it('rejects a missing token and a wrong token', async () => {
    const { session } = await csrfFixture();
    const missing = new Request(`${ORIGIN}/x`, { method: 'POST', headers: { origin: ORIGIN } });
    await expect(harness().service.assertCsrf(missing, session)).rejects.toMatchObject({
      reason: 'token_missing',
    });
    const wrong = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-csrf-token': randomToken(32) },
    });
    const error: unknown = await harness()
      .service.assertCsrf(wrong, session)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CsrfError);
    expect(error).toMatchObject({ reason: 'token_mismatch' });
  });

  it('rejects a cross-site request that has no Origin', async () => {
    const { token, session } = await csrfFixture();
    const request = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'x-csrf-token': token },
    });
    await expect(harness().service.assertCsrf(request, session)).rejects.toMatchObject({
      reason: 'cross_site',
    });
  });

  it('rejects an unsafe request with neither Origin nor Sec-Fetch-Site', async () => {
    const { token, session } = await csrfFixture();
    const request = new Request(`${ORIGIN}/x`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': token },
    });
    await expect(harness().service.assertCsrf(request, session)).rejects.toMatchObject({
      reason: 'origin_missing',
    });
  });
});

describe('isReauthFresh', () => {
  const service = harness().service;

  it('is false when reauth_at is null', () => {
    expect(service.isReauthFresh(authenticated(activeSession({ reauthAt: null })))).toBe(false);
  });

  it('is true exactly 10 minutes after reauth_at', () => {
    const session = authenticated(activeSession({ reauthAt: isoAgo(REAUTH_WINDOW_MS) }));
    expect(service.isReauthFresh(session)).toBe(true);
  });

  it('is false 10 minutes and 1 ms after reauth_at', () => {
    const session = authenticated(activeSession({ reauthAt: isoAgo(REAUTH_WINDOW_MS + 1) }));
    expect(service.isReauthFresh(session)).toBe(false);
  });

  it('is false for a reauth_at in the future', () => {
    const future = new Date(NOW_MS + 1).toISOString();
    expect(service.isReauthFresh(authenticated(activeSession({ reauthAt: future })))).toBe(false);
  });

  it('throws TypeError for an unparseable reauth_at', () => {
    expect(() =>
      service.isReauthFresh(authenticated(activeSession({ reauthAt: 'garbage' }))),
    ).toThrow(TypeError);
  });

  it('is true shortly after reauth_at', () => {
    expect(service.isReauthFresh(authenticated(activeSession({ reauthAt: isoAgo(1000) })))).toBe(
      true,
    );
  });
});

describe('setCookies and clearCookies', () => {
  const secrets = {
    secret: 'S'.repeat(43),
    csrf: 'C'.repeat(43),
    secretHash: 'a'.repeat(64),
    csrfHash: 'b'.repeat(64),
  };

  it('returns the two exact Set-Cookie strings', () => {
    const expiresAt = new Date(NOW_MS + SESSION_ABSOLUTE_MS).toISOString();
    expect(harness().service.setCookies(secrets, expiresAt)).toEqual([
      `__Host-pb_session=${'S'.repeat(43)}; Path=/; Secure; SameSite=Lax; Max-Age=43200; HttpOnly`,
      `__Host-pb_csrf=${'C'.repeat(43)}; Path=/; Secure; SameSite=Strict; Max-Age=43200`,
    ]);
  });

  it('rounds Max-Age down to whole seconds', () => {
    const cookies = harness().service.setCookies(secrets, new Date(NOW_MS + 90_999).toISOString());
    expect(cookies[0]).toContain('Max-Age=90;');
    expect(cookies[1]).toContain('Max-Age=90');
  });

  it('uses Max-Age=0 for an expiry that has passed', () => {
    const cookies = harness().service.setCookies(secrets, isoAgo(5000));
    expect(cookies[0]).toContain('Max-Age=0;');
    expect(cookies[1]).toMatch(/Max-Age=0$/);
  });

  it('rejects an expiry that is not a canonical ISO timestamp', () => {
    const service = harness().service;
    for (const bad of [
      'tomorrow',
      '',
      '2026-10-15T13:00:00Z',
      '2026-10-15T13:00:00.000+00:00',
      '2026-10-15 13:00:00.000Z',
      '2026-02-31T13:00:00.000Z',
      'Thu, 15 Oct 2026 13:00:00 GMT',
    ]) {
      expect(() => service.setCookies(secrets, bad)).toThrow(TypeError);
    }
  });

  it('accepts an expiry exactly at the absolute lifetime and rejects 1 ms beyond it', () => {
    const service = harness().service;
    expect(() =>
      service.setCookies(secrets, new Date(NOW_MS + SESSION_ABSOLUTE_MS).toISOString()),
    ).not.toThrow();
    expect(() =>
      service.setCookies(secrets, new Date(NOW_MS + SESSION_ABSOLUTE_MS + 1).toISOString()),
    ).toThrow(RangeError);
  });

  it('rejects a secret that is not a valid cookie value', () => {
    expect(() => harness().service.setCookies({ ...secrets, secret: 'a b' }, NOW)).toThrow(
      TypeError,
    );
  });

  it('clears both cookies with their own attributes', () => {
    expect(harness().service.clearCookies()).toEqual([
      '__Host-pb_session=; Path=/; Secure; SameSite=Lax; Max-Age=0; HttpOnly',
      '__Host-pb_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
      '__Host-pb_login=; Path=/; Secure; SameSite=Lax; Max-Age=0; HttpOnly',
    ]);
  });
});

describe('logout', () => {
  it('revokes by the cookie hash and returns the clearing cookies', async () => {
    const secret = randomToken(32);
    const h = harness();
    const cookies = await h.service.logout(ctx, requestWith(sessionCookie(secret)), {
      requestId: '01K7R5V0000000000000000001',
      ip: '203.0.113.7',
    });
    expect(h.findActive).toHaveBeenCalledWith(ctx, await sha256Hex(secret), {
      now: NOW,
      idleSince: isoAgo(SESSION_IDLE_MS),
    });
    expect(h.touch).not.toHaveBeenCalled();
    expect(h.revokeBySecretHash).toHaveBeenCalledTimes(1);
    expect(h.revokeBySecretHash).toHaveBeenCalledWith(
      ctx,
      await sha256Hex(secret),
      NOW,
      expect.objectContaining({
        action: 'session.logout',
        actor: { type: 'user', id: activeSession().userId },
        target: { type: 'session', id: activeSession().id },
        occurredAt: NOW,
        sourceIp: '203.0.113.7',
        tokenSelector: null,
        projectId: null,
      }),
    );
    const event = h.revokeBySecretHash.mock.calls[0]?.[3] as AuditEvent;
    expect(JSON.parse(event.payloadJson)).toEqual({
      op_id: expect.any(String),
      request_id: '01K7R5V0000000000000000001',
    });
    expect(cookies).toEqual(h.service.clearCookies());
  });

  it('revokes without an event when the live-session read returns nothing', async () => {
    const secret = randomToken(32);
    const h = harness(null);
    const cookies = await h.service.logout(ctx, requestWith(sessionCookie(secret)), {
      requestId: '01K7R5V0000000000000000001',
      ip: null,
    });
    expect(h.findActive).toHaveBeenCalledTimes(1);
    expect(h.touch).not.toHaveBeenCalled();
    expect(h.revokeBySecretHash).toHaveBeenCalledWith(ctx, await sha256Hex(secret), NOW);
    expect(cookies).toEqual(h.service.clearCookies());
  });

  it('propagates a repository failure instead of reporting success', async () => {
    const h = harness();
    h.revokeBySecretHash.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.service.logout(ctx, requestWith(sessionCookie(randomToken(32))), {
        requestId: '01K7R5V0000000000000000001',
        ip: null,
      }),
    ).rejects.toThrow('db down');
  });

  it('does not revoke when the live-session read fails', async () => {
    const h = harness();
    h.findActive.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.service.logout(ctx, requestWith(sessionCookie(randomToken(32))), {
        requestId: '01K7R5V0000000000000000001',
        ip: null,
      }),
    ).rejects.toThrow('db down');
    expect(h.revokeBySecretHash).not.toHaveBeenCalled();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it.each(['refuses', 'throws'] as const)(
    'revokes without an event and logs a fixed message when audit construction %s',
    async (failure) => {
      const h = harness();
      const secret = randomToken(32);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const audit = vi.spyOn(auditActions, 'auditEvent');
      if (failure === 'throws')
        audit.mockImplementationOnce(() => {
          throw new Error('private request data');
        });
      try {
        const cookies = await h.service.logout(ctx, requestWith(sessionCookie(secret)), {
          requestId: 'invalid-request-id',
          ip: null,
        });
        expect(h.revokeBySecretHash).toHaveBeenCalledExactlyOnceWith(
          ctx,
          await sha256Hex(secret),
          NOW,
          undefined,
        );
        expect(h.touch).not.toHaveBeenCalled();
        expect(cookies).toEqual(h.service.clearCookies());
        expect(log).toHaveBeenCalledExactlyOnceWith('Session logout audit event unavailable');
      } finally {
        audit.mockRestore();
        log.mockRestore();
      }
    },
  );

  it('clears without a repository call when there is no cookie', async () => {
    const h = harness();
    const cookies = await h.service.logout(ctx, requestWith(null), {
      requestId: 'test-request-id',
      ip: null,
    });
    expect(h.repositoryCalls()).toBe(0);
    expect(cookies).toEqual(h.service.clearCookies());
  });

  it('clears without a repository call for malformed and duplicated cookies', async () => {
    const secret = randomToken(32);
    for (const cookie of [
      sessionCookie('short'),
      sessionCookie(`${secret.slice(0, 42)}.`),
      `${sessionCookie(secret)}; ${sessionCookie(secret)}`,
    ]) {
      const h = harness();
      const cookies = await h.service.logout(ctx, requestWith(cookie), {
        requestId: 'test-request-id',
        ip: null,
      });
      expect(h.repositoryCalls()).toBe(0);
      expect(cookies).toEqual(h.service.clearCookies());
    }
  });
});

describe('createSessionService', () => {
  it('rejects a publicOrigin that is not a canonical origin', () => {
    for (const publicOrigin of [
      `${ORIGIN}/`,
      `${ORIGIN}/path`,
      'null',
      'broker.example.test',
      'HTTPS://BROKER.example.test',
    ]) {
      expect(() =>
        createSessionService({
          sessions: {} as SessionRepository,
          clock: fixedClock(NOW),
          publicOrigin,
        }),
      ).toThrow(TypeError);
    }
  });

  it('accepts a canonical origin', () => {
    expect(() =>
      createSessionService({
        sessions: {} as SessionRepository,
        clock: fixedClock(NOW),
        publicOrigin: ORIGIN,
      }),
    ).not.toThrow();
  });
});

describe('clientIpOf', () => {
  const cases = [
    ['1.2', null],
    ['abc', null],
    ['::::', null],
    ['999.1.1.1', null],
    ['a'.repeat(8192), null],
    ['', null],
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['2001:0DB8:0:0::1', '2001:0DB8:0:0::1'],
    ['::ffff:192.0.2.7', '::ffff:192.0.2.7'],
    ['fe80::1%eth0', null],
    ['[::1]', null],
    ['192.0.2.1:80', null],
    ['01.2.3.4', null],
  ] as const;

  it.each(cases)('returns only audit-compatible literals for case %#', (value, expected) => {
    for (const header of ['cf-connecting-ip', 'x-forwarded-for']) {
      const result = clientIpOf(requestWith(null, { [header]: value }));
      expect(result).toBe(expected);
      if (result !== null) expect(isIpLiteral(result)).toBe(true);
    }
  });

  it.each([
    [{ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }, '203.0.113.7'],
    [{ 'x-forwarded-for': ' 198.51.100.1 , 192.0.2.9' }, '198.51.100.1'],
    [{ 'cf-connecting-ip': 'unknown', 'x-forwarded-for': '198.51.100.1' }, null],
    [{ 'x-forwarded-for': 'unknown' }, null],
    [{}, null],
  ])('resolves client address from %j', (headers, expected) => {
    expect(clientIpOf(requestWith(null, headers))).toBe(expected);
  });
});
