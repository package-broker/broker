import { expect } from 'vitest';
import { createDeprecationStore } from '../../repositories/npm-deprecate.js';
import { executing } from './factory-cases.js';
import { NOT_NULL, seedSource } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const ALIASES = ['p', 's', 'v', 't', 'tv', 'iv'];

const cases: ContractCase[] = ALIASES.map((foreignAlias) => ({
  name: `deprecation snapshot excludes foreign ${foreignAlias}`,
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    const org = (alias: string) => (alias === foreignAlias ? foreign.orgId : own.orgId);
    await seedSource(seed, 'DS', org('s'), 'hosted', 'npm');
    await seed.forged(
      "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES ('DP',?,'DS','npm','widget')",
      org('p'),
    );
    for (const [id, alias, version] of [
      ['DV', 'v', '1.0.0'],
      ['DTV', 'tv', '2.0.0'],
    ]) {
      await seed.forged(
        "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,status) VALUES (?,?,'DP',?,?, '2026-11-01T00:00:00.000Z','upstream','{}',?)",
        id!,
        org(alias!),
        version!,
        version!,
        alias === 'tv' && foreignAlias === 'v' ? 'quarantined' : 'active',
      );
    }
    if (foreignAlias === 'iv')
      await seed.forged(
        "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,status) VALUES ('DIV',?,'DP','3.0.0','3.0.0','2026-11-01T00:00:00.000Z','upstream','{}','quarantined')",
        foreign.orgId,
      );
    await seed.forged(
      "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,'DP','latest','DTV')",
      org('t'),
    );
    const result = await createDeprecationStore(executing(context)).snapshot(own, 'DS', 'widget');
    if (['p', 's', 'v'].includes(foreignAlias)) expect(result).toBeNull();
    else if (foreignAlias === 'iv') expect(result?.inactive).toBe(0);
    else expect(result?.tags).toEqual({});
  },
}));

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/npm-deprecate.ts',
    builder: 'createDeprecationStore',
    cases,
    predicates: ALIASES.map((alias) => ({
      name: `deprecation snapshot ${alias} organization`,
      caseName: `deprecation snapshot excludes foreign ${alias}`,
      locate: new RegExp(`(?<![\\w.])${alias}\\.org_id = \\?`),
      neutral: NOT_NULL,
      copies: 1,
    })),
  },
];
