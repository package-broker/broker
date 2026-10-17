import { describe, expect, it } from 'vitest';
import {
  domainPolicyProblems,
  emailDomain,
  evaluateDomainPolicy,
  isValidDomain,
  normalizeEmail,
} from './policy.js';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidSubject,
  isValidTrustAnchor,
  RESERVED_PROVIDER_IDS,
} from './port.js';

const HEX_64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it.each([
    ['two at signs', 'a@b@c'],
    ['empty local part', '@x.io'],
    ['empty domain', 'a@'],
    ['no at sign', 'alice.example.com'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['inner space', 'a b@x.io'],
    ['inner tab', 'a\tb@x.io'],
    ['NUL', 'a\u0000b@x.io'],
    ['BEL', 'a\u0007@x.io'],
    ['DEL', 'a\u007f@x.io'],
    ['newline inside', 'a\nb@x.io'],
    ['no-break space inside', 'a b@x.io'],
    ['255 characters', `${'a'.repeat(243)}@example.com`],
    ['Kelvin sign in the local part', 'a\u212A@example.com'],
    ['Kelvin sign in the domain', 'a@exa\u212Aple.com'],
    ['dotless I', 'a@\u0131nfo.com'],
    ['composed accent', 'caf\u00e9@example.com'],
    ['decomposed accent', 'cafe\u0301@example.com'],
    ['zero-width space', 'a\u200Bb@example.com'],
    ['zero-width joiner in the domain', 'a@exam\u200Dple.com'],
    ['bidi override', 'a\u202Eb@example.com'],
    ['full-width at sign', 'a\uFF20example.com'],
    ['dot-only domain', 'a@.'],
    ['domain starting with a hyphen', 'a@-x'],
    ['domain with an empty label', 'a@b..c'],
    ['domain with a trailing dot', 'a@example.com.'],
    ['domain with a leading dot', 'a@.example.com'],
    ['single-label domain', 'a@localhost'],
    ['IPv4 domain', 'a@127.0.0.1'],
  ])('returns null for %s', (_name, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it('accepts exactly 254 characters', () => {
    const raw = `${'a'.repeat(242)}@example.com`;
    expect(raw).toHaveLength(254);
    expect(normalizeEmail(raw)).toBe(raw);
  });

  it('does not fold the Kelvin sign into k', () => {
    expect(normalizeEmail('\u212A@example.com')).toBeNull();
    expect('\u212A'.toLowerCase()).toBe('k');
  });
});

describe('emailDomain', () => {
  it('returns the part after the at sign', () => {
    expect(emailDomain('alice@example.com')).toBe('example.com');
  });

  it('throws without an at sign', () => {
    expect(() => emailDomain('alice')).toThrow(TypeError);
  });
});

describe('isValidDomain', () => {
  it.each(['example.com', 'sub.example.com', 'a-b.example.co.uk', 'xn--bcher-kva.example'])(
    'accepts %s',
    (domain) => {
      expect(isValidDomain(domain)).toBe(true);
    },
  );

  it.each([
    'localhost',
    '127.0.0.1',
    '1.2.3.4',
    'a.1',
    'Example.com',
    '*.example.com',
    '-a.example.com',
    'a-.example.com',
    'example..com',
    'example.com.',
    '.example.com',
    'exa mple.com',
    'example.com\n',
    '',
    `${'a'.repeat(64)}.com`,
    `${'a.'.repeat(126)}com`,
  ])('rejects %j', (domain) => {
    expect(isValidDomain(domain)).toBe(false);
  });

  it('accepts 253 characters and rejects 254', () => {
    const label = 'a'.repeat(61);
    const at253 = `${label}.${label}.${label}.${label}.${'b'.repeat(253 - 4 * 61 - 4)}`;
    expect(at253).toHaveLength(253);
    expect(isValidDomain(at253)).toBe(true);
    expect(isValidDomain(`b${at253}`)).toBe(false);
  });
});

describe('evaluateDomainPolicy', () => {
  const policy = { verifiedDomains: ['example.com'], autoJoin: false };

  it('refuses an unverified e-mail', () => {
    expect(
      evaluateDomainPolicy({ email: 'alice@example.com', emailVerified: false }, policy),
    ).toEqual({ allow: false, reason: 'email_unverified' });
  });

  it.each([['false'], ['true'], [1], [undefined], [null], [{}], ['']])(
    'refuses a non-boolean emailVerified %j',
    (emailVerified) => {
      expect(
        evaluateDomainPolicy({ email: 'alice@example.com', emailVerified } as never, policy),
      ).toEqual({ allow: false, reason: 'email_unverified' });
    },
  );

  it('does not create for a non-boolean autoJoin', () => {
    expect(
      evaluateDomainPolicy({ email: 'alice@example.com', emailVerified: true }, {
        verifiedDomains: ['example.com'],
        autoJoin: 'false',
      } as never),
    ).toEqual({ allow: true, mayCreate: false });
  });

  it('refuses a non-ASCII look-alike address', () => {
    expect(
      evaluateDomainPolicy(
        { email: 'alice@exam\u212Aple.com', emailVerified: true },
        { verifiedDomains: ['examkple.com'], autoJoin: true },
      ),
    ).toEqual({ allow: false, reason: 'domain_not_verified' });
  });

  it('checks verification before the domain', () => {
    expect(
      evaluateDomainPolicy({ email: 'alice@other.org', emailVerified: false }, policy),
    ).toEqual({ allow: false, reason: 'email_unverified' });
  });

  it('refuses a subdomain of a verified domain', () => {
    expect(
      evaluateDomainPolicy({ email: 'alice@sub.example.com', emailVerified: true }, policy),
    ).toEqual({ allow: false, reason: 'domain_not_verified' });
  });

  it('refuses a parent of a verified domain', () => {
    expect(
      evaluateDomainPolicy(
        { email: 'alice@example.com', emailVerified: true },
        { verifiedDomains: ['sub.example.com'], autoJoin: true },
      ),
    ).toEqual({ allow: false, reason: 'domain_not_verified' });
  });

  it('refuses a domain outside the list', () => {
    expect(evaluateDomainPolicy({ email: 'alice@evil.org', emailVerified: true }, policy)).toEqual({
      allow: false,
      reason: 'domain_not_verified',
    });
  });

  it('refuses an e-mail that does not normalize', () => {
    expect(evaluateDomainPolicy({ email: 'a@b@example.com', emailVerified: true }, policy)).toEqual(
      { allow: false, reason: 'domain_not_verified' },
    );
  });

  it('allows an exact match without creation when autoJoin is false', () => {
    expect(
      evaluateDomainPolicy({ email: 'alice@example.com', emailVerified: true }, policy),
    ).toEqual({ allow: true, mayCreate: false });
  });

  it('allows an exact match with creation when autoJoin is true', () => {
    expect(
      evaluateDomainPolicy(
        { email: 'alice@example.com', emailVerified: true },
        { verifiedDomains: ['example.com'], autoJoin: true },
      ),
    ).toEqual({ allow: true, mayCreate: true });
  });

  it('matches case-insensitively on the e-mail side', () => {
    expect(
      evaluateDomainPolicy({ email: ' Alice@EXAMPLE.com ', emailVerified: true }, policy),
    ).toEqual({ allow: true, mayCreate: false });
  });

  it('refuses everything for an empty domain list', () => {
    expect(
      evaluateDomainPolicy(
        { email: 'alice@example.com', emailVerified: true },
        { verifiedDomains: [], autoJoin: true },
      ),
    ).toEqual({ allow: false, reason: 'domain_not_verified' });
  });
});

describe('domainPolicyProblems', () => {
  it('reports nothing for a valid policy', () => {
    expect(domainPolicyProblems({ verifiedDomains: ['example.com'], autoJoin: false })).toEqual([]);
  });

  it('accepts authoritative domains that are verified', () => {
    expect(
      domainPolicyProblems({
        verifiedDomains: ['example.com'],
        emailAuthoritativeDomains: ['example.com'],
        autoJoin: false,
      }),
    ).toEqual([]);
  });

  it.each([
    ['unverified', ['other.com']],
    ['duplicate', ['example.com', 'example.com']],
    ['invalid', ['SecretCorp']],
    ['uppercase', ['Example.com']],
    ['non-string', [42]],
    ['non-array', 'example.com'],
  ])('rejects an authoritative domain list that is %s without echoing values', (_name, domains) => {
    const problems = domainPolicyProblems({
      verifiedDomains: ['example.com'],
      emailAuthoritativeDomains: domains,
      autoJoin: false,
    } as never);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('emailAuthoritativeDomains');
    expect(problems.join(' ')).not.toMatch(/SecretCorp|other\.com|Example\.com|42/);
  });

  it('accepts several distinct domains', () => {
    expect(
      domainPolicyProblems({ verifiedDomains: ['example.com', 'example.org'], autoJoin: true }),
    ).toEqual([]);
  });

  it.each([
    ['an empty list', []],
    ['a wildcard', ['*.example.com']],
    ['an uppercase domain', ['Example.com']],
    ['a single label', ['localhost']],
    ['a duplicate', ['example.com', 'example.com']],
    ['an empty entry', ['']],
    ['a padded entry', [' example.com']],
    ['an IPv4 address', ['127.0.0.1']],
    ['an all-numeric last label', ['example.123']],
    ['a sparse array', new Array<string>(2)],
    ['a hole next to a domain', Object.assign(new Array<string>(2), { 0: 'example.com' })],
  ])('reports problems for %s', (_name, verifiedDomains) => {
    expect(domainPolicyProblems({ verifiedDomains, autoJoin: false }).length).toBeGreaterThan(0);
  });

  it('reports one problem per bad entry', () => {
    expect(
      domainPolicyProblems({ verifiedDomains: ['example.com', 'Bad', 'worse'], autoJoin: false }),
    ).toHaveLength(2);
  });

  it('reports a non-boolean autoJoin', () => {
    const policy = { verifiedDomains: ['example.com'], autoJoin: 'yes' };
    expect(domainPolicyProblems(policy as never).length).toBeGreaterThan(0);
  });

  it('reports a non-array domain list and non-string entries', () => {
    expect(
      domainPolicyProblems({ verifiedDomains: 'example.com', autoJoin: false } as never),
    ).not.toEqual([]);
    expect(domainPolicyProblems({ verifiedDomains: [42], autoJoin: false } as never)).not.toEqual(
      [],
    );
  });

  it.each([[null], [undefined], ['example.com'], [42], [[]]])(
    'reports a non-object policy %j without throwing',
    (policy) => {
      expect(domainPolicyProblems(policy as never)).toEqual(['policy must be an object']);
    },
  );

  it('never echoes the offending value', () => {
    const problems = domainPolicyProblems({ verifiedDomains: ['SecretCorp'], autoJoin: false });
    expect(problems.join(' ')).not.toContain('SecretCorp');
  });
});

describe('isValidProviderId', () => {
  it.each(['dex', 'cf-access', 'a', 'a1', '0', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(isValidProviderId(id)).toBe(true);
  });

  it.each(['-a', 'a-', 'A', 'a'.repeat(65), '', 'a_b', 'a.b', 'a b', 'dex\n'])(
    'rejects %j',
    (id) => {
      expect(isValidProviderId(id)).toBe(false);
    },
  );
});

describe('reserved provider ids', () => {
  it('reserves local', () => {
    expect(isValidProviderId('local')).toBe(true);
    expect(isReservedProviderId('local')).toBe(true);
    expect(isReservedProviderId('dex')).toBe(false);
  });

  it('cannot be changed through the exported list', () => {
    expect(Object.isFrozen(RESERVED_PROVIDER_IDS)).toBe(true);
    expect(RESERVED_PROVIDER_IDS).toEqual(['local']);
    expect(() => (RESERVED_PROVIDER_IDS as string[]).push('dex')).toThrow(TypeError);
    expect(isReservedProviderId('dex')).toBe(false);
  });
});

describe('isValidSubject', () => {
  it.each(['abc', 'a', 'a'.repeat(255), 'user|123', 'café', '你好'])('accepts %j', (subject) => {
    expect(isValidSubject(subject)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['256 characters', 'a'.repeat(256)],
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'],
    ['zero-width space', 'a​b'],
    ['bidi override', 'a‮b'],
    ['BOM', '﻿abc'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_name, subject) => {
    expect(isValidSubject(subject)).toBe(false);
  });
});

describe('isValidTrustAnchor', () => {
  it.each([
    'oidc:https://dex.example.com/dex',
    'oidc:https://dex.example.com/dex/',
    'oidc:https://dex.example.com',
    'oidc:https://dex.example.com/',
    'oidc:https://dex.example.com:5556/dex',
    'oidc:https://[::1]/dex',
    'oidc:https://[2001:db8::1]:8443/dex',
    'oidc:https://192.0.2.10/dex',
    'oidc:https://Dex.Example.com/dex',
    'oidc:https://[2001:DB8::1]/dex',
    'oidc:http://127.0.0.1:5556/dex',
    'oidc:http://127.0.0.2:5556/dex',
    'oidc:http://localhost:5556',
    'oidc:http://[::1]:5556/dex',
    `access:team.cloudflareaccess.com/${HEX_64}`,
  ])('accepts %s', (anchor) => {
    expect(isValidTrustAnchor(anchor)).toBe(true);
  });

  it.each([
    ['plain http on a public host', 'oidc:http://dex.example.com'],
    ['plain http on a lookalike of a loopback host', 'oidc:http://localhost.evil.com/dex'],
    ['plain http on a non-loopback 127 lookalike', 'oidc:http://127.0.0.1.evil.com/dex'],
    ['plain http on a private address', 'oidc:http://10.0.0.1/dex'],
    ['a query', 'oidc:https://x/?a=1'],
    ['an empty query', 'oidc:https://x/?'],
    ['a fragment', 'oidc:https://dex.example.com/dex#frag'],
    ['an empty fragment', 'oidc:https://dex.example.com/dex#'],
    ['user info', 'oidc:https://user@dex.example.com/dex'],
    ['an empty user info', 'oidc:https://@dex.example.com/dex'],
    ['a relative reference', 'oidc:/dex'],
    ['a single slash after the scheme', 'oidc:https:/dex.example.com'],
    ['a backslash', 'oidc:https://dex.example.com\\dex'],
    ['another scheme', 'oidc:ftp://dex.example.com'],
    ['no scheme prefix', 'https://dex.example.com/dex'],
    ['whitespace', 'oidc:https://dex.example.com/d ex'],
    ['a trailing newline', 'oidc:https://dex.example.com/dex\n'],
    ['a NUL in the path', 'oidc:https://dex.example.com/d\u0000ex'],
    ['a zero-width space in the path', 'oidc:https://dex.example.com/d​ex'],
    ['a non-ASCII host', 'oidc:https://bücher.example/dex'],
    ['a port above 65535', 'oidc:https://example.com:99999'],
    ['an empty port', 'oidc:https://example.com:/dex'],
    ['an out-of-range IPv4 host', 'oidc:https://999.999.999.999'],
    ['an empty host', 'oidc:https:///dex'],
    ['a dot-dot path segment', 'oidc:https://dex.example.com/a/../dex'],
    ['a trailing dot-dot segment', 'oidc:https://dex.example.com/..'],
    ['an encoded dot-dot segment', 'oidc:https://dex.example.com/a/%2e%2E/dex'],
    ['a single-dot segment', 'oidc:https://dex.example.com/./dex'],
    ['an uppercase team', `access:Team.cloudflareaccess.com/${HEX_64}`],
    ['an uppercase audience', `access:team.cloudflareaccess.com/${HEX_64.toUpperCase()}`],
    ['63 hex characters', `access:team.cloudflareaccess.com/${HEX_64.slice(1)}`],
    ['65 hex characters', `access:team.cloudflareaccess.com/${HEX_64}0`],
    ['a non-hex audience', `access:team.cloudflareaccess.com/${'g'.repeat(64)}`],
    ['a team without a dot', `access:team/${HEX_64}`],
    ['a missing audience', 'access:team.cloudflareaccess.com/'],
    ['a team with a path', `access:team.cloudflareaccess.com/x/${HEX_64}`],
    ['an unknown prefix', 'saml:https://dex.example.com'],
    ['an empty string', ''],
    ['more than 512 characters', `oidc:https://dex.example.com/${'a'.repeat(500)}`],
  ])('rejects %s', (_name, anchor) => {
    expect(isValidTrustAnchor(anchor)).toBe(false);
  });

  it('accepts an Access team hostname of exactly 253 characters and rejects 254', () => {
    const label = 'a'.repeat(61);
    const team253 = `${label}.${label}.${label}.${label}.${'b'.repeat(253 - 4 * 61 - 4)}`;
    expect(team253).toHaveLength(253);
    expect(isValidTrustAnchor(`access:${team253}/${HEX_64}`)).toBe(true);
    expect(isValidTrustAnchor(`access:b${team253}/${HEX_64}`)).toBe(false);
  });

  it('accepts exactly 512 characters', () => {
    const prefix = 'oidc:https://dex.example.com/';
    const anchor = prefix + 'a'.repeat(512 - prefix.length);
    expect(anchor).toHaveLength(512);
    expect(isValidTrustAnchor(anchor)).toBe(true);
    expect(isValidTrustAnchor(`${anchor}a`)).toBe(false);
  });
});
