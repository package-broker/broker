import { describe, expect, it } from 'vitest';
import { InvalidVersionError, normalizeBranch, normalizeVersion } from './version-parser.js';

const VALID: ReadonlyArray<readonly [string, string]> = [
  ['v1.2.3', '1.2.3.0'],
  ['1.2.3', '1.2.3.0'],
  ['V1.2.3', '1.2.3.0'],
  ['1.2.3-RC1', '1.2.3.0-RC1'],
  ['1.2.3-rc.1', '1.2.3.0-RC1'],
  ['1.2.3-beta.2', '1.2.3.0-beta2'],
  ['1.2.3-beta2', '1.2.3.0-beta2'],
  ['1.2', '1.2.0.0'],
  ['1', '1.0.0.0'],
  ['v1', '1.0.0.0'],
  ['v2.0.0-alpha', '2.0.0.0-alpha'],
  ['v2.0.0-alpha.1', '2.0.0.0-alpha1'],
  ['2.0.0-a1', '2.0.0.0-alpha1'],
  ['2.0.0-b3', '2.0.0.0-beta3'],
  ['1.0.0-patch1', '1.0.0.0-patch1'],
  ['1.0.0-pl2', '1.0.0.0-patch2'],
  ['1.0.0-p1', '1.0.0.0-patch1'],
  ['1.0.0-stable', '1.0.0.0'],
  ['1.0.0.1', '1.0.0.1'],
  ['1.2.3-alpha-1', '1.2.3.0-alpha1'],
  ['1.2.3.RC1', '1.2.3.0-RC1'],
  ['1.2.3RC1', '1.2.3.0-RC1'],
  ['v1.37.0', '1.37.0.0'],
  ['3.4.4', '3.4.4.0'],
  ['99999.0.0', '99999.0.0.0'],
  ['1.2.3-beta.2.1', '1.2.3.0-beta2.1'],
  ['1.0.0-rc', '1.0.0.0-RC'],
  ['  1.2.3  ', '1.2.3.0'],
  ['1.2.3-', '1.2.3.0'],
  ['1.2.3\n', '1.2.3.0'],
  ['1.0.0-STABLE', '1.0.0.0-stable'],
  ['1.0.0-dev', '1.0.0.0-dev'],
  ['v1.0.0-dev', '1.0.0.0-dev'],
  ['1.0.0-beta-dev', '1.0.0.0-beta-dev'],
];

const INVALID: readonly string[] = [
  '1.0.0.1.2',
  '1.2.3-SNAPSHOT',
  'foo',
  'v6.0.0-next.1',
  '7.0.0-next.9',
  'v1.x',
  '',
  '   ',
  'v',
  '1..2',
  '.1.2',
  '1.2.3 beta',
  ' 1.2.3',
  '１.２.３',
];

describe('normalizeVersion numeric and suffix grammar', () => {
  it.each(VALID)('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  it.each(INVALID)('refuses %j', (input) => {
    expect(() => normalizeVersion(input)).toThrow(InvalidVersionError);
  });

  it('carries the offending input in the error', () => {
    expect(() => normalizeVersion('foo')).toThrow('Invalid version string "foo"');
  });

  it('refuses a long ambiguous digit run quickly', () => {
    const started = Date.now();
    expect(() => normalizeVersion(`1.0.0-beta${'1'.repeat(240)}x`)).toThrow(InvalidVersionError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('accepts 255 characters and refuses 256 with code too_long', () => {
    const at = `1.0.0-beta${'1'.repeat(245)}`;
    expect(at).toHaveLength(255);
    expect(normalizeVersion(at)).toMatch(/^1\.0\.0\.0-beta1+$/);
    const over = `${at}1`;
    expect(() => normalizeVersion(over)).toThrow(InvalidVersionError);
    try {
      normalizeVersion(over);
    } catch (error) {
      expect((error as InvalidVersionError).code).toBe('too_long');
    }
  });

  it('trims before the length check', () => {
    expect(normalizeVersion(`  ${'1.0.0-beta' + '1'.repeat(245)}  `)).toMatch(
      /^1\.0\.0\.0-beta1+$/,
    );
  });

  it('caps the message at 128 characters, escaped, and keeps the full input on a property', () => {
    const input = `"${'x'.repeat(300)}`;
    try {
      normalizeVersion(input);
      expect.unreachable();
    } catch (error) {
      const e = error as InvalidVersionError;
      expect(e.code).toBe('too_long');
      expect(e.input).toBe(input);
      expect(e.message).toBe(`Invalid version string ${JSON.stringify(input.slice(0, 128))}`);
      expect(e.message).not.toContain('x'.repeat(129));
    }
    try {
      normalizeVersion('foo\n"bar');
    } catch (error) {
      const e = error as InvalidVersionError;
      expect(e.code).toBe('invalid');
      expect(e.message).toBe('Invalid version string "foo\\n\\"bar"');
    }
  });
});

const SPIKE_14: ReadonlyArray<readonly [string, string]> = [
  ['1.0.0+build.5', '1.0.0.0'],
  ['1.0.0-RC1+meta', '1.0.0.0-RC1'],
  ['2023.01.15', '2023.01.15.0'],
  ['20230115', '20230115'],
  ['2023-01-15-10-00', '2023.01.15.10.00'],
  ['123456.0.0', '123456.0.0'],
  ['dev-main', 'dev-main'],
  ['1.0.0@dev', '1.0.0.0'],
  ['1.0.0 as 2.0.0', '1.0.0.0'],
  ['dev-master', 'dev-master'],
  ['1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['2.4.x-dev', '2.4.9999999.9999999-dev'],
  ['master', 'dev-master'],
  ['trunk', 'dev-trunk'],
  ['1.0.0-beta@beta', '1.0.0.0-beta'],
];

const SPIKE_16: ReadonlyArray<readonly [string, string]> = [
  ['1.0.0', '1.0.0.0'],
  ['v1.0.0', '1.0.0.0'],
  ['1.0', '1.0.0.0'],
  ['1', '1.0.0.0'],
  ['1.2.3.4', '1.2.3.4'],
  ['1.0.0-beta1', '1.0.0.0-beta1'],
  ['1.0.0-b2', '1.0.0.0-beta2'],
  ['1.0.0-RC1', '1.0.0.0-RC1'],
  ['1.0.0rc1', '1.0.0.0-RC1'],
  ['1.0.0-alpha.3', '1.0.0.0-alpha3'],
  ['1.0.0-patch1', '1.0.0.0-patch1'],
  ['1.0.0-pl2', '1.0.0.0-patch2'],
  ['1.0.0-p3', '1.0.0.0-patch3'],
  ['1.0.0-stable', '1.0.0.0'],
  ['1.0.0-dev', '1.0.0.0-dev'],
  ['1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['1.2.x-dev', '1.2.9999999.9999999-dev'],
  ['2.*-dev', '2.9999999.9999999.9999999-dev'],
  ['dev-main', 'dev-main'],
  ['dev-master', 'dev-master'],
  ['master', 'dev-master'],
  ['dev-feature/foo', 'dev-feature/foo'],
  ['dev-1.x', 'dev-1.x'],
  ['1.0.0+build.5', '1.0.0.0'],
  ['20261014', '20261014'],
  ['2026.10.14', '2026.10.14.0'],
  ['2026-10-14', '2026.10.14'],
  ['1.0.0@beta', '1.0.0.0'],
  ['1.0.0-dev@dev', '1.0.0.0-dev'],
  ['v2.4.7-p3', '2.4.7.0-patch3'],
  ['2.4.7-p3', '2.4.7.0-patch3'],
];

const SPIKE_14_GOTCHA_7: readonly string[] = [
  '1.0.0.1.2',
  '1.2.3-SNAPSHOT',
  'foo',
  'v6.0.0-next.1',
  '7.0.0-next.9',
  'v1.x',
  'not-a-version',
  '1.0.0-foo',
];

describe('normalizeVersion recorded vectors', () => {
  it.each([...SPIKE_14, ...SPIKE_16])('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  it.each(SPIKE_14_GOTCHA_7)('refuses %j', (input) => {
    expect(() => normalizeVersion(input)).toThrow(InvalidVersionError);
  });

  it('normalizes x.y.z, x.y.z.0 and vx.y.z identically', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3.0');
    expect(normalizeVersion('1.2.3.0')).toBe('1.2.3.0');
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3.0');
  });

  it('strips build metadata so a rebuilt tag cannot shadow the release', () => {
    expect(normalizeVersion('v1.0.0')).toBe(normalizeVersion('1.0.0+build.5'));
  });

  it('keeps dev- names verbatim after the prefix, case-folding the prefix', () => {
    expect(normalizeVersion('DEV-Feature/Foo')).toBe('dev-Feature/Foo');
  });

  it('refuses build metadata that contains whitespace', () => {
    expect(() => normalizeVersion('1.0.0+a b')).toThrow(InvalidVersionError);
  });

  it('refuses a long date-shaped digit run quickly', () => {
    const started = Date.now();
    expect(() => normalizeVersion(`2023${'1'.repeat(200)}x`)).toThrow(InvalidVersionError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('normalizeBranch and trailing dev', () => {
  it.each([
    ['1.x -dev', '1.9999999.9999999.9999999-dev'],
    ['1.x\t-dev', '1.9999999.9999999.9999999-dev'],
    ['1.2.x dev', '1.2.9999999.9999999-dev'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  it.each([
    [' 1.x ', '1.9999999.9999999.9999999-dev'],
    ['v1.2', '1.2.9999999.9999999-dev'],
    ['1.*', '1.9999999.9999999.9999999-dev'],
    ['main', 'dev-main'],
    [' feature/foo ', 'dev-feature/foo'],
    ['2.4-develop', 'dev-2.4-develop'],
  ])('normalizeBranch %j gives %j', (input, expected) => {
    expect(normalizeBranch(input)).toBe(expected);
  });
});
