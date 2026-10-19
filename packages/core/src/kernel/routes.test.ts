import * as z from 'zod/mini';
import { SUPPORTED_PLUGIN_API } from '../plugin.js';
import type { ApiSlot, PluginDefinition, RouteDefinition } from '../plugin.js';
import { KernelConfigError, collectRegistrations } from './registry.js';
import { describe, expect, it } from 'vitest';
import { routeDescriptors } from '../authz/catalogue.js';
import {
  routeApiProblems,
  routeBoundaryProblems,
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

describe('authenticated boundary registration', () => {
  const authenticated = {
    path: '/_pb/projects',
    method: 'GET',
    permission: null,
    boundary: 'authenticated',
  };
  const core = { allowAuthenticated: true };
  const problems = (patch: Record<string, unknown>, options: object = core): string[] =>
    routeBoundaryProblems({ ...authenticated, ...patch }, 'route', options);

  it('accepts a core GET route without permission and without :project', () => {
    expect(problems({})).toEqual([]);
  });

  it('refuses a permission', () => {
    const found = problems({ permission: 'org:read' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/must not require a permission/);
  });

  it('refuses :project in the path', () => {
    const found = problems({ path: '/_pb/projects/:project' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/must not have :project/);
  });

  it('refuses POST', () => {
    const found = problems({ method: 'POST' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/must be a GET route/);
  });

  it('refuses needsOrg false', () => {
    const found = problems({ needsOrg: false });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/needs organization context/);
  });

  it('refuses a plugin route', () => {
    const found = problems({}, { apiVersion: 3 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/not available to plugin routes/);
  });

  it('refuses a route registered without the core option', () => {
    const found = problems({}, {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/not available to plugin routes/);
  });

  it('refuses a real plugin that declares the boundary', () => {
    const plugin: PluginDefinition = {
      id: 'demo',
      package: '@test/demo',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/projects',
          permission: null,
          boundary: 'authenticated',
          handler: () => new Response('ok'),
        });
      },
    };
    let caught: unknown;
    try {
      collectRegistrations([plugin]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KernelConfigError);
    expect((caught as KernelConfigError).problems.join('\n')).toMatch(
      /not available to plugin routes/,
    );
  });

  it('marks the route as not session-only in the descriptors', () => {
    const [descriptor] = routeDescriptors([
      { plugin: 'core', ...authenticated, handler: () => new Response() },
    ] as never);
    expect(descriptor?.sessionOnly).toBe(false);
  });
});

describe('bearer-only route registration', () => {
  const route = {
    method: 'POST',
    path: '/_pb/mcp',
    permission: null,
    boundary: 'authenticated',
    bearerOnly: true,
  };
  const core = { allowAuthenticated: true };
  const problems = (patch: Record<string, unknown> = {}) =>
    routeBoundaryProblems({ ...route, ...patch }, 'route', core);

  it('accepts the core authenticated MCP POST', () => {
    expect(problems()).toEqual([]);
  });

  it('refuses another path', () => {
    expect(problems({ path: '/_pb/other' }).join(' ')).toContain('bearerOnly');
  });

  it('refuses another boundary', () => {
    expect(problems({ boundary: 'none' }).join(' ')).toContain('bearerOnly');
  });

  it('refuses another method', () => {
    expect(problems({ method: 'GET' }).join(' ')).toContain('bearerOnly');
  });

  it('refuses a permission', () => {
    expect(problems({ permission: 'org:read' }).length).toBeGreaterThan(0);
  });

  it('refuses a non-true flag', () => {
    expect(problems({ bearerOnly: false }).join(' ')).toContain('bearerOnly');
  });

  it('refuses bearerOnly on a real plugin route independently of its boundary', () => {
    const plugin: PluginDefinition = {
      id: 'demo',
      package: '@test/demo',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register(registry) {
        const definition = {
          method: 'GET' as const,
          path: '/items',
          permission: null,
          bearerOnly: true as const,
          handler: () => new Response('ok'),
        };
        registry.route(definition);
      },
    };
    expect(() => collectRegistrations([plugin])).toThrow(/bearerOnly/);
  });
});
