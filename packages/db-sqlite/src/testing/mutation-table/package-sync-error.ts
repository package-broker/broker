import { expect } from 'vitest';
import { packageSyncErrorStatements } from '../../repositories/source.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, NOT_NULL } from './fixtures.js';

const foreignError: ContractCase = {
  name: 'a child error cannot change a foreign job with the same lease fields',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence) VALUES ('child', ?, 'core:package-sync:v1', 'running', 'worker', ?, 1)",
      foreign.orgId,
      FUTURE,
    );
    await context.executor.batch(
      context.mutateBatch(
        packageSyncErrorStatements(own, { id: 'child', owner: 'worker', fence: 1 }, 'rate_limited'),
      ),
    );
    expect(
      await context.executor.all({
        sql: 'SELECT sync_error FROM job WHERE org_id = ? AND id = ?',
        params: [foreign.orgId, 'child'],
      }),
    ).toEqual([{ sync_error: null }]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/source.ts',
    builder: 'packageSyncErrorStatements',
    cases: [foreignError],
    predicates: [
      {
        name: 'child job belongs to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignError.name,
      },
    ],
  },
];
