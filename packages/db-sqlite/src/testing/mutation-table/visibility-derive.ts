import { expect } from 'vitest';
import { rederiveStatements } from '../../repositories/visibility-derive.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedPackage, seedProject, seedSource } from './fixtures.js';

function deriveCase(kind: 'remove' | 'retag' | 'stay' | 'insert'): ContractCase {
  return {
    name: `rederiveStatements scopes the ${kind} to its organization`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', own.orgId);
      await seedSource(seed, 'S', own.orgId, 'vcs');
      await seedPackage(
        seed,
        'K',
        kind === 'stay' || kind === 'insert' ? foreign.orgId : own.orgId,
        'S',
        'acme/a',
      );
      await seed(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        own.orgId,
      );
      if (kind === 'remove')
        await seed("UPDATE package SET visible_to_new_projects = 0 WHERE id = 'K'");
      if (kind === 'retag')
        await seed(
          "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('I', ?, 'P', 'S', 'acme/*', 'include')",
          own.orgId,
        );
      if (kind !== 'insert')
        await seed(
          "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, 'P', 'K', 'subscription')",
          kind === 'remove' || kind === 'retag' ? foreign.orgId : own.orgId,
        );
      await context.executor.batch(
        context.mutateBatch(rederiveStatements(own, { kind: 'project', projectId: 'P' })),
      );
      const rows = await context.executor.all({
        sql: "SELECT org_id, origin FROM project_package WHERE project_id = 'P'",
        params: [],
      });
      expect(rows).toEqual(
        kind === 'remove' || kind === 'retag'
          ? [{ org_id: foreign.orgId, origin: 'subscription' }]
          : [],
      );
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/visibility-derive.ts',
    builder: 'rederiveStatements',
    cases: (['remove', 'retag', 'stay', 'insert'] as const).map(deriveCase),
    predicates: [
      ...(['remove', 'retag'] as const).map((kind, index) => ({
        name: `${kind} row belongs to the organization`,
        locate: ref('project_package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 2,
        waivedCopies: {
          [1 - index]:
            `the other occurrence is stripped and killed by "${deriveCase(kind === 'remove' ? 'retag' : 'remove').name}"`,
        },
        caseName: deriveCase(kind).name,
      })),
      ...(['stay', 'insert'] as const).map((kind) => ({
        name: `${kind} package belongs to the organization`,
        locate: ref(kind === 'stay' ? 'stay_package' : 'derive_package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: deriveCase(kind).name,
      })),
    ],
    waivers: [
      {
        locate: /"derive_attachment"\."org_id" = \?/,
        reason:
          'same unique (project_id, source_id) row as guard_ps in attachedSourceCondition; both organization comparisons are redundant with each other',
      },
      {
        locate: /"guard_(?:ps|s|p)"\."org_id" = \?/,
        reason:
          'delegated attachedSourceCondition, registered with foreign attachment/source/project mutants in catalogue-predicates.ts; insert guard_ps also duplicates derive_attachment',
      },
    ],
  },
];
