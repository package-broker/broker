import { expect } from 'vitest';
import { createProxyAdmission } from '../../repositories/proxy-admission.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { seedSource, seedProject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignShadow: ContractCase = {
  name: 'a foreign registered name child does not shadow an own proxy admission',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'npmjs_proxy', 'npm');
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      own.orgId,
    );
    await seed(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'npm', 'widget')",
      foreign.orgId,
    );
    expect(
      await createProxyAdmission(executing(context)).admitProxy(own, {
        projectId: 'P',
        ecosystem: 'npm',
        key: 'widget',
      }),
    ).toEqual(['S']);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'proxy-admission',
    'createProxyAdmission',
    foreignShadow,
    /"guard_r"\."org_id" = "k"\."org_id"/,
    [
      {
        locate: /"guard_(?!r"\.)\w+"\."org_id" = /,
        reason:
          'Delegated attachment, admission and package-shadow predicates have independent registrations in catalogue-predicates.ts and admittedProxySources.',
      },
      {
        locate: /"k"\."org_id" = \?/,
        reason:
          'The factory constructs k.org_id from the caller organization; admittedProxySources separately mutation-tests a supplied foreign key row.',
      },
    ],
    '(1 = 1)',
  ),
];
