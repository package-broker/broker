import {
  PLUGIN_BINDABLE_PORTS,
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type PluginDefinition,
  type PortName,
  type RouteDefinition,
} from '../plugin.js';
import type { IdentityProviderFactory } from '../identity/port.js';
import { JobError, defineJob, qualifyJobName, type JobDefinition } from '../platform/jobs.js';
import { reportableErrorName } from './error-name.js';
import type { PackageVisibilityResolver } from './routes.js';
import { routeBoundaryProblems, routePathProblem, routesConflict } from './routes.js';

type RegisteredRoute = RouteDefinition & { readonly plugin: string };

export interface RegisteredJob {
  readonly plugin: string;
  readonly qualifiedName: string;
  readonly definition: JobDefinition;
}

export interface Registration {
  readonly routes: readonly RegisteredRoute[];
  readonly hooks: {
    readonly [K in keyof HookMap]: ReadonlyArray<{
      readonly plugin: string;
      readonly handler: HookMap[K];
    }>;
  };
  readonly jobs: readonly RegisteredJob[];
  readonly bindings: ReadonlyMap<PortName, string>;
  readonly identityFactory: IdentityProviderFactory | null;
}

export interface RegistrationOptions {
  readonly packageResolver?: PackageVisibilityResolver;
  readonly coreJobs?: readonly RegisteredJob[];
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

function jobProblemCode(error: unknown): string {
  return error instanceof JobError ? error.code : reportableErrorName(error);
}

/** Kernel-internal: `core` is rejected as a plugin id, so core job types are qualified here. */
export function registerCoreJob(definition: JobDefinition): RegisteredJob {
  const frozen = defineJob(definition);
  const qualifiedName = `core:${frozen.name}:v${frozen.version}`;
  return Object.freeze({ plugin: 'core', qualifiedName, definition: frozen });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function collectRegistrations(
  plugins: readonly PluginDefinition[],
  options: RegistrationOptions = {},
): Registration {
  const problems: string[] = [];
  const routes: RegisteredRoute[] = [];
  const hooks: { [K in keyof HookMap]: Array<{ plugin: string; handler: HookMap[K] }> } = {
    'access.check': [],
    'auth.resolveIdentity': [],
    'auth.mapGroups': [],
  };
  const jobs: RegisteredJob[] = [...(options.coreJobs ?? [])];
  const jobNames = new Set<string>();
  const bindings = new Map<PortName, string>();
  let identityFactory: IdentityProviderFactory | null = null;
  const [minApi, maxApi] = SUPPORTED_PLUGIN_API;

  for (const core of jobs) {
    if (jobNames.has(core.qualifiedName)) {
      problems.push(`job "${core.qualifiedName}" is registered more than once`);
    }
    jobNames.add(core.qualifiedName);
  }

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
        job: (definition) => {
          assertOpen();
          try {
            const frozen = defineJob(definition);
            const qualifiedName = qualifyJobName(id, frozen.name, frozen.version);
            if (jobNames.has(qualifiedName)) {
              problems.push(`job "${qualifiedName}" is registered more than once`);
            } else {
              jobNames.add(qualifiedName);
              jobs.push(Object.freeze({ plugin: id, qualifiedName, definition: frozen }));
            }
          } catch (error) {
            problems.push(`plugin "${id}" job is invalid: ${jobProblemCode(error)}`);
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
      const boundaryProblems = routeBoundaryProblems(
        route,
        `plugin "${id}" route ${route.method} ${route.path}`,
        { ...options, apiVersion: plugin.apiVersion },
      );
      problems.push(...boundaryProblems);
      if (pathProblem === null && methodAllowed && boundaryProblems.length === 0) {
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
  return {
    routes,
    hooks: Object.freeze(hooks),
    jobs: Object.freeze(jobs),
    bindings,
    identityFactory,
  };
}
