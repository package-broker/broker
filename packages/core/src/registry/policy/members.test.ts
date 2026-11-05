import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '../../db/registry-policy.js';
import { evaluateMembers } from './members.js';
import type { VersionFact } from './types.js';

const NOW = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-02T00:00:00.000Z';

function rule(id: string, overrides: Partial<PolicyRule>): PolicyRule {
  return {
    id,
    projectId: null,
    ecosystem: 'npm',
    packageKey: 'left-pad',
    kind: 'block',
    minAgeSeconds: null,
    clientFamily: null,
    clientMinVersion: null,
    denyUnknown: false,
    reasonCode: 'security_review',
    incidentId: null,
    expiresAt: null,
    revision: 1,
    members: [],
    ...overrides,
  };
}

function fact(version: string, overrides: Partial<VersionFact> = {}): VersionFact {
  return {
    packageId: 'K',
    sourceId: 'S',
    packageKey: 'left-pad',
    versionId: `V-${version}`,
    version,
    normalizedVersion: version,
    revision: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ageBasis: 'published',
    ...overrides,
  };
}

const reasons = (rules: readonly PolicyRule[], candidate: VersionFact, now = NOW) =>
  evaluateMembers(rules, candidate, now).denials.map((d) => `${d.ruleId}:${d.reason}`);

describe('evaluateMembers', () => {
  it('a zero-member block denies every existing and later version of the package', () => {
    const block = [rule('B', {})];
    expect(reasons(block, fact('1.0.0'))).toEqual(['B:blocked']);
    expect(reasons(block, fact('9.9.9', { versionId: 'V-new', revision: 4 }))).toEqual([
      'B:blocked',
    ]);
    expect(reasons(block, fact('1.0.0', { packageKey: 'right-pad' }))).toEqual([]);
  });

  it('a block with members denies exactly those normalized versions', () => {
    const block = [rule('B', { members: ['1.0.0', '2.0.0-beta.1'] })];
    expect(reasons(block, fact('1.0.0'))).toEqual(['B:blocked']);
    expect(reasons(block, fact('2.0.0-beta.1'))).toEqual(['B:blocked']);
    expect(reasons(block, fact('1.0.1'))).toEqual([]);
  });

  it('matches Composer by the normalized version, not the display version', () => {
    const block = [
      rule('B', { ecosystem: 'composer', packageKey: 'acme/a', members: ['1.0.0.0'] }),
    ];
    const composer = (version: string, normalizedVersion: string) =>
      fact(version, { packageKey: 'acme/a', normalizedVersion });
    expect(reasons(block, composer('v1.0.0', '1.0.0.0'))).toEqual(['B:blocked']);
    expect(reasons(block, composer('1.0.0.0', '1.0.0.1'))).toEqual([]);
  });

  it('a zero-member allowlist allows none; members are the only survivors', () => {
    expect(reasons([rule('A', { kind: 'allowlist' })], fact('1.0.0'))).toEqual([
      'A:not_allowlisted',
    ]);
    const allow = [rule('A', { kind: 'allowlist', members: ['1.0.0'] })];
    expect(reasons(allow, fact('1.0.0'))).toEqual([]);
    expect(reasons(allow, fact('1.0.1'))).toEqual(['A:not_allowlisted']);
  });

  it('intersects organization and project allowlists, and a block beats an allowlist', () => {
    const rules = [
      rule('ORG', { kind: 'allowlist', members: ['1.0.0', '2.0.0'] }),
      rule('PRJ', { kind: 'allowlist', projectId: 'P', members: ['2.0.0', '3.0.0'] }),
      rule('BLK', { members: ['2.0.0'] }),
    ];
    expect(reasons(rules, fact('1.0.0'))).toEqual(['PRJ:not_allowlisted']);
    expect(reasons(rules, fact('2.0.0'))).toEqual(['BLK:blocked']);
    expect(reasons(rules, fact('3.0.0'))).toEqual(['ORG:not_allowlisted']);
  });

  it('a source or package switch with the same canonical key cannot evade a rule', () => {
    const rules = [
      rule('B', { members: ['1.0.0'] }),
      rule('Q', { kind: 'quarantine', reasonCode: 'malware', members: ['1.0.0'] }),
    ];
    for (const candidate of [
      fact('1.0.0'),
      fact('1.0.0', { sourceId: 'OTHER-SOURCE', packageId: 'OTHER-PACKAGE', versionId: 'X' }),
    ]) {
      expect(reasons(rules, candidate)).toEqual(['B:blocked', 'Q:quarantined']);
    }
  });

  it('releasing one rule leaves another rule denial in force', () => {
    const quarantine = rule('Q', { kind: 'quarantine', reasonCode: 'malware', members: ['1.0.0'] });
    const block = rule('B', { members: ['1.0.0'] });
    expect(reasons([quarantine, block], fact('1.0.0'))).toEqual(['Q:quarantined', 'B:blocked']);
    expect(reasons([block], fact('1.0.0'))).toEqual(['B:blocked']);
    expect(reasons([quarantine], fact('1.0.0'))).toEqual(['Q:quarantined']);
  });

  it('an expired block or allowlist no longer restricts, and expiry bounds the denial', () => {
    const block = rule('B', { expiresAt: LATER });
    expect(evaluateMembers([block], fact('1.0.0'), NOW)).toEqual({
      denials: [{ ruleId: 'B', ruleRevision: 1, reason: 'blocked' }],
      nextBoundary: LATER,
    });
    expect(reasons([block], fact('1.0.0'), LATER)).toEqual([]);
    expect(
      reasons([rule('A', { kind: 'allowlist', expiresAt: LATER })], fact('1.0.0'), LATER),
    ).toEqual([]);
  });

  it('ignores rules without a package and rules of other kinds', () => {
    const rules = [
      rule('AGE', { kind: 'min_age', packageKey: null, minAgeSeconds: 10 }),
      rule('FLOOR', { kind: 'client_floor', packageKey: null }),
    ];
    expect(evaluateMembers(rules, fact('1.0.0'), NOW)).toEqual({ denials: [], nextBoundary: null });
  });
});
