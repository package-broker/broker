import {
  PLUGIN_BINDABLE_PORTS,
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type PluginDefinition,
  type PortName,
  type RouteDefinition,
} from '../plugin.js';
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
  'migrations',
  'register',
  'init',
]);

const BINDABLE: readonly string[] = PLUGIN_BINDABLE_PORTS;

export function collectRegistrations(plugins: readonly PluginDefinition[]): Registration {
  const problems: string[] = [];
  const routes: RegisteredRoute[] = [];
  const accessChecks: Array<{ plugin: string; handler: HookMap['access.check'] }> = [];
  const bindings = new Map<PortName, string>();
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

    for (const port of plugin.binds ?? []) {
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

    if (plugin.register === undefined) {
      continue;
    }
    const own: RouteDefinition[] = [];
    try {
      plugin.register({
        route: (route) => {
          own.push(route);
        },
        hook: (name, handler) => {
          if (name === 'access.check') {
            accessChecks.push({ plugin: id, handler: handler as HookMap['access.check'] });
          }
        },
      });
    } catch (error) {
      problems.push(
        `plugin "${id}" register failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const route of own) {
      const pathProblem = routePathProblem(route.path);
      if (pathProblem !== null) {
        problems.push(`plugin "${id}": ${pathProblem}`);
      }
      if (route.needsOrg === false && route.permission !== null) {
        problems.push(
          `plugin "${id}" route ${route.method} ${route.path}: a route without organization context must be public`,
        );
      }
      if (pathProblem === null) {
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

  return { routes, hooks: { 'access.check': accessChecks }, bindings };
}
