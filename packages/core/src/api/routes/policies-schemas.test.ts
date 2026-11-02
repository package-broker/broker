import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  POLICY_API_SPECS,
  policyCreateBody,
  policyInspection,
  policyPatchBody,
  policyRule,
  policyRuleDetail,
} from './policies-schemas.js';

const create = { ecosystem: 'npm', package: 'left-pad', kind: 'block', reasonCode: 'malware' };
const INSTALLABLE = /tarball|readme|manifest|integrity|"url"|dist|source/i;

describe('policy API schemas', () => {
  it('accepts the documented create and patch shapes', () => {
    expect(policyCreateBody.safeParse(create).success).toBe(true);
    expect(
      policyCreateBody.safeParse({
        ecosystem: 'npm',
        kind: 'client_floor',
        clientFamily: 'pnpm',
        clientMinVersion: '9.0.0',
        denyUnknown: true,
        reasonCode: 'compatibility',
      }).success,
    ).toBe(true);
    for (const body of [
      { members: ['1.0.0'], overrideReason: 'false_positive' },
      { state: 'disabled', reason: 'superseded' },
      { minAgeDays: 3, overrideReason: 'other' },
      { expiresAt: null },
    ]) {
      expect(policyPatchBody.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it.each([
    ['an unknown field', { ...create, notes: 'x' }],
    ['a non-boolean denyUnknown', { ...create, denyUnknown: 'yes' }],
    ['a free-text reason', { ...create, reasonCode: 'because the vendor said so' }],
    ['an age beyond ten years', { ...create, minAgeDays: 3651 }],
    ['a fractional age', { ...create, minAgeDays: 1.5 }],
    ['a range floor', { ...create, clientMinVersion: '>=9' }],
    ['a second-precision expiry', { ...create, expiresAt: '2027-01-01T00:00:00Z' }],
    ['an external incident link', { ...create, incidentId: 'https://tracker.invalid/1' }],
    [
      'too many members',
      { ...create, members: Array.from({ length: 1001 }, (_, i) => `1.0.${i}`) },
    ],
  ])('rejects %s on create', (_name, body) => {
    expect(policyCreateBody.safeParse(body).success).toBe(false);
  });

  it.each([
    ['a free-text override reason', { state: 'disabled', reason: 'customer asked' }],
    ['a disable without a reason', { state: 'disabled' }],
    ['an enable', { state: 'active', reason: 'other' }],
    ['members mixed with edits', { members: [], minAgeDays: 1 }],
    ['an immutable field', { kind: 'allowlist' }],
    ['a retarget', { package: 'other' }],
    ['a revision in the body', { minAgeDays: 1, revision: 2 }],
    ['an invalid denyUnknown', { denyUnknown: 'false' }],
  ])('rejects %s on patch', (_name, body) => {
    expect(policyPatchBody.safeParse(body).success).toBe(false);
  });

  it('requires a revision precondition on every patch route', () => {
    const patches = POLICY_API_SPECS.filter((spec) => spec.method === 'PATCH');
    expect(patches).toHaveLength(2);
    for (const spec of patches) expect(spec.concurrency).toBe('if-match');
  });

  it('describes no installable content in any response', () => {
    for (const schema of [policyRule, policyRuleDetail, policyInspection]) {
      expect(JSON.stringify(z.toJSONSchema(schema))).not.toMatch(INSTALLABLE);
    }
    for (const spec of POLICY_API_SPECS) {
      for (const schema of Object.values(spec.api.responses)) {
        if (schema === null) continue;
        expect(JSON.stringify(z.toJSONSchema(schema))).not.toMatch(INSTALLABLE);
      }
    }
  });
});
