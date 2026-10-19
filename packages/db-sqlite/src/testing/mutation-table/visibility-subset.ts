import { entries as storeEntries } from './catalogue-writer.js';
import type { MutationEntry } from './harness.js';

const store = storeEntries.find((entry) => entry.builder === 'createVisibilityStore')!;
const methods = ['addPattern', 'removePattern', 'addExplicit', 'removeExplicit'];
const cases = store.cases.filter(
  (test) =>
    methods.some((method) => test.name.startsWith(method)) ||
    test.name.includes('foreign patterns'),
);

export const entries: readonly MutationEntry[] = [
  {
    ...store,
    file: 'repositories/visibility-subset.ts',
    builder: 'createVisibilitySubsetRepository',
    cases,
    predicates: store.predicates.filter((predicate) =>
      cases.some((test) => test.name === predicate.caseName),
    ),
  },
];
