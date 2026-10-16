import { describe, expect, it } from 'vitest';
import { InvalidVersionError, normalizeVersion } from './version-parser.js';

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
