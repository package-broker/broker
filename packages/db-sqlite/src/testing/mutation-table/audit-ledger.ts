import { expect } from 'vitest';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { createAuditLedgerRepository } from '../../repositories/audit-ledger.js';
import { orgOf, type CaseContext, type ContractCase, type MutationEntry } from './harness.js';

const gap: AuditLedgerEntry = {
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
const at = (id: number, fromSeq: number, toSeq: number): AuditLedgerEntry => ({
  ...gap,
  id: `01K7R5V00000000000000000${String(id).padStart(2, '0')}`,
  fromSeq,
  toSeq,
});
const own = { first: at(1, 1, 2), merging: at(3, 3, 4), apart: at(6, 7, 8) };

/**
 * The foreign organization reuses own ids: visible 2..2, a visible 5..9 under the merging id that
 * superseded 5..5, and a visible 20..20 under the first own id. Each one changes an own result
 * when an organization predicate is removed.
 */
async function seed(context: CaseContext) {
  const { own: ownOrg, foreign } = orgOf(context);
  const repository = createAuditLedgerRepository(context.executor);
  await repository.append(foreign, [at(10, 2, 2)]);
  await repository.append(foreign, [at(8, 5, 5)]);
  await repository.append(foreign, [at(3, 6, 9)]);
  await repository.append(foreign, [at(1, 20, 20)]);
  await repository.append(ownOrg, [own.first]);
  const mutating = createAuditLedgerRepository({
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  });
  return { ownOrg, foreign, repository, mutating };
}

const readerIsolation: ContractCase = {
  name: 'ledger readers see only the organization and its own visible gaps',
  async run(context) {
    const { ownOrg, repository, mutating } = await seed(context);
    await expect(mutating.page(ownOrg, null, 500)).resolves.toEqual([own.first]);
    await expect(mutating.effectiveGaps(ownOrg)).resolves.toEqual([own.first]);
    const covering = at(6, 4, 8);
    await repository.append(ownOrg, [covering]);
    await expect(mutating.capacityGap(ownOrg, gap.chainId, 0, 5)).resolves.toEqual(covering);
  },
};

const appendIsolation: ContractCase = {
  name: 'ledger appends merge and supersede only the organization gaps',
  async run(context) {
    const { ownOrg, foreign, repository, mutating } = await seed(context);
    await repository.append(ownOrg, [own.apart]);
    await expect(mutating.append(ownOrg, [own.merging])).resolves.toBeUndefined();
    await expect(repository.effectiveGaps(ownOrg)).resolves.toEqual([
      { ...own.merging, fromSeq: 1, count: 2 },
      own.apart,
    ]);
    await expect(repository.effectiveGaps(foreign)).resolves.toEqual([
      at(1, 20, 20),
      { ...at(3, 5, 9), count: 2 },
      at(10, 2, 2),
    ]);
  },
};

const retryIsolation: ContractCase = {
  name: 'ledger retries compare only gaps the organization superseded',
  async run(context) {
    const { ownOrg, repository, mutating } = await seed(context);
    await repository.append(ownOrg, [own.merging]);
    await expect(mutating.append(ownOrg, [own.merging])).resolves.toBeUndefined();
    await expect(repository.effectiveGaps(ownOrg)).resolves.toEqual([
      { ...own.merging, fromSeq: 1, count: 2 },
    ]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditLedgerRepository',
    file: 'repositories/audit-ledger.ts',
    cases: [readerIsolation, appendIsolation, retryIsolation],
    predicates: [
      {
        name: 'ledger readers belong to the organization',
        locate: /current\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 3,
        caseName: readerIsolation.name,
      },
      {
        name: 'reader conflict checks see only the organization visible gaps',
        locate: /visible_gap\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 3,
        caseName: readerIsolation.name,
      },
      {
        name: 'append merges only the organization visible gaps',
        locate: /open_gap\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'append finds a stored id only in the organization',
        locate: /stored\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'supersession marks only the organization gaps',
        locate: /audit_ledger\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'supersession reads the covering gap only in the organization',
        locate: /covering_gap\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'supersession candidates belong to the organization',
        locate: /candidate_gap\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'supersession sees only gaps the organization already hid',
        locate: /absorbed_gap\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: appendIsolation.name,
      },
      {
        name: 'retries count only gaps the organization superseded',
        locate: /hidden\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: retryIsolation.name,
      },
    ],
  },
];
