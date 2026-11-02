import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext, type OrgContext } from './db/port.js';
import { fixedClock } from './ids.js';
import {
  PLUGIN_BINDABLE_PORTS,
  PlatformUnavailableError,
  requirePlatformPorts,
  SUPPORTED_PLUGIN_API,
  definePlugin,
  type IdentityProvider,
  type AccessCheckResult,
  type AuthMapGroupsInput,
  type AuthResolveIdentityInput,
  type HookMap,
  type MapGroupsResult,
  type PlatformPorts,
  type PluginDefinition,
  type PublishPolicyDefinition,
  type PublishInspection,
  type PublishPolicyVerdict,
  type PluginPorts,
  type PluginRegistry,
  type ReadPolicyInput,
  type ReadPolicyResult,
  type RequestContext,
  type RouteDefinition,
  type VersionFact,
} from './plugin.js';
import * as root from './index.js';

function recordingRegistry(): {
  registry: PluginRegistry;
  routes: RouteDefinition[];
  hooks: Array<{ name: keyof HookMap; handler: HookMap['access.check'] }>;
} {
  const routes: RouteDefinition[] = [];
  const hooks: Array<{ name: keyof HookMap; handler: HookMap['access.check'] }> = [];
  return {
    registry: {
      route: (route) => routes.push(route),
      job: () => undefined,
      hook: (name, handler) => hooks.push({ name, handler: handler as HookMap['access.check'] }),
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
  it('accepts an optional asynchronous publish policy without changing plugin versions or ports', () => {
    const policy: PublishPolicyDefinition = {
      id: 'scanner',
      inspect: (_ctx, input) => {
        expectTypeOf(input).toEqualTypeOf<PublishInspection>();
        expectTypeOf(input.openTarball()).toEqualTypeOf<Promise<ReadableStream<Uint8Array>>>();
        return Promise.resolve({ verdict: 'deny', reason: 'policy' });
      },
    };
    const plugin = definePlugin({
      id: 'scanner',
      package: '@package-broker/plugin-scanner',
      apiVersion: 3,
      platforms: ['node'],
      publishPolicy: policy,
    });
    expect(plugin.publishPolicy).toBe(policy);
    expectTypeOf<PluginDefinition['publishPolicy']>().toEqualTypeOf<
      PublishPolicyDefinition | undefined
    >();
    expectTypeOf<ReturnType<PublishPolicyDefinition['inspect']>>().toEqualTypeOf<
      Promise<PublishPolicyVerdict>
    >();
    expect(SUPPORTED_PLUGIN_API).toEqual([3, 4]);
    expect(PLUGIN_BINDABLE_PORTS).toEqual(['source', 'identity']);
  });

  it('exports an optional asynchronous reauth capability resolver', () => {
    expectTypeOf<IdentityProvider['reauthCapability']>().toEqualTypeOf<
      (() => Promise<boolean>) | undefined
    >();
    expectTypeOf<IdentityProvider['supportsReauth']>().toEqualTypeOf<boolean>();
  });
  it('keeps the supported API range and the identity definePlugin', () => {
    expect(SUPPORTED_PLUGIN_API).toEqual([3, 4]);
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

  it('rejects allow results from auth hooks and unknown hook names at compile time', () => {
    const recorded = recordingRegistry();

    // @ts-expect-error an identity hook cannot allow
    recorded.registry.hook('auth.resolveIdentity', () => ({ allow: true }));
    // @ts-expect-error deny must be the literal true
    recorded.registry.hook('auth.resolveIdentity', () => ({ deny: false }));
    // @ts-expect-error mapGroups can only narrow, never add groups
    recorded.registry.hook('auth.mapGroups', () => ({ add: ['admins'] }));
    // @ts-expect-error mapGroups cannot grant
    recorded.registry.hook('auth.mapGroups', () => ({ allow: true }));
    // @ts-expect-error auth.unknown is not a hook name
    recorded.registry.hook('auth.unknown', () => undefined);

    expectTypeOf<ReturnType<HookMap['auth.resolveIdentity']>>().toEqualTypeOf<
      AccessCheckResult | Promise<AccessCheckResult>
    >();
    expectTypeOf<MapGroupsResult>().toEqualTypeOf<
      { readonly keep: readonly string[] } | undefined
    >();
    expectTypeOf<Parameters<HookMap['auth.mapGroups']>[0]>().toEqualTypeOf<AuthMapGroupsInput>();
    expectTypeOf<
      Parameters<HookMap['auth.resolveIdentity']>[0]
    >().toEqualTypeOf<AuthResolveIdentityInput>();
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

  it('returns the scoped platform ports and fails closed when they are absent', () => {
    const platform = {
      blob: {},
      cache: {},
      jobs: {},
      observability: {},
    } as unknown as PlatformPorts;
    expect(requirePlatformPorts({ ...ports, platform })).toBe(platform);
    expect(() => requirePlatformPorts(ports)).toThrow(PlatformUnavailableError);
    expect(() => requirePlatformPorts(ports)).toThrow(
      expect.objectContaining({ name: 'PlatformUnavailableError' }),
    );
    expectTypeOf<PluginPorts['platform']>().toEqualTypeOf<PlatformPorts | undefined>();
    expect(PLUGIN_BINDABLE_PORTS).not.toContain('blob');
    expect(PLUGIN_BINDABLE_PORTS).not.toContain('cache');
    expect(PLUGIN_BINDABLE_PORTS).not.toContain('job');
    expect(PLUGIN_BINDABLE_PORTS).not.toContain('observability');
  });
});

describe('registry.read hook (plugin API 4)', () => {
  it('typechecks a deny-only hook for both phases on API 4', () => {
    const plugin = definePlugin({
      id: 'read-policy',
      package: '@package-broker/plugin-read-policy',
      apiVersion: 4,
      platforms: ['node', 'cloudflare'],
      register(registry) {
        registry.hook('registry.read', (input) => {
          expectTypeOf(input.signal).toEqualTypeOf<AbortSignal>();
          expectTypeOf(input.org).toEqualTypeOf<Readonly<{ orgId: string }>>();
          if (input.phase === 'request') {
            expectTypeOf(input.packageKey).toEqualTypeOf<string | null>();
            return input.kind === 'search' ? { deny: true, reason: 'restricted' } : undefined;
          }
          expectTypeOf(input.versions).toEqualTypeOf<readonly VersionFact[]>();
          return {
            deniedVersions: input.versions
              .filter((fact) => fact.ageBasis === 'first_seen')
              .map((fact) => ({
                versionId: fact.versionId,
                revision: fact.revision,
                reason: 'restricted' as const,
              })),
          };
        });
        registry.hook('registry.read', async () => Promise.resolve(undefined));
      },
    });
    expect(plugin.apiVersion).toBe(4);
    expect(SUPPORTED_PLUGIN_API).toEqual([3, 4]);
  });

  it('keeps API 3 and existing API 4 plugins valid without the hook', () => {
    const recorded = recordingRegistry();
    const legacy = definePlugin({
      id: 'legacy',
      package: '@package-broker/plugin-legacy',
      apiVersion: 3,
      platforms: ['node'],
      register(registry) {
        registry.hook('access.check', () => undefined);
      },
    });
    legacy.register(recorded.registry);
    expect(recorded.hooks.map((hook) => hook.name)).toEqual(['access.check']);
  });

  it('rejects allow, Response, free-text reasons and raw request data at compile time', () => {
    const recorded = recordingRegistry();
    // @ts-expect-error a read policy cannot allow
    recorded.registry.hook('registry.read', () => ({ allow: true }));
    // @ts-expect-error a read policy cannot return a response
    recorded.registry.hook('registry.read', () => new Response('x'));
    // @ts-expect-error reasons are a fixed set
    recorded.registry.hook('registry.read', () => ({ deny: true, reason: 'because' }));
    // @ts-expect-error deny must be the literal true
    recorded.registry.hook('registry.read', () => ({ deny: false, reason: 'restricted' }));
    recorded.registry.hook('registry.read', () => ({
      // @ts-expect-error a denied version names a fixed reason
      deniedVersions: [{ versionId: 'v', revision: 1, reason: 'malware' }],
    }));
    recorded.registry.hook('registry.read', (input) => {
      // @ts-expect-error the hook sees no raw request
      void input.request;
      // @ts-expect-error the hook sees no headers
      void input.headers;
      // @ts-expect-error the hook gets no next() or authorization callback
      void input.next;
      if (input.phase === 'versions') {
        // @ts-expect-error candidate facts carry no manifest
        void input.versions[0]?.manifest;
        // @ts-expect-error candidate facts are read-only
        input.versions[0]!.revision = 2;
      }
      return undefined;
    });
    expectTypeOf<ReadPolicyResult>().toEqualTypeOf<
      | undefined
      | Readonly<{ deny: true; reason: 'restricted' | 'client_unsupported' }>
      | Readonly<{
          deniedVersions: readonly Readonly<{
            versionId: string;
            revision: number;
            reason: 'restricted' | 'client_unsupported';
          }>[];
        }>
    >();
    expectTypeOf<Extract<ReadPolicyInput, { phase: 'request' }>>().not.toHaveProperty('versions');
    expectTypeOf<Extract<ReadPolicyInput, { phase: 'versions' }>>().not.toHaveProperty('kind');
  });

  it('exposes the hook types through the root and plugin entry points only as types', () => {
    expect(Object.keys(root)).not.toContain('ReadPolicyInput');
    expectTypeOf<root.ReadPolicyInput>().toEqualTypeOf<ReadPolicyInput>();
  });
});
