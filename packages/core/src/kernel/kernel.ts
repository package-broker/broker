import { setAccessContext } from '../authz/access-context.js';
import type { AccessContextSnapshot } from '../authz/access-context.js';
import { engineGrantOf, packageActorOf } from '../authz/engine.js';
import { packageKey } from '../catalogue/names.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { OrgContext } from '../db/port.js';
import type {
  PluginDefinition,
  PluginPorts,
  Platform,
  Principal,
  RequestContext,
  RouteDefinition,
} from '../plugin.js';
import { createRepositoryJobs } from '../platform/jobs-port.js';
import type { JobsFactory } from '../platform/jobs-port.js';
import type {
  LogRecord,
  Observability,
  ObservabilityScope,
  ObsRecordSink,
  ObsRegistry,
} from '../platform/observability.js';
import { forPlugin, noopObservability, safeRecord } from '../platform/observability.js';
import type { HookErrorHandler } from './access.js';
import { authorizeRoute, denyAllEngine, ENGINE_PLUGIN, INPUT_PLUGIN } from './authorize.js';
import type {
  AuthorizationDecision,
  AuthorizationEngine,
  AuthorizationRequest,
  DenyLogger,
} from './authorize.js';
import { denialResponse } from './denial-page.js';
import { defaultLog, envelopeResponse, errorResponse, responseReason } from './errors.js';
import type { KernelLog } from './errors.js';
import { reportableErrorName } from './error-name.js';
import { liveResponse, readyResponse } from './health.js';
import {
  denyReason,
  engineStatusReason,
  hookErrorReason,
  isEngineFailure,
  KERNEL_EVENTS,
  KERNEL_REASON_CODES,
} from './obs-codes.js';
import {
  createCompletionGuard,
  createHttpMetrics,
  createRequestScope,
  logSink,
} from './request-scope.js';
import type { CompletionGuard, KernelObsContext, RequestScope } from './request-scope.js';
import { collectRegistrations, KernelConfigError, ROUTE_METHODS } from './registry.js';
import type { RegisteredJob, Registration } from './registry.js';
import { bindPluginPorts } from './plugin-ports.js';
import type { PlatformServices } from './plugin-ports.js';
import { setResolvedPackage } from './package-context.js';
import type { PackageVisibility, PackageVisibilityPort } from '../db/catalogue.js';
import {
  routeApiProblems,
  routeBoundaryProblems,
  routePathProblem,
  routesConflict,
} from './routes.js';
import { uiRootRedirect } from './ui-routes.js';

export interface KernelObservability {
  readonly sink: ObsRecordSink;
  readonly deploymentId: string;
  /** Honour an inbound W3C traceparent. Only behind a trusted proxy. Default false. */
  readonly trustInboundTraceparent?: boolean;
}

export interface KernelOptions {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
  readonly registration?: Registration;
  readonly ports: PluginPorts;
  readonly resolveOrg: () => Promise<OrgContext>;
  /** Uncached database probe, called on every readiness request. */
  readonly health: () => Promise<boolean>;
  /** Routes under `/_pb/`, registered before plugin routes and served through the same pipeline. */
  readonly coreRoutes?: readonly RouteDefinition[];
  /** Package-visibility resolver bound by the package-visibility feature; required by project:packages:* routes. */
  readonly packageResolver?: PackageVisibilityPort;
  /** Default denyAllEngine. */
  readonly authorization?: AuthorizationEngine;
  /** Default defaultLog. Ignored when `observability` is set. */
  readonly log?: KernelLog;
  /** Default: records go to `log` through `logSink`, deployment id `unconfigured`. */
  readonly observability?: KernelObservability;
  /** Unscoped runtime services; the kernel binds them per plugin, request and job. */
  readonly platformServices?: PlatformServices;
}

export interface JobClaim {
  readonly jobId: string;
  readonly attempt: number;
}

export interface JobScope {
  readonly ports: PluginPorts;
  readonly observability: Observability;
}

export interface Kernel {
  fetch(request: Request): Promise<Response>;
  readonly registration: Registration;
  readonly coreRoutes: readonly RouteDefinition[];
  /** Route templates usable as metric `route` labels and OTLP route attributes. */
  readonly routeTemplates: ReadonlySet<string>;
  /** Ports and observability for one claimed attempt of a job from `registration.jobs`. */
  jobScope(job: RegisteredJob, claim: JobClaim): JobScope;
}

type KernelEnv = {
  Bindings: {
    readonly requestId: string;
    readonly markLogged: () => void;
    readonly scope: RequestScope;
    readonly guard: CompletionGuard;
    readonly log: KernelLog;
  };
};
type RegisteredRoute = Registration['routes'][number];

const CORE_PLUGIN = 'core';
/** authorizeRoute rejects an empty permission; the engine ignores this value on the authenticated boundary. */
const AUTHENTICATED_PLACEHOLDER = 'authenticated';
const CORE_PREFIX = '/_pb/';
const RESERVED_ROOTS = ['/health', '/_pb'] as const;

const REQUEST_ID_HEADER = 'x-request-id';
const HEALTH_ROUTES = ['/health/live', '/health/ready'] as const;
const UNCONFIGURED_DEPLOYMENT = 'unconfigured';

function portAccepts(field: 'route' | 'deployment_id', value: string): boolean {
  return safeRecord({ level: 'debug', event: 'probe', [field]: value })?.[field] === value;
}

function scopedLog(scope: RequestScope): KernelLog {
  return (entry) => {
    scope.obs().log(entry as LogRecord);
  };
}

const silent: KernelLog = () => undefined;

function hookPlugin(label: string): string {
  return label.startsWith('core:') ? CORE_PLUGIN : label;
}

function frozenSet(values: Iterable<string>): ReadonlySet<string> {
  const set = new Set(values);
  for (const method of ['add', 'delete', 'clear'] as const) {
    Object.defineProperty(set, method, {
      value: () => {
        throw new TypeError('Kernel route templates are frozen');
      },
    });
  }
  return Object.freeze(set);
}

type EngineCopy = { readonly [key: string]: unknown };

function dataCopy(raw: unknown): EngineCopy | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  try {
    if (Object.getPrototypeOf(raw) !== Object.prototype) return undefined;
    const descriptors: Record<PropertyKey, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(raw);
    if (!Reflect.ownKeys(descriptors).every((key) => 'value' in descriptors[key]!)) {
      return undefined;
    }
    return Object.defineProperties({}, descriptors) as EngineCopy;
  } catch {
    return undefined;
  }
}

async function failed(
  error: unknown,
  requestId: string,
  log: KernelLog,
  guard: CompletionGuard,
): Promise<Response> {
  try {
    const response = errorResponse(error, requestId, log);
    guard.reason(responseReason(response) ?? 'http.handler_status');
    return response;
  } catch {
    log({ level: 'error', event: 'http.error', error_name: 'Error' });
    guard.reason('error.internal');
    return envelopeResponse(500, 'internal', 'Internal error', requestId);
  }
}

export const AUTHORIZATION_RETRY_AFTER_SECONDS = 5;

function authorizationUnavailable(requestId: string): Response {
  const response = envelopeResponse(
    503,
    'unavailable',
    'Authorization is temporarily unavailable',
    requestId,
    'authz.engine_error',
  );
  response.headers.set('retry-after', String(AUTHORIZATION_RETRY_AFTER_SECONDS));
  return response;
}

function withRequestId(response: Response, requestId: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(REQUEST_ID_HEADER, requestId);
  return copy;
}

function validateCoreRoutes(
  routes: readonly RouteDefinition[],
  packageResolver: PackageVisibilityPort | undefined,
): readonly string[] {
  const problems: string[] = [];
  const eligible: RouteDefinition[] = [];
  for (const route of routes) {
    const label = `core route ${String(route.method)} ${String(route.path)}`;
    let placeable = true;
    if (typeof route.path !== 'string') {
      problems.push(`${label}: path must be a string`);
      placeable = false;
    } else if (!route.path.startsWith(CORE_PREFIX)) {
      problems.push(
        `${label}: path ${JSON.stringify(route.path)} must start with "${CORE_PREFIX}"`,
      );
      placeable = false;
    } else if (route.path === CORE_PREFIX) {
      problems.push(
        `${label}: path ${JSON.stringify(route.path)} must name a path below "${CORE_PREFIX}"`,
      );
      placeable = false;
    } else {
      const pathProblem = routePathProblem(`/${route.path.slice(CORE_PREFIX.length)}`);
      if (pathProblem !== null) {
        problems.push(`${label}: path ${JSON.stringify(route.path)}: ${pathProblem}`);
        placeable = false;
      }
    }
    if (!ROUTE_METHODS.has(route.method)) {
      problems.push(`${label}: method must be one of ${[...ROUTE_METHODS].join(', ')}`);
      placeable = false;
    }
    problems.push(
      ...routeBoundaryProblems(route, label, {
        allowSelf: true,
        allowAuthenticated: true,
        ...(packageResolver === undefined ? {} : { packageResolver }),
      }),
    );
    problems.push(...routeApiProblems(route, label));
    if (placeable) eligible.push(route);
  }
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      if (routesConflict(a, b)) {
        problems.push(`core route ${a.method} ${a.path} conflicts with ${b.method} ${b.path}`);
      }
    }
  }
  return problems;
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const coreRoutes = Object.freeze(
    (options.coreRoutes ?? []).map((route) => Object.freeze({ ...route })),
  );
  const coreProblems = [...validateCoreRoutes(coreRoutes, options.packageResolver)];
  let registration: Registration;
  try {
    registration =
      options.registration ??
      collectRegistrations(
        options.plugins,
        options.packageResolver === undefined ? {} : { packageResolver: options.packageResolver },
      );
  } catch (error) {
    if (error instanceof KernelConfigError) {
      throw new KernelConfigError([...error.problems, ...coreProblems]);
    }
    throw error;
  }
  for (const route of registration.routes) {
    if (route.path === '/') {
      coreProblems.push('plugin root route is reserved for core');
    }
  }
  if (coreProblems.length > 0) throw new KernelConfigError(coreProblems);
  const { ports, resolveOrg, health } = options;
  const services = options.platformServices;
  if (Object.hasOwn(ports, 'platform') || ports.platform !== undefined) {
    throw new KernelConfigError(['ports.platform is bound by the kernel; pass platform services']);
  }
  Object.freeze(ports);
  const registeredJobs = Object.freeze([...registration.jobs]);
  if (services === undefined && registeredJobs.length > 0) {
    const owners = [...new Set(registeredJobs.map((job) => job.plugin))];
    throw new KernelConfigError(
      owners.map((owner) => `plugin "${owner}" registers jobs but platform services are disabled`),
    );
  }
  const jobs: JobsFactory | undefined =
    services === undefined
      ? undefined
      : createRepositoryJobs({
          store: services.jobStore,
          jobs: registeredJobs,
          clock: ports.clock,
          ids: ports.ids,
        });
  const engine = options.authorization ?? denyAllEngine;
  const deploymentId = options.observability?.deploymentId ?? UNCONFIGURED_DEPLOYMENT;
  if (!portAccepts('deployment_id', deploymentId)) {
    throw new KernelConfigError(['observability.deploymentId does not match the port pattern']);
  }
  const routeTemplates = frozenSet(
    [
      '/',
      ...registration.routes.map((route) => route.path),
      ...coreRoutes.map((route) => route.path),
      ...HEALTH_ROUTES,
    ].filter((path) => portAccepts('route', path)),
  );
  const registry: ObsRegistry = {
    events: KERNEL_EVENTS,
    reasonCodes: KERNEL_REASON_CODES,
    routeTemplates,
  };
  const obsContext: KernelObsContext = {
    sink: options.observability?.sink ?? logSink(options.log ?? defaultLog),
    registry,
    deploymentId,
    runtime: options.platform,
    trustInboundTraceparent: options.observability?.trustInboundTraceparent === true,
  };
  const httpMetrics = createHttpMetrics(obsContext);
  const accessChecks = registration.hooks['access.check'];

  const pluginObservability = (
    pluginId: string,
    extra: Pick<ObservabilityScope, 'jobId' | 'attempt'> = {},
  ): Observability => {
    try {
      return forPlugin(
        obsContext.sink,
        { deploymentId, runtime: obsContext.runtime, requestId: null, ...extra },
        pluginId,
        registry,
      );
    } catch {
      return noopObservability;
    }
  };
  const unattended = Object.freeze({ projectId: null, tokenId: null });

  for (const plugin of options.plugins) {
    if (plugin.init === undefined) continue;
    await plugin.init(
      bindPluginPorts(ports, services, jobs, {
        pluginId: plugin.id,
        observability: pluginObservability(plugin.id),
        initiator: unattended,
      }),
    );
  }

  function jobScope(job: RegisteredJob, claim: JobClaim): JobScope {
    if (!registeredJobs.includes(job)) {
      throw new TypeError('jobScope requires a job from kernel.registration.jobs');
    }
    const observability = pluginObservability(job.plugin, {
      jobId: claim.jobId,
      attempt: claim.attempt,
    });
    return Object.freeze({
      ports: bindPluginPorts(ports, services, jobs, {
        pluginId: job.plugin,
        observability,
        initiator: unattended,
      }),
      observability,
    });
  }

  async function invoke(
    route: RegisteredRoute,
    c: Context<KernelEnv>,
    org: OrgContext | null,
    principal: Principal | null,
    projectId: string | null,
    snapshot: AccessContextSnapshot | null,
    resolved: Exclude<PackageVisibility, { kind: 'absent' }> | null = null,
  ): Promise<Response> {
    const context: RequestContext = Object.freeze({
      request: c.req.raw,
      requestId: c.env.requestId,
      org,
      principal,
      projectId,
      params: Object.freeze({ ...c.req.param() }),
      ports: bindPluginPorts(ports, services, jobs, {
        pluginId: route.plugin,
        observability: c.env.scope.obs({ plugin: route.plugin }),
        initiator: { projectId, tokenId: c.env.scope.fields().tokenId ?? null },
      }),
    });
    if (snapshot !== null) {
      try {
        setAccessContext(context, snapshot);
        if (resolved !== null) setResolvedPackage(context, resolved);
      } catch (error) {
        c.env.guard.reason(hookErrorReason(ENGINE_PLUGIN, ENGINE_PLUGIN));
        c.env.scope.obs({ plugin: hookPlugin(ENGINE_PLUGIN) }).log({
          level: 'error',
          event: 'authz.error',
          error_name: reportableErrorName(error),
          reason_code: hookErrorReason(ENGINE_PLUGIN, ENGINE_PLUGIN),
        });
        return authorizationUnavailable(c.env.requestId);
      }
    }
    const response: unknown = await route.handler(context);
    if (!(response instanceof Response)) {
      throw new TypeError(`route ${route.method} ${route.path} did not return a Response`);
    }
    if (response.status >= 400) {
      c.env.guard.reason(responseReason(response) ?? 'http.handler_status');
    }
    return response;
  }

  function routeNotFound(requestId: string): Response {
    return envelopeResponse(404, 'not_found', 'Route not found', requestId);
  }

  async function serve(route: RegisteredRoute, c: Context<KernelEnv>): Promise<Response> {
    const { requestId, scope, guard } = c.env;
    scope.set({ route: route.path });
    const permission =
      route.permission ?? (route.boundary === 'authenticated' ? AUTHENTICATED_PLACEHOLDER : null);
    if (route.boundary === 'self') {
      guard.reason('authz.unauthenticated');
      return envelopeResponse(401, 'unauthorized', 'Unauthorized', requestId);
    }
    if (permission === null) {
      const org = route.needsOrg === false ? null : await resolveOrg();
      return invoke(route, c, org, null, null, {
        principal: null,
        projectId: null,
        boundary: 'none',
        sessionId: null,
        actor: null,
        rateKey: { stage: 'anonymous', ip: null, routeClass: 'none' },
      });
    }

    const org = await resolveOrg();
    let accepted: EngineCopy | undefined;
    let engineOpen = true;
    let engineFailed = false;
    const observedEngine: AuthorizationEngine = {
      async authorize(input) {
        if (engine === denyAllEngine) throw new TypeError('authorization engine is not configured');
        const raw: unknown = await engine.authorize(input);
        const copy = engineOpen ? dataCopy(raw) : undefined;
        if (copy === undefined) return raw as AuthorizationDecision;
        accepted = copy;
        return copy as unknown as AuthorizationDecision;
      },
    };
    const afterEngineAllow = (): void => {
      if (accepted?.['allow'] !== true) return;
      const { projectId, tokenId } = accepted;
      scope.set({
        projectId: typeof projectId === 'string' ? projectId : null,
        tokenId: typeof tokenId === 'string' ? tokenId : null,
      });
    };
    const onHookError: HookErrorHandler = (event) => {
      const reason = hookErrorReason(event.plugin, ENGINE_PLUGIN);
      const failure = isEngineFailure(reason);
      if (failure) engineFailed = true;
      if (event.plugin === ENGINE_PLUGIN) engineOpen = false;
      if (event.plugin !== ENGINE_PLUGIN && event.plugin !== INPUT_PLUGIN) afterEngineAllow();
      guard.reason(reason);
      scope.obs({ plugin: hookPlugin(event.plugin) }).log({
        level: failure ? 'error' : 'warn',
        event: 'authz.error',
        error_name: reportableErrorName(event.error),
        reason_code: reason,
      });
    };
    const onDeny: DenyLogger = (entry) => {
      const reason = denyReason(entry.reason);
      afterEngineAllow();
      guard.reason(reason);
      scope.obs({ plugin: hookPlugin(entry.plugin) }).log({
        level: 'warn',
        event: 'authz.denied',
        reason_code: reason,
      });
    };
    const authorizationRequest: AuthorizationRequest = {
      request: c.req.raw,
      org,
      route: {
        plugin: route.plugin,
        method: route.method,
        path: route.path,
        permission,
        ...(route.boundary === undefined
          ? {}
          : { boundary: route.boundary === 'package' ? 'project' : route.boundary }),
      },
      params: Object.freeze({ ...c.req.param() }),
    };
    const decision = await authorizeRoute(
      authorizationRequest,
      observedEngine,
      accessChecks,
      onHookError,
      { onDeny },
    );
    engineOpen = false;
    if (!decision.allow) {
      if (engineFailed) return authorizationUnavailable(requestId);
      guard.reason(engineStatusReason(decision.status));
      if (decision.status === 401) {
        return envelopeResponse(401, 'unauthorized', 'Unauthorized', requestId);
      }
      if (decision.status === 404) return routeNotFound(requestId);
      return denialResponse(c.req.raw, requestId);
    }
    scope.set({ projectId: decision.projectId, tokenId: decision.tokenId ?? null });
    const grant = engineGrantOf(authorizationRequest);
    const packageActor = route.boundary === 'package' ? packageActorOf(authorizationRequest) : null;
    if (grant === null && route.boundary !== 'package') {
      return invoke(route, c, org, decision.principal, decision.projectId, null);
    }
    if (
      grant === null ||
      grant.principal.kind !== decision.principal.kind ||
      grant.principal.id !== decision.principal.id ||
      grant.projectId !== decision.projectId ||
      (route.boundary === 'package' &&
        (packageActor === null ||
          packageActor.userId !== decision.principal.id ||
          packageActor.projectId !== decision.projectId ||
          packageActor.orgId !== org.orgId))
    ) {
      onHookError({ plugin: ENGINE_PLUGIN, error: new TypeError('inconsistent engine grant') });
      return authorizationUnavailable(requestId);
    }
    let resolved: Exclude<PackageVisibility, { kind: 'absent' }> | null = null;
    if (route.boundary === 'package') {
      const binding = route.package;
      if (binding === undefined || packageActor === null || options.packageResolver === undefined) {
        throw new TypeError('package resolution is not configured');
      }
      const name = binding.name(authorizationRequest.params);
      const absent = (): Response => {
        guard.reason(engineStatusReason(404));
        return routeNotFound(requestId);
      };
      if (typeof name !== 'string' || name.length === 0) return absent();
      const outcome = await options.packageResolver.resolve(packageActor, binding.ecosystem, name);
      if (outcome.kind === 'absent') return absent();
      const key = packageKey(name, {
        ecosystem: binding.ecosystem,
        legacyCase: binding.ecosystem === 'npm',
      });
      if (outcome.kind === 'visible') {
        if (
          outcome.pkg.projectId !== packageActor.projectId ||
          outcome.pkg.ecosystem !== binding.ecosystem ||
          outcome.pkg.key !== key
        ) {
          throw new TypeError('inconsistent resolved package');
        }
        resolved = Object.freeze({ ...outcome, pkg: Object.freeze({ ...outcome.pkg }) });
      } else if (outcome.kind === 'proxy_admissible') {
        if (
          outcome.projectId !== packageActor.projectId ||
          outcome.ecosystem !== binding.ecosystem ||
          outcome.key !== key ||
          outcome.sourceIds.length === 0
        ) {
          throw new TypeError('inconsistent proxy admission');
        }
        if (binding.fetchOnAdmission !== true || c.req.method === 'HEAD') return absent();
        resolved = Object.freeze({ ...outcome, sourceIds: Object.freeze([...outcome.sourceIds]) });
      } else {
        throw new TypeError('unknown package resolution');
      }
    }
    const boundary = route.boundary === 'package' ? 'project' : (route.boundary ?? 'none');
    const snapshot: AccessContextSnapshot = {
      principal: grant.principal,
      projectId: grant.projectId,
      boundary,
      sessionId: grant.sessionId,
      actor: grant.actor,
      rateKey: {
        stage: 'authenticated',
        tokenSelector: grant.tokenSelector,
        principalId: grant.principal.id,
        routeClass: boundary,
      },
    };
    return invoke(route, c, org, decision.principal, decision.projectId, snapshot, resolved);
  }

  const app = new Hono<KernelEnv>();
  app.get('/', (c) => {
    c.env.scope.set({ route: '/' });
    const redirect = uiRootRedirect(c.req.raw);
    if (redirect !== null) return redirect;
    c.env.guard.reason('route.not_found');
    const response = routeNotFound(c.env.requestId);
    response.headers.set('vary', 'Accept');
    return response;
  });
  app.get('/health/live', (c) => {
    c.env.scope.set({ route: '/health/live' });
    return liveResponse(c.env.requestId);
  });
  app.get('/health/ready', async (c) => {
    c.env.scope.set({ route: '/health/ready' });
    const response = await readyResponse(health, resolveOrg, c.env.requestId, { log: c.env.log });
    if (response.status >= 500) {
      c.env.markLogged();
      c.env.guard.reason('health.not_ready');
    }
    return response;
  });
  for (const route of coreRoutes) {
    const registered: RegisteredRoute = { ...route, plugin: CORE_PLUGIN };
    app.on(route.method, route.path, (c) => serve(registered, c));
  }
  const reservedNotFound = (c: Context<KernelEnv>): Response => {
    c.env.guard.reason('route.not_found');
    return routeNotFound(c.env.requestId);
  };
  for (const root of RESERVED_ROOTS) {
    app.all(root, reservedNotFound);
    app.all(`${root}/*`, reservedNotFound);
  }
  for (const route of registration.routes) {
    app.on(route.method, route.path, (c) => serve(route, c));
  }
  app.notFound(reservedNotFound);
  app.onError(async (error, c) => {
    const response = await failed(error, c.env.requestId, c.env.log, c.env.guard);
    c.env.markLogged();
    return response;
  });

  async function fetch(request: Request): Promise<Response> {
    const scope = createRequestScope(obsContext, request);
    const guard = createCompletionGuard(scope, httpMetrics, request.signal);
    const { requestId } = scope;
    const isHead = request.method === 'HEAD';
    const log = scopedLog(scope);
    let logged = false;
    let response: Response | undefined;
    try {
      try {
        response = await app.fetch(request, {
          requestId,
          markLogged: () => {
            logged = true;
          },
          scope,
          guard,
          log,
        });
      } catch (error) {
        response = await failed(error, requestId, logged ? silent : log, guard);
        logged = true;
      }
      try {
        if (isHead) response = new Response(null, response);
        response = withRequestId(response, requestId);
      } catch (error) {
        const failure = await failed(error, requestId, logged ? silent : log, guard);
        response = isHead ? new Response(null, failure) : failure;
      }
      return response;
    } finally {
      guard.complete(response?.status ?? 500);
    }
  }

  return Object.freeze({ fetch, registration, coreRoutes, routeTemplates, jobScope });
}
