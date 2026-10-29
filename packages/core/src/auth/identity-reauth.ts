import { reauthCapability } from '../identity/reauth-capability.js';
import { REAUTH_WINDOW_MS, SESSION_IDLE_MS } from './session.js';
import type { AuthCallMeta, AuthenticatedSession } from './session.js';
import type { OrgContext } from '../db/port.js';
import type { SessionRepository } from '../db/sessions.js';
import type { UserRepository } from '../db/users.js';
import { ulid, type Clock } from '../ids.js';
import { auditEvent, isIpLiteral } from '../audit/actions.js';
import { runResolveIdentityHooks } from '../identity/hooks.js';
import { evaluateDomainPolicy, normalizeEmail } from '../identity/policy.js';
import { isValidTrustAnchor } from '../identity/port.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import type { HookErrorHandler } from '../kernel/access.js';
import type { Registration } from '../kernel/registry.js';

export type ReauthRefusal =
  | 'session_inactive'
  | 'not_sso_session'
  | 'not_supported'
  | 'state_mismatch'
  | 'identity_mismatch'
  | 'anchor_mismatch'
  | 'no_auth_time'
  | 'stale_auth_time'
  | 'policy'
  | 'hook_denied'
  | 'not_updated';

export type ReauthResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: ReauthRefusal };

export interface IdentityReauthDeps {
  readonly users: UserRepository;
  readonly sessions: Pick<SessionRepository, 'findActiveById' | 'markReauthenticatedByIdentity'>;
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

export async function isReauthSessionActive(
  deps: { readonly sessions: Pick<SessionRepository, 'findActiveById'>; readonly clock: Clock },
  ctx: OrgContext,
  sessionId: string,
): Promise<boolean> {
  const now = deps.clock.now().getTime();
  return (
    (await deps.sessions.findActiveById(ctx, sessionId, {
      now: new Date(now).toISOString(),
      idleSince: new Date(now - SESSION_IDLE_MS).toISOString(),
    })) !== null
  );
}

function canonicalTimestampMs(value: string): number | null {
  if (!CANONICAL_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? null : ms;
}

function snapshotTrustAnchor(provider: IdentityProvider): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(provider, 'trustAnchor');
    const anchor: unknown =
      descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof anchor !== 'string' || !isValidTrustAnchor(anchor)) throw new TypeError();
    return anchor;
  } catch {
    throw new TypeError('identity provider has an invalid trust anchor');
  }
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
  meta: AuthCallMeta,
): Promise<ReauthResult> {
  if (!(await isReauthSessionActive(deps, ctx, session.session.id))) {
    return refuse('session_inactive');
  }
  const identityId = session.session.identityId;
  if (identityId === null) return refuse('not_sso_session');
  if (!(await reauthCapability(provider))) return refuse('not_supported');
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

  const trustAnchor = snapshotTrustAnchor(provider);
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

  const { boundAnchor } = await deps.users.lookupForLogin(ctx, {
    provider: provider.id,
    subject: identity.subject,
    email,
    groups: identity.groups,
  });
  if (boundAnchor === null || boundAnchor !== trustAnchor) return refuse('anchor_mismatch');

  if (!(await isReauthSessionActive(deps, ctx, session.session.id))) {
    return refuse('session_inactive');
  }
  const audit = auditEvent({
    id: ulid(now.getTime()),
    now: now.toISOString(),
    action: 'session.reauth',
    actor: { type: 'user', id: session.session.userId },
    target: { type: 'session', id: session.session.id },
    context: {
      opId: ulid(now.getTime()),
      requestId: meta.requestId,
      sourceIp: isIpLiteral(meta.ip) ? meta.ip : null,
      tokenSelector: null,
    },
  });
  if (!audit.ok) throw new TypeError('Invalid session reauthentication audit event');
  const updated = await deps.sessions.markReauthenticatedByIdentity(ctx, {
    audit: audit.event,
    sessionId: session.session.id,
    identityId,
    authTime,
    now: now.toISOString(),
  });
  return updated ? { ok: true } : refuse('not_updated');
}
