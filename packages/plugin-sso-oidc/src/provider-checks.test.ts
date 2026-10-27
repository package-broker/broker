import { fixedClock } from '@package-broker/core/ids';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import * as corePlugin from '@package-broker/core/plugin';
import { providerFieldProblems, type IdentityContext } from '@package-broker/core/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oidcModule from './oidc.js';
import * as presentationModule from './presentation.js';
import { createCloudflareAccessProvider } from './cloudflare-access.js';
import {
  checkEntries,
  checkProviderDefinitions,
  REJECTION_CODES,
  type ProviderConfig,
} from './provider-checks.js';
import ssoOidc from './index.js';
import { createOidcProvider } from './oidc.js';

const oidc = {
  id: 'corp-oidc',
  kind: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'broker-client',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
} as const;

const access = {
  id: 'corp-access',
  kind: 'cloudflare-access',
  teamDomain: 'acme.cloudflareaccess.com',
  audience: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2),
  policy: oidc.policy,
  trustEmailVerification: true,
} as const;

const ctx: IdentityContext = {
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  fetch: () => Promise.reject(new Error('unexpected fetch')),
  env: () => undefined,
};

const dex = {
  ...oidc,
  id: 'dex',
  issuer: 'https://dex.example.com/dex',
  clientId: 'package-broker',
};
const team = {
  ...access,
  id: 'access',
  teamDomain: 'team.cloudflareaccess.com',
  audience: 'ab12'.repeat(16),
  policy: { verifiedDomains: ['example.test'], autoJoin: false },
};

const validFixtures: readonly ProviderConfig[] = [
  oidc,
  access,
  dex,
  team,
  ...[oidc, dex, team].map((config) => ({ ...config, displayName: 'Company SSO' })),
  { ...team, trustEmailVerification: false },
  ...(['none', 'get-identity'] as const).map((groups) => ({ ...team, groups })),
  {
    ...dex,
    displayName: 'Company SSO',
    scopes: ['openid', 'email'],
    trustedAudiences: ['other-client'],
    trustedEndpointOrigins: ['https://token.example.net', 'http://localhost:5556'],
  },
  ...[
    'http://127.0.0.1:5556/dex',
    'http://localhost:5556',
    'https://idp.example.com/Dex',
    'https://idp.example.com/a%2Fb',
    'https://idp.example.com:8443/dex',
    'https://idp.example.com/dex',
    'https://second.example.com',
    'https://other.example.com',
  ].map((issuer) => ({ ...dex, issuer })),
  ...['a:b', 'a*~b'].map((clientId) => ({ ...dex, clientId })),
  { ...dex, trustedAudiences: ['other-app'] },
  ...[
    ['email', 'groups'],
    ['email', 'openid', 'email', 'profile'],
  ].map((scopes) => ({
    ...dex,
    scopes,
  })),
  { ...dex, trustedEndpointOrigins: ['http://127.0.0.1:5556'] },
  ...[
    'https://token.example.net',
    'https://tokens.example.net',
    'https://dex.example.com:8443',
  ].map((origin) => ({ ...dex, trustedEndpointOrigins: [origin] })),
  {
    ...oidc,
    scopes: ['openid', 'email'],
    trustedAudiences: ['broker-client'],
    trustedEndpointOrigins: ['https://idp.example.com'],
    policy: { ...oidc.policy, emailAuthoritativeDomains: ['example.com'] },
  },
  ...(
    [{ ...oidc, id: 'oidc', issuer: 'https://idp.example.test', clientId: 'broker' }, team] as const
  ).flatMap((config) =>
    [undefined, [], ['acme.example']].map((authority) => ({
      ...config,
      policy: {
        verifiedDomains: ['acme.example'],
        autoJoin: false,
        ...(authority === undefined ? {} : { emailAuthoritativeDomains: authority }),
      },
    })),
  ),
  ...Array.from({ length: 64 }, (_, index) => ({
    ...oidc,
    id: `idp-${index}`,
    issuer: `https://idp-${index}.example.com`,
  })),
  ...[
    { ...oidc, id: 'oidc', issuer: 'https://idp.example.test', clientId: 'broker' },
    team,
  ].flatMap((config) =>
    [undefined, [], ['acme.example'], ['other.example']].map((authority) => ({
      ...config,
      policy: {
        verifiedDomains: ['acme.example', 'other.example'],
        ...(authority === undefined ? {} : { emailAuthoritativeDomains: authority }),
        autoJoin: true,
      },
    })),
  ),
];

describe('checkProviderDefinitions', () => {
  afterEach(() => vi.restoreAllMocks());
  it('exports exactly the closed set of rejection codes', () => {
    expect(Object.isFrozen(REJECTION_CODES)).toBe(true);
    expect([...REJECTION_CODES].sort()).toEqual([
      'duplicate_anchor',
      'duplicate_id',
      'field:displayName',
      'field:id',
      'field:kind',
      'field:kindPrefix',
      'field:policy',
      'field:trustAnchor',
      'internal',
      'kind',
      'kind_rules',
      'unreadable',
    ]);
  });

  it.each([
    { code: 'unreadable', entries: [null] },
    {
      code: 'unreadable',
      entries: [
        Object.defineProperty({}, 'id', {
          get() {
            throw new Error();
          },
        }),
      ],
    },
    { code: 'kind', entries: [{ ...oidc, kind: 'unsupported' }] },
    { code: 'kind_rules', entries: [{ ...oidc, clientId: '' }] },
    { code: 'kind_rules', entries: [{ ...access, audience: '' }] },
    { code: 'duplicate_id', entries: [oidc, { ...oidc, issuer: 'https://second.example.com' }] },
    { code: 'duplicate_anchor', entries: [oidc, { ...oidc, id: 'second' }] },
  ])('reports exactly $code at its production site', ({ code, entries }) => {
    const { rejected } = checkProviderDefinitions(entries);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.codes).toEqual([code]);
  });

  it('codes a throwing reader as unreadable', () => {
    expect(
      checkEntries(1, () => {
        throw new Error('private');
      }).rejected,
    ).toEqual([
      {
        index: 0,
        problems: ['providers[0]: configuration must be a readable object'],
        codes: ['unreadable'],
      },
    ]);
  });

  it.each(['kind', 'trustAnchor', 'kindPrefix', 'policy'] as const)(
    'derives field:%s from byField even when problem messages are identical',
    (field) => {
      const fields = providerFieldProblems({
        ...oidc,
        displayName: oidc.id,
        trustAnchor: `oidc:${oidc.issuer}`,
      });
      fields.byField[field] = ['same problem', 'same problem'];
      fields.problems = ['same problem', 'same problem'];
      vi.spyOn(corePlugin, 'providerFieldProblems').mockReturnValue(fields);
      expect(checkProviderDefinitions([oidc]).rejected[0]?.codes).toEqual([`field:${field}`]);
    },
  );

  it('collects multiple field and duplicate id codes once in sorted order', () => {
    const fields = providerFieldProblems({ ...oidc, displayName: '', trustAnchor: '' });
    fields.byField.policy.push('same problem', 'same problem');
    fields.problems = Object.values(fields.byField).flat();
    vi.spyOn(corePlugin, 'providerFieldProblems').mockReturnValue(fields);
    expect(checkProviderDefinitions([oidc, oidc]).rejected[1]?.codes).toEqual([
      'duplicate_id',
      'field:displayName',
      'field:policy',
      'field:trustAnchor',
    ]);
  });

  it('collects duplicate anchor and id codes in sorted order', () => {
    expect(checkProviderDefinitions([oidc, oidc]).rejected[0]?.codes).toEqual([
      'duplicate_anchor',
      'duplicate_id',
    ]);
  });

  it.each([42, undefined, 'Corp', 'Bad Id', 'a'.repeat(65), 'local'])(
    'omits an unsafe or reserved rejection id (%j)',
    (id) => {
      const { rejected } = checkProviderDefinitions([{ ...oidc, id }]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).not.toHaveProperty('id');
      expect(rejected[0]?.codes).toEqual(['field:id', 'kind_rules']);
    },
  );

  it.each(['corp-oidc', 'a', 'a'.repeat(64)])('includes a valid rejection id (%s)', (id) => {
    const { rejected } = checkProviderDefinitions([{ ...oidc, id, clientId: '' }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe(id);
  });

  it('keeps the kind code alongside structural id problems', () => {
    const { rejected } = checkProviderDefinitions([{ ...oidc, id: 'Corp', kind: 'unsupported' }]);
    expect(rejected[0]?.codes).toEqual(['field:id', 'kind']);
    expect(rejected[0]).not.toHaveProperty('id');
  });

  it('reports field:displayName for a real kernel field failure', () => {
    expect(
      checkProviderDefinitions([{ ...access, displayName: 'x'.repeat(101) }]).rejected[0]?.codes,
    ).toEqual(['field:displayName']);
  });

  it.each(['kind validator', 'presentation', 'kernel validator'] as const)(
    'reports internal and retains a valid id when the %s throws',
    (stage) => {
      const spy =
        stage === 'kind validator'
          ? vi.spyOn(oidcModule, 'oidcProblems')
          : stage === 'presentation'
            ? vi.spyOn(presentationModule, 'providerPresentation')
            : vi.spyOn(corePlugin, 'providerFieldProblems');
      spy.mockImplementation(() => {
        throw new Error('PRIVATE_SENTINEL_INTERNAL');
      });
      const { rejected } = checkProviderDefinitions([oidc]);
      expect(rejected).toEqual([
        {
          index: 0,
          id: oidc.id,
          codes: ['internal'],
          problems: ['providers[0]: internal validation failure'],
        },
      ]);
      expect(JSON.stringify(rejected)).not.toContain('PRIVATE_SENTINEL_INTERNAL');
    },
  );

  it('keeps sentinel values out of the entire rejection except problems', () => {
    const sentinel = 'PRIVATE_SENTINEL_T918d';
    const entries = [
      { ...oidc, issuer: `https://UPPER.example.com/${sentinel}` },
      { ...oidc, [sentinel]: 'unknown key' },
      { ...oidc, displayName: `${sentinel}\u0007` },
      { ...oidc, clientId: `${sentinel}\n` },
      { ...oidc, policy: { ...oidc.policy, verifiedDomains: [`${sentinel}@example.com`] } },
      { ...access, teamDomain: `${sentinel}.cloudflareaccess.com` },
      { ...access, policy: { ...access.policy, verifiedDomains: [`${sentinel}@example.com`] } },
      { ...access, displayName: sentinel.repeat(10) },
    ].map((entry, index) => ({
      ...entry,
      id: `sentinel-${index}`,
      ...(entry.kind === 'oidc' && index !== 0
        ? { issuer: `https://idp-${index}.example.com` }
        : {}),
      ...(entry.kind === 'cloudflare-access' && index !== 5
        ? { teamDomain: `team-${index}.cloudflareaccess.com` }
        : {}),
    }));
    const { rejected } = checkProviderDefinitions(entries);
    expect(rejected).toHaveLength(entries.length);
    expect(rejected.map((r) => r.codes)).toEqual([
      ['kind_rules'],
      ['kind_rules'],
      ['kind_rules'],
      ['kind_rules'],
      ['kind_rules'],
      ['kind_rules'],
      ['kind_rules'],
      ['field:displayName'],
    ]);
    for (const r of rejected) {
      expect(r.id).toBe(`sentinel-${r.index}`);
      expect(JSON.stringify({ ...r, problems: undefined })).not.toContain(sentinel);
    }
  });

  it.each(
    [access, oidc].flatMap((config) =>
      [1, 100].map((length) => ({ ...config, displayName: 'x'.repeat(length) })),
    ),
  )('accepts and builds $kind with a boundary display name ($displayName)', (config) => {
    expect(checkProviderDefinitions([config])).toEqual({ accepted: [config], rejected: [] });
    const plugin = ssoOidc({ providers: [config] });
    const built = buildIdentityProviders(collectRegistrations([plugin]), [plugin], ctx);
    expect(built.size).toBe(1);
    expect(built.get(config.id)?.displayName).toBe(config.displayName);
  });

  it.each(['x'.repeat(101), 'Company\u0007SSO', 'Company\u200eSSO'])(
    'rejects an Access display name forbidden by the kernel (%j)',
    (displayName) => {
      const invalid = { ...access, displayName };
      const problem =
        'providers[0]: displayName must be 1 to 100 characters without control or format characters';
      expect(checkProviderDefinitions([invalid, { ...access, id: 'second' }, oidc])).toEqual({
        accepted: [{ ...access, id: 'second' }, oidc],
        rejected: [{ index: 0, problems: [problem], codes: ['field:displayName'], id: access.id }],
      });
      expect(() => ssoOidc({ providers: [invalid, oidc] })).toThrow(
        new TypeError(`invalid sso-oidc configuration: ${problem}`),
      );
    },
  );

  it.each(validFixtures.map((config, index) => ({ config, index })))(
    'adds no kernel field problem to existing valid fixture $index ($config.kind)',
    ({ config }) => {
      const provider =
        config.kind === 'oidc'
          ? createOidcProvider(config, ctx)
          : createCloudflareAccessProvider(config, ctx);
      expect(providerFieldProblems(provider).problems).toEqual([]);
      expect(checkProviderDefinitions([config])).toEqual({ accepted: [config], rejected: [] });
      const plugin = ssoOidc({ providers: [config] });
      const built = buildIdentityProviders(collectRegistrations([plugin]), [plugin], ctx);
      expect(built.size).toBe(1);
      expect(built.get(config.id)?.displayName).toBe(provider.displayName);
      expect(built.get(config.id)?.trustAnchor).toBe(provider.trustAnchor);
    },
  );

  it('keeps good entries in order around a rejected entry with all its problems', () => {
    const second = { ...oidc, id: 'second', issuer: 'https://second.example.com' };
    expect(checkProviderDefinitions([oidc, null, second])).toEqual({
      accepted: [oidc, second],
      rejected: [
        {
          index: 1,
          problems: ['providers[1]: configuration must be an object'],
          codes: ['unreadable'],
        },
      ],
    });
    expect(
      checkProviderDefinitions([{ ...oidc, issuer: 'http://idp.example.com', clientId: '' }])
        .rejected,
    ).toEqual([
      {
        index: 0,
        codes: ['kind_rules'],
        id: oidc.id,
        problems: [
          'providers[0]: issuer must be an https URL (or http on a loopback host) without query, fragment, credentials or trailing slash',
          'providers[0]: clientId must be 1 to 255 printable ASCII characters',
        ],
      },
    ]);
  });

  it('reserves the id of an invalid entry but does not reserve its anchor', () => {
    expect(
      checkProviderDefinitions([{ ...oidc, clientId: '' }, oidc, { ...oidc, id: 'third' }]),
    ).toEqual({
      accepted: [],
      rejected: [
        {
          index: 0,
          codes: ['kind_rules'],
          id: oidc.id,
          problems: ['providers[0]: clientId must be 1 to 255 printable ASCII characters'],
        },
        {
          index: 1,
          problems: ['providers[1]: id duplicates providers[0]'],
          codes: ['duplicate_id'],
          id: oidc.id,
        },
        {
          index: 2,
          problems: ['providers[2]: trust anchor duplicates providers[1]'],
          codes: ['duplicate_anchor'],
          id: 'third',
        },
      ],
    });
  });

  it('reports a later duplicate anchor', () => {
    expect(checkProviderDefinitions([oidc, { ...oidc, id: 'second' }])).toEqual({
      accepted: [oidc],
      rejected: [
        {
          index: 1,
          problems: ['providers[1]: trust anchor duplicates providers[0]'],
          codes: ['duplicate_anchor'],
          id: 'second',
        },
      ],
    });
  });

  it.each([
    [
      'https://idp.example.com/dex/',
      'issuer must be an https URL (or http on a loopback host) without query, fragment, credentials or trailing slash',
    ],
    ['https://idp.example.com/%64ex', 'issuer must be in canonical URL form'],
  ])('rejects a noncanonical anchor before duplicate detection (%s)', (issuer, problem) => {
    const first = { ...oidc, issuer: 'https://idp.example.com/dex' };
    expect(checkProviderDefinitions([first, { ...oidc, id: 'second', issuer }])).toEqual({
      accepted: [first],
      rejected: [
        { index: 1, problems: [`providers[1]: ${problem}`], codes: ['kind_rules'], id: 'second' },
      ],
    });
  });

  it('keeps field problems before duplicate id and anchor problems', () => {
    expect(checkProviderDefinitions([oidc, oidc, { ...oidc, clientId: '' }]).rejected).toEqual([
      {
        index: 1,
        codes: ['duplicate_anchor', 'duplicate_id'],
        id: oidc.id,
        problems: [
          'providers[1]: id duplicates providers[0]',
          'providers[1]: trust anchor duplicates providers[0]',
        ],
      },
      {
        index: 2,
        codes: ['duplicate_id', 'kind_rules'],
        id: oidc.id,
        problems: [
          'providers[2]: clientId must be 1 to 255 printable ASCII characters',
          'providers[2]: id duplicates providers[0]',
        ],
      },
    ]);
  });

  it('rejects an accessor without invoking its getter', () => {
    const getter = vi.fn(() => oidc.issuer);
    const entry = Object.defineProperty({ ...oidc }, 'issuer', { enumerable: true, get: getter });
    expect(checkProviderDefinitions([entry, oidc])).toEqual({
      accepted: [oidc],
      rejected: [
        {
          index: 0,
          problems: ['providers[0]: configuration must be a readable object'],
          codes: ['unreadable'],
        },
      ],
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'reads only length and indices from the providers array (throwing descriptor trap: %s)',
    (throwDescriptor) => {
      const traps: string[] = [];
      const list = new Proxy(
        [oidc, { ...oidc, id: 'second', issuer: 'https://second.example.com' }],
        {
          get(target, key, receiver) {
            traps.push(`get ${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
          getOwnPropertyDescriptor(target, key) {
            traps.push(`getOwnPropertyDescriptor ${String(key)}`);
            if (throwDescriptor) throw new Error('unreadable descriptor');
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          has(target, key) {
            traps.push(`has ${String(key)}`);
            return Reflect.has(target, key);
          },
          ownKeys(target) {
            traps.push('ownKeys');
            return Reflect.ownKeys(target);
          },
        },
      );
      expect(ssoOidc({ providers: list }).binds).toEqual(['identity']);
      expect(traps).toEqual(['get length', 'get 0', 'get 1']);
    },
  );

  it('keeps the per-entry unreadable fallback for a throwing array index', () => {
    const list = [oidc];
    Object.defineProperty(list, 0, {
      get: () => {
        throw new Error('unreadable entry');
      },
    });
    expect(() => ssoOidc({ providers: list })).toThrow(
      'invalid sso-oidc configuration: providers[0]: configuration must be a readable object',
    );
  });

  it('freezes result arrays, rejection records, and their problem lists', () => {
    const getter = vi.fn(() => oidc.issuer);
    const unreadable = Object.defineProperty({ ...oidc }, 'issuer', { get: getter });
    const { accepted, rejected } = checkProviderDefinitions([oidc, null, unreadable]);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(rejected).toHaveLength(2);
    for (const entry of rejected) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.problems)).toBe(true);
      expect(Object.isFrozen(entry.codes)).toBe(true);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('returns frozen snapshots isolated from later input mutation', () => {
    const input = {
      ...oidc,
      issuer: oidc.issuer as string,
      scopes: ['openid', 'email'],
      trustedAudiences: ['broker-client'],
      trustedEndpointOrigins: ['https://idp.example.com'],
      policy: {
        verifiedDomains: ['example.com'],
        emailAuthoritativeDomains: ['example.com'],
        autoJoin: false,
      },
    };
    const before = structuredClone(input);
    const { accepted, rejected } = checkProviderDefinitions([input]);
    input.issuer = 'https://other.example.com';
    input.scopes.push('groups');
    input.trustedAudiences.push('other');
    input.trustedEndpointOrigins.push('https://other.example.com');
    input.policy.verifiedDomains.push('other.example.com');
    input.policy.emailAuthoritativeDomains.push('other.example.com');
    input.policy.autoJoin = true;
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([before]);
    const snapshot = accepted[0];
    expect(snapshot?.kind).toBe('oidc');
    if (snapshot?.kind !== 'oidc') throw new Error('expected OIDC snapshot');
    for (const value of [
      snapshot,
      snapshot.scopes,
      snapshot.trustedAudiences,
      snapshot.trustedEndpointOrigins,
      snapshot.policy,
      snapshot.policy.verifiedDomains,
      snapshot.policy.emailAuthoritativeDomains,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});
