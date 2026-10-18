import type { MutationEntry } from './harness.js';
import { orgOf, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import { epochReadStatement } from '../../repositories/cache-epoch.js';
import { ref, NOT_NULL } from './fixtures.js';

const epochReadSparesForeign: ContractCase = {
  name: 'an epoch read returns only the version of the organization',
  async run(context) {
    const { own } = orgOf(context);
    const rows = await context.executor.all(context.mutate(epochReadStatement(own)));
    expect(rows).toHaveLength(1);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'epochReadStatement',
    file: 'repositories/cache-epoch.ts',
    cases: [epochReadSparesForeign],
    predicates: [
      {
        name: 'epoch rows are scoped to the organization',
        locate: ref('cache_epoch', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: epochReadSparesForeign.name,
      },
    ],
  },
];
