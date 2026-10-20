import { expect } from 'vitest';
import { createClosureEdges } from '../../repositories/closure-edges.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry, winnerWaivers } from './factory-cases.js';
import { visiblePackage, packageQuery } from './catalogue-factory-fixture.js';

const foreignChild: ContractCase = {
  name: 'createClosureEdges rejects a foreign membership child of an own package',
  async run(context) {
    await visiblePackage(context, true);
    const { own } = orgOf(context);

    expect(
      await createClosureEdges(executing(context)).classifyWinners(own, {
        ...packageQuery,
        keys: ['widget'],
      }),
    ).toEqual([{ key: 'widget', winner: null }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('closure-edges', 'createClosureEdges', foreignChild, /"pp"\."org_id" = \?/, [
    ...winnerWaivers,
  ]),
];
