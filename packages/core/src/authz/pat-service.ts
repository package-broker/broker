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
import type { AdminLog } from './administration.js';
import type { MutationFence } from './fence.js';
import { parseScopeLevel, type ScopeLevel } from './scope.js';
import {
  defaultExpiry,
  lifetimeExpiry,
  resolveTokenLifetimePolicy,
  type TokenLifetimePolicy,
} from './token-lifetime.js';

export interface MintedPersonalToken {
  readonly selector: string;
  readonly hash: string;
  readonly pepperVersion: number;
  readonly plaintext: string;
}

export type PersonalTokenValidation =
  { readonly kind: 'local' } | { readonly kind: 'sso'; readonly identityId: string };

export interface ProviderAnchor {
  readonly provider: string;
  readonly anchor: string;
  readonly emailAuthoritative: boolean;
}

export interface PersonalTokenStoreInput {
  readonly id: string;
  readonly name: string;
  readonly scope: ScopeLevel;
  readonly expiresAt: string;
  readonly maxLifetimeDays: number;
  readonly now: string;
  readonly validation: PersonalTokenValidation;
  readonly projectMode: 'all' | 'selected';
  readonly projectIds: readonly string[];
  readonly providerAnchors: readonly ProviderAnchor[];
  readonly audit: AuditEvent;
  readonly idempotency?: IdempotencyRecord;
}

export type PersonalTokenIssueOutcome =
  | { readonly status: 'issued'; readonly id: string; readonly plaintext: string }
  | {
      readonly status: 'refused';
      readonly reason: 'authority' | 'id_conflict' | 'selector_collision' | 'unclassified';
    }
  | { readonly status: 'indeterminate' };

export interface IssuePersonalTokenCall {
  readonly ctx: OrgContext;
  readonly fence: MutationFence;
  readonly input: PersonalTokenStoreInput;
  readonly mint: () => MintedPersonalToken | Promise<MintedPersonalToken>;
}

/** The guarded batch rechecks session, user, reauth freshness, scope and project policy on database time. */
export interface PersonalTokenStore {
  issuePersonal(
    ctx: OrgContext,
    fence: MutationFence,
    input: PersonalTokenStoreInput,
    mint: () => MintedPersonalToken | Promise<MintedPersonalToken>,
  ): Promise<PersonalTokenIssueOutcome>;
}

export interface PersonalTokenIssueInput {
  readonly name: string;
  readonly scope: ScopeLevel;
  /** A stored or submitted read-only flag must agree with the scope. */
  readonly readOnly?: boolean;
  readonly expiresAt?: string;
  readonly lifetimeDays?: number;
  readonly projectMode: 'all' | 'selected';
  /** Empty for `all`; 1 to 200 distinct ids for `selected`. */
  readonly projectIds: readonly string[];
}

export type PersonalTokenError =
  | 'reauth_required'
  | 'invalid_name'
  | 'invalid_scope'
  | 'scope_conflict'
  | 'invalid_expiry'
  | 'invalid_projects'
  | 'forbidden'
  | 'conflict'
  | 'indeterminate';

export type PersonalTokenResult =
  | { readonly ok: true; readonly value: { readonly id: string; readonly plaintext: string } }
  | { readonly ok: false; readonly error: PersonalTokenError };

export interface PersonalTokenServiceDeps {
  readonly lifetime?: TokenLifetimePolicy;
  readonly tokens: PersonalTokenStore;
  readonly sessions: Pick<SessionService, 'isReauthFresh'>;
  readonly organizations: { get(ctx: OrgContext): Promise<Organization | null> };
  readonly providers: { anchors(ctx: OrgContext): Promise<readonly ProviderAnchor[]> };
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}

export interface PersonalTokenService {
  /**
   * CSRF is asserted by the HTTP boundary before this call. Needs no permission: any
   * authenticated, freshly reauthenticated session may issue for itself. An expiry that passes
   * the application cap but fails the database cap surfaces as `forbidden`, like any batch
   * authority loss.
   */
  issue(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    fence: MutationFence,
    input: PersonalTokenIssueInput,
    call: ApiCall,
  ): Promise<PersonalTokenResult>;
}

export const MAX_PERSONAL_TOKEN_PROJECTS = 200;

const DAY_MS = 86_400_000;
const NAME_MAX_LENGTH = 100;
const FORBIDDEN_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELECTOR_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SELECTOR_LENGTH = 12;
const SECRET_BYTES = 32;

function fail(error: PersonalTokenError): PersonalTokenResult {
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

function validProjects(mode: unknown, ids: unknown): ids is readonly string[] {
  if (!Array.isArray(ids)) return false;
  if (mode === 'all') return ids.length === 0;
  if (mode !== 'selected') return false;
  return (
    ids.length >= 1 &&
    ids.length <= MAX_PERSONAL_TOKEN_PROJECTS &&
    ids.every((id) => typeof id === 'string' && id !== '') &&
    new Set(ids).size === ids.length
  );
}

function randomSelector(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SELECTOR_LENGTH));
  return Array.from(bytes, (byte) => SELECTOR_ALPHABET.charAt(byte & 31)).join('');
}

export function createPersonalTokenService(deps: PersonalTokenServiceDeps): PersonalTokenService {
  const { tokens, sessions, organizations, providers, keyring, clock, ids } = deps;

  const maxDays = (deps.lifetime ?? resolveTokenLifetimePolicy(undefined)).personal.maxDays;

  function emit(entry: Readonly<Record<string, unknown>>): void {
    try {
      deps.log({ level: 'info', ...entry });
    } catch {
      // The token is already stored; a failing sink must not report it as failed.
    }
  }

  async function mint(): Promise<MintedPersonalToken> {
    const pepperVersion = keyring.currentVersion;
    const selector = randomSelector();
    const plaintext = formatToken(
      'pat',
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
    async issue(ctx, authenticated, fence, request, call) {
      if (authenticated.principal.kind !== 'user') return fail('forbidden');
      const input = {
        name: request.name,
        scope: request.scope,
        readOnly: request.readOnly,
        expiresAt: request.expiresAt,
        lifetimeDays: request.lifetimeDays,
        expiryProvided: Object.hasOwn(request, 'expiresAt'),
        lifetimeProvided: Object.hasOwn(request, 'lifetimeDays'),
        projectMode: request.projectMode,
        projectIds: Array.isArray(request.projectIds)
          ? [...request.projectIds]
          : request.projectIds,
      };
      const { session } = authenticated;
      if (typeof fence !== 'object' || fence === null) {
        throw new TypeError('issue requires a mutation fence');
      }
      if (fence.userId !== session.userId || fence.sessionId !== session.id) {
        throw new TypeError('the mutation fence must belong to the issuing session');
      }
      if (!sessions.isReauthFresh(authenticated)) return fail('reauth_required');
      if (!isValidName(input.name)) return fail('invalid_name');
      const scope = parseScopeLevel(input.scope);
      if (!scope.ok) return fail('invalid_scope');
      if (input.readOnly !== undefined && input.readOnly !== (scope.level === 'read')) {
        return fail('scope_conflict');
      }
      if (!validProjects(input.projectMode, input.projectIds)) return fail('invalid_projects');

      const nowMs = clock.now().getTime();
      if (input.expiryProvided && input.lifetimeProvided) return fail('invalid_expiry');
      const defaulted = !input.expiryProvided && !input.lifetimeProvided;
      let expiresMs = input.expiryProvided
        ? canonicalTimestampMs(input.expiresAt)
        : input.lifetimeProvided
          ? lifetimeExpiry(nowMs, maxDays, input.lifetimeDays as number)
          : null;
      if (
        !defaulted &&
        (expiresMs === null || expiresMs <= nowMs || expiresMs > nowMs + maxDays * DAY_MS)
      ) {
        return fail('invalid_expiry');
      }
      const organization = await organizations.get(ctx);
      if (organization === null) return fail('forbidden');
      const configured = organization.settings.tokenDefaultExpiryDays;
      if (!Number.isSafeInteger(configured) || configured <= 0) return fail('forbidden');
      if (defaulted) expiresMs = defaultExpiry(nowMs, maxDays, configured);
      if (expiresMs === null) return fail('forbidden');
      const expiresAt = new Date(expiresMs).toISOString();

      const providerAnchors = await providers.anchors(ctx);
      const storeNow = clock.now();
      if (expiresMs <= storeNow.getTime()) return fail('invalid_expiry');

      const id = ids.ulid();
      const audit = auditEvent({
        id: ids.ulid(),
        now: isoTimestamp(storeNow),
        action: 'token.issue',
        actor: { type: 'user', id: session.userId },
        context: call.audit,
        target: { type: 'token', id },
        projectId: null,
        changes: {
          kind: { new: 'pat' },
          name: { new: input.name },
          scope: { new: scope.level },
          expires_at: { new: expiresAt },
          project_mode: { new: input.projectMode },
          project_count: { new: input.projectIds.length },
        },
      });
      if (!audit.ok) throw new TypeError('Invalid token issue audit event');
      const outcome = await tokens.issuePersonal(
        ctx,
        fence,
        {
          id,
          name: input.name,
          scope: scope.level,
          expiresAt,
          maxLifetimeDays: maxDays,
          now: isoTimestamp(storeNow),
          validation:
            session.identityId === null
              ? { kind: 'local' }
              : { kind: 'sso', identityId: session.identityId },
          projectMode: input.projectMode,
          projectIds: input.projectIds,
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
          expiresAt,
          defaulted,
          kind: 'pat',
          orgId: ctx.orgId,
          tokenId: outcome.id,
          actorUserId: session.userId,
          scope: scope.level,
          projectMode: input.projectMode,
        });
        return { ok: true, value: { id: outcome.id, plaintext: outcome.plaintext } };
      }
      if (outcome.status === 'indeterminate') return fail('indeterminate');
      switch (outcome.reason) {
        case 'authority':
          if (!sessions.isReauthFresh(authenticated)) return fail('reauth_required');
          emit({ event: 'token.issue_denied', orgId: ctx.orgId, actorUserId: session.userId });
          return fail('forbidden');
        case 'id_conflict':
        case 'selector_collision':
          return fail('conflict');
        default:
          throw new Error('personal token issue answered unclassified');
      }
    },
  };
}
