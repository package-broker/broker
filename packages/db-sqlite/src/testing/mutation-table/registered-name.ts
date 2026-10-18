import type { MutationEntry } from './harness.js';
import { orgOf, seeder, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { compile, db } from '../../kysely.js';
import { coveredByRegisteredNames, sourceActivatable } from '../../repositories/registered-name.js';
import { seedSource, ref, NOT_NULL, ALWAYS } from './fixtures.js';

const coveredByForeignName: ContractCase = {
  name: 'a registered name of another organization does not cover a key',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S1', own.orgId, 'vcs');
    await seed(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      'R-FOREIGN',
      foreign.orgId,
      'S1',
      'composer',
      'acme/*',
    );
    const rows = await context.executor.all<{ held: number }>(
      context.mutate(
        compile(
          db.selectNoFrom(
            sql<number>`(${coveredByRegisteredNames(own, 'S1' as never, 'acme/a')})`.as('held'),
          ),
        ),
      ) as never,
    );
    expect(rows[0]?.held).toBe(0);
  },
};

function activatableCase(foreignRow: 'source' | 'name'): ContractCase {
  return {
    name: `a ${foreignRow} of another organization does not make a source activatable`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedSource(seed, 'S1', foreignRow === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await seed(
        'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
        'R1',
        foreign.orgId,
        'S1',
        'composer',
        'acme/*',
      );
      const rows = await context.executor.all<{ held: number }>(
        context.mutate(
          compile(
            db.selectNoFrom(sql<number>`(${sourceActivatable(own, 'S1' as never)})`.as('held')),
          ),
        ) as never,
      );
      expect(rows[0]?.held).toBe(0);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'coveredByRegisteredNames',
    file: 'repositories/registered-name.ts',
    cases: [coveredByForeignName],
    predicates: [
      {
        name: 'registered name row is scoped to the organization',
        locate: ref('rn_cov', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: coveredByForeignName.name,
      },
    ],
  },
  {
    builder: 'sourceActivatable',
    file: 'repositories/registered-name.ts',
    waivers: [
      {
        locate: ref('rn_act_c', 'org_id', 'rn_act_s\\.org_id'),
        reason: 'scope completeness of npm registries; no case yet reaches it',
      },
    ],
    cases: [activatableCase('source'), activatableCase('name')],
    predicates: [
      {
        name: 'source row is scoped to the organization',
        locate: ref('rn_act_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: activatableCase('source').name,
      },
      {
        name: 'registered name rows match the source organization',
        locate: ref('rn_act_r', 'org_id', 'rn_act_s\\.org_id'),
        neutral: ALWAYS,
        caseName: activatableCase('name').name,
      },
    ],
  },
];
