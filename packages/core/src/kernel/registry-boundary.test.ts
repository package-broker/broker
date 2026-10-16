import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RouteDefinition,
} from '../plugin.js';
import { createKernel } from './kernel.js';
import { KernelConfigError, collectRegistrations, type RegistrationOptions } from './registry.js';
import type { PackageVisibilityResolver } from './routes.js';

const handler = () => new Response('ok');
const API = SUPPORTED_PLUGIN_API[1];
const resolver: PackageVisibilityResolver = { isVisible: () => true };

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

function route(overrides: Record<string, unknown>): RouteDefinition {
  return {
    method: 'GET',
    path: '/x',
    permission: null,
    handler,
    ...overrides,
  } as RouteDefinition;
}

function pluginWith(routes: RouteDefinition[], apiVersion: number = API) {
  return {
    id: 'demo',
    package: '@test/demo',
    apiVersion,
    platforms: ['node'],
    register(registry) {
      for (const r of routes) registry.route(r);
    },
  } satisfies PluginDefinition;
}

function pluginProblems(r: RouteDefinition, options?: RegistrationOptions): readonly string[] {
  try {
    collectRegistrations([pluginWith([r])], options);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  return [];
}

async function kernelProblems(
  r: RouteDefinition,
  options?: RegistrationOptions,
): Promise<readonly string[]> {
  const corePath = r.path.startsWith('/') ? `/_pb${r.path}` : r.path;
  try {
    await createKernel({
      platform: 'node',
      plugins: [],
      ports,
      resolveOrg: () => Promise.resolve(orgContext('org-1')),
      health: () => Promise.resolve(true),
      log: () => undefined,
      coreRoutes: [{ ...r, path: corePath }],
      ...(options?.packageResolver === undefined
        ? {}
        : { packageResolver: options.packageResolver }),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  return [];
}

type Surface = readonly [
  string,
  (r: RouteDefinition, o?: RegistrationOptions) => Promise<readonly string[]>,
  boolean,
];
const surfaces: readonly Surface[] = [
  ['plugin registration', (r, o) => Promise.resolve(pluginProblems(r, o)), false],
  ['createKernel coreRoutes', kernelProblems, true],
];

describe.each(surfaces)('route boundary via %s', (_name, problemsOf, isCore) => {
  it.each([
    [
      'project route',
      { path: '/p/:project/items', permission: 'project:read', boundary: 'project' },
    ],
    ['organization route', { path: '/orgs', permission: 'org:read', boundary: 'organization' }],
    ['public route without boundary', { permission: null }],
    ['public route with boundary none', { permission: null, boundary: 'none' }],
    ['public route without org', { permission: null, needsOrg: false }],
  ])('accepts a %s', async (_label, overrides) => {
    expect(await problemsOf(route(overrides))).toEqual([]);
  });

  it.each([
    ['no boundary', { permission: 'org:read' }, 'explicit boundary'],
    ['boundary none', { permission: 'org:read', boundary: 'none' }, 'explicit boundary'],
    [
      'package boundary',
      { path: '/p/:project/x', permission: 'project:read', boundary: 'package' },
      'package',
    ],
    [
      'unknown permission',
      { permission: 'a.read', boundary: 'organization' },
      'unknown permission',
    ],
    ['unknown boundary', { permission: 'org:read', boundary: 'tenant' }, 'unknown boundary'],
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
      'project boundary without :project',
      { permission: 'project:read', boundary: 'project' },
      ':project',
    ],
    ['public with organization boundary', { permission: null, boundary: 'organization' }, 'public'],
    [
      'public with project boundary',
      { path: '/p/:project', permission: null, boundary: 'project' },
      'public',
    ],
    ['self with a permission', { permission: 'org:read', boundary: 'self' }, 'self'],
    ['self with :project', { path: '/p/:project/t', permission: null, boundary: 'self' }, 'self'],
    [
      'needsOrg false with permission',
      { permission: 'org:read', boundary: 'organization', needsOrg: false },
      'public',
    ],
    [
      'packages permission without resolver',
      { path: '/p/:project/pk', permission: 'project:packages:read', boundary: 'project' },
      'package-visibility resolver',
    ],
  ])('refuses %s', async (_label, overrides, fragment) => {
    const problems = await problemsOf(route(overrides));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(fragment);
  });

  it('accepts a project:packages:* route when a package resolver is registered', async () => {
    const r = route({
      path: '/p/:project/pk',
      permission: 'project:packages:read',
      boundary: 'project',
    });
    expect(await problemsOf(r, { packageResolver: resolver })).toEqual([]);
  });

  it('refuses a package resolver without isVisible', async () => {
    const r = route({
      path: '/p/:project/pk',
      permission: 'project:packages:read',
      boundary: 'project',
    });
    const broken = {} as PackageVisibilityResolver;
    expect((await problemsOf(r, { packageResolver: broken })).length).toBeGreaterThan(0);
  });

  it('accepts an organization route with :project in the path', async () => {
    const r = route({
      path: '/projects/:project',
      permission: 'org:read',
      boundary: 'organization',
    });
    expect(await problemsOf(r)).toEqual([]);
  });

  it('refuses a null-prototype unknown boundary without throwing', async () => {
    const r = route({ permission: 'org:read', boundary: Object.create(null) });
    expect((await problemsOf(r)).join('\n')).toContain('unknown boundary');
  });

  it(isCore ? 'accepts a self route' : 'refuses a self route', async () => {
    const problems = await problemsOf(route({ path: '/me/t', permission: null, boundary: 'self' }));
    expect(problems.length > 0).toBe(!isCore);
  });

  it('refuses the package boundary even with a resolver', async () => {
    const r = route({ path: '/p/:project/x', permission: 'project:read', boundary: 'package' });
    expect((await problemsOf(r, { packageResolver: resolver })).length).toBeGreaterThan(0);
  });

  it('does not infer a boundary from the path', async () => {
    const problems = await problemsOf(
      route({ path: '/p/:project/items', permission: 'project:read' }),
    );
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('plugin api version and boundary', () => {
  const protectedRoute = route({ permission: 'org:read', boundary: 'organization' });

  it('accepts a protected route with a boundary on API 3', () => {
    expect(() => collectRegistrations([pluginWith([protectedRoute], 3)])).not.toThrow();
  });

  it('refuses an API 2 plugin that declares a boundary', () => {
    expect(() => collectRegistrations([pluginWith([protectedRoute], 2)])).toThrow(/apiVersion 3/);
    expect(() =>
      collectRegistrations([pluginWith([route({ permission: null, boundary: 'none' })], 2)]),
    ).toThrow(/apiVersion 3/);
  });

  it('refuses an API 2 protected route without a boundary', () => {
    expect(() =>
      collectRegistrations([pluginWith([route({ permission: 'org:read' })], 2)]),
    ).toThrow(KernelConfigError);
  });

  it('accepts an API 3 public route without a boundary', () => {
    expect(() =>
      collectRegistrations([pluginWith([route({ permission: null })], 3)]),
    ).not.toThrow();
  });

  it('refuses API 4', () => {
    expect(() => collectRegistrations([pluginWith([protectedRoute], 4)])).toThrow(/apiVersion 4/);
  });
});

describe('core self route', () => {
  it('answers 401 and never runs the handler', async () => {
    let ran = false;
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ports,
      resolveOrg: () => Promise.resolve(orgContext('org-1')),
      health: () => Promise.resolve(true),
      log: () => undefined,
      coreRoutes: [
        route({
          path: '/_pb/me',
          permission: null,
          boundary: 'self',
          handler: () => {
            ran = true;
            return new Response('ok');
          },
        }),
      ],
    });
    const response = await kernel.fetch(new Request('http://broker.test/_pb/me'));
    expect(response.status).toBe(401);
    expect(ran).toBe(false);
  });
});

describe('registry error shape', () => {
  it('reports plugin routes through KernelConfigError with the plugin id', () => {
    const problems = pluginProblems(route({ permission: 'org:read' }));
    expect(problems.some((p) => p.includes('plugin "demo"'))).toBe(true);
  });
});
