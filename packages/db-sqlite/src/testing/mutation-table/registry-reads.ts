import { expect } from 'vitest';
import { coversStatement, versionByIdStatement } from '../../repositories/registry-reads.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL, ref, seedPackage, seedSource, seedVersion } from './fixtures.js';

type Org = 'own' | 'foreign';

async function runCovers(context: CaseContext): Promise<boolean> {
  const { own } = orgOf(context);
  const rows = await context.executor.all<{ covered: number }>(
    context.mutate(coversStatement(own, 'S1', 'acme/a')),
  );
  return rows[0]?.covered === 1;
}

function coversCase(name: string, sourceOrg: Org, nameOrg: Org): ContractCase {
  return {
    name,
    async run(context) {
      const seed = seeder(context.executor);
      const orgs = orgOf(context);
      await seedSource(seed, 'S1', orgs[sourceOrg].orgId, 'vcs');
      await seed.forged(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R1', ?, 'S1', 'composer', 'acme/*')",
        orgs[nameOrg].orgId,
      );
      expect(await runCovers(context)).toBe(false);
    },
  };
}

const foreignSource = coversCase(
  'a source of another organization is never covered',
  'foreign',
  'own',
);
const foreignName = coversCase(
  'a registered name of another organization does not cover',
  'own',
  'foreign',
);

function versionCase(name: string, rows: { source: Org; pkg: Org; version: Org }): ContractCase {
  return {
    name,
    async run(context) {
      const seed = seeder(context.executor);
      const orgs = orgOf(context);
      await seedSource(seed, 'S1', orgs[rows.source].orgId, 'vcs');
      await seedPackage(seed.forged, 'K1', orgs[rows.pkg].orgId, 'S1', 'acme/a');
      await seedVersion(seed.forged, 'V1', orgs[rows.version].orgId, 'K1', '1.0.0');
      const result = await context.executor.all(
        context.mutate(versionByIdStatement(orgs.own, 'K1', 'V1')),
      );
      expect(result).toEqual([]);
    },
  };
}

const foreignVersion = versionCase('a version row of another organization is not returned', {
  source: 'own',
  pkg: 'own',
  version: 'foreign',
});
const foreignPackage = versionCase('a package of another organization is not returned', {
  source: 'own',
  pkg: 'foreign',
  version: 'own',
});
const foreignVersionSource = versionCase('a source of another organization is not consulted', {
  source: 'foreign',
  pkg: 'own',
  version: 'own',
});

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-reads.ts',
    builder: 'coversStatement',
    cases: [foreignSource, foreignName],
    predicates: [
      {
        name: 'source is scoped to the organization',
        locate: ref('rr_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSource.name,
      },
      {
        name: 'registered name row is scoped to the organization',
        locate: ref('rn_cov', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignName.name,
      },
    ],
  },
  {
    file: 'repositories/registry-reads.ts',
    builder: 'versionByIdStatement',
    cases: [foreignVersion, foreignPackage, foreignVersionSource],
    predicates: [
      {
        name: 'version is scoped to the organization',
        locate: ref('rr_v', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignVersion.name,
      },
      {
        name: 'package is scoped to the organization',
        locate: ref('rr_p', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPackage.name,
      },
      {
        name: 'source is scoped to the organization',
        locate: ref('rr_s', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignVersionSource.name,
      },
    ],
  },
];
