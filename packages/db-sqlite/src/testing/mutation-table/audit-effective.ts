import { expect } from 'vitest';
import type { EffectiveAuditConfig } from '@package-broker/core/audit/effective';
import { createAuditEffectiveRepository } from '../../repositories/audit-effective.js';
import { createAuditNoneRepository } from '../../repositories/audit-none.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const effective: EffectiveAuditConfig = {
  policy: 'required',
  policySource: 'build',
  persistRaise: true,
  mode: 'trail',
  trailActive: true,
  activeSinkIds: [],
  blockedSinkIds: [],
  durableSinkIds: [],
  durablePath: true,
  maxJournalBytes: 67108864,
  warnings: [],
};
const isolation: ContractCase = {
  name: 'effective transition preserves foreign policy and verification and ignores foreign generation',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      {
        sql: "UPDATE audit_chain SET verified_at = 'verified' WHERE org_id = ?",
        params: [foreign.orgId],
      },
      {
        sql: "UPDATE organization SET audit_last_verified_at = 'verified' WHERE id = ?",
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
        durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
        VALUES (?, 'archive', 'audit', 'webhook', 9, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, ?, 0)`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
    ]);
    const before = await context.executor.all({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [foreign.orgId],
    });
    const expected = await createAuditNoneRepository(context.executor).snapshot(own);
    const repository = createAuditEffectiveRepository({
      ...context.executor,
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    expect(await repository.save(own, expected, effective, 1, '2026-10-31T12:00:00.000Z')).toBe(
      true,
    );
    expect(
      await context.executor.all({
        sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual(before);
    expect(
      await context.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: 'verified' }]);
  },
};
const guard: ContractCase = {
  name: 'effective transition cannot borrow a foreign snapshot to raise a restored organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const expected = await createAuditNoneRepository(context.executor).snapshot(foreign);
    await context.executor.batch([
      { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [own.orgId] },
    ]);
    const repository = createAuditEffectiveRepository({
      ...context.executor,
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    expect(await repository.save(own, expected, effective, 1, '2026-10-31T12:00:00.000Z')).toBe(
      false,
    );
  },
};
const initialize: ContractCase = {
  name: 'initial configuration respects foreign pending events, ledger rows and sink generations',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
          VALUES (?, 'setup', '2026-10-31T12:00:00.000Z', 'system', 'setup.complete', 'user')`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
          reason_code, policy, mode_generation, actor_type, created_at)
          SELECT org_id, 'policy', 'policy_change', chain_id, epoch, 1, 1, 0, 'policy_set',
            policy, 0, 'system', '2026-10-31T12:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
          durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
          VALUES (?, 'archive', 'audit', 'webhook', 9, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, ?, 0)`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
    ]);
    const reader = createAuditNoneRepository(context.executor);
    const expected = await reader.snapshot(own);
    const before = await reader.snapshot(foreign);
    const repository = createAuditEffectiveRepository({
      ...context.executor,
      all: (statement) => context.executor.all(context.mutate(statement)),
    });
    expect(await repository.initialize(own, expected, effective, 1)).toBe(true);
    expect(await reader.snapshot(foreign)).toEqual(before);
  },
};
const initializeGuard: ContractCase = {
  name: 'initial configuration cannot borrow a foreign chain',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const reader = createAuditNoneRepository(context.executor);
    const expected = await reader.snapshot(foreign);
    const before = await reader.snapshot(foreign);
    const repository = createAuditEffectiveRepository({
      ...context.executor,
      all: (statement) => context.executor.all(context.mutate(statement)),
    });
    expect(await repository.initialize(own, expected, effective, 1)).toBe(false);
    expect(await reader.snapshot(foreign)).toEqual(before);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditEffectiveRepository',
    file: 'repositories/audit-effective.ts',
    cases: [isolation, guard, initialize, initializeGuard],
    predicates: [
      {
        name: 'initial configuration organization',
        locate: /org_id = \?(?= AND chain_id)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: initializeGuard.name,
      },
      ...['p', 'l', 's'].map((alias) => ({
        name: `initial configuration ${alias} organization`,
        locate: new RegExp(`${alias}\\.org_id = \\?`),
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: initialize.name,
      })),
      {
        name: 'snapshot organization',
        locate: /c\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: guard.name,
      },
      {
        name: 'generation organization',
        locate: /s\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'transition organization',
        locate: /org_id = \?(?= RETURNING org_id)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'chain verification organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'organization verification scope',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: isolation.name,
      },
    ],
    waivers: [
      {
        locate: /(?:open_gap|stored|hidden)\.org_id = \?/,
        reason: 'Ledger predicates are exercised by the ledger builder mutation registration.',
      },
      {
        locate: /audit_chain\.org_id = input\.pending_org_id/,
        reason:
          'The shared staging capacity guard is exercised by the pending builder mutation registration.',
      },
    ],
  },
];
