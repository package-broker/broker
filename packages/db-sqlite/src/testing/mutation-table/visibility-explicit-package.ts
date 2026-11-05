import { expect } from 'vitest';
import { explicitPackageStatement } from '../../repositories/visibility-subset.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedProject, seedSource, seedPackage } from './fixtures.js';
const foreignPackage: ContractCase = {
  name: 'explicit membership writer excludes a foreign package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seedPackage(seed.forged, 'K', foreign.orgId, 'S', 'widget', 'npm');
    await context.executor.batch(context.mutateBatch([explicitPackageStatement(own, 'P', 'K')]));
    expect(
      await context.executor.all({ sql: 'SELECT package_id FROM project_package', params: [] }),
    ).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/visibility-subset.ts',
    builder: 'explicitPackageStatement',
    cases: [foreignPackage],
    predicates: [
      {
        name: 'package belongs to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackage.name,
      },
    ],
  },
];
