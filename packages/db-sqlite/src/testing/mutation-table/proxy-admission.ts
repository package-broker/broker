import { expect } from 'vitest';
import { sql } from 'kysely';
import { compile } from '../../kysely.js';
import { admittedProxySources } from '../../repositories/proxy-admission.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedProject, seedSource } from './fixtures.js';

const foreignKey: ContractCase = {
  name: 'admittedProxySources rejects a key of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'packagist_proxy');
    await seed(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      own.orgId,
    );
    const key = sql`(select ${foreign.orgId} as org_id, 'composer' as ecosystem, 'acme/a' as name)`;
    const query = admittedProxySources(own, 'P', 'composer', 'k').innerJoin(key.as('k'), (join) =>
      join.onTrue(),
    );
    expect(await context.executor.all(context.mutate(compile(query)))).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/proxy-admission.ts',
    builder: 'admittedProxySources',
    cases: [foreignKey],
    predicates: [
      {
        name: 'key belongs to the organization',
        locate: ref('k', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignKey.name,
      },
    ],
    waivers: [
      {
        locate: /"guard_(?:bad|ci|cx|i|im|x)"\."org_id" = \?/,
        reason:
          'delegated admissionCondition predicates; all six pattern aliases have independent foreign-pattern mutants in catalogue-predicates.ts',
      },
      {
        locate: /"guard_(?:ps|src|prj)"\."org_id" = \?/,
        reason:
          'outer joins select the same unique attachment, source id and project id checked again by attachedSourceCondition; either copy alone is redundant',
      },
      {
        locate: /"guard_(?:ps_2|s_2|p_2)"\."org_id" = \?/,
        reason:
          'attachedSourceCondition uses the same unique attachment/project/source as the outer joins; helper predicate mutants are independently killed in catalogue-predicates.ts',
      },
      {
        locate: /"guard_(?:q|qs|r)"\."org_id" = "k"\."org_id"/,
        reason:
          'delegated proxyEligibleCondition, whose foreign package, competing-source and registered-name mutants are registered in catalogue-predicates.ts',
      },
    ],
  },
];
