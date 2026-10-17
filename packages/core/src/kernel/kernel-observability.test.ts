import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
  type RequestContext,
  type RouteDefinition,
} from '../plugin.js';
import type { ObsRecord, ObsRecordSink } from '../platform/observability.js';
import type { AuthorizationDecision, AuthorizationEngine, authorizeRoute } from './authorize.js';
import { envelopeResponse } from './errors.js';
import { createKernel } from './kernel.js';
import type { KernelOptions } from './kernel.js';
import { KernelConfigError } from './registry.js';

const ORG = orgContext('org-1');
const BASE = 'http://broker.test';
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) },
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};

type Entry = Readonly<Record<string, unknown>>;

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

function denyingHook(id: string, result: () => unknown): PluginDefinition {
  return plugin(id, [], {
    register(registry) {
      registry.hook('access.check', result as never);
    },
  });
}

const publicItem: RouteDefinition = {
  method: 'GET',
  path: '/items/:id',
  permission: null,
  handler: (ctx) => Response.json({ id: ctx.params['id'] }),
};

function contextKeys(ctx: RequestContext): Response {
  return Response.json({ keys: Object.keys(ctx) });
}

const protectedItem: RouteDefinition = {
  method: 'GET',
  path: '/secure/:id',
  permission: 'org:read',
  boundary: 'organization',
  handler: contextKeys,
};

function engineReturning(decision: AuthorizationDecision): AuthorizationEngine {
  return { authorize: () => Promise.resolve(decision) };
}

const allowWithToken = engineReturning({
  allow: true,
  principal: { kind: 'user', id: 'u-1' },
  projectId: 'p-1',
  tokenId: 'tok_01',
});

function options(
  plugins: readonly PluginDefinition[],
  logs: Entry[],
  overrides: Partial<KernelOptions> = {},
): KernelOptions {
  let healthy = true;
  return {
    platform: 'node',
    plugins,
    ports,
    resolveOrg: () => Promise.resolve(ORG),
    health: () => {
      const value = healthy;
      healthy = true;
      return Promise.resolve(value);
    },
    log: (entry) => {
      logs.push(entry);
    },
    ...overrides,
  };
}

function completions(logs: readonly Entry[]): Entry[] {
  return logs.filter((entry) => entry['event'] === 'http.request');
}

function countingSink(): { sink: ObsRecordSink; records: ObsRecord[] } {
  const records: ObsRecord[] = [];
  return { records, sink: { emit: (record) => void records.push(record) } };
}

async function envelopeId(response: Response): Promise<unknown> {
  const body = (await response.clone().json()) as { error?: { requestId?: unknown } };
  return body.error?.requestId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('kernel completion record', () => {
  it('emits one http.request per request with the minted id, trace fields and reason', async () => {
    const logs: Entry[] = [];
    let healthy = true;
    const kernel = await createKernel({
      ...options([plugin('alpha', [publicItem])], logs),
      health: () => Promise.resolve(healthy),
    });

    const cases: Array<[string, number, string | undefined, string | undefined, boolean, string]> =
      [
        ['/items/42', 200, undefined, '/items/:id', false, 'info'],
        ['/nowhere', 404, 'route.not_found', undefined, true, 'info'],
        ['/health/live', 200, undefined, '/health/live', false, 'debug'],
        ['/health/ready', 503, 'health.not_ready', '/health/ready', true, 'warn'],
      ];
    for (const [path, status, reason, route, hasEnvelope, level] of cases) {
      logs.length = 0;
      healthy = path !== '/health/ready';
      const response = await kernel.fetch(new Request(`${BASE}${path}`));
      const id = response.headers.get('x-request-id');

      expect(response.status).toBe(status);
      const done = completions(logs);
      expect(done).toHaveLength(1);
      const record = done[0]!;
      expect(record['request_id']).toBe(id);
      if (hasEnvelope) expect(await envelopeId(response)).toBe(id);
      expect(record['status']).toBe(status);
      expect(record['duration_ms']).toEqual(expect.any(Number));
      expect(record['trace_id']).toMatch(TRACE_ID);
      expect(record['span_id']).toMatch(SPAN_ID);
      expect(record['reason_code']).toBe(reason);
      expect(record['route']).toBe(route);
      expect(record['level']).toBe(level);
    }
  });

  it('logs a failing readiness probe as http.error then http.request', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel({
      ...options([], logs),
      health: () => Promise.resolve(false),
    });

    const response = await kernel.fetch(new Request(`${BASE}/health/ready`));

    expect(logs.map((entry) => entry['event'])).toEqual(['http.error', 'http.request']);
    expect(logs[0]).toMatchObject({
      error_name: 'ProbeFailedError',
      request_id: response.headers.get('x-request-id'),
    });
  });

  it('keeps concurrent trusted trace contexts apart and ignores traceparent by default', async () => {
    const slow: RouteDefinition = {
      method: 'GET',
      path: '/slow/:n',
      permission: null,
      handler: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, Number(ctx.params['n']) % 5));
        return new Response('ok');
      },
    };
    const traceparent = (i: number): [string, string] => {
      const traceId = (i + 1).toString(16).padStart(32, 'a');
      return [traceId, `00-${traceId}-${'b'.repeat(15)}${(i % 9) + 1}-01`];
    };

    const { sink, records } = countingSink();
    const trusted = await createKernel({
      ...options([plugin('alpha', [slow])], []),
      observability: { sink, deploymentId: 'test', trustInboundTraceparent: true },
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        trusted.fetch(
          new Request(`${BASE}/slow/${String(i)}`, {
            headers: { traceparent: traceparent(i)[1] },
          }),
        ),
      ),
    );
    const logs = records.flatMap((record) => (record.kind === 'log' ? [record.record] : []));
    const ids = new Set<string>();
    responses.forEach((response, i) => {
      const id = response.headers.get('x-request-id')!;
      ids.add(id);
      const mine = logs.filter((record) => record.request_id === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.trace_id).toBe(traceparent(i)[0]);
    });
    expect(ids.size).toBe(20);

    const defaultLogs: Entry[] = [];
    const untrusted = await createKernel(options([plugin('alpha', [slow])], defaultLogs));
    await untrusted.fetch(
      new Request(`${BASE}/slow/1`, { headers: { traceparent: traceparent(3)[1] } }),
    );
    expect(completions(defaultLogs)).toHaveLength(1);
    expect(JSON.stringify(defaultLogs)).not.toContain(traceparent(3)[0]);
  });
});

describe('kernel completion exactly once', () => {
  it('completes once for a throwing handler, without the secret', async () => {
    const SECRET = 'sk_live_9f3aSENTINEL';
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [
            {
              method: 'GET',
              path: '/boom',
              permission: null,
              handler: () => {
                throw new Error(`password=${SECRET}`);
              },
            },
          ]),
        ],
        logs,
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/boom`));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(SECRET);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'internal' } });
    expect(logs.map((entry) => entry['event'])).toEqual(['http.error', 'http.request']);
    expect(logs[0]).toMatchObject({ error_name: 'Error' });
    expect(logs[1]).toMatchObject({ level: 'error', status: 500, reason_code: 'error.internal' });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it('completes once for a HEAD request with the final status', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(options([plugin('alpha', [publicItem])], logs));

    const response = await kernel.fetch(new Request(`${BASE}/items/1`, { method: 'HEAD' }));

    expect(await response.text()).toBe('');
    expect(completions(logs)).toEqual([
      expect.objectContaining({ status: 200, method: 'HEAD', route: '/items/:id' }),
    ]);
  });

  it('completes once when rebuilding the response fails', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [
            { method: 'GET', path: '/error', permission: null, handler: () => Response.error() },
          ]),
        ],
        logs,
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/error`));

    expect(response.status).toBe(500);
    expect(completions(logs)).toEqual([
      expect.objectContaining({ status: 500, reason_code: 'error.internal' }),
    ]);
    expect(logs.filter((entry) => entry['event'] === 'http.error')).toHaveLength(1);
  });

  it('completes once as aborted when the client aborts during the handler', async () => {
    const logs: Entry[] = [];
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [
            {
              method: 'GET',
              path: '/wait',
              permission: null,
              handler: async () => {
                entered();
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
                return new Response('late');
              },
            },
          ]),
        ],
        logs,
      ),
    );
    const controller = new AbortController();

    const pending = kernel.fetch(new Request(`${BASE}/wait`, { signal: controller.signal }));
    await started;
    controller.abort();
    expect(completions(logs)).toEqual([
      expect.objectContaining({ level: 'warn', reason_code: 'request.aborted' }),
    ]);
    expect(completions(logs)[0]).not.toHaveProperty('status');
    release();
    await pending;
    controller.abort();

    expect(completions(logs)).toHaveLength(1);
  });

  it('adds nothing when the signal aborts after completion', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(options([plugin('alpha', [publicItem])], logs));
    const controller = new AbortController();

    await kernel.fetch(new Request(`${BASE}/items/1`, { signal: controller.signal }));
    controller.abort();

    expect(completions(logs)).toEqual([expect.objectContaining({ status: 200 })]);
  });

  it('completes an already-aborted request at once, without route, project or token', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, { authorization: allowWithToken }),
    );

    await kernel.fetch(new Request(`${BASE}/secure/1`, { signal: AbortSignal.abort() }));

    const done = completions(logs);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      reason_code: 'request.aborted',
      project_id: null,
      token_id: null,
    });
    expect(done[0]).not.toHaveProperty('route');
  });
});

describe('kernel authorization records', () => {
  it('logs a free-text hook denial as hook.denied with the verified token id', async () => {
    const FREE_TEXT = 'quota-exceeded-for-ada';
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('guard', () => ({ deny: true, reason: FREE_TEXT })),
        ],
        logs,
        { authorization: allowWithToken },
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/secure/7`));

    expect(response.status).toBe(403);
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'authz.denied',
        plugin: 'guard',
        reason_code: 'hook.denied',
        token_id: 'tok_01',
        project_id: 'p-1',
      }),
      expect.objectContaining({
        event: 'http.request',
        status: 403,
        reason_code: 'hook.denied',
        token_id: 'tok_01',
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(FREE_TEXT);
  });

  it('maps an invalid hook result to hook.invalid_result', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [plugin('alpha', [protectedItem]), denyingHook('guard', () => ({ deny: 'maybe' }))],
        logs,
        { authorization: allowWithToken },
      ),
    );

    await kernel.fetch(new Request(`${BASE}/secure/7`));

    expect(logs[0]).toMatchObject({ event: 'authz.denied', reason_code: 'hook.invalid_result' });
    expect(completions(logs)[0]).toMatchObject({ reason_code: 'hook.invalid_result' });
  });

  it('logs a throwing hook as authz.error with hook.error', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('broken', () => {
            throw new RangeError('secret detail');
          }),
        ],
        logs,
        { authorization: allowWithToken },
      ),
    );

    await kernel.fetch(new Request(`${BASE}/secure/7`));

    expect(logs[0]).toMatchObject({
      event: 'authz.error',
      plugin: 'broken',
      error_name: 'RangeError',
      reason_code: 'hook.error',
      token_id: 'tok_01',
    });
    expect(completions(logs)[0]).toMatchObject({ status: 403, reason_code: 'hook.error' });
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });

  it('logs an engine timeout as authz.error from core with authz.engine_error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, {
        authorization: { authorize: () => new Promise<never>(() => undefined) },
      }),
    );

    const pending = kernel.fetch(new Request(`${BASE}/secure/7`));
    await vi.advanceTimersByTimeAsync(2001);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'authz.error',
        plugin: 'core',
        error_name: 'EngineTimeoutError',
        reason_code: 'authz.engine_error',
        token_id: null,
      }),
      expect.objectContaining({ event: 'http.request', reason_code: 'authz.engine_error' }),
    ]);
  });

  it('logs token_id null on an engine 401 and before authorization', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem, publicItem])], logs, {
        authorization: engineReturning({ allow: false, status: 401 }),
      }),
    );

    await kernel.fetch(new Request(`${BASE}/secure/1`));
    await kernel.fetch(new Request(`${BASE}/items/1`));

    expect(completions(logs)).toEqual([
      expect.objectContaining({
        status: 401,
        reason_code: 'authz.unauthenticated',
        token_id: null,
      }),
      expect.objectContaining({ status: 200, token_id: null }),
    ]);
  });

  it('logs authz.unauthenticated for a self-boundary route without a session', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([], logs, {
        coreRoutes: [
          {
            method: 'GET',
            path: '/_pb/me',
            permission: null,
            boundary: 'self',
            handler: () => new Response('me'),
          },
        ],
      }),
    );

    const response = await kernel.fetch(new Request(`${BASE}/_pb/me`));

    expect(response.status).toBe(401);
    expect(completions(logs)).toEqual([
      expect.objectContaining({ reason_code: 'authz.unauthenticated', route: '/_pb/me' }),
    ]);
  });

  it('records the verified token id but never hands it to the handler', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, { authorization: allowWithToken }),
    );

    const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

    const { keys } = (await response.json()) as { keys: string[] };
    expect(keys).not.toContain('tokenId');
    expect(completions(logs)[0]).toMatchObject({ status: 200, token_id: 'tok_01' });
  });
});

describe('kernel observability option', () => {
  it('emits one counter and one histogram per request with template route labels', async () => {
    const { sink, records } = countingSink();
    const kernel = await createKernel({
      ...options([plugin('alpha', [publicItem, protectedItem])], []),
      observability: { sink, deploymentId: 'prod-1' },
    });

    const paths = ['/items/1', '/items/2', '/nowhere', '/health/live', '/secure/1'];
    for (const path of paths) await kernel.fetch(new Request(`${BASE}${path}`));

    const counters = records.filter(
      (record) => record.kind === 'counter' && record.name === 'pb.http.requests',
    );
    const histograms = records.filter(
      (record) => record.kind === 'histogram' && record.name === 'pb.http.duration_ms',
    );
    expect(counters).toHaveLength(paths.length);
    expect(histograms).toHaveLength(paths.length);
    for (const record of [...counters, ...histograms]) {
      if (record.kind === 'log') continue;
      const route = record.labels['route'];
      if (route !== undefined) expect(kernel.routeTemplates.has(route)).toBe(true);
    }
    expect(counters.map((record) => (record.kind === 'log' ? '' : record.labels['route']))).toEqual(
      ['/items/:id', '/items/:id', undefined, '/health/live', '/secure/:id'],
    );
    expect(
      records.some((record) => record.kind === 'counter' && record.name === 'pb.obs.dropped'),
    ).toBe(false);
    const log = records.find((record) => record.kind === 'log');
    expect(log?.kind === 'log' ? log.record.deployment_id : undefined).toBe('prod-1');
  });

  it('exposes the route templates once', async () => {
    const kernel = await createKernel(
      options([plugin('alpha', [publicItem])], [], {
        coreRoutes: [
          { method: 'GET', path: '/_pb/ping', permission: null, handler: () => new Response('') },
        ],
      }),
    );

    expect([...kernel.routeTemplates].sort()).toEqual(
      ['/_pb/ping', '/health/live', '/health/ready', '/items/:id'].sort(),
    );
  });

  it('rejects an invalid deployment id at startup', async () => {
    const { sink } = countingSink();
    await expect(
      createKernel({
        ...options([], []),
        observability: { sink, deploymentId: 'bad id with spaces' },
      }),
    ).rejects.toBeInstanceOf(KernelConfigError);
  });

  it('serves odd routes, plugin ids and methods and logs them without the offending field', async () => {
    const { sink, records } = countingSink();
    const tilde: RouteDefinition = {
      method: 'GET',
      path: '/a~b',
      permission: null,
      handler: () => new Response('tilde'),
    };
    const kernel = await createKernel({
      ...options(
        [
          plugin('alpha', [tilde, protectedItem]),
          denyingHook('Bad_Plugin', () => ({ deny: true, reason: 'x' })),
        ],
        [],
        { authorization: allowWithToken },
      ),
      observability: { sink, deploymentId: 'prod-1' },
    });

    const tildeResponse = await kernel.fetch(new Request(`${BASE}/a~b`));
    const denied = await kernel.fetch(new Request(`${BASE}/secure/1`));
    const odd = await kernel.fetch(new Request(`${BASE}/items/1`, { method: 'PROPFIND' }));

    expect(tildeResponse.status).toBe(200);
    expect(await tildeResponse.text()).toBe('tilde');
    expect(denied.status).toBe(403);
    expect(odd.status).toBe(404);
    expect(kernel.routeTemplates.has('/a~b')).toBe(false);
    const logs = records.flatMap((record) => (record.kind === 'log' ? [record.record] : []));
    const byId = (response: Response) =>
      logs.filter((record) => record.request_id === response.headers.get('x-request-id'));
    expect(byId(tildeResponse)).toEqual([
      expect.not.objectContaining({ route: expect.anything() as unknown }),
    ]);
    expect(byId(denied)[0]).toMatchObject({ event: 'authz.denied', reason_code: 'hook.denied' });
    expect(byId(denied)[0]).not.toHaveProperty('plugin');
    expect(byId(odd)).toHaveLength(1);
    expect(byId(odd)[0]).not.toHaveProperty('method');
    expect(
      records.some((record) => record.kind === 'counter' && record.name === 'pb.obs.dropped'),
    ).toBe(false);
  });
});

function shiftingTokenDecision(): { decision: object; reads: () => number } {
  let reads = 0;
  const decision = new Proxy(
    { allow: true, principal: { kind: 'user', id: 'u-1' }, projectId: 'p-1', tokenId: 'tok_A' },
    {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== 'tokenId' || descriptor === undefined) return descriptor;
        reads++;
        return { ...descriptor, value: reads === 1 ? 'tok_A' : 'tok_B' };
      },
    },
  );
  return { decision, reads: () => reads };
}

describe('kernel engine decision copy', () => {
  it('logs the token id authorization accepted when a proxy changes it between reads', async () => {
    for (const withHook of [true, false]) {
      const shifting = shiftingTokenDecision();
      const logs: Entry[] = [];
      const kernel = await createKernel(
        options(
          [
            plugin('alpha', [protectedItem]),
            ...(withHook ? [denyingHook('guard', () => ({ deny: true, reason: 'no' }))] : []),
          ],
          logs,
          {
            authorization: {
              authorize: () => Promise.resolve(shifting.decision as AuthorizationDecision),
            },
          },
        ),
      );

      const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

      expect(response.status).toBe(withHook ? 403 : 200);
      const tokens = new Set(logs.map((entry) => entry['token_id']));
      expect([...tokens]).toEqual(['tok_A']);
      expect(shifting.reads()).toBe(1);
    }
  });

  it('keeps the outcome of an accessor decision and logs no token id', async () => {
    const logs: Entry[] = [];
    const decision = {
      allow: true,
      principal: { kind: 'user', id: 'u-1' },
      projectId: 'p-1',
      get tokenId(): string {
        return 'tok_01';
      },
    };
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('guard', () => ({ deny: true, reason: 'no' })),
        ],
        logs,
        { authorization: { authorize: () => Promise.resolve(decision as AuthorizationDecision) } },
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

    expect(response.status).toBe(503);
    expect(logs).toEqual([
      expect.objectContaining({ event: 'authz.error', reason_code: 'authz.engine_error' }),
      expect.objectContaining({ event: 'http.request', token_id: null }),
    ]);
  });

  it('keeps the outcome of a malformed decision', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, {
        authorization: engineReturning({ allow: false, status: 404, x: 1 } as never),
      }),
    );

    const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

    expect(response.status).toBe(503);
    expect(logs.map((entry) => entry['event'])).toEqual(['authz.error', 'http.request']);
  });

  it('ignores an engine result that arrives after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('guard', () => ({ deny: true, reason: 'no' })),
        ],
        logs,
        {
          authorization: {
            authorize: () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    allow: true,
                    principal: { kind: 'user', id: 'u-1' },
                    projectId: 'p-1',
                    tokenId: 'tok_late',
                  });
                }, 5000);
              }),
          },
        },
      ),
    );

    const pending = kernel.fetch(new Request(`${BASE}/secure/1`));
    await vi.advanceTimersByTimeAsync(2001);
    const response = await pending;
    await vi.advanceTimersByTimeAsync(5000);

    expect(response.status).toBe(503);
    expect(logs.map((entry) => entry['event'])).toEqual(['authz.error', 'http.request']);
    expect(JSON.stringify(logs)).not.toContain('tok_late');
  });
});

describe('kernel failure fallbacks', () => {
  it('answers a minimal 500 when the error cannot be mapped, logging once', async () => {
    const hostile = new Proxy(new Error('secret-proxy'), {
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [
            {
              method: 'GET',
              path: '/hostile',
              permission: null,
              handler: () => {
                throw hostile;
              },
            },
          ]),
        ],
        logs,
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/hostile`));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'internal' } });
    expect(logs.map((entry) => entry['event'])).toEqual(['http.error', 'http.request']);
    expect(completions(logs)[0]).toMatchObject({ status: 500, reason_code: 'error.internal' });
    expect(JSON.stringify(logs)).not.toContain('secret-proxy');
  });

  it('logs one http.error when routing itself throws', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(options([plugin('alpha', [publicItem])], logs));
    const real = new Request(`${BASE}/items/1`);
    const broken = new Proxy(real, {
      get(target, key) {
        if (key === 'url') throw new Error('no url');
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    const response = await kernel.fetch(broken);

    expect(response.status).toBe(500);
    expect(logs.map((entry) => entry['event'])).toEqual(['http.error', 'http.request']);
    expect(completions(logs)[0]).toMatchObject({ status: 500 });
  });

  it('refuses to mutate the route templates', async () => {
    const kernel = await createKernel(options([plugin('alpha', [publicItem])], []));
    const templates = kernel.routeTemplates as Set<string>;

    expect(() => templates.add('/x')).toThrow(TypeError);
    expect(() => templates.delete('/items/:id')).toThrow(TypeError);
    expect(() => {
      templates.clear();
    }).toThrow(TypeError);
    expect(kernel.routeTemplates.has('/items/:id')).toBe(true);
    expect(kernel.routeTemplates.has('/x')).toBe(false);
  });
});

describe('kernel onDeny hook_error', () => {
  afterEach(() => {
    vi.doUnmock('./authorize.js');
    vi.resetModules();
  });

  it('maps hook_error from onDeny to hook.error', async () => {
    vi.resetModules();
    vi.doMock('./authorize.js', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      const fake: typeof authorizeRoute = (_request, _engine, _hooks, _onHookError, opts) => {
        opts?.onDeny?.({ plugin: 'guard', reason: 'hook_error' });
        return Promise.resolve({ allow: false, status: 403 });
      };
      return { ...actual, authorizeRoute: fake };
    });
    const fresh = (await import('./kernel.js')).createKernel;
    const logs: Entry[] = [];
    const kernel = await fresh(options([plugin('alpha', [protectedItem])], logs));

    const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

    expect(response.status).toBe(403);
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'authz.denied',
        plugin: 'guard',
        reason_code: 'hook.error',
      }),
      expect.objectContaining({ event: 'http.request', reason_code: 'hook.error' }),
    ]);
  });

  it('does not log authz.denied for a hook error already reported', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('broken', () => {
            throw new RangeError('boom');
          }),
        ],
        logs,
        { authorization: allowWithToken },
      ),
    );

    await kernel.fetch(new Request(`${BASE}/secure/1`));

    expect(logs.map((entry) => entry['event'])).toEqual(['authz.error', 'http.request']);
  });
});

describe('engine failure versus policy denial', () => {
  const failures: ReadonlyArray<readonly [string, AuthorizationEngine]> = [
    ['a rejecting engine', { authorize: () => Promise.reject(new Error('engine down')) }],
    ['a missing authorize method', {} as AuthorizationEngine],
    ['a malformed decision', engineReturning({ allow: false, status: 404, x: 1 } as never)],
  ];

  it.each(failures)('answers 503 without admin text for %s', async (_label, authorization) => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, { authorization }),
    );

    const response = await kernel.fetch(
      new Request(`${BASE}/secure/1`, { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await response.text();
    expect(text).not.toMatch(/administrator/i);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable' } });
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'authz.error',
        level: 'error',
        reason_code: 'authz.engine_error',
      }),
      expect.objectContaining({
        event: 'http.request',
        status: 503,
        reason_code: 'authz.engine_error',
      }),
    ]);
  });

  it('answers 503 on an engine timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, {
        authorization: { authorize: () => new Promise<never>(() => undefined) },
      }),
    );

    const pending = kernel.fetch(
      new Request(`${BASE}/secure/7`, { headers: { accept: 'text/html' } }),
    );
    await vi.advanceTimersByTimeAsync(2001);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/administrator/i);
  });

  it('keeps the 403 page for a policy denial by the engine', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem])], logs, {
        authorization: engineReturning({ allow: false, status: 403 }),
      }),
    );

    const response = await kernel.fetch(
      new Request(`${BASE}/secure/1`, { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/administrator/i);
  });

  it('keeps the 403 page for a policy denial by a hook', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('guard', () => ({ deny: true, reason: 'no' })),
        ],
        logs,
        { authorization: allowWithToken },
      ),
    );

    const response = await kernel.fetch(
      new Request(`${BASE}/secure/1`, { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/administrator/i);
  });

  it('keeps the 403 for a throwing hook', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options(
        [
          plugin('alpha', [protectedItem]),
          denyingHook('broken', () => {
            throw new RangeError('boom');
          }),
        ],
        logs,
        { authorization: allowWithToken },
      ),
    );

    const response = await kernel.fetch(new Request(`${BASE}/secure/1`));

    expect(response.status).toBe(403);
  });
});

describe('handler status and envelope reason', () => {
  const teapot: RouteDefinition = {
    method: 'GET',
    path: '/teapot',
    permission: null,
    handler: () => new Response('short and stout', { status: 418 }),
  };

  it('records http.handler_status for a plugin 418 without a reason code', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(options([plugin('alpha', [teapot])], logs));

    const response = await kernel.fetch(new Request(`${BASE}/teapot`));

    expect(response.status).toBe(418);
    expect(completions(logs)[0]).toMatchObject({ status: 418, reason_code: 'http.handler_status' });
  });

  it('records no reason for a plugin success', async () => {
    const logs: Entry[] = [];
    const kernel = await createKernel(options([plugin('alpha', [publicItem])], logs));

    await kernel.fetch(new Request(`${BASE}/items/1`));

    expect(completions(logs)[0]).not.toHaveProperty('reason_code');
  });

  it.each(['error.unavailable', undefined] as const)(
    'uses the attached core-route reason (%s) or http.handler_status without reading the body',
    async (reason) => {
      const logs: Entry[] = [];
      const kernel = await createKernel(
        options([], logs, {
          coreRoutes: [
            {
              method: 'GET',
              path: '/_pb/unavailable',
              permission: null,
              handler: (ctx) =>
                envelopeResponse(503, 'unavailable', 'Try again later', ctx.requestId, reason),
            },
          ],
        }),
      );
      const json = vi.spyOn(Response.prototype, 'json');
      const text = vi.spyOn(Response.prototype, 'text');
      try {
        const response = await kernel.fetch(new Request(`${BASE}/_pb/unavailable`));

        expect(response.status).toBe(503);
        expect(completions(logs)[0]).toMatchObject({
          reason_code: reason ?? 'http.handler_status',
        });
        expect(json).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
      } finally {
        json.mockRestore();
        text.mockRestore();
      }
    },
  );

  it('does not read the body of a kernel envelope response', async () => {
    const json = vi.spyOn(Response.prototype, 'json');
    const text = vi.spyOn(Response.prototype, 'text');
    try {
      const logs: Entry[] = [];
      const kernel = await createKernel(
        options(
          [
            plugin('alpha', [
              {
                method: 'GET',
                path: '/boom',
                permission: null,
                handler: () => {
                  throw new Error('x');
                },
              },
            ]),
          ],
          logs,
        ),
      );

      const response = await kernel.fetch(new Request(`${BASE}/boom`));

      expect(response.status).toBe(500);
      expect(completions(logs)[0]).toMatchObject({ reason_code: 'error.internal' });
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    } finally {
      json.mockRestore();
      text.mockRestore();
    }
  });
});

describe('denial logging', () => {
  const SENTINEL = 'sentinel-secret-9f3a';

  it.each([
    ['a denying hook', () => ({ deny: true as const, reason: SENTINEL })],
    [
      'a throwing hook',
      () => {
        throw new RangeError(SENTINEL);
      },
    ],
  ])('logs the denial of %s without the sentinel', async (_label, handler) => {
    const logs: Entry[] = [];
    const kernel = await createKernel(
      options([plugin('alpha', [protectedItem]), denyingHook('guard', handler)], logs, {
        authorization: allowWithToken,
      }),
    );

    const response = await kernel.fetch(
      new Request(`${BASE}/secure/7`, { headers: { accept: 'text/html' } }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SENTINEL);
    expect(logs.filter((entry) => String(entry['event']).startsWith('authz.'))).toHaveLength(1);
    expect(completions(logs)).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });
});
