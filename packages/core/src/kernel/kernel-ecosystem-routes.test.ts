import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { PluginDefinition, RouteDefinition } from '../plugin.js';
import { createKernel, type KernelOptions } from './kernel.js';
import { collectRegistrations, KernelConfigError } from './registry.js';

function route(path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return { method: 'GET', path, permission: null, handler: () => new Response(path), ...extra };
}

function options(ecosystemRoutes: readonly RouteDefinition[]): KernelOptions {
  return {
    platform: 'node',
    plugins: [],
    ecosystemRoutes,
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-18T00:00:00Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
  };
}

function plugin(...routes: RouteDefinition[]): PluginDefinition {
  return {
    id: 'ecosystem-test',
    package: '@test/ecosystem-test',
    apiVersion: 3,
    platforms: ['node'],
    register: (registry) => routes.forEach((entry) => registry.route(entry)),
  };
}

const parameter = '/:project/npm/:a/:b';
const literal = '/:project/npm/-/whoami';
const packageRoute = route(parameter, {
  boundary: 'package',
  permission: 'project:packages:read',
  package: { ecosystem: 'npm', name: (params) => `${params['a']}/${params['b']}` },
});

describe('core ecosystem routes', () => {
  it.each([false, true])('dispatches literals before parameters (reverse=%s)', async (reverse) => {
    const routes = [route(parameter), route(literal)];
    const kernel = await createKernel(options(reverse ? routes.reverse() : routes));
    const special = await kernel.fetch(new Request('http://broker.test/demo/npm/-/whoami'));
    const ordinary = await kernel.fetch(new Request('http://broker.test/demo/npm/x/y'));
    expect(special.status).toBe(200);
    expect(await special.text()).toBe(literal);
    expect(await ordinary.text()).toBe(parameter);
    expect(kernel.routeTemplates.has(literal)).toBe(true);
  });

  it('gives earlier literals precedence even when a later segment is a parameter', async () => {
    const earlier = '/:project/npm/-/:action';
    const kernel = await createKernel(options([route('/:project/npm/:a/whoami'), route(earlier)]));
    expect(
      await (await kernel.fetch(new Request('http://broker.test/demo/npm/-/whoami'))).text(),
    ).toBe(earlier);
  });

  it.each([parameter, '/:project/npm/:x/:y'])('rejects duplicate shapes: %s', async (path) => {
    await expect(createKernel(options([route(parameter), route(path)]))).rejects.toThrow(
      'conflicts',
    );
  });

  it.each([false, true])(
    'rejects plugin literals overlapping core parameters (precollected=%s)',
    async (precollected) => {
      const plugins = [plugin(route(literal))];
      await expect(
        createKernel({
          ...options([route(parameter)]),
          plugins,
          ...(precollected ? { registration: collectRegistrations(plugins) } : {}),
        }),
      ).rejects.toThrow('conflicts');
    },
  );

  it('rejects plugin parameters overlapping core literals', async () => {
    await expect(
      createKernel({ ...options([route(literal)]), plugins: [plugin(route(parameter))] }),
    ).rejects.toThrow('conflicts');
  });

  it.each([
    '/',
    '/npm/:project/x',
    '/:project',
    '/_pb/hook',
    '/:project/',
    '/:project/npm/*',
    '/:project/:project',
  ])('rejects an invalid ecosystem path %s', async (path) => {
    await expect(createKernel(options([route(path)]))).rejects.toBeInstanceOf(KernelConfigError);
  });

  it('refuses a package boundary without a resolver', async () => {
    await expect(createKernel(options([packageRoute]))).rejects.toThrow(
      'package boundary is reserved',
    );
  });

  it.each([{ path: null }, { method: null }])(
    'reports malformed routes alongside plugin routes: %j',
    async (extra) => {
      await expect(
        createKernel({
          ...options([route(parameter, extra as unknown as Partial<RouteDefinition>)]),
          plugins: [plugin(route(literal))],
        }),
      ).rejects.toBeInstanceOf(KernelConfigError);
    },
  );

  it('accepts a package boundary with the dependency resolver', async () => {
    await expect(
      createKernel({
        ...options([packageRoute]),
        packageResolver: { resolve: async () => ({ kind: 'absent' }) },
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    { permission: 'project:read' },
    { permission: 'org:read', boundary: 'project' },
    { boundary: 'self' },
    { method: 'HEAD' },
    { ...packageRoute, package: undefined },
    { ...packageRoute, permission: null },
  ] as const)('uses the plugin boundary and method validation for %j', async (extra) => {
    await expect(
      createKernel({
        ...options([route(parameter, extra as Partial<RouteDefinition>)]),
        packageResolver: { resolve: async () => ({ kind: 'absent' }) },
      }),
    ).rejects.toBeInstanceOf(KernelConfigError);
  });

  it('preserves project authorization and deny-only plugin hooks', async () => {
    const handler = vi.fn(() => new Response('allowed'));
    const authorize = vi.fn(async () => ({
      allow: true as const,
      principal: { kind: 'user' as const, id: 'user-1' },
      projectId: 'project-1',
    }));
    const blocker = plugin();
    const kernel = await createKernel({
      ...options([
        route('/:project/packages.json', {
          permission: 'project:read',
          boundary: 'project',
          handler,
        }),
      ]),
      authorization: { authorize },
      plugins: [
        {
          ...blocker,
          register: (registry) => {
            registry.hook('access.check', () => ({ deny: true, reason: 'refused' }));
          },
        },
      ],
    });
    const response = await kernel.fetch(new Request('http://broker.test/demo/packages.json'));
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { project: 'demo' },
        route: expect.objectContaining({ plugin: 'core', boundary: 'project' }),
      }),
    );
  });
});
