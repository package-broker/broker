import { expect } from 'vitest';
import { createCatalogueList } from '../../repositories/catalogue-list.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry, winnerWaivers } from './factory-cases.js';
import { visiblePackage, packageQuery } from './catalogue-factory-fixture.js';

const foreignChild: ContractCase = {
  name: 'createCatalogueList rejects a foreign membership child of an own package',
  async run(context) {
    await visiblePackage(context, true);
    const { own } = orgOf(context);

    expect(
      await createCatalogueList(executing(context)).search(own, {
        ...packageQuery,
        text: 'widget',
        limit: 10,
      }),
    ).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('catalogue-list', 'createCatalogueList', foreignChild, /"pp"\."org_id" = \?/, [
    ...winnerWaivers,
    {
      locate: /ops\.org_id = \?|os\.org_id = \?|op\.org_id = \?/,
      reason:
        'The open namespace branch has no proxy attachments in this membership case; proxy attachment isolation is covered separately by attachedSourceCondition registrations.',
    },
  ]),
];
