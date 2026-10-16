import { describe, expect, it } from 'vitest';
import { SUPPORTED_PLUGIN_API, type PluginDefinition, type RouteDefinition } from '../plugin.js';
import { KernelConfigError, collectRegistrations, type RegistrationOptions } from './registry.js';
import { routeBoundaryProblems, type PackageVisibilityResolver } from './routes.js';

const handler = () => new Response('ok');
const resolver: PackageVisibilityResolver = { isVisible: () => true };

function route(overrides: Record<string, unknown>): RouteDefinition {
  return { method: 'GET', path: '/x', permission: null, handler, ...overrides } as RouteDefinition;
}

function pluginWith(
  routes: RouteDefinition[],
  apiVersion: number = SUPPORTED_PLUGIN_API[1],
): PluginDefinition {
  return {
    id: 'thirdparty',
    package: '@test/thirdparty',
    apiVersion,
    platforms: ['node'],
    register(registry) {
      for (const r of routes) registry.route(r);
    },
  };
}

function problemsOf(
  routes: RouteDefinition[],
  options?: RegistrationOptions,
  apiVersion?: number,
): readonly string[] {
  try {
    collectRegistrations([pluginWith(routes, apiVersion)], options);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  return [];
}

describe('plugin route boundary contract', () => {
  it.each([
    ['unknown permission', { permission: 'plugin:invented', boundary: 'organization' }],
    [
      'unknown permission on project boundary',
      {
        path: '/p/:project/x',
        permission: 'project:invented',
        boundary: 'project',
      },
    ],
    ['unknown boundary', { permission: 'org:read', boundary: 'tenant' }],
    [
      'package boundary',
      { path: '/p/:project/x', permission: 'project:read', boundary: 'package' },
    ],
    ['project boundary without :project', { permission: 'project:read', boundary: 'project' }],
    ['public route with organization boundary', { permission: null, boundary: 'organization' }],
    [
      'public route with project boundary',
      { path: '/p/:project', permission: null, boundary: 'project' },
    ],
    [
      'boundary inferred from a project path',
      { path: '/p/:project/x', permission: 'project:read' },
    ],
    ['self route with a permission', { permission: 'org:read', boundary: 'self' }],
    ['self route with :project', { path: '/p/:project/t', permission: null, boundary: 'self' }],
  ])('refuses %s and names the plugin', (_label, overrides) => {
    const problems = problemsOf([route(overrides)]);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem).toContain('thirdparty');
    }
  });

  it.each([
    [
      'unknown permission',
      { permission: 'plugin:invented', boundary: 'organization' },
      'unknown permission',
    ],
    ['unknown boundary', { permission: 'org:read', boundary: 'tenant' }, 'unknown boundary'],
    [
      'package boundary',
      { path: '/p/:project/x', permission: 'project:read', boundary: 'package' },
      'package boundary',
    ],
  ])('reports the reason for %s', (_label, overrides, fragment) => {
    expect(problemsOf([route(overrides)]).join('\n')).toContain(fragment);
  });

  it('refuses a plugin-invented permission even when a resolver is registered', () => {
    const r = route({
      path: '/p/:project/x',
      permission: 'project:packages:invented',
      boundary: 'project',
    });
    expect(problemsOf([r], { packageResolver: resolver }).length).toBeGreaterThan(0);
  });

  it('refuses a self route on a plugin registration', () => {
    const problems = problemsOf([route({ path: '/me/t', permission: null, boundary: 'self' })]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('thirdparty');
  });

  it('refuses a package boundary even with a resolver', () => {
    const r = route({ path: '/p/:project/x', permission: 'project:read', boundary: 'package' });
    expect(problemsOf([r], { packageResolver: resolver }).length).toBeGreaterThan(0);
  });

  it('refuses a project:packages:* route without a resolver and accepts it with one', () => {
    const r = route({
      path: '/p/:project/pk',
      permission: 'project:packages:read',
      boundary: 'project',
    });
    const without = problemsOf([r]);
    expect(without.join('\n')).toContain('package-visibility resolver');
    expect(without.join('\n')).toContain('thirdparty');
    expect(problemsOf([r], { packageResolver: resolver })).toEqual([]);
  });

  it('reports every malformed route of one plugin together', () => {
    const problems = problemsOf([
      route({ path: '/a', permission: 'plugin:invented', boundary: 'organization' }),
      route({ path: '/b', permission: 'org:read', boundary: 'tenant' }),
      route({ path: '/c', permission: 'org:read' }),
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts valid organization, project and public routes', () => {
    expect(
      problemsOf([
        route({ path: '/o', permission: 'org:read', boundary: 'organization' }),
        route({ path: '/p/:project/i', permission: 'project:read', boundary: 'project' }),
        route({ path: '/pub', permission: null }),
        route({ path: '/pub2', permission: null, boundary: 'none' }),
      ]),
    ).toEqual([]);
  });
});

describe('plugin api transition', () => {
  const protectedRoute = route({ permission: 'org:read', boundary: 'organization' });

  it('supports exactly API 2 and 3', () => {
    expect(SUPPORTED_PLUGIN_API).toEqual([2, 3]);
  });

  it('accepts a bounded protected route on API 3', () => {
    expect(problemsOf([protectedRoute], undefined, 3)).toEqual([]);
  });

  it('refuses an API 2 plugin that declares a boundary', () => {
    expect(problemsOf([protectedRoute], undefined, 2).join('\n')).toContain('apiVersion 3');
  });

  it('refuses an API 2 protected route without a boundary', () => {
    const problems = problemsOf([route({ permission: 'org:read' })], undefined, 2);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('thirdparty');
  });

  it('accepts an API 2 public route without a boundary', () => {
    expect(problemsOf([route({ permission: null })], undefined, 2)).toEqual([]);
  });

  it.each([1, 4])('refuses API %i', (version) => {
    expect(() => collectRegistrations([pluginWith([protectedRoute], version)])).toThrow(
      KernelConfigError,
    );
  });
});

describe('plugin boundary contract, round 2', () => {
  it.each([
    [
      'unknown permission',
      { permission: 'plugin:invented', boundary: 'organization' },
      'unknown permission',
    ],
    [
      'package boundary',
      { path: '/p/:project/x', permission: 'project:read', boundary: 'package' },
      'package boundary is reserved',
    ],
    ['protected route without boundary', { permission: 'org:read' }, 'explicit boundary'],
    [
      'protected route with boundary none',
      { permission: 'org:read', boundary: 'none' },
      'explicit boundary',
    ],
    [
      'project permission on organization boundary',
      { permission: 'project:read', boundary: 'organization' },
      'organization boundary',
    ],
    [
      'organization permission on project boundary',
      { path: '/p/:project/x', permission: 'org:read', boundary: 'project' },
      'project boundary',
    ],
    [
      'protected route with needsOrg false',
      { permission: 'org:read', boundary: 'organization', needsOrg: false },
      'must be public',
    ],
    ['null boundary', { permission: 'org:read', boundary: null }, 'unknown boundary'],
    ['numeric boundary', { permission: 'org:read', boundary: 42 }, 'unknown boundary'],
    [
      'plugin self route',
      { path: '/me/t', permission: null, boundary: 'self' },
      'self boundary is not available',
    ],
  ])('refuses %s with the reason', (_label, overrides, fragment) => {
    const problems = problemsOf([route(overrides)]);
    expect(problems.join('\n')).toContain(fragment);
    expect(problems.every((p) => p.includes('thirdparty'))).toBe(true);
  });

  it('names every malformed route of one plugin', () => {
    const joined = problemsOf([
      route({ path: '/a', permission: 'plugin:invented', boundary: 'organization' }),
      route({ path: '/b', permission: 'org:read', boundary: 'tenant' }),
      route({ path: '/c', permission: 'org:read' }),
    ]).join('\n');
    for (const path of ['/a', '/b', '/c']) {
      expect(joined).toContain(`GET ${path}`);
    }
  });

  it.each([
    [1, 'apiVersion 1'],
    [4, 'apiVersion 4'],
  ])('refuses out-of-range API %i on a public route and names the plugin', (version, fragment) => {
    const problems = problemsOf([route({ permission: null })], undefined, version);
    expect(problems.join('\n')).toContain(fragment);
    expect(problems.join('\n')).toContain('thirdparty');
  });
});

describe('self boundary rules (core registration)', () => {
  const label = 'core route';
  const core = { allowSelf: true } as const;

  it('accepts a session self route without permission or :project', () => {
    expect(
      routeBoundaryProblems({ path: '/me/t', permission: null, boundary: 'self' }, label, core),
    ).toEqual([]);
  });

  it('refuses a self route with a permission', () => {
    const problems = routeBoundaryProblems(
      { path: '/me/t', permission: 'org:read', boundary: 'self' },
      label,
      core,
    );
    expect(problems.join('\n')).toContain('must not require a permission');
  });

  it('refuses a self route with :project', () => {
    const problems = routeBoundaryProblems(
      { path: '/p/:project/t', permission: null, boundary: 'self' },
      label,
      core,
    );
    expect(problems.join('\n')).toContain('must not have :project');
  });
});
