import { SESSION_ABSOLUTE_MS, newSessionSecrets } from './session.js';
import type { SessionMeta, SessionService } from './session.js';
import type { IdentityReauthDeps } from './identity-reauth.js';
import type { OrgContext } from '../db/port.js';
import type { LoginLookup, LoginPlan, LoginWriter, UserRepository } from '../db/users.js';
import type { Clock } from '../ids.js';
import { emailDomain, evaluateDomainPolicy, normalizeEmail } from '../identity/policy.js';
import { runMapGroupsHooks, runResolveIdentityHooks } from '../identity/hooks.js';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidSubject,
  isValidTrustAnchor,
} from '../identity/port.js';
import type { DomainPolicy, IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import type { HookErrorHandler } from '../kernel/access.js';
import type { Registration } from '../kernel/registry.js';

const MAX_PROVIDER_GROUPS = 5000;
const MAX_GROUPS = 1000;
const MAX_GROUP_NAME_LENGTH = 256;
const EVIDENCE_SKEW_MS = 60_000;
const EVIDENCE_MAX_AGE_MS = 315_576_000_000;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const WRITE_ATTEMPTS = 2;

export type LoginRefusal =
  | 'email_missing'
  | 'email_unverified'
  | 'domain_not_verified'
  | 'not_invited'
  | 'user_suspended'
  | 'hook_denied'
  | 'too_many_groups'
  | 'already_linked'
  | 'link_requires_admin'
  | 'invalid_identity'
  | 'provider_rebound'
  | 'email_changed'
  | 'conflict';

export type LoginOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly sessionId: string;
      readonly cookies: readonly string[];
    }
  | { readonly ok: false; readonly reason: LoginRefusal };

export interface IdentityLoginDeps {
  readonly users: UserRepository;
  readonly writer: LoginWriter;
  readonly sessions: SessionService;
  readonly hooks: Pick<Registration['hooks'], 'auth.resolveIdentity' | 'auth.mapGroups'>;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly onHookError?: HookErrorHandler;
  readonly onDenied?: IdentityReauthDeps['onDenied'];
}

interface Candidate {
  readonly email: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly groups: readonly string[];
  readonly issuedAt: string;
  readonly authTime: string | null;
  readonly evidenceTime: string;
  readonly mayCreate: boolean;
}

function refuse(reason: LoginRefusal): LoginOutcome {
  return { ok: false, reason };
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? undefined : ms;
}

function validEvidence(
  issuedAt: unknown,
  authTime: unknown,
  nowMs: number,
): { readonly issuedAt: string; readonly authTime: string | null } | undefined {
  const issued = timestampMs(issuedAt);
  const authenticated = authTime === null ? null : timestampMs(authTime);
  if (issued === undefined || authenticated === undefined) return undefined;
  const inRange = (ms: number): boolean =>
    ms <= nowMs + EVIDENCE_SKEW_MS && ms >= nowMs - EVIDENCE_MAX_AGE_MS;
  if (!inRange(issued)) return undefined;
  if (
    authenticated !== null &&
    (!inRange(authenticated) || authenticated > issued + EVIDENCE_SKEW_MS)
  ) {
    return undefined;
  }
  return { issuedAt: issuedAt as string, authTime: authTime as string | null };
}

const IDENTITY_FIELDS = [
  'provider',
  'subject',
  'email',
  'emailVerified',
  'displayName',
  'groups',
  'issuedAt',
  'authTime',
] as const;

type IdentitySnapshot = { readonly [K in (typeof IDENTITY_FIELDS)[number]]: unknown };

function dataValue(target: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { value: undefined };
  return 'value' in descriptor ? { value: descriptor.value as unknown } : undefined;
}

function snapshotIdentity(identity: unknown): IdentitySnapshot | undefined {
  try {
    if (typeof identity !== 'object' || identity === null) return undefined;
    const copy: Record<string, unknown> = {};
    for (const field of IDENTITY_FIELDS) {
      const entry = dataValue(identity, field);
      if (entry === undefined) return undefined;
      copy[field] = entry.value;
    }
    return copy as IdentitySnapshot;
  } catch {
    return undefined;
  }
}

function copyGroups(
  raw: unknown,
): { readonly groups: readonly string[] } | { readonly reason: LoginRefusal } {
  if (raw === undefined) return { groups: [] };
  try {
    if (!Array.isArray(raw)) return { reason: 'invalid_identity' };
    const length = dataValue(raw, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return { reason: 'invalid_identity' };
    }
    if (length > MAX_PROVIDER_GROUPS) return { reason: 'too_many_groups' };
    const distinct = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const entry = dataValue(raw, String(index));
      if (entry === undefined || typeof entry.value !== 'string') {
        return { reason: 'invalid_identity' };
      }
      distinct.add(entry.value);
    }
    return { groups: [...distinct] };
  } catch {
    return { reason: 'invalid_identity' };
  }
}

function groupsFit(groups: readonly string[]): LoginRefusal | undefined {
  if (groups.length > MAX_GROUPS) return 'too_many_groups';
  for (const group of groups) {
    if (LONE_SURROGATE.test(group)) return 'invalid_identity';
    const length = Array.from(group).length;
    if (length < 1) return 'invalid_identity';
    if (length > MAX_GROUP_NAME_LENGTH) return 'too_many_groups';
  }
  return undefined;
}

interface ProviderSnapshot {
  readonly id: string;
  readonly trustAnchor: string;
  readonly policy: Required<DomainPolicy>;
}

const INVALID_PROVIDER = 'identity provider has an invalid id, trust anchor or policy';

function ownValue(target: object, key: string): unknown {
  const entry = dataValue(target, key);
  if (entry === undefined) throw new TypeError(INVALID_PROVIDER);
  return entry.value;
}

function copyDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) throw new TypeError(INVALID_PROVIDER);
  const length = ownValue(domains, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(INVALID_PROVIDER);
  }
  const copy: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const domain = ownValue(domains, String(index));
    if (typeof domain !== 'string') throw new TypeError(INVALID_PROVIDER);
    copy.push(domain);
  }
  return copy;
}

function snapshotProvider(provider: unknown): ProviderSnapshot {
  try {
    if (typeof provider !== 'object' || provider === null) throw new TypeError(INVALID_PROVIDER);
    const id = ownValue(provider, 'id');
    const trustAnchor = ownValue(provider, 'trustAnchor');
    const policy = ownValue(provider, 'policy');
    if (
      typeof id !== 'string' ||
      !isValidProviderId(id) ||
      isReservedProviderId(id) ||
      typeof trustAnchor !== 'string' ||
      !isValidTrustAnchor(trustAnchor) ||
      typeof policy !== 'object' ||
      policy === null
    ) {
      throw new TypeError(INVALID_PROVIDER);
    }
    const verifiedDomains = copyDomains(ownValue(policy, 'verifiedDomains'));
    const authoritative = ownValue(policy, 'emailAuthoritativeDomains');
    const emailAuthoritativeDomains = authoritative === undefined ? [] : copyDomains(authoritative);
    return {
      id,
      trustAnchor,
      policy: {
        verifiedDomains,
        emailAuthoritativeDomains,
        autoJoin: ownValue(policy, 'autoJoin') === true,
      },
    };
  } catch {
    throw new TypeError(INVALID_PROVIDER);
  }
}

async function attempt(
  deps: IdentityLoginDeps,
  ctx: OrgContext,
  provider: ProviderSnapshot,
  candidate: Candidate,
  meta: SessionMeta,
): Promise<LoginOutcome | 'retry'> {
  const found: LoginLookup = await deps.users.lookupForLogin(ctx, {
    provider: provider.id,
    subject: candidate.subject,
    email: candidate.email,
    groups: candidate.groups,
  });

  if (found.boundAnchor !== null && found.boundAnchor !== provider.trustAnchor) {
    return refuse('provider_rebound');
  }

  let userId: string;
  let createUser = false;
  let identityId: string | null = null;
  if (found.identity !== null) {
    if (found.identityUser === null) return refuse('invalid_identity');
    if (found.identity.userId !== found.identityUser.id) return refuse('invalid_identity');
    if (found.identityUser.email !== candidate.email) return refuse('email_changed');
    if (found.identityUser.status === 'suspended') return refuse('user_suspended');
    userId = found.identityUser.id;
    identityId = found.identity.id;
  } else if (found.userByEmail !== null) {
    if (found.userByEmail.status === 'suspended') return refuse('user_suspended');
    if (found.userByEmail.linkedAtProvider) return refuse('already_linked');
    if (!provider.policy.emailAuthoritativeDomains.includes(emailDomain(candidate.email))) {
      return refuse('link_requires_admin');
    }
    userId = found.userByEmail.id;
  } else if (candidate.mayCreate || found.invited) {
    userId = deps.ids.ulid();
    createUser = true;
  } else {
    return refuse('not_invited');
  }
  const planIdentityId = identityId ?? deps.ids.ulid();

  const denial = await runResolveIdentityHooks(
    deps.hooks['auth.resolveIdentity'],
    {
      org: ctx,
      userId,
      identity: Object.freeze({
        provider: provider.id,
        subject: candidate.subject,
        email: candidate.email,
        emailVerified: true,
        displayName: candidate.displayName,
        groups: candidate.groups,
        issuedAt: candidate.issuedAt,
        authTime: candidate.authTime,
      }),
    },
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

  const secrets = await newSessionSecrets();
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
  const sessionId = deps.ids.ulid();
  const plan: LoginPlan = {
    userId,
    createUser,
    email: candidate.email,
    displayName: candidate.displayName,
    identityId: planIdentityId,
    provider: provider.id,
    trustAnchor: provider.trustAnchor,
    subject: candidate.subject,
    emailVerified: true,
    groups: candidate.groups,
    evidenceTime: candidate.evidenceTime,
    session: {
      id: sessionId,
      userId,
      identityId: planIdentityId,
      secretHash: secrets.secretHash,
      csrfHash: secrets.csrfHash,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
      now: nowIso,
    },
    previousSecretHash: meta.previousSecretHash,
    now: nowIso,
    autoJoin: candidate.mayCreate,
  };

  if ((await deps.writer.commit(ctx, plan)) === 'refused') return 'retry';
  return {
    ok: true,
    userId,
    sessionId,
    cookies: deps.sessions.setCookies(secrets, expiresAt),
  };
}

/**
 * Turns a verified identity into a session or a typed refusal. The identity is copied once through
 * own data properties, so a plugin object with accessors is refused as `invalid_identity`.
 * A lost write race repeats the lookup and the `auth.resolveIdentity` hooks once, so a hook can
 * run twice for one login, possibly with another user id.
 */
export async function completeIdentityLogin(
  deps: IdentityLoginDeps,
  ctx: OrgContext,
  provider: IdentityProvider,
  identity: VerifiedIdentity,
  meta: SessionMeta,
): Promise<LoginOutcome> {
  const copy = snapshotIdentity(identity);
  if (copy === undefined) return refuse('invalid_identity');
  const email = typeof copy.email === 'string' ? normalizeEmail(copy.email) : null;
  if (email === null) return refuse('email_missing');
  const fixed = snapshotProvider(provider);
  if (copy.provider !== fixed.id) throw new TypeError('identity was verified by another provider');
  if (!isValidSubject(copy.subject)) return refuse('invalid_identity');
  if (typeof copy.emailVerified !== 'boolean') return refuse('invalid_identity');

  const evidence = validEvidence(copy.issuedAt, copy.authTime, deps.clock.now().getTime());
  if (evidence === undefined) return refuse('invalid_identity');

  const start = copyGroups(copy.groups);
  if ('reason' in start) return refuse(start.reason);
  const mapped = await runMapGroupsHooks(
    deps.hooks['auth.mapGroups'],
    { org: ctx, provider: fixed.id, groups: start.groups },
    deps.onHookError,
  );
  if (!('groups' in mapped)) return refuse('hook_denied');
  const problem = groupsFit(mapped.groups);
  if (problem !== undefined) return refuse(problem);

  const decision = evaluateDomainPolicy(
    { email, emailVerified: copy.emailVerified as boolean },
    fixed.policy,
  );
  if (!decision.allow) return refuse(decision.reason);

  const candidate: Candidate = {
    email,
    subject: copy.subject,
    displayName: typeof copy.displayName === 'string' ? copy.displayName : null,
    groups: mapped.groups,
    issuedAt: evidence.issuedAt,
    authTime: evidence.authTime,
    evidenceTime: evidence.authTime ?? evidence.issuedAt,
    mayCreate: decision.mayCreate,
  };
  for (let round = 0; round < WRITE_ATTEMPTS; round += 1) {
    const result = await attempt(deps, ctx, fixed, candidate, meta);
    if (result !== 'retry') return result;
  }
  return refuse('conflict');
}
