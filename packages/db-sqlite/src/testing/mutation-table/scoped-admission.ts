import { expect } from 'vitest';
import { createScopedAdmission } from '../../repositories/scoped-admission.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { seedProject, seedSource } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignName: ContractCase = {
  name: 'scoped admission ignores a foreign registered name child of an own source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
    await seed('UPDATE source SET config_json = \'{"scopes":["@acme"]}\' WHERE id = \'S\'');
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      own.orgId,
    );
    await seed(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'npm', '@acme/*')",
      foreign.orgId,
    );
    expect(
      await createScopedAdmission(executing(context)).admitScoped(own, {
        projectId: 'P',
        key: '@acme/widget',
      }),
    ).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('scoped-admission', 'createScopedAdmission', foreignName, /rn\.org_id = \?/, [
    {
      locate: /"(?:guard_\w+|prj)"\."org_id" = \?/,
      reason:
        'The own project and attachment are controls; delegated attachedSourceCondition and admissionCondition predicates are independently registered in catalogue-predicates.ts.',
    },
    {
      locate: /pkg\.org_id = \?/,
      reason: 'The package exclusion contains no package rows in this registered-name case.',
    },
  ]),
];
