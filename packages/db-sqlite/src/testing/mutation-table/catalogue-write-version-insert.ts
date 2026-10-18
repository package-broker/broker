import { type MutationEntry } from './harness.js';
import {
  monotonicDecisions,
  publicationCase,
  writeTimeCase,
  futureHistoryCase,
} from './catalogue-time-cases.js';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'versionInsertStatements',
    file: 'repositories/catalogue-write-version-insert.ts',
    cases: [],
    predicates: [],
    sqlDecisions: [
      ...monotonicDecisions('insert'),
      {
        name: 'future upstream history is refused only during initial synchronization',
        pattern: /package.last_synced_at IS NULL(?=\s+AND \?)/,
        replacement: 'package.last_synced_at IS NOT NULL',
        expected: 1,
        case: futureHistoryCase,
      },
      {
        name: 'an unchanged insert batch preserves the package clock',
        pattern: /version.last_op_id = \?/,
        replacement: '(? is not null)',
        expected: 1,
        case: writeTimeCase('insert', 'unchanged'),
      },
      ...[false, true].map((synced) => ({
        name: `publication time and basis follow the package synchronization phase (${String(synced)})`,
        pattern: /CASE WHEN package.last_synced_at IS NULL/,
        replacement: 'CASE WHEN package.last_synced_at IS NOT NULL',
        expected: 6,
        case: publicationCase(synced),
      })),
    ],
    batchDecisions: [
      {
        name: 'multiple inserted versions advance the package clock once',
        pattern: /update "package" set/,
        expected: 1,
        caseName: writeTimeCase('insert', 'future').name,
        case: writeTimeCase('insert', 'future'),
      },
    ],
  },
];
