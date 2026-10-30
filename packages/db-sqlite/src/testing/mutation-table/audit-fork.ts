import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditForkRepository } from '../../repositories/audit-fork.js';
import { seedAuditFork } from '../audit-fork-suite.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

function mutated(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}
async function readHistory(context: CaseContext, target: 'own' | 'foreign') {
  const { own, foreign } = orgOf(context);
  await seedAuditFork(context.executor, own);
  await seedAuditFork(context.executor, foreign);
  await context.executor.batch([
    {
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
      SELECT '01JZZZZZZZZZZZZZZZZZZZZZZX', org_id, 'chain_reset', chain_id, 0, 1, 1, 0, 'tamper_detected', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
      params: [own.orgId],
    },
    {
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
      SELECT '01JZZZZZZZZZZZZZZZZZZZZZZY', f.org_id, 'chain_reset', o.chain_id, 0, 1, 1, 0, 'tamper_detected', f.policy, f.mode_generation, 'system', '2026-10-31T00:00:00.000Z'
      FROM audit_chain f, audit_chain o WHERE f.org_id = ? AND o.org_id = ?`,
      params: [foreign.orgId, own.orgId],
    },
  ]);
  await context.executor.batch([
    {
      sql: 'UPDATE audit_chain SET chain_id = ?, head_seq = CASE WHEN org_id = ? THEN 8 ELSE 10 END WHERE org_id IN (?, ?)',
      params: ['c'.repeat(32), own.orgId, own.orgId, foreign.orgId],
    },
    {
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT 'foreign-gap', org_id, 'gap', chain_id, epoch, 6, 6, 1, 'seq_gap', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
      params: [foreign.orgId],
    },
    {
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT 'own-gap', org_id, 'gap', chain_id, epoch, 5, 5, 0, 'seq_gap', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
      params: [own.orgId],
    },
    {
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT CASE WHEN org_id = ? THEN 'confirm-a' ELSE 'confirm-z' END, org_id, 'restore_confirmed', chain_id, epoch, 1, 1, 0, 'restore_confirmed', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id IN (?, ?)`,
      params: [own.orgId, own.orgId, foreign.orgId],
    },
  ]);
  const plain = createAuditForkRepository(context.executor);
  const selected = target === 'own' ? own : foreign;
  expect(await createAuditForkRepository(mutated(context)).read(selected)).toEqual(
    await plain.read(selected),
  );
}
const read: ContractCase = {
  name: 'fork reads exclude foreign chain and sinks',
  run: (context) => readHistory(context, 'foreign'),
};
const historyRead: ContractCase = {
  name: 'fork history uses only the organization chain and confirmation',
  run: (context) => readHistory(context, 'own'),
};
const save: ContractCase = {
  name: 'fork writes preserve foreign state and verification and ignore foreign generations',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditFork(context.executor, own);
    await seedAuditFork(context.executor, foreign);
    await context.executor.batch([
      {
        sql: `UPDATE audit_sink SET generation = 99, inflight_repr = '{"custodyFromSeq":2}' WHERE org_id = ?`,
        params: [foreign.orgId],
      },
    ]);
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
      SELECT '01JZZZZZZZZZZZZZZZZZZZZZZX', org_id, 'chain_reset', chain_id, 0, 1, 1, 0, 'tamper_detected', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
      SELECT '01JZZZZZZZZZZZZZZZZZZZZZZW', o.org_id, 'chain_reset', f.chain_id, 0, 1, 1, 0, 'tamper_detected', o.policy, o.mode_generation, 'system', '2026-10-29T00:00:00.000Z'
      FROM audit_chain o, audit_chain f WHERE o.org_id = ? AND f.org_id = ?`,
        params: [own.orgId, foreign.orgId],
      },
    ]);
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ?, head_seq = 10 WHERE org_id IN (?, ?)',
        params: ['c'.repeat(32), own.orgId, foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT 'foreign-gap', org_id, 'gap', chain_id, epoch, 5, 5, 1, 'seq_gap', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
        params: [foreign.orgId],
      },
      {
        sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, reason_code, policy, mode_generation, actor_type, created_at)
        SELECT CASE WHEN org_id = ? THEN 'confirm-a' ELSE 'confirm-z' END, org_id, 'restore_confirmed', chain_id, epoch, 1, 1, 0, 'restore_confirmed', policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id IN (?, ?)`,
        params: [own.orgId, own.orgId, foreign.orgId],
      },
    ]);
    const plain = createAuditForkRepository(context.executor);
    const expected = await plain.read(own);
    const before = await plain.read(foreign);
    const saved = await createAuditForkRepository(mutated(context)).save(
      own,
      expected,
      [],
      {
        epoch: 1,
        restorePending: true,
        boundaryReason: 'epoch_bump',
        sinks: expected.sinks.map((row) => ({ ...row, state: 'blocked', blockedReason: 'fork' })),
        ledger: [],
        event: null,
        now: '2026-10-30T00:00:00.000Z',
      },
      2,
    );
    expect(saved).toBe(true);
    expect(await plain.read(foreign)).toEqual(before);
    expect(
      await context.executor.all({
        sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ verified_at: '2026-10-30T00:00:00.000Z' }]);
    expect(
      await context.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: '2026-10-30T00:00:00.000Z' }]);
  },
};
const guard: ContractCase = {
  name: 'foreign chain snapshot cannot authorize a fork save',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditFork(context.executor, own);
    await seedAuditFork(context.executor, foreign);
    const expected = await createAuditForkRepository(context.executor).read(foreign);
    expect(
      await createAuditForkRepository(mutated(context)).save(
        own,
        expected,
        [],
        {
          epoch: 1,
          restorePending: true,
          boundaryReason: 'epoch_bump',
          sinks: expected.sinks,
          ledger: [],
          event: null,
          now: '2026-10-30T00:00:00.000Z',
        },
        2,
      ),
    ).toBe(false);
  },
};
const hashes: ContractCase = {
  name: 'foreign journal hashes cannot satisfy local observations',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditFork(context.executor, own);
    await context.executor.batch([
      {
        sql: `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type)
        VALUES ('foreign-hash', ?, 1, ?, ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [foreign.orgId, '0'.repeat(64), 'f'.repeat(64)],
      },
    ]);
    const plain = createAuditForkRepository(context.executor);
    const port = createAuditForkRepository(mutated(context));
    expect(await port.hashAt(own, 1)).toBeNull();
    const expected = await plain.read(own);
    expect(
      await port.save(
        own,
        expected,
        [{ seq: 1, hash: null }],
        {
          epoch: 1,
          restorePending: true,
          boundaryReason: 'epoch_bump',
          sinks: expected.sinks,
          ledger: [],
          event: null,
          now: '2026-10-30T00:00:00.000Z',
        },
        2,
      ),
    ).toBe(true);
  },
};
const carry: ContractCase = {
  name: 'fork carry copies only the organization obligations into the new epoch',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditFork(context.executor, own);
    await seedAuditFork(context.executor, foreign);
    const row = (
      orgId: string,
      id: string,
      kind: string,
      from: number,
      reason: string,
      resolves: string | null = null,
    ) => ({
      sql: `INSERT INTO audit_ledger (id, org_id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type, created_at, resolves_id)
        SELECT ?, org_id, ?, chain_id, epoch, ?, ?, 1, CASE WHEN ? = 'gap' THEN NULL ELSE 'archive' END, ?, policy, mode_generation, 'system', '2026-10-30T00:00:00.000Z', ? FROM audit_chain WHERE org_id = ?`,
      params: [id, kind, from, from, kind, reason, resolves, orgId],
    });
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ?, head_seq = 10 WHERE org_id IN (?, ?)',
        params: ['c'.repeat(32), own.orgId, foreign.orgId],
      },
      row(own.orgId, '01JZZZZZZZZZZZZZZZZZZZZZZV', 'gap', 5, 'seq_gap'),
      row(own.orgId, '01JZZZZZZZZZZZZZZZZZZZZZZT', 'uncertain', 6, 'timeout'),
      row(foreign.orgId, '01JZZZZZZZZZZZZZZZZZZZZZZV', 'gap', 5, 'seq_gap'),
      row(foreign.orgId, '01JZZZZZZZZZZZZZZZZZZZZZZU', 'gap', 7, 'seq_gap'),
      row(foreign.orgId, '01JZZZZZZZZZZZZZZZZZZZZZZT', 'uncertain', 6, 'timeout'),
    ]);
    await context.executor.batch([
      row(
        foreign.orgId,
        '01JZZZZZZZZZZZZZZZZZZZZZZR',
        'replay',
        6,
        'durable_ack',
        '01JZZZZZZZZZZZZZZZZZZZZZZT',
      ),
    ]);
    const ledger = (orgId: string) =>
      context.executor.all({
        sql: 'SELECT * FROM audit_ledger WHERE org_id = ? ORDER BY id',
        params: [orgId],
      });
    const foreignBefore = await ledger(foreign.orgId);
    const expected = await createAuditForkRepository(context.executor).read(own);
    expect(
      await createAuditForkRepository(mutated(context)).save(
        own,
        expected,
        [],
        {
          epoch: 1,
          restorePending: true,
          boundaryReason: 'epoch_bump',
          sinks: expected.sinks,
          ledger: [],
          event: null,
          now: '2026-10-30T00:00:00.000Z',
        },
        2,
      ),
    ).toBe(true);
    expect(
      (await ledger(own.orgId))
        .filter((value) => value.epoch === 1)
        .map((value) => [value.kind, value.from_seq])
        .sort(),
    ).toEqual([
      ['gap', 5],
      ['uncertain', 6],
    ]);
    expect(await ledger(foreign.orgId)).toEqual(foreignBefore);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditForkRepository',
    file: 'repositories/audit-fork.ts',
    cases: [read, historyRead, save, guard, hashes, carry],
    predicates: [
      {
        name: 'chain read organization',
        locate: /(?<=FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: read.name,
      },
      {
        name: 'sink read organization',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?(?= ORDER BY)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: read.name,
      },
      {
        name: 'history chain organization (read)',
        locate: /history_source\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: historyRead.name,
      },
      {
        name: 'history chain organization (CAS)',
        locate: /history_source\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'history gap organization (read)',
        locate: /gap\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: historyRead.name,
      },
      {
        name: 'history gap organization (CAS)',
        locate: /gap\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'history chain reset organization (read)',
        locate: /reset\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: historyRead.name,
      },
      {
        name: 'history chain reset organization (CAS)',
        locate: /reset\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'history newer reset organization (read)',
        locate: /newer\.org_id = reset\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: historyRead.name,
      },
      {
        name: 'history newer reset organization (CAS)',
        locate: /newer\.org_id = reset\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'history latest confirmation organization (read)',
        locate: /latest\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: historyRead.name,
      },
      {
        name: 'history latest confirmation organization (CAS)',
        locate: /latest\.org_id = history_chain\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'carry chain organization',
        locate: /carry_chain\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 3,
        caseName: carry.name,
      },
      {
        name: 'carry row organization',
        locate: /carried\.org_id = carry_chain\.org_id/,
        neutral: '1',
        copies: 3,
        caseName: carry.name,
      },
      {
        name: 'carry resolution organization',
        locate: /resolution\.org_id = carried\.org_id/,
        neutral: '1',
        copies: 3,
        caseName: carry.name,
        waivedCopies: {
          2: 'Without the predicate the carried set can only shrink; the guard count (copy 1) catches a shrink, while its membership check only looks for carried rows missing from the mapping.',
        },
      },
      {
        name: 'carry source organization',
        locate: /(?<![a-z_])source\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: carry.name,
      },
      {
        name: 'journal read organization',
        locate: /(?<=FROM audit_event WHERE )org_id = \?(?= AND seq)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: hashes.name,
      },
      {
        name: 'journal observation organization',
        locate: /(?<=FROM audit_event WHERE )org_id = \?(?=\n\s+AND seq)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: hashes.name,
      },
      {
        name: 'chain CAS organization',
        locate: /c\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: guard.name,
      },
      {
        name: 'sink set count organization',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?(?=\))/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'sink CAS and generation organization',
        locate: /s\.org_id = \?(?= AND \()/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'chain update organization',
        locate: /org_id = \?(?= RETURNING org_id)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'sink update organization',
        locate: /org_id = \?(?= AND sink_id IN)/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'chain verification organization',
        locate: /(?<=verified_at = NULL WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
      {
        name: 'organization verification organization',
        locate: /(?<=audit_last_verified_at = NULL WHERE )id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: save.name,
      },
    ],
  },
];
