import { expect, it } from 'vitest';
import { MapError, parsePackagistMap } from './map.js';

it('normalizes omitted sections of the versioned map', () => {
  expect(parsePackagistMap({ version: 1 })).toEqual({
    version: 1,
    projects: {},
    github: { installations: {} },
    mirrorOrder: [],
    packages: {},
    teams: {},
    credentials: [],
    distHosts: {},
  });
});
it.each([
  null,
  {},
  { version: 2 },
  { version: 1, github: null },
  { version: 1, projects: { acme: { slug: 'acme\n' } } },
  { version: 1, github: { installations: { 'acme\n': 42 } } },
  { version: 1, credentials: [{ match: { package: 'acme/*\n' }, kind: 'http_basic', ref: null }] },
  {
    version: 1,
    credentials: [{ match: { host: 'git.example.test\n' }, kind: 'http_basic', ref: null }],
  },
  { version: 1, mirrorOrder: null },
  { version: 1, credentials: null },
  { version: 1, unknown: true },
  { version: 1, projects: { acme: { slug: 'acme', existing: 'other' } } },
  { version: 1, projects: { acme: { slug: 123 } } },
  { version: 1, github: { installations: { acme: 0 } } },
  { version: 1, github: { installations: {}, extra: true } },
  { version: 1, mirrorOrder: [20, 20] },
  { version: 1, teams: { acme: { members: 'csv', group: { provider: 'sso', value: 'acme' } } } },
  { version: 1, teams: { acme: { members: 'csv', role: 'organization_admin' } } },
  { version: 1, packages: { 'acme/private': { url: 'https://git.example.test/', extra: true } } },
  { version: 1, distHosts: { 20: ['UPPER.example.test'] } },
  {
    version: 1,
    credentials: [
      { match: { host: 'git.example.test', package: 'acme/*' }, kind: 'http_basic', ref: null },
    ],
  },
  { version: 1, credentials: [{ match: { host: 'git.example.test' }, ref: null }] },
  {
    version: 1,
    credentials: [
      { match: { host: 'git.example.test' }, kind: 'http_basic', ref: null, secret: 'forbidden' },
    ],
  },
])('refuses invalid strict map %#', (value) => {
  expect(() => parsePackagistMap(value)).toThrow(MapError);
});
it.each([
  'env:ghp_SECRET',
  'env:GHP_SECRET',
  'env:lower',
  'env:NAME\n',
  'file:relative',
  'file:/tmp/../secret',
  'inline-secret',
])('refuses credential grammar without echoing input %#', (ref) => {
  expect(() =>
    parsePackagistMap({
      version: 1,
      credentials: [{ match: { host: 'git.example.test' }, kind: 'http_basic', ref }],
    }),
  ).toThrow('invalid_map');
});
it.each(['env:COMPOSER_AUTH_REF', 'file:/run/secrets/composer', null])(
  'accepts explicit non-secret references %#',
  (ref) => {
    expect(
      parsePackagistMap({
        version: 1,
        credentials: [{ match: { host: 'git.example.test' }, kind: 'http_basic', ref }],
      }).credentials[0]?.ref,
    ).toBe(ref);
  },
);
it.each([
  [
    { distHosts: { 20: Array.from({ length: 65 }, (_, i) => `h${i}.example.test`) } },
    'SOURCE_CONFIG_LIST_LIMIT',
  ],
  [
    {
      credentials: [
        { match: { package: `acme/${'a'.repeat(46)}` }, kind: 'http_basic', ref: null },
      ],
    },
    'MAX_PATTERN_BYTES',
  ],
])('names config caps %#', (part, cap) => {
  try {
    parsePackagistMap({ version: 1, ...part });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MapError);
    expect((error as MapError).cap).toBe(cap);
  }
});
