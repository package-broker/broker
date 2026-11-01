import { describe, expect, it } from 'vitest';
import { validDistTag } from './dist-tags.js';

describe('npm dist-tag validation', () => {
  it.each(['latest', 'beta', 'next', 'xray', 'vnext', 'release-2026', '123abc', '_beta', '-beta'])(
    'accepts %s',
    (tag) => {
      expect(validDistTag(tag)).toBe(true);
    },
  );
  it.each([
    '',
    '1',
    'v1',
    '1.2',
    '1.2.3',
    '*',
    'x',
    'X',
    '^1',
    '~2',
    '>=1 <2',
    '1 || 2',
    '1 - 2',
    '../beta',
    'bad tag',
  ])('refuses %s', (tag) => {
    expect(validDistTag(tag)).toBe(false);
  });
});
