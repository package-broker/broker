import {
  CSRF_COOKIE,
  LOGIN_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  serializeCookie,
} from './cookies.js';
import { assertCsrfToken, assertSameOrigin } from './csrf.js';
import { randomToken, sha256Hex } from './primitives.js';
import { auditEvent, isIpLiteral } from '../audit/actions.js';
import type { OrgContext } from '../db/port.js';
import type { ActiveSession, SessionRepository } from '../db/sessions.js';
import { ulid, type Clock } from '../ids.js';
import type { Principal } from '../plugin.js';

export const SESSION_ABSOLUTE_MS = 43_200_000;
export const SESSION_IDLE_MS = 3_600_000;
export const SESSION_TOUCH_MS = 300_000;
export const REAUTH_WINDOW_MS = 600_000;

export type AuthCallMeta = {
  readonly requestId: string;
  readonly ip: string | null;
};

export interface SessionMeta extends AuthCallMeta {
  readonly userAgent: string | null;
  readonly previousSecretHash: string | null;
}

export interface SessionSecrets {
  readonly secret: string;
  readonly csrf: string;
  readonly secretHash: string;
  readonly csrfHash: string;
}

export interface AuthenticatedSession {
  readonly session: ActiveSession;
  readonly principal: Principal;
}

export interface SessionService {
  /** A failing `touch` rejects the whole call: the request fails closed. */
  authenticate(ctx: OrgContext, request: Request): Promise<AuthenticatedSession | null>;
  assertCsrf(request: Request, session: AuthenticatedSession): Promise<void>;
  isReauthFresh(session: AuthenticatedSession): boolean;
  setCookies(secrets: SessionSecrets, expiresAt: string): readonly string[];
  clearCookies(): readonly string[];
  /** Repository failures propagate; the route must still send `clearCookies()` when it catches one. */
  logout(ctx: OrgContext, request: Request, meta: AuthCallMeta): Promise<readonly string[]>;
}

const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_FLAGS = { httpOnly: true, sameSite: 'Lax' } as const;
const CSRF_FLAGS = { httpOnly: false, sameSite: 'Strict' } as const;
const LOGIN_FLAGS = { httpOnly: true, sameSite: 'Lax' } as const;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function newSessionSecrets(): Promise<SessionSecrets> {
  const secret = randomToken(32);
  const csrf = randomToken(32);
  return { secret, csrf, secretHash: await sha256Hex(secret), csrfHash: await sha256Hex(csrf) };
}

function sessionSecretOf(request: Request): string | null {
  const value = readCookie(request, SESSION_COOKIE);
  return value !== null && SESSION_SECRET_PATTERN.test(value) ? value : null;
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function clientIpOf(request: Request): string | null {
  const candidate =
    nonEmpty(request.headers.get('cf-connecting-ip')) ??
    nonEmpty(request.headers.get('x-forwarded-for')?.split(',')[0] ?? null);
  return candidate !== null && isIpLiteral(candidate) ? candidate : null;
}

export function authCallMetaOf(
  request: Request,
  requestId: string,
  resolveClientIp: (request: Request) => string | null = clientIpOf,
): AuthCallMeta {
  return { requestId, ip: resolveClientIp(request) };
}

function timestampMs(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError('session timestamp is not parseable');
  }
  return ms;
}

export async function sessionMetaOf(
  request: Request,
  requestId: string,
  resolveClientIp: (request: Request) => string | null = clientIpOf,
): Promise<SessionMeta> {
  const secret = sessionSecretOf(request);
  return {
    ...authCallMetaOf(request, requestId, resolveClientIp),
    userAgent: nonEmpty(request.headers.get('user-agent')),
    previousSecretHash: secret === null ? null : await sha256Hex(secret),
  };
}

export function createSessionService(deps: {
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly publicOrigin: string;
}): SessionService {
  const { sessions, clock, publicOrigin } = deps;
  if (publicOrigin === 'null' || new URL(publicOrigin).origin !== publicOrigin) {
    throw new TypeError('publicOrigin must be a canonical origin');
  }

  const clearCookies = (): readonly string[] => [
    clearCookie(SESSION_COOKIE, SESSION_FLAGS),
    clearCookie(CSRF_COOKIE, CSRF_FLAGS),
    clearCookie(LOGIN_COOKIE, LOGIN_FLAGS),
  ];

  return {
    async authenticate(ctx, request) {
      const secret = sessionSecretOf(request);
      if (secret === null) {
        return null;
      }
      const now = clock.now().getTime();
      const session = await sessions.findActive(ctx, await sha256Hex(secret), {
        now: new Date(now).toISOString(),
        idleSince: new Date(now - SESSION_IDLE_MS).toISOString(),
      });
      if (session === null) {
        return null;
      }
      const lastSign = timestampMs(session.lastSeenAt ?? session.createdAt);
      if (now - lastSign > SESSION_TOUCH_MS) {
        await sessions.touch(
          ctx,
          session.id,
          new Date(now).toISOString(),
          new Date(now - SESSION_TOUCH_MS).toISOString(),
        );
      }
      return { session, principal: { kind: 'user', id: session.userId } };
    },

    async assertCsrf(request, authenticated) {
      assertSameOrigin(request, publicOrigin);
      await assertCsrfToken(request, authenticated.session.csrfHash);
    },

    isReauthFresh(authenticated) {
      const { reauthAt } = authenticated.session;
      if (reauthAt === null) {
        return false;
      }
      const age = clock.now().getTime() - timestampMs(reauthAt);
      return age >= 0 && age <= REAUTH_WINDOW_MS;
    },

    setCookies(secrets, expiresAt) {
      const expiry = Date.parse(expiresAt);
      if (
        !CANONICAL_TIMESTAMP.test(expiresAt) ||
        Number.isNaN(expiry) ||
        new Date(expiry).toISOString() !== expiresAt
      ) {
        throw new TypeError('expiresAt must be a canonical ISO timestamp');
      }
      const remaining = expiry - clock.now().getTime();
      if (remaining > SESSION_ABSOLUTE_MS) {
        throw new RangeError('expiresAt exceeds the absolute session lifetime');
      }
      const maxAgeSeconds = Math.max(0, Math.floor(remaining / 1000));
      return [
        serializeCookie(SESSION_COOKIE, secrets.secret, { ...SESSION_FLAGS, maxAgeSeconds }),
        serializeCookie(CSRF_COOKIE, secrets.csrf, { ...CSRF_FLAGS, maxAgeSeconds }),
      ];
    },

    clearCookies,

    async logout(ctx, request, meta) {
      const secret = sessionSecretOf(request);
      if (secret !== null) {
        const secretHash = await sha256Hex(secret);
        const now = clock.now();
        const session = await sessions.findActive(ctx, secretHash, {
          now: now.toISOString(),
          idleSince: new Date(now.getTime() - SESSION_IDLE_MS).toISOString(),
        });
        if (session === null) {
          await sessions.revokeBySecretHash(ctx, secretHash, now.toISOString());
        } else {
          const id = ulid(now.getTime());
          const audit = auditEvent({
            id,
            now: now.toISOString(),
            action: 'session.logout',
            actor: { type: 'user', id: session.userId },
            target: { type: 'session', id: session.id },
            context: {
              opId: id,
              requestId: meta.requestId,
              sourceIp: isIpLiteral(meta.ip) ? meta.ip : null,
              tokenSelector: null,
            },
          });
          if (!audit.ok) throw new TypeError('Invalid session logout audit event');
          await sessions.revokeBySecretHash(ctx, secretHash, now.toISOString(), audit.event);
        }
      }
      return clearCookies();
    },
  };
}
