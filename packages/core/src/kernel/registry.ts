import { isRegisteredCoreJob, type RegisteredCoreJob } from '../runtime/core-jobs.js';
export type { RegisteredCoreJob } from '../runtime/core-jobs.js';
import {
  PLUGIN_BINDABLE_PORTS,
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type IdentityDescriptor,
  type PluginDefinition,
  type PortName,
  type SourceProviderFactory,
  type SourceProviderContext,
  type RouteDefinition,
} from '../plugin.js';
import type { IdentityProviderFactory } from '../identity/port.js';
import { canonicalAnchor } from '../identity/providers.js';
import { readLength } from '../identity/provider-fields.js';
import type { SourceProvider } from '../sources/provider.js';
import {
  JobError,
  assertPluginId,
  defineJob,
  isReservedPluginId,
  qualifyJobName,
  type JobDefinition,
} from '../platform/jobs.js';
import { reportableErrorName } from './error-name.js';
import type { PackageVisibilityPort } from '../db/catalogue.js';
import {
  routeApiProblems,
  routeBoundaryProblems,
  routePathProblem,
  routesConflict,
} from './routes.js';

const SOURCE_PROVIDERS_API_VERSION = 3;

const MAX_SNAPSHOT_ARRAY = 1024;

class RouteSnapshotRefusal extends Error {}

function snapshotValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) throw new RouteSnapshotRefusal('circular reference');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      if (length > MAX_SNAPSHOT_ARRAY) {
        throw new RouteSnapshotRefusal(`arrays are limited to ${MAX_SNAPSHOT_ARRAY} elements`);
      }
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) {
        items.push(snapshotValue((value as unknown[])[i], ancestors));
      }
      return Object.freeze(items);
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new RouteSnapshotRefusal('only plain objects and arrays are allowed');
    }
    return Object.freeze(ownEntries(value, (v) => snapshotValue(v, ancestors)));
  } finally {
    ancestors.delete(value);
  }
}

function ownEntries(
  source: object,
  convert: (value: unknown, key: string) => unknown,
): Record<string, unknown> {
  const keys = Object.keys(source);
  if (keys.includes('__proto__')) throw new RouteSnapshotRefusal('__proto__ key is not allowed');
  return Object.fromEntries(
    keys.map((key) => [key, convert((source as Record<string, unknown>)[key], key)]),
  );
}

function snapshotRoute(route: RouteDefinition): RouteDefinition {
  if (typeof route !== 'object' || route === null) {
    throw new RouteSnapshotRefusal('route must be an object');
  }
  const snapshot = ownEntries(route, (value, key) => {
    if (key === 'package' || key === 'api') return snapshotValue(value, new Set());
    if (
      typeof value === 'function' ? key !== 'handler' : typeof value === 'object' && value !== null
    ) {
      throw new RouteSnapshotRefusal(
        key === 'boundary'
          ? 'unknown boundary: boundary must be a string'
          : 'route fields must be primitive values',
      );
    }
    return value;
  });
  if (typeof snapshot.method !== 'string' || typeof snapshot.path !== 'string') {
    throw new RouteSnapshotRefusal('method and path must be strings');
  }
  if (typeof snapshot.handler !== 'function') {
    throw new RouteSnapshotRefusal('handler must be a function');
  }
  return Object.freeze(snapshot) as unknown as RouteDefinition;
}

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
  readonly identityDescriptor: IdentityDescriptor | null;
  readonly sourceProviders: ReadonlyMap<string, SourceProvider>;
}

export interface RegistrationOptions {
  readonly sourceProviderContext?: SourceProviderContext;
  readonly packageResolver?: PackageVisibilityPort;
  readonly coreJobs?: readonly RegisteredCoreJob[];
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
  'identityDescriptor',
  'sourceProviders',
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
  const jobs: RegisteredJob[] = [];
  const jobNames = new Set<string>();
  const bindings = new Map<PortName, string>();
  let identityFactory: IdentityProviderFactory | null = null;
  let identityDescriptor: IdentityDescriptor | null = null;
  const sourceProviders = new Map<string, SourceProvider>();
  const sourceProviderOwners = new Map<string, string>();
  const [minApi, maxApi] = SUPPORTED_PLUGIN_API;

  for (const [index, core] of (options.coreJobs ?? []).entries()) {
    if (!isRegisteredCoreJob(core)) {
      problems.push(`core job was not issued by registerCoreJob (coreJobs entry ${index})`);
      continue;
    }
    jobs.push(core);
    if (jobNames.has(core.qualifiedName)) {
      problems.push(`job "${core.qualifiedName}" is registered more than once`);
    }
    jobNames.add(core.qualifiedName);
  }

  for (const plugin of plugins) {
    const id = plugin.id;

    if (!Number.isInteger(plugin.apiVersion)) {
      problems.push(`plugin "${id}" apiVersion must be an integer`);
    } else if (!(plugin.apiVersion >= minApi && plugin.apiVersion <= maxApi)) {
      problems.push(
        `plugin "${id}" has apiVersion ${plugin.apiVersion}, core supports ${minApi} to ${maxApi}`,
      );
    }
    let validId: boolean | undefined;
    if (isReservedPluginId(id)) {
      validId = false;
      problems.push(`plugin id "${id}" is reserved`);
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
    let descriptorMalformed = false;
    try {
      const descriptor: unknown = plugin.identityDescriptor;
      if (descriptor !== undefined && !bindsIdentity) {
        problems.push(`plugin "${id}" identityDescriptor requires an identity binding`);
      } else if (descriptor !== undefined) {
        identityDescriptor = snapshotIdentityDescriptor(descriptor);
        descriptorMalformed = identityDescriptor === null;
      }
    } catch {
      descriptorMalformed = true;
    }
    if (descriptorMalformed) problems.push(`plugin "${id}" identityDescriptor is malformed`);
    const factory: unknown = plugin.identityProviders;
    problems.push(...providerFactoryProblems(id, 'identity', 'identityProviders', factory, binds));
    if (bindsIdentity && typeof factory === 'function' && bindings.get('identity') === id) {
      identityFactory = factory as IdentityProviderFactory;
    }

    const sourceFactory: unknown = plugin.sourceProviders;
    problems.push(
      ...providerFactoryProblems(id, 'source', 'sourceProviders', sourceFactory, binds),
    );
    if (sourceFactory !== undefined && plugin.apiVersion < SOURCE_PROVIDERS_API_VERSION) {
      problems.push(
        `plugin "${id}" declares sourceProviders and requires apiVersion ${SOURCE_PROVIDERS_API_VERSION}`,
      );
    }
    if (binds.includes('source') && typeof sourceFactory === 'function') {
      for (const provider of invokeSourceFactory(
        id,
        sourceFactory as SourceProviderFactory,
        problems,
        options.sourceProviderContext,
      )) {
        const holder = sourceProviderOwners.get(provider.id);
        if (holder !== undefined) {
          problems.push(
            `source provider "${provider.id}" is supplied by plugins "${holder}" and "${id}"`,
          );
        } else {
          sourceProviderOwners.set(provider.id, id);
          sourceProviders.set(provider.id, provider);
        }
      }
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
          try {
            own.push(snapshotRoute(route));
          } catch (error) {
            if (!(error instanceof RouteSnapshotRefusal)) throw error;
            problems.push(`plugin "${id}" route is invalid: ${error.message}`);
          }
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
          if (validId === undefined) {
            try {
              assertPluginId(id);
              validId = true;
            } catch (error) {
              validId = false;
              problems.push(`plugin "${id}" id is invalid: ${jobProblemCode(error)}`);
            }
          }
          if (!validId) return;
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
      const apiProblems = routeApiProblems(
        route,
        `plugin "${id}" route ${route.method} ${route.path}`,
      );
      problems.push(...boundaryProblems, ...apiProblems);
      if (
        pathProblem === null &&
        methodAllowed &&
        boundaryProblems.length === 0 &&
        apiProblems.length === 0
      ) {
        routes.push(Object.freeze({ ...route, plugin: id }));
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
    identityDescriptor,
    sourceProviders,
  };
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (keys.some((key) => !Object.hasOwn(value, key))) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  return Object.fromEntries(keys.map((key) => [key, (value as Record<string, unknown>)[key]]));
}

function snapshotIdentityDescriptor(value: unknown): IdentityDescriptor | null {
  const { runtimeProviders, compiled } = fields(value, ['runtimeProviders', 'compiled']) ?? {};
  if (typeof runtimeProviders !== 'boolean' || !Array.isArray(compiled)) return null;
  const length = readLength(compiled as unknown[]);
  if (length === null || length > 64) return null;
  const ids = new Set<string>();
  const anchors = new Set<string>();
  const entries: IdentityDescriptor['compiled'][number][] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(compiled, index)) return null;
    const { id, kind, anchor } =
      fields((compiled as unknown[])[index], ['id', 'kind', 'anchor']) ?? {};
    if (
      typeof id !== 'string' ||
      !isValidProviderId(id) ||
      isReservedProviderId(id) ||
      (kind !== 'oidc' && kind !== 'cloudflare-access') ||
      typeof anchor !== 'string' ||
      !isValidTrustAnchor(anchor) ||
      !anchor.startsWith(kind === 'oidc' ? 'oidc:' : 'access:')
    )
      return null;
    const canonical = canonicalAnchor(anchor);
    if (ids.has(id) || anchors.has(canonical)) return null;
    ids.add(id);
    anchors.add(canonical);
    entries.push(Object.freeze({ id, kind, anchor }));
  }
  return Object.freeze({ runtimeProviders, compiled: Object.freeze(entries) });
}

function providerFactoryProblems(
  id: string,
  port: PortName,
  key: string,
  factory: unknown,
  binds: readonly string[],
): string[] {
  const bound = binds.includes(port);
  const problems: string[] = [];
  if (factory !== undefined && typeof factory !== 'function') {
    problems.push(`plugin "${id}" ${key} must be a function`);
  }
  if (bound && factory === undefined) {
    problems.push(`plugin "${id}" binds ${port} but has no ${key}`);
  }
  if (!bound && factory !== undefined) {
    problems.push(`plugin "${id}" has ${key} but does not bind ${port}`);
  }
  return problems;
}

function invokeSourceFactory(
  id: string,
  factory: SourceProviderFactory,
  problems: string[],
  context?: SourceProviderContext,
): readonly SourceProvider[] {
  let returned: unknown;
  try {
    returned = context === undefined ? factory() : factory(context);
  } catch (error) {
    problems.push(`plugin "${id}" sourceProviders threw ${reportableErrorName(error)}`);
    return [];
  }
  if (isThenable(returned)) {
    problems.push(`plugin "${id}" sourceProviders must be synchronous`);
    returned.then(undefined, () => undefined);
    return [];
  }
  if (!Array.isArray(returned)) {
    problems.push(`plugin "${id}" sourceProviders must return an array`);
    return [];
  }
  const valid: SourceProvider[] = [];
  for (const provider of returned as unknown[]) {
    const providerId = (provider as { id?: unknown } | null)?.id;
    if (typeof providerId !== 'string' || providerId === '') {
      problems.push(`plugin "${id}" sourceProviders returned a provider without an id`);
    } else {
      valid.push(provider as SourceProvider);
    }
  }
  return valid;
}
