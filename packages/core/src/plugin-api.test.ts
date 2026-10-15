import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext, type OrgContext } from './db/port.js';
import { fixedClock } from './ids.js';
import {
  PLUGIN_BINDABLE_PORTS,
  SUPPORTED_PLUGIN_API,
  definePlugin,
  type AccessCheckResult,
  type HookMap,
  type PluginDefinition,
  type PluginPorts,
  type PluginRegistry,
  type RequestContext,
  type RouteDefinition,
} from './plugin.js';

function recordingRegistry(): {
  registry: PluginRegistry;
  routes: RouteDefinition[];
  hooks: Array<{ name: keyof HookMap; handler: HookMap[keyof HookMap] }>;
} {
  const routes: RouteDefinition[] = [];
  const hooks: Array<{ name: keyof HookMap; handler: HookMap[keyof HookMap] }> = [];
  return {
    registry: {
      route: (route) => routes.push(route),
      hook: (name, handler) => hooks.push({ name, handler }),
    },
    routes,
    hooks,
  };
}

const ports: PluginPorts = {
  organizations: {
    get: () => Promise.resolve(null),
    // @ts-expect-error a plugin organization port is read-only
    updateSettings: () => Promise.resolve(null),
  },
  clock: fixedClock('2026-10-15T08:00:00.000Z'),
  ids: { ulid: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
};

describe('plugin contract', () => {
  it('keeps the supported API range and the identity definePlugin', () => {
    expect(SUPPORTED_PLUGIN_API).toEqual([2, 2]);
    const definition = {
      id: 'x',
      package: '@package-broker/plugin-x',
      apiVersion: 1,
      platforms: ['node'],
    } satisfies PluginDefinition;
    expect(definePlugin(definition)).toBe(definition);
  });

  it('lists the ports a plugin may bind', () => {
    expect(PLUGIN_BINDABLE_PORTS).toEqual(['source', 'identity']);
  });

  it('accepts a plugin with binds, migrations, routes, an access hook and init', async () => {
    let initializedAt: Date | undefined;
    const plugin = definePlugin({
      id: 'sample',
      package: '@package-broker/plugin-sample',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node', 'cloudflare'],
      binds: ['source'],
      migrations: { dir: 'migrations' },
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/sample/:id',
          permission: 'sample.read',
          handler: (ctx) => new Response(ctx.params.id ?? ''),
        });
        registry.hook('access.check', (input) =>
          input.projectId === 'blocked' ? { deny: true, reason: 'blocked project' } : undefined,
        );
      },
      init(pluginPorts) {
        initializedAt = pluginPorts.clock.now();
      },
    });

    const recorded = recordingRegistry();
    plugin.register(recorded.registry);
    await plugin.init(ports);

    expect(initializedAt?.toISOString()).toBe('2026-10-15T08:00:00.000Z');
    expect(recorded.routes.map((route) => [route.method, route.path, route.permission])).toEqual([
      ['GET', '/sample/:id', 'sample.read'],
    ]);
    const [hook] = recorded.hooks;
    expect(hook?.name).toBe('access.check');
    const input = {
      org: orgContext('01JZZZZZZZZZZZZZZZZZZZZZZZ'),
      principal: { kind: 'user', id: 'u1' },
      permission: 'sample.read',
    } as const;
    expect(await hook?.handler({ ...input, projectId: 'blocked' })).toEqual({
      deny: true,
      reason: 'blocked project',
    });
    expect(await hook?.handler({ ...input, projectId: null })).toBeUndefined();
  });

  it('rejects allow results from access hooks and HEAD routes at compile time', () => {
    const recorded = recordingRegistry();

    // @ts-expect-error an access hook cannot allow
    recorded.registry.hook('access.check', () => ({ allow: true }));
    // @ts-expect-error deny must be the literal true
    recorded.registry.hook('access.check', () => ({ deny: false }));
    recorded.registry.route({
      // @ts-expect-error HEAD is served by GET routes
      method: 'HEAD',
      path: '/x',
      permission: null,
      handler: () => new Response(null),
    });

    expectTypeOf<AccessCheckResult>().toEqualTypeOf<
      { readonly deny: true; readonly reason?: string } | undefined
    >();
    expectTypeOf<RouteDefinition['method']>().toEqualTypeOf<
      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    >();
    expect(recorded.hooks.map((hook) => hook.name)).toEqual(['access.check', 'access.check']);
    expect(recorded.routes).toHaveLength(1);
  });

  it('rejects unknown port names at compile time', () => {
    const definition = {
      id: 'y',
      package: '@package-broker/plugin-y',
      apiVersion: 1,
      platforms: ['node'],
      binds: ['database-x'],
    } as const;

    // @ts-expect-error not a port name
    expect(definePlugin(definition)).toBe(definition);
  });

  it('rejects runtime-owned port names at compile time', () => {
    const definition = {
      id: 'y',
      package: '@package-broker/plugin-y',
      apiVersion: 1,
      platforms: ['node'],
      binds: ['database'],
    } as const;

    // @ts-expect-error database is owned by the runtime
    expect(definePlugin(definition)).toBe(definition);
    expectTypeOf<NonNullable<PluginDefinition['binds']>[number]>().toEqualTypeOf<
      'source' | 'identity'
    >();
  });

  it('rejects misspelled plugin keys at compile time', () => {
    const misspelledBinds = {
      id: 'z',
      package: '@package-broker/plugin-z',
      apiVersion: 1,
      platforms: ['node'],
      bind: ['source'],
    } as const;
    const misspelledHooks = {
      id: 'z',
      package: '@package-broker/plugin-z',
      apiVersion: 1,
      platforms: ['node'],
      hooks: {},
    } as const;

    // @ts-expect-error bind is not a plugin key
    expect(definePlugin(misspelledBinds)).toBe(misspelledBinds);
    // @ts-expect-error hooks is not a plugin key
    expect(definePlugin(misspelledHooks)).toBe(misspelledHooks);
  });

  it('checks init and route handler parameters contravariantly', () => {
    const base = {
      id: 'w',
      package: '@package-broker/plugin-w',
      apiVersion: 1,
      platforms: ['node'],
    } as const;
    const greedyInit = {
      ...base,
      init: (pluginPorts: PluginPorts & { readonly blob: unknown }) => {
        void pluginPorts.blob;
      },
    };
    const orgOnlyRoute = {
      method: 'GET',
      path: '/w',
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext & { readonly org: OrgContext }) => new Response(ctx.org.orgId),
    } as const;
    const recorded = recordingRegistry();

    // @ts-expect-error init cannot demand a port the kernel does not provide
    expect(definePlugin(greedyInit)).toBe(greedyInit);
    // @ts-expect-error a handler cannot assume a non-null org
    recorded.registry.route(orgOnlyRoute);

    expect(recorded.routes).toEqual([orgOnlyRoute]);
    expectTypeOf<
      Parameters<NonNullable<PluginDefinition['init']>>[0]
    >().toEqualTypeOf<PluginPorts>();
    expectTypeOf<Parameters<RouteDefinition['handler']>[0]>().toEqualTypeOf<RequestContext>();
  });
});
