import { describe, expect, it } from 'vitest';
import { STORED_PUBLISHED_AT_BASES } from '../../catalogue/version-rules.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import { effectiveDate, evaluateMinAge } from './age.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import type { VersionFact } from './types.js';

const NOW = '2026-11-01T00:00:00.000Z';
const DAY = 86_400;

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: '01J0P0000000000000000000A1',
    projectId: null,
    ecosystem: 'npm',
    packageKey: null,
    kind: 'min_age',
    minAgeSeconds: 7 * DAY,
    clientFamily: null,
    clientMinVersion: null,
    denyUnknown: false,
    reasonCode: 'organization_policy',
    incidentId: null,
    expiresAt: null,
    revision: 3,
    members: [],
    ...overrides,
  };
}

function fact(publishedAt: string, overrides: Partial<VersionFact> = {}): VersionFact {
  return {
    packageId: 'K',
    sourceId: 'S',
    packageKey: 'left-pad',
    versionId: 'V',
    version: '1.0.0',
    normalizedVersion: '1.0.0',
    revision: 1,
    publishedAt,
    ageBasis: 'published',
    ...overrides,
  };
}

const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

describe('effectiveDate', () => {
  it('uses the stored release date for broker and validated upstream history bases', () => {
    for (const basis of [
      'broker',
      'release_date',
      'build_date',
      'source_time',
      'packagist_added',
      'source_release',
    ]) {
      expect(
        effectiveDate({ publishedAt: ago(10), publishedAtBasis: basis, createdAt: ago(1) }),
      ).toEqual({ publishedAt: ago(10), ageBasis: 'published' });
    }
  });

  it('recognizes every basis a catalogue or import write can store', () => {
    for (const basis of STORED_PUBLISHED_AT_BASES) {
      expect(
        effectiveDate({ publishedAt: ago(10), publishedAtBasis: basis, createdAt: ago(1) }),
        basis,
      ).toEqual({
        publishedAt: ago(10),
        ageBasis: basis === 'import_time' ? 'imported' : 'published',
      });
    }
  });

  it('waits from import for an import_time basis', () => {
    expect(
      effectiveDate({ publishedAt: ago(10), publishedAtBasis: 'import_time', createdAt: ago(1) }),
    ).toEqual({ publishedAt: ago(10), ageBasis: 'imported' });
  });

  it('falls back to the immutable created_at for an unrecognized basis or an invalid date', () => {
    for (const stored of [
      { publishedAt: ago(10), publishedAtBasis: 'upstream', createdAt: ago(1) },
      { publishedAt: ago(10), publishedAtBasis: undefined, createdAt: ago(1) },
      { publishedAt: 'yesterday', publishedAtBasis: 'broker', createdAt: ago(1) },
      { publishedAt: '2026-10-01T00:00:00Z', publishedAtBasis: 'release_date', createdAt: ago(1) },
    ]) {
      expect(effectiveDate(stored)).toEqual({ publishedAt: ago(1), ageBasis: 'first_seen' });
    }
  });

  it('fails closed when neither the release date nor created_at is usable', () => {
    for (const createdAt of [undefined, '', 'not-a-date', '2026-10-01 00:00:00']) {
      expect(() =>
        effectiveDate({ publishedAt: 'bad', publishedAtBasis: 'broker', createdAt }),
      ).toThrow(RegistryPolicyUnavailableError);
    }
  });
});

describe('evaluateMinAge', () => {
  it('denies before the threshold and admits at and after it', () => {
    const before = evaluateMinAge([rule()], fact(ago(7 * DAY - 1)), NOW);
    expect(before.denials).toEqual([
      { ruleId: '01J0P0000000000000000000A1', ruleRevision: 3, reason: 'min_age' },
    ]);
    expect(before.nextBoundary).toBe(new Date(Date.parse(NOW) + 1000).toISOString());
    expect(evaluateMinAge([rule()], fact(ago(7 * DAY)), NOW)).toEqual({
      denials: [],
      nextBoundary: null,
    });
    expect(evaluateMinAge([rule()], fact(ago(8 * DAY)), NOW).denials).toEqual([]);
  });

  it('keeps a future date ineligible until it ages, even with a zero minimum', () => {
    const future = new Date(Date.parse(NOW) + 60_000).toISOString();
    const zero = evaluateMinAge([rule({ minAgeSeconds: 0 })], fact(future), NOW);
    expect(zero.denials).toHaveLength(1);
    expect(zero.nextBoundary).toBe(future);
    expect(evaluateMinAge([rule()], fact(future), NOW).nextBoundary).toBe(
      new Date(Date.parse(future) + 7 * DAY * 1000).toISOString(),
    );
  });

  it('measures an imported version from its import date and a legacy row from created_at', () => {
    const imported = effectiveDate({
      publishedAt: ago(2 * DAY),
      publishedAtBasis: 'import_time',
      createdAt: ago(9 * DAY),
    });
    expect(evaluateMinAge([rule()], fact(imported.publishedAt), NOW).denials).toHaveLength(1);
    const legacy = effectiveDate({
      publishedAt: ago(30 * DAY),
      publishedAtBasis: 'upstream',
      createdAt: ago(2 * DAY),
    });
    expect(evaluateMinAge([rule()], fact(legacy.publishedAt), NOW).denials).toHaveLength(1);
  });

  it('requires every applicable rule and reports each failing one', () => {
    const rules = [
      rule({ id: '01J0P0000000000000000000A1', minAgeSeconds: DAY }),
      rule({ id: '01J0P0000000000000000000A2', minAgeSeconds: 10 * DAY, projectId: 'P' }),
      rule({ id: '01J0P0000000000000000000A3', minAgeSeconds: 30 * DAY, packageKey: 'other' }),
    ];
    const result = evaluateMinAge(rules, fact(ago(5 * DAY)), NOW);
    expect(result.denials.map((denial) => denial.ruleId)).toEqual(['01J0P0000000000000000000A2']);
    expect(result.nextBoundary).toBe(new Date(Date.parse(NOW) + 5 * DAY * 1000).toISOString());
  });

  it('ignores rules that are expired or of another kind, and an expiry bounds the denial', () => {
    expect(
      evaluateMinAge(
        [rule({ expiresAt: NOW }), rule({ kind: 'block', minAgeSeconds: null })],
        fact(NOW),
        NOW,
      ).denials,
    ).toEqual([]);
    const expiring = new Date(Date.parse(NOW) + 1000).toISOString();
    expect(evaluateMinAge([rule({ expiresAt: expiring })], fact(NOW), NOW)).toEqual({
      denials: [{ ruleId: '01J0P0000000000000000000A1', ruleRevision: 3, reason: 'min_age' }],
      nextBoundary: expiring,
    });
  });

  it('fails closed on a rule without a minimum or a fact with an invalid date', () => {
    expect(() => evaluateMinAge([rule({ minAgeSeconds: null })], fact(NOW), NOW)).toThrow(
      RegistryPolicyUnavailableError,
    );
    expect(() => evaluateMinAge([rule()], fact('soon'), NOW)).toThrow(
      RegistryPolicyUnavailableError,
    );
  });
});
