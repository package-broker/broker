import { expect } from 'vitest';
import { projectSourceIdsStatement } from '../../repositories/project-source-read.js';
import { NOT_NULL, seedProject, seedSource } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function foreignCase(
  name: string,
  attachmentOrg: 'own' | 'foreign',
  sourceOrg: 'own' | 'foreign',
): ContractCase {
  return {
    name,
    async run(context) {
      const seed = seeder(context.executor);
      const orgs = orgOf(context);
      await seedProject(seed, 'P-ATT', orgs.own.orgId);
      await seedSource(seed, 'S-ATT', orgs[sourceOrg].orgId, 'composer_repository');
      await seed.forged(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        orgs[attachmentOrg].orgId,
        'P-ATT',
        'S-ATT',
      );
      expect(
        await context.executor.all(context.mutate(projectSourceIdsStatement(orgs.own, 'P-ATT'))),
      ).toEqual([]);
    },
  };
}

const foreignAttachment = foreignCase(
  'an attachment row of another organization is not returned',
  'foreign',
  'own',
);
const foreignSource = foreignCase(
  'an attached source of another organization is not returned',
  'own',
  'foreign',
);

export const entries: readonly MutationEntry[] = [
  {
    builder: 'projectSourceIdsStatement',
    file: 'repositories/project-source-read.ts',
    cases: [foreignAttachment, foreignSource],
    predicates: [
      {
        name: 'attachment belongs to the organization',
        locate: /"ps"\."org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: foreignAttachment.name,
      },
      {
        name: 'source belongs to the organization',
        locate: /"s"\."org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: foreignSource.name,
      },
    ],
  },
];
