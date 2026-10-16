import type { AuthenticatedSession } from '../auth/session.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp } from '../ids.js';
import type { AdminLog } from './administration.js';
import type { FailureReason, FenceGuard, MutationFence } from './fence.js';
import type { ServicePrincipalAuthority } from './service-principal-service.js';

export type RevocableToken =
  | {
      readonly id: string;
      readonly kind: 'pat';
      readonly userId: string;
      readonly projectId: null;
      readonly projectMode: 'all' | 'selected';
    }
  | {
      readonly id: string;
      readonly kind: 'svc';
      readonly userId: null;
      readonly projectId: string | null;
      readonly projectMode: null;
    }
  | {
      readonly id: string;
      readonly kind: 'cst';
      readonly userId: string | null;
      readonly projectId: string | null;
      readonly projectMode: null;
    };

export type TokenRevokeOutcome =
  | { readonly status: 'revoked'; readonly opId: string }
  | { readonly status: 'already_revoked' }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly reason: FailureReason }
  | { readonly status: 'indeterminate' };

export interface TokenRevokeStore {
  get(ctx: OrgContext, id: string): Promise<RevocableToken | null>;
  revoke(
    ctx: OrgContext,
    fence: MutationFence,
    guard: FenceGuard,
    tokenId: string,
    now: string,
  ): Promise<TokenRevokeOutcome>;
}

export interface TokenOwnershipGuard {
  ownPersonalToken(ctx: OrgContext, fence: MutationFence, tokenId: string): FenceGuard;
}

export interface TokenRevokeDeps {
  readonly tokens: TokenRevokeStore;
  readonly authority: Pick<ServicePrincipalAuthority, 'guard' | 'livePermissions'>;
  readonly ownership: TokenOwnershipGuard;
  readonly clock: Clock;
  readonly log: AdminLog;
}

export type TokenRevokeError = 'unauthenticated' | 'forbidden' | 'not_found' | 'indeterminate';

export type TokenRevokeResult =
  | { readonly ok: true; readonly value: { readonly revoked: boolean } }
  | { readonly ok: false; readonly error: TokenRevokeError };

export interface TokenRevokeInput {
  readonly tokenId: string;
  /** The project in the route URL; null on the own-token and organization routes. */
  readonly routeProjectId: string | null;
}

export interface TokenRevokeService {
  /**
   * CSRF is asserted by the HTTP boundary before this call. Only a user session revokes; a token
   * credential has no session. `revoked: false` is an idempotent repeat with no event.
   */
  revoke(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    fence: MutationFence,
    input: TokenRevokeInput,
  ): Promise<TokenRevokeResult>;
}

const ORG_REVOKE = 'org:tokens:revoke';
const PROJECT_REVOKE = 'project:tokens:revoke';

type Via = 'own' | 'organization' | 'project';

function fail(error: TokenRevokeError): TokenRevokeResult {
  return { ok: false, error };
}

export function createTokenRevokeService(deps: TokenRevokeDeps): TokenRevokeService {
  const { tokens, authority, ownership, clock } = deps;

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The revoke is already stored; a failing sink must not report it as failed.
    }
  }

  function deny(ctx: OrgContext, actorUserId: string | null): TokenRevokeResult {
    emit({ event: 'token.revoke_denied', orgId: ctx.orgId, tokenId: null, actorUserId });
    return fail('forbidden');
  }

  return {
    async revoke(ctx, authenticated, fence, input) {
      const { session, principal } = authenticated;
      if (typeof fence !== 'object' || fence === null) {
        throw new TypeError('revoke requires a mutation fence');
      }
      if (fence.userId !== session.userId || fence.sessionId !== session.id) {
        throw new TypeError('the mutation fence must belong to the revoking session');
      }
      if (
        (principal as { kind?: unknown } | null)?.kind !== 'user' ||
        principal.id !== session.userId
      ) {
        return deny(ctx, null);
      }
      const actorUserId = session.userId;
      const { tokenId, routeProjectId } = input;
      if (
        routeProjectId !== null &&
        (typeof routeProjectId !== 'string' || routeProjectId === '')
      ) {
        throw new TypeError('routeProjectId must be null or a non-empty string');
      }

      const found =
        typeof tokenId === 'string' && tokenId !== '' ? await tokens.get(ctx, tokenId) : null;
      const target =
        found !== null && (routeProjectId === null || found.projectId === routeProjectId)
          ? found
          : null;
      let via: Via;
      let guard: FenceGuard;
      if (target !== null && target.kind === 'pat' && target.userId === actorUserId) {
        via = 'own';
        guard = ownership.ownPersonalToken(ctx, fence, target.id);
      } else if ((await authority.livePermissions(ctx, fence, null)).has(ORG_REVOKE)) {
        if (target === null) return fail('not_found');
        via = 'organization';
        guard = authority.guard(ctx, fence, {
          permission: ORG_REVOKE,
          projectId: null,
          organizationAdmin: false,
          covers: [],
        });
      } else if (routeProjectId !== null) {
        const live = await authority.livePermissions(ctx, fence, routeProjectId);
        if (!live.has(PROJECT_REVOKE)) return deny(ctx, actorUserId);
        if (target === null || target.kind !== 'svc') return fail('not_found');
        via = 'project';
        guard = authority.guard(ctx, fence, {
          permission: PROJECT_REVOKE,
          projectId: routeProjectId,
          organizationAdmin: false,
          covers: [],
          allowArchived: true,
        });
      } else {
        return deny(ctx, actorUserId);
      }

      const outcome = await tokens.revoke(ctx, fence, guard, target.id, isoTimestamp(clock.now()));
      switch (outcome.status) {
        case 'revoked':
          emit({
            event: 'token.revoked',
            orgId: ctx.orgId,
            tokenId: target.id,
            kind: target.kind,
            projectId: target.projectId,
            via,
            actorUserId,
            opId: outcome.opId,
          });
          return { ok: true, value: { revoked: true } };
        case 'already_revoked':
          return { ok: true, value: { revoked: false } };
        case 'indeterminate':
          return fail('indeterminate');
        case 'not_found':
          return fail('not_found');
        case 'refused':
          return outcome.reason === 'authority' ? fail('unauthenticated') : deny(ctx, actorUserId);
      }
    },
  };
}
