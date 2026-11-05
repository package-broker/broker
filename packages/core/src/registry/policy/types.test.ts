import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RegistryPolicyInputError,
  isPolicyClientVersion,
  isPolicyMember,
  isPolicyPackageKey,
  policyMembers,
  type PolicyRule,
} from '../../db/registry-policy.js';
import {
  requestFacts,
  versionFact,
  type ClientHints,
  type PolicyDecision,
  type PolicyRequestFacts,
  type VersionFact,
} from './types.js';

const FACT: VersionFact = {
  packageId: 'package',
  sourceId: 'source',
  packageKey: 'left-pad',
  versionId: 'version',
  version: '1.0.0',
  normalizedVersion: '1.0.0',
  revision: 2,
  publishedAt: '2026-10-01T00:00:00.000Z',
  ageBasis: 'published',
};

const REQUEST: PolicyRequestFacts = {
  orgId: 'org',
  projectId: 'project',
  principal: { kind: 'user', id: 'user' },
  ecosystem: 'npm',
  client: { family: 'pnpm', version: '9.1.0' },
  now: '2026-11-01T00:00:00.000Z',
};

describe('policy fact types', () => {
  it('require organization, project, provenance and revision', () => {
    expectTypeOf<PolicyRequestFacts>().toHaveProperty('orgId');
    expectTypeOf<PolicyRequestFacts>().toHaveProperty('projectId');
    expectTypeOf<VersionFact>().toHaveProperty('ageBasis');
    expectTypeOf<VersionFact>().toHaveProperty('revision');
    expectTypeOf<PolicyRule>().toHaveProperty('revision');
    const noProject: Omit<PolicyRequestFacts, 'projectId'> = REQUEST;
    const noBasis: Omit<VersionFact, 'ageBasis'> = FACT;
    // @ts-expect-error a request without its project is not a policy request
    const missingProject: PolicyRequestFacts = noProject;
    // @ts-expect-error a candidate without provenance cannot be aged
    const missingBasis: VersionFact = noBasis;
    const withHeaders: PolicyRequestFacts = {
      orgId: 'org',
      projectId: 'project',
      principal: { kind: 'user', id: 'user' },
      ecosystem: 'npm',
      client: { family: 'npm', version: null },
      now: REQUEST.now,
      // @ts-expect-error raw headers are not a policy input
      headers: { 'user-agent': 'npm/10' },
    };
    const raw = 'npm/10.2.0 node/v20';
    // @ts-expect-error a client family outside the normalized set is not a hint
    const rawClient: ClientHints = { family: raw, version: null };
    expect([missingProject, missingBasis, withHeaders, rawClient]).toHaveLength(4);
  });

  it('carry no permissive verdict', () => {
    // @ts-expect-error a decision can never allow
    const allow: PolicyDecision = { kind: 'allow' };
    // @ts-expect-error denials name a fixed reason
    const freeText: PolicyDecision = { kind: 'deny_request', reason: 'looks risky' };
    expect([allow, freeText]).toHaveLength(2);
  });

  it('copy only the declared candidate fields and freeze them', () => {
    const copied = versionFact({ ...FACT, manifest: { scripts: {} } } as VersionFact);
    expect(copied).toEqual(FACT);
    expect(Object.isFrozen(copied)).toBe(true);
    expect('manifest' in copied).toBe(false);
  });

  it.each<[string, Partial<Record<keyof VersionFact, unknown>>]>([
    ['revision zero', { revision: 0 }],
    ['a fractional revision', { revision: 1.5 }],
    ['an unknown basis', { ageBasis: 'download' }],
    ['a date without milliseconds', { publishedAt: '2026-10-01T00:00:00Z' }],
    ['an empty version id', { versionId: '' }],
  ])('refuse a candidate with %s', (_label, change) => {
    expect(() => versionFact({ ...FACT, ...change } as VersionFact)).toThrow(TypeError);
  });

  it('copy request facts without extra fields and refuse raw client strings', () => {
    const copied = requestFacts({ ...REQUEST, headers: { cookie: 'x' } } as PolicyRequestFacts);
    expect(copied).toEqual(REQUEST);
    expect(Object.isFrozen(copied.client)).toBe(true);
    expect('headers' in copied).toBe(false);
    for (const client of [
      { family: 'npm/10', version: null },
      { family: 'unknown', version: '1.0.0' },
      { family: 'npm', version: '10.0.0-rc.1' },
    ]) {
      expect(() => requestFacts({ ...REQUEST, client } as PolicyRequestFacts)).toThrow(TypeError);
    }
    expect(() => requestFacts({ ...REQUEST, projectId: '' })).toThrow(TypeError);
    expect(() =>
      requestFacts({ ...REQUEST, principal: { kind: 'anonymous', id: 'x' } } as never),
    ).toThrow(TypeError);
  });
});

describe('policy rule input validators', () => {
  it('accept canonical package keys only', () => {
    expect(isPolicyPackageKey('npm', 'left-pad')).toBe(true);
    expect(isPolicyPackageKey('npm', '@scope/pkg')).toBe(true);
    expect(isPolicyPackageKey('npm', '!left!pad')).toBe(true);
    expect(isPolicyPackageKey('npm', 'Left-Pad')).toBe(false);
    expect(isPolicyPackageKey('npm', '')).toBe(false);
    expect(isPolicyPackageKey('composer', 'vendor/package')).toBe(true);
    expect(isPolicyPackageKey('composer', 'Vendor/Package')).toBe(false);
    expect(isPolicyPackageKey('composer', 'left-pad')).toBe(false);
  });

  it('accept exact normalized members and refuse ranges, tags and globs', () => {
    expect(isPolicyMember('npm', '1.2.3')).toBe(true);
    expect(isPolicyMember('npm', '1.2.3-beta.1')).toBe(true);
    for (const value of ['^1.2.3', 'latest', '1.x', '1.2.*', '>=1.0.0', 'v1.2.3', '', ' 1.0.0']) {
      expect(isPolicyMember('npm', value), value).toBe(false);
    }
    expect(isPolicyMember('composer', '1.2.3.0')).toBe(true);
    expect(isPolicyMember('composer', 'dev-main')).toBe(true);
    expect(isPolicyMember('composer', '1.2.3.0-beta1')).toBe(true);
    for (const value of ['^1.2', '1.2.*', 'dev-', 'dev-a b', '~1.0']) {
      expect(isPolicyMember('composer', value), value).toBe(false);
    }
  });

  it('accept only the canonical Composer form the catalogue stores in version_normalized', () => {
    for (const value of [
      '1.0.0.0',
      '1.0.0.0-alpha1',
      '1.0.0.0-beta2',
      '1.0.0.0-RC1',
      '1.0.0.0-patch1',
      '1.0.0.0-dev',
      '1.2.9999999.9999999-dev',
      'dev-main',
      'dev-feature/x',
    ]) {
      expect(isPolicyMember('composer', value), value).toBe(true);
    }
    for (const value of [
      '1.0',
      '1.0.0',
      '1.0.0.0-alpha.1',
      '1.0.0.0-beta-2',
      '1.0.0.0.0',
      '2020.01.01',
      '1.0.0.0-alpha1.',
    ]) {
      expect(isPolicyMember('composer', value), value).toBe(false);
    }
  });

  it('sort and bound member sets with a fixed field error', () => {
    expect(policyMembers('npm', ['2.0.0', '1.0.0'])).toEqual(['1.0.0', '2.0.0']);
    expect(policyMembers('npm', [])).toEqual([]);
    const thousand = Array.from({ length: 1000 }, (_, index) => `1.0.${index}`);
    expect(policyMembers('npm', thousand)).toHaveLength(1000);
    for (const members of [[...thousand, '2.0.0'], ['1.0.0', '1.0.0'], ['secret-token'], 'x']) {
      let caught: unknown;
      try {
        policyMembers('npm', members);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RegistryPolicyInputError);
      expect(caught).toMatchObject({
        code: 'invalid_request',
        field: 'members',
        message: 'invalid_request',
      });
    }
  });

  it('accept stable numeric client floors only', () => {
    expect(isPolicyClientVersion('9.0.0')).toBe(true);
    for (const value of ['9', '9.0', '9.0.0-rc.1', '01.0.0', ' 9.0.0', '>=9.0.0']) {
      expect(isPolicyClientVersion(value), value).toBe(false);
    }
  });
});
