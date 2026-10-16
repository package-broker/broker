import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RequestContext,
  type RouteDefinition,
} from '../plugin.js';
import type { AuthorizationDecision, AuthorizationEngine } from './authorize.js';
import { createKernel } from './kernel.js';
import type { KernelOptions } from './kernel.js';
import { NotBootstrappedError } from './org.js';
import { collectRegistrations, KernelConfigError } from './registry.js';

const ORG = orgContext('org-1');
const BASE = 'http://broker.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

interface Harness {
  readonly options: KernelOptions;
  readonly calls: { resolveOrg: number; health: number };
  readonly logs: Array<Readonly<Record<string, unknown>>>;
  setHealthy(value: boolean): void;
}

function harness(
  plugins: readonly PluginDefinition[],
  overrides: Partial<KernelOptions> & { resolveOrg?: () => Promise<OrgContext> } = {},
): Harness {
  const calls = { resolveOrg: 0, health: 0 };
  const logs: Array<Readonly<Record<string, unknown>>> = [];
  let healthy = true;
  const resolve = overrides.resolveOrg ?? (() => Promise.resolve(ORG));
  const options: KernelOptions = {
    platform: 'node',
    plugins,
    ports,
    log: (entry) => {
      logs.push(entry);
    },
    ...overrides,
    resolveOrg: () => {
      calls.resolveOrg++;
      return resolve();
    },
    health: () => {
      calls.health++;
      return Promise.resolve(healthy);
    },
  };
  return {
    options,
    calls,
    logs,
    setHealthy: (value) => {
      healthy = value;
    },
  };
}

function plugin(
  id: string,
  routes: readonly RouteDefinition[],
  extra: Partial<PluginDefinition> = {},
): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    register(registry) {
      for (const route of routes) registry.route(route);
    },
    ...extra,
  };
}

function echo(ctx: RequestContext): Response {
  return Response.json({
    org: ctx.org?.orgId ?? null,
    principal: ctx.principal,
    projectId: ctx.projectId,
    params: ctx.params,
    requestId: ctx.requestId,
  });
}

const publicItem: RouteDefinition = {
  method: 'GET',
  path: '/items/:id',
  permission: null,
  handler: echo,
};
const protectedItem: RouteDefinition = {
  method: 'GET',
  path: '/secure/:id',
  permission: 'org:read',
  boundary: 'organization',
  handler: echo,
};

function engineReturning(decision: AuthorizationDecision): AuthorizationEngine {
  return { authorize: () => Promise.resolve(decision) };
}

const allowUser = engineReturning({
  allow: true,
  principal: { kind: 'user', id: 'u-1' },
  projectId: 'p-1',
});

async function envelope(
  response: Response,
): Promise<{ code: string; message: string; requestId: string }> {
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  return body.error;
}

describe('createKernel', () => {
  it('uses a prebuilt registration as-is without calling register again', async () => {
    let calls = 0;
    const registered = plugin('alpha', [], {
      register(registry) {
        calls++;
        registry.route(publicItem);
        registry.hook('access.check', () => undefined);
      },
    });
    const registration = collectRegistrations([registered]);
    const h = harness([registered]);
    const kernel = await createKernel({ ...h.options, registration });

    expect(calls).toBe(1);
    expect(kernel.registration).toBe(registration);
    expect((await kernel.fetch(new Request(`${BASE}/items/1`))).status).toBe(200);
  });

  it('validates core routes when given a prebuilt registration', async () => {
    const h = harness([]);
    await expect(
      createKernel({
        ...h.options,
        registration: collectRegistrations([]),
        coreRoutes: [publicItem],
      }),
    ).rejects.toMatchObject({
      name: 'KernelConfigError',
      problems: [expect.stringContaining('must start with "/_pb/"')],
    });
  });

  it('merges a throwing register failure with core-route problems', async () => {
    let calls = 0;
    const h = harness([
      plugin('alpha', [], {
        register() {
          calls += 1;
          throw new TypeError();
        },
      }),
    ]);
    const failure: unknown = await createKernel({ ...h.options, coreRoutes: [publicItem] }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KernelConfigError);
    const problems = (failure as KernelConfigError).problems;
    expect(problems).toContain('plugin "alpha" register threw TypeError');
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('must start with "/_pb/"')]),
    );
    expect(problems).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it('does not collect registrations when a prebuilt registration is passed', async () => {
    let calls = 0;
    const h = harness([
      plugin('alpha', [], {
        register() {
          calls += 1;
          throw new TypeError();
        },
      }),
    ]);
    const kernel = await createKernel({ ...h.options, registration: collectRegistrations([]) });

    expect(calls).toBe(0);
    expect((await kernel.fetch(new Request(`${BASE}/health/live`))).status).toBe(200);
  });

  it('answers an unknown route with a 404 envelope without touching the resolver or the database', async () => {
    const h = harness([plugin('alpha', [publicItem])]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/nope`));

    expect(response.status).toBe(404);
    const error = await envelope(response);
    expect(error).toMatchObject({ code: 'not_found', message: 'Route not found' });
    expect(response.headers.get('x-request-id')).toBe(error.requestId);
    expect(error.requestId).toMatch(UUID);
    expect(h.calls).toEqual({ resolveOrg: 0, health: 0 });
  });

  it('serves live and checks the database on every readiness probe', async () => {
    const h = harness([]);
    const kernel = await createKernel(h.options);

    const live = await kernel.fetch(new Request(`${BASE}/health/live`));
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(h.calls.health).toBe(0);

    const ready = await kernel.fetch(new Request(`${BASE}/health/ready`));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });

    h.setHealthy(false);
    const notReady = await kernel.fetch(new Request(`${BASE}/health/ready`));
    expect(notReady.status).toBe(503);
    expect((await envelope(notReady)).code).toBe('not_ready');
    expect(h.calls.health).toBe(2);
  });

  it('logs a failing readiness probe exactly once', async () => {
    const h = harness([]);
    const kernel = await createKernel(h.options);
    h.setHealthy(false);

    const response = await kernel.fetch(new Request(`${BASE}/health/ready`));

    expect(response.status).toBe(503);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'error',
      request_id: response.headers.get('x-request-id'),
      error_name: 'ProbeFailedError',
    });
  });

  it('passes org and params to a public route', async () => {
    const h = harness([plugin('alpha', [publicItem])]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/items/42`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      org: 'org-1',
      principal: null,
      projectId: null,
      params: { id: '42' },
    });
    expect(response.headers.get('x-request-id')).toBe(body['requestId']);
    expect(h.calls.resolveOrg).toBe(1);
  });

  it('skips org resolution for a route with needsOrg false', async () => {
    const h = harness([
      plugin('alpha', [
        { method: 'GET', path: '/open', permission: null, needsOrg: false, handler: echo },
      ]),
    ]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/open`));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ org: null, principal: null });
    expect(h.calls.resolveOrg).toBe(0);
  });

  it('answers 503 not_bootstrapped when the organization does not exist yet', async () => {
    const h = harness([plugin('alpha', [publicItem])], {
      resolveOrg: () => Promise.reject(new NotBootstrappedError()),
    });
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/items/42`));

    expect(response.status).toBe(503);
    expect((await envelope(response)).code).toBe('not_bootstrapped');
  });

  describe('protected routes', () => {
    it('deny with 403 under the default engine', async () => {
      const h = harness([plugin('alpha', [protectedItem])]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

      expect(response.status).toBe(403);
      expect(await envelope(response)).toMatchObject({ code: 'forbidden', message: 'Forbidden' });
    });

    it('hand the principal and project to the handler when the engine allows and no hook denies', async () => {
      const h = harness([plugin('alpha', [protectedItem])], { authorization: allowUser });
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/7`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        org: 'org-1',
        principal: { kind: 'user', id: 'u-1' },
        projectId: 'p-1',
        params: { id: '7' },
      });
    });

    it('deny with 403 when a hook denies, logging the reason and keeping it from the client', async () => {
      const h = harness(
        [
          plugin('alpha', [protectedItem]),
          plugin('guard', [], {
            register(registry) {
              registry.hook('access.check', () => ({ deny: true, reason: 'quota-exceeded' }));
            },
          }),
        ],
        { authorization: allowUser },
      );
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/7`));

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('quota-exceeded');
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'forbidden' } });
      expect(h.logs).toEqual([
        expect.objectContaining({
          level: 'warn',
          plugin: 'guard',
          code: 'denied',
          requestId: response.headers.get('x-request-id'),
        }),
      ]);
    });

    it('never logs the hook reason or a thrown message', async () => {
      const SENTINEL = 'sentinel-secret-9f3a';
      for (const handler of [
        () => ({ deny: true as const, reason: SENTINEL }),
        () => {
          throw new RangeError(SENTINEL);
        },
      ]) {
        const h = harness(
          [
            plugin('alpha', [protectedItem]),
            plugin('guard', [], {
              register(registry) {
                registry.hook('access.check', handler);
              },
            }),
          ],
          { authorization: allowUser },
        );
        const kernel = await createKernel(h.options);

        const response = await kernel.fetch(
          new Request(`${BASE}/secure/7`, { headers: { accept: 'text/html' } }),
        );

        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(SENTINEL);
        expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
      }
    });

    it('answers a browser 403 with the static page and a JSON client with the envelope', async () => {
      const h = harness([plugin('alpha', [protectedItem])]);
      const kernel = await createKernel(h.options);

      const page = await kernel.fetch(
        new Request(`${BASE}/secure/1`, { headers: { accept: 'text/html,*/*;q=0.8' } }),
      );
      const api = await kernel.fetch(
        new Request(`${BASE}/secure/1`, { headers: { accept: 'application/json' } }),
      );

      expect(page.status).toBe(403);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(page.headers.get('vary')).toBe('Accept');
      expect(await page.text()).toContain('You do not have access.');
      expect(api.status).toBe(403);
      expect((await envelope(api)).code).toBe('forbidden');
    });

    it('answers a 404 decision exactly like an unknown route', async () => {
      const notFoundEngine = engineReturning({ allow: false, status: 404 });
      const h = harness([plugin('alpha', [protectedItem])], { authorization: notFoundEngine });
      const kernel = await createKernel(h.options);
      const snapshot = async (path: string): Promise<unknown> => {
        const response = await kernel.fetch(
          new Request(`${BASE}${path}`, { headers: { accept: 'text/html' } }),
        );
        const headers = Object.fromEntries(
          [...response.headers].filter(([name]) => name !== 'x-request-id'),
        );
        const text = await response.text();
        const id = response.headers.get('x-request-id') ?? '';
        return { status: response.status, headers, body: text.replaceAll(id, '<id>') };
      };

      const unknownRoute = await snapshot('/nowhere/1');
      const decision404 = await snapshot('/secure/1');

      expect(decision404).toEqual(unknownRoute);
      expect(decision404).toMatchObject({ status: 404 });
    });

    it('does not let a hook turn a 404 decision into anything else', async () => {
      const h = harness(
        [
          plugin('alpha', [protectedItem]),
          plugin('guard', [], {
            register(registry) {
              registry.hook('access.check', () => ({ deny: true, reason: 'x' }));
            },
          }),
        ],
        { authorization: engineReturning({ allow: false, status: 404 }) },
      );
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

      expect(response.status).toBe(404);
      expect((await envelope(response)).code).toBe('not_found');
    });

    it('reports a malformed engine decision to the log by plugin and error name', async () => {
      const h = harness([plugin('alpha', [protectedItem])], {
        authorization: {
          authorize: () => Promise.resolve({ allow: false, status: 404, x: 1 } as never),
        },
      });
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

      expect(response.status).toBe(403);
      expect(h.logs).toEqual([
        expect.objectContaining({
          level: 'warn',
          plugin: 'core:authorization',
          error: 'TypeError',
        }),
      ]);
    });

    it('log a throwing hook by plugin and error name only', async () => {
      const h = harness(
        [
          plugin('alpha', [protectedItem]),
          plugin('broken', [], {
            register(registry) {
              registry.hook('access.check', () => {
                throw new RangeError('secret detail');
              });
            },
          }),
        ],
        { authorization: allowUser },
      );
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/7`));

      expect(response.status).toBe(403);
      expect(JSON.stringify(h.logs)).not.toContain('secret detail');
      expect(h.logs).toContainEqual(
        expect.objectContaining({ level: 'warn', plugin: 'broken', error: 'RangeError' }),
      );
    });

    it('answer 401 when the engine says unauthenticated', async () => {
      const h = harness([plugin('alpha', [protectedItem])], {
        authorization: engineReturning({ allow: false, status: 401 }),
      });
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

      expect(response.status).toBe(401);
      expect(await envelope(response)).toMatchObject({
        code: 'unauthorized',
        message: 'Unauthorized',
      });
    });
  });

  describe('HEAD', () => {
    it('is authorized like GET on a protected route and has an empty body', async () => {
      const h = harness([plugin('alpha', [protectedItem])]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`, { method: 'HEAD' }));

      expect(response.status).toBe(403);
      expect(await response.text()).toBe('');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
    });

    it('is served by a public GET route with an empty body', async () => {
      const h = harness([plugin('alpha', [publicItem])]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/items/1`, { method: 'HEAD' }));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    });

    it('suppresses the error body when a public GET handler throws a string', async () => {
      const h = harness([
        plugin('alpha', [
          {
            method: 'GET',
            path: '/boom',
            permission: null,
            handler: () => Promise.reject('secret'),
          },
        ]),
      ]);
      const kernel = await createKernel(h.options);

      const get = await kernel.fetch(new Request(`${BASE}/boom`));
      expect(get.status).toBe(500);
      const text = await get.text();
      expect(text).not.toContain('secret');
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal' } });

      const head = await kernel.fetch(new Request(`${BASE}/boom`, { method: 'HEAD' }));
      expect(head.status).toBe(get.status);
      expect(await head.text()).toBe('');
      expect(head.headers.get('x-request-id')).toMatch(UUID);
    });
  });

  describe('handler responses the kernel cannot reissue', () => {
    const readBody = async (): Promise<Response> => {
      const response = new Response('payload');
      await response.text();
      return response;
    };
    const errorResponse = () => Response.error();

    it('turns a GET response with an already-read body into a logged 500 envelope', async () => {
      const h = harness([
        plugin('alpha', [{ method: 'GET', path: '/read', permission: null, handler: readBody }]),
      ]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/read`));

      expect(response.status).toBe(500);
      expect((await envelope(response)).code).toBe('internal');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      expect(h.logs).toHaveLength(1);
    });

    it('answers a HEAD request with an empty body when the handler body was already read', async () => {
      const h = harness([
        plugin('alpha', [{ method: 'GET', path: '/read', permission: null, handler: readBody }]),
      ]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/read`, { method: 'HEAD' }));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      expect(h.logs).toHaveLength(0);
    });

    it('turns a GET Response.error() into a logged 500 envelope', async () => {
      const h = harness([
        plugin('alpha', [
          { method: 'GET', path: '/error', permission: null, handler: errorResponse },
        ]),
      ]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/error`));

      expect(response.status).toBe(500);
      expect((await envelope(response)).code).toBe('internal');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      expect(h.logs).toHaveLength(1);
    });

    it('turns a HEAD Response.error() into a logged 500 envelope', async () => {
      const h = harness([
        plugin('alpha', [
          { method: 'GET', path: '/error', permission: null, handler: errorResponse },
        ]),
      ]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(new Request(`${BASE}/error`, { method: 'HEAD' }));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
      expect(h.logs).toHaveLength(1);
    });
  });

  it('logs a 5xx response returned by a handler exactly once', async () => {
    const h = harness([
      plugin('alpha', [
        {
          method: 'GET',
          path: '/down',
          permission: null,
          handler: () => new Response('nope', { status: 503 }),
        },
      ]),
    ]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/down`));

    expect(response.status).toBe(503);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'error',
      requestId: response.headers.get('x-request-id'),
      status: 503,
    });
    expect(JSON.stringify(h.logs)).not.toContain('nope');
  });

  it('turns a handler error into a 500 envelope without internals and one log entry', async () => {
    const h = harness([
      plugin('alpha', [
        {
          method: 'POST',
          path: '/boom',
          permission: null,
          handler: () => {
            throw new Error('secret');
          },
        },
      ]),
    ]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/boom`, { method: 'POST' }));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal' } });
    expect(h.logs).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  it('turns a handler that returns no Response into a 500 envelope', async () => {
    const h = harness([
      plugin('alpha', [
        {
          method: 'GET',
          path: '/nothing',
          permission: null,
          handler: () => undefined as unknown as Response,
        },
      ]),
    ]);
    const kernel = await createKernel(h.options);

    const response = await kernel.fetch(new Request(`${BASE}/nothing`));

    expect(response.status).toBe(500);
    expect((await envelope(response)).code).toBe('internal');
  });

  describe('request ids', () => {
    it('adds distinct ids to reused handler responses, covering headers and ids only', async () => {
      const cached = new Response('cached', {
        status: 202,
        statusText: 'Accepted',
        headers: { 'x-handler': 'cached' },
      });
      const originalHeaders = [...cached.headers];
      const h = harness([plugin('alpha', [{ ...publicItem, handler: () => cached }])]);
      const kernel = await createKernel(h.options);

      const first = await kernel.fetch(new Request(`${BASE}/items/1`));
      const second = await kernel.fetch(new Request(`${BASE}/items/2`));

      expect(first.headers.get('x-request-id')).toMatch(UUID);
      expect(second.headers.get('x-request-id')).toMatch(UUID);
      expect(second.headers.get('x-request-id')).not.toBe(first.headers.get('x-request-id'));
      expect([...cached.headers]).toEqual(originalHeaders);
      for (const response of [first, second]) {
        expect(response.status).toBe(202);
        expect(response.statusText).toBe('Accepted');
        expect(response.headers.get('x-handler')).toBe('cached');
      }
      expect(await first.text()).toBe('cached');
      await expect(second.text()).rejects.toThrow();
    });

    it('generate a fresh id for every request even when the client supplies one', async () => {
      const h = harness([plugin('alpha', [publicItem])]);
      const kernel = await createKernel(h.options);

      const response = await kernel.fetch(
        new Request(`${BASE}/items/1`, { headers: { 'x-request-id': 'trace-ABC-123' } }),
      );

      const requestId = response.headers.get('x-request-id');
      expect(requestId).toMatch(UUID);
      expect(requestId).not.toBe('trace-ABC-123');
      expect(await response.json()).toMatchObject({ requestId });

      const next = await kernel.fetch(
        new Request(`${BASE}/items/1`, { headers: { 'x-request-id': 'trace-ABC-123' } }),
      );
      expect(next.headers.get('x-request-id')).toMatch(UUID);
      expect(next.headers.get('x-request-id')).not.toBe(requestId);
    });

    it.each([['has space'], ['<script>'], ['a'.repeat(65)], ['ok_underscore']])(
      'regenerate a malformed client id %s',
      async (incoming) => {
        const h = harness([]);
        const kernel = await createKernel(h.options);

        const response = await kernel.fetch(
          new Request(`${BASE}/nope`, { headers: { 'x-request-id': incoming } }),
        );

        const error = await envelope(response);
        expect(error.requestId).toMatch(UUID);
        expect(response.headers.get('x-request-id')).toBe(error.requestId);
      },
    );

    it('overwrite an x-request-id the handler set with this request id', async () => {
      const h = harness([
        plugin('alpha', [
          {
            method: 'GET',
            path: '/own',
            permission: null,
            handler: () => new Response('ok', { headers: { 'x-request-id': 'handler-fixed' } }),
          },
          {
            method: 'GET',
            path: '/redirect',
            permission: null,
            handler: () => Response.redirect(`${BASE}/elsewhere`, 302),
          },
        ]),
      ]);
      const kernel = await createKernel(h.options);

      const own = await kernel.fetch(new Request(`${BASE}/own`));
      expect(own.headers.get('x-request-id')).toMatch(UUID);
      expect(own.headers.get('x-request-id')).not.toBe('handler-fixed');
      expect(await own.text()).toBe('ok');

      const redirect = await kernel.fetch(new Request(`${BASE}/redirect`));
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe(`${BASE}/elsewhere`);
      expect(redirect.headers.get('x-request-id')).toMatch(UUID);
    });
  });

  describe('plugin init', () => {
    it('runs every init in order before createKernel resolves', async () => {
      const events: string[] = [];
      const slow = (id: string, ms: number) => async (received: PluginPorts) => {
        expect(received).toBe(ports);
        events.push(`${id}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`${id}:end`);
      };
      const h = harness([
        plugin('first', [], { init: slow('first', 20) }),
        plugin('second', [], { init: slow('second', 1) }),
      ]);

      const kernel = await createKernel(h.options);

      expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
      expect(kernel.registration.routes).toEqual([]);
    });

    it('rejects when an init rejects', async () => {
      const h = harness([
        plugin('first', [], { init: () => Promise.reject(new Error('init failed')) }),
      ]);

      await expect(createKernel(h.options)).rejects.toThrow('init failed');
    });
  });
});
