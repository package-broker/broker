import type { ApiCall } from '../api/idempotency.js';
import { auditEvent, type AuditEvent, type AuditAction } from '../audit/actions.js';
import type { AuthenticatedSession, SessionService } from '../auth/session.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp, ulid } from '../ids.js';
import { isValidProviderId, isValidSubject, isValidTrustAnchor } from '../identity/port.js';
import { buildOrganizationActor, type ActorAccessSnapshot } from './actor.js';
import type { AdminLog } from './administration.js';
import type { MutationFence } from './fence.js';
import type { ProviderAnchor } from './pat-service.js';

export interface UnlinkStoreInput {
  readonly identityId: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  /** The provider's current trust anchor; it becomes the issuer of the block. */
  readonly anchor: string;
  readonly now: string;
}

export type UnlinkStoreOutcome =
  'unlinked' | 'authority' | 'conflict' | 'last_holder' | 'indeterminate';

/** One fenced batch that re-proves the actor's live session and authority on database time. */
export interface IdentityUnlinkStore {
  unlinkIdentity(
    ctx: OrgContext,
    fence: MutationFence,
    input: UnlinkStoreInput,
    audit: { readonly unlink: AuditEvent; readonly block: AuditEvent },
  ): Promise<UnlinkStoreOutcome>;
}

export interface UnlinkIdentityRequest {
  readonly identityId: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
}

export type UnlinkError =
  'forbidden' | 'reauth_required' | 'invalid_input' | 'conflict' | 'last_holder' | 'indeterminate';

export type UnlinkResult =
  { readonly ok: true } | { readonly ok: false; readonly error: UnlinkError };

export interface UnlinkServiceDeps {
  readonly unlinks: IdentityUnlinkStore;
  readonly sessions: Pick<SessionService, 'isReauthFresh'>;
  readonly providers: { anchors(ctx: OrgContext): Promise<readonly ProviderAnchor[]> };
  readonly clock: Clock;
  readonly log: AdminLog;
}

/**
 * CSRF is asserted by the HTTP boundary before this call. Needs an organization admin holding
 * `org:users:write`, acting through a live user session reauthenticated within the window;
 * refusals carry a fixed code only.
 */
export interface UnlinkService {
  unlinkIdentity(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    snapshot: ActorAccessSnapshot,
    fence: MutationFence,
    request: UnlinkIdentityRequest,
    call: ApiCall,
  ): Promise<UnlinkResult>;
}

interface SessionCopy {
  readonly id: string | null;
  readonly userId: string | null;
  readonly reauthAt: unknown;
  readonly principalKind: unknown;
  readonly principalId: unknown;
}

const OK: UnlinkResult = Object.freeze({ ok: true });
const REQUIRED_PERMISSION = 'org:users:write';

function fail(error: UnlinkError): UnlinkResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function copySession(authenticated: unknown): SessionCopy {
  const session = isRecord(authenticated) ? authenticated['session'] : undefined;
  const principal = isRecord(authenticated) ? authenticated['principal'] : undefined;
  const id = isRecord(session) ? session['id'] : undefined;
  const userId = isRecord(session) ? session['userId'] : undefined;
  return {
    id: isId(id) ? id : null,
    userId: isId(userId) ? userId : null,
    reauthAt: isRecord(session) ? session['reauthAt'] : null,
    principalKind: isRecord(principal) ? principal['kind'] : undefined,
    principalId: isRecord(principal) ? principal['id'] : undefined,
  };
}

function isAuthorized(
  copy: SessionCopy,
  snapshot: ActorAccessSnapshot,
  fence: MutationFence,
): boolean {
  const { id, userId } = copy;
  if (id === null || userId === null) return false;
  if (copy.principalKind !== 'user' || copy.principalId !== userId) return false;
  const actor = buildOrganizationActor('organization', snapshot);
  if (actor === null || !actor.isOrganizationAdmin) return false;
  if (!actor.permissions.has(REQUIRED_PERMISSION)) return false;
  if (actor.userId !== userId || actor.sessionId !== id) return false;
  return fence.userId === userId && fence.sessionId === id;
}

function requireFence(fence: unknown, operation: string): asserts fence is MutationFence {
  if (!isRecord(fence) || !isId(fence['userId']) || !isId(fence['sessionId'])) {
    throw new TypeError(`${operation} requires a mutation fence`);
  }
}

function frozenSession(copy: SessionCopy): AuthenticatedSession {
  return {
    session: { reauthAt: copy.reauthAt },
    principal: { kind: 'user', id: copy.userId },
  } as unknown as AuthenticatedSession;
}

function emitter(log: AdminLog): (entry: Readonly<Record<string, unknown>>) => void {
  return (entry) => {
    try {
      log(entry);
    } catch {
      // A failing sink must not change the outcome already decided.
    }
  };
}

function copyRequest(request: unknown): UnlinkIdentityRequest | null {
  if (!isRecord(request)) return null;
  const identityId = request['identityId'];
  const userId = request['userId'];
  const provider = request['provider'];
  const subject = request['subject'];
  if (!isId(identityId) || !isId(userId)) return null;
  if (typeof provider !== 'string' || !isValidProviderId(provider)) return null;
  if (!isValidSubject(subject)) return null;
  return { identityId, userId, provider, subject };
}

export function createUnlinkService(deps: UnlinkServiceDeps): UnlinkService {
  const { unlinks, sessions, providers, clock } = deps;
  const emit = emitter(deps.log);

  function denied(ctx: OrgContext, actorUserId: string | null): UnlinkResult {
    emit({ level: 'warn', event: 'identity.unlink_denied', orgId: ctx.orgId, actorUserId });
    return fail('forbidden');
  }

  return {
    async unlinkIdentity(ctx, authenticated, snapshot, fence, request, call) {
      requireFence(fence, 'identity unlink');
      const copy = copySession(authenticated);
      if (!isAuthorized(copy, snapshot, fence)) return denied(ctx, copy.userId);
      const frozen = frozenSession(copy);
      if (!sessions.isReauthFresh(frozen)) return fail('reauth_required');
      const input = copyRequest(request);
      if (input === null) return fail('invalid_input');

      const anchors = await providers.anchors(ctx);
      const anchor = anchors.find((entry) => entry.provider === input.provider)?.anchor;
      if (anchor === undefined) return fail('conflict');

      const now = isoTimestamp(clock.now());
      const outcome = await unlinks.unlinkIdentity(
        ctx,
        fence,
        {
          ...input,
          anchor,
          now,
        },
        {
          unlink: identityAudit('identity.unlink', fence, call, now),
          block: identityAudit('identity.block', fence, call, now),
        },
      );
      switch (outcome) {
        case 'unlinked':
          emit({
            level: 'info',
            event: 'identity.unlinked',
            orgId: ctx.orgId,
            actorUserId: copy.userId,
            identityId: input.identityId,
            userId: input.userId,
          });
          return OK;
        case 'authority':
          if (!sessions.isReauthFresh(frozen)) return fail('reauth_required');
          return denied(ctx, copy.userId);
        case 'conflict':
          return fail('conflict');
        case 'last_holder':
          return fail('last_holder');
        case 'indeterminate':
          return fail('indeterminate');
        default:
          throw new Error('identity unlink answered an unknown outcome');
      }
    },
  };
}

export interface UnblockIdentityRequest {
  readonly provider: string;
  /** The trust anchor recorded on the block when it was placed. */
  readonly issuer: string;
  readonly subject: string;
}

export type UnblockStoreOutcome = 'unblocked' | 'authority' | 'not_found' | 'indeterminate';

/** One fenced batch that re-proves the actor's live session and authority, then deletes one block. */
export interface IdentityBlockStore {
  unblock(
    ctx: OrgContext,
    fence: MutationFence,
    request: UnblockIdentityRequest,
    audit: AuditEvent,
  ): Promise<UnblockStoreOutcome>;
}

export type UnblockError =
  'not_found' | 'forbidden' | 'reauth_required' | 'invalid_input' | 'indeterminate';

export type UnblockResult =
  { readonly ok: true } | { readonly ok: false; readonly error: UnblockError };

export interface UnblockServiceDeps {
  readonly blocks: IdentityBlockStore;
  readonly sessions: Pick<SessionService, 'isReauthFresh'>;
  readonly clock: Clock;
  readonly log: AdminLog;
}

/**
 * Lifts one identity block. CSRF is asserted by the HTTP boundary before this call; the authority,
 * reauthentication and logging rules are those of `UnlinkService`.
 */
export interface UnblockService {
  unblockIdentity(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    snapshot: ActorAccessSnapshot,
    fence: MutationFence,
    request: UnblockIdentityRequest,
    call: ApiCall,
  ): Promise<UnblockResult>;
}

const UNBLOCKED: UnblockResult = Object.freeze({ ok: true });

function failUnblock(error: UnblockError): UnblockResult {
  return { ok: false, error };
}

function copyUnblockRequest(request: unknown): UnblockIdentityRequest | null {
  if (!isRecord(request)) return null;
  const provider = request['provider'];
  const issuer = request['issuer'];
  const subject = request['subject'];
  if (typeof provider !== 'string' || !isValidProviderId(provider)) return null;
  if (typeof issuer !== 'string' || !isValidTrustAnchor(issuer)) return null;
  if (!isValidSubject(subject)) return null;
  return { provider, issuer, subject };
}

export function createUnblockService(deps: UnblockServiceDeps): UnblockService {
  const { blocks, sessions, clock } = deps;
  const emit = emitter(deps.log);

  function denied(
    ctx: OrgContext,
    actorUserId: string | null,
    provider: string | null,
  ): UnblockResult {
    emit({
      level: 'warn',
      event: 'identity.unblock_denied',
      orgId: ctx.orgId,
      actorUserId,
      provider,
    });
    return failUnblock('forbidden');
  }

  return {
    async unblockIdentity(ctx, authenticated, snapshot, fence, request, call) {
      requireFence(fence, 'identity unblock');
      const copy = copySession(authenticated);
      if (!isAuthorized(copy, snapshot, fence)) return denied(ctx, copy.userId, null);
      const frozen = frozenSession(copy);
      if (!sessions.isReauthFresh(frozen)) return failUnblock('reauth_required');
      const input = copyUnblockRequest(request);
      if (input === null) return failUnblock('invalid_input');

      const outcome = await blocks.unblock(
        ctx,
        fence,
        input,
        identityAudit('identity.unblock', fence, call, isoTimestamp(clock.now())),
      );
      switch (outcome) {
        case 'unblocked':
          emit({
            level: 'info',
            event: 'identity.unblocked',
            orgId: ctx.orgId,
            actorUserId: copy.userId,
            provider: input.provider,
          });
          return UNBLOCKED;
        case 'authority':
          if (!sessions.isReauthFresh(frozen)) return failUnblock('reauth_required');
          return denied(ctx, copy.userId, input.provider);
        case 'not_found':
          return failUnblock('not_found');
        case 'indeterminate':
          return failUnblock('indeterminate');
        default:
          throw new Error('identity unblock answered an unknown outcome');
      }
    },
  };
}

function identityAudit(
  action: AuditAction,
  fence: MutationFence,
  call: ApiCall,
  now: string,
): AuditEvent {
  const result = auditEvent({
    id: ulid(),
    now,
    action,
    actor: { type: 'user', id: fence.userId },
    target: { type: 'identity_block', id: null },
    projectId: null,
    context: call.audit,
  });
  if (!result.ok) throw new TypeError('identity audit event is invalid');
  return result.event;
}
