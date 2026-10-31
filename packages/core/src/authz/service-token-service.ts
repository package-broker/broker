import type { OidcReplayBatch, TrustedPublisherBinding } from '../db/oidc.js';
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
import {
  defaultExpiry,
  lifetimeExpiry,
  resolveTokenLifetimePolicy,
  type TokenLifetimePolicy,
} from './token-lifetime.js';

export interface MintedServiceToken {
  readonly selector: string;
  readonly hash: string;
  readonly pepperVersion: number;
  readonly plaintext: string;
}

export interface WorkloadTokenFence {
  readonly publisher: TrustedPublisherBinding;
  readonly replay: OidcReplayBatch;
}
export interface WorkloadTokenInput {
  readonly id: string;
  readonly now: string;
  readonly expiresAt: string;
  readonly audit: AuditEvent;
}
export interface WorkloadTokenStore {
  issueWorkload(
    ctx: OrgContext,
    fence: WorkloadTokenFence,
    input: WorkloadTokenInput,
    mint: () => MintedServiceToken | Promise<MintedServiceToken>,
  ): Promise<ServiceTokenIssueOutcome>;
}
export function createWorkloadTokenService(deps: {
  readonly tokens: WorkloadTokenStore;
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}) {
  return {
    async issueWorkload(
      ctx: OrgContext,
      fence: WorkloadTokenFence,
      input: {
        readonly requestId: string;
        readonly changes: NonNullable<Parameters<typeof auditEvent>[0]['changes']>;
      },
    ) {
      const now = deps.clock.now();
      const expiry = requestedExpiry(
        { expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString() },
        now.getTime(),
        1,
      );
      if (!expiry.ok || expiry.expiresMs === null) throw new TypeError('invalid_workload_expiry');
      const expiresAt = new Date(expiry.expiresMs).toISOString();
      const id = deps.ids.ulid();
      const event = auditEvent({
        id: deps.ids.ulid(),
        now: now.toISOString(),
        action: 'token.workload_issue',
        actor: { type: 'service_principal', id: fence.publisher.servicePrincipalId },
        context: {
          opId: deps.ids.ulid(),
          requestId: input.requestId,
          sourceIp: null,
          tokenSelector: null,
        },
        target: { type: 'token', id },
        changes: { ...input.changes, token_id: { new: id }, expires_at: { new: expiresAt } },
      });
      if (!event.ok) throw new TypeError('invalid_workload_audit');
      const result = await deps.tokens.issueWorkload(
        ctx,
        fence,
        { id, now: now.toISOString(), expiresAt, audit: event.event },
        async () => {
          const selector = randomSelector();
          const plaintext = formatToken(
            'svc',
            selector,
            crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
          );
          const pepperVersion = deps.keyring.currentVersion;
          return {
            selector,
            plaintext,
            pepperVersion,
            hash: await hashToken(deps.keyring, pepperVersion, plaintext),
          };
        },
      );
      return result.status === 'issued'
        ? {
            status: 'issued' as const,
            token: result.plaintext,
            created: now.toISOString(),
            expires: expiresAt,
          }
        : result;
    },
  };
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
  readonly maxLifetimeDays: number;
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

export interface ServiceTokenRecord {
  readonly id: string;
  readonly servicePrincipalId: string;
  readonly projectId: string | null;
  readonly scope: ScopeLevel;
  readonly readOnly: boolean;
  readonly name: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface ServiceTokenRotateInput {
  readonly tokenId: string;
  readonly routeProjectId: string | null;
  readonly overlapDays: 0 | 1 | 7;
  readonly name?: string;
  readonly expiresAt?: string;
  readonly lifetimeDays?: number;
}

export interface ServiceTokenRotateStoreInput extends ServiceTokenStoreInput {
  readonly tokenId: string;
  readonly overlapDays: 0 | 1 | 7;
  readonly rotationAudit: AuditEvent;
}

export type ServiceTokenRotateOutcome =
  | {
      readonly status: 'rotated';
      readonly id: string;
      readonly plaintext: string;
      readonly replacedExpiresAt: string;
    }
  | Exclude<ServiceTokenIssueOutcome, { readonly status: 'issued' }>;

export type ServiceTokenRotateError = ServiceTokenError | 'invalid_overlap';

export type ServiceTokenRotateResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly id: string;
        readonly plaintext: string;
        readonly replacedTokenId: string;
        readonly replacedExpiresAt: string;
      };
    }
  | { readonly ok: false; readonly error: ServiceTokenRotateError };

export interface ServiceTokenRotationStore {
  getService(ctx: OrgContext, tokenId: string): Promise<ServiceTokenRecord | null>;
  rotateService(
    ctx: OrgContext,
    fence: MutationFence,
    input: ServiceTokenRotateStoreInput,
    mint: () => MintedServiceToken | Promise<MintedServiceToken>,
  ): Promise<ServiceTokenRotateOutcome>;
}

/**
 * The guarded batch rechecks session, user, reauth freshness, principal status and revision, project
 * status and token_max_scope, and the issuer authority on database time.
 */
/** Issuance-only adapters may omit rotation; runtimes supply the complete repository. */
export interface ServiceTokenStore
  extends Partial<ServiceTokenRotationStore>, Partial<WorkloadTokenStore> {
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
  readonly expiresAt?: string;
  readonly lifetimeDays?: number;
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
  readonly lifetime?: TokenLifetimePolicy;
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
  rotate(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    actor: ActorContext,
    fence: MutationFence,
    input: ServiceTokenRotateInput,
    call?: ApiCall,
  ): Promise<ServiceTokenRotateResult>;
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

function fail<E extends ServiceTokenRotateError>(
  error: E,
): { readonly ok: false; readonly error: E } {
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

function requestedExpiry(
  request: Pick<ServiceTokenIssueInput, 'expiresAt' | 'lifetimeDays'>,
  nowMs: number,
  maxDays: number,
):
  | { readonly ok: true; readonly expiresMs: number | null; readonly defaulted: boolean }
  | { readonly ok: false; readonly error: 'invalid_expiry' } {
  const expiryProvided = Object.hasOwn(request, 'expiresAt');
  const lifetimeProvided = Object.hasOwn(request, 'lifetimeDays');
  if (expiryProvided && lifetimeProvided) return fail('invalid_expiry');
  const defaulted = !expiryProvided && !lifetimeProvided;
  const expiresMs = expiryProvided
    ? canonicalTimestampMs(request.expiresAt)
    : lifetimeProvided
      ? lifetimeExpiry(nowMs, maxDays, request.lifetimeDays as number)
      : null;
  if (
    !defaulted &&
    (expiresMs === null || expiresMs <= nowMs || expiresMs > nowMs + maxDays * DAY_MS)
  ) {
    return fail('invalid_expiry');
  }
  return { ok: true, expiresMs, defaulted };
}

export function createServiceTokenService(deps: ServiceTokenServiceDeps): ServiceTokenService {
  const { tokens, principals, authority, sessions, organizations, providers, keyring, clock, ids } =
    deps;

  const maxDays = (deps.lifetime ?? resolveTokenLifetimePolicy(undefined)).service.maxDays;

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The token is already stored; a failing sink must not report it as failed.
    }
  }

  function deny(
    ctx: OrgContext,
    actorUserId: string | null,
  ): { readonly ok: false; readonly error: 'forbidden' } {
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

  async function issue(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    actor: ActorContext,
    fence: MutationFence,
    request: ServiceTokenIssueInput,
    call: ApiCall,
    rotation?: { old: ServiceTokenRecord; overlapDays: 0 | 1 | 7 },
  ): Promise<ServiceTokenResult | Extract<ServiceTokenRotateResult, { ok: true }>> {
    const input = {
      servicePrincipalId: request.servicePrincipalId,
      routeProjectId: request.routeProjectId,
      name: request.name,
      scope: request.scope,
      readOnly: request.readOnly,
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
    const expiry = requestedExpiry(request, nowMs, maxDays);
    if (!expiry.ok) return expiry;
    const { defaulted } = expiry;
    let { expiresMs } = expiry;
    const organization = await organizations.get(ctx);
    if (organization === null) return deny(ctx, session.userId);
    const configured = organization.settings.tokenDefaultExpiryDays;
    if (!Number.isSafeInteger(configured) || configured <= 0) return deny(ctx, session.userId);
    if (defaulted) expiresMs = defaultExpiry(nowMs, maxDays, configured);
    if (expiresMs === null) return deny(ctx, session.userId);
    const expiresAt = new Date(expiresMs).toISOString();

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
    if (
      !live.has(requirement.permission) ||
      !covers.every((name) => live.has(name)) ||
      (rotation !== undefined &&
        !live.has(target.projectId === null ? 'org:tokens:revoke' : 'project:tokens:revoke'))
    ) {
      return deny(ctx, session.userId);
    }

    if (
      rotation !== undefined &&
      (rotation.old.revokedAt !== null || Date.parse(rotation.old.expiresAt) <= nowMs)
    ) {
      return fail('conflict');
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
        expires_at: { new: expiresAt },
        project_mode: { new: target.projectId === null ? 'all' : 'selected' },
        project_count: { new: target.projectId === null ? 0 : 1 },
      },
    });
    if (!audit.ok) throw new TypeError('Invalid token issue audit event');
    const storeInput: ServiceTokenStoreInput = {
      id,
      name: input.name,
      servicePrincipalId: target.id,
      projectId: target.projectId,
      principalRevision: target.revision,
      scope: scope.level,
      readOnly,
      expiresAt,
      maxLifetimeDays: maxDays,
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
    };
    let outcome: ServiceTokenIssueOutcome | ServiceTokenRotateOutcome;
    if (rotation === undefined) {
      outcome = await tokens.issueService(ctx, fence, storeInput, mint);
    } else {
      if (tokens.rotateService === undefined) throw new TypeError('rotation store is required');
      const rotationAudit = auditEvent({
        id: ids.ulid(),
        now: storeInput.now,
        action: 'token.rotate',
        actor: { type: 'user', id: actor.userId },
        context: call.audit,
        target: { type: 'token', id: rotation.old.id },
        projectId: target.projectId,
      });
      if (!rotationAudit.ok) throw new TypeError('Invalid token rotation audit event');
      outcome = await tokens.rotateService(
        ctx,
        fence,
        {
          ...storeInput,
          tokenId: rotation.old.id,
          overlapDays: rotation.overlapDays,
          rotationAudit: rotationAudit.event,
        },
        mint,
      );
    }
    if (outcome.status === 'rotated' && rotation !== undefined) {
      emit({
        event: 'token.rotated',
        orgId: ctx.orgId,
        tokenId: rotation.old.id,
        replacementId: outcome.id,
        projectId: target.projectId,
        overlapDays: rotation.overlapDays,
        actorUserId: session.userId,
        replacedExpiresAt: outcome.replacedExpiresAt,
        expiresAt,
      });
      return {
        ok: true,
        value: {
          id: outcome.id,
          plaintext: outcome.plaintext,
          replacedTokenId: rotation.old.id,
          replacedExpiresAt: outcome.replacedExpiresAt,
        },
      };
    }
    if (outcome.status === 'issued') {
      emit({
        event: 'token.issued',
        expiresAt,
        defaulted,
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
    if (outcome.status === 'rotated') throw new Error('unexpected rotation outcome');
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
  }

  return {
    issue,
    async rotate(ctx, authenticated, actor, fence, request, call) {
      const { session, principal } = authenticated;
      if (typeof fence !== 'object' || fence === null)
        throw new TypeError('rotate requires a mutation fence');
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
        request.routeProjectId !== null &&
        (typeof request.routeProjectId !== 'string' || request.routeProjectId === '')
      ) {
        throw new TypeError('routeProjectId must be null or a non-empty string');
      }
      if (!sessions.isReauthFresh(authenticated)) return fail('reauth_required');
      if (![0, 1, 7].includes(request.overlapDays)) return fail('invalid_overlap');
      if (Object.hasOwn(request, 'name') && !isValidName(request.name)) return fail('invalid_name');
      const expiry = requestedExpiry(request, clock.now().getTime(), maxDays);
      if (!expiry.ok) return expiry;
      if (tokens.getService === undefined) throw new TypeError('rotation store is required');
      const old =
        typeof request.tokenId === 'string' && request.tokenId !== ''
          ? await tokens.getService(ctx, request.tokenId)
          : null;
      if (old === null || old.projectId !== request.routeProjectId) {
        const live = await authority.livePermissions(ctx, fence, null);
        return live.has(PROJECT_ISSUE) || live.has(ORG_ISSUE)
          ? fail('not_found')
          : deny(ctx, session.userId);
      }
      let rotationCall = call;
      if (rotationCall === undefined) {
        const auditId = ids.ulid();
        rotationCall = {
          audit: { opId: auditId, requestId: auditId, sourceIp: null, tokenSelector: null },
        };
      }
      const result = await issue(
        ctx,
        authenticated,
        actor,
        fence,
        {
          servicePrincipalId: old.servicePrincipalId,
          routeProjectId: request.routeProjectId,
          name: request.name === undefined ? old.name : request.name,
          scope: old.scope,
          readOnly: old.readOnly,
          ...(Object.hasOwn(request, 'expiresAt')
            ? { expiresAt: request.expiresAt as string }
            : {}),
          ...(Object.hasOwn(request, 'lifetimeDays')
            ? { lifetimeDays: request.lifetimeDays as number }
            : {}),
        },
        rotationCall,
        { old, overlapDays: request.overlapDays },
      );
      if (!result.ok) return result;
      if (!('replacedTokenId' in result.value)) throw new Error('unexpected issue outcome');
      return { ok: true, value: result.value };
    },
  };
}
