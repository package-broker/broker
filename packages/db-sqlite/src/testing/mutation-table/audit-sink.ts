import { expect } from 'vitest';
import {
  reconcileAuditSinks,
  type AuditSinkRegistration,
} from '@package-broker/core/audit/sinks/registry';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAuditSinkRepository } from '../../repositories/audit-sink.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const sink: AuditSinkRegistration = {
  id: 'archive',
  pluginId: 'audit',
  kind: 'webhook',
  durableAck: true,
  destination: { receiverFingerprint: 'a'.repeat(64), activationSource: 'ARCHIVE_URL' },
};
function mutated(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}
const read: ContractCase = {
  name: 'sink snapshots use only the requested organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const plain = createAuditSinkRepository(context.executor);
    await reconcileAuditSinks(plain, own, 1, [sink], now);
    await reconcileAuditSinks(plain, foreign, 2, [{ ...sink, id: 'other' }], now);
    const expected = await plain.read(foreign);
    expect(await createAuditSinkRepository(mutated(context)).read(foreign)).toEqual(expected);
  },
};
const save: ContractCase = {
  name: 'sink reconciliation spares foreign chain and cursor rows',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const plain = createAuditSinkRepository(context.executor);
    await reconcileAuditSinks(plain, own, 1, [sink], now);
    await reconcileAuditSinks(plain, foreign, 1, [sink, { ...sink, id: 'other' }], now);
    const ownChain = await plain.read(own);
    await context.executor.batch([
      {
        sql: 'UPDATE audit_chain SET chain_id = ?, incarnation = ? WHERE org_id = ?',
        params: [ownChain.chainId, ownChain.incarnation, foreign.orgId],
      },
    ]);
    const before = await plain.read(foreign);
    const expected = await plain.read(own);
    expect(
      await createAuditSinkRepository(mutated(context)).save(own, expected, {
        generation: 2,
        sinks: expected.sinks.map((row) => ({ ...row, generation: 2, state: 'disabled' })),
        rebinds: [],
        now: now.toISOString(),
      }),
    ).toBe(true);
    expect((await plain.read(own)).sinks[0]).toMatchObject({ generation: 2, state: 'disabled' });
    expect(await plain.read(foreign)).toEqual(before);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditSinkRepository',
    file: 'repositories/audit-sink.ts',
    cases: [read, save],
    predicates: [
      {
        name: 'chain snapshot organization',
        locate: /(?<=FROM audit_chain WHERE )org_id = \?/,
        neutral: '(? IS NOT NULL)',
        caseName: read.name,
        copies: 1,
      },
      {
        name: 'sink snapshot organization',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?(?= ORDER BY)/,
        neutral: '(? IS NOT NULL)',
        caseName: read.name,
        copies: 1,
      },
      {
        name: 'chain generation fence organization',
        locate: /org_id = \?(?= AND mode_generation)/,
        neutral: '(? IS NOT NULL)',
        caseName: save.name,
        copies: 1,
      },
      {
        name: 'sink membership fence organization',
        locate: /(?<=FROM audit_sink WHERE )org_id = \?(?=\))/,
        neutral: '(? IS NOT NULL)',
        caseName: save.name,
        copies: 1,
      },
      {
        name: 'sink snapshot fence organization',
        locate: /org_id = \?(?= AND sink_id IS)/,
        neutral: '(? IS NOT NULL)',
        caseName: save.name,
        copies: 1,
      },
    ],
  },
];
