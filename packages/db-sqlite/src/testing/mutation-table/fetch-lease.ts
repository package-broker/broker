import type { MutationEntry } from './harness.js';
import { leaseCase } from './lease-cases.js';
export const entries: readonly MutationEntry[] = [
  {
    builder: 'fetchLeaseGuard',
    file: 'repositories/fetch-lease.ts',
    cases: [leaseCase('fetch', false)],
    predicates: [
      {
        name: 'live lease belongs to the organization',
        locate: /fetch_lease.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: leaseCase('fetch', false).name,
      },
    ],
  },
  {
    builder: 'createFetchLeaseWriteGuard',
    file: 'repositories/fetch-lease.ts',
    cases: [leaseCase('fetch', true)],
    predicates: [
      {
        name: 'live lease belongs to the organization',
        locate: /fetch_lease.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: leaseCase('fetch', true).name,
      },
    ],
  },
];
