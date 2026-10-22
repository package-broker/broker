import { expect } from 'vitest';
import { acceptRemovalStatement } from '../../repositories/source-removal.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

const refusal = { at: '2020-01-01T00:00:00.000Z', absent: 9, listed: 1, successful: 1 };

const foreignSource: ContractCase = {
  name: 'removal acceptance excludes a foreign source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'composer_repository');
    await seed(
      `UPDATE source SET last_refusal_at = '${refusal.at}', last_refusal_absent = 9,
        last_refusal_listed = 1, last_refusal_successful = 1 WHERE id = 'S'`,
    );
    await context.executor.batch([
      context.mutate(acceptRemovalStatement(own, { sourceId: 'S', refusal })),
    ]);
    expect(
      await context.executor.all({
        sql: "SELECT removal_accepted FROM source WHERE id = 'S'",
        params: [],
      }),
    ).toEqual([{ removal_accepted: 0 }]);
  },
};

const cases = [foreignSource];
export const entries: readonly MutationEntry[] = [
  {
    builder: 'acceptRemovalStatement',
    file: 'repositories/source-removal.ts',
    cases,
    predicates: [
      {
        name: 'the armed source belongs to the organization',
        locate: /(?<=WHERE )org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
    ],
  },
];
