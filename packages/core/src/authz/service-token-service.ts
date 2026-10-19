import type { ApiCall, IdempotencyRecord } from '../api/idempotency.js';
import { auditEvent, type AuditEvent } from '../audit/actions.js';
import type { AuthenticatedSession, SessionService } from '../auth/session.js';
import type { Organization } from '../db/organization.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import { isoTimestamp } from '../ids.js';
import type { Keyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { ActorContext, AdminLog } from './administration.js';
import type { MutationFence } from './fence.js';
import type { ProviderAnchor } from './pat-service.js';
import { parseScopeLevel, scopeAllows, type ScopeLevel } from './scope.js';
import type {
  ServicePrincipalAuthority,
  ServicePrincipalRecord,
} from './service-principal-service.js';

export interface MintedServiceToken {
  readonly selector: string;
  readonly hash: string;
  readonly pepperVersion: number;
  readonly plaintext: string;
}

export interface ServiceTokenAuthority {
  /** The issuer must still hold this permission at the principal's boundary when the batch commits. */
  readonly permission: string;
  readonly organizationAdmin: boolean;
  /** The token's conferred permissions: the batch requires each in both the issuer's live set and the principal's stored set. */
  readonly covers: readonly string[];
}

/** Carries no project list: the token is bound to the principal's project and writes no token_project rows. */
export interface ServiceTokenStoreInput {
  readonly id: string;
  readonly name: string;
  readonly servicePrincipalId: string;
  readonly projectId: string | null;
  /** The batch refuses when the principal's revision moved, so a narrowed permission set is not raced. */
  readonly principalRevision: number;
  readonly scope: ScopeLevel;
  readonly readOnly: boolean;
  readonly expiresAt: string;
  readonly now: string;
  readonly authority: ServiceTokenAuthority;
  /** Provider anchors of the organization, for the issuer's group and e-mail evidence. */
  readonly providerAnchors: readonly ProviderAnchor[];
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
}

export type ServiceTokenIssueOutcome =
  | { readonly status: 'issued'; readonly id: string; readonly plaintext: string }
  | {
      readonly status: 'refused';
      readonly reason:
        'authority' | 'conflict' | 'id_conflict' | 'selector_collision' | 'unclassified';
    }
  | { readonly status: 'indeterminate' };

export interface IssueServiceTokenCall {
  readonly ctx: OrgContext;
  readonly fence: MutationFence;
  readonly input: ServiceTokenStoreInput;
  readonly mint: () => MintedServiceToken | Promise<MintedServiceToken>;
}

/**
 * The guarded batch rechecks session, user, reauth freshness, principal status and revision, project
 * status and token_max_scope, and the issuer authority on database time.
 */
export interface ServiceTokenStore {
  issueService(
    ctx: OrgContext,
    fence: MutationFence,
    input: ServiceTokenStoreInput,
    mint: () => MintedServiceToken | Promise<MintedServiceToken>,
  ): Promise<ServiceTokenIssueOutcome>;
}

export interface ServiceTokenIssueInput {
  readonly routeProjectId: string | null;
  readonly servicePrincipalId: string;
  readonly name: string;
  readonly scope: ScopeLevel;
  /** A submitted read-only flag must agree with the scope. */
  readonly readOnly?: boolean;
  readonly expiresAt: string;
}

export type ServiceTokenError =
  | 'reauth_required'
  | 'invalid_name'
  | 'invalid_scope'
  | 'scope_conflict'
  | 'invalid_expiry'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'indeterminate';

export type ServiceTokenResult =
  | { readonly ok: true; readonly value: { readonly id: string; readonly plaintext: string } }
  | { readonly ok: false; readonly error: ServiceTokenError };

export interface ServiceTokenServiceDeps {
  readonly tokens: ServiceTokenStore;
  readonly principals: { get(ctx: OrgContext, id: string): Promise<ServicePrincipalRecord | null> };
  readonly authority: Pick<ServicePrincipalAuthority, 'livePermissions'>;
  readonly sessions: Pick<SessionService, 'isReauthFresh'>;
  readonly organizations: { get(ctx: OrgContext): Promise<Organization | null> };
  readonly providers: { anchors(ctx: OrgContext): Promise<readonly ProviderAnchor[]> };
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

export interface ServiceTokenService {
  /**
   * CSRF is asserted by the HTTP boundary before this call. Only a user session issues: a token
   * credential has no session, so no service credential can mint a sibling.
   */
  issue(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    actor: ActorContext,
    fence: MutationFence,
    input: ServiceTokenIssueInput,
    call: ApiCall,
  ): Promise<ServiceTokenResult>;
}

export const MAX_SERVICE_TOKEN_DAYS = 90;
export const MAX_CI_READ_ONLY_TOKEN_DAYS = 365;

const DAY_MS = 86_400_000;
const NAME_MAX_LENGTH = 100;
const FORBIDDEN_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELECTOR_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SELECTOR_LENGTH = 12;
const SECRET_BYTES = 32;
const PROJECT_ISSUE = 'project:tokens:create';
const ORG_ISSUE = 'org:service-principals:write';
const LEVEL_ANCHOR: Readonly<Record<ScopeLevel, string | null>> = {
  read: 'project:packages:read',
  write: 'project:packages:write',
  full: null,
};

function fail(error: ServiceTokenError): ServiceTokenResult {
  return { ok: false, error };
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string' || FORBIDDEN_NAME_CHARACTER.test(name) || name.trim() === '') {
    return false;
  }
  return Array.from(name).length <= NAME_MAX_LENGTH;
}

function canonicalTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? null : ms;
}

function randomSelector(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SELECTOR_LENGTH));
  return Array.from(bytes, (byte) => SELECTOR_ALPHABET.charAt(byte & 31)).join('');
}

function requirementFor(projectId: string | null): {
  permission: string;
  organizationAdmin: boolean;
} {
  return projectId === null
    ? { permission: ORG_ISSUE, organizationAdmin: true }
    : { permission: PROJECT_ISSUE, organizationAdmin: false };
}

/** The principal's stored permissions this level would confer; null when the level asks for more than it stores. */
function conferred(target: ServicePrincipalRecord, level: ScopeLevel): string[] | null {
  const covers = [
    ...new Set(
      target.permissions.filter(
        (name) =>
          scopeAllows(level, name) && (target.projectId === null || name.startsWith('project:')),
      ),
    ),
  ].sort();
  const anchor = LEVEL_ANCHOR[level];
  if (anchor !== null && !covers.includes(anchor)) return null;
  return covers.length === 0 ? null : covers;
}

export function createServiceTokenService(deps: ServiceTokenServiceDeps): ServiceTokenService {
  const { tokens, principals, authority, sessions, organizations, providers, keyring, clock, ids } =
    deps;

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The token is already stored; a failing sink must not report it as failed.
    }
  }

  function deny(ctx: OrgContext, actorUserId: string | null): ServiceTokenResult {
    emit({ event: 'token.issue_denied', kind: 'svc', orgId: ctx.orgId, actorUserId });
    return fail('forbidden');
  }

  async function mint(): Promise<MintedServiceToken> {
    const pepperVersion = keyring.currentVersion;
    const selector = randomSelector();
    const plaintext = formatToken(
      'svc',
      selector,
      crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
    );
    return {
      selector,
      hash: await hashToken(keyring, pepperVersion, plaintext),
      pepperVersion,
      plaintext,
    };
  }

  return {
    async issue(ctx, authenticated, actor, fence, request, call) {
      const input = {
        servicePrincipalId: request.servicePrincipalId,
        routeProjectId: request.routeProjectId,
        name: request.name,
        scope: request.scope,
        readOnly: request.readOnly,
        expiresAt: request.expiresAt,
      };
      const { session, principal } = authenticated;
      if (typeof fence !== 'object' || fence === null) {
        throw new TypeError('issue requires a mutation fence');
      }
      if (fence.userId !== session.userId || fence.sessionId !== session.id) {
        throw new TypeError('the mutation fence must belong to the issuing session');
      }
      if (
        (principal as { kind?: unknown } | null)?.kind !== 'user' ||
        principal.id !== session.userId ||
        (actor as { kind?: unknown } | null)?.kind !== 'organization' ||
        actor.userId !== session.userId
      ) {
        return deny(ctx, null);
      }
      if (
        input.routeProjectId !== null &&
        (typeof input.routeProjectId !== 'string' || input.routeProjectId === '')
      ) {
        throw new TypeError('routeProjectId must be null or a non-empty string');
      }
      if (!sessions.isReauthFresh(authenticated)) return fail('reauth_required');
      if (!isValidName(input.name)) return fail('invalid_name');
      const scope = parseScopeLevel(input.scope);
      if (!scope.ok) return fail('invalid_scope');
      const readOnly = scope.level === 'read';
      if (input.readOnly !== undefined && input.readOnly !== readOnly) {
        return fail('scope_conflict');
      }

      const nowMs = clock.now().getTime();
      const expiresMs = canonicalTimestampMs(input.expiresAt);
      if (expiresMs === null || expiresMs <= nowMs) return fail('invalid_expiry');
      const organization = await organizations.get(ctx);
      if (organization === null) return deny(ctx, session.userId);
      const configured = readOnly
        ? organization.settings.tokenCiReadonlyExpiryDays
        : organization.settings.tokenDefaultExpiryDays;
      if (!Number.isInteger(configured) || configured <= 0) return deny(ctx, session.userId);
      const days = Math.min(
        configured,
        readOnly ? MAX_CI_READ_ONLY_TOKEN_DAYS : MAX_SERVICE_TOKEN_DAYS,
      );
      if (expiresMs > nowMs + days * DAY_MS) return fail('invalid_expiry');

      const principalId = input.servicePrincipalId;
      const target =
        typeof principalId === 'string' && principalId !== ''
          ? await principals.get(ctx, principalId)
          : null;
      if (target === null || target.projectId !== input.routeProjectId) {
        const live = await authority.livePermissions(ctx, fence, null);
        return live.has(PROJECT_ISSUE) || live.has(ORG_ISSUE)
          ? fail('not_found')
          : deny(ctx, session.userId);
      }
      if (target.status !== 'active') return deny(ctx, session.userId);
      const requirement = requirementFor(target.projectId);
      if (requirement.organizationAdmin && actor.isOrganizationAdmin !== true) {
        return deny(ctx, session.userId);
      }
      const covers = conferred(target, scope.level);
      if (covers === null) return deny(ctx, session.userId);
      const live = await authority.livePermissions(ctx, fence, target.projectId);
      if (!live.has(requirement.permission) || !covers.every((name) => live.has(name))) {
        return deny(ctx, session.userId);
      }

      const providerAnchors = await providers.anchors(ctx);
      const storeNow = clock.now();
      if (expiresMs <= storeNow.getTime()) return fail('invalid_expiry');

      const id = ids.ulid();
      const audit = auditEvent({
        id: ids.ulid(),
        now: isoTimestamp(storeNow),
        action: 'token.issue',
        actor: { type: 'user', id: actor.userId },
        context: call.audit,
        target: { type: 'token', id },
        projectId: target.projectId,
        changes: {
          kind: { new: 'svc' },
          name: { new: input.name },
          scope: { new: scope.level },
          expires_at: { new: input.expiresAt },
          project_mode: { new: target.projectId === null ? 'all' : 'selected' },
          project_count: { new: target.projectId === null ? 0 : 1 },
        },
      });
      if (!audit.ok) throw new TypeError('Invalid token issue audit event');
      const outcome = await tokens.issueService(
        ctx,
        fence,
        {
          id,
          name: input.name,
          servicePrincipalId: target.id,
          projectId: target.projectId,
          principalRevision: target.revision,
          scope: scope.level,
          readOnly,
          expiresAt: input.expiresAt,
          now: isoTimestamp(storeNow),
          authority: { ...requirement, covers },
          providerAnchors,
          audit: audit.event,
          ...(call.idempotency === undefined
            ? {}
            : {
                idempotency: {
                  ...call.idempotency,
                  responseJson: JSON.stringify({ code: 'already_issued', id }),
                },
              }),
        },
        mint,
      );

      if (outcome.status === 'issued') {
        emit({
          event: 'token.issued',
          kind: 'svc',
          orgId: ctx.orgId,
          tokenId: outcome.id,
          servicePrincipalId: target.id,
          projectId: target.projectId,
          actorUserId: session.userId,
          scope: scope.level,
        });
        return { ok: true, value: { id: outcome.id, plaintext: outcome.plaintext } };
      }
      if (outcome.status === 'indeterminate') return fail('indeterminate');
      switch (outcome.reason) {
        case 'authority':
          if (!sessions.isReauthFresh(authenticated)) return fail('reauth_required');
          return deny(ctx, session.userId);
        case 'conflict':
        case 'id_conflict':
        case 'selector_collision':
          return fail('conflict');
        default:
          throw new Error('service token issue answered unclassified');
      }
    },
  };
}
