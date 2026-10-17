import { describe, expect, it } from 'vitest';
import { parseSourceConfig } from '../sources/config.js';
import { createOutboundPolicy } from '../sources/url-policy.js';
import { MAX_KEY_LENGTH, packageKey } from './names.js';
import {
  MAX_PATTERN_BYTES,
  MAX_PATTERNS_PER_RULE,
  isPatternSyntax,
  PatternError,
  PATTERN_ALPHABET,
  isValidPattern,
  matchesPattern,
  patternAdmits,
} from './patterns.js';

const longName = 'A'.repeat(214);

describe('isValidPattern', () => {
  it.each([
    'acme/*',
    '@acme/*',
    '*-plugin',
    'acme/exact',
    '*',
    'a*b*c*d',
    '!j!s!o!n!stream',
    'a'.repeat(50),
  ])('accepts %s', (pattern) => {
    expect(isValidPattern(pattern)).toBe(true);
  });

  it.each([
    ['uppercase', 'Acme/*'],
    ['question mark', 'acme/?'],
    ['open bracket', 'acme/[a'],
    ['close bracket', 'acme/a]'],
    ['five wildcards', 'a*b*c*d*e*'],
    ['empty', ''],
    ['51 bytes', 'a'.repeat(51)],
    ['51 bytes with wildcards', `${'a'.repeat(49)}**`],
    ['space', 'acme /x'],
    ['backslash', 'acme\\x'],
  ])('refuses %s', (_label, pattern) => {
    expect(isValidPattern(pattern)).toBe(false);
  });

  it('matches the key of a fully capitalised 214-character name at 428 characters', () => {
    const key = packageKey(longName, { ecosystem: 'npm', legacyCase: true });
    expect(key).toHaveLength(MAX_KEY_LENGTH);
    expect(isPatternSyntax(key, MAX_KEY_LENGTH)).toBe(true);
    expect(matchesPattern(key, key)).toBe(true);
  });

  it('accepts the maximum length', () => {
    expect(MAX_PATTERN_BYTES).toBe(50);
    expect(isValidPattern('a'.repeat(MAX_PATTERN_BYTES))).toBe(true);
  });
});

describe('matchesPattern', () => {
  const table: [string, string, boolean][] = [
    ['acme/*', 'acme/widget', true],
    ['acme/*', 'acme/', true],
    ['acme/*', 'acme', false],
    ['acme/*', 'other/acme/widget', false],
    ['@acme/*', '@acme/a/b', true],
    ['@acme/*', '@other/a', false],
    ['*-plugin', 'acme/foo-plugin', true],
    ['*-plugin', 'acme/foo-plugin-x', false],
    ['*', 'anything/at/all', true],
    ['a*b', 'ab', true],
    ['a*b', 'a/x/y/b', true],
    ['a*b', 'a/x/y/bc', false],
    ['*a*b*', 'xxaxxbxx', true],
    ['acme/exact', 'acme/exact', true],
    ['acme/exact', 'acme/exact2', false],
    ['acme.x', 'acmeqx', false],
    ['*acme', 'acme', true],
    ['acme*', 'acme', true],
    ['*acme*', 'acme', true],
    ['!j*', '!j!s!o!n!stream', true],
    ['!j*', 'jsonstream', false],
    ['*!s*', '!j!s!o!n!stream', true],
  ];
  it.each(table)('%s vs %s is %s', (pattern, key, expected) => {
    expect(matchesPattern(pattern, key)).toBe(expected);
  });
});

describe('patternAdmits', () => {
  it('never admits flag 0, even through a matching include', () => {
    expect(patternAdmits({ includes: ['acme/*'], excludes: [], flag: 0 }, 'acme/a')).toBe(false);
    expect(patternAdmits({ includes: [], excludes: [], flag: 0 }, 'acme/a')).toBe(false);
  });

  it('admits flag 1 with no includes unless excluded', () => {
    expect(patternAdmits({ includes: [], excludes: [], flag: 1 }, 'acme/a')).toBe(true);
    expect(patternAdmits({ includes: [], excludes: ['acme/*'], flag: 1 }, 'acme/a')).toBe(false);
    expect(patternAdmits({ includes: [], excludes: ['other/*'], flag: 1 }, 'acme/a')).toBe(true);
  });

  it('with includes admits only matching flag-1 keys', () => {
    const rule = { includes: ['acme/*', '*-plugin'], excludes: [], flag: 1 } as const;
    expect(patternAdmits(rule, 'acme/a')).toBe(true);
    expect(patternAdmits(rule, 'x/foo-plugin')).toBe(true);
    expect(patternAdmits(rule, 'x/other')).toBe(false);
  });

  it('lets an exclude beat a matching include', () => {
    const rule = { includes: ['acme/*'], excludes: ['acme/secret*'], flag: 1 } as const;
    expect(patternAdmits(rule, 'acme/secret-x')).toBe(false);
    expect(patternAdmits(rule, 'acme/public')).toBe(true);
  });
});

describe('linear-time matching', () => {
  it.each([
    ['*a*a*a*a', `${'a'.repeat(427)}b`, false],
    ['*a*a*a*b', 'a'.repeat(428), false],
    ['*a*a*a*a', 'a'.repeat(428), true],
  ])('%s stays fast', (pattern, key, expected) => {
    const start = performance.now();
    expect(matchesPattern(pattern, key)).toBe(expected);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('fail closed', () => {
  it('throws on invalid patterns in matchesPattern', () => {
    expect(() => matchesPattern('Acme/*', 'acme/a')).toThrow(PatternError);
    expect(() => matchesPattern('acme/?', 'acme/a')).toThrow('invalid_pattern');
    expect(() => matchesPattern('', '')).toThrow(PatternError);
  });

  it('does not admit when an exclude is invalid', () => {
    for (const bad of ['Acme/*', 'acme/?']) {
      expect(patternAdmits({ includes: [], excludes: [bad], flag: 1 }, 'acme/a')).toBe(false);
    }
  });

  it('does not admit through an invalid include', () => {
    expect(patternAdmits({ includes: ['acme/[a'], excludes: [], flag: 1 }, 'acme/a')).toBe(false);
    expect(patternAdmits({ includes: ['acme/*', 'A*'], excludes: [], flag: 1 }, 'acme/a')).toBe(
      false,
    );
  });

  it('accepts exactly four wildcards', () => {
    expect(isValidPattern('a*b*c*d*')).toBe(true);
  });

  it('caps patterns per rule', () => {
    expect(MAX_PATTERNS_PER_RULE).toBe(64);
    const ok = Array.from({ length: 64 }, (_, i) => `p${i}/*`);
    const many = [...ok, 'extra/*'];
    expect(patternAdmits({ includes: ok, excludes: [], flag: 1 }, 'p1/x')).toBe(true);
    expect(patternAdmits({ includes: many, excludes: [], flag: 1 }, 'p1/x')).toBe(false);
    expect(patternAdmits({ includes: [], excludes: many, flag: 1 }, 'zzz/x')).toBe(false);
  });
});

describe('key alphabet', () => {
  it('covers every character of npm, composer and encoded keys', () => {
    const keys = [
      packageKey(longName, { ecosystem: 'npm', legacyCase: true }),
      packageKey('@types/node', { ecosystem: 'npm' }),
      packageKey('a~b._-c', { ecosystem: 'npm', legacyCase: true }),
      packageKey('Vendor/Pkg-name_x.y', { ecosystem: 'composer' }),
    ];
    for (const key of keys) {
      expect(PATTERN_ALPHABET.test(key)).toBe(true);
    }
  });

  it('refuses glob metacharacters', () => {
    for (const ch of ['?', '[', ']', '\\', '+', '(', ')', '{', '}', '|', '^', '$', ' ']) {
      expect(PATTERN_ALPHABET.test(`a${ch}b`)).toBe(false);
    }
  });
});

it('refuses a 51-byte Composer selection pattern through parseSourceConfig', () => {
  const result = parseSourceConfig(
    'composer_repository',
    'composer',
    'https://repo.example.test',
    JSON.stringify({ selection: { patterns: [`acme/${'a'.repeat(46)}`] } }),
    {
      runtime: 'node',
      hasCredential: false,
      policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected invalid selection');
  expect(result.problems).toEqual(
    expect.arrayContaining([expect.objectContaining({ field: 'selection.patterns' })]),
  );
});

it('rejects syntax above the matching limit', () => {
  expect(isPatternSyntax('a'.repeat(MAX_KEY_LENGTH + 1), MAX_KEY_LENGTH)).toBe(false);
  expect(() => matchesPattern('a'.repeat(MAX_KEY_LENGTH + 1), 'a')).toThrow(PatternError);
});
