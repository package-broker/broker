import { describe, expect, it } from 'vitest';
import { parseNpmPath } from './paths.js';

const NOT_FOUND = { kind: 'not_found' };

describe('parseNpmPath names', () => {
  it.each([[['@changesets%2ftypes']], [['@changesets%2Ftypes']], [['@changesets', 'types']]])(
    'parses every spelling of a scoped packument %j to one key',
    (segments) => {
      expect(parseNpmPath(segments)).toEqual({ kind: 'packument', key: '@changesets/types' });
    },
  );

  it('parses an unscoped packument', () => {
    expect(parseNpmPath(['left-pad'])).toEqual({ kind: 'packument', key: 'left-pad' });
  });

  it('encodes capitals in the key for legacy names', () => {
    expect(parseNpmPath(['JSONStream'])).toEqual({ kind: 'packument', key: '!j!s!o!n!stream' });
  });

  it.each([
    [['left-pad', '1.0.0'], 'left-pad', '1.0.0'],
    [['left-pad', 'latest'], 'left-pad', 'latest'],
    [['@changesets%2ftypes', '4.1.0'], '@changesets/types', '4.1.0'],
    [['@changesets', 'types', 'next'], '@changesets/types', 'next'],
  ])('parses %j as version or tag', (segments, key, selector) => {
    expect(parseNpmPath(segments)).toEqual({ kind: 'version', key, selector });
  });
});

describe('parseNpmPath tarballs', () => {
  it.each([
    [['left-pad', '-', 'left-pad-1.0.0.tgz'], 'left-pad', '1.0.0'],
    [['@changesets%2ftypes', '-', 'types-4.1.0.tgz'], '@changesets/types', '4.1.0'],
    [['@changesets%2Ftypes', '-', 'types-4.1.0.tgz'], '@changesets/types', '4.1.0'],
    [['%40changesets%2ftypes', '-', 'types-4.1.0.tgz'], '@changesets/types', '4.1.0'],
    [['@changesets', 'types', '-', 'types-4.1.0.tgz'], '@changesets/types', '4.1.0'],
  ])('parses %j', (segments, key, version) => {
    expect(parseNpmPath(segments)).toEqual({
      kind: 'tarball',
      key,
      version,
      file: segments[segments.length - 1],
    });
  });

  it('accepts a prerelease version', () => {
    expect(parseNpmPath(['a', '-', 'a-1.0.0-beta.1.tgz'])).toMatchObject({
      kind: 'tarball',
      version: '1.0.0-beta.1',
    });
  });

  it.each([
    [['left-pad', '-', 'other-1.0.0.tgz']],
    [['left-pad', '-', 'left-pad-1.0.tgz']],
    [['left-pad', '-', 'left-pad-1.0.0.tar']],
    [['left-pad', '-', 'left-pad-.tgz']],
    [['left-pad', '-', 'left-pad-01.0.0.tgz']],
    [['@changesets', 'types', '-', 'changesets-types-4.1.0.tgz']],
    [['left-pad', '-']],
    [['left-pad', '-', 'left-pad-1.0.0+build.5.tgz']],
    [['left-pad', '%2d', 'left-pad-1.0.0.tgz']],
    [['left-pad', 'x', 'left-pad-1.0.0.tgz']],
    [['left-pad', '-', 'left-pad-1.0.0.tgz', 'extra']],
  ])('refuses %j', (segments) => {
    expect(parseNpmPath(segments)).toEqual(NOT_FOUND);
  });
});

describe('parseNpmPath selectors', () => {
  it.each([128, 129, 256])('accepts a selector of %i characters', (length) => {
    const selector = '1'.repeat(length);
    expect(parseNpmPath(['a', selector])).toEqual({ kind: 'version', key: 'a', selector });
  });

  it.each(['_next', '-beta', 'v1.x', 'next+tag'])('accepts the dist-tag %s', (selector) => {
    expect(parseNpmPath(['a', selector])).toEqual({ kind: 'version', key: 'a', selector });
  });

  it('accepts a scoped legacy name with capitals in the name part', () => {
    expect(parseNpmPath(['@scope%2fPkg'])).toEqual({ kind: 'packument', key: '@scope/!pkg' });
  });
});

describe('parseNpmPath specials', () => {
  it.each([
    [['-', 'whoami'], { kind: 'whoami' }],
    [['-', 'ping'], { kind: 'ping' }],
    [['-', 'v1', 'search'], { kind: 'search' }],
    [['-', 'npm', 'v1', 'security', 'advisories', 'bulk'], { kind: 'audit' }],
    [['-', 'package', 'left-pad', 'dist-tags'], { kind: 'dist_tags', key: 'left-pad' }],
    [
      ['-', 'package', '@changesets%2ftypes', 'dist-tags'],
      { kind: 'dist_tags', key: '@changesets/types' },
    ],
    [
      ['-', 'package', '@changesets%2Ftypes', 'dist-tags'],
      { kind: 'dist_tags', key: '@changesets/types' },
    ],
    [
      ['-', 'package', '@changesets', 'types', 'dist-tags'],
      { kind: 'dist_tags', key: '@changesets/types' },
    ],
  ])('parses %j', (segments, expected) => {
    expect(parseNpmPath(segments)).toEqual(expected);
  });

  it.each([
    [['-']],
    [['-', 'whoami', 'x']],
    [['-', 'unknown']],
    [['-', 'package', '-', 'dist-tags']],
    [['-', 'package', 'left-pad']],
    [['-', 'package', 'left-pad', 'dist-tags', 'latest']],
    [['-', 'package', '@changesets', 'dist-tags']],
  ])('refuses %j', (segments) => {
    expect(parseNpmPath(segments)).toEqual(NOT_FOUND);
  });
});

describe('parseNpmPath hostile input', () => {
  it.each([
    ['empty path', []],
    ['empty segment', ['']],
    ['empty trailing segment', ['left-pad', '']],
    ['dot', ['.']],
    ['dot dot', ['..']],
    ['encoded dot dot', ['%2e%2e']],
    ['encoded dot dot after name', ['left-pad', '%2E%2E']],
    ['dot in scoped part', ['@scope', '..']],
    ['traversal in scoped form', ['@scope%2f..']],
    ['double-encoded slash', ['@scope%252fname']],
    ['double-encoded percent', ['left%2570ad']],
    ['percent sign alone', ['left%25pad']],
    ['encoded backslash', ['left%5cpad']],
    ['literal backslash', ['left\\pad']],
    ['encoded slash in unscoped name', ['left%2fpad']],
    ['encoded slash in version', ['left-pad', '1%2f2']],
    ['two encoded slashes in scoped name', ['@a%2fb%2fc']],
    ['scoped form followed by empty', ['@scope%2f']],
    ['scope only', ['@scope']],
    ['empty scoped name', ['@scope%2f']],
    ['invalid escape', ['left%zzpad']],
    ['truncated escape', ['left%2']],
    ['encoded NUL', ['left%00pad']],
    ['encoded newline', ['left%0apad']],
    ['bad UTF-8', ['%ff']],
    ['reserved name', ['node_modules']],
    ['dash name via encoding', ['%2d', '1.0.0']],
    ['encoded dash special prefix', ['%2d', 'whoami']],
    ['encoded dash package prefix', ['%2d', 'package', 'left-pad', 'dist-tags']],
    ['question mark in name', ['left?pad']],
    ['question mark in selector', ['left-pad', '1.0.0?x']],
    ['non-ASCII', ['caf%C3%A9']],
    ['non-ASCII selector', ['left-pad', '%C3%A9']],
    ['dot-leading scope', ['@.scope%2fname']],
    ['dot-leading scoped name', ['@scope', '.name']],
    ['dots-only scoped name', ['@scope%2f...']],
    ['uppercase scope', ['@Scope%2fname']],
    ['uppercase scope two segments', ['@Scope', 'name']],
    ['selector of 257', ['a', 'v'.repeat(257)]],
    ['dash version name', ['-', '-']],
    ['space', ['left%20pad']],
    ['too many segments', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    ['overlong name', ['a'.repeat(215)]],
    ['overlong raw segment', ['a'.repeat(5000)]],
    ['overlong scoped', [`@${'a'.repeat(300)}%2fb`]],
  ] as [string, string[]][])('refuses %s', (_label, segments) => {
    expect(parseNpmPath(segments)).toEqual(NOT_FOUND);
  });
});
