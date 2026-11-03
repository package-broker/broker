import { describe, expect, it } from 'vitest';
import { packageKey } from '../catalogue/names.js';
import { isNotificationPattern, isStoredPackageKey, notificationFilterMatches } from './filter.js';

const key = (name: string) => packageKey(name, { ecosystem: 'npm', legacyCase: true });

describe('stored-key notification filters', () => {
  it.each([
    ['*', 'left-pad', true],
    ['*', '@example/library', true],
    ['@example/*', '@example/library', true],
    ['@example/*', '@example/deep/x', true],
    ['@example/*', '@examples/library', false],
    ['@example/*', 'example/library', false],
    ['left-pad', 'left-pad', true],
    ['left-pad', 'left-pad2', false],
    ['left-pad', 'xleft-pad', false],
    ['*pad', 'left-pad', true],
    ['*pad', 'left-padx', false],
    ['left*', 'left', true],
    ['l*t*d', 'left-pad', true],
    ['l*t*d', 'left-pa', false],
    ['a*a', 'a', false],
    ['a*a', 'aa', true],
    ['*/*', '@example/library', true],
    ['*/*', 'library', false],
    ['@example/!library', key('@example/Library'), true],
    ['@example/library', key('@example/Library'), false],
    ['@!example/*', key('@Example/x'), true],
    ['@example/*', key('@Example/x'), false],
    ['*!l*', key('@example/Library'), true],
    ['a.b', 'axb', false],
    ['a.b', 'a.b', true],
  ])('%s against %s is %s', (pattern, stored, expected) => {
    expect(notificationFilterMatches(pattern, stored)).toBe(expected);
  });

  it.each([
    '',
    '@Example/*',
    '^left-pad$',
    'left-?ad',
    '[a-z]*',
    'left\\-pad',
    '(a|b)',
    'a+',
    'left$',
    '*****',
    'a'.repeat(51),
    ' left',
  ])('rejects %j as a pattern', (pattern) => {
    expect(isNotificationPattern(pattern)).toBe(false);
    expect(notificationFilterMatches(pattern, 'left-pad')).toBe(false);
  });

  it('accepts four wildcards and 50 bytes', () => {
    expect(isNotificationPattern('a*b*c*d*')).toBe(true);
    expect(isNotificationPattern('a'.repeat(50))).toBe(true);
  });

  it('never matches a display name in place of the stored key', () => {
    expect(isStoredPackageKey('@example/Library')).toBe(false);
    expect(notificationFilterMatches('*', '@example/Library')).toBe(false);
    expect(notificationFilterMatches('*', 'a'.repeat(429))).toBe(false);
    expect(isStoredPackageKey(key('@example/Library'))).toBe(true);
  });
});
