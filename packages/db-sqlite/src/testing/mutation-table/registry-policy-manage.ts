import { expect } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createRegistryPolicyCatalog } from '../../repositories/registry-policy-catalog.js';
import { createRegistryPolicyExpiry } from '../../repositories/registry-policy-expiry.js';
import { createPolicyReadAuditSink } from '../../repositories/registry-policy-read-audit.js';
import { seedMember, seedRule } from '../../contract/registry-policy-fixture.js';
import { executing } from './factory-cases.js';
import { FUTURE, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const RULE = '01J0P0000000000000000000M1';
const FOREIGN_RULE = '01J0P0000000000000000000M2';
const PAST = '2026-11-01T12:00:00.000Z';
const JOB = { id: 'EXPIRY-JOB', owner: 'worker', fence: 3 };

const envelope = () => ({
  id: ulid(),
  occurredAt: new Date().toISOString(),
  context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
});

const foreignCatalog: ContractCase = {
  name: 'policy catalog lists and reads only rules of the organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedRule(seed, { id: FOREIGN_RULE, orgId: foreign.orgId });
    const catalog = createRegistryPolicyCatalog(executing(context));
    expect(await catalog.list(own, { projectId: null, kinds: ['block'], limit: 10 })).toEqual({
      items: [],
      next: null,
    });
    expect(await catalog.get(own, FOREIGN_RULE)).toBeNull();
  },
};

const foreignMembers: ContractCase = {
  name: 'policy catalog counts and lists no member of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedRule(seed, { id: RULE, orgId: own.orgId });
    await seedMember(seed, own.orgId, RULE, '1.0.0');
    await seedMember(seed.forged, foreign.orgId, RULE, '9.9.9');
    const catalog = createRegistryPolicyCatalog(executing(context));
    const page = await catalog.list(own, { projectId: null, kinds: ['block'], limit: 10 });
    expect(page.items.map((item) => [item.id, item.memberCount])).toEqual([[RULE, 1]]);
    expect(await catalog.get(own, RULE)).toMatchObject({ memberCount: 1, members: ['1.0.0'] });
  },
};

const foreignDue: ContractCase = {
  name: 'policy expiry finds no expired rule of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedRule(seeder(context.executor), {
      id: FOREIGN_RULE,
      orgId: foreign.orgId,
      expiresAt: PAST,
    });
    expect(await createRegistryPolicyExpiry(executing(context)).due(own, 10)).toEqual([]);
  },
};

const movedExpiry: ContractCase = {
  name: 'policy expiry marks nothing once the rule belongs to another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedRule(seed, { id: RULE, orgId: own.orgId, expiresAt: PAST });
    await seed(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'core:registry-policy-expire:v1', ?, 'running', 'worker', ?, 3)",
      JOB.id,
      own.orgId,
      JOB.id,
      FUTURE,
    );
    const inner = executing(context);
    const racing: SqlExecutor = {
      driver: inner.driver,
      all: (statement) => inner.all(statement),
      async batch(statements) {
        await seed.forged(
          'UPDATE registry_policy_rule SET org_id = ? WHERE id = ?',
          foreign.orgId,
          RULE,
        );
        return inner.batch(statements);
      },
    };
    const marked = await createRegistryPolicyExpiry(racing).mark(
      own,
      systemMutationFence('purge', JOB, {}),
      { id: RULE, revision: 1, audit: envelope() },
    );
    expect(marked).toBe(false);
    const [row] = await context.executor.all<{ expiry_audited_at: string | null }>({
      sql: 'SELECT expiry_audited_at FROM registry_policy_rule WHERE id = ?',
      params: [RULE],
    });
    expect(row?.expiry_audited_at).toBeNull();
  },
};

const sinkOwnsRows: ContractCase = {
  name: 'policy read evidence lands in the organization of the request',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const built = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      action: 'policy.read_denied',
      actor: { type: 'user', id: 'U1' },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      target: { type: 'version', id: 'V1' },
      projectId: 'P1',
      changes: {
        read_kind: { new: 'dist' },
        ecosystem: { new: 'npm' },
        package_key: { new: 'left-pad' },
        version_id: { new: 'V1' },
        version_revision: { new: 1 },
        reasons: { new: [`rule:${RULE}:1:blocked`] },
      },
    });
    if (!built.ok) throw new Error(built.reason);
    await createPolicyReadAuditSink(executing(context)).record(own, [built.event]);
    const rows = await context.executor.all<{ org_id: string }>({
      sql: "SELECT org_id FROM audit_pending WHERE action = 'policy.read_denied'",
      params: [],
    });
    expect(rows.map((row) => row.org_id)).toEqual([own.orgId]);
    expect(rows.map((row) => row.org_id)).not.toContain(foreign.orgId);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-policy-catalog.ts',
    builder: 'createRegistryPolicyCatalog',
    cases: [foreignCatalog, foreignMembers],
    predicates: [
      {
        name: 'listed and read rules belong to the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignCatalog.name,
      },
      {
        name: 'counted members belong to the organization',
        locate: /"c"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignMembers.name,
      },
      {
        name: 'listed members belong to the organization',
        locate: /"m"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignMembers.name,
      },
    ],
    waivers: [],
  },
  {
    file: 'repositories/registry-policy-expiry.ts',
    builder: 'createRegistryPolicyExpiry',
    cases: [foreignDue, movedExpiry],
    predicates: [
      {
        name: 'due rules belong to the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignDue.name,
      },
      {
        name: 'the expiry marker targets a rule of the organization',
        locate: /(?<=update "registry_policy_rule" set [^;]*? where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: movedExpiry.name,
      },
    ],
    waivers: [
      {
        locate: /"e"\."org_id" = \?/,
        reason:
          'The pre-read only shapes the audit payload; the organization-scoped update decides whether anything is marked, so a foreign row read without it still marks nothing.',
      },
      {
        locate: /job\.org_id = \?/,
        reason: 'Composed jobLeaseGuard has its own organization mutation registration.',
      },
    ],
  },
  {
    file: 'repositories/registry-policy-read-audit.ts',
    builder: 'createPolicyReadAuditSink',
    cases: [sinkOwnsRows],
    predicates: [],
  },
];
