import { describe, expect, it } from 'vitest';
import {
  PROJECT_SLUG_PATTERN,
  isValidProjectSlug,
  pluginPrefixProblem,
  projectSlugProblem,
  reservedFirstSegments,
  resolveProjectPath,
} from './project-path.js';

const routes = [
  { path: '/health' },
  { path: '/auth/login' },
  { path: '/setup' },
  { path: '/callback/:provider' },
  { path: '/login' },
  { path: '/_pb/projects/:project/grants' },
  { path: '/.well-known/jwks' },
  { path: '/:wild/thing' },
  { path: '/reports/daily' },
];
const reserved = reservedFirstSegments(routes);

describe('project slug grammar', () => {
  it.each(['a', 'acme', 'a1', 'a-b', 'a--b', '0', '9z', 'a'.repeat(64)])('accepts %s', (slug) => {
    expect(isValidProjectSlug(slug)).toBe(true);
  });

  it.each([
    '',
    '-a',
    'a-',
    'A',
    'aB',
    'a_b',
    'a.b',
    'a b',
    'a/b',
    'a\\b',
    'a%61',
    'ä',
    'a'.repeat(65),
    ' a',
    'a\n',
    '..',
    '.',
  ])('rejects %j', (slug) => {
    expect(isValidProjectSlug(slug)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidProjectSlug(undefined as unknown as string)).toBe(false);
    expect(isValidProjectSlug(42 as unknown as string)).toBe(false);
  });
});

describe('reserved set', () => {
  it('always holds health and _pb', () => {
    const bare = reservedFirstSegments([]);
    expect(bare.has('health')).toBe(true);
    expect(bare.has('_pb')).toBe(true);
  });

  it('derives literal first segments from the route table', () => {
    for (const name of ['health', '_pb', 'auth', 'setup', 'callback', 'login', 'reports']) {
      expect(reserved.has(name)).toBe(true);
    }
  });

  it('ignores parameter first segments', () => {
    expect(reserved.has(':wild')).toBe(false);
    expect(reserved.has('wild')).toBe(false);
  });

  it('reserves the static floor without any routes', () => {
    const bare = reservedFirstSegments([]);
    for (const name of ['health', '_pb', 'auth', 'setup', 'callback', 'login', '.well-known']) {
      expect(bare.has(name)).toBe(true);
    }
  });

  it('lowercases first segments from the route table', () => {
    expect(reservedFirstSegments([{ path: '/Reports/x' }]).has('reports')).toBe(true);
  });

  it('refuses a reserved slug at creation', () => {
    expect(projectSlugProblem('auth', reserved)).not.toBeNull();
    expect(projectSlugProblem('reports', reserved)).not.toBeNull();
    expect(projectSlugProblem('health', reserved)).not.toBeNull();
    expect(projectSlugProblem('Acme', reserved)).not.toBeNull();
    expect(projectSlugProblem('acme', reserved)).toBeNull();
  });

  it('refuses a plugin prefix that matches an existing slug', () => {
    expect(pluginPrefixProblem('/acme/tools', new Set(['acme']))).not.toBeNull();
    expect(pluginPrefixProblem('/acme', new Set(['acme']))).not.toBeNull();
    expect(pluginPrefixProblem('/other/tools', new Set(['acme']))).toBeNull();
    expect(pluginPrefixProblem('/', new Set(['acme']))).toBeNull();
    expect(pluginPrefixProblem('/ACME/tools', new Set(['acme']))).not.toBeNull();
    expect(pluginPrefixProblem('/:x/tools', new Set(['acme']))).not.toBeNull();
    expect(pluginPrefixProblem('acme/tools', new Set(['acme']))).not.toBeNull();
  });
});

describe('resolveProjectPath', () => {
  it('resolves every path family to the same slug', () => {
    const paths = [
      '/acme/packages.json',
      '/acme/p2/vendor/pkg.json',
      '/acme/dist/vendor/pkg/1.0.0/ref.zip',
      '/acme/npm/left-pad',
      '/_pb/projects/acme/grants',
      '/_pb/projects/acme',
    ];
    for (const path of paths) {
      const result = resolveProjectPath(path, reserved);
      expect(result.ok && result.slug).toBe('acme');
    }
  });

  it('reports the family and the raw remainder', () => {
    expect(resolveProjectPath('/acme/packages.json', reserved)).toEqual({
      ok: true,
      slug: 'acme',
      family: 'packages.json',
      rest: [],
    });
    expect(resolveProjectPath('/acme/p2/vendor/pkg~dev.json', reserved)).toEqual({
      ok: true,
      slug: 'acme',
      family: 'p2',
      rest: ['vendor', 'pkg~dev.json'],
    });
    expect(resolveProjectPath('/_pb/projects/acme/grants/x', reserved)).toEqual({
      ok: true,
      slug: 'acme',
      family: 'api',
      rest: ['grants', 'x'],
    });
  });

  it('leaves an encoded slash in p2, dist and api segments to the owning route', () => {
    for (const path of [
      '/acme/dist/dev-feature%2Fx',
      '/acme/p2/a%2fb',
      '/_pb/projects/acme/a%2Fb',
    ]) {
      expect(resolveProjectPath(path, reserved).ok).toBe(true);
    }
    expect(resolveProjectPath('/acme/dist/.hidden/x..y/a.%2e', reserved).ok).toBe(true);
  });

  it('accepts a URL and reads its raw pathname', () => {
    const ok = resolveProjectPath(new URL('http://x/acme/npm/@scope%2Fpkg'), reserved);
    expect(ok).toMatchObject({ ok: true, slug: 'acme', rest: ['@scope%2Fpkg'] });
    expect(resolveProjectPath(new URL('http://x/%61cme/packages.json'), reserved)).toEqual({
      ok: false,
    });
    expect(resolveProjectPath(new URL('http://x/ac%5Cme/packages.json'), reserved)).toEqual({
      ok: false,
    });
    expect(resolveProjectPath(new URL('http://x/%61cme/packages.json').pathname, reserved)).toEqual(
      { ok: false },
    );
  });

  it('exports the slug pattern', () => {
    expect(PROJECT_SLUG_PATTERN.test('acme')).toBe(true);
  });

  it('hands a scoped npm path to the next stage undecoded', () => {
    expect(resolveProjectPath('/acme/npm/@scope%2Fpkg', reserved)).toEqual({
      ok: true,
      slug: 'acme',
      family: 'npm',
      rest: ['@scope%2Fpkg'],
    });
    expect(resolveProjectPath('/acme/npm/@scope%2Fpkg/-/pkg-1.0.0.tgz', reserved)).toEqual({
      ok: true,
      slug: 'acme',
      family: 'npm',
      rest: ['@scope%2Fpkg', '-', 'pkg-1.0.0.tgz'],
    });
    const dotted = resolveProjectPath('/acme/npm/pkg/-/pkg-1.0.0-beta.1.tgz', reserved);
    expect(dotted.ok && dotted.rest).toEqual(['pkg', '-', 'pkg-1.0.0-beta.1.tgz']);
  });

  it('does not decode the remainder twice', () => {
    const result = resolveProjectPath('/acme/npm/%252e%252e', reserved);
    expect(result.ok && result.rest).toEqual(['%252e%252e']);
  });

  it.each([
    ['encoded slash in the slug', '/ac%2Fme/packages.json'],
    ['encoded slash lowercase', '/ac%2fme/packages.json'],
    ['encoded backslash', '/ac%5Cme/packages.json'],
    ['literal backslash', '/ac\\me/packages.json'],
    ['percent-encoded alias', '/%61cme/packages.json'],
    ['percent-encoded alias in api path', '/_pb/projects/%61cme/grants'],
    ['double-encoded alias', '/%2561cme/packages.json'],
    ['uppercase spelling', '/Acme/packages.json'],
    ['uppercase in api path', '/_pb/projects/ACME/grants'],
    ['dot segment', '/./packages.json'],
    ['dot-dot segment', '/../packages.json'],
    ['encoded dot segment', '/%2e%2e/packages.json'],
    ['dot segment in api path', '/_pb/projects/../grants'],
    ['encoded dot in api path', '/_pb/projects/%2e/grants'],
    ['leading hyphen', '/-acme/packages.json'],
    ['trailing hyphen', '/acme-/packages.json'],
    ['underscore', '/ac_me/packages.json'],
    ['dot inside slug', '/ac.me/packages.json'],
    ['non-ASCII', '/acmé/packages.json'],
    ['overlong slug', `/${'a'.repeat(65)}/packages.json`],
    ['empty slug', '//packages.json'],
    ['empty api slug', '/_pb/projects//grants'],
    ['missing api slug', '/_pb/projects'],
    ['reserved health', '/health/packages.json'],
    ['reserved auth', '/auth/packages.json'],
    ['reserved route-table segment', '/reports/packages.json'],
    ['bare _pb', '/_pb/packages.json'],
    ['reserved slug in api path', '/_pb/projects/auth/grants'],
    ['unknown family', '/acme/other/x'],
    ['no family', '/acme'],
    ['bare slug with trailing slash', '/acme/'],
    ['packages.json with trailing slash', '/acme/packages.json/'],
    ['packages.json with extra segment', '/acme/packages.json/x'],
    ['no leading slash', 'acme/packages.json'],
    ['empty path', ''],
    ['root', '/'],
    ['query smuggled in path', '/acme/packages.json?project=other'],
    ['fragment smuggled in path', '/acme/packages.json#x'],
    ['control character', '/acme\u0000/packages.json'],
    ['whitespace', '/ acme/packages.json'],
    ['uppercase encoded dots', '/%2E%2E/packages.json'],
    ['encoded underscore in _pb', '/%5Fpb/projects/acme'],
    ['encoded projects keyword', '/_pb/%70rojects/acme'],
    ['uppercase _PB', '/_PB/projects/acme'],
    ['uppercase Projects keyword', '/_pb/Projects/acme'],
    ['bare p2', '/acme/p2'],
    ['bare dist', '/acme/dist'],
    ['bare npm', '/acme/npm'],
    ['p2 trailing slash', '/acme/p2/'],
    ['p2 double slash', '/acme/p2//x'],
    ['p2 trailing slash after name', '/acme/p2/vendor/'],
    ['api trailing slash', '/_pb/projects/acme/'],
    ['api double slash', '/_pb/projects/acme//grants'],
    ['p2 dot segment', '/acme/p2/./x'],
    ['p2 dot-dot segment', '/acme/p2/../x'],
    ['dist dot-dot segment', '/acme/dist/../x'],
    ['api dot-dot segment', '/_pb/projects/acme/../x'],
    ['p2 encoded dots', '/acme/p2/%2e%2E/x'],
    ['dist mixed encoded dots', '/acme/dist/.%2e/x'],
    ['dist mixed encoded dots 2', '/acme/dist/%2e./x'],
    ['api single encoded dot', '/_pb/projects/acme/%2e'],
    ['npm encoded dot-dot', '/acme/npm/%2e%2E'],
    ['npm mixed encoded dot-dot', '/acme/npm/.%2E'],
    ['npm encoded dot', '/acme/npm/pkg/%2e'],
    ['npm encoded backslash', '/acme/npm/a%5Cb'],
    ['p2 encoded NUL', '/acme/p2/a%00b'],
    ['dist encoded control', '/acme/dist/a%1fb'],
    ['api encoded DEL', '/_pb/projects/acme/a%7Fb'],
    ['npm encoded tab', '/acme/npm/a%09b'],
    ['api encoded backslash', '/_pb/projects/acme/a%5cb'],
    ['api encoded dot', '/_pb/projects/acme/%2E'],
    ['p2 literal backslash', '/acme/p2/a\\b'],
    ['npm dot segment', '/acme/npm/./x'],
    ['npm dot-dot segment', '/acme/npm/pkg/..'],
    ['npm double slash', '/acme/npm//x'],
    ['npm trailing slash', '/acme/npm/pkg/'],
    ['npm whitespace', '/acme/npm/a b'],
    ['npm encoded-looking whitespace char', '/acme/npm/a\tb'],
    ['p2 control character', '/acme/p2/a\u0007b'],
    ['reserved .well-known', '/.well-known/packages.json'],
    ['reserved setup', '/setup/packages.json'],
    ['reserved callback', '/callback/packages.json'],
    ['reserved login', '/login/packages.json'],
  ])('refuses %s', (_name, path) => {
    expect(resolveProjectPath(path, reserved)).toEqual({ ok: false });
  });

  it('refuses every failure with the same shape', () => {
    const a = resolveProjectPath('/health/packages.json', reserved);
    const b = resolveProjectPath('/%61/packages.json', reserved);
    const c = resolveProjectPath('/unknown-reserved-x/nope', reserved);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
