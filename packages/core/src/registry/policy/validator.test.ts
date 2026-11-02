import { describe, expect, it } from 'vitest';
import { policyEntityTag, policyValidator, type PolicyDecisionState } from './validator.js';

const BASE = 'a'.repeat(64);
const STATE: PolicyDecisionState = {
  versions: [
    { versionId: 'V1', revision: 1 },
    { versionId: 'V2', revision: 3 },
  ],
  nextBoundary: '2026-11-08T00:00:00.000Z',
  clientFamily: 'npm',
};

describe('decision-aware validators', () => {
  it('the same decision gives the same validator, whatever the discovery order', async () => {
    expect(await policyValidator(BASE, STATE)).toBe(await policyValidator(BASE, STATE));
    expect(await policyValidator(BASE, { ...STATE, versions: [...STATE.versions].reverse() })).toBe(
      await policyValidator(BASE, STATE),
    );
    expect(
      await policyValidator(BASE, {
        ...STATE,
        versions: [...STATE.versions, { versionId: 'V1', revision: 1 }],
      }),
    ).toBe(await policyValidator(BASE, STATE));
  });

  it('a different filtered set, revision, boundary bucket, client family or base changes it', async () => {
    const same = await policyValidator(BASE, STATE);
    const variants: Array<[string, PolicyDecisionState]> = [
      [BASE, { ...STATE, versions: [{ versionId: 'V1', revision: 1 }] }],
      [BASE, { ...STATE, versions: [...STATE.versions, { versionId: 'V3', revision: 1 }] }],
      [
        BASE,
        {
          ...STATE,
          versions: [
            { versionId: 'V1', revision: 1 },
            { versionId: 'V2', revision: 4 },
          ],
        },
      ],
      [BASE, { ...STATE, nextBoundary: '2026-11-09T00:00:00.000Z' }],
      [BASE, { ...STATE, nextBoundary: null }],
      [BASE, { ...STATE, clientFamily: 'pnpm' }],
      [BASE, { ...STATE, clientFamily: 'unknown' }],
      ['b'.repeat(64), STATE],
    ];
    const seen = new Set([same]);
    for (const [base, state] of variants) seen.add(await policyValidator(base, state));
    expect(seen.size).toBe(variants.length + 1);
  });

  it('versions removed by a hook change the digest like any other denial', async () => {
    const all = [
      { versionId: 'V1', revision: 1 },
      { versionId: 'V2', revision: 1 },
    ];
    const hookFiltered = all.filter((version) => version.versionId !== 'V2');
    expect(await policyValidator(BASE, { ...STATE, versions: hookFiltered })).not.toBe(
      await policyValidator(BASE, { ...STATE, versions: all }),
    );
  });

  it('an empty set is a distinct decision, and the version id and revision cannot be confused', async () => {
    expect(await policyValidator(BASE, { ...STATE, versions: [] })).not.toBe(
      await policyValidator(BASE, STATE),
    );
    expect(
      await policyValidator(BASE, { ...STATE, versions: [{ versionId: 'V1', revision: 11 }] }),
    ).not.toBe(
      await policyValidator(BASE, { ...STATE, versions: [{ versionId: 'V11', revision: 1 }] }),
    );
  });

  it('refuses a missing base or an invalid revision instead of hashing it', async () => {
    await expect(policyValidator('', STATE)).rejects.toBeInstanceOf(TypeError);
    await expect(
      policyValidator(BASE, { ...STATE, versions: [{ versionId: 'V1', revision: 0 }] }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('a policy entity tag is weak and can never equal an unfiltered npm tag', async () => {
    const tag = await policyEntityTag(BASE, STATE);
    expect(tag).toMatch(/^W\/"p\.[0-9a-f]{32}"$/);
    expect(tag).not.toBe(`W/"${BASE.slice(0, 16)}"`);
  });
});
