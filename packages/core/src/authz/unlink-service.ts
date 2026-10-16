import type { AuthenticatedSession, SessionService } from '../auth/session.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp } from '../ids.js';
import { isValidProviderId, isValidSubject } from '../identity/port.js';
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

function requireFence(fence: unknown): asserts fence is MutationFence {
  if (!isRecord(fence) || !isId(fence['userId']) || !isId(fence['sessionId'])) {
    throw new TypeError('identity unlink requires a mutation fence');
  }
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

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log(entry);
    } catch {
      // A failing sink must not change the outcome already decided.
    }
  }

  function denied(ctx: OrgContext, actorUserId: string | null): UnlinkResult {
    emit({ level: 'warn', event: 'identity.unlink_denied', orgId: ctx.orgId, actorUserId });
    return fail('forbidden');
  }

  return {
    async unlinkIdentity(ctx, authenticated, snapshot, fence, request) {
      requireFence(fence);
      const copy = copySession(authenticated);
      if (!isAuthorized(copy, snapshot, fence)) return denied(ctx, copy.userId);
      const frozen = {
        session: { reauthAt: copy.reauthAt },
        principal: { kind: 'user', id: copy.userId },
      } as unknown as AuthenticatedSession;
      if (!sessions.isReauthFresh(frozen)) return fail('reauth_required');
      const input = copyRequest(request);
      if (input === null) return fail('invalid_input');

      const anchors = await providers.anchors(ctx);
      const anchor = anchors.find((entry) => entry.provider === input.provider)?.anchor;
      if (anchor === undefined) return fail('conflict');

      const outcome = await unlinks.unlinkIdentity(ctx, fence, {
        ...input,
        anchor,
        now: isoTimestamp(clock.now()),
      });
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
