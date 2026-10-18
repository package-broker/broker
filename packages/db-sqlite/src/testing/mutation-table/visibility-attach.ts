import { expect } from 'vitest';
import { attachSourceStatements } from '../../repositories/visibility-attach.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedProject, seedSource } from './fixtures.js';

function attachCase(layer: 'source' | 'project'): ContractCase {
  return {
    name: `attachSourceStatements rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', layer === 'project' ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S', layer === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await context.executor.batch(context.mutateBatch(attachSourceStatements(own, 'P')));
      expect(
        await context.executor.all({
          sql: "SELECT source_id FROM project_source WHERE project_id = 'P'",
          params: [],
        }),
      ).toEqual([]);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/visibility-attach.ts',
    builder: 'attachSourceStatements',
    cases: [attachCase('source'), attachCase('project')],
    predicates: [
      {
        name: 'source belongs to the organization',
        locate: /(?<![\w".])"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: attachCase('source').name,
      },
      {
        name: 'new project belongs to the organization',
        locate: /new_project.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: attachCase('project').name,
      },
    ],
    waivers: [
      {
        locate:
          /"(?:project_package|stay_package|derive_attachment|derive_package|guard_ps|guard_s|guard_p)"\."org_id" = \?/,
        reason:
          'the final three statements are returned unchanged by rederiveStatements, whose remove, retag, stay and insert predicates are registered in visibility-derive.ts and whose attachment guards are registered in catalogue-predicates.ts',
      },
    ],
  },
];
