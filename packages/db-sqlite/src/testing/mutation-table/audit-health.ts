import { ulid } from '@package-broker/core/ids';
import { expect } from 'vitest';
import { AuditHealthConflictError } from '@package-broker/core/audit/health';
import { createAuditHealthRepository } from '../../repositories/audit-health.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

function mutating(context: CaseContext) {
  return createAuditHealthRepository({
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  });
}
const snapshot: ContractCase = {
  name: 'health snapshots exclude foreign chain, pending, sink and ledger state',
  async run(context) {
    const { own: foreign, foreign: own } = orgOf(context);
    await context.executor.batch([
      { sql: "UPDATE audit_chain SET mode = 'trail' WHERE org_id = ?", params: [own.orgId] },
      { sql: "UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", params: [foreign.orgId] },
      {
        sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
        VALUES (?, 'pending', '2026-10-30T00:00:00.000Z', 'system', 'project.update', 'project')`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
        VALUES (?, 'sink', 'sink', 'webhook', 0, 'fingerprint', 1, 'build', 'blocked', 0, ?, 0, 'now', 'now')`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT org_id, 'incident', 'gap', chain_id, epoch, 1, 1, 1, 'seq_gap', policy, mode_generation, 'system', 'now' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
    ]);
    expect(await mutating(context).snapshot(own)).toEqual({
      mode: 'trail',
      capacityState: 'ok',
      restorePending: false,
      oldestPendingAt: null,
      sinks: [],
      incidents: [],
      alerts: [],
    });
  },
};
const observation = { code: 'audit.capacity' as const, fingerprint: 'warning', failing: false };
const observe: ContractCase = {
  name: 'health observation reads and resolves only its organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const normal = createAuditHealthRepository(context.executor);
    await normal.observe(foreign, [observation]);
    await normal.observe(own, [observation]);
    const result = await mutating(context).observe(own, []);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.active).toBe(false);
    expect((await normal.observe(foreign, [observation])).raised).toEqual([]);
  },
};
const read: ContractCase = {
  name: 'health reads cannot substitute foreign persisted observations',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const normal = createAuditHealthRepository(context.executor);
    await normal.observe(foreign, [observation]);
    expect((await mutating(context).observe(own, [observation])).alerts).toHaveLength(1);
    expect((await normal.observe(own, [])).alerts).toHaveLength(1);
  },
};
const acknowledgeRevision: ContractCase = {
  name: 'health acknowledgement revisions exclude foreign occurrences',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const normal = createAuditHealthRepository(context.executor);
    await normal.observe(own, [observation]);
    await normal.observe(foreign, [observation]);
    await normal.observe(foreign, [{ ...observation, fingerprint: 'refusing', failing: true }]);
    expect(await mutating(context).acknowledge(own, observation.code, 1)).toBe(true);
  },
};
const acknowledge: ContractCase = {
  name: 'health acknowledgements preserve foreign incidents',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const normal = createAuditHealthRepository(context.executor);
    await normal.observe(foreign, [observation]);
    await normal.observe(own, [observation]);
    expect(await mutating(context).acknowledge(own, observation.code, 1)).toBe(true);
    expect((await normal.observe(foreign, [observation])).alerts[0]?.acknowledgedRevision).toBe(0);
  },
};
const raise: ContractCase = {
  name: 'transient alerts are captured only for their organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await mutating(context).raise(own, 'audit.hold_failed');
    const normal = createAuditHealthRepository(context.executor);
    expect((await normal.observe(own, [])).alerts).toHaveLength(1);
    expect((await normal.observe(foreign, [])).alerts).toEqual([]);
  },
};
const outcome = (write: Promise<unknown>) =>
  write.then(
    () => 'written',
    (error: unknown) => {
      if (error instanceof AuditHealthConflictError) return 'conflict';
      throw error;
    },
  );
const guardCount: ContractCase = {
  name: 'health observation guards count only their organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await createAuditHealthRepository(context.executor).observe(foreign, [observation]);
    expect(await outcome(mutating(context).observe(own, [observation], []))).toBe('written');
  },
};
const guardRows: ContractCase = {
  name: 'health observation guards cannot match a foreign twin',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const normal = createAuditHealthRepository(context.executor);
    await normal.observe(foreign, [observation]);
    await normal.observe(own, [observation]);
    const stale = (await normal.snapshot(own)).alerts;
    await normal.observe(own, [{ ...observation, fingerprint: 'refusing', failing: true }]);
    expect(await outcome(mutating(context).observe(own, [], stale))).toBe('conflict');
  },
};
async function operatorFixture(context: CaseContext, foreignActor = false) {
  const { own, foreign } = orgOf(context);
  const id = ulid();
  await context.executor.all({
    sql: 'INSERT INTO user_account (org_id, id, email) VALUES (?, ?, ?)',
    params: [foreignActor ? foreign.orgId : own.orgId, id, 'operator@example.test'],
  });
  const port = createAuditHealthRepository(
    {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    },
    { actor: { type: 'user', id }, generation: 0, now: new Date('2026-10-31T00:00:00.000Z') },
  );
  return { own, foreign, port, normal: createAuditHealthRepository(context.executor) };
}
const operatorRead: ContractCase = {
  name: 'alert operator lookup excludes foreign accounts',
  async run(context) {
    const { own, port } = await operatorFixture(context, true);
    expect(await port.operatorStatus(own)).toBe('actor_unavailable');
  },
};
async function foreignGeneration(context: CaseContext, orgId: string) {
  await context.executor.all({
    sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, created_at, updated_at)
      VALUES (?, 'sink', 'sink', 'webhook', 1, 'fingerprint', 1, 'build', 'active', 0, ?, 0, 'now', 'now')`,
    params: [orgId, '0'.repeat(64)],
  });
}
const operatorGeneration: ContractCase = {
  name: 'alert operator generation lookup excludes foreign sinks',
  async run(context) {
    const { own, foreign, port } = await operatorFixture(context);
    await foreignGeneration(context, foreign.orgId);
    expect(await port.operatorStatus(own)).toBe('ready');
  },
};
const operatorGuard: ContractCase = {
  name: 'alert acknowledgement guards exclude foreign actors',
  async run(context) {
    const { own, port, normal } = await operatorFixture(context, true);
    await normal.raise(own, observation.code);
    await expect(port.acknowledge(own, observation.code, 1)).rejects.toThrow(
      AuditHealthConflictError,
    );
  },
};
const generationGuard: ContractCase = {
  name: 'alert acknowledgement generation guard excludes foreign sinks',
  async run(context) {
    const { own, foreign, port, normal } = await operatorFixture(context);
    await foreignGeneration(context, foreign.orgId);
    await normal.raise(own, observation.code);
    expect(await outcome(port.acknowledge(own, observation.code, 1))).toBe('written');
    expect((await normal.snapshot(own)).alerts?.[0]?.acknowledgedRevision).toBe(1);
  },
};
const eventScope: ContractCase = {
  name: 'alert events require an unacknowledged incident in their organization',
  async run(context) {
    const { own, foreign, port, normal } = await operatorFixture(context);
    await normal.raise(own, observation.code);
    await normal.acknowledge(own, observation.code, 1);
    await normal.raise(foreign, observation.code);
    expect(await port.acknowledge(own, observation.code, 1)).toBe(false);
    expect(
      await context.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toEqual([]);
  },
};
const eventRevision: ContractCase = {
  name: 'alert event revision excludes foreign incidents',
  async run(context) {
    const { own, foreign, port, normal } = await operatorFixture(context);
    await normal.raise(own, observation.code);
    await normal.raise(foreign, observation.code);
    await normal.raise(foreign, observation.code);
    expect(await port.acknowledge(own, observation.code, 1)).toBe(true);
    expect(
      await context.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [own.orgId],
      }),
    ).toHaveLength(1);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditHealthRepository',
    file: 'repositories/audit-health.ts',
    cases: [
      snapshot,
      observe,
      read,
      acknowledge,
      acknowledgeRevision,
      raise,
      guardCount,
      guardRows,
      operatorRead,
      operatorGeneration,
      operatorGuard,
      generationGuard,
      eventScope,
      eventRevision,
    ],
    predicates: [
      {
        name: 'alert operator lookup is scoped',
        locate: /(?<=FROM user_account WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: operatorRead.name,
      },
      {
        name: 'alert generation lookup is scoped',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: operatorGeneration.name,
      },
      {
        name: 'alert actor guard is scoped',
        locate: /(?<=FROM "user_account"\s+WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: operatorGuard.name,
      },
      {
        name: 'alert generation guard is scoped',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: generationGuard.name,
      },
      {
        name: 'alert event incident is scoped',
        locate: /(?<=EXISTS \(SELECT 1 FROM audit_health WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: eventScope.name,
      },
      {
        name: 'alert event latest revision is scoped',
        locate: /h\.org_id = \?(?= AND h\.code = \?)/,
        neutral: '(? IS NOT NULL)',
        caseName: eventRevision.name,
        copies: 2,
      },

      ...['audit_chain', 'audit_pending', 'audit_sink', 'audit_ledger'].map((table) => ({
        name: `health snapshot scopes ${table}`,
        locate: new RegExp(String.raw`(?<=FROM ${table}\s+WHERE )org_id = \?`),
        neutral: '(? IS NOT NULL)',
        caseName: snapshot.name,
      })),
      {
        name: 'health resolution scopes alerts',
        locate: /(?<=SET active = 0, failing = 0 WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: observe.name,
      },
      {
        name: 'health alert reads are scoped',
        locate: /(?<=FROM audit_health WHERE )org_id = \?(?= ORDER BY)/,
        neutral: '(? IS NOT NULL)',
        caseName: read.name,
      },
      {
        name: 'health acknowledgement revision is scoped',
        locate: /h\.org_id = \?(?= AND h\.code = \?)/,
        neutral: '(? IS NOT NULL)',
        caseName: acknowledgeRevision.name,
      },
      {
        name: 'health observation guard counts its organization',
        locate: /(?<=SELECT count\(\*\) FROM audit_health WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: guardCount.name,
      },
      {
        name: 'health observation guard matches its organization',
        locate: /h\.org_id = \?(?=\s+AND h\.code = json_extract)/,
        neutral: '(? IS NOT NULL)',
        caseName: guardRows.name,
      },
      {
        name: 'health acknowledgement is scoped',
        locate: /(?<=WHERE )org_id = \?(?= AND code)/,
        neutral: '(? IS NOT NULL)',
        caseName: acknowledge.name,
      },
    ],
  },
];
