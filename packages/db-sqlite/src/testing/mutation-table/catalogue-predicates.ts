import type { MutationEntry } from './harness.js';
import { orgOf, seeder, type CaseContext, type ContractCase } from './harness.js';
import { expect } from 'vitest';
import { sql, type SqlBool } from 'kysely';
import { compile, db } from '../../kysely.js';
import {
  admissionCondition,
  attachedSourceCondition,
  col,
  proxyEligibleCondition,
  readTimeCondition,
  visibleRowsCondition,
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
    await seedSource(seed, 'S-FOREIGN', own.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seedPackage(seed.forged, 'K-FOREIGN', foreign.orgId, 'S-FOREIGN', 'acme/a');
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

const proxyShadowedByForeignSource: ContractCase = {
  name: 'a competing package with a foreign organization source does not shadow a proxy',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedSource(seed, 'S-PROXY', own.orgId, 'packagist_proxy');
    await seedSource(seed, 'S-FOREIGN', foreign.orgId, 'vcs');
    await seedPackage(seed, 'K-PROXY', own.orgId, 'S-PROXY', 'acme/a');
    await seedPackage(seed.forged, 'K-ODD', own.orgId, 'S-FOREIGN', 'acme/a');
    expect(
      await ids(
        context,
        packageRows()
          .where('pkg.id', '=', 'K-PROXY')
          .where(proxyEligibleCondition({ package: 'pkg', source: 'src' })),
      ),
    ).toEqual(['K-PROXY']);
  },
};

const admissionAliases = ['bad', 'ci', 'cx', 'i', 'im', 'x'] as const;

function admissionCase(alias: (typeof admissionAliases)[number]): ContractCase {
  return {
    name: `foreign pattern rows do not affect admission through ${alias}`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedProject(seed, 'P1', own.orgId);
      await seedSource(seed, 'S1', own.orgId, 'vcs');
      await seedPackage(seed, 'K1', own.orgId, 'S1', 'acme/a');
      const pattern = async (id: string, orgId: string, text: string, effect: string) => {
        await seed.forged(
          'INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          orgId,
          'P1',
          'S1',
          text,
          effect,
        );
      };
      if (alias === 'im') await pattern('OWN', own.orgId, 'zzz/*', 'include');
      const count = alias === 'ci' || alias === 'cx' ? 65 : 1;
      for (let index = 0; index < count; index += 1) {
        const text =
          alias === 'bad'
            ? 'acme/?'
            : alias === 'i'
              ? 'zzz/*'
              : alias === 'im' || alias === 'x'
                ? 'acme/*'
                : `zzz/${String(index)}`;
        await pattern(
          `FOREIGN-${String(index)}`,
          foreign.orgId,
          text,
          alias === 'cx' || alias === 'x' || alias === 'bad' ? 'exclude' : 'include',
        );
      }
      expect(
        await ids(
          context,
          db
            .selectFrom('package as pkg')
            .select('pkg.id')
            .where(
              admissionCondition(
                own,
                sql.lit('P1'),
                col('pkg.source_id'),
                col('pkg.name'),
                col('pkg.visible_to_new_projects'),
              ),
            ),
        ),
      ).toEqual(alias === 'im' ? [] : ['K1']);
    },
  };
}

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
      await seed.forged(
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

function visibleRowsCase(mismatched: 'pp' | 'pkg' | 'src' | 'ps'): ContractCase {
  return {
    name: `visible rows reject a foreign ${mismatched} row`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedProject(seed, 'P1', own.orgId);
      await seedSource(seed, 'S-GUARD', own.orgId, 'vcs');
      await seedSource(seed, 'S-OUTER', mismatched === 'src' ? foreign.orgId : own.orgId, 'vcs');
      await seedPackage(
        seed.forged,
        'K1',
        mismatched === 'pkg' ? foreign.orgId : own.orgId,
        'S-GUARD',
        'acme/a',
      );
      await seed(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        own.orgId,
        'P1',
        'S-GUARD',
      );
      await seed.forged(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        mismatched === 'ps' ? foreign.orgId : own.orgId,
        'P1',
        'S-OUTER',
      );
      await seed.forged(
        "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
        mismatched === 'pp' ? foreign.orgId : own.orgId,
        'P1',
        'K1',
      );
      const rows = db
        .selectFrom('project_package as pp')
        .innerJoin('package as pkg', 'pkg.id', 'pp.package_id')
        .innerJoin('source as src', (join) => join.on('src.id', '=', 'S-OUTER'))
        .innerJoin('project_source as ps', (join) => join.onRef('ps.source_id', '=', 'src.id'))
        .select('pkg.id')
        .where(
          sql<SqlBool>`${visibleRowsCondition(own, { pp: 'pp', pkg: 'pkg', src: 'src', ps: 'ps' })}`,
        );
      expect(await ids(context, rows)).toEqual([]);
    },
  };
}

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
    cases: [proxyShadowedByForeignPackage, proxyShadowedByForeignSource, proxyBlockedByForeignName],
    predicates: [
      {
        name: 'proxy shadow check is scoped to the package organization',
        locate: ref('guard_q', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyShadowedByForeignPackage.name,
      },
      {
        name: 'competing source is scoped to the package organization',
        locate: ref('guard_qs', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        copies: 1,
        caseName: proxyShadowedByForeignSource.name,
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
    builder: 'admissionCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: admissionAliases.map(admissionCase),
    predicates: admissionAliases.map((alias) => ({
      name: `${alias} pattern rows are scoped to the organization`,
      locate: ref(`guard_${alias}`, 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: admissionCase(alias).name,
    })),
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
  {
    builder: 'visibleRowsCondition',
    file: 'repositories/catalogue-predicates.ts',
    cases: [
      ...(['pp', 'pkg', 'src', 'ps'] as const).map(visibleRowsCase),
      attachedCase('attachment'),
      attachedCase('source'),
      attachedCase('project'),
      readTimeForeignProject,
      proxyShadowedByForeignPackage,
      proxyShadowedByForeignSource,
      proxyBlockedByForeignName,
    ],
    predicates: [
      ...(['pp', 'pkg', 'src', 'ps'] as const).map((alias) => ({
        name: `${alias} row is scoped to the organization`,
        locate: ref(alias, 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: visibleRowsCase(alias).name,
      })),
      ...(['attachment', 'source', 'project'] as const).map((kind, index) => ({
        name: `attached ${kind} row is scoped to the organization`,
        locate: ref(['guard_ps', 'guard_s', 'guard_p'][index]!, 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: attachedCase(kind).name,
      })),
      {
        name: 'read-time project row is scoped to the organization',
        locate: ref('guard_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: readTimeForeignProject.name,
      },
      {
        name: 'proxy shadow check is scoped to the package organization',
        locate: ref('guard_q', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyShadowedByForeignPackage.name,
      },
      {
        name: 'competing source is scoped to the package organization',
        locate: ref('guard_qs', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        copies: 1,
        caseName: proxyShadowedByForeignSource.name,
      },
      {
        name: 'registered name check is scoped to the package organization',
        locate: ref('guard_r', 'org_id', '"pkg"\\."org_id"'),
        neutral: ALWAYS,
        caseName: proxyBlockedByForeignName.name,
      },
    ],
  },
];
