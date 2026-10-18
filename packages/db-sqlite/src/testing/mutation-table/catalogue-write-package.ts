import { leaseCase } from './lease-cases.js';
import { type MutationEntry } from './harness.js';
import { monotonicDecisions, writeTimeCase } from './catalogue-time-cases.js';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'packageUpsertStatements',
    file: 'repositories/catalogue-write-package.ts',
    cases: [],
    predicates: [],
    sqlDecisions: [
      ...monotonicDecisions('upsert'),
      {
        name: 'a description change advances the package revision exactly once',
        pattern: /package.rev \+ 1/,
        replacement: 'package.rev + 2',
        expected: 1,
        case: writeTimeCase('upsert', 'future'),
      },
      {
        name: 'unchanged descriptions preserve the package clock',
        pattern: /package.description is not \?/,
        replacement: '(? is null or 1 = 1)',
        expected: 1,
        case: writeTimeCase('upsert', 'unchanged'),
      },
    ],
  },
  {
    builder: 'createCatalogueWriteGuard',
    file: 'repositories/catalogue-write-package.ts',
    cases: [leaseCase('job', true)],
    predicates: [
      {
        name: 'live lease belongs to the organization',
        locate: /job.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: leaseCase('job', true).name,
      },
    ],
  },
];
