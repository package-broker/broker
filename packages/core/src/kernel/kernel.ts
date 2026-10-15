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
import type { HookErrorHandler } from './access.js';
import { authorizeRoute, denyAllEngine } from './authorize.js';
import type { AuthorizationEngine, DenyLogger } from './authorize.js';
import { defaultLog, envelopeResponse, errorResponse } from './errors.js';
import type { KernelLog } from './errors.js';
import { liveResponse, readyResponse } from './health.js';
import { collectRegistrations, KernelConfigError, ROUTE_METHODS } from './registry.js';
import type { Registration } from './registry.js';
import { routePathProblem, routesConflict } from './routes.js';

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
  /** Default denyAllEngine. */
  readonly authorization?: AuthorizationEngine;
  /** Default defaultLog. */
  readonly log?: KernelLog;
}

export interface Kernel {
  fetch(request: Request): Promise<Response>;
  readonly registration: Registration;
  readonly coreRoutes: readonly RouteDefinition[];
}

type KernelEnv = {
  Bindings: {
    readonly requestId: string;
    readonly markLogged: () => void;
  };
};
type RegisteredRoute = Registration['routes'][number];

const CORE_PLUGIN = 'core';
const CORE_PREFIX = '/_pb/';
const RESERVED_ROOTS = ['/health', '/_pb'] as const;

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error';
}

function guardedLog(sink: KernelLog): KernelLog {
  return (entry) => {
    try {
      sink(entry);
    } catch {
      return;
    }
  };
}

function withRequestId(response: Response, requestId: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(REQUEST_ID_HEADER, requestId);
  return copy;
}

function validateCoreRoutes(routes: readonly RouteDefinition[]): readonly string[] {
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
    if (route.needsOrg === false && route.permission !== null) {
      problems.push(`${label}: a route without organization context must be public`);
    }
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
  const coreProblems = validateCoreRoutes(coreRoutes);
  let registration: Registration;
  try {
    registration = options.registration ?? collectRegistrations(options.plugins);
  } catch (error) {
    if (error instanceof KernelConfigError) {
      throw new KernelConfigError([...error.problems, ...coreProblems]);
    }
    throw error;
  }
  if (coreProblems.length > 0) throw new KernelConfigError(coreProblems);
  const { ports, resolveOrg, health } = options;
  const engine = options.authorization ?? denyAllEngine;
  const log = guardedLog(options.log ?? defaultLog);
  const accessChecks = registration.hooks['access.check'];

  for (const plugin of options.plugins) {
    if (plugin.init !== undefined) await plugin.init(ports);
  }

  async function invoke(
    route: RegisteredRoute,
    c: Context<KernelEnv>,
    org: OrgContext | null,
    principal: Principal | null,
    projectId: string | null,
  ): Promise<Response> {
    const context: RequestContext = Object.freeze({
      request: c.req.raw,
      requestId: c.env.requestId,
      org,
      principal,
      projectId,
      params: Object.freeze({ ...c.req.param() }),
      ports,
    });
    const response: unknown = await route.handler(context);
    if (!(response instanceof Response)) {
      throw new TypeError(`route ${route.method} ${route.path} did not return a Response`);
    }
    return response;
  }

  async function serve(route: RegisteredRoute, c: Context<KernelEnv>): Promise<Response> {
    const requestId = c.env.requestId;
    const permission = route.permission;
    if (permission === null) {
      const org = route.needsOrg === false ? null : await resolveOrg();
      return invoke(route, c, org, null, null);
    }

    const org = await resolveOrg();
    const onHookError: HookErrorHandler = (event) => {
      log({ level: 'warn', requestId, plugin: event.plugin, error: errorName(event.error) });
    };
    const onDeny: DenyLogger = (entry) => {
      log({ level: 'warn', requestId, plugin: entry.plugin, reason: entry.reason });
    };
    const decision = await authorizeRoute(
      {
        request: c.req.raw,
        org,
        route: { plugin: route.plugin, method: route.method, path: route.path, permission },
        params: Object.freeze({ ...c.req.param() }),
      },
      engine,
      accessChecks,
      onHookError,
      { onDeny },
    );
    if (!decision.allow) {
      return decision.status === 401
        ? envelopeResponse(401, 'unauthorized', 'Unauthorized', requestId)
        : envelopeResponse(403, 'forbidden', 'Forbidden', requestId);
    }
    return invoke(route, c, org, decision.principal, decision.projectId);
  }

  const app = new Hono<KernelEnv>();
  app.get('/health/live', (c) => liveResponse(c.env.requestId));
  app.get('/health/ready', async (c) => {
    const response = await readyResponse(health, resolveOrg, c.env.requestId, { log });
    if (response.status >= 500) c.env.markLogged();
    return response;
  });
  for (const route of coreRoutes) {
    const registered: RegisteredRoute = { ...route, plugin: CORE_PLUGIN };
    app.on(route.method, route.path, (c) => serve(registered, c));
  }
  const reservedNotFound = (c: Context<KernelEnv>): Response =>
    envelopeResponse(404, 'not_found', 'Route not found', c.env.requestId);
  for (const root of RESERVED_ROOTS) {
    app.all(root, reservedNotFound);
    app.all(`${root}/*`, reservedNotFound);
  }
  for (const route of registration.routes) {
    app.on(route.method, route.path, (c) => serve(route, c));
  }
  app.notFound((c) => envelopeResponse(404, 'not_found', 'Route not found', c.env.requestId));
  app.onError((error, c) => {
    c.env.markLogged();
    return errorResponse(error, c.env.requestId, log);
  });

  async function fetch(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let logged = false;
    let response: Response;
    try {
      response = await app.fetch(request, {
        requestId,
        markLogged: () => {
          logged = true;
        },
      });
    } catch (error) {
      logged = true;
      response = errorResponse(error, requestId, log);
    }
    try {
      if (request.method === 'HEAD') response = new Response(null, response);
      response = withRequestId(response, requestId);
      if (response.status >= 500 && !logged) {
        log({ level: 'error', requestId, status: response.status });
      }
      return response;
    } catch (error) {
      const failure = errorResponse(error, requestId, log);
      return request.method === 'HEAD' ? new Response(null, failure) : failure;
    }
  }

  return Object.freeze({ fetch, registration, coreRoutes });
}
