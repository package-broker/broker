import type { MutationEntry } from './harness.js';
import { orgOf, seeder, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import { dueStatement, findByRepositoryStatement } from '../../repositories/source.js';
import { seedSource, NOT_NULL } from './fixtures.js';

const dueSparesForeignSources: ContractCase = {
  name: 'the due source list excludes sources of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    for (const [id, orgId] of [
      ['S-OWN', own.orgId],
      ['S-FOREIGN', foreign.orgId],
    ] as const) {
      await seedSource(seed, id, orgId, 'vcs');
      await seed('UPDATE source SET next_poll_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', id);
    }
    const rows = await context.executor.all<{ id: string }>(context.mutate(dueStatement(own, 10)));
    expect(rows.map((row) => row.id)).toEqual(['S-OWN']);
  },
};

const repositorySparesForeignSources: ContractCase = {
  name: 'repository lookup excludes a matching source of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seed(
      'UPDATE source SET config_json = ? WHERE id = ?',
      JSON.stringify({ provider: 'github', repository: 'Acme/Widget' }),
      'S-FOREIGN',
    );
    const rows = await context.executor.all(
      context.mutate(
        findByRepositoryStatement(own, { provider: 'github', repository: 'acme/widget' }),
      ),
    );
    expect(rows).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'findByRepositoryStatement',
    file: 'repositories/source.ts',
    cases: [repositorySparesForeignSources],
    predicates: [
      {
        name: 'repository lookup is scoped to the organization',
        locate: /(?<=from "source" where )"org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: repositorySparesForeignSources.name,
      },
    ],
  },
  {
    builder: 'dueStatement',
    file: 'repositories/source.ts',
    cases: [dueSparesForeignSources],
    predicates: [
      {
        name: 'source rows are scoped to the organization',
        locate: /(?<=from "source" where )"org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: dueSparesForeignSources.name,
      },
    ],
  },
];
