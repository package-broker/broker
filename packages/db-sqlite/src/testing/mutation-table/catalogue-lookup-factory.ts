import { expect } from 'vitest';
import { createCatalogueLookup } from '../../repositories/catalogue-lookup.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry, winnerWaivers } from './factory-cases.js';
import { visiblePackage, packageQuery } from './catalogue-factory-fixture.js';

const foreignChild: ContractCase = {
  name: 'createCatalogueLookup rejects a foreign version child of an own package',
  async run(context) {
    await visiblePackage(context, false);
    const { own } = orgOf(context);
    const seed = seeder(context.executor);
    await seed.forged("UPDATE version SET org_id = ? WHERE id = 'V'", orgOf(context).foreign.orgId);
    expect(
      await createCatalogueLookup(executing(context)).lookupVersion(own, {
        ...packageQuery,
        versionNormalized: '1.0.0',
      }),
    ).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('catalogue-lookup', 'createCatalogueLookup', foreignChild, /v\.org_id = \?/, [
    ...winnerWaivers,
    {
      locate: /"pp"\."org_id" = \?|e\.org_id = \?/,
      reason:
        'The winner membership and cache epoch reads are delegated to independently registered visibleWinner and epochReadStatement.',
    },
  ]),
];
