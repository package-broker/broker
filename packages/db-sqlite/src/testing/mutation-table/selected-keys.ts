import { expect } from 'vitest';
import {
  selectedKeysStatement,
  selectionRevisionStatement,
} from '../../repositories/source-sync-reads.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

const foreignRegistration: ContractCase = {
  name: 'selected keys reject a registration from another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await context.executor.all(context.mutate(selectedKeysStatement(own, 'S', ['acme/p']))),
    ).toEqual([]);
  },
};
const foreignSource: ContractCase = {
  name: 'selected keys reject a source from another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
      own.orgId,
    );
    expect(
      await context.executor.all(context.mutate(selectedKeysStatement(own, 'S', ['acme/p']))),
    ).toEqual([]);
  },
};
const revisionForeignSource: ContractCase = {
  name: 'selection revision ignores a source from another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedSource(seeder(context.executor), 'S', foreign.orgId, 'vcs');
    expect(
      await context.executor.all(context.mutate(selectionRevisionStatement(own, 'S'))),
    ).toEqual([{ revision: null }]);
  },
};
const revisionForeignRegistration: ContractCase = {
  name: 'selection revision ignores a registration from another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await context.executor.all(context.mutate(selectionRevisionStatement(own, 'S'))),
    ).toEqual([{ revision: '["{}",1,[]]' }]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'selectionRevisionStatement',
    file: 'repositories/source-sync-reads.ts',
    cases: [revisionForeignSource, revisionForeignRegistration],
    predicates: [
      {
        name: 'selection revision source organization',
        locate: /source\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: revisionForeignSource.name,
      },
      {
        name: 'selection revision registration organization',
        locate: /registered_name\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: revisionForeignRegistration.name,
      },
    ],
  },
  {
    builder: 'selectedKeysStatement',
    file: 'repositories/source-sync-reads.ts',
    cases: [foreignRegistration, foreignSource],
    predicates: [
      {
        name: 'registration organization',
        locate: /rn_cov\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: foreignRegistration.name,
      },
    ],
    waivers: [
      {
        locate: /selection_source\.org_id = \?/,
        reason:
          'The org-scoped ecosystem subquery independently rejects a foreign source; sourceSelectionCondition has an isolated source mutation case in source-selection.ts.',
      },
      {
        locate: /(?<=AND )org_id = \?/,
        reason:
          'sourceSelectionCondition independently rejects a foreign source; the redundant ecosystem lookup remains organization scoped.',
      },
    ],
  },
];
