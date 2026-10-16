import { describe, expect, it } from 'vitest';
import {
  MAX_KEY_LENGTH,
  PackageNameError,
  displayName,
  packageKey,
  searchableName,
} from './names.js';

const long = `A${'b'.repeat(106)}${'C'.repeat(107)}`;

describe('npm keys', () => {
  const corpus = ['JSONStream', 'left-pad', '@Scope/Pkg', '@types/node', 'a', long];

  it.each(corpus)('round-trips %s', (name) => {
    const key = packageKey(name, { ecosystem: 'npm', legacyCase: true });
    expect(key).toBe(key.toLowerCase());
    expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
    expect(displayName(key)).toBe(name);
  });

  it('keeps the 214-character corpus entry at the length limit', () => {
    expect(long).toHaveLength(214);
    expect(packageKey(long, { ecosystem: 'npm', legacyCase: true })).toHaveLength(214 + 107 + 1);
  });

  it('separates capitalised and lowercase spellings but searches them together', () => {
    const upper = packageKey('JSONStream', { ecosystem: 'npm', legacyCase: true });
    const lower = packageKey('jsonstream', { ecosystem: 'npm' });
    expect(upper).toBe('!j!s!o!n!stream');
    expect(upper).not.toBe(lower);
    expect(searchableName(upper)).toBe('jsonstream');
    expect(searchableName(lower)).toBe('jsonstream');
  });

  it.each([
    ['exclamation mark', 'bad!name'],
    ['leading dot', '.hidden'],
    ['leading underscore', '_private'],
    ['space', 'has space'],
    ['empty', ''],
    ['over 214 characters', 'a'.repeat(215)],
    ['leading dot in scope', '@.s/pkg'],
    ['empty scope', '@/pkg'],
    ['empty name', '@s/'],
    ['second slash', '@s/a/b'],
    ['slash without scope', 'a/b'],
    ['star', 'a*b'],
    ['percent', 'a%2fb'],
  ])('refuses %s', (_label, name) => {
    expect(() => packageKey(name, { ecosystem: 'npm', legacyCase: true })).toThrow(
      PackageNameError,
    );
  });

  it('refuses capitals without legacyCase', () => {
    expect(() => packageKey('JSONStream', { ecosystem: 'npm' })).toThrow(PackageNameError);
    expect(() => packageKey('Abc', { ecosystem: 'npm', legacyCase: false })).toThrow(
      PackageNameError,
    );
  });
});

describe('displayName', () => {
  it.each(['a!', '!1', '!!a', 'a!B'])('refuses malformed encoding %s', (key) => {
    expect(() => displayName(key)).toThrow(PackageNameError);
  });
});

describe('composer keys', () => {
  it('shares a key between spellings that differ only in case', () => {
    const a = packageKey('Symfony/Console', { ecosystem: 'composer' });
    expect(a).toBe('symfony/console');
    expect(packageKey('SYMFONY/console', { ecosystem: 'composer' })).toBe(a);
    expect(displayName(a)).toBe(a);
  });

  it.each([
    'novendor',
    '/name',
    'vendor/',
    'a/b/c',
    '-v/name',
    'v/name-',
    'v/na me',
    'v/na!me',
    'v/a---b',
    'v__x/name',
    '',
  ])('refuses %j', (name) => {
    expect(() => packageKey(name, { ecosystem: 'composer' })).toThrow(PackageNameError);
  });

  it('accepts dots, underscores and hyphens inside segments', () => {
    expect(packageKey('my-vendor/pkg_name.x', { ecosystem: 'composer' })).toBe(
      'my-vendor/pkg_name.x',
    );
  });
});

const npm = { ecosystem: 'npm' } as const;
const npmLegacy = { ecosystem: 'npm', legacyCase: true } as const;
const composer = { ecosystem: 'composer' } as const;

function elapsed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('hostile input runs in linear time', () => {
  it.each([
    ['composer vendor', 'a'.repeat(400) + '!', composer],
    ['composer name', 'v/' + 'a'.repeat(400) + '!', composer],
    ['composer separators', 'a-'.repeat(200) + '!', composer],
    ['npm name', 'a'.repeat(200) + '!', npm],
    ['npm scoped', '@' + 'a'.repeat(100) + '/' + 'b'.repeat(100) + '!', npmLegacy],
    ['npm separators', 'a.'.repeat(100) + '!', npmLegacy],
  ])('refuses %s quickly', (_label, name, options) => {
    expect(
      elapsed(() => {
        expect(() => packageKey(name, options)).toThrow(PackageNameError);
      }),
    ).toBeLessThan(500);
  });
});

describe('npm rules', () => {
  it('accepts a tilde only with legacyCase', () => {
    expect(() => packageKey('a~b', npm)).toThrow(PackageNameError);
    expect(packageKey('a~b', npmLegacy)).toBe('a~b');
  });

  it.each(['node_modules', 'Node_Modules', 'favicon.ico', 'FAVICON.ICO'])(
    'refuses reserved name %s',
    (name) => {
      expect(() => packageKey(name, npmLegacy)).toThrow(PackageNameError);
    },
  );

  it('accepts a scoped package segment starting with . or _ only with legacyCase', () => {
    expect(packageKey('@x/_y', npmLegacy)).toBe('@x/_y');
    expect(packageKey('@x/.y', npmLegacy)).toBe('@x/.y');
    expect(() => packageKey('@x/_y', npm)).toThrow(PackageNameError);
    expect(() => packageKey('@_x/y', npmLegacy)).toThrow(PackageNameError);
    expect(() => packageKey('_y', npmLegacy)).toThrow(PackageNameError);
  });

  it.each(["it's", 'a(b)', 'a*b', 'a!b'])(
    'refuses legacy character in %s even with legacyCase',
    (name) => {
      expect(() => packageKey(name, npmLegacy)).toThrow(PackageNameError);
    },
  );

  it.each(['@s', '@S/pkg', '@s/Pkg'])('refuses %s without legacyCase', (name) => {
    expect(() => packageKey(name, npm)).toThrow(PackageNameError);
  });

  it.each(['café', 'ａbc', 'аbc', 'a\n', 'a\t', 'a\u212a'])(
    'refuses non-ASCII or whitespace %j',
    (name) => {
      expect(() => packageKey(name, npmLegacy)).toThrow(PackageNameError);
    },
  );

  it('accepts a key of exactly 428 characters', () => {
    const key = packageKey('A'.repeat(214), npmLegacy);
    expect(key).toHaveLength(MAX_KEY_LENGTH);
    expect(displayName(key)).toBe('A'.repeat(214));
  });

  it('computes the searchable form of a scoped encoded key', () => {
    expect(searchableName(packageKey('@Scope/Pkg', npmLegacy))).toBe('@scope/pkg');
  });

  it('requires an ecosystem', () => {
    // @ts-expect-error ecosystem is required
    expect(() => packageKey('a', {})).toThrow(PackageNameError);
  });
});

describe('composer extras', () => {
  it.each(['véndor/name', 'vendor/nаme', 'vendor/name\n', 'vendor/name\t', 'a\u212a/b'])(
    'refuses non-ASCII or whitespace %j',
    (name) => {
      expect(() => packageKey(name, composer)).toThrow(PackageNameError);
    },
  );

  it('refuses names longer than 428 characters', () => {
    expect(() => packageKey('v/' + 'a'.repeat(427), composer)).toThrow(PackageNameError);
    expect(packageKey('v/' + 'a'.repeat(426), composer)).toHaveLength(428);
  });

  it('leaves a composer key unchanged for search', () => {
    expect(searchableName('symfony/console')).toBe('symfony/console');
  });
});

describe('displayName extras', () => {
  it('refuses an uppercase key', () => {
    expect(() => displayName('A')).toThrow(PackageNameError);
  });
});
