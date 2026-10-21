import { expect } from 'vitest';
import { compile } from '../../kysely.js';
import { visibleWinner } from '../../repositories/catalogue-read.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedPackage, seedProject, seedSource } from './fixtures.js';

function foreignWinner(layer: 'membership' | 'package'): ContractCase {
  return {
    name: `visibleWinner rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedProject(seed, 'P', own.orgId);
      await seedSource(seed, 'S', own.orgId, 'vcs');
      await seedPackage(
        seed.forged,
        'K',
        layer === 'package' ? foreign.orgId : own.orgId,
        'S',
        'acme/a',
      );
      await seed(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
        own.orgId,
      );
      await seed.forged(
        "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, 'P' AS project_id, 'K' AS package_id, 'explicit' AS origin) AS input JOIN package AS p ON p.id = input.package_id WHERE 1",
        layer === 'membership' ? foreign.orgId : own.orgId,
      );
      expect(
        await context.executor.all(
          context.mutate(compile(visibleWinner(own, 'P', 'composer', 'acme/a'))),
        ),
      ).toEqual([]);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/catalogue-read.ts',
    builder: 'visibleWinner',
    cases: [foreignWinner('membership'), foreignWinner('package')],
    predicates: (['membership', 'package'] as const).map((layer) => ({
      name: `${layer} belongs to the organization`,
      locate: ref(layer === 'membership' ? 'pp' : 'pkg', 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: foreignWinner(layer).name,
    })),
    waivers: [
      {
        locate: /"(?:src|ps)"\."org_id" = \?/,
        reason:
          'redundant with attachedSourceCondition: src.id = pkg.source_id and ps is the same unique (project_id, source_id) row as guard_ps',
      },
      {
        locate: /"guard_(?:ps|s|p)"\."org_id" = \?/,
        reason:
          'delegated attachedSourceCondition and readTimeCondition predicates; their named foreign attachment/source/project cases are registered in catalogue-predicates.ts (source/attachment scopes also duplicate the outer joins)',
      },
      {
        locate: /"guard_(?:q|qs|r)"\."org_id" = "pkg"\."org_id"/,
        reason:
          'delegated proxyEligibleCondition predicates, killed by its foreign package, competing-source and registered name cases in catalogue-predicates.ts',
      },
    ],
  },
];
