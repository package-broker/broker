import { describe, expect, it } from 'vitest';
import { npmVersionsFromRefs } from './version-rules.js';

describe('npmVersionsFromRefs', () => {
  it('accepts semver tags, strips one v, prefers exact tags, and selects stable latest', () => {
    const result = npmVersionsFromRefs([
      'v1.0.0',
      '1.0.0',
      '2.0.0-beta.2',
      '1.10.0',
      '1.9.0',
      'vv3.0.0',
      '3.0.0+build',
      'main',
    ]);
    expect(result.versions.map(({ ref, version }) => [ref, version])).toEqual([
      ['2.0.0-beta.2', '2.0.0-beta.2'],
      ['1.10.0', '1.10.0'],
      ['1.9.0', '1.9.0'],
      ['1.0.0', '1.0.0'],
    ]);
    expect(result.latest).toBe('1.10.0');
  });
  it('compares prerelease identifiers numerically and falls back to prerelease latest', () => {
    expect(npmVersionsFromRefs(['v1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-alpha']).latest).toBe(
      '1.0.0-beta.11',
    );
    expect(npmVersionsFromRefs([]).latest).toBeNull();
  });
  it('caps the number of refs before iterating and the length of each tag', () => {
    expect(() => npmVersionsFromRefs(Array(50_001).fill('1.0.0'))).toThrow('too_many_refs');
    expect(npmVersionsFromRefs(['1.0.0-' + 'a'.repeat(251)]).versions).toEqual([]);
  });
});
