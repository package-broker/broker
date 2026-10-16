import { describe, expect, expectTypeOf, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PackageEcosystem,
  type PluginDefinition,
  type PluginPorts,
  type RouteDefinition,
} from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import type { AuthorizationEngine } from './authorize.js';
import { createKernel } from './kernel.js';
import { KernelConfigError, collectRegistrations } from './registry.js';
import {
  PACKAGE_ECOSYSTEMS,
  routeBoundaryProblems,
  type PackageVisibilityResolver,
} from './routes.js';

const handler = () => new Response('ok');
const resolver: PackageVisibilityResolver = { isVisible: () => true };
const binding = {
  ecosystem: 'composer',
  name: (params: Readonly<Record<string, string>>) => params['name'] ?? null,
};

function packageRoute(overrides: Record<string, unknown> = {}): RouteDefinition {
  return {
    method: 'GET',
    path: '/p/:project/pkg/:name',
    permission: 'project:packages:read',
    boundary: 'package',
    package: binding,
    handler,
    ...overrides,
  } as RouteDefinition;
}

function pluginProblems(
  route: RouteDefinition,
  withResolver: boolean,
  apiVersion: number = SUPPORTED_PLUGIN_API[1],
): readonly string[] {
  const plugin: PluginDefinition = {
    id: 'pkgplugin',
    package: '@test/pkgplugin',
    apiVersion,
    platforms: ['node'],
    register(registry) {
      registry.route(route);
    },
  };
  try {
    collectRegistrations([plugin], withResolver ? { packageResolver: resolver } : {});
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  return [];
}

function coreProblems(route: RouteDefinition, withResolver: boolean): readonly string[] {
  return routeBoundaryProblems(route, 'core route', {
    allowSelf: true,
    ...(withResolver ? { packageResolver: resolver } : {}),
  });
}

describe.each([
  ['plugin', pluginProblems],
  ['core', coreProblems],
] as const)('package boundary on a %s route', (_kind, problemsOf) => {
  it('refuses a well-formed package route without a resolver', () => {
    expect(problemsOf(packageRoute(), false).join('\n')).toContain('package boundary is reserved');
  });

  it('refuses a project:packages:* project route without a resolver', () => {
    const r = packageRoute({ boundary: 'project', package: undefined });
    expect(problemsOf(r, false).join('\n')).toContain('package-visibility resolver');
  });

  it.each([
    ['read', {}],
    ['write', { method: 'PUT', permission: 'project:packages:write' }],
    ['fetchOnAdmission', { package: { ...binding, fetchOnAdmission: true } }],
    ['npm', { package: { ...binding, ecosystem: 'npm' } }],
  ])('registers a well-formed %s route with a resolver', (_label, overrides) => {
    expect(problemsOf(packageRoute(overrides), true)).toEqual([]);
  });

  it.each([
    ['no package binding', { package: undefined }, 'package binding'],
    ['a null package binding', { package: null }, 'package binding'],
    ['no name extractor', { package: { ecosystem: 'composer' } }, 'name extractor'],
    ['a string name', { package: { ...binding, name: 'vendor/x' } }, 'name extractor'],
    ['an unknown ecosystem', { package: { ...binding, ecosystem: 'pypi' } }, 'ecosystem'],
    [
      'a non-boolean fetchOnAdmission',
      { package: { ...binding, fetchOnAdmission: 'yes' } },
      'fetchOnAdmission',
    ],
    ['no :project in the path', { path: '/pkg/:name' }, ':project'],
    ['an org permission', { permission: 'org:read' }, 'project:packages:read'],
    ['a project:read permission', { permission: 'project:read' }, 'project:packages:read'],
    ['project:packages:manage', { permission: 'project:packages:manage' }, 'project:packages:read'],
    ['a public permission', { permission: null }, 'package boundary'],
  ])('refuses a package route with %s', (_label, overrides, fragment) => {
    const problems = problemsOf(packageRoute(overrides), true);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(fragment);
  });

  it('refuses a package binding on a non-package boundary', () => {
    const r = packageRoute({ boundary: 'project' });
    expect(problemsOf(r, true).join('\n')).toContain('package binding');
  });
});

describe('package boundary on a plugin route', () => {
  it('names the plugin in every problem', () => {
    const problems = pluginProblems(packageRoute({ package: undefined }), true);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(problem).toContain('pkgplugin');
  });

  it('refuses a package route on a plugin below apiVersion 3', () => {
    expect(pluginProblems(packageRoute(), true, 2).length).toBeGreaterThan(0);
  });

  it('keeps the registered binding on the route', () => {
    const plugin: PluginDefinition = {
      id: 'pkgplugin',
      package: '@test/pkgplugin',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register(registry) {
        registry.route(packageRoute());
      },
    };
    const { routes } = collectRegistrations([plugin], { packageResolver: resolver });
    expect(routes[0]?.package?.name({ name: 'vendor/x' })).toBe('vendor/x');
    expect(routes[0]?.package?.ecosystem).toBe('composer');
  });
});

describe('package ecosystems', () => {
  it('lists exactly the PackageEcosystem union at runtime', () => {
    expectTypeOf<(typeof PACKAGE_ECOSYSTEMS)[number]>().toEqualTypeOf<PackageEcosystem>();
    expect([...PACKAGE_ECOSYSTEMS].sort()).toEqual(['composer', 'npm']);
  });
});

describe('package boundary at request time', () => {
  const ports: PluginPorts = {
    organizations: { get: () => Promise.resolve(null) },
    clock: fixedClock('2026-10-16T00:00:00.000Z'),
    ids: { ulid: () => '01JA0000000000000000000000' },
  };
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5);

  function realEngine(lookups: string[]): AuthorizationEngine {
    return createAuthorizationEngine({
      access: {
        lookupSession: () => {
          lookups.push('session');
          return Promise.resolve(null);
        },
        lookupToken: () => {
          lookups.push('token');
          return Promise.resolve(null);
        },
        touchSession: () => Promise.resolve(true),
        touchToken: () => Promise.resolve(true),
      },
      tokenUse: {
        keyring: createKeyring([
          { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
        ]),
        nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
        dispatch: () => undefined,
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: () => Promise.resolve([]),
    });
  }

  async function serve(
    headers: Record<string, string>,
    authorization?: AuthorizationEngine,
  ): Promise<{ status: number; handled: number }> {
    let handled = 0;
    const plugin: PluginDefinition = {
      id: 'pkgplugin',
      package: '@test/pkgplugin',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register(registry) {
        registry.route(
          packageRoute({
            handler: () => {
              handled += 1;
              return new Response('package');
            },
          }),
        );
      },
    };
    const kernel = await createKernel({
      platform: 'node',
      plugins: [plugin],
      ports,
      resolveOrg: () => Promise.resolve(orgContext('org-1')),
      health: () => Promise.resolve(true),
      log: () => undefined,
      packageResolver: resolver,
      ...(authorization === undefined ? {} : { authorization }),
    });
    const response = await kernel.fetch(
      new Request('https://broker.test/p/demo/pkg/vendor-x', { headers }),
    );
    return { status: response.status, handled };
  }

  it.each([
    ['a bearer token', { authorization: `Bearer ${formatToken('pat', 'abcdefghijkl', secret)}` }],
    ['a session cookie', { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` }],
    ['no credential', {}],
  ])('denies a registered package route with %s before any lookup', async (_label, headers) => {
    const lookups: string[] = [];
    const { status, handled } = await serve(headers, realEngine(lookups));
    expect(status).toBe(403);
    expect(handled).toBe(0);
    expect(lookups).toEqual([]);
  });

  it('denies a registered package route under the default engine', async () => {
    const { status, handled } = await serve({});
    expect(status).toBe(403);
    expect(handled).toBe(0);
  });
});
