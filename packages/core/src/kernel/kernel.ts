import { Hono } from 'hono';
import type { Context } from 'hono';
import type { OrgContext } from '../db/port.js';
import type {
  PluginDefinition,
  PluginPorts,
  Platform,
  Principal,
  RequestContext,
} from '../plugin.js';
import type { HookErrorHandler } from './access.js';
import { authorizeRoute, denyAllEngine } from './authorize.js';
import type { AuthorizationEngine, DenyLogger } from './authorize.js';
import { defaultLog, envelopeResponse, errorResponse } from './errors.js';
import type { KernelLog } from './errors.js';
import { liveResponse, readyResponse } from './health.js';
import { collectRegistrations } from './registry.js';
import type { Registration } from './registry.js';

export interface KernelOptions {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
  readonly ports: PluginPorts;
  readonly resolveOrg: () => Promise<OrgContext>;
  /** Uncached database probe, called on every readiness request. */
  readonly health: () => Promise<boolean>;
  /** Default denyAllEngine. */
  readonly authorization?: AuthorizationEngine;
  /** Default defaultLog. */
  readonly log?: KernelLog;
}

export interface Kernel {
  fetch(request: Request): Promise<Response>;
  readonly registration: Registration;
}

type KernelEnv = {
  Bindings: {
    readonly requestId: string;
    readonly markLogged: () => void;
  };
};
type RegisteredRoute = Registration['routes'][number];

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

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const registration = collectRegistrations(options.plugins);
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

  return Object.freeze({ fetch, registration });
}
