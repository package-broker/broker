import { describe, expect, it } from 'vitest';
import {
  evaluateFilters,
  FilterError,
  type FilterRule,
  type FilterRepository,
  type FileEvidence,
  type FilterResult,
} from './filters.js';

const repo: FilterRepository = {
  id: 7,
  name: 'acme/php-library',
  archived: false,
  fork: false,
  visibility: 'private',
  topics: ['php', 'composer'],
};
interface Case {
  label: string;
  rule: FilterRule;
  repository?: Partial<FilterRepository>;
  files?: FileEvidence;
  existingChild?: boolean;
  missingTopics?: boolean;
  result: FilterResult;
}
const cases: Case[] = [
  { label: 'defaults', rule: {}, result: 'matched' },
  { label: 'empty filters', rule: { filters: [] }, result: 'matched' },
  { label: 'empty entry', rule: { filters: [{}] }, result: 'matched' },
  { label: 'exact name', rule: { filters: [{ names: ['php-library'] }] }, result: 'matched' },
  { label: 'case insensitive', rule: { filters: [{ names: ['PHP-LIBRARY'] }] }, result: 'matched' },
  { label: 'star', rule: { filters: [{ names: ['php-*'] }] }, result: 'matched' },
  { label: 'question', rule: { filters: [{ names: ['php-librar?'] }] }, result: 'matched' },
  {
    label: 'question exactly one',
    rule: { filters: [{ names: ['php-libra?'] }] },
    result: 'unmatched',
  },
  { label: 'star empty', rule: { filters: [{ names: ['php-library*'] }] }, result: 'matched' },
  { label: 'star backtrack', rule: { filters: [{ names: ['*p*l*y'] }] }, result: 'matched' },
  { label: 'name mismatch', rule: { filters: [{ names: ['npm-*'] }] }, result: 'unmatched' },
  { label: 'positive OR', rule: { filters: [{ names: ['npm-*', 'php-*'] }] }, result: 'matched' },
  {
    label: 'exclusion wins',
    rule: { filters: [{ names: ['php-*', '!php-library'] }] },
    result: 'unmatched',
  },
  {
    label: 'exclusion first wins',
    rule: { filters: [{ names: ['!php-library', '*'] }] },
    result: 'unmatched',
  },
  {
    label: 'exclusion case insensitive',
    rule: { filters: [{ names: ['!PHP-*'] }] },
    result: 'unmatched',
  },
  {
    label: 'only exclusion includes others',
    rule: { filters: [{ names: ['!npm-*'] }] },
    result: 'matched',
  },
  { label: 'empty names', rule: { filters: [{ names: [] }] }, result: 'matched' },
  {
    label: 'entries OR',
    rule: { filters: [{ names: ['no'] }, { names: ['php-*'] }] },
    result: 'matched',
  },
  {
    label: 'entries all fail',
    rule: { filters: [{ names: ['no'] }, { names: ['also-no'] }] },
    result: 'unmatched',
  },
  {
    label: 'topics all',
    rule: { filters: [{ topicsAll: ['php', 'composer'] }] },
    result: 'matched',
  },
  {
    label: 'topics all missing one',
    rule: { filters: [{ topicsAll: ['php', 'npm'] }] },
    result: 'unmatched',
  },
  { label: 'topics any', rule: { filters: [{ topicsAny: ['npm', 'php'] }] }, result: 'matched' },
  { label: 'topics any miss', rule: { filters: [{ topicsAny: ['npm'] }] }, result: 'unmatched' },
  { label: 'topics exact', rule: { filters: [{ topicsAny: ['ph'] }] }, result: 'unmatched' },
  {
    label: 'topics absent',
    rule: { filters: [{ topicsAll: ['php'] }] },
    missingTopics: true,
    result: 'unknown',
  },
  {
    label: 'empty topics definitive',
    rule: { filters: [{ topicsAll: ['php'] }] },
    repository: { topics: [] },
    result: 'unmatched',
  },
  {
    label: 'empty topic conditions',
    rule: { filters: [{ topicsAny: [], topicsAll: [] }] },
    missingTopics: true,
    result: 'matched',
  },
  {
    label: 'all conditions AND',
    rule: { filters: [{ names: ['no'], topicsAny: ['php'] }] },
    result: 'unmatched',
  },
  {
    label: 'marker exists',
    rule: { filters: [{ pathsExist: ['.package-broker'] }] },
    files: { '.package-broker': 'present' },
    result: 'matched',
  },
  {
    label: 'marker missing',
    rule: { filters: [{ pathsExist: ['marker'] }] },
    files: { marker: 'absent' },
    result: 'unmatched',
  },
  { label: 'marker unprobed', rule: { filters: [{ pathsExist: ['marker'] }] }, result: 'unknown' },
  {
    label: 'marker error',
    rule: { filters: [{ pathsExist: ['marker'] }] },
    files: { marker: 'unknown' },
    result: 'unknown',
  },
  {
    label: 'excluded file absent',
    rule: { filters: [{ pathsDoNotExist: ['skip'] }] },
    files: { skip: 'absent' },
    result: 'matched',
  },
  {
    label: 'excluded file exists',
    rule: { filters: [{ pathsDoNotExist: ['skip'] }] },
    files: { skip: 'present' },
    result: 'unmatched',
  },
  {
    label: 'excluded file unprobed',
    rule: { filters: [{ pathsDoNotExist: ['skip'] }] },
    result: 'unknown',
  },
  {
    label: 'multiple files AND',
    rule: { filters: [{ pathsExist: ['a', 'b'] }] },
    files: { a: 'present', b: 'absent' },
    result: 'unmatched',
  },
  {
    label: 'unknown AND false',
    rule: { filters: [{ pathsExist: ['a'], names: ['no'] }] },
    result: 'unmatched',
  },
  { label: 'unknown OR true', rule: { filters: [{ pathsExist: ['a'] }, {}] }, result: 'matched' },
  {
    label: 'unknown OR false',
    rule: { filters: [{ pathsExist: ['a'] }, { names: ['no'] }] },
    result: 'unknown',
  },
  { label: 'archived admission', rule: {}, repository: { archived: true }, result: 'unmatched' },
  {
    label: 'allow archived',
    rule: { skipArchived: false },
    repository: { archived: true },
    result: 'matched',
  },
  {
    label: 'existing archived child',
    rule: {},
    repository: { archived: true },
    existingChild: true,
    result: 'matched',
  },
  {
    label: 'existing fork child',
    rule: {},
    repository: { archived: true, fork: true },
    existingChild: true,
    result: 'unmatched',
  },
  {
    label: 'existing child visibility',
    rule: { visibility: 'public' },
    repository: { archived: true },
    existingChild: true,
    result: 'unmatched',
  },
  {
    label: 'existing child excluded id',
    rule: { excludedRepositoryIds: [7] },
    repository: { archived: true },
    existingChild: true,
    result: 'unmatched',
  },
  {
    label: 'existing child matching glob',
    rule: { filters: [{ names: ['php-*'] }] },
    repository: { archived: true },
    existingChild: true,
    result: 'matched',
  },
  {
    label: 'existing child mismatching glob',
    rule: { filters: [{ names: ['npm-*'] }] },
    repository: { archived: true },
    existingChild: true,
    result: 'unmatched',
  },
  {
    label: 'prototype marker unprobed',
    rule: { filters: [{ pathsExist: ['__proto__'] }] },
    result: 'unknown',
  },
  {
    label: 'prototype marker own evidence',
    rule: { filters: [{ pathsExist: ['__proto__'] }] },
    files: { ['__proto__']: 'present' },
    result: 'matched',
  },
  { label: 'skip fork', rule: {}, repository: { fork: true }, result: 'unmatched' },
  {
    label: 'allow fork',
    rule: { skipForks: false },
    repository: { fork: true },
    result: 'matched',
  },
  { label: 'private visibility', rule: { visibility: 'private_internal' }, result: 'matched' },
  {
    label: 'internal visibility',
    rule: { visibility: 'private_internal' },
    repository: { visibility: 'internal' },
    result: 'matched',
  },
  {
    label: 'public excluded',
    rule: { visibility: 'private_internal' },
    repository: { visibility: 'public' },
    result: 'unmatched',
  },
  {
    label: 'public only',
    rule: { visibility: 'public' },
    repository: { visibility: 'public' },
    result: 'matched',
  },
  { label: 'private excluded', rule: { visibility: 'public' }, result: 'unmatched' },
  { label: 'excluded id', rule: { excludedRepositoryIds: [7] }, result: 'unmatched' },
  { label: 'other excluded id', rule: { excludedRepositoryIds: [8] }, result: 'matched' },
  {
    label: 'exclusion overrides empty entry',
    rule: { filters: [{}], excludedRepositoryIds: [7] },
    result: 'unmatched',
  },
  {
    label: 'prototype path unprobed',
    rule: { filters: [{ pathsExist: ['constructor'] }] },
    result: 'unknown',
  },
  {
    label: 'adversarial glob',
    rule: { filters: [{ names: ['*a'.repeat(40) + 'b'] }] },
    repository: { name: 'a'.repeat(100) },
    result: 'unmatched',
  },
];

describe('evaluateFilters', () => {
  describe.each(['pathsExist', 'pathsDoNotExist'] as const)('%s root markers', (key) => {
    it.each(['a', '.package-broker', 'AZaz09._-', 'a'.repeat(100)])(
      'accepts root marker %s',
      (path) => {
        expect(
          evaluateFilters(
            repo,
            { filters: [{ [key]: [path] }] },
            {
              [path]: key === 'pathsExist' ? 'present' : 'absent',
            },
          ),
        ).toBe('matched');
      },
    );
    it.each([
      '',
      '.',
      '..',
      '...',
      'dir/marker',
      'a'.repeat(101),
      'a'.repeat(255),
      'marker name',
      'café',
      'marker:config',
      'marker@config',
      'marker\n',
      'marker\r',
      'marker\t',
      'marker\u0000',
    ])('rejects invalid marker %j with a fixed error', (path) => {
      expect(() => evaluateFilters(repo, { filters: [{ [key]: [path] }] })).toThrow(FilterError);
    });
  });
  it.each(cases)('$label', ({ rule, repository, files, existingChild, missingTopics, result }) => {
    const candidate = { ...repo, ...repository };
    if (missingTopics) delete candidate.topics;
    expect(
      evaluateFilters(candidate, rule, files, existingChild === undefined ? {} : { existingChild }),
    ).toBe(result);
  });
  it('accepts 1,000 excluded repository ids', () => {
    expect(
      evaluateFilters(repo, {
        excludedRepositoryIds: Array.from({ length: 1000 }, (_, i) => i + 100),
      }),
    ).toBe('matched');
  });
  it.each([
    null,
    1,
    'rule',
    [],
    { unexpected: true },
    { excludedRepositoryIds: Array.from({ length: 1001 }, (_, i) => i + 1) },
    { filters: Array.from({ length: 11 }, () => ({})) },
    { filters: [{ names: Array(21).fill('*') }] },
    ...['', '!', '!!x', 'x!y', 'a/b', 'x ', 'a'.repeat(101)].map((name) => ({
      filters: [{ names: [name] }],
    })),
    ...[
      '../secret',
      '/absolute',
      'a//b',
      'a/./b',
      'a\\b',
      'a%2fb',
      'a?b',
      'a#b',
      'a\nb',
      'a/'.repeat(130),
    ].map((path) => ({ filters: [{ pathsExist: [path] }] })),
    { filters: [{ topicsAll: ['PHP'] }] },
    // eslint-disable-next-line no-sparse-arrays -- Exercise a missing excluded repository id.
    { excludedRepositoryIds: [, 7] },
    { excludedRepositoryIds: [0] },
    { excludedRepositoryIds: [Number.MAX_SAFE_INTEGER + 1] },
  ])('rejects invalid rule %# with a fixed error', (rule) => {
    expect(() => evaluateFilters(repo, rule as FilterRule)).toThrow(FilterError);
  });
});

it('does not mutate repository, rule or probe evidence', () => {
  const repository = Object.freeze({ ...repo, topics: Object.freeze(['php']) });
  const rule = Object.freeze({
    filters: Object.freeze([
      Object.freeze({ names: Object.freeze(['php-*']), pathsExist: Object.freeze(['marker']) }),
    ]),
  });
  const files = Object.freeze({ marker: 'present' as const });
  expect(evaluateFilters(repository, rule, files)).toBe('matched');
  expect(evaluateFilters(repository, rule, files)).toBe('matched');
});
