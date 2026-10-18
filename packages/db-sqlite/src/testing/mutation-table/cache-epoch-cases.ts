import { expect } from 'vitest';
import { sql } from 'kysely';
import { assertGuard, cacheEpochBumpStatements } from '../../kysely.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';

export function epochEntry(file: string, builder: string): MutationEntry {
  const contractCase: ContractCase = {
    name: `${file} ${builder} advances only the owning organization's epoch`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const read = () =>
        context.executor.all<{ org_id: string; version: string }>({
          sql: 'SELECT org_id, version FROM cache_epoch ORDER BY org_id',
          params: [],
        });
      const before = await read();
      const statements =
        builder === 'assertGuard'
          ? assertGuard(sql<boolean>`1`, own)
          : cacheEpochBumpStatements(own);
      await expect(context.executor.batch(context.mutateBatch(statements))).resolves.toHaveLength(
        statements.length,
      );
      const after = await read();
      expect(after.find(({ org_id }) => org_id === own.orgId)?.version).not.toBe(
        before.find(({ org_id }) => org_id === own.orgId)?.version,
      );
      expect(after.find(({ org_id }) => org_id === foreign.orgId)).toEqual(
        before.find(({ org_id }) => org_id === foreign.orgId),
      );
    },
  };
  return {
    builder,
    file,
    cases: [contractCase],
    predicates: [
      {
        name: 'the epoch update targets one organization',
        locate: /"org_id" = \?/,
        neutral: '(? is not null)',
        copies: 1,
        caseName: contractCase.name,
      },
    ],
  };
}
