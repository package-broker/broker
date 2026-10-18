import type { MutationEntry } from './harness.js';
import { leaseCase } from './lease-cases.js';
export const entries: readonly MutationEntry[] = [
  {
    builder: 'jobLeaseGuard',
    file: 'repositories/job-lease-guard.ts',
    cases: [leaseCase('job', false)],
    predicates: [
      {
        name: 'live lease belongs to the organization',
        locate: /job.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: leaseCase('job', false).name,
      },
    ],
  },
];
