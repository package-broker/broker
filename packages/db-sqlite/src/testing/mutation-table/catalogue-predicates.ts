import type { MutationEntry } from './harness.js';
import { orgOf, seeder, type CaseContext, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { compile, db } from '../../kysely.js';
import {
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
} from '../../repositories/catalogue-predicates.js';
import { seedSource, seedPackage, seedProject, ref, ALWAYS, NOT_NULL } from './fixtures.js';

async function ids(context: CaseContext, query: Parameters<typeof compile>[0]): Promise<string[]> {
  const rows = await context.executor.all<{ id: string }>(context.mutate(compile(query)));
  return rows.map((row) => row.id).sort();
}

const packageRows = () =>
  db
    .selectFrom('package as pkg')
    .innerJoin('source as src', 'src.id', 'pkg.source_id')
    .select('pkg.id');

const proxyShadowedByForeignPackage: ContractCase = {
  name: 'a same-named package of another organization does not shadow a proxy package',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-PROXY', own.orgId, 'packagist_proxy');
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seedPackage(seed, 'K-FOREIGN', foreign.orgId, 'S-FOREIGN', 'acme/a');
    expect(
      await ids(
        context,
        packageRows()
          .where('pkg.org_id', '=', own.orgId)
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    ).toEqual(['K-PROXY']);
  },
};

const proxyBlockedByForeignName: ContractCase = {
  name: 'a registered name of another organization does not block a proxy package',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-PROXY', own.orgId, 'packagist_proxy');
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seed(
      'INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, ?, ?)',
      'R-FOREIGN',
      foreign.orgId,
      'S-FOREIGN',
      'composer',
      'acme/*',
    );
    expect(
      await ids(
        context,
        packageRows()
          .where('pkg.org_id', '=', own.orgId)
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    ).toEqual(['K-PROXY']);
  },
};

function attachedCase(mismatched: 'attachment' | 'source' | 'project'): ContractCase {
  return {
    name: `an attachment whose ${mismatched} belongs to another organization is not attached`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedProject(seed, 'P1', mismatched === 'project' ? foreign.orgId : own.orgId);
      await seedSource(seed, 'S1', mismatched === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await seed(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        mismatched === 'attachment' ? foreign.orgId : own.orgId,
        'P1',
        'S1',
      );
      const rows = db
        .selectFrom('project_source as x')
        .innerJoin('source as sx', 'sx.id', 'x.source_id')
        .select('x.source_id as id')
        .where(
          attachedSourceCondition(
            own,
            col('x.project_id'),
            col('x.source_id'),
            col('sx.ecosystem'),
          ),
        );
      expect(await ids(context, rows)).toEqual([]);
    },
  };
}

const readTimeForeignProject: ContractCase = {
  name: 'a project of another organization does not make a package readable',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    await seedSource(seed, 'S1', own.orgId, 'vcs');
    await seedPackage(seed, 'K1', own.orgId, 'S1', 'acme/a');
    expect(
      await ids(
        context,
        packageRows().where(
          readTimeCondition(own, sql`${'P-FOREIGN'}`, { package: 'pkg', source: 'src' }),
        ),
      ),
    ).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'proxyEligibleCondition',
    file: 'repositories/catalogue-predicates.ts',
    waivers: [
      {
        locate: ref('pkg', 'org_id', '\\?'),
        reason: 'restricts the rows of the test query, not part of the builder',
      },
    ],
    cases: [proxyShadowedByForeignPackage, proxyBlockedByForeignName],
    predicates: [
      {
        name: 'proxy shadow check is scoped to the package organization',
        locate: ref('guard_q', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyShadowedByForeignPackage.name,
      },
      {
        name: 'registered name check is scoped to the package organization',
        locate: ref('guard_r', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyBlockedByForeignName.name,
      },
    ],
  },
  {
    builder: 'attachedSourceCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: [attachedCase('attachment'), attachedCase('source'), attachedCase('project')],
    predicates: [
      {
        name: 'attachment row is scoped to the organization',
        locate: ref('guard_ps', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('attachment').name,
      },
      {
        name: 'source row is scoped to the organization',
        locate: ref('guard_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('source').name,
      },
      {
        name: 'project row is scoped to the organization',
        locate: ref('guard_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase('project').name,
      },
    ],
  },
  {
    builder: 'readTimeCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: [readTimeForeignProject],
    predicates: [
      {
        name: 'project row is scoped to the organization',
        locate: ref('guard_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: readTimeForeignProject.name,
      },
    ],
  },
];
