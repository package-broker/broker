import type { IdempotencyRecord } from '../api/idempotency.js';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import type {
  PolicyRuleDetail,
  PolicyWriteOutcome,
  RegistryPolicyCatalog,
  RegistryPolicyMembers,
  RegistryPolicyStore,
  RegistryPolicyUpdater,
} from '../db/registry-policy.js';
import type { PolicyCaller, PolicyIdempotency } from '../registry/policy/manage.js';

export const POLICY_ORG = Object.freeze({ orgId: 'org-a' }) as OrgContext;
export const POLICY_RULE_ID = '01J0P0000000000000000000R1';
export const POLICY_NOW = '2026-11-02T10:00:00.000Z';

export function policyRuleRecord(overrides: Partial<PolicyRuleDetail> = {}): PolicyRuleDetail {
  return {
    id: POLICY_RULE_ID,
    projectId: null,
    ecosystem: 'npm',
    packageKey: 'left-pad',
    kind: 'block',
    minAgeSeconds: null,
    clientFamily: null,
    clientMinVersion: null,
    denyUnknown: false,
    reasonCode: 'security_review',
    incidentId: null,
    expiresAt: null,
    disabledAt: null,
    disabledReason: null,
    revision: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    memberCount: 1,
    members: ['1.0.0'],
    ...overrides,
  };
}

export function policyCallerOf(overrides: Partial<PolicyCaller> = {}): PolicyCaller {
  return {
    org: POLICY_ORG,
    routeProjectId: null,
    fence: mutationFence(
      { userId: 'user-1', sessionId: 'session-1' } as unknown as AuthenticatedActor,
      {},
    ),
    principal: { kind: 'user', id: 'user-1' },
    organizationPermissions: new Set(['org:packages:manage', 'org:settings:write']),
    projectPermissions: new Set(),
    audit: {
      opId: '01J0A0D0000000000000000002',
      requestId: '01J0A0D0000000000000000003',
      sourceIp: null,
      tokenSelector: null,
    },
    ...overrides,
  };
}

type Call = readonly [method: string, input: Record<string, unknown>];

/** In-memory repositories: a write that succeeds stores its idempotency record, as the batch does. */
export function policyRepositories(rules: PolicyRuleDetail[] = [policyRuleRecord()]) {
  const calls: Call[] = [];
  const records = new Map<string, IdempotencyRecord>();
  let next: PolicyWriteOutcome | null = null;
  function settle(method: string, input: Record<string, unknown>): PolicyWriteOutcome {
    calls.push([method, input]);
    const outcome =
      next ?? ({ ok: true, revision: Number(input['expectedRevision'] ?? 0) + 1 } as const);
    next = null;
    const record = input['idempotency'] as IdempotencyRecord | undefined;
    if (outcome.ok && record !== undefined) records.set(record.key, record);
    return outcome;
  }
  const catalog: RegistryPolicyCatalog = {
    async list(_ctx, query) {
      calls.push(['list', { ...query }]);
      return {
        items: rules.filter(
          (rule) => rule.projectId === query.projectId && query.kinds.includes(rule.kind),
        ),
        next: null,
      };
    },
    async get(_ctx, id) {
      return rules.find((rule) => rule.id === id) ?? null;
    },
  };
  const store: RegistryPolicyStore = {
    async create(_ctx, _fence, input) {
      return settle('create', { ...input, expectedRevision: 0 });
    },
  };
  const updater: RegistryPolicyUpdater = {
    async update(_ctx, _fence, input) {
      return settle('update', { ...input });
    },
    async disable(_ctx, _fence, input) {
      return settle('disable', { ...input });
    },
  };
  const members: RegistryPolicyMembers = {
    async replace(_ctx, _fence, input) {
      return settle('members', { ...input });
    },
  };
  const idempotency = (key: string, hash = 'hash-1'): PolicyIdempotency => ({
    key,
    route: 'POST /_pb/policies',
    hash,
    find: async () => records.get(key) ?? null,
  });
  let ids = 0;
  return {
    calls,
    records,
    rules,
    refuse(outcome: PolicyWriteOutcome) {
      next = outcome;
    },
    idempotency,
    deps: {
      store,
      updater,
      members,
      catalog,
      ids: { ulid: () => `01J0P00000000000000000${String(ids++).padStart(4, '0')}` },
      clock: { now: () => new Date(POLICY_NOW) },
    },
  };
}
