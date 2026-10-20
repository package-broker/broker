import { expect } from 'vitest';
import { packageIdStatement } from '../../repositories/package-id.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL, ref, seedPackage, seedSource } from './fixtures.js';

type Org = 'own' | 'foreign';

function packageIdCase(name: string, rows: { source: Org; pkg: Org }): ContractCase {
  return {
    name,
    async run(context: CaseContext) {
      const seed = seeder(context.executor);
      const orgs = orgOf(context);
      await seedSource(seed, 'S1', orgs[rows.source].orgId, 'vcs');
      await seedPackage(seed, 'K1', orgs[rows.pkg].orgId, 'S1', 'acme/a');
      const result = await context.executor.all(
        context.mutate(packageIdStatement(orgs.own, 'S1', 'acme/a')),
      );
      expect(result).toEqual([]);
    },
  };
}

const foreignPackage = packageIdCase('a package of another organization is not returned', {
  source: 'own',
  pkg: 'foreign',
});
const foreignSource = packageIdCase('a source of another organization is not consulted', {
  source: 'foreign',
  pkg: 'own',
});

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/package-id.ts',
    builder: 'packageIdStatement',
    cases: [foreignPackage, foreignSource],
    predicates: [
      {
        name: 'package is scoped to the organization',
        locate: ref('pi_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackage.name,
      },
      {
        name: 'source is scoped to the organization',
        locate: ref('pi_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
    ],
  },
];
