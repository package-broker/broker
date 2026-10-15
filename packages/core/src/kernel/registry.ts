import {
  PLUGIN_BINDABLE_PORTS,
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type PluginDefinition,
  type PortName,
  type RouteDefinition,
} from '../plugin.js';
import type { IdentityProviderFactory } from '../identity/port.js';
import { reportableErrorName } from './error-name.js';
import { routePathProblem, routesConflict } from './routes.js';

type RegisteredRoute = RouteDefinition & { readonly plugin: string };

export interface Registration {
  readonly routes: readonly RegisteredRoute[];
  readonly hooks: {
    readonly [K in keyof HookMap]: ReadonlyArray<{
      readonly plugin: string;
      readonly handler: HookMap[K];
    }>;
  };
  readonly bindings: ReadonlyMap<PortName, string>;
  readonly identityFactory: IdentityProviderFactory | null;
}

export class KernelConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'KernelConfigError';
    this.problems = problems;
  }
}

const DEFINITION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'package',
  'apiVersion',
  'platforms',
  'dependsOn',
  'capabilities',
  'binds',
  'identityProviders',
  'migrations',
  'register',
  'init',
]);

const BINDABLE: readonly string[] = PLUGIN_BINDABLE_PORTS;

export const ROUTE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const HOOK_NAME_KEYS = {
  'access.check': true,
  'auth.resolveIdentity': true,
  'auth.mapGroups': true,
} satisfies Record<keyof HookMap, true>;

const HOOK_NAMES: ReadonlySet<string> = new Set(Object.keys(HOOK_NAME_KEYS));

const MAX_NAME_LENGTH = 80;

function isHookName(name: unknown): name is keyof HookMap {
  return typeof name === 'string' && HOOK_NAMES.has(name);
}

function quoted(value: unknown): string {
  try {
    return JSON.stringify(String(value).slice(0, MAX_NAME_LENGTH));
  } catch {
    return '"?"';
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function collectRegistrations(plugins: readonly PluginDefinition[]): Registration {
  const problems: string[] = [];
  const routes: RegisteredRoute[] = [];
  const hooks: { [K in keyof HookMap]: Array<{ plugin: string; handler: HookMap[K] }> } = {
    'access.check': [],
    'auth.resolveIdentity': [],
    'auth.mapGroups': [],
  };
  const bindings = new Map<PortName, string>();
  let identityFactory: IdentityProviderFactory | null = null;
  const [minApi, maxApi] = SUPPORTED_PLUGIN_API;

  for (const plugin of plugins) {
    const id = plugin.id;

    if (!(plugin.apiVersion >= minApi && plugin.apiVersion <= maxApi)) {
      problems.push(
        `plugin "${id}" has apiVersion ${plugin.apiVersion}, core supports ${minApi} to ${maxApi}`,
      );
    }
    if (id === 'core') {
      problems.push('plugin id "core" is reserved');
    }
    for (const key of Reflect.ownKeys(plugin)) {
      if (typeof key === 'symbol' || !DEFINITION_KEYS.has(key)) {
        problems.push(`plugin "${id}" has unknown key "${String(key)}"`);
      }
    }

    const binds = plugin.binds ?? [];
    for (const port of binds) {
      if (!BINDABLE.includes(port)) {
        problems.push(`plugin "${id}" cannot bind port "${port}": provided by the runtime`);
        continue;
      }
      const holder = bindings.get(port);
      if (holder === undefined) {
        bindings.set(port, id);
      } else {
        problems.push(`port "${port}" is bound by plugins "${holder}" and "${id}"`);
      }
    }

    const bindsIdentity = binds.includes('identity');
    const factory: unknown = plugin.identityProviders;
    if (factory !== undefined && typeof factory !== 'function') {
      problems.push(`plugin "${id}" identityProviders must be a function`);
    }
    if (bindsIdentity && factory === undefined) {
      problems.push(`plugin "${id}" binds identity but has no identityProviders`);
    }
    if (!bindsIdentity && factory !== undefined) {
      problems.push(`plugin "${id}" has identityProviders but does not bind identity`);
    }
    if (bindsIdentity && typeof factory === 'function' && bindings.get('identity') === id) {
      identityFactory = factory as IdentityProviderFactory;
    }

    if (plugin.register === undefined) {
      continue;
    }
    const own: RouteDefinition[] = [];
    let sealed = false;
    const assertOpen = (): void => {
      if (sealed) {
        throw new Error('registry is sealed: register has returned');
      }
    };
    try {
      const returned: unknown = plugin.register({
        route: (route) => {
          assertOpen();
          own.push(route);
        },
        hook: (name, handler) => {
          assertOpen();
          if (!isHookName(name)) {
            problems.push(`plugin "${id}" registered unknown hook ${quoted(name)}`);
          } else if (typeof handler !== 'function') {
            problems.push(`plugin "${id}" hook ${quoted(name)} handler must be a function`);
          } else {
            (hooks[name] as Array<{ plugin: string; handler: unknown }>).push({
              plugin: id,
              handler,
            });
          }
        },
      });
      if (isThenable(returned)) {
        problems.push(`plugin "${id}" register must be synchronous`);
        returned.then(undefined, () => undefined);
      }
    } catch (error) {
      problems.push(`plugin "${id}" register threw ${reportableErrorName(error)}`);
    } finally {
      sealed = true;
    }

    for (const route of own) {
      const pathProblem = routePathProblem(route.path);
      if (pathProblem !== null) {
        problems.push(`plugin "${id}": ${pathProblem}`);
      }
      const methodAllowed = ROUTE_METHODS.has(route.method);
      if (!methodAllowed) {
        problems.push(
          `plugin "${id}" route ${String(route.method)} ${route.path}: method must be one of ${[...ROUTE_METHODS].join(', ')}`,
        );
      }
      if (route.needsOrg === false && route.permission !== null) {
        problems.push(
          `plugin "${id}" route ${route.method} ${route.path}: a route without organization context must be public`,
        );
      }
      if (pathProblem === null && methodAllowed) {
        routes.push({ ...route, plugin: id });
      }
    }
  }

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!;
      const b = routes[j]!;
      if (routesConflict(a, b)) {
        problems.push(
          `route ${a.method} ${a.path} of plugin "${a.plugin}" conflicts with ${b.method} ${b.path} of plugin "${b.plugin}"`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new KernelConfigError(problems);
  }

  for (const list of Object.values(hooks)) {
    Object.freeze(list);
  }
  return { routes, hooks: Object.freeze(hooks), bindings, identityFactory };
}
