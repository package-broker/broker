import { describe, expect, it } from 'vitest';
import { validDistTag } from './dist-tags.js';

describe('npm dist-tag validation', () => {
  it.each([
    'latest',
    'beta',
    'next',
    'xray',
    'vnext',
    'vv1.2.3',
    'V1',
    '01',
    'x.1',
    '1.x.0',
    '9007199254740991',
    '1.9007199254740991',
    '1.2.9007199254740992',
    '~1.9007199254740991.0',
    '1-alpha',
    '1.2-alpha',
    '1.2.3-01',
    'release-2026',
    '123abc',
    '_beta',
    '-beta',
  ])('accepts %s', (tag) => {
    expect(validDistTag(tag)).toBe(true);
  });
  it.each([
    '',
    '1',
    'v1',
    'vv1',
    'vv1.2',
    '~>1',
    '~vv1.2',
    '~vv1.2.3',
    'vvx',
    '1.x.x',
    '1.2.3*',
    '*1.2.3',
    '*v1.2.3',
    '1.*2.3',
    '1.2.*3',
    '1.2.3-b*eta',
    '~x.1',
    '~1.x.0',
    '9007199254740991.0.0',
    '1.2.9007199254740991',
    '9007199254740990',
    '1.9007199254740990',
    '1.2.x-beta',
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
