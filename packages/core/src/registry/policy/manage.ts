import type { AuditContext } from '../../audit/actions.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  settleIdempotent,
  type IdempotencyRecord,
} from '../../api/idempotency.js';
import type { MutationFence } from '../../authz/fence.js';
import { displayName, packageKey } from '../../catalogue/names.js';
import type { OrgContext } from '../../db/port.js';
import {
  POLICY_RULE_KINDS,
  RegistryPolicyInputError,
  type PolicyClientFamily,
  type PolicyEcosystem,
  type PolicyOverrideReason,
  type PolicyReasonCode,
  type PolicyRuleDetail,
  type PolicyRuleKind,
  type PolicyRulePatch,
  type PolicyRuleRecord,
  type PolicyRuleScope,
  type PolicyWriteOutcome,
  type RegistryPolicyCatalog,
  type RegistryPolicyMembers,
  type RegistryPolicyStore,
  type RegistryPolicyUpdater,
} from '../../db/registry-policy.js';
import type { Clock } from '../../ids.js';
import type { Principal } from '../../plugin.js';

const DAY_SECONDS = 86_400;
export const MAX_MIN_AGE_DAYS = 3650;

/** Settings authority governs age and client floors; package management governs the rest. */
export function policyPermission(kind: PolicyRuleKind, scope: PolicyRuleScope['kind']): string {
  const settings = kind === 'min_age' || kind === 'client_floor';
  if (scope === 'organization') return settings ? 'org:settings:write' : 'org:packages:manage';
  return settings ? 'project:settings:write' : 'project:packages:manage';
}

/** Who calls and through which route; the repositories recheck authority inside the write. */
export interface PolicyCaller {
  readonly org: OrgContext;
  /** Null for organization routes; a project route manages only that project's rules. */
  readonly routeProjectId: string | null;
  /** Null when the caller is not a human session; such callers read and change nothing. */
  readonly fence: MutationFence | null;
  readonly principal: Principal;
  readonly organizationPermissions: ReadonlySet<string>;
  readonly projectPermissions: ReadonlySet<string>;
  readonly audit: AuditContext;
}

/** The fixed public shape of one rule; package names, never internal keys or member lists. */
export interface PolicyRuleView {
  readonly id: string;
  readonly scope: 'organization' | 'project';
  readonly projectId: string | null;
  readonly ecosystem: PolicyEcosystem;
  readonly package: string | null;
  readonly kind: PolicyRuleKind;
  readonly minAgeDays: number | null;
  readonly clientFamily: PolicyClientFamily | null;
  readonly clientMinVersion: string | null;
  readonly denyUnknown: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly incidentId: string | null;
  readonly expiresAt: string | null;
  readonly state: 'active' | 'disabled';
  readonly disabledAt: string | null;
  readonly disabledReason: PolicyOverrideReason | null;
  readonly memberCount: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PolicyRuleDetailView extends PolicyRuleView {
  readonly members: readonly string[];
}

export function policyRuleView(record: PolicyRuleRecord): PolicyRuleView {
  let name: string | null = null;
  if (record.packageKey !== null) {
    name = record.ecosystem === 'npm' ? displayName(record.packageKey) : record.packageKey;
  }
  return {
    id: record.id,
    scope: record.projectId === null ? 'organization' : 'project',
    projectId: record.projectId,
    ecosystem: record.ecosystem,
    package: name,
    kind: record.kind,
    minAgeDays: record.minAgeSeconds === null ? null : record.minAgeSeconds / DAY_SECONDS,
    clientFamily: record.clientFamily,
    clientMinVersion: record.clientMinVersion,
    denyUnknown: record.denyUnknown,
    reasonCode: record.reasonCode,
    incidentId: record.incidentId,
    expiresAt: record.expiresAt,
    state: record.disabledAt === null ? 'active' : 'disabled',
    disabledAt: record.disabledAt,
    disabledReason: record.disabledReason,
    memberCount: record.memberCount,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function policyRuleDetailView(detail: PolicyRuleDetail): PolicyRuleDetailView {
  return { ...policyRuleView(detail), members: [...detail.members] };
}

export type PolicyManageError =
  | 'invalid_request'
  | 'forbidden'
  | 'reauth_required'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'idempotency_mismatch'
  | 'unavailable';

export type PolicyManageOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: PolicyManageError; readonly field?: string };

/** The idempotency key of one write; the route hashes the request it belongs to. */
export interface PolicyIdempotency {
  readonly key: string;
  readonly route: string;
  readonly hash: string;
  find(): Promise<IdempotencyRecord | null>;
}

export interface PolicyManageDeps {
  readonly store: RegistryPolicyStore;
  readonly updater: RegistryPolicyUpdater;
  readonly members: RegistryPolicyMembers;
  readonly catalog: RegistryPolicyCatalog;
  readonly ids: { ulid(): string };
  readonly clock: Clock;
}

export interface PolicyCreateRequest {
  readonly scope: PolicyRuleScope;
  readonly ecosystem: PolicyEcosystem;
  readonly package: string | null;
  readonly kind: PolicyRuleKind;
  readonly minAgeDays: number | null;
  readonly clientFamily: PolicyClientFamily | null;
  readonly clientMinVersion: string | null;
  readonly denyUnknown: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly incidentId: string | null;
  readonly expiresAt: string | null;
  readonly members: readonly string[];
}

export interface PolicyUpdateRequest {
  readonly minAgeDays?: number;
  readonly clientMinVersion?: string;
  readonly denyUnknown?: boolean;
  readonly reasonCode?: PolicyReasonCode;
  readonly incidentId?: string | null;
  readonly expiresAt?: string | null;
  readonly overrideReason?: PolicyOverrideReason;
}

type Failure = Extract<PolicyManageOutcome<never>, { ok: false }>;

const REFUSALS: Readonly<Record<Exclude<PolicyWriteOutcome, { ok: true }>['reason'], Failure>> = {
  forbidden: { ok: false, error: 'forbidden' },
  reauth_required: { ok: false, error: 'reauth_required' },
  not_found: { ok: false, error: 'not_found' },
  conflict: { ok: false, error: 'conflict' },
  replayed: { ok: false, error: 'conflict' },
  limit_exceeded: { ok: false, error: 'limit_exceeded' },
  indeterminate: { ok: false, error: 'unavailable' },
};

/** Whether the caller may manage a rule of this scope and kind through its route. */
export function policyAuthority(
  caller: PolicyCaller,
  scope: PolicyRuleScope,
  kind: PolicyRuleKind,
): 'manage' | 'forbidden' | 'hidden' {
  if (scope.kind === 'organization') {
    if (caller.routeProjectId !== null) return 'hidden';
    return caller.organizationPermissions.has(policyPermission(kind, 'organization'))
      ? 'manage'
      : 'forbidden';
  }
  if (caller.routeProjectId !== null && caller.routeProjectId !== scope.projectId) return 'hidden';
  if (caller.organizationPermissions.has(policyPermission(kind, 'organization'))) return 'manage';
  return caller.routeProjectId !== null &&
    caller.projectPermissions.has(policyPermission(kind, 'project'))
    ? 'manage'
    : 'forbidden';
}

/** The rule kinds the caller may read in a scope; reading needs the same authority as writing. */
export function readableKinds(caller: PolicyCaller, scope: PolicyRuleScope): PolicyRuleKind[] {
  if (caller.fence === null) return [];
  return POLICY_RULE_KINDS.filter((kind) => policyAuthority(caller, scope, kind) === 'manage');
}

function scopeOf(record: Pick<PolicyRuleRecord, 'projectId'>): PolicyRuleScope {
  return record.projectId === null
    ? { kind: 'organization' }
    : { kind: 'project', projectId: record.projectId };
}

function inputFailure(error: unknown): Failure {
  if (error instanceof RegistryPolicyInputError) {
    return { ok: false, error: 'invalid_request', field: error.field };
  }
  throw error;
}

function canonicalPackage(ecosystem: PolicyEcosystem, name: string | null): string | null {
  if (name === null) return null;
  try {
    return packageKey(name, { ecosystem, legacyCase: ecosystem === 'npm' });
  } catch {
    throw new RegistryPolicyInputError('packageKey');
  }
}

function minAgeSeconds(days: number | null | undefined): number | null | undefined {
  if (days === undefined || days === null) return days;
  if (!Number.isSafeInteger(days) || days < 0 || days > MAX_MIN_AGE_DAYS) {
    throw new RegistryPolicyInputError('minAgeSeconds');
  }
  return days * DAY_SECONDS;
}

export interface PolicyManageService {
  list(
    caller: PolicyCaller,
    query: { readonly projectId: string | null; readonly after?: string; readonly limit: number },
  ): Promise<PolicyManageOutcome<{ items: PolicyRuleView[]; next: string | null }>>;
  get(caller: PolicyCaller, id: string): Promise<PolicyManageOutcome<PolicyRuleDetailView>>;
  create(
    caller: PolicyCaller,
    request: PolicyCreateRequest,
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
  update(
    caller: PolicyCaller,
    id: string,
    expectedRevision: number,
    request: PolicyUpdateRequest,
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
  disable(
    caller: PolicyCaller,
    id: string,
    expectedRevision: number,
    reason: PolicyOverrideReason,
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
  /** Reads a rule the caller may manage, for writes outside this service. */
  managed(
    caller: PolicyCaller,
    id: string,
  ): Promise<{ readonly ok: true; readonly rule: PolicyRuleDetail } | Failure>;
  /**
   * The stored answer of an earlier request with this key, checked before any precondition so a
   * client whose response was lost receives it again; null when the request is new.
   */
  replay(idempotency: PolicyIdempotency): Promise<PolicyManageOutcome<PolicyRuleView> | null>;
  /** Runs one repository write under the request's idempotency key. */
  write(
    caller: PolicyCaller,
    idempotency: PolicyIdempotency,
    status: number,
    body: PolicyRuleView,
    run: (record: IdempotencyRecord) => Promise<PolicyWriteOutcome>,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
}

export function createPolicyManageService(deps: PolicyManageDeps): PolicyManageService {
  const envelope = (caller: PolicyCaller) => ({
    id: deps.ids.ulid(),
    occurredAt: deps.clock.now().toISOString(),
    context: caller.audit,
  });

  async function managed(
    caller: PolicyCaller,
    id: string,
  ): Promise<{ readonly ok: true; readonly rule: PolicyRuleDetail } | Failure> {
    if (caller.fence === null) return { ok: false, error: 'forbidden' };
    const rule = await deps.catalog.get(caller.org, id);
    if (rule === null) return { ok: false, error: 'not_found' };
    const authority = policyAuthority(caller, scopeOf(rule), rule.kind);
    if (authority === 'hidden') return { ok: false, error: 'not_found' };
    if (authority === 'forbidden') return { ok: false, error: 'forbidden' };
    return { ok: true, rule };
  }

  function replayed(record: IdempotencyRecord): PolicyManageOutcome<PolicyRuleView> {
    try {
      return {
        ok: true,
        value: JSON.parse(record.responseJson) as PolicyRuleView,
        replayed: true,
      };
    } catch {
      return { ok: false, error: 'conflict' };
    }
  }

  async function replay(
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView> | null> {
    const existing = await idempotency.find();
    const decision = decideReplay(existing, idempotency.hash, deps.clock.now());
    if (decision === 'mismatch') return { ok: false, error: 'idempotency_mismatch' };
    if (decision === 'replay' && existing !== null) return replayed(existing);
    return null;
  }

  async function write(
    caller: PolicyCaller,
    idempotency: PolicyIdempotency,
    status: number,
    body: PolicyRuleView,
    run: (record: IdempotencyRecord) => Promise<PolicyWriteOutcome>,
  ): Promise<PolicyManageOutcome<PolicyRuleView>> {
    const earlier = await replay(idempotency);
    if (earlier !== null) return earlier;
    const now = deps.clock.now();
    const record = buildIdempotencyRecord({
      principal: caller.principal,
      key: idempotency.key,
      route: idempotency.route,
      hash: idempotency.hash,
      status,
      response: body,
      now,
    });
    const settled = await settleIdempotent({
      record,
      hash: idempotency.hash,
      now,
      find: () => idempotency.find(),
      run: () => run(record),
      failed: (outcome) => !outcome.ok,
    });
    if (settled.kind === 'mismatch') return { ok: false, error: 'idempotency_mismatch' };
    if (settled.kind === 'replay') return replayed(settled.record);
    const outcome = settled.result;
    if (!outcome.ok) return REFUSALS[outcome.reason];
    if (outcome.unchanged === true) {
      const current = await deps.catalog.get(caller.org, body.id);
      if (current === null) return { ok: false, error: 'not_found' };
      return { ok: true, value: policyRuleView(current), replayed: false };
    }
    return { ok: true, value: body, replayed: false };
  }

  return {
    managed,
    replay,
    write,

    async list(caller, query) {
      if (caller.fence === null) return { ok: false, error: 'forbidden' };
      const scope: PolicyRuleScope =
        query.projectId === null
          ? { kind: 'organization' }
          : { kind: 'project', projectId: query.projectId };
      const kinds = readableKinds(caller, scope);
      if (kinds.length === 0) {
        return {
          ok: false,
          error:
            scope.kind === 'organization' && caller.routeProjectId !== null
              ? 'not_found'
              : 'forbidden',
        };
      }
      const page = await deps.catalog.list(caller.org, {
        projectId: query.projectId,
        kinds,
        limit: query.limit,
        ...(query.after === undefined ? {} : { after: query.after }),
      });
      return {
        ok: true,
        value: { items: page.items.map(policyRuleView), next: page.next },
        replayed: false,
      };
    },

    async get(caller, id) {
      const found = await managed(caller, id);
      if (!found.ok) return found;
      return { ok: true, value: policyRuleDetailView(found.rule), replayed: false };
    },

    async create(caller, request, idempotency) {
      if (caller.fence === null) return { ok: false, error: 'forbidden' };
      const authority = policyAuthority(caller, request.scope, request.kind);
      if (authority === 'hidden') return { ok: false, error: 'not_found' };
      if (authority === 'forbidden') return { ok: false, error: 'forbidden' };
      const fence = caller.fence;
      try {
        const now = deps.clock.now().toISOString();
        const id = deps.ids.ulid();
        const input = {
          id,
          scope: request.scope,
          ecosystem: request.ecosystem,
          packageKey: canonicalPackage(request.ecosystem, request.package),
          kind: request.kind,
          minAgeSeconds: minAgeSeconds(request.minAgeDays) ?? null,
          clientFamily: request.clientFamily,
          clientMinVersion: request.clientMinVersion,
          denyUnknown: request.denyUnknown,
          reasonCode: request.reasonCode,
          incidentId: request.incidentId,
          expiresAt: request.expiresAt,
          members: request.members,
          now,
          audit: envelope(caller),
        };
        const members =
          request.kind === 'block' || request.kind === 'allowlist' || request.kind === 'quarantine'
            ? new Set(request.members).size
            : 0;
        const body = policyRuleView({
          id,
          projectId: request.scope.kind === 'project' ? request.scope.projectId : null,
          ecosystem: request.ecosystem,
          packageKey: input.packageKey,
          kind: request.kind,
          minAgeSeconds: input.minAgeSeconds,
          clientFamily: request.clientFamily,
          clientMinVersion: request.clientMinVersion,
          denyUnknown: request.denyUnknown,
          reasonCode: request.reasonCode,
          incidentId: request.incidentId,
          expiresAt: request.expiresAt,
          disabledAt: null,
          disabledReason: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          memberCount: members,
        });
        return await write(caller, idempotency, 201, body, (record) =>
          deps.store.create(caller.org, fence, { ...input, idempotency: record }),
        );
      } catch (error) {
        return inputFailure(error);
      }
    },

    async update(caller, id, expectedRevision, request, idempotency) {
      const found = await managed(caller, id);
      if (!found.ok) return found;
      const earlier = await replay(idempotency);
      if (earlier !== null) return earlier;
      const rule = found.rule;
      if (rule.disabledAt !== null || rule.revision !== expectedRevision) {
        return { ok: false, error: 'conflict' };
      }
      try {
        const now = deps.clock.now().toISOString();
        const patch: { -readonly [K in keyof PolicyRulePatch]: PolicyRulePatch[K] } = {};
        if (request.minAgeDays !== undefined)
          patch.minAgeSeconds = minAgeSeconds(request.minAgeDays)!;
        if (request.clientMinVersion !== undefined)
          patch.clientMinVersion = request.clientMinVersion;
        if (request.denyUnknown !== undefined) patch.denyUnknown = request.denyUnknown;
        if (request.reasonCode !== undefined) patch.reasonCode = request.reasonCode;
        if (request.incidentId !== undefined) patch.incidentId = request.incidentId;
        if (request.expiresAt !== undefined) patch.expiresAt = request.expiresAt;
        const body = policyRuleView({
          ...rule,
          ...(patch.minAgeSeconds === undefined ? {} : { minAgeSeconds: patch.minAgeSeconds }),
          ...(patch.clientMinVersion === undefined
            ? {}
            : { clientMinVersion: patch.clientMinVersion }),
          ...(patch.denyUnknown === undefined ? {} : { denyUnknown: patch.denyUnknown }),
          ...(patch.reasonCode === undefined ? {} : { reasonCode: patch.reasonCode }),
          ...(patch.incidentId === undefined ? {} : { incidentId: patch.incidentId }),
          ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
          revision: expectedRevision + 1,
          updatedAt: now,
        });
        return await write(caller, idempotency, 200, body, (record) =>
          deps.updater.update(caller.org, caller.fence!, {
            id,
            expectedRevision,
            patch,
            now,
            audit: envelope(caller),
            idempotency: record,
            ...(request.overrideReason === undefined
              ? {}
              : { overrideReason: request.overrideReason }),
          }),
        );
      } catch (error) {
        return inputFailure(error);
      }
    },

    async disable(caller, id, expectedRevision, reason, idempotency) {
      const found = await managed(caller, id);
      if (!found.ok) return found;
      const earlier = await replay(idempotency);
      if (earlier !== null) return earlier;
      const rule = found.rule;
      if (rule.disabledAt !== null || rule.revision !== expectedRevision) {
        return { ok: false, error: 'conflict' };
      }
      try {
        const now = deps.clock.now().toISOString();
        const body = policyRuleView({
          ...rule,
          disabledAt: now,
          disabledReason: reason,
          revision: expectedRevision + 1,
          updatedAt: now,
        });
        return await write(caller, idempotency, 200, body, (record) =>
          deps.updater.disable(caller.org, caller.fence!, {
            id,
            expectedRevision,
            reason,
            now,
            audit: envelope(caller),
            idempotency: record,
          }),
        );
      } catch (error) {
        return inputFailure(error);
      }
    },
  };
}
