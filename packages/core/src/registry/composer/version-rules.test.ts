import { describe, expect, it } from 'vitest';
import { validateVersion } from '../../catalogue/versions.js';
import {
  branchToVersion,
  compareNormalized,
  tagToVersion,
  versionsFromRefs,
} from './version-rules.js';

const BRANCH_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['main', 'dev-main', 'dev-main'],
  ['master', 'dev-master', 'dev-master'],
  ['1.x', '1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['2.x', '2.x-dev', '2.9999999.9999999.9999999-dev'],
  ['2.4-develop', 'dev-2.4-develop', 'dev-2.4-develop'],
  ['feature/foo', 'dev-feature/foo', 'dev-feature/foo'],
  ['release-1.2', 'dev-release-1.2', 'dev-release-1.2'],
  ['1.2', '1.2.x-dev', '1.2.9999999.9999999-dev'],
  ['v1.2', 'v1.2.x-dev', '1.2.9999999.9999999-dev'],
  ['1.2.x', '1.2.x-dev', '1.2.9999999.9999999-dev'],
  ['1.*', '1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['develop', 'dev-develop', 'dev-develop'],
  ['trunk', 'dev-trunk', 'dev-trunk'],
  ['default', 'dev-default', 'dev-default'],
  ['3.0', '3.0.x-dev', '3.0.9999999.9999999-dev'],
  ['v4.x', 'v4.x-dev', '4.9999999.9999999.9999999-dev'],
  ['fix#123', 'dev-fix+123', 'dev-fix+123'],
  ['bun-tool', 'dev-bun-tool', 'dev-bun-tool'],
  ['maintenance/v2', 'dev-maintenance/v2', 'dev-maintenance/v2'],
  ['changeset-release/next', 'dev-changeset-release/next', 'dev-changeset-release/next'],
  ['9999999', '9999999.x-dev', '9999999.9999999.9999999.9999999-dev'],
  ['1.X', '1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['2.0-dev', 'dev-2.0-dev', 'dev-2.0-dev'],
];

const TAG_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['v1.2.3', 'v1.2.3', '1.2.3.0'],
  ['1.2.3-RC1', '1.2.3-RC1', '1.2.3.0-RC1'],
  ['1.2', '1.2', '1.2.0.0'],
  ['release-1.2', '1.2', '1.2.0.0'],
  ['release-1.2.3', '1.2.3', '1.2.3.0'],
  ['1.0.0-dev', '1.0.0', '1.0.0.0'],
  ['v1.0.0-dev', 'v1.0.0', '1.0.0.0'],
  ['dev-main', 'dev-main', 'main'],
  ['2.0.0-b3', '2.0.0-b3', '2.0.0.0-beta3'],
  ['v1.37.0', 'v1.37.0', '1.37.0.0'],
  ['1.2.3-rc.1', '1.2.3-rc.1', '1.2.3.0-RC1'],
  ['1.2.3-beta.2', '1.2.3-beta.2', '1.2.3.0-beta2'],
  ['1.2.3-beta2', '1.2.3-beta2', '1.2.3.0-beta2'],
  ['v2.0.0-alpha', 'v2.0.0-alpha', '2.0.0.0-alpha'],
  ['v2.0.0-alpha.1', 'v2.0.0-alpha.1', '2.0.0.0-alpha1'],
  ['2.0.0-a1', '2.0.0-a1', '2.0.0.0-alpha1'],
  ['1.0.0-patch1', '1.0.0-patch1', '1.0.0.0-patch1'],
  ['1.0.0-pl2', '1.0.0-pl2', '1.0.0.0-patch2'],
  ['1.0.0-p1', '1.0.0-p1', '1.0.0.0-patch1'],
  ['1.0.0-stable', '1.0.0-stable', '1.0.0.0'],
  ['1.0.0.1', '1.0.0.1', '1.0.0.1'],
  ['1', '1', '1.0.0.0'],
  ['v1', 'v1', '1.0.0.0'],
  ['1.0.0+build.5', '1.0.0+build.5', '1.0.0.0'],
  ['1.0.0-RC1+meta', '1.0.0-RC1+meta', '1.0.0.0-RC1'],
  ['2023.01.15', '2023.01.15', '2023.01.15.0'],
  ['20230115', '20230115', '20230115'],
  ['2023-01-15-10-00', '2023-01-15-10-00', '2023.01.15.10.00'],
  ['1.2.3-alpha-1', '1.2.3-alpha-1', '1.2.3.0-alpha1'],
  ['V1.2.3', 'V1.2.3', '1.2.3.0'],
  ['1.2.3.RC1', '1.2.3.RC1', '1.2.3.0-RC1'],
  ['1.2.3RC1', '1.2.3RC1', '1.2.3.0-RC1'],
  ['3.4.4', '3.4.4', '3.4.4.0'],
  ['99999.0.0', '99999.0.0', '99999.0.0.0'],
  ['123456.0.0', '123456.0.0', '123456.0.0'],
  ['1.2.3-beta.2.1', '1.2.3-beta.2.1', '1.2.3.0-beta2.1'],
  ['1.0.0-rc', '1.0.0-rc', '1.0.0.0-RC'],
];

const refs = (...args: Parameters<typeof versionsFromRefs>) => versionsFromRefs(...args).versions;

describe('branchToVersion', () => {
  it.each(BRANCH_ROWS)('%s', (branch, version, versionNormalized) => {
    expect(branchToVersion(branch)).toEqual({ ok: true, version, versionNormalized });
  });

  it('rejects a branch name that conflicts with constraint syntax', () => {
    for (const name of ['feature with space', 'a,b', 'a|b']) {
      expect(branchToVersion(name).ok).toBe(false);
    }
  });

  it('never produces the literal 9999999-dev as a stored key', () => {
    for (const name of ['9999999-dev', '9999999', 'x', '1.x', 'main']) {
      const result = branchToVersion(name);
      expect(result.ok && result.versionNormalized).not.toBe('9999999-dev');
    }
  });

  it('yields a normalized form the catalogue accepts with dev stability', () => {
    for (const [branch] of BRANCH_ROWS) {
      const result = branchToVersion(branch);
      if (!result.ok) throw new Error(branch);
      expect(
        validateVersion({
          ecosystem: 'composer',
          version: result.version,
          versionNormalized: result.versionNormalized,
        }).stability,
      ).toBe('dev');
    }
  });
});

describe('tagToVersion', () => {
  it.each(TAG_ROWS)('%s', (tag, version, versionNormalized) => {
    const result = tagToVersion(tag);
    expect(result.ok && [result.version, result.versionNormalized]).toEqual([
      version,
      versionNormalized,
    ]);
  });

  it.each(['1.0.0.1.2', '1.2.3-SNAPSHOT', 'foo', 'v6.0.0-next.1', '7.0.0-next.9', 'v1.x', ''])(
    'drops %j',
    (tag) => {
      expect(tagToVersion(tag).ok).toBe(false);
    },
  );
});

describe('tagToVersion skipped flag', () => {
  it.each([
    ['1.0.0-dev', true],
    ['dev-main', true],
    ['1.0.0', false],
  ])('%s', (tag, skipped) => {
    const result = tagToVersion(tag);
    expect(result.ok && result.skipped).toBe(skipped);
  });
});

describe('compareNormalized', () => {
  it('orders numerically, not lexically', () => {
    expect(compareNormalized('1.37.0.0', '1.34.0.0')).toBeGreaterThan(0);
    expect(compareNormalized('1.10.0.0', '1.9.0.0')).toBeGreaterThan(0);
  });

  it('orders stabilities dev < alpha < beta < RC < stable < patch', () => {
    const ordered = [
      '1.0.0.0-dev',
      '1.0.0.0-alpha1',
      '1.0.0.0-beta1',
      '1.0.0.0-RC1',
      '1.0.0.0',
      '1.0.0.0-patch1',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareNormalized(ordered[index]!, ordered[index - 1]!)).toBeGreaterThan(0);
    }
  });

  it('does not produce NaN for multi-part prerelease suffixes', () => {
    expect(compareNormalized('1.0.0.0-RC1-2', '1.0.0.0-RC1-1')).toBeGreaterThan(0);
    expect(compareNormalized('1.0.0.0-RC1-2', '1.0.0.0-RC1-2')).toBe(0);
  });

  it('compares large digit runs without precision loss', () => {
    expect(compareNormalized('1.9007199254740993.0.0', '1.9007199254740992.0.0')).toBeGreaterThan(
      0,
    );
  });

  it('orders prerelease numbers numerically', () => {
    expect(compareNormalized('1.0.0.0-RC10', '1.0.0.0-RC9')).toBeGreaterThan(0);
  });

  it('puts named dev branches below every numbered version', () => {
    expect(compareNormalized('dev-main', '0.0.1.0-dev')).toBeLessThan(0);
    expect(compareNormalized('dev-a', 'dev-b')).toBeLessThan(0);
    expect(compareNormalized('dev-a', 'dev-a')).toBe(0);
  });
});

describe('versionsFromRefs', () => {
  it('yields one version for v1.0.0 and 1.0.0', () => {
    const result = refs(['v1.0.0', '1.0.0'], [], null);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      version: '1.0.0',
      versionNormalized: '1.0.0.0',
      ref: '1.0.0',
    });
    expect(refs(['1.0.0', 'v1.0.0'], [], null)).toEqual(result);
  });

  it('prefers the ref whose name equals the pretty version over a release- ref', () => {
    const result = refs(['release-1.2', '1.2'], [], null);
    expect(result).toHaveLength(1);
    expect(result[0]?.ref).toBe('1.2');
  });

  it('falls back to the lexically first ref when none equals the pretty version', () => {
    const result = refs(['release-1.2', 'release-v1.2'], [], null);
    expect(result).toHaveLength(1);
    expect(result[0]?.ref).toBe('release-1.2');
  });

  it('sorts v1.37.0 above v1.34.0 regardless of input order', () => {
    const forward = refs(['v1.34.0', 'v1.37.0'], [], null).map((v) => v.ref);
    const reverse = refs(['v1.37.0', 'v1.34.0'], [], null).map((v) => v.ref);
    expect(forward).toEqual(['v1.37.0', 'v1.34.0']);
    expect(reverse).toEqual(forward);
  });

  it('drops invalid, -dev and dev- tags', () => {
    const result = refs(
      ['1.0.0', '1.1.0-dev', 'dev-main', 'foo', '1.2.3-SNAPSHOT', 'v1.x'],
      [],
      null,
    );
    expect(result.map((v) => v.ref)).toEqual(['1.0.0']);
  });

  it('marks the default branch and keeps branches below tags', () => {
    const result = refs(['1.0.0'], ['main', '1.x', 'develop'], 'main');
    expect(result.map((v) => [v.ref, v.versionNormalized, v.defaultBranch])).toEqual([
      ['1.x', '1.9999999.9999999.9999999-dev', false],
      ['1.0.0', '1.0.0.0', false],
      ['main', 'dev-main', true],
      ['develop', 'dev-develop', false],
    ]);
  });

  it('skips branches that conflict with constraint syntax', () => {
    expect(refs([], ['feature with space'], null)).toEqual([]);
  });

  it('every produced pair passes catalogue validation with the expected stability', () => {
    const result = refs(
      ['1.0.0', '1.0.0-RC1', '2.0.0-beta3', '3.0.0-alpha', '1.0.0-patch1'],
      ['main', '1.x'],
      'main',
    );
    const stabilities = result.map(
      (v) =>
        validateVersion({
          ecosystem: 'composer',
          version: v.version,
          versionNormalized: v.versionNormalized,
        }).stability,
    );
    expect(stabilities.sort()).toEqual(['RC', 'alpha', 'beta', 'dev', 'dev', 'stable', 'stable']);
  });

  it('never stores 9999999-dev for the default branch', () => {
    const result = refs([], ['1.x', '9999999-dev'], '1.x');
    expect(result.some((v) => v.versionNormalized === '9999999-dev')).toBe(false);
  });

  it('marks the default flag on the winner when branches collide', () => {
    for (const [branches, def] of [
      [['1.x', 'v1.x'], 'v1.x'],
      [['v1.x', '1.x'], '1.x'],
      [['1.X', '1.x'], '1.X'],
      [['1.x', '1.X'], '1.x'],
    ] as const) {
      const result = refs([], branches, def);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ ref: def, defaultBranch: true });
    }
  });

  it('counts refs the catalogue rejects without echoing names', () => {
    const long = `a${'b'.repeat(300)}`;
    const result = versionsFromRefs(
      ['1.0.0@beta', 'foo@dev', '1.0.0', 'dev-main', '2.0.0-dev'],
      ['1.99999999', long, 'main'],
      null,
    );
    expect(result.versions.map((v) => v.ref).sort()).toEqual(['1.0.0', 'main']);
    expect(result.skipped).toBe(4);
    expect(Object.keys(result).sort()).toEqual(['skipped', 'versions']);
  });
});
