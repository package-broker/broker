import type { MutationEntry } from './harness.js';
import { entries as reconcilerEntries } from './catalogue-reconcile.js';

export const entries: readonly MutationEntry[] = reconcilerEntries.map((entry) => ({
  ...entry,
  builder: 'finalizeListingStatements',
}));
