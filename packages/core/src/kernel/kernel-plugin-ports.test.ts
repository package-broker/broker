import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  PlatformUnavailableError,
  requirePlatformPorts,
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RequestContext,
  type RouteDefinition,
} from '../plugin.js';
import type { BlobStore } from '../platform/blob.js';
import type { Cache } from '../platform/cache.js';
import type { JobEnqueue } from '../platform/job-repository.js';
import { JobError, jobErrorCode, type JobDefinition } from '../platform/jobs.js';
import type { JobStore } from '../platform/jobs-port.js';
import {
  noopObservability,
  type ObsRecord,
  type ObsRecordSink,
} from '../platform/observability.js';
import type { AuthorizationEngine } from './authorize.js';
import { createKernel } from './kernel.js';
import type { KernelOptions } from './kernel.js';
import { bindPluginPorts, type PlatformServices } from './plugin-ports.js';
import { KernelConfigError } from './registry.js';

const ORG = orgContext('org-1');
const BASE = 'http://broker.test';

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-16T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

function memoryStore(): JobStore & { readonly rows: JobEnqueue[] } {
  const rows: JobEnqueue[] = [];
  return {
    rows,
    enqueue(_ctx, row) {
      rows.push(row);
      return Promise.resolve({ id: row.id, created: true });
    },
    status(_ctx, id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve({
        id: row.id,
        type: row.type,
        state: 'queued',
        attempts: 0,
        maxAttempts: row.maxAttempts,
        runAt: '2026-10-16T00:00:00.000Z',
        lastErrorCode: null,
        history: [],
      });
    },
  };
}

function services(store: JobStore = memoryStore()): PlatformServices {
  return {
    blob: { kind: 'fake-blob' } as unknown as BlobStore,
    cache: { kind: 'fake-cache' } as unknown as Cache,
    jobStore: store,
  };
}

function recordingSink(): { sink: ObsRecordSink; logs: () => Record<string, unknown>[] } {
  const records: ObsRecord[] = [];
  return {
    sink: { emit: (record) => void records.push(record) },
    logs: () =>
      records.flatMap((record) =>
        record.kind === 'log' ? [record.record as unknown as Record<string, unknown>] : [],
      ),
  };
}

const job: JobDefinition = {
  name: 'x',
  version: 1,
  validate: (input: unknown) => input,
  handler: async () => {},
};

async function tryEnqueue(pluginPorts: PluginPorts, type: string): Promise<string> {
  try {
    await requirePlatformPorts(pluginPorts).jobs.enqueue(ORG, type, {}, { idempotencyKey: 'k1' });
    return 'ok';
  } catch (error) {
    return error instanceof JobError ? jobErrorCode(error) : 'other';
  }
}

interface Seen {
  init?: PluginPorts;
  route?: RequestContext;
}

function jobPlugin(
  id: string,
  seen: Seen,
  routeOverrides: Partial<RouteDefinition> = {},
  extra: Partial<PluginDefinition> = {},
): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    register(registry) {
      registry.job(job);
      registry.route({
        method: 'GET',
        path: `/${id}/run`,
        permission: null,
        handler: async (ctx) => {
          seen.route = ctx;
          requirePlatformPorts(ctx.ports).observability.log({ level: 'info', event: 'http.error' });
          return Response.json({
            own: await tryEnqueue(ctx.ports, `${id}:x:v1`),
            other: await tryEnqueue(ctx.ports, `${id === 'a' ? 'b' : 'a'}:x:v1`),
          });
        },
        ...routeOverrides,
      });
    },
    init(initPorts) {
      seen.init = initPorts;
      requirePlatformPorts(initPorts).observability.log({ level: 'info', event: 'http.error' });
    },
    ...extra,
  };
}

function options(
  plugins: readonly PluginDefinition[],
  overrides: Partial<KernelOptions> = {},
): KernelOptions {
  return {
    platform: 'node',
    plugins,
    ports,
    resolveOrg: () => Promise.resolve(ORG),
    health: () => Promise.resolve(true),
    log: () => undefined,
    ...overrides,
  };
}

describe('kernel plugin ports: init and routes', () => {
  it('binds jobs and observability to each plugin', async () => {
    const seenA: Seen = {};
    const seenB: Seen = {};
    const store = memoryStore();
    const { sink, logs } = recordingSink();
    const kernel = await createKernel(
      options([jobPlugin('a', seenA), jobPlugin('b', seenB)], {
        platformServices: services(store),
        observability: { sink, deploymentId: 'dep-1' },
      }),
    );

    expect(await tryEnqueue(seenA.init!, 'a:x:v1')).toBe('ok');
    expect(await tryEnqueue(seenA.init!, 'b:x:v1')).toBe('invalid_name');
    expect(await tryEnqueue(seenB.init!, 'b:x:v1')).toBe('ok');
    expect(await tryEnqueue(seenB.init!, 'a:x:v1')).toBe('invalid_name');

    const initLogs = logs().filter((entry) => entry['event'] === 'http.error');
    expect(initLogs.map((entry) => [entry['plugin'], entry['request_id']])).toEqual([
      ['a', null],
      ['b', null],
    ]);

    for (const id of ['a', 'b']) {
      const response = await kernel.fetch(new Request(`${BASE}/${id}/run`));
      expect(await response.json()).toEqual({ own: 'ok', other: 'invalid_name' });
      const requestId = response.headers.get('x-request-id');
      const routeLog = logs().filter(
        (entry) => entry['event'] === 'http.error' && entry['request_id'] === requestId,
      );
      expect(routeLog).toHaveLength(1);
      expect(routeLog[0]!['plugin']).toBe(id);
    }
    expect(store.rows.every((row) => row.projectId === null && row.initiatorTokenId === null)).toBe(
      true,
    );
  });

  it('passes the allowed project id and token id as the job initiator', async () => {
    const seen: Seen = {};
    const store = memoryStore();
    const engine: AuthorizationEngine = {
      authorize: () =>
        Promise.resolve({
          allow: true,
          principal: { kind: 'user', id: 'u-1' },
          projectId: 'p-1',
          tokenId: 'tok_01',
        }),
    };
    const kernel = await createKernel(
      options(
        [
          jobPlugin('a', seen, {
            path: '/p/:project/a-run',
            permission: 'project:read',
            boundary: 'project',
          }),
        ],
        { platformServices: services(store), authorization: engine },
      ),
    );
    store.rows.length = 0;

    const response = await kernel.fetch(new Request(`${BASE}/p/demo/a-run`));
    expect(response.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ projectId: 'p-1', initiatorTokenId: 'tok_01' });
  });

  it('enqueues from a public route with a null project and token', async () => {
    const store = memoryStore();
    const kernel = await createKernel(
      options([jobPlugin('a', {})], { platformServices: services(store) }),
    );

    await kernel.fetch(new Request(`${BASE}/a/run`));
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ projectId: null, initiatorTokenId: null });
  });

  it('passes the exact blob and cache objects and freezes every bound port', async () => {
    const seen: Seen = {};
    const platform = services();
    await createKernel(options([jobPlugin('a', seen)], { platformServices: platform })).then(
      (kernel) => kernel.fetch(new Request(`${BASE}/a/run`)),
    );

    for (const bound of [seen.init!, seen.route!.ports]) {
      expect(Object.isFrozen(bound)).toBe(true);
      expect(Object.isFrozen(bound.platform)).toBe(true);
      expect(bound.platform!.blob).toBe(platform.blob);
      expect(bound.platform!.cache).toBe(platform.cache);
      expect(bound.organizations).toBe(ports.organizations);
      expect(bound.clock).toBe(ports.clock);
      expect(bound.ids).toBe(ports.ids);
    }
  });
});

describe('kernel plugin ports: isolation and per-request binding', () => {
  it('hides a job from another plugin on get', async () => {
    const seenA: Seen = {};
    const seenB: Seen = {};
    await createKernel(
      options([jobPlugin('a', seenA), jobPlugin('b', seenB)], {
        platformServices: services(),
      }),
    );
    const own = requirePlatformPorts(seenA.init!).jobs;
    const other = requirePlatformPorts(seenB.init!).jobs;

    const { id } = await own.enqueue(ORG, 'a:x:v1', {}, { idempotencyKey: 'k1' });
    expect(await other.get(ORG, id)).toBeNull();
    expect(await own.get(ORG, id)).toMatchObject({ id, type: 'a:x:v1' });
  });

  it('binds each request to its own initiator and ports object', async () => {
    const store = memoryStore();
    const routePorts: PluginPorts[] = [];
    const enqueueing = (path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition => ({
      method: 'GET',
      path,
      permission: null,
      handler: async (ctx) => {
        routePorts.push(ctx.ports);
        return Response.json({ own: await tryEnqueue(ctx.ports, 'a:x:v1') });
      },
      ...extra,
    });
    const engine: AuthorizationEngine = {
      authorize: () =>
        Promise.resolve({
          allow: true,
          principal: { kind: 'user', id: 'u-1' },
          projectId: 'p-1',
          tokenId: 'tok_01',
        }),
    };
    const twoRoutes: PluginDefinition = {
      id: 'a',
      package: '@test/a',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register(registry) {
        registry.job(job);
        registry.route(
          enqueueing('/p/:project/a-run', { permission: 'project:read', boundary: 'project' }),
        );
        registry.route(enqueueing('/a/run'));
      },
    };
    const kernel = await createKernel(
      options([twoRoutes], { platformServices: services(store), authorization: engine }),
    );

    expect((await kernel.fetch(new Request(`${BASE}/p/demo/a-run`))).status).toBe(200);
    expect((await kernel.fetch(new Request(`${BASE}/a/run`))).status).toBe(200);

    expect(store.rows.map((row) => [row.projectId, row.initiatorTokenId])).toEqual([
      ['p-1', 'tok_01'],
      [null, null],
    ]);
    expect(routePorts).toHaveLength(2);
    expect(routePorts[0]).not.toBe(routePorts[1]);
    expect(routePorts[0]!.platform!.jobs).not.toBe(routePorts[1]!.platform!.jobs);
  });
});

describe('kernel plugin ports: jobScope', () => {
  async function scoped() {
    const { sink, logs } = recordingSink();
    const store = memoryStore();
    const kernel = await createKernel(
      options([jobPlugin('a', {}), jobPlugin('b', {})], {
        platformServices: services(store),
        observability: { sink, deploymentId: 'dep-1' },
      }),
    );
    return { kernel, logs, store };
  }

  it('binds ports and observability to the job plugin, job id and attempt', async () => {
    const { kernel, logs } = await scoped();
    const registered = kernel.registration.jobs.find((entry) => entry.plugin === 'b')!;

    const scope = kernel.jobScope(registered, { jobId: '01JA0000000000000000000001', attempt: 2 });
    expect(Object.isFrozen(scope.ports)).toBe(true);
    expect(await tryEnqueue(scope.ports, 'b:x:v1')).toBe('ok');
    expect(await tryEnqueue(scope.ports, 'a:x:v1')).toBe('invalid_name');

    scope.observability.log({ level: 'info', event: 'http.error' });
    const record = logs().at(-1)!;
    expect(record).toMatchObject({
      plugin: 'b',
      job_id: '01JA0000000000000000000001',
      attempt: 2,
      request_id: null,
    });
    expect(requirePlatformPorts(scope.ports).observability).toBe(scope.observability);
  });

  it('throws TypeError for a structurally equal job not from the registration', async () => {
    const { kernel } = await scoped();
    const registered = kernel.registration.jobs[0]!;

    expect(() =>
      kernel.jobScope({ ...registered }, { jobId: '01JA0000000000000000000001', attempt: 1 }),
    ).toThrow(TypeError);
  });

  it('falls back to a working no-op observability for an invalid job id', async () => {
    const { kernel, logs } = await scoped();
    const registered = kernel.registration.jobs[0]!;
    const before = logs().length;

    const scope = kernel.jobScope(registered, { jobId: 'not a job id\n', attempt: 1 });
    expect(() => scope.observability.log({ level: 'info', event: 'http.error' })).not.toThrow();
    expect(logs()).toHaveLength(before);
    expect(await tryEnqueue(scope.ports, `${registered.plugin}:x:v1`)).toBe('ok');
  });
});

describe('kernel plugin ports: configuration', () => {
  it('refuses ports.platform set by the caller', async () => {
    const seeded = { ...ports, platform: {} as never };
    await expect(createKernel(options([], { ports: seeded }))).rejects.toThrow(KernelConfigError);
    await expect(createKernel(options([], { ports: seeded }))).rejects.toThrow(
      'ports.platform is bound by the kernel; pass platform services',
    );
  });

  it('refuses an own platform key even when it is undefined, and freezes ports', async () => {
    const seeded = { ...ports, platform: undefined } as unknown as PluginPorts;
    await expect(createKernel(options([], { ports: seeded }))).rejects.toThrow(
      'ports.platform is bound by the kernel; pass platform services',
    );
    const own: PluginPorts = { ...ports };
    await createKernel(options([], { ports: own }));
    expect(Object.isFrozen(own)).toBe(true);
  });

  it('bindPluginPorts refuses services without a jobs factory', () => {
    const binding = {
      pluginId: 'a',
      observability: noopObservability,
      initiator: { projectId: null, tokenId: null },
    };
    expect(() => bindPluginPorts(ports, services(), undefined, binding)).toThrow(TypeError);
  });

  it('refuses a plugin that registers jobs when platform services are disabled', async () => {
    const plugins = [
      jobPlugin('a', {}),
      jobPlugin('b', {}, {}, { register: (registry) => registry.route(plainRoute) }),
    ];
    const attempt = createKernel(options(plugins));
    await expect(attempt).rejects.toThrow(KernelConfigError);
    await expect(createKernel(options(plugins))).rejects.toThrow(
      'plugin "a" registers jobs but platform services are disabled',
    );
    await expect(createKernel(options(plugins))).rejects.not.toThrow('plugin "b"');
  });

  it('leaves platform absent when services are disabled and no job is registered', async () => {
    let initPorts: PluginPorts | undefined;
    let routePorts: PluginPorts | undefined;
    const plugin: PluginDefinition = {
      id: 'plain',
      package: '@test/plain',
      apiVersion: SUPPORTED_PLUGIN_API[1],
      platforms: ['node'],
      register: (registry) =>
        registry.route({
          ...plainRoute,
          handler: (ctx) => {
            routePorts = ctx.ports;
            return new Response('ok');
          },
        }),
      init: (bound) => {
        initPorts = bound;
      },
    };
    const kernel = await createKernel(options([plugin]));
    await kernel.fetch(new Request(`${BASE}/plain`));

    for (const bound of [initPorts!, routePorts!]) {
      expect(Object.hasOwn(bound, 'platform')).toBe(false);
      expect(() => requirePlatformPorts(bound)).toThrow(PlatformUnavailableError);
    }
  });
});

const plainRoute: RouteDefinition = {
  method: 'GET',
  path: '/plain',
  permission: null,
  handler: () => new Response('ok'),
};
