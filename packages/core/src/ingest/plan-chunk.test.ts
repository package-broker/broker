import { describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '../catalogue/metadata.js';
import type { CatalogueWriteMethod, VersionInput } from '../db/catalogue.js';
import {
  INVOCATION_BUDGET,
  planChunk,
  type ChunkBudget,
  type ChunkMember,
  type ChunkSource,
  type ExistingChunkVersion,
} from './plan-chunk.js';

const INTEGRITY_A = `sha512-${'A'.repeat(86)}==`;
const INTEGRITY_B = `sha512-${'B'.repeat(86)}==`;
const SHA1_A = 'a'.repeat(40);
const SHA1_B = 'b'.repeat(40);

function npmManifest(version: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'left-pad',
    version,
    dist: {
      tarball: `https://registry.example.test/left-pad/-/left-pad-${version}.tgz`,
      integrity: INTEGRITY_A,
      shasum: SHA1_A,
      signatures: [{ keyid: 'k1', sig: 'one' }],
    },
    ...overrides,
  };
}

function composerManifest(version: string, description = 'Library'): unknown {
  return {
    name: 'acme/lib',
    version,
    description,
    dist: { type: 'zip', url: `https://dist.example.test/acme/lib/${version}.zip`, shasum: SHA1_A },
  };
}

function versionInput(
  ecosystem: 'npm' | 'composer',
  version: string,
  manifest: unknown,
): VersionInput {
  return {
    version,
    versionNormalized: version,
    license: null,
    distType: ecosystem === 'npm' ? 'tar' : 'zip',
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata(ecosystem, manifest),
    history: { basis: 'release_date', at: '2026-10-01T00:00:00.000Z' },
  };
}

function member(ordinal: number, version: VersionInput): ChunkMember {
  return { ordinal, version };
}

function existingFrom(version: VersionInput, withMetadata = true): ExistingChunkVersion {
  return {
    versionNormalized: version.versionNormalized,
    id: `v-${version.versionNormalized}`,
    revision: 1,
    status: 'active',
    npmIntegrity: version.metadata.npmIntegrity,
    composerShasum: version.metadata.composerShasum,
    ...(withMetadata ? { metadataJson: version.metadata.json } : {}),
  };
}

const npmSource: ChunkSource = { key: 'left-pad', type: 'npm_registry', covered: true };
const composerSource: ChunkSource = { key: 'acme/lib', type: 'composer_repository', covered: true };
const noA6: ChunkBudget = { sessionStatements: 3 };

function withA6(overrides: Partial<Record<CatalogueWriteMethod, number>> = {}): ChunkBudget {
  return {
    sessionStatements: 3,
    statementBudget: {
      syncPackage: 120,
      attachDist: 4,
      openListing: 3,
      markListing: 2,
      finalizeListing: 10,
      quarantine: 5,
      markPackageAbsent: 3,
      ...overrides,
    },
  };
}

function npmMembers(count: number, start = 0): ChunkMember[] {
  return Array.from({ length: count }, (_, i) =>
    member(start + i, versionInput('npm', `1.0.${start + i}`, npmManifest(`1.0.${start + i}`))),
  );
}

describe('planChunk npm diff', () => {
  it('treats a version whose only difference is a new signature as unchanged', () => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const next = versionInput(
      'npm',
      '1.0.0',
      npmManifest('1.0.0', {
        dist: {
          tarball: 'https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz',
          integrity: INTEGRITY_A,
          shasum: SHA1_A,
          signatures: [{ keyid: 'k2', sig: 'two' }],
          attestations: { url: 'https://registry.example.test/att', provenance: {} },
        },
      }),
    );
    const plan = planChunk([member(0, next)], [existingFrom(old)], npmSource, noA6);
    expect(plan.unchanged).toEqual(['1.0.0']);
    expect(plan.npmConflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.writerCalls).toEqual([]);
    expect(plan.cursorAfter).toBe(0);
  });

  it('ignores other manifest differences', () => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const next = versionInput('npm', '1.0.0', npmManifest('1.0.0', { description: 'changed' }));
    expect(planChunk([member(0, next)], [existingFrom(old)], npmSource, noA6).unchanged).toEqual([
      '1.0.0',
    ]);
  });

  it.each([
    ['integrity', { integrity: INTEGRITY_B, shasum: SHA1_A, tarball: 'left-pad-1.0.0.tgz' }],
    ['shasum', { integrity: INTEGRITY_A, shasum: SHA1_B, tarball: 'left-pad-1.0.0.tgz' }],
    ['tarball file name', { integrity: INTEGRITY_A, shasum: SHA1_A, tarball: 'other-1.0.0.tgz' }],
  ])('reports a changed %s as a conflict and never writes it', (_field, dist) => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const next = versionInput(
      'npm',
      '1.0.0',
      npmManifest('1.0.0', {
        dist: {
          tarball: `https://registry.example.test/left-pad/-/${dist.tarball}`,
          integrity: dist.integrity,
          shasum: dist.shasum,
        },
      }),
    );
    const plan = planChunk([member(0, next)], [existingFrom(old)], npmSource, noA6);
    expect(plan.npmConflicts).toEqual([
      { versionNormalized: '1.0.0', versionId: 'v-1.0.0', revision: 1 },
    ]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.writerCalls).toEqual([{ method: 'quarantine', versionNormalized: '1.0.0' }]);
  });

  it('does not treat a different tarball host as a conflict', () => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const moved = npmManifest('1.0.0') as { dist: Record<string, unknown> };
    moved.dist.tarball = 'https://mirror.example.test/x/left-pad-1.0.0.tgz?cache=1';
    const next = versionInput('npm', '1.0.0', moved);
    expect(planChunk([member(0, next)], [existingFrom(old)], npmSource, noA6).unchanged).toEqual([
      '1.0.0',
    ]);
  });

  it('requests metadata instead of trusting a matching integrity on a key-only row', () => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const plan = planChunk([member(0, old)], [existingFrom(old, false)], npmSource, noA6);
    expect(plan.unchanged).toEqual([]);
    expect(plan.metadataRequired).toEqual(['1.0.0']);
    expect(plan.cursorAfter).toBeNull();
    expect(plan.writerCalls).toEqual([]);
  });

  it.each([
    ['shasum', { integrity: INTEGRITY_A, shasum: SHA1_B, tarball: 'left-pad-1.0.1.tgz' }],
    ['tarball file name', { integrity: INTEGRITY_A, shasum: SHA1_A, tarball: 'other-1.0.1.tgz' }],
  ])('finds a changed %s on a key-only row only after the metadata read', (_field, dist) => {
    const old = versionInput('npm', '1.0.1', npmManifest('1.0.1'));
    const next = versionInput(
      'npm',
      '1.0.1',
      npmManifest('1.0.1', {
        dist: {
          tarball: `https://registry.example.test/left-pad/-/${dist.tarball}`,
          integrity: dist.integrity,
          shasum: dist.shasum,
        },
      }),
    );
    const members = [
      member(0, versionInput('npm', '1.0.0', npmManifest('1.0.0'))),
      member(1, next),
    ];
    const keyOnly = planChunk(members, [existingFrom(old, false)], npmSource, noA6);
    expect(keyOnly.metadataRequired).toEqual(['1.0.1']);
    expect(keyOnly.unchanged).toEqual([]);
    expect(keyOnly.inserts.map((v) => v.versionNormalized)).toEqual(['1.0.0']);
    expect(keyOnly.cursorAfter).toBe(0);
    const reread = planChunk(members.slice(1), [existingFrom(old)], npmSource, noA6);
    expect(reread.metadataRequired).toEqual([]);
    expect(reread.npmConflicts.map((c) => c.versionNormalized)).toEqual(['1.0.1']);
  });

  it('reports a changed integrity on a key-only row as a conflict without a metadata read', () => {
    const old = versionInput('npm', '1.0.0', npmManifest('1.0.0'));
    const changed = versionInput(
      'npm',
      '1.0.0',
      npmManifest('1.0.0', { dist: { integrity: INTEGRITY_B, shasum: SHA1_A } }),
    );
    const plan = planChunk([member(0, changed)], [existingFrom(old, false)], npmSource, noA6);
    expect(plan.npmConflicts.map((c) => c.versionNormalized)).toEqual(['1.0.0']);
    expect(plan.metadataRequired).toEqual([]);
  });

  it('inserts a version that does not exist yet', () => {
    const plan = planChunk(npmMembers(2), [], npmSource, noA6);
    expect(plan.inserts.map((v) => v.versionNormalized)).toEqual(['1.0.0', '1.0.1']);
    expect(plan.writerCalls).toHaveLength(1);
    expect(plan.cursorAfter).toBe(1);
  });
});

describe('planChunk composer diff', () => {
  it('treats a canonical metadata difference as an update', () => {
    const old = versionInput('composer', '1.0.0', composerManifest('1.0.0'));
    const next = versionInput('composer', '1.0.0', composerManifest('1.0.0', 'New text'));
    const plan = planChunk([member(0, next)], [existingFrom(old)], composerSource, noA6);
    expect(plan.composerUpdates.map((v) => v.versionNormalized)).toEqual(['1.0.0']);
    expect(plan.writerCalls).toEqual([{ method: 'syncPackage', versions: [next] }]);
  });

  it('treats identical canonical metadata as unchanged', () => {
    const old = versionInput('composer', '1.0.0', composerManifest('1.0.0'));
    const plan = planChunk([member(0, old)], [existingFrom(old)], composerSource, noA6);
    expect(plan.unchanged).toEqual(['1.0.0']);
    expect(plan.writerCalls).toEqual([]);
  });

  it('plans an update when the existing row was read without metadata', () => {
    const old = versionInput('composer', '1.0.0', composerManifest('1.0.0'));
    const plan = planChunk([member(0, old)], [existingFrom(old, false)], composerSource, noA6);
    expect(plan.composerUpdates).toHaveLength(1);
  });
});

describe('planChunk registered-name coverage', () => {
  it('refuses every member of an uncovered composer_repository package before any write', () => {
    const members = [
      member(4, versionInput('composer', '1.0.0', composerManifest('1.0.0'))),
      member(5, versionInput('composer', '2.0.0', composerManifest('2.0.0'))),
    ];
    const plan = planChunk(members, [], { ...composerSource, covered: false }, withA6());
    expect(plan.refused).toEqual([
      { version: '1.0.0', reason: 'name_not_registered' },
      { version: '2.0.0', reason: 'name_not_registered' },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.writerCalls).toEqual([]);
    expect(plan.cursorAfter).toBe(5);
  });

  it('budgets marks for refused members and stops at the invocation limit', () => {
    const members = npmMembers(2000);
    const plan = planChunk(
      members,
      [],
      { key: 'left-pad', type: 'npm_registry', covered: false },
      { ...withA6({ markListing: 1 }), sessionStatements: 449 },
    );
    expect(plan.refused).toHaveLength(1000);
    expect(plan.cursorAfter).toBe(999);
    expect(plan.statements).toBe(450);
    expect(plan.writerCalls).toEqual([]);
  });

  it('budgets refused members without A6 at one statement per 1,000 marks', () => {
    const plan = planChunk(
      npmMembers(2000),
      [],
      { key: 'left-pad', type: 'npm_registry', covered: false },
      { sessionStatements: 449 },
    );
    expect(plan.refused).toHaveLength(1000);
    expect(plan.cursorAfter).toBe(999);
  });

  it.each(['npm_registry', 'vcs'] as const)('refuses an uncovered %s package', (type) => {
    const plan = planChunk(npmMembers(1), [], { key: 'left-pad', type, covered: false }, noA6);
    expect(plan.refused).toHaveLength(1);
    expect(plan.writerCalls).toEqual([]);
  });

  it.each(['packagist_proxy', 'npmjs_proxy'] as const)('ignores coverage for a %s', (type) => {
    const plan = planChunk(npmMembers(1), [], { key: 'left-pad', type, covered: false }, noA6);
    expect(plan.refused).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
  });
});

describe('planChunk budget', () => {
  it('exports the invocation budget', () => {
    expect(INVOCATION_BUDGET).toBe(450);
  });

  it('without A6 never plans more than one writer call', () => {
    const old = versionInput('npm', '1.0.3', npmManifest('1.0.3'));
    const members = npmMembers(120);
    const conflicting = versionInput(
      'npm',
      '1.0.3',
      npmManifest('1.0.3', { dist: { integrity: INTEGRITY_B, shasum: SHA1_A } }),
    );
    members[3] = member(3, conflicting);
    const plan = planChunk(members, [existingFrom(old)], npmSource, noA6);
    expect(plan.writerCalls).toHaveLength(1);
    expect(plan.writerCalls[0]).toEqual({
      method: 'syncPackage',
      versions: members.slice(0, 3).map((m) => m.version),
    });
    expect(plan.cursorAfter).toBe(2);
    expect(plan.statements).toBeNull();
  });

  it('without A6 caps one sync call at 50 versions', () => {
    const plan = planChunk(npmMembers(120), [], npmSource, noA6);
    expect(plan.writerCalls).toHaveLength(1);
    expect(plan.inserts).toHaveLength(50);
    expect(plan.cursorAfter).toBe(49);
  });

  it('with A6 places as many calls as the reported cost allows, each <= 50 versions', () => {
    const plan = planChunk(npmMembers(400), [], npmSource, withA6());
    const syncs = plan.writerCalls.filter((c) => c.method === 'syncPackage');
    expect(syncs).toHaveLength(3);
    for (const call of syncs) expect(call.versions.length).toBeLessThanOrEqual(50);
    expect(plan.inserts).toHaveLength(150);
    expect(plan.cursorAfter).toBe(149);
    expect(plan.statements).toBe(3 + 2 + 3 * 120);
    expect(plan.statements).toBeLessThanOrEqual(INVOCATION_BUDGET);
  });

  it('charges marks per 1,000 keys and session statements for unchanged members', () => {
    const members = npmMembers(2500);
    const existing = members.map((m) => existingFrom(m.version));
    const plan = planChunk(members, existing, npmSource, withA6());
    expect(plan.unchanged).toHaveLength(2500);
    expect(plan.writerCalls).toEqual([]);
    expect(plan.statements).toBe(3 + 3 * 2);
    expect(plan.cursorAfter).toBe(2499);
  });

  it('charges quarantine calls against the budget', () => {
    const members = npmMembers(100);
    const existing = members.map((m) =>
      existingFrom(
        versionInput(
          'npm',
          m.version.version,
          npmManifest(m.version.version, {
            dist: { integrity: INTEGRITY_B, shasum: SHA1_A },
          }),
        ),
      ),
    );
    const plan = planChunk(members, existing, npmSource, withA6({ quarantine: 10 }));
    expect(plan.npmConflicts).toHaveLength(44);
    expect(plan.statements).toBe(3 + 2 + 44 * 10);
  });

  it('refuses a budget too small for the first member', () => {
    expect(() =>
      planChunk(npmMembers(1), [], npmSource, withA6({ syncPackage: INVOCATION_BUDGET })),
    ).toThrow(RangeError);
  });

  it('returns a null cursor and no calls for an empty chunk', () => {
    const plan = planChunk([], [], npmSource, withA6());
    expect(plan.cursorAfter).toBeNull();
    expect(plan.writerCalls).toEqual([]);
  });
});

describe('per-version sync costs', () => {
  it('requires the remaining writer costs before planning conflicting npm versions', () => {
    const members = npmMembers(100);
    const existing = members.map((m) => ({
      ...existingFrom(m.version),
      npmIntegrity: INTEGRITY_B,
    }));
    const syncCost = (versions: number) => 78 + 4 * versions;
    expect(() =>
      planChunk(members, existing, npmSource, { sessionStatements: 6, syncCost }),
    ).toThrow(new TypeError('invalid chunk budget'));

    const plan = planChunk(members, existing, npmSource, {
      ...withA6({ quarantine: 10, markListing: 5 }),
      sessionStatements: 6,
      syncCost,
    });
    expect(plan.npmConflicts).toHaveLength(43);
    expect(plan.writerCalls).toHaveLength(43);
    expect(plan.writerCalls.every((call) => call.method === 'quarantine')).toBe(true);
    expect(plan.cursorAfter).toBe(42);
    expect(plan.statements).toBe(6 + 5 + 43 * 10);
    expect(plan.statements).toBeLessThanOrEqual(INVOCATION_BUDGET);
  });

  it('covers 1,200 new versions within the invocation budget', () => {
    // Composer is the more expensive ecosystem: three update statements and one insert.
    const syncCost = (versions: number) => 78 + 4 * versions;
    const budget: ChunkBudget = {
      ...withA6({ syncPackage: 500, markListing: 5 }),
      sessionStatements: 6,
      syncCost,
    };
    let remaining = npmMembers(1200);
    const covered: number[] = [];
    let largest = 0;
    while (remaining.length > 0) {
      const plan = planChunk(remaining, [], npmSource, budget);
      largest = Math.max(largest, plan.statements!);
      expect(plan.inserts.length).toBeGreaterThan(0);
      expect(plan.statements).toBeLessThanOrEqual(INVOCATION_BUDGET);
      const writes = plan.writerCalls.reduce((sum, call) => {
        expect(call.method).toBe('syncPackage');
        if (call.method !== 'syncPackage') return sum;
        expect(call.versions.length).toBeLessThanOrEqual(50);
        return sum + syncCost(call.versions.length);
      }, 0);
      expect(plan.statements).toBe(6 + 5 + writes);
      const taken = remaining.filter((m) => m.ordinal <= plan.cursorAfter!);
      covered.push(...taken.map((m) => m.ordinal));
      remaining = remaining.slice(taken.length);
    }
    expect(covered).toEqual(Array.from({ length: 1200 }, (_, n) => n));
    expect(largest).toBe(447);
  });
});
