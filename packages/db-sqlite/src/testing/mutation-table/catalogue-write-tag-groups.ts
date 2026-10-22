import type { MutationEntry } from './harness.js';
import { entries as atomicEntries } from './catalogue-write-tags.js';

// The atomic wrapper executes the grouped builder's SQL, including every organization predicate.
export const entries: readonly MutationEntry[] = atomicEntries.map((entry) => ({
  ...entry,
  builder: 'distTagStatementGroups',
}));
