import { expect } from 'vitest';
import { createRegisteredNameRepository } from '../../repositories/registered-name.js';
import { executing } from './factory-cases.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

function foreignProxy(part: 'source' | 'attachment'): ContractCase {
  return {
    name: `claim proxy reads ignore a foreign ${part}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'PROXY', part === 'source' ? foreign.orgId : own.orgId, 'npmjs_proxy');
      await seed(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('PR', ?, 'project', 'Project')",
        own.orgId,
      );
      await seed.forged(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        part === 'attachment' ? foreign.orgId : own.orgId,
        'PR',
        'PROXY',
      );
      expect(await createRegisteredNameRepository(executing(context)).claimProxy(own)).toBe(
        part === 'source' ? null : 'PROXY',
      );
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createRegisteredNameRepository',
    file: 'repositories/registered-name.ts',
    cases: [foreignProxy('source'), foreignProxy('attachment')],
    predicates: [
      {
        name: 'claim proxy source belongs to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignProxy('source').name,
      },
    ],
  },
];
