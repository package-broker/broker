import { expect } from 'vitest';
import {
  registerAuditExport,
  type VerifiedAuditArtifact,
} from '@package-broker/core/audit/cutover';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditCutoverRepository } from '../../repositories/audit-cutover.js';
import { CUTOVER_ACTOR, CUTOVER_NOW, seedCutover } from '../audit-cutover-suite.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const mutated = (context: CaseContext): SqlExecutor => ({
  driver: context.executor.driver,
  all: (s) => context.executor.all(context.mutate(s)),
  batch: (s) => context.executor.batch(context.mutateBatch(s)),
});
function register(context: CaseContext, artifact: VerifiedAuditArtifact) {
  return registerAuditExport(
    createAuditCutoverRepository(mutated(context)),
    orgOf(context).own,
    artifact,
    0,
    { type: 'user', id: CUTOVER_ACTOR },
    CUTOVER_NOW,
  );
}
const isolated: ContractCase = {
  name: 'registration and verification reset preserve a foreign chain and ignore its build generation',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const artifact = await seedCutover(context.executor, own);
    await seedCutover(context.executor, foreign, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq) VALUES (?, 'archive', 'audit', 'webhook', 1, 'fingerprint', 1, 'ARCHIVE_URL', 'active', 0, ?, 0)`,
        params: [foreign.orgId, '0'.repeat(64)],
      },
    ]);
    expect(await register(context, artifact)).toBe(true);
    expect(
      await context.executor.all({
        sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ verified_at: CUTOVER_NOW }]);
    expect(
      await context.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: CUTOVER_NOW }]);
  },
};
const read: ContractCase = {
  name: 'registration reads the requested organization policy',
  async run(context) {
    const { foreign } = orgOf(context);
    const artifact = await seedCutover(context.executor, foreign);
    await context.executor.batch([
      {
        sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?",
        params: [foreign.orgId],
      },
    ]);
    expect(
      await registerAuditExport(
        createAuditCutoverRepository(mutated(context)),
        foreign,
        artifact,
        0,
        { type: 'user', id: CUTOVER_ACTOR },
        CUTOVER_NOW,
      ),
    ).toBe(true);
  },
};
const guard: ContractCase = {
  name: 'a matching foreign head cannot authorize a restored organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const artifact = await seedCutover(context.executor, own);
    await seedCutover(context.executor, foreign, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ? WHERE org_id = ?',
        params: [artifact.chainId, foreign.orgId],
      },
      { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [own.orgId] },
    ]);
    expect(await register(context, artifact)).toBe(false);
  },
};
const actor: ContractCase = {
  name: 'a foreign active operator cannot authorize a local registration',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const artifact = await seedCutover(context.executor, own);
    await context.executor.batch([
      {
        sql: 'UPDATE user_account SET org_id = ? WHERE org_id = ? AND id = ?',
        params: [foreign.orgId, own.orgId, CUTOVER_ACTOR],
      },
    ]);
    expect(await register(context, artifact)).toBe(false);
  },
};

const anchor: ContractCase = {
  name: 'a foreign artifact anchor cannot prove local custody',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const artifact = await seedCutover(context.executor, own);
    await seedCutover(context.executor, foreign, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
    await context.executor.batch([
      { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [own.orgId] },
    ]);
    expect(await register(context, artifact)).toBe(false);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditCutoverRepository',
    file: 'repositories/audit-cutover.ts',
    cases: [isolated, read, guard, actor, anchor],
    predicates: [
      {
        name: 'artifact anchor organization',
        locate: /e\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: anchor.name,
        copies: 1,
      },
      {
        name: 'snapshot organization',
        locate: /(?<=incarnation FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: read.name,
        copies: 1,
      },
      {
        name: 'head organization',
        locate: /c\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: guard.name,
        copies: 1,
      },
      {
        name: 'generation organization',
        locate: /s\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: isolated.name,
        copies: 1,
      },
      {
        name: 'operator organization',
        locate: /org_id = \?(?= AND id = \? AND status)/,
        neutral: '(? IS NOT NULL)',
        caseName: actor.name,
        copies: 1,
      },
      {
        name: 'chain verification organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: isolated.name,
        copies: 1,
      },
      {
        name: 'organization verification scope',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: isolated.name,
        copies: 1,
      },
    ],
    waivers: [
      {
        locate: /(?:open_gap|stored|hidden)\.org_id = \?/,
        reason:
          'Unchanged ledger statement scopes have independent mutation coverage in the ledger repository registration.',
      },
    ],
  },
];
