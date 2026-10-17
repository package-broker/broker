import { describe, expect, expectTypeOf, it } from 'vitest';
import { fixedClock } from '../ids.js';
import { createKernel } from './kernel.js';
import { routeApiProblems } from './routes.js';
import { SUPPORTED_PLUGIN_API, type PluginDefinition, type RouteDefinition } from '../plugin.js';
import type { JobDefinition } from '../platform/jobs.js';
import {
  KernelConfigError,
  collectRegistrations,
  registerCoreJob,
  type RegistrationOptions,
  type RegisteredCoreJob,
  type RegisteredJob,
} from './registry.js';

const handler = () => new Response('ok');

function plugin(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    ...overrides,
  };
}

function withRoutes(
  id: string,
  routes: RouteDefinition[],
  overrides: Partial<PluginDefinition> = {},
) {
  return plugin(id, {
    register(registry) {
      for (const route of routes) registry.route(route);
    },
    ...overrides,
  });
}

function problemsOf(plugins: readonly PluginDefinition[]): readonly string[] {
  try {
    collectRegistrations(plugins);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  throw new Error('expected KernelConfigError');
}

describe('collectRegistrations', () => {
  it('returns routes with plugin ids, hooks in order and the bindings map', () => {
    const first = () => undefined;
    const second = () => undefined;
    const a = withRoutes(
      'alpha',
      [{ method: 'GET', path: '/a', permission: 'org:read', boundary: 'organization', handler }],
      {
        binds: ['source'],
        sourceProviders: () => [],
        register(registry) {
          registry.route({
            method: 'GET',
            path: '/a',
            permission: 'org:read',
            boundary: 'organization',
            handler,
          });
          registry.hook('access.check', first);
        },
      },
    );
    const b = plugin('beta', {
      binds: ['identity'],
      identityProviders: () => [],
      register(registry) {
        registry.route({ method: 'POST', path: '/b', permission: null, handler });
        registry.hook('access.check', second);
      },
    });

    const result = collectRegistrations([a, b]);

    expect(result.routes.map((r) => [r.plugin, r.method, r.path])).toEqual([
      ['alpha', 'GET', '/a'],
      ['beta', 'POST', '/b'],
    ]);
    expect(result.hooks['access.check']).toEqual([
      { plugin: 'alpha', handler: first },
      { plugin: 'beta', handler: second },
    ]);
    expect([...result.bindings]).toEqual([
      ['source', 'alpha'],
      ['identity', 'beta'],
    ]);
  });

  it('registers plugins and hooks in the array order it is given', () => {
    const calls: string[] = [];
    const aHook = () => undefined;
    const bHook = () => undefined;
    const a = plugin('a', {
      register(registry) {
        calls.push('a');
        registry.hook('access.check', aHook);
      },
    });
    const b = plugin('b', {
      dependsOn: ['a'],
      register(registry) {
        calls.push('b');
        registry.hook('access.check', bHook);
      },
    });
    const manifest = { plugins: [b, a] };

    const registration = collectRegistrations(manifest.plugins);

    expect(calls).toEqual(['b', 'a']);
    expect(registration.hooks['access.check']).toEqual([
      { plugin: 'b', handler: bHook },
      { plugin: 'a', handler: aHook },
    ]);
  });

  it('accepts plugins without register or binds', () => {
    const result = collectRegistrations([plugin('quiet')]);
    expect(result.routes).toEqual([]);
    expect(result.hooks['access.check']).toEqual([]);
    expect(result.bindings.size).toBe(0);
  });

  it('rejects an unsupported apiVersion', () => {
    const [min, max] = SUPPORTED_PLUGIN_API;
    const problems = problemsOf([plugin('old', { apiVersion: min - 1 })]);
    expect(problems).toEqual([
      `plugin "old" has apiVersion ${min - 1}, core supports ${min} to ${max}`,
    ]);
  });

  it('rejects plugin id core', () => {
    expect(problemsOf([plugin('core')])).toEqual(['plugin id "core" is reserved']);
  });

  it('rejects an unknown definition key supplied through a cast', () => {
    const definition = { ...plugin('sneaky'), onRequest() {} } as never;
    expect(problemsOf([definition])).toEqual(['plugin "sneaky" has unknown key "onRequest"']);
  });

  it('accepts every documented definition key', () => {
    const full = plugin('full', {
      dependsOn: [],
      capabilities: ['x'],
      binds: [],
      migrations: { dir: 'm' },
      register() {},
      init() {},
    });
    expect(() => collectRegistrations([full])).not.toThrow();
  });

  it.each(['source', 'identity'] as const)('accepts binds: [%s]', (port) => {
    const definition = plugin('p', {
      binds: [port],
      ...(port === 'identity' ? { identityProviders: () => [] } : { sourceProviders: () => [] }),
    });
    expect(collectRegistrations([definition]).bindings.get(port)).toBe('p');
  });

  it('rejects binds: [database]', () => {
    const definition = plugin('p', { binds: ['database'] as never });
    expect(problemsOf([definition])).toEqual([
      'plugin "p" cannot bind port "database": provided by the runtime',
    ]);
  });

  it('rejects a port bound twice', () => {
    const problems = problemsOf([
      plugin('a', { binds: ['source'], sourceProviders: () => [] }),
      plugin('b', { binds: ['source'], sourceProviders: () => [] }),
    ]);
    expect(problems).toEqual(['port "source" is bound by plugins "a" and "b"']);
  });

  it('reports a register that throws', () => {
    const boom = plugin('boom', {
      register() {
        throw new Error('nope');
      },
    });
    expect(problemsOf([boom])).toEqual(['plugin "boom" register threw Error']);
  });

  it('reports a register that throws a non-Error value', () => {
    const boom = plugin('boom', {
      register() {
        throw 'text';
      },
    });
    expect(problemsOf([boom])).toEqual(['plugin "boom" register threw Error']);
  });

  it('reports a route path problem', () => {
    const bad = withRoutes('p', [{ method: 'GET', path: 'items', permission: null, handler }]);
    expect(problemsOf([bad])).toEqual(['plugin "p": route path "items" must start with "/"']);
  });

  it('rejects a route method outside the supported set', () => {
    const bad = withRoutes('p', [
      { method: 'HEAD' as never, path: '/x', permission: null, handler },
    ]);
    expect(problemsOf([bad])).toEqual([
      'plugin "p" route HEAD /x: method must be one of GET, POST, PUT, PATCH, DELETE',
    ]);
  });

  it('rejects needsOrg: false with a permission', () => {
    const bad = withRoutes('p', [
      {
        method: 'GET',
        path: '/x',
        permission: 'org:read',
        boundary: 'organization',
        needsOrg: false,
        handler,
      },
    ]);
    expect(problemsOf([bad])).toEqual([
      'plugin "p" route GET /x: a route without organization context must be public',
    ]);
  });

  it('accepts needsOrg: false on a public route', () => {
    const ok = withRoutes('p', [
      { method: 'GET', path: '/x', permission: null, needsOrg: false, handler },
    ]);
    expect(collectRegistrations([ok]).routes).toHaveLength(1);
  });

  it('reports conflicting routes across plugins', () => {
    const a = withRoutes('a', [{ method: 'GET', path: '/items/:id', permission: null, handler }]);
    const b = withRoutes('b', [{ method: 'GET', path: '/items/new', permission: null, handler }]);
    expect(problemsOf([a, b])).toEqual([
      'route GET /items/:id of plugin "a" conflicts with GET /items/new of plugin "b"',
    ]);
  });

  it('does not conflict across methods', () => {
    const a = withRoutes('a', [{ method: 'GET', path: '/items', permission: null, handler }]);
    const b = withRoutes('b', [{ method: 'POST', path: '/items', permission: null, handler }]);
    expect(collectRegistrations([a, b]).routes).toHaveLength(2);
  });

  it('reports the path problem and the organization problem of one route', () => {
    const bad = withRoutes('p', [
      {
        method: 'GET',
        path: 'x',
        permission: 'org:read',
        boundary: 'organization',
        needsOrg: false,
        handler,
      },
    ]);
    expect(problemsOf([bad])).toEqual([
      'plugin "p": route path "x" must start with "/"',
      'plugin "p" route GET x: a route without organization context must be public',
    ]);
  });

  it('keeps route problems collected before register throws', () => {
    const bad = plugin('p', {
      register(registry) {
        registry.route({ method: 'GET', path: 'x', permission: null, handler });
        throw new Error('late');
      },
    });
    expect(problemsOf([bad])).toEqual([
      'plugin "p" register threw Error',
      'plugin "p": route path "x" must start with "/"',
    ]);
  });

  it('rejects a non-enumerable and a symbol unknown key', () => {
    const hidden = plugin('hidden');
    Object.defineProperty(hidden, 'onRequest', { value() {}, enumerable: false });
    const tag = Symbol('tag');
    const marked = Object.assign(plugin('marked'), { [tag]: 1 });
    expect(problemsOf([hidden, marked])).toEqual([
      'plugin "hidden" has unknown key "onRequest"',
      'plugin "marked" has unknown key "Symbol(tag)"',
    ]);
  });

  it('refuses an API 2 plugin and registers the same plugin at API 3', () => {
    let thrown: unknown;
    try {
      collectRegistrations([plugin('legacy', { apiVersion: 2 })]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KernelConfigError);
    expect((thrown as KernelConfigError).problems).toEqual([
      'plugin "legacy" has apiVersion 2, core supports 3 to 4',
    ]);
    expect(() => collectRegistrations([plugin('legacy', { apiVersion: 3 })])).not.toThrow();
  });

  it.each([2.5, Number.NaN])('rejects non-integer apiVersion %s', (apiVersion) => {
    expect(problemsOf([plugin('alpha', { apiVersion })])).toEqual([
      'plugin "alpha" apiVersion must be an integer',
    ]);
  });

  it('refuses the reserved schedule plugin id without jobs', () => {
    expect(problemsOf([plugin('schedule')])).toEqual(['plugin id "schedule" is reserved']);
  });

  it('collects three problems from one set', () => {
    const a = plugin('a', { apiVersion: 99, binds: ['source'], sourceProviders: () => [] });
    const b = withRoutes(
      'b',
      [
        {
          method: 'GET',
          path: '/x',
          permission: 'org:read',
          boundary: 'organization',
          needsOrg: false,
          handler,
        },
      ],
      {
        binds: ['source'],
        sourceProviders: () => [],
      },
    );
    const error = (() => {
      try {
        collectRegistrations([a, b]);
      } catch (e) {
        return e as KernelConfigError;
      }
      throw new Error('expected KernelConfigError');
    })();
    expect(error.problems).toHaveLength(3);
    expect(error.message).toBe(error.problems.join('\n'));
    expect(error.problems[0]).toContain('plugin "a" has apiVersion 99');
    expect(error.problems[1]).toBe('port "source" is bound by plugins "a" and "b"');
    expect(error.problems[2]).toContain('plugin "b" route GET /x');
  });
  describe('jobs', () => {
    const job = (overrides: Partial<JobDefinition> = {}): JobDefinition => ({
      name: 'sync',
      version: 1,
      validate: (input) => input,
      handler: async () => undefined,
      ...overrides,
    });
    const withJobs = (id: string, ...definitions: JobDefinition[]) =>
      plugin(id, {
        register(registry) {
          for (const definition of definitions) registry.job(definition);
        },
      });

    it('records a valid job with the plugin and the qualified name', () => {
      const definition = job({ schedule: { everySeconds: 300 } });
      const { jobs } = collectRegistrations([withJobs('alpha', definition)]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.plugin).toBe('alpha');
      expect(jobs[0]!.qualifiedName).toBe('alpha:sync:v1');
      expect(jobs[0]!.definition.name).toBe('sync');
      expect(jobs[0]!.definition.schedule).toEqual({ everySeconds: 300 });
      expect(Object.isFrozen(jobs[0]!.definition)).toBe(true);
    });

    it('returns no jobs when none are registered', () => {
      expect(collectRegistrations([plugin('alpha')]).jobs).toEqual([]);
    });

    it('rejects duplicate qualified names within a plugin and separates plugin namespaces', () => {
      expect(problemsOf([withJobs('alpha', job(), job())])).toEqual([
        'job "alpha:sync:v1" is registered more than once',
      ]);
      expect(() =>
        collectRegistrations([withJobs('alpha', job()), withJobs('alpha2', job())]),
      ).not.toThrow();
    });

    it('rejects a non-function handler and validate', () => {
      const badHandler = job({ handler: 'nope' as never });
      const badValidate = job({ name: 'other', validate: 1 as never });
      const problems = problemsOf([withJobs('alpha', badHandler, badValidate)]);
      expect(problems).toHaveLength(2);
      expect(problems).toEqual([
        'plugin "alpha" job is invalid: invalid_definition',
        'plugin "alpha" job is invalid: invalid_definition',
      ]);
    });

    it('rejects an invalid interval', () => {
      for (const everySeconds of [30, 61, 0, -60, Number.NaN, '60' as never]) {
        const problems = problemsOf([withJobs('alpha', job({ schedule: { everySeconds } }))]);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('invalid_schedule');
      }
    });

    it('rejects an invalid name', () => {
      const problems = problemsOf([withJobs('alpha', job({ name: 'Bad:Name' }))]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('invalid_name');
    });

    it('rejects an async register that registers a job', () => {
      const asyncPlugin = plugin('alpha', {
        register: (async (registry: { job(d: JobDefinition): void }) => {
          registry.job(job());
        }) as never,
      });
      expect(problemsOf([asyncPlugin])).toContain('plugin "alpha" register must be synchronous');
    });

    it('rejects a job registered after register returned', () => {
      let captured: { job(d: JobDefinition): void } | undefined;
      const late = plugin('alpha', {
        register(registry) {
          captured = registry;
        },
      });
      collectRegistrations([late]);
      expect(() => captured!.job(job())).toThrow('registry is sealed');
    });

    it('still rejects a plugin that binds a runtime-owned port', () => {
      for (const port of ['blob', 'cache', 'job', 'observability'] as const) {
        const problems = problemsOf([
          plugin('alpha', { binds: [port] as never, register: (r) => r.job(job()) }),
        ]);
        expect(problems).toContain(
          `plugin "alpha" cannot bind port "${port}": provided by the runtime`,
        );
      }
    });

    it('registers a core job outside the plugin-qualified path', () => {
      const core = registerCoreJob(job({ name: 'session-cleanup' }));
      expect(core.plugin).toBe('core');
      expect(core.qualifiedName).toBe('core:session-cleanup:v1');
      expect(Object.isFrozen(core.definition)).toBe(true);
      const { jobs } = collectRegistrations([withJobs('alpha', job())], { coreJobs: [core] });
      expect(jobs.map((entry) => entry.qualifiedName)).toEqual([
        'core:session-cleanup:v1',
        'alpha:sync:v1',
      ]);
      expect(() => registerCoreJob(job({ name: 'Bad' }))).toThrow();
    });

    it('reports an invalid plugin id once and skips all three jobs', () => {
      expect(problemsOf([withJobs('Bad:Id', job({ name: 'Bad' }), job(), job())])).toEqual([
        'plugin "Bad:Id" id is invalid: invalid_name',
      ]);
    });

    it('rejects a structurally identical core job not issued by registerCoreJob', () => {
      const issued = registerCoreJob(job());
      const forged: RegisteredJob = { ...issued };
      expectTypeOf<RegisteredJob>().not.toExtend<
        NonNullable<RegistrationOptions['coreJobs']>[number]
      >();
      expect(() =>
        collectRegistrations([], {
          // @ts-expect-error Only registerCoreJob output can be supplied as a core job.
          coreJobs: [forged],
        }),
      ).toThrow('core job was not issued by registerCoreJob');
    });

    it('rejects a spread copy typed as a registered core job and reports its entry index', () => {
      const issued = registerCoreJob(job());
      const copied: RegisteredCoreJob = { ...issued };
      expect(() => collectRegistrations([], { coreJobs: [issued, copied] })).toThrow(
        'core job was not issued by registerCoreJob (coreJobs entry 1)',
      );
    });

    it('rejects a duplicate core job', () => {
      const core = registerCoreJob(job({ name: 'session-cleanup' }));
      expect(() => collectRegistrations([], { coreJobs: [core, core] })).toThrow(KernelConfigError);
    });
  });
});

describe('route API registration', () => {
  const api = {
    operationId: 'getUsers',
    summary: 'Get users',
    tags: ['users'],
    responses: { 200: null },
  };

  it('rejects the same api problem as the standalone validator', () => {
    const route: RouteDefinition = { method: 'GET', path: '/p2/x', permission: null, handler, api };
    expect(problemsOf([withRoutes('p', [route])])).toEqual(
      routeApiProblems(route, 'plugin "p" route GET /p2/x'),
    );
    const plain = { method: route.method, path: route.path, permission: route.permission, handler };
    expect(collectRegistrations([withRoutes('p', [plain])]).routes).toHaveLength(1);
  });

  it('rejects a plugin claiming the reserved API namespace', () => {
    expect(
      problemsOf([
        withRoutes('p', [{ method: 'GET', path: '/_pb/users', permission: null, handler, api }]),
      ]),
    ).toHaveLength(1);
  });

  it('accepts plugin API version 4', () => {
    expect(() => collectRegistrations([plugin('p', { apiVersion: 4 })])).not.toThrow();
  });

  it('rejects plugin API version 5', () => {
    expect(problemsOf([plugin('p', { apiVersion: 5 })])).toEqual([
      'plugin "p" has apiVersion 5, core supports 3 to 4',
    ]);
  });

  const options = {
    platform: 'node' as const,
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-17T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: () => Promise.reject(new Error('unexpected org resolution')),
    health: () => Promise.resolve(true),
    log: () => undefined,
  };

  it('rejects invalid API metadata on core routes', async () => {
    await expect(
      createKernel({
        ...options,
        coreRoutes: [
          {
            method: 'GET',
            path: '/_pb/users',
            permission: null,
            handler,
            api: { ...api, operationId: 'Bad-Id' },
          },
        ],
      }),
    ).rejects.toThrow(KernelConfigError);
  });

  it('dispatches identically with and without API metadata', async () => {
    const results = [];
    for (const slot of [undefined, api]) {
      let calls = 0;
      const route: RouteDefinition = {
        method: 'GET',
        path: '/_pb/users',
        permission: null,
        needsOrg: false,
        ...(slot === undefined ? {} : { api: slot }),
        handler: () => {
          calls++;
          return new Response('users', { status: 202 });
        },
      };
      const kernel = await createKernel({ ...options, coreRoutes: [route] });
      const response = await kernel.fetch(new Request('https://broker.test/_pb/users'));
      results.push({ status: response.status, body: await response.text() });
      expect(calls).toBe(1);
    }
    expect(results).toEqual([
      { status: 202, body: 'users' },
      { status: 202, body: 'users' },
    ]);
  });
});
