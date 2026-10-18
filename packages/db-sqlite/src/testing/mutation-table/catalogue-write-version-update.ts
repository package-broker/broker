import { type MutationEntry } from './harness.js';
import { monotonicDecisions, writeTimeCase } from './catalogue-time-cases.js';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'versionUpdateStatements',
    file: 'repositories/catalogue-write-version-update.ts',
    cases: [],
    predicates: [],
    sqlDecisions: [
      ...monotonicDecisions('update'),
      ...monotonicDecisions('update', 'composer'),
      {
        name: 'an unchanged update batch preserves the package clock',
        pattern:
          /version.upstream_released_at IS NOT json_extract\(incoming.value, '\$.upstream'\)/,
        replacement: "version.upstream_released_at IS json_extract(incoming.value, '$.upstream')",
        expected: 1,
        case: writeTimeCase('update', 'unchanged'),
      },
    ],
    batchDecisions: [
      {
        name: 'multiple updated versions read the clock once',
        pattern: /(?:strftime\('[^']*', 'now'(?:, '[^']*')?\)|unixepoch\('now'(?:, '[^']*')?\))/,
        expected: 1,
        caseName: writeTimeCase('update', 'future').name,
        case: writeTimeCase('update', 'future'),
      },
      {
        name: 'multiple updated versions advance the package clock once',
        pattern: /update "package" set/,
        expected: 1,
        caseName: writeTimeCase('update', 'future').name,
        case: writeTimeCase('update', 'future'),
      },
      {
        name: 'multiple Composer revisions advance the package clock once',
        pattern: /update "package" set/,
        expected: 1,
        caseName: writeTimeCase('update', 'future', 'composer').name,
        case: writeTimeCase('update', 'future', 'composer'),
      },
    ],
  },
];
