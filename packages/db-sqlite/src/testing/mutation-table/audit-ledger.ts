import { expect } from 'vitest';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditLedgerRepository } from '../../repositories/audit-ledger.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const organizationIsolation: ContractCase = {
  name: 'ledger appends and pages keep same-id dispositions isolated by organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const entry: AuditLedgerEntry = {
      id: '01K7R5V0000000000000000001',
      kind: 'gap',
      chainId: 'a'.repeat(32),
      epoch: 0,
      fromSeq: 1,
      toSeq: 2,
      count: 1,
      sinkId: null,
      reasonCode: 'capacity',
      policy: 'availability',
      modeGeneration: 0,
      actorType: 'system',
      actorId: null,
      createdAt: '2026-10-28T10:00:00.000Z',
    };
    const repository = createAuditLedgerRepository(context.executor);
    const foreignEntries = [
      { ...entry, count: 1 },
      { ...entry, id: '01K7R5V0000000000000000002', kind: 'export' as const },
    ];
    await repository.append(foreign, foreignEntries);
    const mutating = createAuditLedgerRepository({
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    });
    await mutating.append(own, [entry]);
    const superseding = {
      ...entry,
      id: '01K7R5V0000000000000000003',
      fromSeq: 3,
      toSeq: 4,
    };
    await repository.append(foreign, [superseding]);
    expect(await mutating.page(own, null, 500)).toEqual([entry]);
    expect(await mutating.effectiveGaps(own)).toEqual([entry]);
    expect(await repository.page(foreign, null, 500)).toEqual([
      foreignEntries[1],
      { ...superseding, fromSeq: 1, count: 2 },
    ]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditLedgerRepository',
    file: 'repositories/audit-ledger.ts',
    cases: [organizationIsolation],
    predicates: [
      {
        name: 'latest gap lookup belongs to the organization',
        locate: /l.org_id = \?(?= AND)/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: organizationIsolation.name,
      },
      {
        name: 'ledger readers belong to the organization',
        locate: /current.org_id = \?(?= AND)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: organizationIsolation.name,
      },
      {
        name: 'superseding gaps belong to the organization',
        locate: /later.org_id = \?(?= AND)/,
        neutral: '(? is not null)',
        copies: 2,
        caseName: organizationIsolation.name,
      },
    ],
  },
];
