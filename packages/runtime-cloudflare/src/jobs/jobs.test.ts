import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { registerCoreJob } from '@package-broker/core/kernel/registry';
import type { RegisteredJob } from '@package-broker/core/kernel/registry';
import type { PluginPorts } from '@package-broker/core/plugin';
import {
  StaleFenceError,
  type JobClaim,
  type JobRepository,
} from '@package-broker/core/platform/job-repository';
import { JobError } from '@package-broker/core/platform/jobs';
import {
  DROPPED_COUNTER,
  createObservability,
  type LogRecord,
  type ObsRecord,
  type Observability,
} from '@package-broker/core/platform/observability';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import {
  createJobRepository,
  type SqliteJobRepository,
} from '@package-broker/db-sqlite/repositories/job';
import {
  createJobScheduleRepository,
  type JobScheduleRepository,
} from '@package-broker/db-sqlite/repositories/job-schedule';
import { createD1Executor, type D1DatabaseLike } from '../db/d1-executor.js';
import {
  JOB_EVENTS,
  JOB_NOTIFICATION_VERSION,
  JOB_REASON_CODES,
  QUEUE_MAX_DELAY_SECONDS,
  QUEUE_RETRY_DELAY_SECONDS,
  createJobBatchSender,
  createJobSender,
  createQueueHandler,
  enqueueAndNotify,
  jobNotification,
  type QueueLike,
  type QueueMessageLike,
} from './consumer.js';
import { CRON_DUE_PAGE_LIMIT, createScheduledHandler } from './cron.js';

const bindings = Array.from({ length: 32 }, (_, index) => `QDB${index}`);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let nextBinding = 0;

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

interface Fixture {
  readonly repository: SqliteJobRepository;
  readonly schedule: JobScheduleRepository;
  readonly ctx: OrgContext;
  exec(sql: string, params: readonly (string | number)[]): Promise<void>;
  rows(sql: string, params: readonly (string | number)[]): Promise<Record<string, unknown>[]>;
}

async function fixture(): Promise<Fixture> {
  const binding = bindings[nextBinding];
  nextBinding += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await loadSources(), { holder: 'jobs-test' });
  const { a } = await seedTwoOrganizations(executor);
  return {
    repository: createJobRepository(executor),
    schedule: createJobScheduleRepository(executor),
    ctx: a,
    async exec(sql, params) {
      await executor.batch([{ sql, params }]);
    },
    async rows(sql, params) {
      const [result] = await executor.batch([{ sql, params }]);
      return (result?.rows ?? []) as Record<string, unknown>[];
    },
  };
}

interface Recorded {
  readonly observability: Observability;
  readonly logs: LogRecord[];
}

function recorder(): Recorded {
  const logs: LogRecord[] = [];
  return {
    logs,
    observability: {
      log: (record) => logs.push(record),
      counter: () => undefined,
      histogram: () => undefined,
    },
  };
}

const ports: PluginPorts = {
  organizations: { get: () => Promise.resolve(null) } as unknown as PluginPorts['organizations'],
  clock: systemClock,
  ids: { ulid },
};

interface Message extends QueueMessageLike {
  readonly acked: () => number;
  readonly retried: () => { delaySeconds?: number }[];
}

function message(body: unknown, options: { throwOnAck?: boolean } = {}): Message {
  let acks = 0;
  const retries: { delaySeconds?: number }[] = [];
  return {
    body,
    ack() {
      if (options.throwOnAck === true) throw new Error('ack transport failure');
      acks += 1;
    },
    retry(retryOptions) {
      retries.push(retryOptions ?? {});
    },
    acked: () => acks,
    retried: () => retries,
  };
}

function counting(name: string, behaviour: () => Promise<void> = () => Promise.resolve()) {
  const calls: unknown[] = [];
  const job = registerCoreJob({
    name,
    version: 1,
    validate: (input) => input,
    handler: async (payload) => {
      calls.push(payload);
      await behaviour();
    },
  });
  return { job, calls };
}

async function enqueue(
  f: Fixture,
  type: string,
  key: string,
  overrides: { resourceKey?: string } = {},
): Promise<string> {
  const id = ulid();
  await f.repository.enqueue(f.ctx, {
    id,
    type,
    payloadJson: '{"n":1}',
    idempotencyKey: `${type}:${key}`,
    resourceKey: overrides.resourceKey ?? null,
    runAt: null,
    maxAttempts: 5,
    projectId: null,
    initiatorTokenId: null,
  });
  return id;
}

function handlerFor(
  f: Fixture,
  jobs: readonly RegisteredJob[],
  observability: Observability = recorder().observability,
) {
  return createQueueHandler({
    repository: f.repository,
    jobs: { jobs },
    observability,
    ports,
  });
}

describe('createQueueHandler on D1', () => {
  it('runs the handler once for a repeated notification and acks every copy', async () => {
    const f = await fixture();
    const { job, calls } = counting('repeat');
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const handle = handlerFor(f, [job]);

    const first = message(jobNotification(f.ctx, id));
    const second = message(jobNotification(f.ctx, id));
    await handle({ messages: [first, second] }, {});
    const third = message(jobNotification(f.ctx, id));
    await handle({ messages: [third] }, {});

    expect(calls).toEqual([{ n: 1 }]);
    for (const m of [first, second, third]) {
      expect(m.acked()).toBe(1);
      expect(m.retried()).toEqual([]);
    }
    expect((await f.repository.status(f.ctx, id))?.state).toBe('succeeded');
  });

  it('acks a notification for a job whose lease is live and never kills the running job', async () => {
    const f = await fixture();
    const { job, calls } = counting('busy');
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const held = await f.repository.claim(f.ctx, ulid(), {
      id,
      types: [job.qualifiedName],
      leaseSeconds: 60,
      maxRunning: 2,
    });
    expect(held?.id).toBe(id);

    const stale = message(jobNotification(f.ctx, id));
    await handlerFor(f, [job])({ messages: [stale] }, {});

    expect(calls).toEqual([]);
    expect(stale.acked()).toBe(1);
    expect(stale.retried()).toEqual([]);
    expect((await f.repository.status(f.ctx, id))?.state).toBe('running');
  });

  it('acks when the maxRunning cap is reached and leaves the job queued', async () => {
    const f = await fixture();
    const { job, calls } = counting('capped');
    const ids = [
      await enqueue(f, job.qualifiedName, 'k1'),
      await enqueue(f, job.qualifiedName, 'k2'),
      await enqueue(f, job.qualifiedName, 'k3'),
    ];
    for (const id of ids.slice(0, 2)) {
      await f.repository.claim(f.ctx, ulid(), {
        id,
        types: [job.qualifiedName],
        leaseSeconds: 60,
        maxRunning: 2,
      });
    }
    const third = message(jobNotification(f.ctx, ids[2] as string));
    await handlerFor(f, [job])({ messages: [third] }, {});

    expect(calls).toEqual([]);
    expect(third.acked()).toBe(1);
    expect(third.retried()).toEqual([]);
    expect((await f.repository.status(f.ctx, ids[2] as string))?.state).toBe('queued');
  });

  it('settles a transient handler error as a due retry in SQL and acks', async () => {
    const f = await fixture();
    const { job } = counting('flaky', () => Promise.reject(new Error('upstream 502 secret=abc')));
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const recorded = recorder();
    const m = message(jobNotification(f.ctx, id));
    await handlerFor(f, [job], recorded.observability)({ messages: [m] }, {});

    expect(m.acked()).toBe(1);
    expect(m.retried()).toEqual([]);
    const status = await f.repository.status(f.ctx, id);
    expect(status?.state).toBe('queued');
    expect(status?.attempts).toBe(1);
    expect(status?.lastErrorCode).toBe('handler_error');
    expect(JSON.stringify(recorded.logs)).not.toContain('secret=abc');
  });

  it('records the JobError code of a failing handler', async () => {
    const f = await fixture();
    const { job } = counting('aborting', () => Promise.reject(new JobError('aborted')));
    const id = await enqueue(f, job.qualifiedName, 'k1');
    await handlerFor(f, [job])({ messages: [message(jobNotification(f.ctx, id))] }, {});
    expect((await f.repository.status(f.ctx, id))?.lastErrorCode).toBe('aborted');
  });

  it('fails permanently when the stored payload does not validate, without running the handler', async () => {
    const f = await fixture();
    const calls: unknown[] = [];
    const job = registerCoreJob({
      name: 'strict',
      version: 1,
      validate: () => {
        throw new JobError('invalid_payload');
      },
      handler: (payload) => {
        calls.push(payload);
        return Promise.resolve();
      },
    });
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const m = message(jobNotification(f.ctx, id));
    await handlerFor(f, [job])({ messages: [m] }, {});

    expect(calls).toEqual([]);
    expect(m.acked()).toBe(1);
    const status = await f.repository.status(f.ctx, id);
    expect(status?.state).toBe('dead');
    expect(status?.lastErrorCode).toBe('invalid_payload');
  });

  it('acks an unknown envelope version and a malformed body without claiming', async () => {
    const f = await fixture();
    const { job, calls } = counting('versioned');
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const bodies: unknown[] = [
      { v: JOB_NOTIFICATION_VERSION + 1, org: f.ctx.orgId, job: id },
      { v: JOB_NOTIFICATION_VERSION, org: f.ctx.orgId },
      { v: JOB_NOTIFICATION_VERSION, org: '', job: id },
      { v: JOB_NOTIFICATION_VERSION, org: f.ctx.orgId, job: 'not-a-ulid' },
      { v: JOB_NOTIFICATION_VERSION, org: 'org-a', job: id },
      { v: JOB_NOTIFICATION_VERSION, org: f.ctx.orgId, job: id.toLowerCase() },
      { v: JOB_NOTIFICATION_VERSION, org: f.ctx.orgId, job: id, extra: 'payload' },
      'not-an-envelope',
      null,
    ];
    const messages = bodies.map((body) => message(body));
    const claim = vi.spyOn(f.repository, 'claim');
    const recorded = recorder();
    await handlerFor(f, [job], recorded.observability)({ messages }, {});

    expect(claim).not.toHaveBeenCalled();
    expect(
      recorded.logs.filter((record) => record.event === 'job.notification_rejected'),
    ).toHaveLength(messages.length);
    expect(calls).toEqual([]);
    for (const m of messages) {
      expect(m.acked()).toBe(1);
      expect(m.retried()).toEqual([]);
    }
    expect((await f.repository.status(f.ctx, id))?.state).toBe('queued');
  });

  it('acks a notification for an unregistered type without executing anything', async () => {
    const f = await fixture();
    const { job, calls } = counting('known');
    const id = await enqueue(f, 'acme:gone:v1', 'k1');
    const m = message(jobNotification(f.ctx, id));
    await handlerFor(f, [job])({ messages: [m] }, {});

    expect(calls).toEqual([]);
    expect(m.acked()).toBe(1);
    expect((await f.repository.status(f.ctx, id))?.state).toBe('queued');
  });

  it('aborts a handler past its budget and settles a retryable timeout', async () => {
    const f = await fixture();
    let seen: AbortSignal | undefined;
    const job = registerCoreJob({
      name: 'slow',
      version: 1,
      validate: (input) => input,
      handler: (_payload, context) => {
        seen = context.signal;
        return new Promise(() => undefined);
      },
    });
    const id = await enqueue(f, job.qualifiedName, 'k1');
    const handle = createQueueHandler({
      repository: f.repository,
      jobs: { jobs: [job] },
      observability: recorder().observability,
      ports,
      limits: { budgetMs: 20, heartbeatMs: 5 },
    });
    const m = message(jobNotification(f.ctx, id));
    await handle({ messages: [m] }, {});

    expect(seen?.aborted).toBe(true);
    expect(m.acked()).toBe(1);
    const status = await f.repository.status(f.ctx, id);
    expect(status?.state).toBe('queued');
    expect(status?.lastErrorCode).toBe('timeout');
  });
});

function fakeRepository(overrides: Partial<SqliteJobRepository>): SqliteJobRepository {
  const fail = () => Promise.reject(new Error('unexpected call'));
  return {
    enqueue: fail,
    status: fail,
    claim: fail,
    heartbeat: fail,
    settle: fail,
    reap: fail,
    listDue: fail,
    buryUnregistered: fail,
    ...overrides,
  };
}

const orgA = { orgId: '01J00000000000000000000A0A' } as OrgContext;
const someJob = '01J00000000000000000000J0B';

function fakeClaim(
  type: string,
  leaseUntil = new Date(Date.now() + 60_000).toISOString(),
): JobClaim {
  return {
    id: someJob,
    owner: ulid(),
    fence: 1,
    type,
    payloadJson: '{}',
    idempotencyKey: 'k',
    resourceKey: null,
    projectId: null,
    initiatorTokenId: null,
    attempt: 1,
    maxAttempts: 5,
    leaseUntil,
  };
}

function blockingJob(name: string) {
  let seen: AbortSignal | undefined;
  let started: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const job = registerCoreJob({
    name,
    version: 1,
    validate: (input) => input,
    handler: async (_payload, context) => {
      calls += 1;
      seen = context.signal;
      started();
      await gate;
    },
  });
  return { job, running, release, signal: () => seen, calls: () => calls };
}

describe('createQueueHandler transport boundaries', () => {
  it('retries with the queue retry delay when the claim fails in transport', async () => {
    const handle = createQueueHandler({
      repository: fakeRepository({ claim: () => Promise.reject(new Error('D1 network')) }),
      jobs: { jobs: [counting('t').job] },
      observability: recorder().observability,
      ports,
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});

    expect(m.acked()).toBe(0);
    expect(m.retried()).toEqual([{ delaySeconds: QUEUE_RETRY_DELAY_SECONDS }]);
    expect(QUEUE_RETRY_DELAY_SECONDS).toBe(30);
  });

  it('keeps processing after an ack throws and never rejects', async () => {
    const claim = vi.fn(() => Promise.resolve(null));
    const handle = createQueueHandler({
      repository: fakeRepository({ claim }),
      jobs: { jobs: [counting('t').job] },
      observability: recorder().observability,
      ports,
    });
    const broken = message(jobNotification(orgA, someJob), { throwOnAck: true });
    const healthy = message(jobNotification(orgA, '01J00000000000000000000J0C'));
    await expect(handle({ messages: [broken, healthy] }, {})).resolves.toBeUndefined();

    expect(claim).toHaveBeenCalledTimes(2);
    expect(healthy.acked()).toBe(1);
    expect(broken.retried()).toEqual([]);
  });

  it('never rejects on a malformed batch', async () => {
    const handle = createQueueHandler({
      repository: fakeRepository({}),
      jobs: { jobs: [] },
      observability: recorder().observability,
      ports,
    });
    await expect(handle(null as never, {})).resolves.toBeUndefined();
    await expect(handle({ messages: null } as never, {})).resolves.toBeUndefined();
  });

  it('retries a failed settle once inline after a successful handler, then acks', async () => {
    const { job, calls } = counting('t');
    const settle = vi
      .fn<JobRepository['settle']>()
      .mockRejectedValueOnce(new Error('D1 network'))
      .mockResolvedValue(undefined);
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(job.qualifiedName)),
        settle,
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [job] },
      observability: recorder().observability,
      ports,
      limits: { settleRetryMs: 1 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});

    expect(calls).toHaveLength(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls.map((call) => call[2])).toEqual([
      { outcome: 'succeeded' },
      { outcome: 'succeeded' },
    ]);
    expect(m.acked()).toBe(1);
  });

  it('acks after the inline settle retry also fails instead of retrying into a storm', async () => {
    const { job } = counting('t');
    const settle = vi.fn(() => Promise.reject(new Error('D1 network')));
    const recorded = recorder();
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(job.qualifiedName)),
        settle,
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [job] },
      observability: recorded.observability,
      ports,
      limits: { settleRetryMs: 1 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});
    expect(settle).toHaveBeenCalledTimes(2);
    expect(m.acked()).toBe(1);
    expect(m.retried()).toEqual([]);
    expect(recorded.logs.map((record) => record.event)).toContain('job.settle_failed');
  });

  it('does not retry a settle rejected with a stale fence', async () => {
    const { job } = counting('t');
    const settle = vi.fn(() => Promise.reject(new StaleFenceError()));
    const recorded = recorder();
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(job.qualifiedName)),
        settle,
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [job] },
      observability: recorded.observability,
      ports,
      limits: { settleRetryMs: 1 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});
    expect(settle).toHaveBeenCalledTimes(1);
    expect(m.acked()).toBe(1);
    expect(recorded.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'job.lease_lost' }),
    );
    expect(recorded.logs.map((record) => record.event)).not.toContain('job.settle_failed');
  });

  it('logs a stale fence on the settle retry as a lease_lost warning', async () => {
    const { job } = counting('t');
    const settle = vi
      .fn<JobRepository['settle']>()
      .mockRejectedValueOnce(new Error('D1 network'))
      .mockRejectedValueOnce(new StaleFenceError());
    const recorded = recorder();
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(job.qualifiedName)),
        settle,
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [job] },
      observability: recorded.observability,
      ports,
      limits: { settleRetryMs: 1 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});
    expect(settle).toHaveBeenCalledTimes(2);
    expect(m.acked()).toBe(1);
    const events = recorded.logs.map((record) => [record.level, record.event]);
    expect(events).toContainEqual(['warn', 'job.lease_lost']);
    expect(events.map(([, event]) => event)).not.toContain('job.settle_failed');
  });

  it('stops on a heartbeat StaleFenceError: signal aborted, no settle, ack', async () => {
    const blocking = blockingJob('fenced');
    const settle = vi.fn(() => Promise.resolve());
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(blocking.job.qualifiedName)),
        settle,
        heartbeat: () => Promise.reject(new StaleFenceError()),
      }),
      jobs: { jobs: [blocking.job] },
      observability: recorder().observability,
      ports,
      limits: { heartbeatMs: 5 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});
    blocking.release();

    expect(blocking.signal()?.aborted).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(m.acked()).toBe(1);
    expect(m.retried()).toEqual([]);
  });

  it('halts locally as lease_lost once the tracked lease passes without a successful heartbeat', async () => {
    const blocking = blockingJob('expiring');
    const settle = vi.fn(() => Promise.resolve());
    const recorded = recorder();
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () =>
          Promise.resolve(
            fakeClaim(blocking.job.qualifiedName, new Date(Date.now() + 40).toISOString()),
          ),
        settle,
        heartbeat: () => Promise.reject(new Error('D1 network')),
      }),
      jobs: { jobs: [blocking.job] },
      observability: recorded.observability,
      ports,
      limits: { heartbeatMs: 5 },
    });
    const m = message(jobNotification(orgA, someJob));
    await handle({ messages: [m] }, {});
    blocking.release();

    expect(blocking.signal()?.aborted).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(m.acked()).toBe(1);
    expect(recorded.logs.map((record) => record.event)).toContain('job.lease_lost');
  });

  it('extends the tracked lease after each successful heartbeat', async () => {
    const job = registerCoreJob({
      name: 'outlives',
      version: 1,
      validate: (input) => input,
      handler: () => new Promise((resolve) => setTimeout(resolve, 80)),
    });
    const settle = vi.fn(() => Promise.resolve());
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () =>
          Promise.resolve(fakeClaim(job.qualifiedName, new Date(Date.now() + 30).toISOString())),
        settle,
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [job] },
      observability: recorder().observability,
      ports,
      limits: { heartbeatMs: 5 },
    });
    await handle({ messages: [message(jobNotification(orgA, someJob))] }, {});
    expect(settle).toHaveBeenCalledWith(orgA, expect.anything(), { outcome: 'succeeded' });
  });
});

describe('concurrent delivery on D1', () => {
  it('runs a blocking handler once when two consumers race on the same id', async () => {
    const f = await fixture();
    const blocking = blockingJob('raced');
    const id = await enqueue(f, blocking.job.qualifiedName, 'k1');
    const first = message(jobNotification(f.ctx, id));
    const second = message(jobNotification(f.ctx, id));

    const one = handlerFor(f, [blocking.job])({ messages: [first] }, {});
    await blocking.running;
    const two = handlerFor(f, [blocking.job])({ messages: [second] }, {});
    await two;
    expect(second.acked()).toBe(1);
    expect(first.acked()).toBe(0);

    blocking.release();
    await one;
    expect(blocking.calls()).toBe(1);
    expect(first.acked()).toBe(1);
    expect((await f.repository.status(f.ctx, id))?.state).toBe('succeeded');
  });
});

describe('producer', () => {
  function fakeQueue() {
    const sent: { body: unknown; options?: unknown }[] = [];
    const batches: unknown[][] = [];
    const queue: QueueLike = {
      send: (body, options) => {
        sent.push(options === undefined ? { body } : { body, options });
        return Promise.resolve();
      },
      sendBatch: (messages) => {
        batches.push(messages.map((item) => item.body));
        return Promise.resolve();
      },
    };
    return { queue, sent, batches };
  }

  it('sends an envelope carrying only version, org id and job id', async () => {
    const { queue, sent } = fakeQueue();
    await createJobSender(queue)(orgA, someJob);
    expect(sent).toEqual([
      { body: { v: JOB_NOTIFICATION_VERSION, org: orgA.orgId, job: someJob } },
    ]);
  });

  it('sends cron pages through sendBatch in chunks of at most 100', async () => {
    const { queue, batches } = fakeQueue();
    const ids = Array.from({ length: 205 }, () => ulid());
    await createJobBatchSender(queue)(orgA, ids);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(ids.map((id) => jobNotification(orgA, id)));
  });

  it('commits the job before sending and survives a failed send', async () => {
    const f = await fixture();
    const order: string[] = [];
    const enqueueJob = enqueueAndNotify({
      repository: f.repository,
      send: (_ctx, id) => {
        order.push(`send:${id}`);
        return Promise.reject(new Error('queue down'));
      },
      observability: recorder().observability,
    });
    const id = ulid();
    const result = await enqueueJob(f.ctx, produced(id, null));
    order.push('returned');

    expect(result).toEqual({ id, created: true });
    expect(order).toEqual([`send:${id}`, 'returned']);
    expect((await f.repository.status(f.ctx, id))?.state).toBe('queued');
  });

  it('passes delaySeconds for a future runAt and leaves runAt beyond the queue limit to Cron', async () => {
    const f = await fixture();
    const calls: { id: string; options: unknown }[] = [];
    const enqueueJob = enqueueAndNotify({
      repository: f.repository,
      send: (_ctx, id, options) => {
        calls.push({ id, options });
        return Promise.resolve();
      },
      observability: recorder().observability,
    });
    const soon = ulid();
    await enqueueJob(f.ctx, produced(soon, new Date(Date.now() + 90_500).toISOString()));
    const later = ulid();
    await enqueueJob(
      f.ctx,
      produced(later, new Date(Date.now() + (QUEUE_MAX_DELAY_SECONDS + 60) * 1000).toISOString()),
    );
    const now = ulid();
    await enqueueJob(f.ctx, produced(now, null));

    expect(calls.map((call) => call.id)).toEqual([soon, now]);
    const delay = (calls[0]?.options as { delaySeconds: number }).delaySeconds;
    expect(delay).toBeGreaterThanOrEqual(92);
    expect(delay).toBeLessThanOrEqual(93);
    expect(calls[1]?.options).toBeUndefined();
  });
});

function produced(id: string, runAt: string | null) {
  return {
    id,
    type: 'core:produced:v1',
    payloadJson: '{}',
    idempotencyKey: `core:produced:v1:${id}`,
    resourceKey: null,
    runAt,
    maxAttempts: 5,
    projectId: null,
    initiatorTokenId: null,
  };
}

function scheduleStub(overrides: Partial<JobScheduleRepository> = {}): JobScheduleRepository {
  return {
    upsert: () => Promise.resolve(),
    sync: () => Promise.resolve(),
    disable: () => Promise.resolve(),
    tick: () => Promise.resolve([]),
    ...overrides,
  };
}

describe('createScheduledHandler', () => {
  it('syncs once, creates due schedule jobs, reaps expired leases and sends a bounded page', async () => {
    const f = await fixture();
    const { job } = counting('tick');
    const sent: string[] = [];
    const sync = vi.spyOn(f.schedule, 'sync');
    const reap = vi.spyOn(f.repository, 'reap');
    const listDue = vi.spyOn(f.repository, 'listDue');

    const expired = await enqueue(f, job.qualifiedName, 'expired');
    await f.repository.claim(f.ctx, ulid(), {
      id: expired,
      types: [job.qualifiedName],
      leaseSeconds: 60,
      maxRunning: 2,
    });
    await f.exec('UPDATE job SET lease_until = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      expired,
    ]);

    const sendJobs = vi.fn((_ctx: OrgContext, ids: readonly string[]) => {
      sent.push(...ids);
      return Promise.resolve();
    });
    const scheduled = createScheduledHandler({
      repository: f.repository,
      schedule: f.schedule,
      sendJobs,
      org: () => Promise.resolve(f.ctx),
      definitions: [{ name: job.qualifiedName, everySeconds: 60 }],
      types: [job.qualifiedName],
      observability: recorder().observability,
    });

    await scheduled({}, {});
    await f.exec('UPDATE job_schedule SET next_run_at = ? WHERE name = ?', [
      '2000-01-01T00:00:00.000Z',
      job.qualifiedName,
    ]);
    sent.length = 0;
    sendJobs.mockClear();
    await scheduled({}, {});

    expect(sync).toHaveBeenCalledTimes(1);
    expect(reap).toHaveBeenCalledTimes(2);
    expect(listDue.mock.calls.map((call) => call[1])).toEqual([
      { types: [job.qualifiedName], limit: CRON_DUE_PAGE_LIMIT },
      { types: [job.qualifiedName], limit: CRON_DUE_PAGE_LIMIT },
    ]);
    expect(CRON_DUE_PAGE_LIMIT).toBe(50);
    expect(sendJobs).toHaveBeenCalledTimes(1);
    const fired = await f.rows("SELECT id FROM job WHERE idempotency_key LIKE 'schedule:%'", []);
    expect(fired).toHaveLength(1);
    expect(sent).toContain(String(fired[0]?.id));
    expect(new Set(sent).size).toBe(sent.length);
    const reaped = await f.repository.status(f.ctx, expired);
    expect(reaped?.state).toBe('queued');
    expect(sent).not.toContain(expired);

    await f.exec('UPDATE job SET run_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', expired]);
    sent.length = 0;
    await scheduled({}, {});
    expect(sent).toContain(expired);
  });

  it('buries day-old unregistered rows so 50 stuck rows no longer hide a newer due job', async () => {
    const f = await fixture();
    const { job } = counting('live');
    const stuck: string[] = [];
    for (let i = 0; i < 50; i += 1) stuck.push(await enqueue(f, 'acme:gone:v1', `s${i}`));
    for (const id of stuck) {
      await f.exec('UPDATE job SET run_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', id]);
    }
    const fresh = await enqueue(f, job.qualifiedName, 'fresh');
    const sent: string[] = [];
    const recorded = recorder();
    const scheduled = createScheduledHandler({
      repository: f.repository,
      schedule: f.schedule,
      sendJobs: (_ctx, ids) => {
        sent.push(...ids);
        return Promise.resolve();
      },
      org: () => Promise.resolve(f.ctx),
      definitions: [],
      types: [job.qualifiedName],
      observability: recorded.observability,
    });
    await scheduled({}, {});

    expect(sent).toEqual([fresh]);
    const dead = await f.rows(
      "SELECT count(*) AS n FROM job WHERE state = 'dead' AND last_error = 'unknown_job_type'",
      [],
    );
    expect(Number(dead[0]?.n)).toBe(50);
    expect(recorded.logs).toContainEqual(
      expect.objectContaining({
        event: 'job.unregistered_buried',
        reason_code: 'job.unregistered_type',
      }),
    );
  });

  it('caps the page at the due limit and sends it as one batch', async () => {
    const batches: (readonly string[])[] = [];
    const scheduled = createScheduledHandler({
      repository: fakeRepository({
        reap: () => Promise.resolve(0),
        buryUnregistered: () => Promise.resolve(0),
        listDue: (_ctx, input) =>
          Promise.resolve(Array.from({ length: input.limit }, (_, i) => `due-${i}`)),
      }),
      schedule: scheduleStub({
        tick: () =>
          Promise.resolve(
            Array.from({ length: 10 }, (_, i) => ({ name: 'x', jobId: `fired-${i}` })),
          ),
      }),
      sendJobs: (_ctx, ids) => {
        batches.push(ids);
        return Promise.resolve();
      },
      org: () => Promise.resolve(orgA),
      definitions: [],
      types: ['core:x:v1'],
      observability: recorder().observability,
    });
    await scheduled({}, {});
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(CRON_DUE_PAGE_LIMIT);
  });

  it('never rejects and keeps going when each step fails', async () => {
    const recorded = recorder();
    const sendJobs = vi.fn(() => Promise.reject(new Error('send down')));
    const scheduled = createScheduledHandler({
      repository: fakeRepository({
        reap: () => Promise.reject(new Error('reap down')),
        buryUnregistered: () => Promise.reject(new Error('bury down')),
        listDue: () => Promise.resolve(['a', 'b']),
      }),
      schedule: scheduleStub({
        sync: () => Promise.reject(new Error('sync down')),
        tick: () => Promise.reject(new Error('tick down')),
      }),
      sendJobs,
      org: () => Promise.resolve(orgA),
      definitions: [],
      types: ['core:x:v1'],
      observability: recorded.observability,
    });
    await expect(scheduled({}, {})).resolves.toBeUndefined();
    expect(sendJobs).toHaveBeenCalledWith(orgA, ['a', 'b']);
    const events = recorded.logs.map((record) => record.event);
    for (const event of [
      'job.schedule_sync_failed',
      'job.reap_failed',
      'job.bury_failed',
      'job.notify_failed',
    ]) {
      expect(events).toContain(event);
    }
  });

  it('never buries when no job type is registered', async () => {
    const bury = vi.fn(() => Promise.resolve(0));
    await createScheduledHandler({
      repository: fakeRepository({
        reap: () => Promise.resolve(0),
        buryUnregistered: bury,
        listDue: () => Promise.resolve([]),
      }),
      schedule: scheduleStub(),
      sendJobs: () => Promise.resolve(),
      org: () => Promise.resolve(orgA),
      definitions: [],
      types: [],
      observability: recorder().observability,
    })({}, {});
    expect(bury).not.toHaveBeenCalled();
  });

  it('retries sync on the next tick after a failure and does nothing without an organization', async () => {
    const sync = vi
      .fn<JobScheduleRepository['sync']>()
      .mockRejectedValueOnce(new Error('sync down'))
      .mockResolvedValue(undefined);
    let org: OrgContext | null = null;
    const scheduled = createScheduledHandler({
      repository: fakeRepository({
        reap: () => Promise.resolve(0),
        buryUnregistered: () => Promise.resolve(0),
        listDue: () => Promise.resolve([]),
      }),
      schedule: scheduleStub({ sync }),
      sendJobs: () => Promise.resolve(),
      org: () => Promise.resolve(org),
      definitions: [],
      types: [],
      observability: recorder().observability,
    });
    await scheduled({}, {});
    expect(sync).not.toHaveBeenCalled();
    org = orgA;
    await scheduled({}, {});
    await scheduled({}, {});
    await scheduled({}, {});
    expect(sync).toHaveBeenCalledTimes(2);
  });
});

describe('observability registry', () => {
  it('every job event and reason code passes the real registry without pb.obs.dropped', async () => {
    const records: ObsRecord[] = [];
    const observability = createObservability(
      { emit: (record) => records.push(record) },
      { deploymentId: 'test', runtime: 'cloudflare', requestId: null },
      {
        events: new Set<string>(JOB_EVENTS),
        reasonCodes: new Set<string>(JOB_REASON_CODES),
        routeTemplates: new Set<string>(),
      },
    );
    const { job } = counting('observed');
    const failing = counting('observed-fail', () => Promise.reject(new Error('boom'))).job;
    const blocking = blockingJob('observed-lease');

    const consumers = [
      createQueueHandler({
        repository: fakeRepository({ claim: () => Promise.reject(new Error('D1 network')) }),
        jobs: { jobs: [job] },
        observability,
        ports,
      }),
      createQueueHandler({
        repository: fakeRepository({
          claim: () => Promise.resolve(fakeClaim(failing.qualifiedName)),
          settle: () => Promise.reject(new Error('D1 network')),
          heartbeat: () => Promise.resolve(),
        }),
        jobs: { jobs: [failing] },
        observability,
        ports,
        limits: { settleRetryMs: 1 },
      }),
      createQueueHandler({
        repository: fakeRepository({
          claim: () =>
            Promise.resolve(
              fakeClaim(blocking.job.qualifiedName, new Date(Date.now() + 40).toISOString()),
            ),
          heartbeat: () => Promise.reject(new Error('D1 network')),
        }),
        jobs: { jobs: [blocking.job] },
        observability,
        ports,
        limits: { heartbeatMs: 5 },
      }),
    ];
    for (const handle of consumers) {
      await handle(
        {
          messages: [
            message(jobNotification(orgA, someJob)),
            message({ v: 9 }),
            message(jobNotification(orgA, someJob), { throwOnAck: true }),
          ],
        },
        {},
      );
    }
    blocking.release();

    await createScheduledHandler({
      repository: fakeRepository({
        reap: () => Promise.reject(new Error('reap down')),
        buryUnregistered: () => Promise.resolve(3),
        listDue: () => Promise.reject(new Error('scan down')),
      }),
      schedule: scheduleStub({ tick: () => Promise.resolve([{ name: 'x', jobId: someJob }]) }),
      sendJobs: () => Promise.reject(new Error('send down')),
      org: () => Promise.resolve(orgA),
      definitions: [],
      types: ['core:x:v1'],
      observability,
    })({}, {});
    await createScheduledHandler({
      repository: fakeRepository({}),
      schedule: scheduleStub({ sync: () => Promise.reject(new Error('sync down')) }),
      sendJobs: () => Promise.resolve(),
      org: () => Promise.resolve(orgA),
      definitions: [],
      types: [],
      observability,
    })({}, {});

    const dropped = records.filter(
      (record) => record.kind === 'counter' && record.name === DROPPED_COUNTER,
    );
    expect(dropped).toEqual([]);
    const events = new Set(
      records.flatMap((record) => (record.kind === 'log' ? [record.record.event] : [])),
    );
    for (const event of [
      'job.claim_failed',
      'job.notification_rejected',
      'job.ack_failed',
      'job.handler_failed',
      'job.settle_failed',
      'job.heartbeat_failed',
      'job.lease_lost',
      'job.reap_failed',
      'job.unregistered_buried',
      'job.due_scan_failed',
      'job.notify_failed',
      'job.schedule_sync_failed',
    ]) {
      expect(events).toContain(event);
    }
    for (const event of events) expect(JOB_EVENTS).toContain(event);
  });

  it('job logs keep job_id and attempt through a per-job scoped observability', async () => {
    const records: ObsRecord[] = [];
    const registry = {
      events: new Set<string>(JOB_EVENTS),
      reasonCodes: new Set<string>(JOB_REASON_CODES),
      routeTemplates: new Set<string>(),
    };
    const sink = { emit: (record: ObsRecord) => records.push(record) };
    const scope = { deploymentId: 'test', runtime: 'cloudflare', requestId: null } as const;
    const failing = counting('scoped-fail', () => Promise.reject(new Error('boom'))).job;
    const handle = createQueueHandler({
      repository: fakeRepository({
        claim: () => Promise.resolve(fakeClaim(failing.qualifiedName)),
        settle: () => Promise.resolve(),
        heartbeat: () => Promise.resolve(),
      }),
      jobs: { jobs: [failing] },
      observability: createObservability(sink, scope, registry),
      forJob: ({ jobId, attempt }) =>
        createObservability(sink, { ...scope, jobId, attempt }, registry),
      ports,
    });
    await handle({ messages: [message(jobNotification(orgA, someJob))] }, {});

    const logs = records.flatMap((record) => (record.kind === 'log' ? [record.record] : []));
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'job.handler_failed', job_id: someJob, attempt: 1 }),
    );
    expect(
      records.some((record) => record.kind === 'counter' && record.name === DROPPED_COUNTER),
    ).toBe(false);
  });
});
