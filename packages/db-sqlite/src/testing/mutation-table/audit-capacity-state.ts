import { expect } from 'vitest';
import { auditCapacityStateStatement } from '../../repositories/audit-capacity-state.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

const isolated: ContractCase = {
  name: 'capacity warning updates only the organization at the warning threshold',
  async run(context) {
    const { own, foreign } = orgOf(context);
    for (const org of [own, foreign])
      await context.executor.batch([
        {
          sql: 'UPDATE audit_chain SET journal_bytes = 80 WHERE org_id = ?',
          params: [org.orgId],
        },
      ]);
    await context.executor.batch(context.mutateBatch([auditCapacityStateStatement(own, 100)]));
    for (const [org, expected] of [
      [own, 'warning'],
      [foreign, 'ok'],
    ] as const) {
      expect(
        await context.executor.all({
          sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ capacity_state: expected }]);
    }
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'auditCapacityStateStatement',
    file: 'repositories/audit-capacity-state.ts',
    cases: [isolated],
    predicates: [
      {
        name: 'capacity state updates only the organization',
        locate: /org_id = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: isolated.name,
      },
    ],
  },
];
