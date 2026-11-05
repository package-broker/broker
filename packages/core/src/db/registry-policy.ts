import type { AuditContext } from '../audit/actions.js';
import type { IdempotencyRecord } from '../api/idempotency.js';
import type { AnyMutationFence } from '../authz/fence.js';
import { MAX_KEY_LENGTH, displayName, packageKey } from '../catalogue/names.js';
import { validateVersion } from '../catalogue/versions.js';
import { isUlid } from '../ids.js';
import { normalizeVersion } from '../registry/composer/version-parser.js';
import type { OrgContext } from './port.js';

export const POLICY_ECOSYSTEMS = ['npm', 'composer'] as const;
export const POLICY_RULE_KINDS = [
  'min_age',
  'block',
  'allowlist',
  'quarantine',
  'client_floor',
] as const;
export const POLICY_CLIENT_FAMILIES = ['npm', 'pnpm', 'yarn', 'composer'] as const;
export const POLICY_REASON_CODES = [
  'malware',
  'security_review',
  'compatibility',
  'organization_policy',
] as const;
/** The only reasons a rule disable or a blocked-version removal may carry; never free text. */
export const POLICY_OVERRIDE_REASONS = [
  'false_positive',
  'emergency_compatibility',
  'superseded',
  'other',
] as const;

export type PolicyEcosystem = (typeof POLICY_ECOSYSTEMS)[number];
export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];
export type PolicyClientFamily = (typeof POLICY_CLIENT_FAMILIES)[number];
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];
export type PolicyOverrideReason = (typeof POLICY_OVERRIDE_REASONS)[number];

export const MAX_POLICY_RULES = 256;
export const MAX_POLICY_MEMBERS = 1000;
export const MAX_MIN_AGE_SECONDS = 315_360_000;

/** A stored rule as the evaluator sees it; members are exact normalized versions, sorted. */
export interface PolicyRule {
  readonly id: string;
  readonly projectId: string | null;
  readonly ecosystem: PolicyEcosystem;
  readonly packageKey: string | null;
  readonly kind: PolicyRuleKind;
  readonly minAgeSeconds: number | null;
  readonly clientFamily: PolicyClientFamily | null;
  readonly clientMinVersion: string | null;
  readonly denyUnknown: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly incidentId: string | null;
  readonly expiresAt: string | null;
  readonly revision: number;
  readonly members: readonly string[];
}

/** Enabled rules of one organization and project read together with the epoch they belong to. */
export interface PolicySnapshot {
  readonly epoch: string;
  readonly rules: readonly PolicyRule[];
}

export interface PolicySnapshotQuery {
  readonly ecosystem: PolicyEcosystem;
  /** Null reads organization rules only. */
  readonly projectId: string | null;
  /** Null reads only rules without a package; a key also reads that package's rules. */
  readonly packageKey: string | null;
}

export type PolicyNamespaceQuery = Omit<PolicySnapshotQuery, 'packageKey'>;

/** Rules one namespace read may return; beyond either cap the caller reads per package. */
export const MAX_POLICY_NAMESPACE_RULES = 1024;
export const MAX_POLICY_NAMESPACE_MEMBERS = 20_000;

export interface RegistryPolicyReader {
  /** Throws RegistryPolicyStoreError('unavailable') when the snapshot cannot be proven complete. */
  snapshot(ctx: OrgContext, query: PolicySnapshotQuery): Promise<PolicySnapshot>;
  /**
   * The enabled rules of every package key in one read, for requests that touch many packages;
   * null when more rules or members apply than the namespace caps allow.
   */
  namespace?(ctx: OrgContext, query: PolicyNamespaceQuery): Promise<PolicySnapshot | null>;
}

/**
 * What a per-package snapshot of `packageKey` would return, cut from a namespace read with the
 * same per-package rule cap.
 */
export function policyPackageView(
  namespace: PolicySnapshot,
  packageKey: string | null,
): PolicySnapshot {
  const rules = namespace.rules.filter(
    (rule) => rule.packageKey === null || (packageKey !== null && rule.packageKey === packageKey),
  );
  if (rules.length > MAX_POLICY_RULES) throw new RegistryPolicyStoreError();
  return { epoch: namespace.epoch, rules };
}

export type PolicyRuleScope =
  { readonly kind: 'organization' } | { readonly kind: 'project'; readonly projectId: string };

/** The broker-generated envelope of the audit event a rule write records. */
export interface PolicyAuditEnvelope {
  readonly id: string;
  readonly occurredAt: string;
  readonly context: AuditContext;
}

interface PolicyWriteBase {
  readonly now: string;
  readonly audit: PolicyAuditEnvelope;
  readonly idempotency?: IdempotencyRecord;
}

export interface PolicyRuleCreate extends PolicyWriteBase {
  readonly id: string;
  readonly scope: PolicyRuleScope;
  readonly ecosystem: PolicyEcosystem;
  readonly packageKey: string | null;
  readonly kind: PolicyRuleKind;
  readonly minAgeSeconds: number | null;
  readonly clientFamily: PolicyClientFamily | null;
  readonly clientMinVersion: string | null;
  readonly denyUnknown: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly incidentId: string | null;
  readonly expiresAt: string | null;
  readonly members: readonly string[];
}

/** Fields an update may change; kind, ecosystem, scope and package stay fixed for a rule's life. */
export interface PolicyRulePatch {
  readonly minAgeSeconds?: number;
  readonly clientMinVersion?: string;
  readonly denyUnknown?: boolean;
  readonly reasonCode?: PolicyReasonCode;
  readonly incidentId?: string | null;
  readonly expiresAt?: string | null;
}

export interface PolicyRuleUpdate extends PolicyWriteBase {
  readonly id: string;
  readonly expectedRevision: number;
  readonly patch: PolicyRulePatch;
  /** Recorded with a weakening edit; never required for tightening. */
  readonly overrideReason?: PolicyOverrideReason;
}

export interface PolicyRuleDisable extends PolicyWriteBase {
  readonly id: string;
  readonly expectedRevision: number;
  readonly reason: PolicyOverrideReason;
}

export interface PolicyMembersReplace extends PolicyWriteBase {
  readonly id: string;
  readonly expectedRevision: number;
  readonly members: readonly string[];
  /** Required when the replacement removes versions from a block or quarantine. */
  readonly overrideReason?: PolicyOverrideReason;
}

export type PolicyWriteRefusal =
  | 'forbidden'
  | 'reauth_required'
  | 'not_found'
  | 'conflict'
  | 'replayed'
  | 'limit_exceeded'
  | 'indeterminate';

export type PolicyWriteOutcome =
  | { readonly ok: true; readonly revision: number; readonly unchanged?: true }
  | { readonly ok: false; readonly reason: PolicyWriteRefusal };

export interface RegistryPolicyStore {
  create(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PolicyRuleCreate,
  ): Promise<PolicyWriteOutcome>;
}

export interface RegistryPolicyUpdater {
  update(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PolicyRuleUpdate,
  ): Promise<PolicyWriteOutcome>;
  disable(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PolicyRuleDisable,
  ): Promise<PolicyWriteOutcome>;
}

export interface RegistryPolicyMembers {
  replace(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PolicyMembersReplace,
  ): Promise<PolicyWriteOutcome>;
}

export type PolicyInputField =
  | 'id'
  | 'scope'
  | 'projectId'
  | 'ecosystem'
  | 'packageKey'
  | 'kind'
  | 'minAgeSeconds'
  | 'clientFamily'
  | 'clientMinVersion'
  | 'denyUnknown'
  | 'reasonCode'
  | 'incidentId'
  | 'expiresAt'
  | 'members'
  | 'expectedRevision'
  | 'patch'
  | 'overrideReason'
  | 'now'
  | 'audit';

/** Input refused before any statement runs; the message is fixed and names only the field path. */
export class RegistryPolicyInputError extends Error {
  readonly code = 'invalid_request';
  readonly field: PolicyInputField;

  constructor(field: PolicyInputField) {
    super('invalid_request');
    this.name = 'RegistryPolicyInputError';
    this.field = field;
  }
}

/** A policy read that cannot be proven complete; serving must fail closed. */
export class RegistryPolicyStoreError extends Error {
  readonly code = 'unavailable';

  constructor() {
    super('Package policy is unavailable');
    this.name = 'RegistryPolicyStoreError';
  }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLIENT_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const COMPOSER_NUMERIC = /^\d+(?:\.\d+)*(?:-(alpha|beta|RC|patch)[\d.-]*)?(?:-dev)?$/;
const COMPOSER_BRANCH = /^dev-[^\s\p{Cc}]+$/u;
export const POLICY_PROJECT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

export function isPolicyTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** A stable numeric client version such as 9.0.0; prereleases and ranges are not floors. */
export function isPolicyClientVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 5 &&
    value.length <= 64 &&
    CLIENT_VERSION.test(value)
  );
}

export function isPolicyPackageKey(ecosystem: PolicyEcosystem, value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH)
    return false;
  try {
    const name = ecosystem === 'npm' ? displayName(value) : value;
    return packageKey(name, { ecosystem, legacyCase: ecosystem === 'npm' }) === value;
  } catch {
    return false;
  }
}

/** An exact normalized version as the catalogue stores it in version_normalized. */
export function isPolicyMember(ecosystem: PolicyEcosystem, value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (ecosystem === 'npm') {
    try {
      validateVersion({ ecosystem, version: value, versionNormalized: value });
      return true;
    } catch {
      return false;
    }
  }
  if (value.length > 255 || !(COMPOSER_BRANCH.test(value) || COMPOSER_NUMERIC.test(value))) {
    return false;
  }
  try {
    return normalizeVersion(value) === value;
  } catch {
    return false;
  }
}

/** Sorted distinct exact members, or the input error for the members field. */
export function policyMembers(ecosystem: PolicyEcosystem, members: unknown): readonly string[] {
  if (!Array.isArray(members) || members.length > MAX_POLICY_MEMBERS) {
    throw new RegistryPolicyInputError('members');
  }
  const seen = new Set<string>();
  for (const member of members as unknown[]) {
    if (!isPolicyMember(ecosystem, member) || seen.has(member)) {
      throw new RegistryPolicyInputError('members');
    }
    seen.add(member);
  }
  return [...seen].sort();
}

export function isPolicyRuleId(value: unknown): value is string {
  return typeof value === 'string' && isUlid(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown, field: PolicyInputField): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new RegistryPolicyInputError(field);
  }
  return value as T;
}

function expiry(value: unknown, now: string): string | null {
  if (value === null) return null;
  if (!isPolicyTimestamp(value) || value <= now) throw new RegistryPolicyInputError('expiresAt');
  return value;
}

function minAge(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_MIN_AGE_SECONDS
  ) {
    throw new RegistryPolicyInputError('minAgeSeconds');
  }
  return value;
}

/** Compares two stable numeric client versions. */
export function comparePolicyClientVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

const MEMBER_KINDS: ReadonlySet<PolicyRuleKind> = new Set(['block', 'allowlist', 'quarantine']);

export function isPolicyMemberKind(kind: PolicyRuleKind): boolean {
  return MEMBER_KINDS.has(kind);
}

/** The create input with every field checked against its kind; refusals name one fixed field. */
export function validatePolicyRuleCreate(input: PolicyRuleCreate): PolicyRuleCreate {
  if (typeof input !== 'object' || input === null) throw new RegistryPolicyInputError('id');
  if (!isPolicyRuleId(input.id)) throw new RegistryPolicyInputError('id');
  if (!isPolicyTimestamp(input.now)) throw new RegistryPolicyInputError('now');
  const scope = input.scope;
  if (
    typeof scope !== 'object' ||
    scope === null ||
    (scope.kind !== 'organization' && scope.kind !== 'project')
  ) {
    throw new RegistryPolicyInputError('scope');
  }
  if (
    scope.kind === 'project' &&
    (typeof scope.projectId !== 'string' || !POLICY_PROJECT_ID.test(scope.projectId))
  ) {
    throw new RegistryPolicyInputError('projectId');
  }
  const ecosystem = oneOf(POLICY_ECOSYSTEMS, input.ecosystem, 'ecosystem');
  const kind = oneOf(POLICY_RULE_KINDS, input.kind, 'kind');
  const reasonCode = oneOf(POLICY_REASON_CODES, input.reasonCode, 'reasonCode');
  const packageKey = input.packageKey;
  if (packageKey === null) {
    if (MEMBER_KINDS.has(kind)) throw new RegistryPolicyInputError('packageKey');
  } else if (kind === 'client_floor' || !isPolicyPackageKey(ecosystem, packageKey)) {
    throw new RegistryPolicyInputError('packageKey');
  }
  const minAgeSeconds = kind === 'min_age' ? minAge(input.minAgeSeconds) : input.minAgeSeconds;
  if (kind !== 'min_age' && minAgeSeconds !== null)
    throw new RegistryPolicyInputError('minAgeSeconds');
  let clientFamily = input.clientFamily;
  const clientMinVersion = input.clientMinVersion;
  if (kind === 'client_floor') {
    clientFamily = oneOf(POLICY_CLIENT_FAMILIES, clientFamily, 'clientFamily');
    if ((ecosystem === 'composer') !== (clientFamily === 'composer')) {
      throw new RegistryPolicyInputError('clientFamily');
    }
    if (!isPolicyClientVersion(clientMinVersion))
      throw new RegistryPolicyInputError('clientMinVersion');
  } else {
    if (clientFamily !== null) throw new RegistryPolicyInputError('clientFamily');
    if (clientMinVersion !== null) throw new RegistryPolicyInputError('clientMinVersion');
  }
  if (typeof input.denyUnknown !== 'boolean' || (input.denyUnknown && kind !== 'client_floor')) {
    throw new RegistryPolicyInputError('denyUnknown');
  }
  if (input.incidentId !== null && !isPolicyRuleId(input.incidentId)) {
    throw new RegistryPolicyInputError('incidentId');
  }
  const expiresAt = expiry(input.expiresAt, input.now);
  const members = MEMBER_KINDS.has(kind) ? policyMembers(ecosystem, input.members) : input.members;
  if (!MEMBER_KINDS.has(kind) && (!Array.isArray(members) || members.length > 0)) {
    throw new RegistryPolicyInputError('members');
  }
  if (kind === 'quarantine') {
    if (scope.kind !== 'organization') throw new RegistryPolicyInputError('scope');
    if (expiresAt !== null) throw new RegistryPolicyInputError('expiresAt');
    if (reasonCode !== 'malware') throw new RegistryPolicyInputError('reasonCode');
    if (members.length === 0) throw new RegistryPolicyInputError('members');
  }
  return {
    ...input,
    scope:
      scope.kind === 'organization'
        ? { kind: 'organization' }
        : { kind: 'project', projectId: scope.projectId },
    ecosystem,
    kind,
    reasonCode,
    packageKey,
    minAgeSeconds,
    clientFamily,
    clientMinVersion,
    expiresAt,
    members,
  };
}

/** The patch checked against the stored rule's kind; refusals name one fixed field. */
export function validatePolicyRulePatch(
  kind: PolicyRuleKind,
  patch: PolicyRulePatch,
  now: string,
): PolicyRulePatch {
  if (typeof patch !== 'object' || patch === null || Object.keys(patch).length === 0) {
    throw new RegistryPolicyInputError('patch');
  }
  const out: { -readonly [K in keyof PolicyRulePatch]: PolicyRulePatch[K] } = {};
  for (const key of Object.keys(patch)) {
    const value: unknown = (patch as Record<string, unknown>)[key];
    switch (key) {
      case 'minAgeSeconds':
        if (kind !== 'min_age') throw new RegistryPolicyInputError('minAgeSeconds');
        out.minAgeSeconds = minAge(value);
        break;
      case 'clientMinVersion':
        if (kind !== 'client_floor' || !isPolicyClientVersion(value)) {
          throw new RegistryPolicyInputError('clientMinVersion');
        }
        out.clientMinVersion = value;
        break;
      case 'denyUnknown':
        if (kind !== 'client_floor' || typeof value !== 'boolean') {
          throw new RegistryPolicyInputError('denyUnknown');
        }
        out.denyUnknown = value;
        break;
      case 'reasonCode':
        out.reasonCode = oneOf(POLICY_REASON_CODES, value, 'reasonCode');
        if (kind === 'quarantine' && value !== 'malware')
          throw new RegistryPolicyInputError('reasonCode');
        break;
      case 'incidentId':
        if (value !== null && !isPolicyRuleId(value))
          throw new RegistryPolicyInputError('incidentId');
        out.incidentId = value as string | null;
        break;
      case 'expiresAt':
        if (kind === 'quarantine') throw new RegistryPolicyInputError('expiresAt');
        out.expiresAt = expiry(value, now);
        break;
      default:
        throw new RegistryPolicyInputError('patch');
    }
  }
  return out;
}

/** A stored rule as management sees it, disabled rules included; members are counted only. */
export interface PolicyRuleRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly ecosystem: PolicyEcosystem;
  readonly packageKey: string | null;
  readonly kind: PolicyRuleKind;
  readonly minAgeSeconds: number | null;
  readonly clientFamily: PolicyClientFamily | null;
  readonly clientMinVersion: string | null;
  readonly denyUnknown: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly incidentId: string | null;
  readonly expiresAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: PolicyOverrideReason | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly memberCount: number;
}

export interface PolicyRuleDetail extends PolicyRuleRecord {
  readonly members: readonly string[];
}

export const POLICY_LIST_PAGE_MAX = 100;

export interface PolicyRuleListQuery {
  /** Null lists organization rules; a project id lists that project's rules. */
  readonly projectId: string | null;
  /** The kinds the caller may read; an empty list reads nothing. */
  readonly kinds: readonly PolicyRuleKind[];
  readonly after?: string;
  readonly limit: number;
}

/** Management reads of stored rules; never used to decide a serving request. */
export interface RegistryPolicyCatalog {
  list(
    ctx: OrgContext,
    query: PolicyRuleListQuery,
  ): Promise<{ readonly items: readonly PolicyRuleRecord[]; readonly next: string | null }>;
  get(ctx: OrgContext, id: string): Promise<PolicyRuleDetail | null>;
}

/** An enabled rule whose expiry passed and whose expiry evidence is not yet recorded. */
export interface PolicyExpiryDue {
  readonly id: string;
  readonly projectId: string | null;
  readonly ecosystem: PolicyEcosystem;
  readonly kind: PolicyRuleKind;
  readonly packageKey: string | null;
  readonly revision: number;
  readonly expiresAt: string;
}

export const POLICY_EXPIRY_PAGE = 50;

/**
 * Expiry bookkeeping only: marking a rule records its expiry evidence once and never changes its
 * revision or the interval in which it was active.
 */
export interface RegistryPolicyExpiry {
  due(ctx: OrgContext, limit: number): Promise<readonly PolicyExpiryDue[]>;
  mark(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: {
      readonly id: string;
      readonly revision: number;
      readonly audit: PolicyAuditEnvelope;
    },
  ): Promise<boolean>;
}
