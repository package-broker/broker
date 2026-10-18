import { expect } from 'vitest';
import { attachedProxyStatement } from '../../repositories/source.js';
import { seedProject, seedSource, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const excludesForeign: ContractCase = {
  name: 'proxy attachment reads exclude foreign organizations',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedProject(seed, 'P-FOREIGN-PROXY', foreign.orgId);
    await seedSource(seed, 'S-FOREIGN-PROXY', foreign.orgId, 'npmjs_proxy', 'npm');
    await seed(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      foreign.orgId,
      'P-FOREIGN-PROXY',
      'S-FOREIGN-PROXY',
    );
    expect(
      await context.executor.all(
        context.mutate(attachedProxyStatement(own, 'P-FOREIGN-PROXY', 'npm')),
      ),
    ).toEqual([]);
  },
};

const attachment: ContractCase = {
  name: 'only an attached proxy of the requested ecosystem satisfies the read',
  async run(context) {
    const seed = seeder(context.executor);
    const { own } = orgOf(context);
    await seedProject(seed, 'P-PROXY', own.orgId);
    await seedSource(seed, 'S-PROXY', own.orgId, 'npmjs_proxy', 'npm');
    const read = (ecosystem: 'npm' | 'composer') =>
      context.executor.all(context.mutate(attachedProxyStatement(own, 'P-PROXY', ecosystem)));
    expect(await read('npm')).toEqual([]);
    await seed(
      'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
      own.orgId,
      'P-PROXY',
      'S-PROXY',
    );
    expect(await read('npm')).toHaveLength(1);
    expect(await read('composer')).toEqual([]);
    await seed("UPDATE source SET type = 'npm_registry' WHERE id = ?", 'S-PROXY');
    expect(await read('npm')).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'attachedProxyStatement',
    file: 'repositories/source.ts',
    cases: [excludesForeign, attachment],
    predicates: [
      {
        name: 'attachment belongs to the organization',
        locate: /"project_source"\."org_id" = \?/,
        copies: 1,
        neutral: NOT_NULL,
        caseName: excludesForeign.name,
      },
    ],
    waivers: [
      {
        locate: /"source"\."org_id" = "project_source"\."org_id"/,
        reason: 'source and attachment must belong to the same scoped organization',
      },
    ],
  },
];
