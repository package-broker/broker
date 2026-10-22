import { expect } from 'vitest';
import { compile, db } from '../../kysely.js';
import { sourceSelectionRevision } from '../../repositories/source-selection-revision.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

const foreignSource: ContractCase = {
  name: 'selection revision expression ignores a foreign source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedSource(seeder(context.executor), 'S', foreign.orgId, 'vcs');
    expect(
      await context.executor.all(
        context.mutate(compile(db.selectNoFrom(sourceSelectionRevision(own, 'S').as('revision')))),
      ),
    ).toEqual([{ revision: null }]);
  },
};

const foreignRegistration: ContractCase = {
  name: 'selection revision expression ignores a foreign registration',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await context.executor.all(
        context.mutate(compile(db.selectNoFrom(sourceSelectionRevision(own, 'S').as('revision')))),
      ),
    ).toEqual([{ revision: '["{}",1,[]]' }]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'sourceSelectionRevision',
    file: 'repositories/source-selection-revision.ts',
    cases: [foreignSource, foreignRegistration],
    predicates: [
      {
        name: 'source organization',
        locate: /source\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: foreignSource.name,
      },
      {
        name: 'registration organization',
        locate: /registered_name\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: foreignRegistration.name,
      },
    ],
  },
];
