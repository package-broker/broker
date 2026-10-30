import { expect } from 'vitest';
import { fixedClock } from '@package-broker/core/ids';
import { createAuditTrailServices } from '../../repositories/api-services.js';
import { JOURNAL_TIME, seedAuditJournal } from '../audit-journal-fixture.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const isolation: ContractCase = {
  name: 'assembled trail reader remains bound to its organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedAuditJournal(context.executor, own, 1);
    await seedAuditJournal(context.executor, foreign, 2);
    const services = createAuditTrailServices(
      {
        ...context.executor,
        all: (statement) => context.executor.all(context.mutate(statement)),
      },
      own,
      { enqueue: async () => ({ id: 'job', created: false }), get: async () => null },
      fixedClock(JOURNAL_TIME),
    );
    const result = await services.journal.list({ projectId: null, limit: 200 }).catch(() => null);
    expect(result).not.toBeNull();
    expect(result!.items.map((row) => row.seq)).toEqual([1]);
    expect(result!.items[0]?.orgId).toBe(own.orgId);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createAuditTrailServices',
    file: 'repositories/api-services.ts',
    cases: [isolation],
    predicates: [
      {
        name: 'journal chain identity belongs to the event organization',
        locate: /chain\.org_id = event\.org_id/,
        neutral: '1 = 1',
        copies: 1,
        caseName: isolation.name,
      },
      {
        name: 'assembled trail journal scopes events by organization',
        locate: /event\.org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolation.name,
      },
    ],
  },
];
