import { REAUTH_WINDOW_MS } from './session.js';
import type { AuthenticatedSession } from './session.js';
import type { OrgContext } from '../db/port.js';
import type { SessionRepository } from '../db/sessions.js';
import type { UserRepository } from '../db/users.js';
import type { Clock } from '../ids.js';
import { runResolveIdentityHooks } from '../identity/hooks.js';
import { evaluateDomainPolicy, normalizeEmail } from '../identity/policy.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import type { HookErrorHandler } from '../kernel/access.js';
import type { Registration } from '../kernel/registry.js';

export type ReauthRefusal =
  | 'not_sso_session'
  | 'not_supported'
  | 'state_mismatch'
  | 'identity_mismatch'
  | 'no_auth_time'
  | 'stale_auth_time'
  | 'policy'
  | 'hook_denied'
  | 'not_updated';

export type ReauthResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: ReauthRefusal };

export interface IdentityReauthDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly hooks: Pick<Registration['hooks'], 'auth.resolveIdentity'>;
  readonly onHookError?: HookErrorHandler;
  readonly onDenied?: (denial: {
    readonly plugin: string;
    readonly code: HookDenialCode;
  }) => void | Promise<void>;
}

/** The fields of the opened sealed login state that bind a callback to this re-authentication. */
export interface ReauthLoginState {
  readonly provider: string;
  readonly purpose: string;
  readonly sessionId: string | null;
  readonly issuedAt: number;
}

type HookDenialCode = NonNullable<Awaited<ReturnType<typeof runResolveIdentityHooks>>>['code'];

const AUTH_TIME_BEFORE_START_TOLERANCE_MS = 60_000;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function refuse(reason: ReauthRefusal): ReauthResult {
  return { ok: false, reason };
}

function canonicalTimestampMs(value: string): number | null {
  if (!CANONICAL_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? null : ms;
}

/**
 * Moves `reauth_at` to the provider's own `authTime`, only for the identity the session was created
 * with, and only when the opened login state belongs to this session's re-authentication. A
 * malformed `authTime`, one in the future, older than ten minutes or more than a minute before the
 * re-authentication started or not after the session was created counts as stale. `onDenied` receives the denying plugin and code; the
 * result never carries them.
 */
export async function reauthenticateWithIdentity(
  deps: IdentityReauthDeps,
  ctx: OrgContext,
  session: AuthenticatedSession,
  provider: IdentityProvider,
  identity: VerifiedIdentity,
  loginState: ReauthLoginState,
): Promise<ReauthResult> {
  const identityId = session.session.identityId;
  if (identityId === null) return refuse('not_sso_session');
  if (!provider.supportsReauth) return refuse('not_supported');
  if (
    loginState.provider !== provider.id ||
    loginState.purpose !== 'reauth' ||
    loginState.sessionId !== session.session.id ||
    !Number.isSafeInteger(loginState.issuedAt)
  ) {
    return refuse('state_mismatch');
  }

  const stored = await deps.users.getIdentity(ctx, identityId);
  if (
    stored === null ||
    stored.userId !== session.session.userId ||
    provider.id !== identity.provider ||
    stored.provider !== identity.provider ||
    stored.subject !== identity.subject
  ) {
    return refuse('identity_mismatch');
  }
  const email = normalizeEmail(identity.email);
  if (email === null || stored.email !== email) {
    return refuse('identity_mismatch');
  }

  const authTime = identity.authTime;
  if (authTime === null) return refuse('no_auth_time');

  const now = deps.clock.now();
  const authTimeMs = canonicalTimestampMs(authTime);
  const sessionStartMs = canonicalTimestampMs(session.session.createdAt);
  if (
    authTimeMs === null ||
    sessionStartMs === null ||
    authTimeMs <= sessionStartMs ||
    authTimeMs > now.getTime() ||
    now.getTime() - authTimeMs > REAUTH_WINDOW_MS ||
    authTimeMs < loginState.issuedAt - AUTH_TIME_BEFORE_START_TOLERANCE_MS
  ) {
    return refuse('stale_auth_time');
  }

  if (!evaluateDomainPolicy(identity, provider.policy).allow) return refuse('policy');

  const denial = await runResolveIdentityHooks(
    deps.hooks['auth.resolveIdentity'],
    { org: ctx, identity, userId: session.session.userId },
    deps.onHookError,
  );
  if (denial !== undefined) {
    const onDenied = deps.onDenied;
    if (onDenied !== undefined) {
      const report = { plugin: denial.plugin, code: denial.code };
      void Promise.resolve()
        .then(() => onDenied(report))
        .catch(() => undefined);
    }
    return refuse('hook_denied');
  }

  const updated = await deps.sessions.markReauthenticatedByIdentity(ctx, {
    sessionId: session.session.id,
    identityId,
    authTime,
    now: now.toISOString(),
  });
  return updated ? { ok: true } : refuse('not_updated');
}
