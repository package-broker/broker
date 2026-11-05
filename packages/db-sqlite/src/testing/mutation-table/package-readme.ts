import { expect } from 'vitest';
import { createPackageReadmeReader } from '../../repositories/package-readme.js';
import { executing } from './factory-cases.js';
import { seedSource, seedPackage, seedVersion, seedProject, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const isolation: ContractCase = {
  name: 'readme refuses foreign content attached to an own version',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'hosted', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seedVersion(seed, 'V', own.orgId, 'K', '1.0.0');
    await seed(
      "INSERT INTO project_source (org_id,project_id,source_id) VALUES (?,'P','S')",
      own.orgId,
    );
    await seed(
      "INSERT INTO project_package (org_id,project_id,package_id,ecosystem,name,origin) VALUES (?,'P','K','npm','widget','subscription')",
      own.orgId,
    );
    await seed(
      "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,'K','latest','V')",
      own.orgId,
    );
    await seed.forged(
      "INSERT INTO version_readme (org_id,version_id,filename,body) VALUES (?,'V','README.md','foreign content')",
      foreign.orgId,
    );
    expect(
      await createPackageReadmeReader(executing(context)).get(own, {
        projectId: 'P',
        ecosystem: 'npm',
        key: 'widget',
      }),
    ).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/package-readme.ts',
    builder: 'createPackageReadmeReader',
    cases: [isolation],
    predicates: [
      {
        name: 'readme content belongs to organization',
        locate: /r\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: isolation.name,
      },
    ],
    waivers: [
      {
        locate: /"(?:pp|pkg|src|ps|guard_\w+)"\."org_id" = |(?:dt|v)\.org_id = \?/,
        reason:
          'visibleWinner delegates its independently mutation-tested package, source, attachment and project guards. The tag and version join repeat the own winner identity; the readme content scope is isolated here with a forged cross-organization row.',
      },
    ],
  },
];
