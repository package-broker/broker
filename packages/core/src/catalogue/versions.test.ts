import { describe, expect, it } from 'vitest';
import { normalizeVersion } from '../registry/composer/version-parser.js';
import { VersionError, validateVersion } from './versions.js';

const composer = (version: string, versionNormalized: string) =>
  validateVersion({ ecosystem: 'composer', version, versionNormalized });
const npm = (version: string) =>
  validateVersion({ ecosystem: 'npm', version, versionNormalized: version });

describe('composer versions', () => {
  it.each([
    ['1.2.3', '1.2.3.0', 'stable'],
    ['v1.2.3', '1.2.3.0', 'stable'],
    ['1.2', '1.2.0.0', 'stable'],
    ['1.2.3.4', '1.2.3.4', 'stable'],
    ['1.2.3-beta2', '1.2.3.0-beta2', 'beta'],
    ['1.2.3-beta.2', '1.2.3.0-beta2', 'beta'],
    ['1.2.3-RC1', '1.2.3.0-RC1', 'RC'],
    ['1.2.3-rc1', '1.2.3.0-RC1', 'RC'],
    ['1.2.3-alpha1', '1.2.3.0-alpha1', 'alpha'],
    ['1.2.3-p1', '1.2.3.0-patch1', 'stable'],
    ['1.2.3-patch1', '1.2.3.0-patch1', 'stable'],
    ['2.0.0-dev', '2.0.0.0-dev', 'dev'],
    ['dev-main', 'dev-main', 'dev'],
    ['dev-feature/x', 'dev-feature/x', 'dev'],
    ['dev-master', 'dev-master', 'dev'],
    ['1.0.0-beta', '1.0.0.0-beta', 'beta'],
    ['1.0.0-alpha', '1.0.0.0-alpha', 'alpha'],
    ['1.0.0-RC', '1.0.0.0-RC', 'RC'],
    ['1.0.0-patch', '1.0.0.0-patch', 'stable'],
    ['1.0.0-beta2-dev', '1.0.0.0-beta2-dev', 'dev'],
    ['2020.01.01', '2020.01.01.0', 'stable'],
    ['20200101', '20200101', 'stable'],
    ['dev-a+b', 'dev-a+b', 'dev'],
    ['master', 'dev-master', 'dev'],
    ['dev-1.0', 'dev-1.0', 'dev'],
    ['dev-feature_x#1', 'dev-feature_x#1', 'dev'],
    ['1.x-dev', '1.9999999.9999999.9999999-dev', 'dev'],
    ['1.0-dev', '1.0.0.0-dev', 'dev'],
    ['1.0.x-dev', '1.0.9999999.9999999-dev', 'dev'],
  ])('accepts %s as %s', (version, normalized, stability) => {
    expect(composer(version, normalized)).toEqual({ stability });
  });

  it.each([
    ['1.2.3', '1.2.4.0'],
    ['1.2.3', '1.2.3'],
    ['1.2.3', 'v1.2.3.0'],
    ['1.2.3-beta2', '1.2.3.0-beta3'],
    ['1.2.3-beta2', '1.2.3.0'],
    ['1.2.3', '1.2.3.0-dev'],
    ['1.2.3.0-gamma1', '1.2.3.0-gamma1'],
    ['1.2.3', '1.2.3.0-beta'],
    ['1.2.3', '1.2.3.0-beta2 '],
    ['dev-main', 'dev-trunk'],
    ['dev-main', 'dev-'],
    ['dev-a b', 'dev-a b'],
    ['main', 'dev-main'],
    ['dev-main', '9999999-dev'],
    ['dev-master', '9999999-dev'],
    ['master-dev', '9999999-dev'],
    ['main-dev', 'dev-main'],
    ['1.0-dev', 'dev-1.0'],
    ['1.x-dev', 'dev-1.x'],
    ['1.2.3+build', '1.2.3.0+build'],
    ['2020-01-01', '2020.01.01.0-x'],
    ['not a version', 'dev-not a version'],
    ['dev-a b', 'dev-a b'],
    ['dev-x\u0000y', 'dev-x\u0000y'],
    ['dev-x\u007fy', 'dev-x\u007fy'],
    ['1.0.0 ', '1.0.0.0'],
    [' 1.0.0', '1.0.0.0'],
    ['1.0 0', '1.0.0.0'],
    ['dev-main as 1.0.0', 'dev-main'],
    ['1.0.0 as 2.0.0', '1.0.0.0'],
    ['1.0.0@dev', '1.0.0.0'],
    ['dev-main@dev', 'dev-main'],
    ['1.0.0\n', '1.0.0.0'],
    ['', ''],
    ['1.2.3.4.5', '1.2.3.4.5'],
  ])('refuses pair %s / %s', (version, normalized) => {
    expect(() => composer(version, normalized)).toThrow(VersionError);
  });
});

describe('composer normalizer agreement', () => {
  it.each([
    '1.0.0',
    'v2.3.4',
    '3.0',
    '1.0.0-RC1',
    '1.0.0-rc.2',
    '2.0.0-alpha3',
    '1.0.0-patch1',
    '1.0.0-p2',
    '1.0.x-dev',
    '2.x-dev',
    '2.0.0-dev',
    'dev-main',
    'dev-master',
    'master',
    'dev-release/1.2',
    '2020.01.15',
    '1.2.3.4',
  ])('accepts the normalizer result for %s', (version) => {
    const normalized = normalizeVersion(version);
    expect(composer(version, normalized).stability).toBeDefined();
  });
});

describe('length caps', () => {
  it('limits composer versions to 255 characters', () => {
    const ok = `dev-${'a'.repeat(251)}`;
    expect(composer(ok, ok)).toEqual({ stability: 'dev' });
    const long = `${ok}a`;
    expect(() => composer(long, long)).toThrow(VersionError);
  });

  it('limits npm versions to 256 characters and safe integers', () => {
    const ok = `1.0.0-${'a'.repeat(250)}`;
    expect(ok).toHaveLength(256);
    expect(npm(ok)).toEqual({ stability: 'alpha' });
    expect(() => npm(`${ok}a`)).toThrow(VersionError);
    expect(npm(`${Number.MAX_SAFE_INTEGER}.0.0`)).toEqual({ stability: 'stable' });
    expect(() => npm(`${Number.MAX_SAFE_INTEGER + 2}.0.0`)).toThrow(VersionError);
  });
});

describe('npm versions', () => {
  it('classifies npm prerelease identifiers by digits-only suffix', () => {
    expect(npm('1.0.0-beta2')).toEqual({ stability: 'beta' });
    expect(npm('1.0.0-beta-1')).toEqual({ stability: 'alpha' });
    expect(npm('1.0.0-rc1')).toEqual({ stability: 'RC' });
  });

  it.each([
    ['1.0.0', 'stable'],
    ['0.0.1', 'stable'],
    ['1.0.0-rc.1', 'RC'],
    ['1.0.0-RC.1', 'RC'],
    ['1.0.0-beta.2', 'beta'],
    ['1.0.0-alpha', 'alpha'],
    ['1.0.0-next.3', 'alpha'],
    ['1.0.0-0', 'alpha'],
    ['1.0.0-x-y.rc', 'alpha'],
  ])('accepts %s as %s', (version, stability) => {
    expect(npm(version)).toEqual({ stability });
  });

  it.each([
    'v1.0.0',
    '01.0.0',
    '1.00.0',
    '1.0.0+build',
    '1.0.0-rc.1+build',
    '1.0',
    '1.0.0-',
    '1.0.0-01',
    '1.0.0-rc..1',
    ' 1.0.0',
    '',
  ])('refuses %j', (version) => {
    expect(() => npm(version)).toThrow(VersionError);
  });

  it('refuses a normalized form that differs from the version', () => {
    expect(() =>
      validateVersion({ ecosystem: 'npm', version: '1.0.0', versionNormalized: '1.0.0.0' }),
    ).toThrow(VersionError);
  });

  it('refuses an unknown ecosystem', () => {
    expect(() =>
      validateVersion({ ecosystem: 'pypi' as 'npm', version: '1.0.0', versionNormalized: '1.0.0' }),
    ).toThrow(VersionError);
  });
});
