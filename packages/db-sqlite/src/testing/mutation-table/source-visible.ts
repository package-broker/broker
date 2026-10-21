import { expect } from 'vitest';
import { getVisibleSourceStatement } from '../../repositories/source.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedProject, seedSource } from './fixtures.js';

const foreignSource: ContractCase = {
  name: 'source visibility lookups exclude foreign organization sources',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'FOREIGN', foreign.orgId, 'vcs');
    await seed.forged("UPDATE source SET project_id = 'P' WHERE id = 'FOREIGN'");
    expect(
      await context.executor.all(
        context.mutate(
          getVisibleSourceStatement(own, {
            projectId: 'P',
            sourceId: 'FOREIGN',
          }),
        ),
      ),
    ).toEqual([]);
  },
};

const foreignProject: ContractCase = {
  name: 'source visibility lookups exclude a foreign project referenced by an own source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', foreign.orgId);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged("UPDATE source SET project_id = 'P' WHERE id = 'S'");
    expect(
      await context.executor.all(
        context.mutate(
          getVisibleSourceStatement(own, {
            projectId: 'P',
            sourceId: 'S',
          }),
        ),
      ),
    ).toEqual([]);
  },
};

const foreignAttachment: ContractCase = {
  name: 'source visibility lookups exclude a foreign attachment referencing own rows',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      foreign.orgId,
    );
    expect(
      await context.executor.all(
        context.mutate(
          getVisibleSourceStatement(own, {
            projectId: 'P',
            sourceId: 'S',
          }),
        ),
      ),
    ).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'getVisibleSourceStatement',
    file: 'repositories/source.ts',
    cases: [foreignSource, foreignProject, foreignAttachment],
    predicates: [
      {
        name: 'visible source rows belong to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
      {
        name: 'the visible project belongs to the organization',
        locate: /visible_project\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignProject.name,
      },
      {
        name: 'attachments belong to the organization',
        locate: /attachment\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignAttachment.name,
      },
    ],
  },
];
