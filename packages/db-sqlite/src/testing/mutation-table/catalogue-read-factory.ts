import { expect } from 'vitest';
import { createCatalogueReader } from '../../repositories/catalogue-read.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry, winnerWaivers } from './factory-cases.js';
import { visiblePackage, packageQuery } from './catalogue-factory-fixture.js';

const foreignChild: ContractCase = {
  name: 'createCatalogueReader rejects a foreign version child of an own package',
  async run(context) {
    await visiblePackage(context, false);
    const { own } = orgOf(context);
    const seed = seeder(context.executor);
    await seed("UPDATE version SET org_id = ? WHERE id = 'V'", orgOf(context).foreign.orgId);
    expect(
      await createCatalogueReader(executing(context)).resolveVersions(own, {
        ...packageQuery,
        limit: 10,
      }),
    ).toMatchObject({ versions: [] });
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('catalogue-read', 'createCatalogueReader', foreignChild, /v\.org_id = \?/, [
    ...winnerWaivers,
    {
      locate: /"pp"\."org_id" = \?|e\.org_id = \?/,
      reason:
        'The winner membership and cache epoch reads are delegated to independently registered visibleWinner and epochReadStatement.',
    },
  ]),
];
