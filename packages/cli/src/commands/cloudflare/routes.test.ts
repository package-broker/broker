import { expect, it } from 'vitest';
import type { ManagedRoute } from './inventory.js';
import { routeConflict } from './routes.js';

it.each([
  [
    'exact foreign host',
    'packages.example.com/private/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  ['wildcard subdomain', '*.example.com/*', 'packages.example.com/*', 'foreign', 'zone', 'overlap'],
  ['wildcard subdomain excludes apex', '*.example.com/*', 'example.com/*', 'foreign', 'zone', null],
  [
    'wildcard suffix includes apex',
    '*example.com/*',
    'example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'wildcard suffix includes subdomain',
    '*example.com/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  ['all hosts', '*/*', 'packages.example.com/*', 'foreign', 'zone', 'overlap'],
  ['sibling host', 'shop.example.com/*', 'packages.example.com/*', 'foreign', 'zone', null],
  [
    'narrower path',
    'packages.example.com/private',
    'packages.example.com/public/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'HTTP prefix',
    'http://packages.example.com/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'HTTPS prefix',
    'https://packages.example.com/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'uppercase foreign host',
    'PACKAGES.EXAMPLE.COM/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'uppercase requested host',
    'packages.example.com/*',
    'PACKAGES.EXAMPLE.COM/*',
    'foreign',
    'zone',
    'overlap',
  ],
  ['another zone overlap', '*/*', 'packages.example.com/*', 'foreign', 'other-zone', null],
  [
    'another zone exact pattern',
    'packages.example.com/*',
    'packages.example.com/*',
    'foreign',
    'other-zone',
    null,
  ],
  ['own script', 'packages.example.com/*', 'packages.example.com/*', 'broker', 'zone', null],
  ['own wildcard', '*/*', 'packages.example.com/*', 'broker', 'zone', null],
  [
    'foreign ownership takes precedence',
    'packages.example.com/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'foreign_owner',
  ],
  [
    'scriptless overlap',
    'packages.example.com/private/*',
    'packages.example.com/*',
    undefined,
    'zone',
    'overlap',
  ],
  [
    'scriptless exact ownership',
    'packages.example.com/*',
    'packages.example.com/*',
    undefined,
    'zone',
    'foreign_owner',
  ],
  ['non-string pattern', 42, 'packages.example.com/*', 'foreign', 'zone', null],
  ['missing pattern', undefined, 'packages.example.com/*', 'foreign', 'zone', null],
  [
    'uppercase scheme',
    'HTTPS://packages.example.com/*',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
  [
    'wildcard excludes unrelated suffix',
    '*.example.com/*',
    'notexample.com/*',
    'foreign',
    'zone',
    null,
  ],
  [
    'foreign pattern without path',
    'packages.example.com',
    'packages.example.com/*',
    'foreign',
    'zone',
    'overlap',
  ],
] as const)('%s', (_name, pattern, wanted, script, zone, expected) => {
  const requested: readonly ManagedRoute[] = [
    { id: null, zone_id: 'zone', pattern: wanted, script: 'broker' },
  ];
  expect(routeConflict(zone, { pattern, script }, requested, 'broker')).toBe(expected);
});

it.each([
  ['only the other zone overlaps', 'shop.example.com/*', null],
  ['the same zone overlaps', 'packages.example.com/*', 'overlap'],
] as const)('%s in a mixed-zone requested list', (_name, sameZonePattern, expected) => {
  const requested: readonly ManagedRoute[] = [
    { id: null, zone_id: 'other-zone', pattern: 'packages.example.com/*', script: 'broker' },
    { id: null, zone_id: 'zone', pattern: sameZonePattern, script: 'broker' },
  ];
  expect(
    routeConflict(
      'zone',
      { pattern: 'packages.example.com/private/*', script: 'foreign' },
      requested,
      'broker',
    ),
  ).toBe(expected);
});
