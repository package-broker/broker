import { describe, expect, it, vi } from 'vitest';
import { generateOpenApi } from '../api/openapi.js';
import { openApiRoute } from '../api/openapi-route.js';
import type { ApiRouteSpec } from '../api/route.js';
import { API_ERROR_CODES } from '../api/response.js';
import { auditRoutes } from '../api/routes/audit.js';
import { myPermissionsRoute, myProjectPermissionsRoute } from '../api/routes/permissions.js';
import { createAuthModule, type AuthRepositories } from '../auth/module.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type { CatalogueReader } from '../db/catalogue.js';
import { orgContext, type SqlExecutor } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider } from '../identity/port.js';
import type { PluginDefinition, RouteDefinition } from '../plugin.js';
import { renderComposerP2, renderPackagesJson } from '../registry/composer/render.js';
import { renderPackument, renderVersionDocument } from '../registry/npm/render.js';
import { createKeyring } from '../secrets/keyring.js';
import { createKernel, type Kernel } from './kernel.js';
import { collectRegistrations } from './registry.js';

type LogEntry = Readonly<Record<string, unknown>>;
type FailureMode =
  'handler' | 'organization' | 'authorization' | 'deny-401' | 'deny-403' | 'deny-404';
const ORIGIN = 'https://broker.test';
const ORG = orgContext('org-1');
const clock = fixedClock('2026-10-19T00:00:00.000Z');

// Kernel and auth mappings are private; keep the allowed wire values explicit here.
const kernelErrors = [
  [500, 'internal', 'Internal error'],
  [503, 'not_bootstrapped', 'Organization is not bootstrapped'],
  [503, 'misconfigured', 'Server is not configured'],
  [503, 'unavailable', 'Try again later'],
  [503, 'unavailable', 'Authorization is temporarily unavailable'],
  [503, 'not_ready', 'Not ready'],
  [404, 'not_found', 'Route not found'],
  [404, 'not_found', 'Unknown provider'],
  [400, 'bad_request', 'Bad request'],
  [400, 'reauth_unsupported', 'Re-authentication is not supported'],
  [401, 'unauthorized', 'Unauthorized'],
  [401, 'invalid_credentials', 'Invalid credentials'],
  [401, 'login_failed', 'Login failed'],
  [403, 'forbidden', 'Forbidden'],
  [502, 'provider_error', 'Identity provider error'],
] as const;
const allowedErrors = [
  ...Object.entries(API_ERROR_CODES).map(([code, { status, message }]) => [status, code, message]),
  ...kernelErrors,
];

async function assertEnvelope(
  response: Response,
  logs: readonly LogEntry[],
  sentinel: string,
  npm = false,
) {
  const text = await response.text();
  for (const output of [text, JSON.stringify([...response.headers]), JSON.stringify(logs)]) {
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('SELECT secret');
  }
  if (response.status < 400) return;
  type ErrorFields = {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
  let error: ErrorFields;
  if (npm) {
    const body = JSON.parse(text) as { error: string; code: string; requestId: string };
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'requestId']);
    expect(typeof body.error).toBe('string');
    error = { code: body.code, message: body.error, requestId: body.requestId };
  } else {
    const body = JSON.parse(text) as { error: ErrorFields };
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(
      body.error.details === undefined
        ? ['code', 'message', 'requestId']
        : ['code', 'details', 'message', 'requestId'],
    );
    error = body.error;
  }
  expect(allowedErrors).toContainEqual([response.status, error.code, error.message]);
  expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(error.requestId).toBe(response.headers.get('x-request-id'));
  if (response.status >= 500) {
    const requestLogs = logs.filter(
      (entry) => entry['request_id'] === error.requestId || entry['requestId'] === error.requestId,
    );
    expect(
      requestLogs.some((entry) => entry['error_name'] === 'Error' || entry['error'] === 'Error'),
    ).toBe(true);
  }
  if (error.details !== undefined) {
    expect(response.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(Array.isArray(error.details)).toBe(true);
    expect((error.details as unknown[]).length).toBeLessThanOrEqual(20);
    for (const detail of error.details as {
      path: string;
      code: string;
      location?: string;
    }[]) {
      expect(Object.keys(detail).sort()).toEqual(
        detail.location === undefined ? ['code', 'path'] : ['code', 'location', 'path'],
      );
      if (detail.location !== undefined)
        expect(['params', 'query', 'body']).toContain(detail.location);
      expect(typeof detail.path).toBe('string');
      expect(typeof detail.code).toBe('string');
    }
  }
}

function repository<T extends object>(read: () => Promise<unknown>): T {
  return new Proxy({} as T, { get: () => read });
}

async function harness(mode: FailureMode, extra: readonly RouteDefinition[] = []) {
  const sentinel = crypto.randomUUID();
  const failure = () => {
    throw new Error(`${sentinel} SELECT secret`);
  };
  const db: SqlExecutor = { driver: 'none', all: vi.fn(failure), batch: vi.fn(failure) };
  const read = () => db.all({ sql: 'SELECT secret', params: [] });
  const logs: LogEntry[] = [];
  const provider: IdentityProvider = {
    id: 'fixture',
    kind: 'oidc',
    displayName: 'Fixture',
    trustAnchor: 'oidc:https://identity.test',
    supportsReauth: true,
    policy: { verifiedDomains: [], autoJoin: false },
    start: vi.fn(failure),
    finish: vi.fn(failure),
  };
  const plugin: PluginDefinition = {
    id: 'fixture',
    package: '@test/fixture',
    apiVersion: 3,
    platforms: ['node'],
    binds: ['identity'],
    identityProviders: () => [provider],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/fixture/items/:id',
        permission: null,
        handler: async (ctx) => {
          await ctx.ports.organizations.get(ORG);
          return new Response('unreachable');
        },
      });
      for (const route of extra) registry.route(route);
    },
  };
  const registration = collectRegistrations([plugin]);
  const repositories: AuthRepositories = {
    sessions: repository(read),
    users: repository(read),
    login: repository(read),
    localReader: repository(read),
    localSetup: repository(read),
    localSuccess: repository(read),
    credentials: repository(read),
  };
  const auth = createAuthModule({
    repositories,
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    clock,
    ids: { ulid: () => '01JA0000000000000000000000' },
    publicOrigin: ORIGIN,
    clientIp: () => null,
    providers: new Map([[provider.id, provider]]),
    hooks: registration.hooks,
    log: (entry) => logs.push(entry),
  });
  const coreRoutes = [
    ...auth.coreRoutes,
    ...auditRoutes({
      list: async () => {
        await read();
        return { items: [], next: null };
      },
      head: failure,
    }),
    myPermissionsRoute(),
    myProjectPermissionsRoute(),
  ];
  coreRoutes.push(
    openApiRoute(
      generateOpenApi(
        coreRoutes.filter(
          (route): route is RouteDefinition & ApiRouteSpec =>
            route.api !== undefined && !('exempt' in route.api),
        ),
        { title: 'Sweep', version: '1' },
      ),
    ),
  );
  const access = createPackageAccess(repository<CatalogueReader>(read));
  const actor = {
    kind: 'project' as const,
    userId: 'u',
    orgId: ORG.orgId,
    projectId: 'p',
    permissions: new Set(['project:packages:read']),
  };
  const ecosystemRoutes: RouteDefinition[] = [
    {
      method: 'GET',
      path: '/:project/npm/-/whoami',
      permission: 'project:read',
      boundary: 'project',
      handler: failure,
    },
    {
      method: 'GET',
      path: '/:project/packages.json',
      permission: null,
      handler: (ctx) =>
        renderPackagesJson({
          actor,
          access,
          projectSlug: ctx.params['project']!,
          requestId: ctx.requestId,
        }),
    },
    {
      method: 'GET',
      path: '/:project/p2/:vendor/:name',
      permission: null,
      handler: (ctx) =>
        renderComposerP2({
          actor,
          access,
          projectSlug: ctx.params['project']!,
          requestId: ctx.requestId,
          name: 'acme/pkg',
          publicUrl: ORIGIN,
          request: ctx.request,
          clock: { advance: failure },
        }),
    },
    {
      method: 'GET',
      path: '/:project/npm/:name',
      permission: null,
      handler: (ctx) =>
        renderPackument({
          actor,
          access,
          projectSlug: ctx.params['project']!,
          requestId: ctx.requestId,
          name: 'pkg',
          publicUrl: ORIGIN,
        }),
    },
    {
      method: 'GET',
      path: '/:project/npm/:name/:version',
      permission: null,
      handler: (ctx) =>
        renderVersionDocument(
          {
            actor,
            access,
            projectSlug: ctx.params['project']!,
            requestId: ctx.requestId,
            name: 'pkg',
            publicUrl: ORIGIN,
          },
          ctx.params['version']!,
        ),
    },
  ];
  const kernel = await createKernel({
    platform: 'node',
    plugins: [plugin],
    registration,
    coreRoutes,
    ecosystemRoutes,
    publicOrigin: ORIGIN,
    ports: {
      organizations: { get: vi.fn(failure) },
      clock,
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: async () => {
      if (mode === 'organization') await read();
      return ORG;
    },
    health: async () => {
      await read();
      return true;
    },
    authorization: {
      authorize: async ({ route }) => {
        if (mode === 'authorization') failure();
        if (mode === 'deny-401' || mode === 'deny-403' || mode === 'deny-404') {
          return {
            allow: false,
            status: mode === 'deny-401' ? 401 : mode === 'deny-403' ? 403 : 404,
          };
        }
        return {
          allow: true,
          principal: { kind: 'user', id: 'u' },
          projectId: route.boundary === 'project' ? 'p' : null,
        };
      },
    },
    log: (entry) => logs.push(entry),
  });
  return { kernel, ecosystemRoutes, logs, sentinel, db, provider };
}

type Harness = Awaited<ReturnType<typeof harness>>;
const samples: Record<string, string> = {
  provider: 'fixture',
  project: 'demo',
  vendor: 'acme',
  name: 'pkg',
  version: '1.0.0',
  id: 'sample',
};
function samplePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    expect(samples[name], `missing sample for :${name}`).toBeDefined();
    return samples[name]!;
  });
}

function registeredRoutes(kernel: Kernel, ecosystemRoutes: readonly RouteDefinition[]) {
  const routes = [
    ...kernel.coreRoutes,
    ...kernel.registration.routes,
    ...ecosystemRoutes,
    ...['/', '/health/live', '/health/ready'].map((path) => ({ method: 'GET', path })),
  ];
  expect(new Set(routes.map(({ path }) => path))).toEqual(kernel.routeTemplates);
  return routes;
}

async function sweep(h: Harness) {
  const seen = new Set<string>();
  const statuses = new Set<number>();
  const authBodies: Record<string, unknown> = {
    '/_pb/auth/sso/:provider/start': { purpose: 'login', returnTo: '/' },
    '/_pb/auth/local/setup/start': { token: 'T'.repeat(43) },
    '/_pb/auth/local/setup/finish': {
      token: 'T'.repeat(43),
      password: 'Strong passphrase 123!',
      code: '123456',
    },
    '/_pb/auth/local/login': {
      email: 'fixture@example.test',
      password: 'Strong passphrase 123!',
      code: '123456',
    },
    '/_pb/auth/local/reauth': { password: 'Strong passphrase 123!', code: '123456' },
    '/_pb/auth/logout': {},
  };
  for (const route of registeredRoutes(h.kernel, h.ecosystemRoutes)) {
    const path = samplePath(route.path);
    for (const malformed of [false, true]) {
      const body = malformed
        ? '{'
        : JSON.stringify(
            authBodies[route.path] ?? {
              token: 'T'.repeat(43),
              email: 'fixture@example.test',
              password: 'Strong passphrase 123!',
              code: '123456',
              purpose: 'login',
              returnTo: '/',
            },
          );
      const request = new Request(
        `${ORIGIN}${path}${malformed && route.path.includes('/audit') ? '?limit=0' : ''}`,
        {
          method: route.method,
          headers: {
            accept: 'application/json',
            origin: ORIGIN,
            'content-type': 'application/json',
            cookie: `__Host-pb_session=${'S'.repeat(43)}`,
          },
          ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { body }),
        },
      );
      const response = await h.kernel.fetch(request);
      statuses.add(response.status);
      await assertEnvelope(response, h.logs, h.sentinel, route.path.includes('/npm/'));
      seen.add(`${route.method} ${route.path}`);
    }
  }
  expect(seen.size).toBe(registeredRoutes(h.kernel, h.ecosystemRoutes).length);
  for (const path of ['/_pb/missing', '/health/missing', '/missing']) {
    await assertEnvelope(await h.kernel.fetch(new Request(`${ORIGIN}${path}`)), h.logs, h.sentinel);
  }
  return statuses;
}

describe('registered route error envelope sweep', () => {
  it.each([
    ['handler', 500],
    ['organization', 500],
    ['authorization', 503],
    ['deny-401', 401],
    ['deny-403', 403],
    ['deny-404', 404],
  ] as const)('uses the npm shape for %s regardless of Accept', async (mode, status) => {
    const h = await harness(mode);
    for (const accept of ['application/json', 'text/html', 'application/vnd.npm.install-v1+json']) {
      const response = await h.kernel.fetch(
        new Request(`${ORIGIN}/demo/npm/-/whoami`, { headers: { accept } }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (mode === 'authorization') expect(response.headers.get('retry-after')).toBe('5');
      await assertEnvelope(response, h.logs, h.sentinel, true);
    }
  });

  it('keeps the nested shape outside the npm mount despite npm headers or path parameters', async () => {
    const h = await harness('organization');
    for (const path of ['/fixture/items/npm', '/npm/p2/acme/pkg', '/demo/npm/missing/extra/path']) {
      const response = await h.kernel.fetch(
        new Request(`${ORIGIN}${path}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
        }),
      );
      expect(response.status).toBe(path.endsWith('/path') ? 404 : 500);
      await assertEnvelope(response, h.logs, h.sentinel);
    }
  });

  it.each(['handler', 'organization', 'authorization'] as const)(
    'keeps %s failures client-safe on every registered route',
    async (mode) => {
      const h = await harness(mode);
      await sweep(h);
      expect(h.db.all).toHaveBeenCalled();
      expect(h.logs).toContainEqual(expect.objectContaining({ error_name: 'Error' }));
      if (mode === 'handler') expect(h.provider.start).toHaveBeenCalled();
    },
  );

  it.each([401, 403] as const)(
    'keeps authorization denial %s client-safe across routes',
    async (status) => {
      const h = await harness(status === 401 ? 'deny-401' : 'deny-403');
      const statuses = await sweep(h);
      expect(statuses.has(status)).toBe(true);
      const response = await h.kernel.fetch(
        new Request(`${ORIGIN}/_pb/me/permissions`, {
          headers: { accept: 'application/json' },
        }),
      );
      expect(response.status).toBe(status);
      await assertEnvelope(response, h.logs, h.sentinel);
    },
  );

  it('rejects a newly registered handler that returns a caught error message', async () => {
    const h = await harness('handler', [
      {
        method: 'GET',
        path: '/leaky/items/:id',
        permission: null,
        handler: async (ctx) => {
          try {
            await ctx.ports.organizations.get(ORG);
            return new Response('unreachable');
          } catch (err) {
            return Response.json(
              {
                error: {
                  code: 'internal',
                  message: (err as Error).message,
                  requestId: ctx.requestId,
                },
              },
              { status: 500 },
            );
          }
        },
      },
    ]);
    await expect(sweep(h)).rejects.toThrow('not to contain');
  });

  it('keeps HEAD failures bodyless', async () => {
    const h = await harness('organization');
    for (const route of registeredRoutes(h.kernel, h.ecosystemRoutes)) {
      if (route.method !== 'GET') continue;
      const response = await h.kernel.fetch(
        new Request(`${ORIGIN}${samplePath(route.path)}`, { method: 'HEAD' }),
      );
      expect(await response.text()).toBe('');
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify([...response.headers])).not.toContain(h.sentinel);
    }
    expect(JSON.stringify(h.logs)).not.toContain(h.sentinel);
  });
});
