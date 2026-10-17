import * as z from 'zod/mini';
import type { ApiSlot, RouteDefinition } from '../plugin.js';
import { describe, expect, it } from 'vitest';
import {
  routeApiProblems,
  RESERVED_PATH_PREFIXES,
  routePathProblem,
  routesConflict,
} from './routes.js';

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

describe('routeApiProblems', () => {
  const api: ApiSlot = {
    operationId: 'listUsers',
    summary: 'List users',
    tags: ['users'],
    responses: { 200: z.array(z.string()) },
  };
  const route = { method: 'GET', path: '/_pb/users', api } as const;

  it('rejects an api slot outside the API prefix', () => {
    expect(routeApiProblems({ ...route, path: '/p2/x' }, 'route')).toEqual([
      'route: api is only allowed under /_pb/',
    ]);
  });

  it.each(['/_pb/ui', '/_pb/ui/assets/:file', '/_pb/mcp', '/_pb/openapi.json'])(
    'accepts an exemption on %s',
    (path) => {
      expect(
        routeApiProblems({ ...route, path, api: { exempt: 'static' } }, 'route', {
          requireApi: true,
        }),
      ).toEqual([]);
    },
  );

  it('rejects an exemption on an API route', () => {
    expect(routeApiProblems({ ...route, api: { exempt: 'static' } }, 'route')).toHaveLength(1);
  });

  it('rejects an exemption mixed with API slot fields', () => {
    expect(
      routeApiProblems(
        {
          ...route,
          path: '/_pb/ui',
          api: { exempt: 'static', operationId: 'listUsers', body: z.string() },
        },
        'route',
      ),
    ).toHaveLength(1);
  });

  it.each(['', 'x'.repeat(121), 42])('rejects exemption reason %j', (exempt) => {
    expect(routeApiProblems({ ...route, path: '/_pb/ui', api: { exempt } }, 'route')).toHaveLength(
      1,
    );
  });

  it('allows an undocumented route by default', () => {
    expect(routeApiProblems({ method: 'GET', path: '/_pb/users' }, 'route')).toEqual([]);
  });

  it('requires a slot when enabled', () => {
    expect(
      routeApiProblems({ method: 'GET', path: '/_pb/users' }, 'route', { requireApi: true }),
    ).toHaveLength(1);
  });

  it('accepts a documented route when required', () => {
    expect(routeApiProblems(route, 'route', { requireApi: true })).toEqual([]);
  });

  it.each([
    ['operationId', { operationId: 'Bad-Id' }],
    ['tags', { tags: [] }],
    ['success response', { responses: { 400: null } }],
    ['response range', { responses: { 99: null, 200: null } }],
    ['summary length', { summary: 'x'.repeat(121) }],
    ['empty summary', { summary: '' }],
    ['empty tag', { tags: [''] }],
    ['tag count', { tags: Array<string>(9).fill('users') }],
    ['response integer', { responses: { 200: null, 201.5: null } }],
    ['response upper bound', { responses: { 200: null, 600: null } }],
  ])('rejects invalid %s', (_name, patch) => {
    expect(routeApiProblems({ ...route, api: { ...api, ...patch } }, 'route')).toHaveLength(1);
  });

  it('rejects mcp true on POST', () => {
    expect(
      routeApiProblems({ ...route, method: 'POST', api: { ...api, mcp: true } }, 'route'),
    ).toHaveLength(1);
  });

  it('accepts mcp true on GET and false on POST', () => {
    expect(routeApiProblems({ ...route, api: { ...api, mcp: true } }, 'route')).toEqual([]);
    expect(
      routeApiProblems({ ...route, method: 'POST', api: { ...api, mcp: false } }, 'route'),
    ).toEqual([]);
  });

  it('requires Zod schemas in the typed slot', () => {
    const definition: RouteDefinition = {
      ...route,
      permission: null,
      handler: () => new Response(),
      api: {
        ...api,
        // @ts-expect-error body must be a Zod schema
        body: { not: 'a schema' },
      },
    };
    expect(definition.api).toBeDefined();
  });
});
