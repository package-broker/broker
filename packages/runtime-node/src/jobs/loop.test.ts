import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fenceKind } from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid, type Clock } from '@package-broker/core/ids';
import type { RegisteredJob } from '@package-broker/core/kernel/registry';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { PluginPorts } from '@package-broker/core/plugin';
import type { JobContext } from '@package-broker/core/platform/jobs';
import {
  createObservability,
  DROPPED_COUNTER,
  type LogRecord,
  type ObsRecord,
  type Observability,
} from '@package-broker/core/platform/observability';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { openBetterSqliteExecutor } from '../db/better-sqlite3-executor.js';
import {
  createJobLoop,
  JOB_DRAIN_MS,
  JOB_EVENTS,
  type JobLoop,
  type JobScope,
  type RunnerObservability,
} from './loop.js';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
const ORG = orgContext('01J0000000000000000000ORG1');
const ports = {
  organizations: { findSingleton: () => Promise.resolve(null) },
  clock: systemClock,
  ids: { ulid },
} as unknown as PluginPorts;

const NODE_SCOPE = { deploymentId: 'test', runtime: 'node', requestId: null } as const;

function realObservability(records: ObsRecord[], events: readonly string[]) {
  return {
    sink: { emit: (record: ObsRecord) => records.push(record) },
    registry: {
      events: new Set(events),
      reasonCodes: new Set<string>(),
      routeTemplates: new Set<string>(),
    },
  };
}

function logsOf(records: readonly ObsRecord[]) {
  return records.flatMap((record) => (record.kind === 'log' ? [record.record] : []));
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Harness {
  readonly executor: SqlExecutor;
  readonly logs: LogRecord[];
  readonly observability: Observability;
  enqueue(type: string, key: string): Promise<string>;
  status(id: string): ReturnType<ReturnType<typeof createJobRepository>['status']>;
  set(column: 'run_at' | 'lease_until', id: string, iso: string): Promise<void>;
  loop(
    jobs: readonly RegisteredJob[],
    executor?: SqlExecutor,
    clock?: Clock,
    scope?: JobScope,
    runnerObservability?: RunnerObservability,
  ): JobLoop;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'pb-job-loop-'));
  const opened = openBetterSqliteExecutor(join(directory, 'loop.db'));
  const loops: JobLoop[] = [];
  cleanup.push(async () => {
    for (const loop of loops) await loop.stop();
    await opened.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { executor } = opened;
  const sources = await Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
  await migrate(executor, sources, { holder: 'job-loop-test' });
  await executor.batch([
    {
      sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
      params: [ORG.orgId, 'org', 'Org'],
    },
    {
      sql: 'INSERT INTO cache_epoch (org_id, version) VALUES (?, hex(randomblob(16))) ON CONFLICT (org_id) DO NOTHING',
      params: [ORG.orgId],
    },
  ]);
  const repository = createJobRepository(executor);
  const logs: LogRecord[] = [];
  const observability: Observability = {
    log: (record) => logs.push(record),
    counter: () => undefined,
    histogram: () => undefined,
  };
  return {
    executor,
    logs,
    observability,
    async enqueue(type, key) {
      const result = await repository.enqueue(ORG, {
        id: ulid(),
        type,
        payloadJson: '{}',
        idempotencyKey: `${type}:${key}`,
        resourceKey: null,
        runAt: null,
        maxAttempts: 5,
        projectId: null,
        initiatorTokenId: null,
      });
      return result.id;
    },
    status: (id) => repository.status(ORG, id),
    async set(column, id, iso) {
      await executor.batch([
        { sql: `UPDATE job SET ${column} = ? WHERE id = ?`, params: [iso, id] },
      ]);
    },
    loop(jobs, override, clock, scope, runnerObservability) {
      const loop = createJobLoop({
        executor: override ?? executor,
        jobs,
        scope: scope ?? (() => ({ ports, observability })),
        observability,
        ...(runnerObservability === undefined ? {} : { runnerObservability }),
        ...(clock === undefined ? {} : { clock }),
      });
      loops.push(loop);
      return loop;
    },
  };
}

function job(
  name: string,
  handler: (payload: unknown, context: JobContext) => Promise<void>,
): RegisteredJob {
  return registerCoreJob({ name, version: 1, validate: (input) => input, handler });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const PAST = '2000-01-01T00:00:00.000Z';
const WAIT = { timeout: 8000, interval: 20 };

describe('createJobLoop', () => {
  it('takes handler ports and observability from each registered job scope', async () => {
    const h = await harness();
    const seen = new Map<string, JobContext>();
    const jobs = ['a', 'b'].map((plugin): RegisteredJob => ({
      plugin,
      qualifiedName: `${plugin}:work:v1`,
      definition: job('work', (_payload, context) => {
        seen.set(plugin, context);
        return Promise.resolve();
      }).definition,
    }));
    const scoped = jobs.map(() => ({
      ports: { ...ports },
      observability: { ...h.observability },
    }));
    const scope = vi.fn((registered: RegisteredJob) => scoped[jobs.indexOf(registered)]!);
    const ids = await Promise.all(
      jobs.map((registered) => h.enqueue(registered.qualifiedName, 'one')),
    );
    h.loop(jobs, undefined, undefined, scope).start();
    for (const [index, registered] of jobs.entries()) {
      await vi.waitFor(
        async () => expect((await h.status(ids[index]!))?.state).toBe('succeeded'),
        WAIT,
      );
      expect(scope).toHaveBeenCalledWith(registered, { jobId: ids[index], attempt: 1 });
      expect(scope.mock.calls[index]?.[0]).toBe(registered);
      expect(seen.get(registered.plugin)?.ports).toBe(scoped[index]?.ports);
      expect(seen.get(registered.plugin)?.observability).toBe(scoped[index]?.observability);
    }
    expect(scope).toHaveBeenCalledTimes(2);
  });

  it('routes heartbeat and settle failures through the runner observability with job_id and attempt', async () => {
    const h = await harness();
    const id = await h.enqueue('core:boundary:v1', 'one');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runnerRecords: ObsRecord[] = [];
    const scopedRecords: ObsRecord[] = [];
    const runtime = realObservability(runnerRecords, JOB_EVENTS);
    const handlerSide = realObservability(scopedRecords, []);
    const gate = deferred();
    let started = false;
    const flaky = new Proxy(h.executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'batch') return (value as (...args: unknown[]) => unknown).bind(target);
        return (statements: Parameters<SqlExecutor['batch']>[0]) => {
          if (
            statements.some((item) =>
              /lease_until = max\(lease_until|outcome = 'succeeded'/.test(item.sql),
            )
          ) {
            return Promise.reject(new Error('storage unavailable'));
          }
          return target.batch(statements);
        };
      },
    });
    h.loop(
      [
        job('boundary', async () => {
          started = true;
          await gate.promise;
        }),
      ],
      flaky,
      undefined,
      () => ({
        ports,
        observability: createObservability(handlerSide.sink, NODE_SCOPE, handlerSide.registry),
      }),
      ({ jobId, attempt }) =>
        createObservability(runtime.sink, { ...NODE_SCOPE, jobId, attempt }, runtime.registry),
    ).start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logsOf(runnerRecords)).toContainEqual(
      expect.objectContaining({ event: 'job.heartbeat_failed', job_id: id, attempt: 1 }),
    );
    gate.resolve();
    await vi.waitFor(
      () =>
        expect(logsOf(runnerRecords)).toContainEqual(
          expect.objectContaining({ event: 'job.settle_failed', job_id: id, attempt: 1 }),
        ),
      WAIT,
    );
    expect(scopedRecords).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('logs handler_failed with job_id and attempt through the runner observability', async () => {
    const h = await harness();
    const id = await h.enqueue('core:boom:v1', 'one');
    const runnerRecords: ObsRecord[] = [];
    const scopedRecords: ObsRecord[] = [];
    const runtime = realObservability(runnerRecords, JOB_EVENTS);
    const handlerSide = realObservability(scopedRecords, []);
    h.loop(
      [job('boom', () => Promise.reject(new Error('boom')))],
      undefined,
      undefined,
      () => ({
        ports,
        observability: createObservability(handlerSide.sink, NODE_SCOPE, handlerSide.registry),
      }),
      ({ jobId, attempt }) =>
        createObservability(runtime.sink, { ...NODE_SCOPE, jobId, attempt }, runtime.registry),
    ).start();
    await vi.waitFor(() => expect(logsOf(runnerRecords).length).toBeGreaterThan(0), WAIT);
    expect(logsOf(runnerRecords)).toContainEqual(
      expect.objectContaining({ event: 'job.handler_failed', job_id: id, attempt: 1 }),
    );
    expect(scopedRecords).toEqual([]);
  });

  it('fails retryably without running the handler when scope throws', async () => {
    const h = await harness();
    const handler = vi.fn(() => Promise.resolve());
    const id = await h.enqueue('core:scope-error:v1', 'one');
    h.loop([job('scope-error', handler)], undefined, undefined, () => {
      throw new Error('scope failure');
    }).start();
    await vi.waitFor(
      async () =>
        expect(await h.status(id)).toMatchObject({
          state: 'queued',
          lastErrorCode: 'handler_error',
          attempts: 1,
        }),
      WAIT,
    );
    expect(handler).not.toHaveBeenCalled();
    expect((await h.status(id))?.history[0]?.outcome).toBe('failed');
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'job.handler_failed', job_id: id }),
    );
    expect(h.logs.filter((l) => l.event === 'job.handler_failed')).toHaveLength(1);
  });

  it('claims due jobs and runs at most maxRunning (2) handlers concurrently', async () => {
    const h = await harness();
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const seen: JobContext[] = [];
    const ids = await Promise.all(['a', 'b', 'c'].map((key) => h.enqueue('core:work:v1', key)));
    h.loop([
      job('work', async (_payload, context) => {
        seen.push(context);
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    ]).start();
    await vi.waitFor(() => expect(running).toBe(2), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(running).toBe(2);
    gate.resolve();
    for (const id of ids) {
      await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    }
    expect(peak).toBe(2);
    expect(seen[0]).toMatchObject({ org: ORG, attempt: 1, ports, observability: h.observability });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.idempotencyKey).toMatch(/^core:work:v1:/);
  });

  it('settles a handler exception as a due retry with a sanitized error code', async () => {
    const h = await harness();
    const id = await h.enqueue('core:boom:v1', 'one');
    h.loop([
      job('boom', () => Promise.reject(new Error('secret detail must not be stored'))),
    ]).start();
    await vi.waitFor(async () => expect((await h.status(id))?.attempts).toBe(1), WAIT);
    await vi.waitFor(async () => {
      const status = await h.status(id);
      expect(status).toMatchObject({ state: 'queued', lastErrorCode: 'handler_error' });
      expect(status?.history[0]?.outcome).toBe('failed');
      expect(Date.parse(status?.runAt ?? '')).toBeGreaterThan(Date.now());
    }, WAIT);
  });

  it('reaps an expired lease from a crashed runner and retries the job', async () => {
    const h = await harness();
    const id = await h.enqueue('core:retry:v1', 'one');
    const crashed = await createJobRepository(h.executor).claim(ORG, ulid(), {
      types: ['core:retry:v1'],
      leaseSeconds: 60,
      maxRunning: 2,
    });
    expect(crashed?.id).toBe(id);
    await h.set('lease_until', id, PAST);
    let runs = 0;
    h.loop([
      job('retry', () => {
        runs += 1;
        return Promise.resolve();
      }),
    ]).start();
    await vi.waitFor(async () => {
      const status = await h.status(id);
      expect(status?.history.some((attempt) => attempt.outcome === 'lease_expired')).toBe(true);
    }, WAIT);
    expect(runs).toBe(0);
    await h.set('run_at', id, PAST);
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    expect(runs).toBe(1);
  });

  it('stop() aborts a running handler, drains it and releases the job without an attempt', async () => {
    const h = await harness();
    const id = await h.enqueue('core:long:v1', 'one');
    let started = false;
    const loop = h.loop([
      job('long', (_payload, context) => {
        started = true;
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason));
        });
      }),
    ]);
    loop.start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    const before = Date.now();
    await loop.stop();
    expect(Date.now() - before).toBeLessThan(JOB_DRAIN_MS);
    const status = await h.status(id);
    expect(status).toMatchObject({ state: 'queued', attempts: 0 });
    expect(status?.history[0]?.outcome).toBe('released');
  });

  it('stop() returns after the 10 s drain, clears the task timers and never settles late', async () => {
    const h = await harness();
    const id = await h.enqueue('core:stuck:v1', 'one');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = deferred();
    let started = false;
    const loop = h.loop([
      job('stuck', () => {
        started = true;
        return release.promise;
      }),
    ]);
    loop.start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(JOB_DRAIN_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    release.resolve();
    await vi.advanceTimersByTimeAsync(300_000);
    const status = await h.status(id);
    expect(status).toMatchObject({ state: 'running', attempts: 1 });
    expect(status?.history[0]?.outcome).toBe('running');
    expect(h.logs.some((record) => record.event === 'job.settle_failed')).toBe(false);
  });

  it('stop() resolves abandoned: 1 for a handler that never settles', async () => {
    const h = await harness();
    await h.enqueue('core:stuck:v1', 'one');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started = false;
    const loop = h.loop([
      job('stuck', () => {
        started = true;
        return new Promise<void>(() => undefined);
      }),
    ]);
    loop.start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(JOB_DRAIN_MS);
    await expect(stopping).resolves.toEqual({ abandoned: 1 });
    await expect(loop.stop()).resolves.toEqual({ abandoned: 1 });
  });

  it('stop() resolves abandoned: 0 after a handler drains on abort', async () => {
    const h = await harness();
    await h.enqueue('core:long:v1', 'one');
    let started = false;
    const loop = h.loop([
      job('long', (_payload, context) => {
        started = true;
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason));
        });
      }),
    ]);
    loop.start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    await expect(loop.stop()).resolves.toEqual({ abandoned: 0 });
  });

  it('stop() resolves abandoned: 0 for a loop that never started or never ran work', async () => {
    const h = await harness();
    const idle = h.loop([job('idle', () => Promise.resolve())]);
    await expect(idle.stop()).resolves.toEqual({ abandoned: 0 });
    const started = h.loop([job('idle2', () => Promise.resolve())]);
    started.start();
    await expect(started.stop()).resolves.toEqual({ abandoned: 0 });
  });

  it('unrefs the budget and heartbeat timers', async () => {
    const h = await harness();
    await h.enqueue('core:unref:v1', 'one');
    const real = globalThis.setTimeout;
    const handles = new Map<number, { hasRef(): boolean }>();
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
    ) => {
      const handle = real(callback, ms);
      if (ms !== undefined) handles.set(ms, handle);
      return handle;
    }) as typeof setTimeout);
    const gate = deferred();
    let started = false;
    try {
      h.loop([
        job('unref', async () => {
          started = true;
          await gate.promise;
        }),
      ]).start();
      await vi.waitFor(() => expect(started).toBe(true), WAIT);
      expect(handles.get(240_000)?.hasRef()).toBe(false);
      expect(handles.get(20_000)?.hasRef()).toBe(false);
    } finally {
      spy.mockRestore();
      gate.resolve();
    }
  });

  it('does not re-arm a heartbeat that resolves after the handler settled', async () => {
    const h = await harness();
    const id = await h.enqueue('core:beat:v1', 'one');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = deferred();
    let holding = true;
    let beats = 0;
    const proxy = new Proxy(h.executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'batch') return (value as (...args: unknown[]) => unknown).bind(target);
        return async (statements: Parameters<SqlExecutor['batch']>[0]) => {
          const result = await target.batch(statements);
          if (statements.some((item) => /lease_until = max\(lease_until/.test(item.sql))) {
            beats += 1;
            if (holding) {
              holding = false;
              await held.promise;
            }
          }
          return result;
        };
      },
    });
    const gate = deferred();
    let started = false;
    h.loop(
      [
        job('beat', async () => {
          started = true;
          await gate.promise;
        }),
      ],
      proxy,
    ).start();
    await vi.waitFor(() => expect(started).toBe(true), WAIT);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(beats).toBe(1);
    gate.resolve();
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats).toBe(1);
    expect(h.logs.some((record) => record.event === 'job.heartbeat_failed')).toBe(false);
  });

  it('logs a timer error as a sanitized event and keeps polling', async () => {
    const h = await harness();
    const id = await h.enqueue('core:after-error:v1', 'one');
    let failures = 1;
    const flaky = new Proxy(h.executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'batch' && failures > 0) {
          failures -= 1;
          return () => Promise.reject(new Error('disk path /var/secret leaked'));
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    h.loop([job('after-error', () => Promise.resolve())], flaky).start();
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    const event = h.logs.find((record) => record.event === 'job.schedule_sync_failed');
    expect(event).toEqual({
      level: 'error',
      event: 'job.schedule_sync_failed',
      error_name: 'Error',
    });
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  it('a crash after the effect committed produces one domain effect on replay', async () => {
    const h = await harness();
    await h.executor.batch([
      { sql: 'CREATE TABLE effect (domain_key TEXT PRIMARY KEY)', params: [] },
    ]);
    const id = await h.enqueue('core:effect:v1', 'one');
    const hang = deferred();
    const attempts: number[] = [];
    h.loop([
      job('effect', async (_payload, context) => {
        attempts.push(context.attempt);
        await h.executor.batch([
          {
            sql: 'INSERT INTO effect (domain_key) VALUES (?) ON CONFLICT (domain_key) DO NOTHING',
            params: [context.idempotencyKey],
          },
        ]);
        if (context.attempt === 1) await hang.promise;
      }),
    ]).start();
    await vi.waitFor(() => expect(attempts).toEqual([1]), WAIT);
    await h.set('lease_until', id, PAST);
    await vi.waitFor(async () => {
      const status = await h.status(id);
      expect(status?.history.some((attempt) => attempt.outcome === 'lease_expired')).toBe(true);
    }, WAIT);
    await h.set('run_at', id, PAST);
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    hang.resolve();
    await vi.waitFor(
      () => expect(h.logs.some((record) => record.event === 'job.settle_failed')).toBe(true),
      WAIT,
    );
    const rows = await h.executor.all<{ n: number }>({
      sql: 'SELECT count(*) AS n FROM effect',
      params: [],
    });
    expect(rows[0]?.n).toBe(1);
    expect(attempts).toEqual([1, 2]);
    expect((await h.status(id))?.state).toBe('succeeded');
  });

  it('syncs schedules on the ticking instance and ticks at most once per minute', async () => {
    const h = await harness();
    const ran: string[] = [];
    const scheduled = registerCoreJob({
      name: 'sweep',
      version: 1,
      validate: (input) => input,
      handler: (_payload, context) => {
        ran.push(context.idempotencyKey);
        return Promise.resolve();
      },
      schedule: { everySeconds: 60 },
    });
    await h.executor.batch([
      {
        sql: 'INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled) VALUES (?, ?, 60, ?, 1)',
        params: [ORG.orgId, 'core:retired:v1', PAST],
      },
    ]);
    let now = Date.now();
    h.loop([scheduled], undefined, { now: () => new Date(now) }).start();
    await vi.waitFor(async () => {
      const rows = await h.executor.all<{ name: string; enabled: number }>({
        sql: 'SELECT name, enabled FROM job_schedule ORDER BY name',
        params: [],
      });
      expect(rows).toEqual([
        { name: 'core:retired:v1', enabled: 0 },
        { name: 'core:sweep:v1', enabled: 1 },
      ]);
    }, WAIT);
    await h.executor.batch([
      {
        sql: 'UPDATE job_schedule SET next_run_at = ? WHERE name = ?',
        params: [PAST, 'core:sweep:v1'],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(ran).toHaveLength(0);
    now += 60_000;
    await vi.waitFor(() => expect(ran).toHaveLength(1), WAIT);
    expect(ran[0]).toMatch(/^schedule:core:sweep:v1:/);
  });

  it('leaves process-wide error handlers to the runtime and exposes its event names', async () => {
    const h = await harness();
    const uncaught = process.listenerCount('uncaughtException');
    const unhandled = process.listenerCount('unhandledRejection');
    const loop = h.loop([]);
    loop.start();
    expect(process.listenerCount('uncaughtException')).toBe(uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(unhandled);
    await loop.stop();
    for (const event of JOB_EVENTS) expect(event).toMatch(/^job\.[a-z_]+$/);
    expect(JOB_EVENTS).toEqual(
      expect.arrayContaining([
        'job.schedule_sync_failed',
        'job.schedule_tick_failed',
        'job.reap_failed',
        'job.claim_failed',
        'job.handler_failed',
        'job.heartbeat_failed',
        'job.settle_failed',
      ]),
    );
  });

  it('emits through the real observability registry without dropped records', async () => {
    const h = await harness();
    const records: ObsRecord[] = [];
    const real = createObservability(
      { emit: (record) => records.push(record) },
      { deploymentId: 'test', runtime: 'node', requestId: null },
      { events: new Set(JOB_EVENTS), reasonCodes: new Set(), routeTemplates: new Set() },
    );
    let failures = 1;
    const flaky = new Proxy(h.executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'batch' && failures > 0) {
          failures -= 1;
          return () => Promise.reject(new Error('boom'));
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const good = await h.enqueue('core:fine:v1', 'one');
    const bad = await h.enqueue('core:fails:v1', 'one');
    const loop = createJobLoop({
      executor: flaky,
      jobs: [
        job('fine', () => Promise.resolve()),
        job('fails', () => Promise.reject(new Error('no'))),
      ],
      scope: () => ({ ports, observability: real }),
      observability: real,
    });
    loop.start();
    try {
      await vi.waitFor(async () => {
        expect((await h.status(good))?.state).toBe('succeeded');
        expect((await h.status(bad))?.attempts).toBe(1);
        expect((await h.status(bad))?.state).toBe('queued');
      }, WAIT);
    } finally {
      await loop.stop();
    }
    const events = records.flatMap((record) =>
      record.kind === 'log' ? [record.record.event] : [],
    );
    expect(events).toEqual(
      expect.arrayContaining(['job.schedule_sync_failed', 'job.handler_failed']),
    );
    expect(
      records.some((record) => record.kind === 'counter' && record.name === 'pb.jobs.settled'),
    ).toBe(true);
    expect(
      records.filter((record) => record.kind === 'counter' && record.name === DROPPED_COUNTER),
    ).toEqual([]);
  });

  it('retries the settle of a successful handler once before giving up', async () => {
    const h = await harness();
    let failures = 1;
    const flaky = new Proxy(h.executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'batch') return (value as (...args: unknown[]) => unknown).bind(target);
        return (statements: Parameters<SqlExecutor['batch']>[0]) => {
          if (
            failures > 0 &&
            statements.some((item) => item.sql.includes("outcome = 'succeeded'"))
          ) {
            failures -= 1;
            return Promise.reject(new Error('busy'));
          }
          return target.batch(statements);
        };
      },
    });
    const id = await h.enqueue('core:settle:v1', 'one');
    let runs = 0;
    h.loop(
      [
        job('settle', () => {
          runs += 1;
          return Promise.resolve();
        }),
      ],
      flaky,
    ).start();
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    expect(failures).toBe(0);
    expect(runs).toBe(1);
    expect(h.logs.some((record) => record.event === 'job.settle_failed')).toBe(false);
  });

  it('counts a replayed attempt separately while the stale attempt still runs, and stop aborts both', async () => {
    const h = await harness();
    const id = await h.enqueue('core:replay:v1', 'one');
    const signals: AbortSignal[] = [];
    let running = 0;
    const loop = h.loop([
      job('replay', (_payload, context) => {
        signals.push(context.signal);
        running += 1;
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            running -= 1;
            reject(context.signal.reason);
          });
        });
      }),
    ]);
    loop.start();
    await vi.waitFor(() => expect(running).toBe(1), WAIT);
    await h.set('lease_until', id, PAST);
    await vi.waitFor(async () => {
      const status = await h.status(id);
      expect(status?.history.some((attempt) => attempt.outcome === 'lease_expired')).toBe(true);
    }, WAIT);
    await h.set('run_at', id, PAST);
    await vi.waitFor(() => expect(running).toBe(2), WAIT);
    await h.enqueue('core:replay:v1', 'two');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(running).toBe(2);
    expect(signals).toHaveLength(2);
    const before = Date.now();
    await loop.stop();
    expect(Date.now() - before).toBeLessThan(JOB_DRAIN_MS);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(running).toBe(0);
  });

  it('rejects a non-positive maxRunning', () => {
    expect(() =>
      createJobLoop({
        executor: {} as SqlExecutor,
        jobs: [],
        scope: () => ({ ports, observability: {} as Observability }),
        maxRunning: 0,
        observability: {
          log: () => undefined,
          counter: () => undefined,
          histogram: () => undefined,
        },
      }),
    ).toThrow(RangeError);
  });

  it('hands the handler a fence issuer bound to the claimed job lease', async () => {
    const h = await harness();
    let seen:
      | { fence: ReturnType<NonNullable<JobContext['fences']>['delegated']>; row: unknown }
      | undefined;
    const registered = job('fenced', async (_payload, context) => {
      const rows = await h.executor.all<{ lease_owner: string; fence: number }>({
        sql: 'SELECT lease_owner, fence FROM job WHERE id = ?',
        params: [context.jobId],
      });
      seen = { fence: context.fences!.delegated('user-1', 'run-1', { a: 1 }), row: rows[0] };
    });
    const id = await h.enqueue(registered.qualifiedName, 'one');
    h.loop([registered]).start();
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    const row = seen?.row as { lease_owner: string; fence: number };
    expect(fenceKind(seen!.fence)).toBe('delegated');
    expect(seen!.fence.job).toEqual({ id, owner: row.lease_owner, fence: row.fence });
    expect(seen!.fence.approverUserId).toBe('user-1');
    expect(seen!.fence.runId).toBe('run-1');
  });

  it('gives a plugin job no fence issuer', async () => {
    const h = await harness();
    let seen: JobContext | undefined;
    const core = job('work', () => Promise.resolve());
    const plugin: RegisteredJob = {
      plugin: 'acme',
      qualifiedName: 'acme:work:v1',
      definition: {
        ...core.definition,
        handler: (_payload, context) => {
          seen = context;
          return Promise.resolve();
        },
      },
    };
    const id = await h.enqueue(plugin.qualifiedName, 'one');
    h.loop([plugin]).start();
    await vi.waitFor(async () => expect((await h.status(id))?.state).toBe('succeeded'), WAIT);
    expect(seen).toBeDefined();
    expect(seen?.fences).toBeUndefined();
  });
});
