import type { AuditEvent } from '../audit/actions.js';
import type { ProjectActor } from '../authz/project-actor.js';
import type { OrgId } from '../db/port.js';
import type {
  PolicyNamespaceQuery,
  PolicyRule,
  PolicySnapshotQuery,
  RegistryPolicyReader,
} from '../db/registry-policy.js';
import { ulid } from '../ids.js';
import type { HookMap } from '../plugin.js';
import type { PolicyReadAuditSink } from '../registry/policy/read-audit.js';
import {
  createRegistryReadSession,
  type RegistryReadSessionDeps,
  type RegistryReadSessionInput,
} from '../registry/policy/session.js';
import type { VersionFact } from '../registry/policy/types.js';

export const T0 = Date.parse('2026-11-01T00:00:00.000Z');

export function policyRule(id: string, overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id,
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
    revision: 1,
    members: [],
    ...overrides,
  };
}

export function versionOf(n: number, overrides: Partial<VersionFact> = {}): VersionFact {
  return {
    packageId: 'K',
    sourceId: 'S',
    packageKey: 'left-pad',
    versionId: `V${String(n)}`,
    version: `1.0.${String(n)}`,
    normalizedVersion: `1.0.${String(n)}`,
    revision: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ageBasis: 'published',
    ...overrides,
  };
}

export function policyState(rules: PolicyRule[] = [], options: { namespace?: boolean } = {}) {
  const state = { epoch: 'e1', rules, fail: false, namespaceFull: false };
  const queries: Array<{ orgId: string; query: PolicySnapshotQuery }> = [];
  const namespaces: Array<{ orgId: string; query: PolicyNamespaceQuery }> = [];
  const namespace: RegistryPolicyReader['namespace'] = async (ctx, query) => {
    namespaces.push({ orgId: ctx.orgId, query });
    if (state.fail) throw new Error('database is locked: SELECT * FROM secret');
    if (state.namespaceFull) return null;
    return {
      epoch: state.epoch,
      rules: state.rules.filter(
        (rule) =>
          rule.ecosystem === query.ecosystem &&
          (rule.projectId === null || rule.projectId === query.projectId),
      ),
    };
  };
  const reader: RegistryPolicyReader = {
    ...(options.namespace === true ? { namespace } : {}),
    snapshot: async (ctx, query) => {
      queries.push({ orgId: ctx.orgId, query });
      if (state.fail) throw new Error('database is locked: SELECT * FROM secret');
      return {
        epoch: state.epoch,
        rules: state.rules.filter(
          (rule) =>
            rule.ecosystem === query.ecosystem &&
            (rule.projectId === null || rule.projectId === query.projectId) &&
            (rule.packageKey === null || rule.packageKey === query.packageKey),
        ),
      };
    },
  };
  return {
    state,
    queries,
    namespaces,
    reader,
    /** A committed rule change: new rules and a new epoch. */
    commit(next: PolicyRule[]) {
      state.rules = next;
      state.epoch = `${state.epoch}+`;
    },
  };
}

export function auditSink(fail = false) {
  const events: AuditEvent[] = [];
  const state = { fail, calls: 0 };
  const sink: PolicyReadAuditSink = {
    record: async (_ctx, batch) => {
      state.calls += 1;
      if (state.fail) throw new Error('audit unavailable');
      events.push(...batch);
    },
  };
  return { events, sink, state };
}

export function projectActor(overrides: Partial<ProjectActor> = {}): ProjectActor {
  return {
    kind: 'project',
    userId: 'U',
    orgId: 'org-a' as OrgId,
    projectId: 'P',
    permissions: new Set(['project:packages:read']),
    ...overrides,
  };
}

export function mutableClock(start = T0) {
  let at = start;
  return {
    clock: { now: () => new Date(at) },
    advance(ms: number) {
      at += ms;
    },
  };
}

export interface SessionSetup {
  readonly rules?: PolicyRule[];
  readonly hooks?: Array<HookMap['registry.read']>;
  readonly actor?: ProjectActor;
  readonly input?: Partial<RegistryReadSessionInput>;
  readonly deps?: Partial<RegistryReadSessionDeps>;
  readonly auditFails?: boolean;
  /** The reader also answers namespace reads, as the SQLite reader does. */
  readonly namespace?: boolean;
}

export function sessionSetup(setup: SessionSetup = {}) {
  const policy = policyState(setup.rules, { namespace: setup.namespace === true });
  const audit = auditSink(setup.auditFails);
  const time = mutableClock();
  const hooks = (setup.hooks ?? []).map((handler, index) => ({
    plugin: `hook-${String(index)}`,
    handler,
  }));
  const deps: RegistryReadSessionDeps = {
    policy: policy.reader,
    hooks,
    hookBudgetMs: 1000,
    clock: time.clock,
    audit: audit.sink,
    ids: { ulid },
    ...setup.deps,
  };
  const open = (input: Partial<RegistryReadSessionInput> = {}) =>
    createRegistryReadSession(deps, {
      actor: setup.actor ?? projectActor(),
      principal: { kind: 'user', id: 'U' },
      ecosystem: 'npm',
      kind: 'metadata',
      client: { family: 'npm', version: '10.2.4' },
      requestId: ulid(),
      ...setup.input,
      ...input,
    });
  return { policy, audit, time, deps, open };
}
