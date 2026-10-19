import { entries as storeEntries } from './catalogue-writer.js';
import type { MutationEntry } from './harness.js';

const store = storeEntries.find((entry) => entry.builder === 'createVisibilityStore')!;
const methods = ['attachSource', 'detachSource', 'setPrecedence', 'setPackageFlag'];
const cases = store.cases.filter((test) => methods.some((method) => test.name.startsWith(method)));

export const entries: readonly MutationEntry[] = [
  {
    ...store,
    file: 'repositories/visibility-attach.ts',
    builder: 'createVisibilityAttachRepository',
    cases,
    predicates: store.predicates.filter((predicate) =>
      cases.some((test) => test.name === predicate.caseName),
    ),
  },
];
