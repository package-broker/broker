import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS, blobPurgeTiming } from './index.js';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import type { ByteStore } from '@package-broker/core/platform/blob';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from './db/d1-executor.js';
import { orgContext } from '@package-broker/core/db/port';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { definePlugin, requirePlatformPorts } from '@package-broker/core/plugin';
import type { PluginPorts } from '@package-broker/core/plugin';
import type { R2BucketLike } from './blob/r2.js';
import type { CacheStorageLike } from './cache/cache-api.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './db/d1-executor.js';
import type { QueueLike } from './jobs/consumer.js';
import type { AnalyticsEngineLike } from './observability/workers.js';
import { createWorker, unboundExecutor } from './index.js';
import type { Env, WorkerOptions } from './index.js';

describe('runtime-cloudflare', () => {
  it('answers unknown routes with the error envelope', async () => {
    const response = await createWorker([]).fetch(new Request('https://broker.invalid/nope'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('reports the no-binding stub executor as driver none', async () => {
    const executor = unboundExecutor();
    expect(executor.driver).toBe('none');
    await expect(executor.all({ sql: 'SELECT 1', params: [] })).rejects.toThrow('no DB binding');
    await expect(executor.batch([])).rejects.toThrow('no DB binding');
  });

  it('answers an unexpected kernel rejection with the error envelope', async () => {
    vi.resetModules();
    vi.doMock('@package-broker/core/kernel/kernel', () => ({
      createKernel: () =>
        Promise.resolve({
          fetch: () => Promise.reject(new Error('kernel exploded')),
          registration: { routes: [], hooks: { 'access.check': [] }, bindings: new Map() },
        }),
    }));
    try {
      const { createWorker: createWorkerWithFailingKernel } = await import('./index.js');
      const response = await createWorkerWithFailingKernel([], { log: () => undefined }).fetch(
        new Request('https://broker.invalid/anything'),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('internal');
      expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
    } finally {
      vi.doUnmock('@package-broker/core/kernel/kernel');
      vi.resetModules();
    }
  });

  it('resolves the same services from the assembled application on every call', async () => {
    const worker = createWorker([]);
    const first = await worker.services();
    expect(await worker.services()).toBe(first);
    expect(await first.providerAnchors.anchors({ orgId: 'org' } as never)).toEqual([]);
  });

  it('runs work dispatched outside a request and logs that nothing keeps it alive', async () => {
    const log = vi.fn();
    const services = await createWorker([], { log }).services();
    let ran = false;
    services.dispatch(() => {
      ran = true;
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(true);
    expect(log).toHaveBeenCalledWith({ level: 'warn', event: 'deferred.untracked' });
  });

  it('binds dispatched work to the request that dispatched it, not the latest one', async () => {
    const gates = new Map<string, () => void>();
    const opened = new Map<string, Promise<void>>();
    for (const path of ['/a', '/b']) {
      opened.set(
        path,
        new Promise<void>((resolve) => {
          gates.set(path, resolve);
        }),
      );
    }
    let finishA = (): void => undefined;
    const workA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    const shared: { dispatch?: (run: () => Promise<void>) => void } = {};
    vi.resetModules();
    vi.doMock('@package-broker/core/kernel/kernel', () => ({
      createKernel: () =>
        Promise.resolve({
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            await opened.get(path);
            if (path === '/a') shared.dispatch?.(() => workA);
            return new Response(path);
          },
        }),
    }));
    try {
      const { createWorker: createGatedWorker } = await import('./index.js');
      const worker = createGatedWorker([], { log: () => undefined });
      shared.dispatch = (await worker.services()).dispatch;
      const waitA = vi.fn<(promise: Promise<unknown>) => void>();
      const waitB = vi.fn<(promise: Promise<unknown>) => void>();
      const a = worker.fetch(new Request('https://broker.invalid/a'), undefined, {
        waitUntil: waitA,
      });
      const b = worker.fetch(new Request('https://broker.invalid/b'), undefined, {
        waitUntil: waitB,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      gates.get('/a')?.();
      expect(await (await a).text()).toBe('/a');
      const keptA = waitA.mock.calls[0]?.[0] as Promise<unknown>;
      let settledA = false;
      void keptA.then(() => {
        settledA = true;
      });

      gates.get('/b')?.();
      expect(await (await b).text()).toBe('/b');
      const keptB = waitB.mock.calls[0]?.[0] as Promise<unknown>;
      await expect(keptB).resolves.toBeUndefined();
      expect(settledA).toBe(false);

      finishA();
      await keptA;
      expect(settledA).toBe(true);
    } finally {
      vi.doUnmock('@package-broker/core/kernel/kernel');
      vi.resetModules();
    }
  });

  it('reports work a request dispatches after its context settled as untracked', async () => {
    const shared: { dispatch?: (run: () => Promise<void>) => void } = {};
    let dispatchedLate = (): void => undefined;
    const late = new Promise<void>((resolve) => {
      dispatchedLate = resolve;
    });
    vi.resetModules();
    vi.doMock('@package-broker/core/kernel/kernel', () => ({
      createKernel: () =>
        Promise.resolve({
          fetch: () => {
            setTimeout(() => {
              shared.dispatch?.(() => Promise.resolve());
              dispatchedLate();
            }, 20);
            return Promise.resolve(new Response('ok'));
          },
        }),
    }));
    try {
      const { createWorker: createLateWorker } = await import('./index.js');
      const log = vi.fn();
      const worker = createLateWorker([], { log });
      shared.dispatch = (await worker.services()).dispatch;
      const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
      await worker.fetch(new Request('https://broker.invalid/'), undefined, { waitUntil });
      await waitUntil.mock.calls[0]?.[0];
      expect(log).not.toHaveBeenCalled();
      await late;
      expect(log).toHaveBeenCalledWith({ level: 'warn', event: 'deferred.untracked' });
    } finally {
      vi.doUnmock('@package-broker/core/kernel/kernel');
      vi.resetModules();
    }
  });

  it('does not hold a request open for work dispatched after it ended', async () => {
    const worker = createWorker([]);
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await worker.fetch(new Request('https://broker.invalid/nope'), undefined, { waitUntil });
    const services = await worker.services();
    services.dispatch(() => new Promise<void>(() => undefined));
    const kept = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await expect(kept).resolves.toBeUndefined();
  });
});

const KEY_V1 = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const STANZA: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 * 1024 },
  cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: {
    adapter: 'workers',
    analyticsBinding: 'ANALYTICS',
    deploymentIdEnv: 'DEPLOYMENT_ID',
    endpointEnv: 'PB_OTLP_ENDPOINT',
  },
};

function fakeD1(): D1DatabaseLike {
  const verifier = new Map<number, string>();
  type Recorded = D1PreparedStatementLike & { sql: string; values: unknown[] };
  const make = (sql: string, values: unknown[]): Recorded => ({
    sql,
    values,
    bind: (...next) => make(sql, next),
    all: () => Promise.resolve(run(sql, values)),
  });
  const run = (
    sql: string,
    values: unknown[],
  ): { results: unknown[]; meta?: { changes: number } } => {
    const insert = /^\s*insert into keyring_verifier .*X'([0-9a-f]{64})'/is.exec(sql);
    if (insert !== null) {
      const version = values[0] as number;
      const only = /where not exists/i.test(sql);
      if ((only && verifier.size > 0) || verifier.has(version)) {
        return { results: [], meta: { changes: 0 } };
      }
      verifier.set(version, (insert[1] as string).toUpperCase());
      return { results: [], meta: { changes: 1 } };
    }
    if (/from "keyring_verifier"/i.test(sql)) {
      return {
        results: [...verifier]
          .sort(([left], [right]) => right - left)
          .map(([key_version, mac_hex]) => ({ key_version, mac_hex })),
      };
    }
    return { results: [] };
  };
  return {
    prepare: (sql) => make(sql, []),
    batch: (statements) =>
      Promise.resolve(
        (statements as Recorded[]).map((statement) => run(statement.sql, statement.values)),
      ),
  };
}

function fakeBucket(): R2BucketLike {
  return {
    head: () => Promise.resolve(null),
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
  } as unknown as R2BucketLike;
}

function fakeQueue(): QueueLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    send: (body) => {
      sent.push(body);
      return Promise.resolve();
    },
    sendBatch: (messages) => {
      sent.push(...messages.map((message) => message.body));
      return Promise.resolve();
    },
  };
}

function fakeAnalytics(): AnalyticsEngineLike & { points: unknown[] } {
  const points: unknown[] = [];
  return { points, writeDataPoint: (point) => void points.push(point) };
}

function fakeCaches(): CacheStorageLike {
  return {
    open: () =>
      Promise.resolve({
        match: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      }),
  };
}

function boundEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: fakeD1(),
    STORAGE: fakeBucket(),
    JOBS: fakeQueue(),
    ANALYTICS: fakeAnalytics(),
    DEPLOYMENT_ID: 'test-deployment',
    PB_MASTER_KEY: KEY_V1,
    PB_PUBLIC_URL: 'https://broker.test',
    PB_OTLP_ENDPOINT: 'https://collector.test',
    ...overrides,
  } as Env;
}

function probe(onInit: (ports: PluginPorts) => void | Promise<void> = () => undefined) {
  return definePlugin({
    id: 'probe',
    package: 'test/probe',
    platforms: ['cloudflare'],
    apiVersion: 3,
    init: onInit,
  });
}

const quiet = { log: () => undefined, console: { log: () => undefined, error: () => undefined } };

function otlpFetch() {
  const calls: string[] = [];
  const impl = (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { calls, impl };
}

function context() {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (promise: Promise<unknown>) => void promises.push(promise) };
}

describe('runtime-cloudflare platform assembly', () => {
  it('uses the auth client-address rule for management API metadata', async () => {
    let resolve: ((request: Request) => string | null) | undefined;
    vi.resetModules();
    vi.doMock('@package-broker/core/api/module', async (original) => {
      const actual = await original<typeof import('@package-broker/core/api/module')>();
      return {
        ...actual,
        createApiModule: (...args: Parameters<typeof actual.createApiModule>) => {
          resolve = args[0].organization.clientIp;
          return actual.createApiModule(...args);
        },
      };
    });
    try {
      const { createWorker: createCapturedWorker } = await import('./index.js');
      await createCapturedWorker([], quiet).services(boundEnv());
      expect(resolve).toBeTypeOf('function');
      for (const [address, expected] of [
        ['2001:db8::1', '2001:db8::1'],
        ['203.0.113.7', '203.0.113.7'],
        [':', null],
        ['a'.repeat(64), null],
      ] as const) {
        expect(
          resolve!(
            new Request('https://broker.test/_pb/me', {
              headers: { 'cf-connecting-ip': address },
            }),
          ),
        ).toBe(expected);
      }
    } finally {
      vi.doUnmock('@package-broker/core/api/module');
      vi.resetModules();
    }
  });

  it('hands the kernel all four services when the cloudflare stanza is bound', async () => {
    let seen: PluginPorts | undefined;
    const worker = createWorker([probe((ports) => void (seen = ports))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const response = await worker.fetch(new Request('https://broker.test/nope'), boundEnv());
    expect(response.status).toBe(404);
    const platform = requirePlatformPorts(seen as PluginPorts);
    expect(typeof platform.blob.put).toBe('function');
    expect(typeof platform.cache.get).toBe('function');
    expect(typeof platform.jobs.enqueue).toBe('function');
    expect(typeof platform.observability.log).toBe('function');
  });

  it('keeps platform services disabled without a stanza', async () => {
    let seen: PluginPorts | undefined;
    const worker = createWorker([probe((ports) => void (seen = ports))], quiet);
    await worker.fetch(new Request('https://broker.test/nope'), boundEnv());
    expect(seen?.platform).toBeUndefined();
  });

  it('runs queue and scheduled events through the application the fetch built', async () => {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);
    const acked: number[] = [];
    const message = {
      body: { v: 1, org: '01J0WWWWWWWWWWWWWWWWWW0001', job: '01J0WWWWWWWWWWWWWWWWWW0002' },
      ack: () => void acked.push(1),
      retry: () => undefined,
    };
    await worker.queue({ messages: [message] }, { ...env });
    await worker.scheduled({ cron: '* * * * *' }, { ...env });
    expect(inits).toBe(1);
    expect(acked).toEqual([1]);
    expect((env.JOBS as unknown as { sent: unknown[] }).sent).toEqual([]);
  });

  it('rejects enqueue of a job type nobody registered', async () => {
    let seen: PluginPorts | undefined;
    const worker = createWorker([probe((ports) => void (seen = ports))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);
    const { jobs } = requirePlatformPorts(seen as PluginPorts);
    await expect(
      jobs.enqueue(
        orgContext('01J0WWWWWWWWWWWWWWWWWW0001'),
        'probe:missing:v1',
        {},
        {
          idempotencyKey: 'k',
        },
      ),
    ).rejects.toMatchObject({ name: 'JobError', code: 'unknown_job_type' });
    expect((env.JOBS as unknown as { sent: unknown[] }).sent).toEqual([]);
  });

  it('builds distinct kernels for envs sharing DB but differing in STORAGE, JOBS or DEPLOYMENT_ID', async () => {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const base = boundEnv();
    const request = () => new Request('https://broker.test/nope');
    await worker.fetch(request(), base);
    await worker.fetch(request(), { ...base, STORAGE: fakeBucket() });
    await worker.fetch(request(), { ...base, JOBS: fakeQueue() });
    await worker.fetch(request(), { ...base, DEPLOYMENT_ID: 'other-deployment' });
    expect(inits).toBe(4);
  });

  it('reuses the kernel for a new env object carrying the same bindings', async () => {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const base = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), base);
    await worker.fetch(new Request('https://broker.test/nope'), { ...base });
    expect(inits).toBe(1);
  });

  it('shares one pending initialization between concurrent cold requests', async () => {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const base = boundEnv();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        worker.fetch(new Request('https://broker.test/nope'), { ...base }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(inits).toBe(1);
  });

  it('evicts a rejected initialization so the next request rebuilds', async () => {
    let inits = 0;
    const worker = createWorker(
      [
        probe(() => {
          inits += 1;
          if (inits === 1) throw new Error('first init fails');
        }),
      ],
      { ...quiet, platformPorts: STANZA, cacheStorage: fakeCaches(), otlpFetch: otlpFetch().impl },
    );
    const base = boundEnv();
    const first = await worker.fetch(new Request('https://broker.test/nope'), base);
    expect(first.status).toBe(500);
    const second = await worker.fetch(new Request('https://broker.test/nope'), base);
    expect(second.status).toBe(404);
    expect(inits).toBe(2);
  });

  it.each([
    ['STORAGE', { STORAGE: undefined }],
    ['JOBS', { JOBS: undefined }],
    ['ANALYTICS', { ANALYTICS: undefined }],
    ['DEPLOYMENT_ID', { DEPLOYMENT_ID: undefined }],
    ['a malformed DEPLOYMENT_ID', { DEPLOYMENT_ID: 'not a deployment id' }],
    ['DB', { DB: undefined }],
    ['the OTLP endpoint variable', { PB_OTLP_ENDPOINT: undefined }],
    ['a STORAGE string instead of a bucket', { STORAGE: 'bucket' }],
  ])('answers 503 misconfigured when %s is missing', async (_name, overrides) => {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const response = await worker.fetch(
      new Request('https://broker.test/nope'),
      boundEnv(overrides),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('misconfigured');
    expect(inits).toBe(0);
  });

  it('answers 503 misconfigured when the Cache API is unavailable', async () => {
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: null,
      otlpFetch: otlpFetch().impl,
    });
    const response = await worker.fetch(new Request('https://broker.test/nope'), boundEnv());
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'misconfigured',
    );
  });

  it('returns without throwing from queue and scheduled when bindings are missing', async () => {
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv({ JOBS: undefined });
    await expect(worker.queue({ messages: [] }, env)).resolves.toBeUndefined();
    await expect(worker.scheduled({}, env)).resolves.toBeUndefined();
  });

  it.each([undefined, 'debug', 'info', 'warn', 'error'] as const)(
    'exports completion spans independently of log level %s',
    async (level) => {
      const calls: Array<{ url: string; body: string }> = [];
      const worker = createWorker([], {
        ...quiet,
        platformPorts: STANZA,
        cacheStorage: fakeCaches(),
        observability: level === undefined ? {} : { level },
        otlpFetch: async (input, init) => {
          calls.push({ url: String(input), body: String(init?.body) });
          return new Response('{}');
        },
      });
      const ctx = context();
      const env = boundEnv();
      expect(
        (await worker.fetch(new Request('https://broker.test/health/live'), env, ctx)).status,
      ).toBe(200);
      await Promise.all(ctx.promises);

      const traces = calls.filter((call) => call.url.endsWith('/v1/traces'));
      expect(traces).toHaveLength(1);
      const body = JSON.parse(traces[0]!.body) as {
        resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
      };
      expect(
        body.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
        ),
      ).toEqual(['GET /health/live']);
      const logs = calls
        .filter((call) => call.url.endsWith('/v1/logs'))
        .map((call) => call.body)
        .join('');
      expect(logs.includes('/health/live')).toBe(level === 'debug');
    },
  );

  it('defers the OTLP export to waitUntil and never flushes eagerly', async () => {
    const otlp = otlpFetch();
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlp.impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);
    expect(otlp.calls).toEqual([]);

    const ctx = context();
    const response = await worker.fetch(new Request('https://broker.test/nope'), env, ctx);
    expect(response.status).toBe(404);
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);
    expect(otlp.calls).toContain('https://collector.test/v1/logs');
    expect(otlp.calls).toContain('https://collector.test/v1/traces');
  });

  it('writes metric points to Analytics Engine and drops pb.http lines without it', async () => {
    const lines: unknown[] = [];
    const stanza: PlatformPortConfig = {
      ...STANZA,
      observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
    };
    const worker = createWorker([], {
      log: () => undefined,
      console: { log: (value) => void lines.push(value), error: (value) => void lines.push(value) },
      platformPorts: stanza,
      cacheStorage: fakeCaches(),
    });
    await worker.fetch(new Request('https://broker.test/nope'), boundEnv({ ANALYTICS: undefined }));
    const names = lines.map((line) => (line as { name?: string; event?: string }).name);
    expect(names.some((name) => typeof name === 'string' && name.startsWith('pb.http.'))).toBe(
      false,
    );
    expect(lines.some((line) => (line as { event?: string }).event === 'http.request')).toBe(true);

    const analytics = fakeAnalytics();
    const withAnalytics = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    await withAnalytics.fetch(
      new Request('https://broker.test/nope'),
      boundEnv({ ANALYTICS: analytics }),
    );
    expect(analytics.points.length).toBeGreaterThan(0);
  });
});

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['IDB0'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const requireFromHere = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(requireFromHere.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migratedDatabase(): Promise<{ db: D1DatabaseLike; orgId: string }> {
  const db = (await mf.getD1Database('IDB0')) as unknown as D1DatabaseLike;
  const sources: MigrationSource[] = await Promise.all(
    ['0001_init.sql'].map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
  await migrate(createD1Executor(db), sources, { holder: 'index-test' });
  const orgId = ulid();
  await createOrganizationBootstrap(createD1Executor(db)).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  return { db, orgId };
}

describe('runtime-cloudflare inbound traceparent', () => {
  const TRACE_ID = 'ab'.repeat(16);
  const TRACEPARENT = `00-${TRACE_ID}-${'cd'.repeat(8)}-01`;

  async function traceIds(observability: WorkerOptions['observability']): Promise<unknown[]> {
    const lines: unknown[] = [];
    const worker = createWorker([], {
      log: () => undefined,
      console: { log: (value) => void lines.push(value), error: (value) => void lines.push(value) },
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
      ...(observability === undefined ? {} : { observability }),
    });
    await worker.fetch(
      new Request('https://broker.test/nope', { headers: { traceparent: TRACEPARENT } }),
      boundEnv(),
    );
    const ids = lines
      .filter((line) => (line as { event?: string }).event === 'http.request')
      .map((line) => (line as { trace_id?: string }).trace_id);
    expect(ids.length).toBeGreaterThan(0);
    return ids;
  }

  it('ignores the header by default', async () => {
    for (const id of await traceIds(undefined)) expect(id).not.toBe(TRACE_ID);
  });

  it('ignores the header when the flag is false', async () => {
    for (const id of await traceIds({ trustInboundTraceparent: false })) {
      expect(id).not.toBe(TRACE_ID);
    }
  });

  it('adopts the header trace id when the flag is true', async () => {
    for (const id of await traceIds({ trustInboundTraceparent: true })) {
      expect(id).toBe(TRACE_ID);
    }
  });

  it('answers 503 misconfigured on a non-boolean flag without echoing it', async () => {
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
      observability: {
        trustInboundTraceparent: 'yes-secret',
      } as unknown as WorkerOptions['observability'],
    });
    const response = await worker.fetch(new Request('https://broker.test/nope'), boundEnv());
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe('misconfigured');
    expect(text).not.toContain('yes-secret');
  });

  it('answers 503 misconfigured on an unknown observability key', async () => {
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
      observability: { sampleRate: true } as unknown as WorkerOptions['observability'],
    });
    const response = await worker.fetch(new Request('https://broker.test/nope'), boundEnv());
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'misconfigured',
    );
  });
});

describe('runtime-cloudflare job path', () => {
  it('commits to D1, notifies the queue and gives runner events job_id and attempt', async () => {
    let ports: PluginPorts | undefined;
    const plugin = definePlugin({
      id: 'probe',
      package: 'test/probe',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.job({
          name: 'work',
          version: 1,
          validate: (input) => input,
          handler: () => Promise.reject(new Error('handler exploded')),
        });
      },
      init(initPorts) {
        ports = initPorts;
      },
    });
    const lines: unknown[] = [];
    const worker = createWorker([plugin], {
      log: () => undefined,
      console: { log: (value) => void lines.push(value), error: (value) => void lines.push(value) },
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const { db, orgId } = await migratedDatabase();
    const env = boundEnv({ DB: db });
    await worker.fetch(new Request('https://broker.test/nope'), env);

    const queued = await requirePlatformPorts(ports as PluginPorts).jobs.enqueue(
      orgContext(orgId),
      'probe:work:v1',
      { n: 1 },
      { idempotencyKey: 'once' },
    );
    expect(queued.created).toBe(true);
    const sent = (env.JOBS as unknown as { sent: { job: string }[] }).sent;
    expect(sent).toHaveLength(1);

    const acked: number[] = [];
    await worker.queue(
      { messages: [{ body: sent[0], ack: () => void acked.push(1), retry: () => undefined }] },
      { ...env },
    );
    expect(acked).toEqual([1]);

    const failure = lines
      .map((line) =>
        typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : line,
      )
      .find((line) => (line as { event?: string }).event === 'job.handler_failed') as
      { job_id?: string; attempt?: number } | undefined;
    expect(failure?.job_id).toBe(queued.id);
    expect(failure?.attempt).toBe(1);
  });
});

function recordingLog() {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    log: (entry: Readonly<Record<string, unknown>>) => void entries.push({ ...entry }),
  };
}

function messageProbe(body: unknown) {
  const calls = { ack: 0, retry: [] as unknown[] };
  return {
    calls,
    message: {
      body,
      ack: () => void (calls.ack += 1),
      retry: (options?: unknown) => void calls.retry.push(options),
    },
  };
}

describe('runtime-cloudflare event delivery', () => {
  it('retries every message and acks none when the organization lookup fails', async () => {
    const lines: unknown[] = [];
    const record = (value: unknown) => void lines.push(value);
    const worker = createWorker([], {
      log: () => undefined,
      console: { log: record, error: record },
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    let failing = false;
    const healthy = fakeD1();
    const db: D1DatabaseLike = {
      prepare: (sql) => {
        if (failing) throw new Error('database unavailable');
        return healthy.prepare(sql);
      },
      batch: (statements) => healthy.batch(statements),
    };
    const env = boundEnv({ DB: db });
    await worker.fetch(new Request('https://broker.test/nope'), env);
    failing = true;
    const first = messageProbe({ v: 1, org: ulid(), job: ulid() });
    const second = messageProbe({ v: 1, org: ulid(), job: ulid() });
    await worker.queue({ messages: [first.message, second.message] }, { ...env });
    for (const probeCalls of [first.calls, second.calls]) {
      expect(probeCalls.ack).toBe(0);
      expect(probeCalls.retry).toEqual([{ delaySeconds: 30 }]);
    }
    const events = lines.map((line) =>
      typeof line === 'string'
        ? (JSON.parse(line) as { event?: string }).event
        : (line as { event?: string }).event,
    );
    expect(events).toContain('job.batch_failed');
    expect(events).not.toContain('http.error');
  });

  it('retries every message and acks none when the application cannot be built', async () => {
    const { entries, log } = recordingLog();
    const worker = createWorker([], {
      ...quiet,
      log,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const first = messageProbe({ v: 1, org: ulid(), job: ulid() });
    const second = messageProbe({ v: 1, org: ulid(), job: ulid() });
    second.message.retry = () => {
      throw new Error('retry rejected');
    };
    await worker.queue(
      { messages: [first.message, second.message] },
      boundEnv({ JOBS: undefined }),
    );
    expect(first.calls.ack).toBe(0);
    expect(first.calls.retry).toEqual([{ delaySeconds: 30 }]);
    expect(second.calls.ack).toBe(0);
    expect(entries.some((entry) => entry.event === 'job.batch_failed')).toBe(true);
    expect(entries.some((entry) => entry.event === 'job.retry_failed')).toBe(true);
    expect(entries.some((entry) => entry.event === 'http.error')).toBe(false);
  });

  it('logs job.cron_failed when the scheduled event cannot build the application', async () => {
    const { entries, log } = recordingLog();
    const worker = createWorker([], {
      ...quiet,
      log,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    await worker.scheduled({ cron: '* * * * *' }, boundEnv({ JOBS: undefined }));
    expect(entries.some((entry) => entry.event === 'job.cron_failed')).toBe(true);
    expect(entries.some((entry) => entry.event === 'http.error')).toBe(false);
  });

  it('rejects a foreign-org notification on a bootstrapped deployment without running the consumer', async () => {
    let ports: PluginPorts | undefined;
    let ran = 0;
    const plugin = definePlugin({
      id: 'probe',
      package: 'test/probe',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.job({
          name: 'work',
          version: 1,
          validate: (input) => input,
          handler: () => {
            ran += 1;
            return Promise.resolve();
          },
        });
      },
      init(initPorts) {
        ports = initPorts;
      },
    });
    const worker = createWorker([plugin], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const { db } = await migratedDatabase();
    const bootstrapped = await createOrganizationBootstrap(createD1Executor(db)).findSingleton();
    const env = boundEnv({ DB: db });
    await worker.fetch(new Request('https://broker.test/nope'), env);
    await requirePlatformPorts(ports as PluginPorts).jobs.enqueue(
      orgContext((bootstrapped as { id: string }).id),
      'probe:work:v1',
      {},
      { idempotencyKey: 'foreign' },
    );
    const sent = (env.JOBS as unknown as { sent: { org: string; job: string }[] }).sent;
    const foreign = messageProbe({ ...sent[0], org: ulid() });
    await worker.queue({ messages: [foreign.message] }, { ...env });
    expect(foreign.calls.ack).toBe(1);
    expect(foreign.calls.retry).toEqual([]);
    expect(ran).toBe(0);

    const own = messageProbe(sent[0]);
    await worker.queue({ messages: [own.message] }, { ...env });
    expect(own.calls.ack).toBe(1);
    expect(ran).toBe(1);
  });
});

describe('runtime-cloudflare application cache', () => {
  function counting() {
    let inits = 0;
    const worker = createWorker([probe(() => void (inits += 1))], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    return {
      worker,
      inits: () => inits,
      hit: (env: Env) => worker.fetch(new Request('https://broker.test/nope'), env),
    };
  }

  it('builds distinct kernels for envs differing only in PB_PUBLIC_URL', async () => {
    const { hit, inits } = counting();
    const base = boundEnv();
    await hit(base);
    await hit({ ...base });
    expect(inits()).toBe(1);
    await hit({ ...base, PB_PUBLIC_URL: 'https://other.test' } as Env);
    expect(inits()).toBe(2);
  });

  it('evicts the least recently used application, not the oldest inserted', async () => {
    const { hit, inits } = counting();
    const base = boundEnv();
    const keyed = (index: number): Env => ({ ...base, DEPLOYMENT_ID: `deployment-${index}` });
    for (let index = 0; index < 8; index += 1) await hit(keyed(index));
    expect(inits()).toBe(8);
    await hit(keyed(0));
    expect(inits()).toBe(8);
    await hit(keyed(8));
    expect(inits()).toBe(9);
    await hit(keyed(0));
    expect(inits()).toBe(9);
    await hit(keyed(1));
    expect(inits()).toBe(10);
  });

  it('logs the names of failed bindings once per failed build and keeps them out of the 503 body', async () => {
    const { entries, log } = recordingLog();
    const worker = createWorker([], {
      ...quiet,
      log,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv({ JOBS: undefined, PB_OTLP_ENDPOINT: undefined });
    const response = await worker.fetch(new Request('https://broker.test/nope'), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/STORAGE|JOBS|DEPLOYMENT_ID|PB_OTLP/);
    const logged = entries.filter((entry) => entry.event === 'startup.misconfigured');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.problems).toEqual([
      'jobs.binding: JOBS is not bound',
      'observability.endpointEnv: PB_OTLP_ENDPOINT is not set',
    ]);
    expect(JSON.stringify(entries)).not.toContain(KEY_V1);
  });
});

function within(promise: Promise<unknown>, ms = 300): Promise<'settled' | 'hung'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms)),
  ]);
}

function heldPuts() {
  const releases: (() => void)[] = [];
  let hold = false;
  const caches: CacheStorageLike = {
    open: () =>
      Promise.resolve({
        match: () => Promise.resolve(undefined),
        put: () =>
          hold ? new Promise<void>((resolve) => void releases.push(resolve)) : Promise.resolve(),
        delete: () => Promise.resolve(false),
      }),
  };
  return {
    caches,
    releases,
    hold: (value: boolean) => void (hold = value),
  };
}

const CACHE_KEY = {
  projectId: 'p',
  sourceId: 's',
  kind: 'metadata',
  digest: 'a'.repeat(64),
} as const;

function cacheEntry() {
  const later = new Date(Date.now() + 300_000).toISOString();
  return {
    value: new Uint8Array([1]),
    freshUntil: later,
    staleUntil: later,
    negative: false,
    insertedAt: new Date().toISOString(),
  };
}

function cachePlugin(onInit: (ports: PluginPorts) => void) {
  let ports: PluginPorts | undefined;
  return definePlugin({
    id: 'putter',
    package: 'test/putter',
    platforms: ['cloudflare'],
    apiVersion: 3,
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/put',
        permission: null,
        needsOrg: false,
        handler: async () => {
          await requirePlatformPorts(ports as PluginPorts).cache.set(
            orgContext('o'),
            CACHE_KEY,
            cacheEntry(),
          );
          return Response.json({ ok: true });
        },
      });
      registry.route({
        method: 'GET',
        path: '/none',
        permission: null,
        needsOrg: false,
        handler: () => Response.json({ ok: true }),
      });
    },
    init(initPorts) {
      ports = initPorts;
      onInit(initPorts);
    },
  });
}

describe('runtime-cloudflare deferred work per request', () => {
  it('lets a request settle without waiting for another request flush', async () => {
    const releases: (() => void)[] = [];
    let hold = false;
    const impl = (): Promise<Response> =>
      hold
        ? new Promise((resolve) => {
            releases.push(() => resolve(new Response('{}', { status: 200 })));
          })
        : Promise.resolve(new Response('{}', { status: 200 }));
    const worker = createWorker([], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);

    hold = true;
    const slow = context();
    await worker.fetch(new Request('https://broker.test/nope'), { ...env }, slow);
    expect(releases.length).toBeGreaterThan(0);
    hold = false;
    const quick = context();
    await worker.fetch(new Request('https://broker.test/nope'), { ...env }, quick);

    expect(await within(Promise.all(quick.promises))).toBe('settled');
    expect(await within(Promise.all(slow.promises), 50)).toBe('hung');
    for (const release of releases) release();
    expect(await within(Promise.all(slow.promises))).toBe('settled');
  });

  it('keeps a held cache put with the request that created it', async () => {
    const puts = heldPuts();
    const worker = createWorker([cachePlugin(() => undefined)], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: puts.caches,
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/none'), env);

    puts.hold(true);
    const first = context();
    expect(
      (await worker.fetch(new Request('https://broker.test/put'), { ...env }, first)).status,
    ).toBe(200);
    puts.hold(false);
    const second = context();
    await worker.fetch(new Request('https://broker.test/none'), { ...env }, second);

    expect(await within(Promise.all(second.promises))).toBe('settled');
    expect(await within(Promise.all(first.promises), 50)).toBe('hung');
    for (const release of puts.releases) release();
    expect(await within(Promise.all(first.promises))).toBe('settled');
  });

  it('logs a cache put with no live request once, without key or value', async () => {
    const lines: unknown[] = [];
    const record = (value: unknown) => void lines.push(value);
    let seen: PluginPorts | undefined;
    const worker = createWorker([cachePlugin((ports) => void (seen = ports))], {
      log: () => undefined,
      console: { log: record, error: record },
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    await worker.fetch(new Request('https://broker.test/none'), boundEnv());
    const { cache } = requirePlatformPorts(seen as PluginPorts);
    await cache.set(orgContext('o'), CACHE_KEY, cacheEntry());
    await cache.set(orgContext('o'), CACHE_KEY, cacheEntry());
    const untracked = lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .filter((line) => line.includes('cache.put_untracked'));
    expect(untracked).toHaveLength(1);
    expect(untracked[0]).not.toContain('a'.repeat(64));
  });
});

describe('runtime-cloudflare event delivery without a stanza', () => {
  it('retries every message instead of returning silently', async () => {
    const worker = createWorker([], quiet);
    const first = messageProbe({ v: 1 });
    const second = messageProbe({ v: 1 });
    await worker.queue({ messages: [first.message, second.message] }, boundEnv());
    for (const calls of [first.calls, second.calls]) {
      expect(calls.ack).toBe(0);
      expect(calls.retry).toEqual([{ delaySeconds: 30 }]);
    }
  });
});

describe('runtime-cloudflare fingerprint memo', () => {
  it('computes the configuration digest once for one env object', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      const worker = createWorker([], {
        ...quiet,
        platformPorts: STANZA,
        cacheStorage: fakeCaches(),
        otlpFetch: otlpFetch().impl,
      });
      const env = boundEnv();
      await worker.fetch(new Request('https://broker.test/nope'), env);
      const afterFirst = digest.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await worker.fetch(new Request('https://broker.test/nope'), env);
      await worker.fetch(new Request('https://broker.test/nope'), env);
      expect(digest.mock.calls.length).toBe(afterFirst);
    } finally {
      digest.mockRestore();
    }
  });
});

describe('runtime-cloudflare handler failure reporting', () => {
  it('reports a queue handler failure through the application observability', async () => {
    const lines: unknown[] = [];
    const record = (value: unknown) => void lines.push(value);
    const logged: unknown[] = [];
    const worker = createWorker([], {
      log: (entry) => void logged.push(entry),
      console: { log: record, error: record },
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);
    const poisoned = {
      messages: new Proxy([], {
        get(target, key, receiver) {
          if (key === Symbol.iterator) throw new Error('batch exploded');
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    };
    await worker.queue(poisoned, { ...env });
    const events = lines.map((line) =>
      typeof line === 'string'
        ? (JSON.parse(line) as { event?: string }).event
        : (line as { event?: string }).event,
    );
    expect(events).toContain('job.batch_failed');
    expect(logged.some((entry) => (entry as { event?: string }).event === 'job.batch_failed')).toBe(
      false,
    );
  });
});

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function consoleLines() {
  const lines: string[] = [];
  const record = (value: unknown) =>
    void lines.push(typeof value === 'string' ? value : JSON.stringify(value));
  return { lines, console: { log: record, error: record } };
}

describe('runtime-cloudflare request scope', () => {
  it('keeps a cache put with the request that started it while another request is live', async () => {
    const puts = heldPuts();
    const gate = deferred();
    const holdGate = deferred();
    let ports: PluginPorts | undefined;
    const plugin = definePlugin({
      id: 'slow',
      package: 'test/slow',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/slow',
          permission: null,
          needsOrg: false,
          handler: async () => {
            await gate.promise;
            await requirePlatformPorts(ports as PluginPorts).cache.set(
              orgContext('o'),
              CACHE_KEY,
              cacheEntry(),
            );
            return Response.json({ ok: true });
          },
        });
        registry.route({
          method: 'GET',
          path: '/hold',
          permission: null,
          needsOrg: false,
          handler: async () => {
            await holdGate.promise;
            return Response.json({ ok: true });
          },
        });
        registry.route({
          method: 'GET',
          path: '/none',
          permission: null,
          needsOrg: false,
          handler: () => Response.json({ ok: true }),
        });
      },
      init(initPorts) {
        ports = initPorts;
      },
    });
    const worker = createWorker([plugin], {
      ...quiet,
      platformPorts: STANZA,
      cacheStorage: puts.caches,
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/none'), env);

    puts.hold(true);
    const a = context();
    const b = context();
    const slow = worker.fetch(new Request('https://broker.test/slow'), { ...env }, a);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const held = worker.fetch(new Request('https://broker.test/hold'), { ...env }, b);
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.resolve();
    expect((await slow).status).toBe(200);
    holdGate.resolve();
    expect((await held).status).toBe(200);

    expect(await within(Promise.all(b.promises))).toBe('settled');
    expect(await within(Promise.all(a.promises), 50)).toBe('hung');
    for (const release of puts.releases) release();
    expect(await within(Promise.all(a.promises))).toBe('settled');
  });

  it('keeps waiting for dispatched work when the telemetry flush rejects', async () => {
    vi.resetModules();
    vi.doMock('@package-broker/core/platform/otlp', async (original) => {
      const actual = await original<typeof import('@package-broker/core/platform/otlp')>();
      return {
        ...actual,
        createOtlpExporter: (...args: Parameters<typeof actual.createOtlpExporter>) => ({
          ...actual.createOtlpExporter(...args),
          flush: () => Promise.reject(new Error('flush rejected')),
        }),
      };
    });
    try {
      const { createWorker: createFlushingWorker } = await import('./index.js');
      const work = deferred();
      const shared: { dispatch?: (run: () => Promise<void>) => void } = {};
      const plugin = definePlugin({
        id: 'dispatcher',
        package: 'test/dispatcher',
        platforms: ['cloudflare'],
        apiVersion: 3,
        register(registry) {
          registry.route({
            method: 'GET',
            path: '/go',
            permission: null,
            needsOrg: false,
            handler: () => {
              shared.dispatch?.(() => work.promise);
              return Response.json({ ok: true });
            },
          });
        },
      });
      const worker = createFlushingWorker([plugin], {
        ...quiet,
        platformPorts: STANZA,
        cacheStorage: fakeCaches(),
        otlpFetch: otlpFetch().impl,
      });
      const env = boundEnv();
      shared.dispatch = (await worker.services(env)).dispatch;
      const ctx = context();
      await worker.fetch(new Request('https://broker.test/go'), env, ctx);
      const kept = Promise.all(ctx.promises);
      expect(await within(kept, 50)).toBe('hung');
      work.resolve();
      await expect(kept).resolves.toBeDefined();
    } finally {
      vi.doUnmock('@package-broker/core/platform/otlp');
      vi.resetModules();
    }
  });

  it('closes the dispatch scope of a request that has no execution context', async () => {
    const shared: { dispatch?: (run: () => Promise<void>) => void } = {};
    const late = deferred();
    const log = vi.fn();
    const plugin = definePlugin({
      id: 'late',
      package: 'test/late',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/go',
          permission: null,
          needsOrg: false,
          handler: () => {
            setTimeout(() => {
              shared.dispatch?.(() => Promise.resolve());
              late.resolve();
            }, 30);
            return Response.json({ ok: true });
          },
        });
      },
    });
    const worker = createWorker([plugin], { log, console: quiet.console });
    shared.dispatch = (await worker.services()).dispatch;
    await worker.fetch(new Request('https://broker.test/go'));
    await late.promise;
    expect(log).toHaveBeenCalledWith({ level: 'warn', event: 'deferred.untracked' });
  });

  it('logs untracked dispatches once, through the platform observability path', async () => {
    const out = consoleLines();
    const worker = createWorker([], {
      log: () => undefined,
      console: out.console,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const env = boundEnv();
    await worker.fetch(new Request('https://broker.test/nope'), env);
    const services = await worker.services(env);
    services.dispatch(() => Promise.resolve());
    services.dispatch(() => Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(out.lines.filter((line) => line.includes('deferred.untracked'))).toHaveLength(1);
  });

  it('runs a queue event in its own scope so work it dispatches is kept alive', async () => {
    const shared: { dispatch?: (run: () => Promise<void>) => void } = {};
    const work = deferred();
    const out = consoleLines();
    let ports: PluginPorts | undefined;
    const plugin = definePlugin({
      id: 'probe',
      package: 'test/probe',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.job({
          name: 'work',
          version: 1,
          validate: (input) => input,
          handler: () => {
            shared.dispatch?.(() => work.promise);
            return Promise.resolve();
          },
        });
      },
      init(initPorts) {
        ports = initPorts;
      },
    });
    const worker = createWorker([plugin], {
      log: () => undefined,
      console: out.console,
      platformPorts: STANZA,
      cacheStorage: fakeCaches(),
      otlpFetch: otlpFetch().impl,
    });
    const { db } = await migratedDatabase();
    const bootstrapped = await createOrganizationBootstrap(createD1Executor(db)).findSingleton();
    const env = boundEnv({ DB: db });
    await worker.fetch(new Request('https://broker.test/nope'), env);
    shared.dispatch = (await worker.services(env)).dispatch;
    await requirePlatformPorts(ports as PluginPorts).jobs.enqueue(
      orgContext((bootstrapped as { id: string }).id),
      'probe:work:v1',
      {},
      { idempotencyKey: 'scoped' },
    );
    const sent = (env.JOBS as unknown as { sent: unknown[] }).sent;
    const ctx = context();
    await worker.queue({ messages: [messageProbe(sent[0]).message] }, { ...env }, ctx);
    expect(await within(Promise.all(ctx.promises), 50)).toBe('hung');
    work.resolve();
    expect(await within(Promise.all(ctx.promises))).toBe('settled');
    expect(out.lines.some((line) => line.includes('deferred.untracked'))).toBe(false);
  });
});

describe('blob purge timing', () => {
  const invalidTimeouts = [900_000, 90_001, 999, 1500.5];
  it.each(invalidTimeouts)('refuses delete timeout %s as misconfigured', (timeout) => {
    expect(() => blobPurgeTiming(timeout, 900)).toThrow(KernelConfigError);
    expect(() => blobPurgeTiming(timeout, 900)).toThrow('blob.deleteTimeoutMs');
  });

  it('accepts the shipped purge timing', () => {
    expect(blobPurgeTiming(BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS)).toEqual({
      deleteTimeoutMs: 30_000,
      leaseMs: 900_000,
    });
  });

  it.each([...invalidTimeouts, BLOB_DELETE_TIMEOUT_MS, 1000, 90_000])(
    'agrees with lifecycle validation for delete timeout %s',
    (deleteTimeoutMs) => {
      const metadata = {
        softDelete: async () => false,
        claimPurge: async () => null,
        canStartRemove: async () => false,
        markDeleted: async () => false,
        cancelPurge: async () => false,
        unschedule: async () => false,
        scheduleOrphan: async () => false,
        listDue: async () => [],
      };
      const lifecycle = () =>
        createBlobLifecycle({
          metadata,
          store: {} as ByteStore,
          observability: { counter() {}, histogram() {}, log() {} },
          deleteTimeoutMs,
          leaseMs: BLOB_PURGE_LEASE_SECONDS * 1000,
        });
      const timing = () => blobPurgeTiming(deleteTimeoutMs, BLOB_PURGE_LEASE_SECONDS);
      if (invalidTimeouts.includes(deleteTimeoutMs)) {
        expect(lifecycle).toThrow(TypeError);
        expect(timing).toThrow(KernelConfigError);
      } else {
        expect(lifecycle).not.toThrow();
        expect(timing).not.toThrow();
      }
    },
  );
});

it.each([undefined, true, false])(
  'vulnerability switch %s controls Worker cron, redelivery and API projection',
  async (enabled) => {
    const { discoveredMigrations } =
      await import('@package-broker/db-sqlite/testing/migrated-database');
    const { createJobRepository } = await import('@package-broker/db-sqlite/repositories/job');
    const local = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
      }),
    );
    try {
      const db = (await local.getD1Database('DB')) as unknown as D1DatabaseLike;
      const executor = createD1Executor(db);
      await migrate(executor, await discoveredMigrations(), { holder: 'vulnerability-test' });
      const org = orgContext(ulid());
      await createOrganizationBootstrap(executor).bootstrap({
        id: org.orgId,
        slug: 'vulnerability',
        name: 'Vulnerability',
        now: new Date().toISOString(),
      });
      const source = ulid(),
        pkg = ulid(),
        version = ulid();
      await executor.batch([
        {
          sql: "INSERT INTO source (id,org_id,name,ecosystem,type,url,config_json) VALUES (?,?,'public','npm','npmjs_proxy','https://registry.npmjs.org','{}')",
          params: [source, org.orgId],
        },
        {
          sql: "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES (?,?,?,'npm','public-control')",
          params: [pkg, org.orgId, source],
        },
        {
          sql: "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json) VALUES (?,?,?,'1.2.3','1.2.3',?,'upstream','{}')",
          params: [version, org.orgId, pkg, new Date().toISOString()],
        },
      ]);
      let unavailable = true;
      const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        expect(String(input)).toBe('https://api.osv.dev/v1/querybatch');
        expect(await new Request(input, init).json()).toEqual({
          queries: [{ package: { ecosystem: 'npm', name: 'public-control' }, version: '1.2.3' }],
        });
        return unavailable
          ? new Response(null, { status: 503 })
          : Response.json({ results: [{ vulns: [{ id: 'GHSA-test' }] }] });
      });
      const notifications: { v: number; org: string; job: string }[] = [];
      const env: Env = {
        DB: db,
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
        } as unknown as R2BucketLike,
        JOBS: {
          send: async (body) => {
            notifications.push(body as (typeof notifications)[number]);
          },
          sendBatch: async (batch) => {
            notifications.push(...batch.map(({ body }) => body as (typeof notifications)[number]));
          },
        },
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
        DEPLOYMENT_ID: 'vulnerability-test',
      };
      const worker = createWorker([], {
        ...(enabled === undefined ? {} : { vulnerability: { enabled } }),
        platformPorts: {
          blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
          cache: { adapter: 'cache-api', namespace: 'vulnerability-test' },
          jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 1 },
          observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
        },
        cacheStorage: fakeCaches(),
        console: { log: () => undefined, error: () => undefined },
        authorization: {
          authorize: async () => ({
            allow: true,
            principal: { kind: 'user', id: 'reader' },
            projectId: null,
          }),
        },
      });
      const read = async () => {
        const response = await worker.fetch(
          new Request(`https://broker.test/_pb/packages/${pkg}/versions`),
          env,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          items: {
            vulnerability: { status: string; reason: string | null; advisoryCount: number };
          }[];
        };
        return body.items[0]!.vulnerability;
      };
      expect(await read()).toMatchObject({
        status: 'unknown',
        reason: enabled === false ? 'disabled' : 'pending',
      });
      expect(transport).not.toHaveBeenCalled();
      await worker.scheduled({}, env);
      const schedules = await executor.all({
        sql: "SELECT name FROM job_schedule WHERE org_id=? AND name='core:vulnerability-sync:v1'",
        params: [org.orgId],
      });
      expect(schedules).toHaveLength(enabled === false ? 0 : 1);
      const repository = createJobRepository(executor);
      const enqueue = () =>
        repository.enqueue(org, {
          id: ulid(),
          type: 'core:vulnerability-sync:v1',
          payloadJson: '{}',
          idempotencyKey: ulid(),
          maxAttempts: 3,
          projectId: null,
          initiatorTokenId: null,
          resourceKey: null,
          runAt: null,
        });
      const deliver = async (id: string) => {
        const probe = messageProbe({ v: 1, org: org.orgId, job: id });
        await worker.queue({ messages: [probe.message] }, env);
        return probe.calls;
      };
      if (enabled === false) {
        await executor.batch([
          {
            sql: "INSERT INTO vulnerability_result (org_id,version_id,package_id,ecosystem,package_key,version,query_version,mapping_version,assessment,fetched_at,attempted_at,next_attempt_at,generation) VALUES (?,?,?,'npm','public-control','1.2.3','1.2.3',1,'affected',?,?,?,0)",
            params: [
              org.orgId,
              version,
              pkg,
              new Date().toISOString(),
              new Date().toISOString(),
              new Date().toISOString(),
            ],
          },
        ]);
        expect(await read()).toEqual({
          status: 'unknown',
          reason: 'disabled',
          source: null,
          fetchedAt: null,
          lastKnownStatus: null,
          advisoryCount: 0,
          advisories: [],
          detailsComplete: false,
          advisoriesTruncated: false,
        });
        const old = await enqueue();
        await deliver(old.id);
        await deliver(old.id);
        expect(transport).not.toHaveBeenCalled();
        expect(await read()).toMatchObject({ reason: 'disabled', advisoryCount: 0 });
      } else {
        await executor.batch([
          {
            sql: "UPDATE job_schedule SET next_run_at='2000-01-01T00:00:00.000Z' WHERE org_id=? AND name='core:vulnerability-sync:v1'",
            params: [org.orgId],
          },
        ]);
        await worker.scheduled({}, env);
        const rows = await executor.all<{ id: string }>({
          sql: "SELECT id FROM job WHERE org_id=? AND type='core:vulnerability-sync:v1'",
          params: [org.orgId],
        });
        expect(rows).toHaveLength(1);
        const id = rows[0]!.id;
        expect(notifications.some((n) => n.job === id)).toBe(true);
        expect((await deliver(id)).ack).toBe(1);
        expect(await read()).toMatchObject({ reason: 'upstream_unavailable' });
        unavailable = false;
        await executor.batch([
          {
            sql: "UPDATE vulnerability_result SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE org_id=?",
            params: [org.orgId],
          },
          {
            sql: "UPDATE vulnerability_sync_state SET blocked_until=NULL,next_request_at='2000-01-01T00:00:00.000Z' WHERE org_id=?",
            params: [org.orgId],
          },
        ]);
        const retry = await enqueue();
        expect((await deliver(retry.id)).ack).toBe(1);
        expect(await read()).toMatchObject({ status: 'affected', advisoryCount: 1 });
        expect((await deliver(retry.id)).ack).toBe(1);
        await read();
        expect(transport).toHaveBeenCalledTimes(2);
      }
    } finally {
      vi.restoreAllMocks();
      await local.dispose();
    }
  },
);

describe('runtime MCP mount', () => {
  it.each([true, false])(
    'checks binding availability after a cached startup with binding present: %s',
    async (initiallyBound) => {
      const worker = createWorker([], { mcp: { enabled: true }, log: () => undefined });
      const bound = {
        PB_PUBLIC_URL: 'https://broker.test',
        MCP_RATE_LIMIT: { limit: async () => ({ success: true }) },
      };
      const unbound = { PB_PUBLIC_URL: 'https://broker.test' };
      const start = async (hasBinding: boolean) => {
        const startup = worker.services(hasBinding ? bound : unbound);
        if (hasBinding) expect((await startup).access).toBeNull();
        else await expect(startup).rejects.toMatchObject({ name: 'KernelConfigError' });
      };
      await start(initiallyBound);
      await start(!initiallyBound);
    },
  );

  it.each([undefined, false])(
    'MCP disabled (%s) matches the unknown core route',
    async (enabled) => {
      const worker = createWorker([], enabled === undefined ? {} : { mcp: { enabled } });
      const snapshot = async (path: string) => {
        const response = await worker.fetch(
          new Request(`https://broker.test${path}`, { method: 'POST' }),
        );
        const body = (await response.json()) as { error: { requestId?: string } };
        delete body.error.requestId;
        const headers = Object.fromEntries(response.headers);
        delete headers['x-request-id'];
        return { status: response.status, body, headers };
      };
      const missing = await snapshot('/_pb/unknown');
      expect(missing.status).toBe(404);
      expect(await snapshot('/_pb/mcp')).toEqual(missing);
    },
  );

  it('MCP enabled refuses startup without the binding and sanitizes the response and log', async () => {
    const log = vi.fn();
    const env = { PB_PUBLIC_URL: 'https://broker.test', PB_MASTER_KEY: 'environment-sentinel' };
    const worker = createWorker([], { mcp: { enabled: true }, log });
    await expect(worker.services(env)).rejects.toMatchObject({ name: 'KernelConfigError' });
    const response = await worker.fetch(
      new Request('https://broker.test/_pb/mcp', { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'misconfigured', message: 'Server is not configured' },
    });
    expect(body + JSON.stringify(log.mock.calls)).not.toContain('environment-sentinel');
  });

  it('MCP calls use the authenticated selector and return an HTTP envelope when limited', async () => {
    const local = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
      }),
    );
    try {
      const { discoveredMigrations } =
        await import('@package-broker/db-sqlite/testing/migrated-database');
      const db = (await local.getD1Database('DB')) as unknown as D1DatabaseLike;
      const executor = createD1Executor(db);
      await migrate(executor, await discoveredMigrations(), { holder: 'mcp-test' });
      const orgId = ulid();
      await createOrganizationBootstrap(executor).bootstrap({
        id: orgId,
        slug: 'acme',
        name: 'Acme',
        now: new Date().toISOString(),
      });
      const key = KEY_V1;
      const selector = 'abcdefghijkl';
      const token = formatToken('svc', selector, new Uint8Array(32).fill(7));
      const hash = await hashToken(createKeyring([parseMasterKey(key, 'PB_MASTER_KEY')]), 1, token);
      const limit = vi
        .fn<(input: { key: string }) => Promise<{ success: boolean }>>()
        .mockResolvedValue({ success: true });
      const env: Env = {
        DB: db,
        PB_PUBLIC_URL: 'https://broker.test',
        PB_MASTER_KEY: key,
        MCP_RATE_LIMIT: { limit },
      };
      const worker = createWorker([], { mcp: { enabled: true }, log: () => undefined });
      await worker.services(env);
      await executor.batch([
        {
          sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          params: ['mcp-user', orgId, 'reader@example.test'],
        },
        {
          sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
          params: ['mcp-service', orgId, 'MCP reader', 'mcp-user'],
        },
        {
          sql: `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name,
          scopes_json, read_only, service_principal_id, expires_at, project_mode)
          VALUES (?, ?, 'svc', ?, ?, 1, 'MCP reader', '["read"]', 1, ?, ?, 'all')`,
          params: [
            'mcp-token',
            orgId,
            selector,
            hash,
            'mcp-service',
            new Date(Date.now() + 3600000).toISOString(),
          ],
        },
      ]);
      const request = () =>
        new Request('https://broker.test/_pb/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'test', version: '1' },
            },
          }),
        });
      const initialized = await worker.fetch(request(), env);
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: { tools: {} } },
      });
      limit.mockResolvedValue({ success: false });
      const response = await worker.fetch(request(), env);
      expect(limit.mock.calls).toEqual([[{ key: selector }], [{ key: selector }]]);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'rate_limited',
          message: 'Rate limit exceeded',
          requestId: response.headers.get('x-request-id'),
        },
      });
    } finally {
      await local.dispose();
    }
  });
});
