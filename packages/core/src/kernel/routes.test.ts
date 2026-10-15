import { describe, expect, it } from 'vitest';
import { RESERVED_PATH_PREFIXES, routePathProblem, routesConflict } from './routes.js';

describe('routePathProblem', () => {
  it.each(['/', '/items', '/items/:id', '/a.b/c-d_e~f', '/healthy', '/_pbx'])(
    'accepts %s',
    (path) => {
      expect(routePathProblem(path)).toBeNull();
    },
  );

  it.each([
    '',
    'items',
    '/items/',
    '//x',
    '/items/*',
    '/items/:id?',
    '/items/{id}',
    '/x/:a/:a',
    '/health/x',
    '/health',
    '/_pb/x',
    '/_pb',
    '/items/:1a',
    '/items/:',
  ])('rejects %j naming the path', (path) => {
    const problem = routePathProblem(path);
    expect(problem).toEqual(expect.any(String));
    expect(problem).toContain(JSON.stringify(path));
  });

  it('exposes the reserved prefixes', () => {
    expect(RESERVED_PATH_PREFIXES).toEqual(['/health/', '/_pb/']);
  });
});

describe('routesConflict', () => {
  it.each([
    ['GET', '/items/:id', 'GET', '/items/:name'],
    ['GET', '/items/new', 'GET', '/items/:id'],
    ['get', '/items/:id', 'GET', '/items/x'],
    ['GET', '/items/a', 'GET', '/items/a'],
    ['GET', '/', 'GET', '/'],
  ])('%s %s conflicts with %s %s', (ma, pa, mb, pb) => {
    expect(routesConflict({ method: ma, path: pa }, { method: mb, path: pb })).toBe(true);
  });

  it.each([
    ['GET', '/items/:id', 'POST', '/items/:id'],
    ['GET', '/items/:id', 'GET', '/items/:id/x'],
    ['GET', '/items/a', 'GET', '/items/b'],
    ['GET', '/', 'GET', '/items'],
  ])('%s %s does not conflict with %s %s', (ma, pa, mb, pb) => {
    expect(routesConflict({ method: ma, path: pa }, { method: mb, path: pb })).toBe(false);
  });
});
