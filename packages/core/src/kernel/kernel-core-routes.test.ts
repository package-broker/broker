import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RouteDefinition,
} from '../plugin.js';
import { createKernel } from './kernel.js';
import type { KernelOptions } from './kernel.js';
import { KernelConfigError } from './registry.js';

const BASE = 'http://broker.test';

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

function options(
  coreRoutes: readonly RouteDefinition[] | undefined,
  plugins: readonly PluginDefinition[] = [],
  logs: Array<Readonly<Record<string, unknown>>> = [],
): KernelOptions {
  return {
    platform: 'node',
    plugins,
    ports,
    resolveOrg: () => Promise.resolve(orgContext('org-1')),
    health: () => Promise.resolve(true),
    log: (entry) => {
      logs.push(entry);
    },
    ...(coreRoutes === undefined ? {} : { coreRoutes }),
  };
}

const ping: RouteDefinition = {
  method: 'GET',
  path: '/_pb/ping',
  permission: null,
  handler: () => Response.json({ pong: true }),
};

async function problemsOf(coreRoutes: readonly RouteDefinition[]): Promise<readonly string[]> {
  const error: unknown = await createKernel(options(coreRoutes)).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(KernelConfigError);
  return (error as KernelConfigError).problems;
}

function route(path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return { method: 'GET', path, permission: null, handler: () => new Response('ok'), ...extra };
}

describe('createKernel coreRoutes', () => {
  it('serves a public core route with a request id', async () => {
    const kernel = await createKernel(options([ping]));

    const response = await kernel.fetch(new Request(`${BASE}/_pb/ping`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('denies a permissioned core route with the default engine', async () => {
    const kernel = await createKernel(
      options([route('/_pb/secret', { permission: 'org:read', boundary: 'organization' })]),
    );

    const response = await kernel.fetch(new Request(`${BASE}/_pb/secret`));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('hands a permissioned core route to the engine under the plugin label core', async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const kernel = await createKernel({
      ...options([route('/_pb/secret', { permission: 'org:read', boundary: 'organization' })]),
      authorization: {
        authorize: (request) => {
          seen.push(request.route);
          return Promise.resolve({
            allow: true,
            principal: { kind: 'user', id: 'u-1' },
            projectId: null,
          });
        },
      },
    });

    const response = await kernel.fetch(new Request(`${BASE}/_pb/secret`));

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        plugin: 'core',
        method: 'GET',
        path: '/_pb/secret',
        permission: 'org:read',
        boundary: 'organization',
      },
    ]);
  });

  it('serves core routes with params and a resolved organization', async () => {
    let seen: { org: string | null; params: Readonly<Record<string, string>> } | null = null;
    const kernel = await createKernel(
      options([
        route('/_pb/things/:id', {
          handler: (ctx) => {
            seen = { org: ctx.org?.orgId ?? null, params: ctx.params };
            return new Response('ok');
          },
        }),
      ]),
    );

    await kernel.fetch(new Request(`${BASE}/_pb/things/7`));

    expect(seen).toEqual({ org: 'org-1', params: { id: '7' } });
  });

  it('skips org resolution for a core route with needsOrg false', async () => {
    let resolved = 0;
    const base = options([route('/_pb/open', { needsOrg: false })]);
    const kernel = await createKernel({
      ...base,
      resolveOrg: () => {
        resolved++;
        return Promise.resolve(orgContext('org-1'));
      },
    });

    const response = await kernel.fetch(new Request(`${BASE}/_pb/open`));

    expect(response.status).toBe(200);
    expect(resolved).toBe(0);
  });

  it('exposes frozen core routes and leaves registration unchanged', async () => {
    const kernel = await createKernel(options([ping]));

    expect(kernel.coreRoutes).toEqual([ping]);
    expect(Object.isFrozen(kernel.coreRoutes)).toBe(true);
    expect(kernel.coreRoutes[0]).not.toBe(ping);
    expect(Object.isFrozen(kernel.coreRoutes[0])).toBe(true);
    expect(kernel.registration.routes).toEqual([]);
  });

  it('exposes an empty list when no core routes are given', async () => {
    const kernel = await createKernel(options(undefined));

    expect(kernel.coreRoutes).toEqual([]);
    expect(Object.isFrozen(kernel.coreRoutes)).toBe(true);
  });

  it('answers a throwing core handler with the 500 envelope and one log line', async () => {
    const logs: Array<Readonly<Record<string, unknown>>> = [];
    const kernel = await createKernel(
      options(
        [
          route('/_pb/boom', {
            handler: () => {
              throw new Error('secret');
            },
          }),
        ],
        [],
        logs,
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/_pb/boom`));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal' } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('keeps serving plugin routes next to core routes', async () => {
    const alpha: PluginDefinition = {
      id: 'alpha',
      package: '@test/alpha',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
      register: (registry) => {
        registry.route(route('/items'));
      },
    };
    const kernel = await createKernel(options([ping], [alpha]));

    expect((await kernel.fetch(new Request(`${BASE}/items`))).status).toBe(200);
    expect((await kernel.fetch(new Request(`${BASE}/_pb/ping`))).status).toBe(200);
    expect(kernel.registration.routes.map((r) => r.path)).toEqual(['/items']);
  });

  describe('precedence over plugin parameter routes', () => {
    const capture = (hits: string[]): PluginDefinition => ({
      id: 'greedy',
      package: '@test/greedy',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
      register: (registry) => {
        registry.route(
          route('/:a/:b', {
            handler: () => {
              hits.push('GET /:a/:b');
              return new Response('plugin');
            },
          }),
        );
        registry.route(
          route('/:a/:b/:c/:d', {
            method: 'POST',
            handler: () => {
              hits.push('POST /:a/:b/:c/:d');
              return new Response('plugin');
            },
          }),
        );
      },
    });

    it('reaches a core GET route, not a plugin GET /:a/:b', async () => {
      const hits: string[] = [];
      const kernel = await createKernel(
        options([route('/_pb/session', { handler: () => new Response('core') })], [capture(hits)]),
      );

      const response = await kernel.fetch(new Request(`${BASE}/_pb/session`));

      expect(await response.text()).toBe('core');
      expect(hits).toEqual([]);
    });

    it('reaches a core POST route, not a plugin POST /:a/:b/:c/:d', async () => {
      const hits: string[] = [];
      const kernel = await createKernel(
        options(
          [
            route('/_pb/auth/local/login', {
              method: 'POST',
              handler: () => new Response('core'),
            }),
          ],
          [capture(hits)],
        ),
      );

      const response = await kernel.fetch(
        new Request(`${BASE}/_pb/auth/local/login`, { method: 'POST', body: 'x' }),
      );

      expect(await response.text()).toBe('core');
      expect(hits).toEqual([]);
    });

    it.each([
      ['GET', '/_pb/unknown/x'],
      ['GET', '/_pb/unknown'],
      ['POST', '/_pb/auth/unknown/x/y'],
      ['GET', '/_pb/session'],
      ['GET', '/_pb'],
      ['GET', '/health/unknown'],
      ['POST', '/health/live'],
      ['GET', '/health'],
    ])('answers %s %s with a 404 envelope, never a plugin route', async (method, path) => {
      const hits: string[] = [];
      const kernel = await createKernel(options([], [capture(hits)]));

      const response = await kernel.fetch(new Request(`${BASE}${path}`, { method }));

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      expect(hits).toEqual([]);
    });

    it('still serves the health routes', async () => {
      const hits: string[] = [];
      const kernel = await createKernel(options([], [capture(hits)]));

      const response = await kernel.fetch(new Request(`${BASE}/health/live`));

      expect(response.status).toBe(200);
      expect(hits).toEqual([]);
    });
  });

  it('still rejects a plugin route under /_pb/', async () => {
    const rogue: PluginDefinition = {
      id: 'rogue',
      package: '@test/rogue',
      apiVersion: SUPPORTED_PLUGIN_API[0],
      platforms: ['node'],
      register: (registry) => {
        registry.route(route('/_pb/ping'));
      },
    };

    const error: unknown = await createKernel(options([ping], [rogue])).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(KernelConfigError);
    expect((error as KernelConfigError).problems.join('\n')).toContain('reserved core prefix');
  });

  describe('validation', () => {
    it.each([
      ['/ping', 'must start with "/_pb/"'],
      ['/_pb', 'must start with "/_pb/"'],
      ['/_pb/', 'must name a path below'],
      ['/_pb//x', 'empty segment'],
      ['/_pb/a/', 'trailing slash'],
      ['/_pb/a b', 'invalid segment'],
      ['/_pb/:id/:id', 'repeats parameter'],
    ])('rejects path %s', async (path, fragment) => {
      const problems = await problemsOf([route(path)]);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(JSON.stringify(path));
      expect(problems[0]).toContain(fragment);
    });

    it('rejects a method outside the allowed set', async () => {
      const bad = { ...ping, method: 'TRACE' } as unknown as RouteDefinition;

      const problems = await problemsOf([bad]);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('method must be one of');
    });

    it('rejects needsOrg false on a permissioned route', async () => {
      const problems = await problemsOf([
        route('/_pb/x', { needsOrg: false, permission: 'org:read', boundary: 'organization' }),
      ]);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('must be public');
    });

    it('rejects two conflicting core routes', async () => {
      const problems = await problemsOf([route('/_pb/a/:id'), route('/_pb/a/new')]);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('conflicts with');
    });

    it('allows the same path with different methods', async () => {
      const kernel = await createKernel(
        options([route('/_pb/a'), route('/_pb/a', { method: 'POST' })]),
      );

      expect(kernel.coreRoutes).toHaveLength(2);
    });

    it('lists every problem in one error, each input path once', async () => {
      const paths = ['/ping', '/_pb', '/_pb/', '/_pb//x', '/_pb/a/'];
      const problems = await problemsOf([
        ...paths.map((path) => route(path)),
        route('/_pb/c/:id'),
        route('/_pb/c/new'),
      ]);

      expect(problems).toHaveLength(6);
      for (const path of paths) {
        expect(
          problems.filter((problem) => problem.includes(`core route GET ${path}:`)),
        ).toHaveLength(1);
      }
      expect(problems.filter((problem) => problem.includes('conflicts with'))).toHaveLength(1);
    });

    it('checks conflicts for a route that also lacks a public permission', async () => {
      const problems = await problemsOf([
        route('/_pb/x'),
        route('/_pb/x', { needsOrg: false, permission: 'org:read', boundary: 'organization' }),
      ]);

      expect(problems).toHaveLength(2);
      expect(problems.some((problem) => problem.includes('must be public'))).toBe(true);
      expect(problems.some((problem) => problem.includes('conflicts with'))).toBe(true);
    });

    it('reports a non-string path as a problem', async () => {
      const bad = { ...ping, path: 42 } as unknown as RouteDefinition;

      const problems = await problemsOf([bad]);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('path must be a string');
    });

    it('merges plugin and core problems into one error', async () => {
      const rogue: PluginDefinition = {
        id: 'rogue',
        package: '@test/rogue',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        register: (registry) => {
          registry.route(route('/bad//path'));
        },
      };

      const error: unknown = await createKernel(options([route('/ping')], [rogue])).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(KernelConfigError);
      const problems = (error as KernelConfigError).problems;
      expect(problems).toHaveLength(2);
      expect(problems.some((problem) => problem.includes('plugin "rogue"'))).toBe(true);
      expect(problems.some((problem) => problem.includes('core route GET /ping'))).toBe(true);
    });

    it('fails before any plugin init runs', async () => {
      let inits = 0;
      const alpha: PluginDefinition = {
        id: 'alpha',
        package: '@test/alpha',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        init: () => {
          inits++;
        },
      };

      await expect(createKernel(options([route('/ping')], [alpha]))).rejects.toBeInstanceOf(
        KernelConfigError,
      );
      expect(inits).toBe(0);
    });
  });
});
