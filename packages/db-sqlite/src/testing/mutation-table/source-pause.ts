import { expect } from 'vitest';
import { pauseSourceStatement } from '../../repositories/source.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

const foreignSource: ContractCase = {
  name: 'pausing preserves a foreign source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'vcs');
    await context.executor.batch([context.mutate(pauseSourceStatement(own, 'S'))]);
    expect(
      await context.executor.all({ sql: "SELECT status FROM source WHERE id = 'S'", params: [] }),
    ).toEqual([{ status: 'active' }]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'pauseSourceStatement',
    file: 'repositories/source.ts',
    cases: [foreignSource],
    predicates: [
      {
        name: 'the paused source belongs to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
    ],
  },
];
