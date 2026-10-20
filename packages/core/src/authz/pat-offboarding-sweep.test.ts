import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock, type Clock } from '../ids.js';
import { JobError, type JobContext, type Jobs } from '../platform/jobs.js';
import { PAT_OFFBOARDING_JOB_TYPE } from './pat-offboarding.js';
import {
  createPatOffboardingSweepJob,
  PAT_OFFBOARDING_SWEEP_MAX_PAGES,
  PAT_OFFBOARDING_SWEEP_PAGE_SIZE,
  type PatOffboardingSweepStore,
} from './pat-offboarding-sweep.js';

const NOW = '2026-10-20T23:59:59.999Z';
const ORG = '01J00000000000000000000A0A';
const ctx = orgContext(ORG);

function userId(n: number): string {
  return `01J0USER${String(n).padStart(18, '0')}`;
}

function context(signal = new AbortController().signal): JobContext {
  return {
    org: ctx,
    jobId: 'job-sweep',
    idempotencyKey: 'k',
    attempt: 1,
    fence: 1,
    signal,
    ports: {} as JobContext['ports'],
    observability: {} as JobContext['observability'],
  };
}

function setup(
  options: {
    users?: readonly string[];
    clock?: Clock;
    enqueue?: Jobs['enqueue'];
    log?: (entry: Readonly<Record<string, unknown>>) => void;
  } = {},
) {
  const all = options.users ?? [];
  const suspendedUsersWithLivePats = vi.fn(async (_ctx: unknown, afterId: string, limit: number) =>
    all.filter((id) => id > afterId).slice(0, limit),
  );
  const store: PatOffboardingSweepStore = { suspendedUsersWithLivePats };
  const enqueue = vi.fn(
    options.enqueue ?? (async () => ({ id: 'job-1', created: true })),
  ) as unknown as Jobs['enqueue'] & ReturnType<typeof vi.fn>;
  const entries: Record<string, unknown>[] = [];
  const job = createPatOffboardingSweepJob({
    store,
    jobs: { enqueue },
    clock: options.clock ?? fixedClock(NOW),
    log: options.log ?? ((entry) => entries.push({ ...entry })),
  });
  const run = (input: unknown = {}, jobContext = context()) =>
    job.definition.handler(job.definition.validate(input), jobContext);
  return { job, run, enqueue, entries, suspendedUsersWithLivePats };
}

describe('registration', () => {
  it('registers core:pat-offboarding-sweep:v1 on a 86 400 second schedule with three attempts', () => {
    const { job } = setup();

    expect(job.qualifiedName).toBe('core:pat-offboarding-sweep:v1');
    expect(job.definition.schedule).toEqual({ everySeconds: 86_400 });
    expect(job.definition.maxAttempts).toBe(3);
  });

  it('accepts the empty payload', () => {
    const { job } = setup();

    expect(job.definition.validate({})).toEqual({});
  });

  it.each([
    ['a non-empty object', { userId: userId(1) }],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('refuses %s as the payload', (_name, payload) => {
    const { job } = setup();

    expect(() => job.definition.validate(payload)).toThrow(JobError);
    try {
      job.definition.validate(payload);
    } catch (error) {
      expect((error as JobError).code).toBe('invalid_payload');
    }
  });
});

describe('handler', () => {
  it('enqueues the offboarding job once per user with the run date in the key', async () => {
    const { run, enqueue, entries, suspendedUsersWithLivePats } = setup({
      users: [userId(1), userId(2)],
    });

    await run();

    expect(suspendedUsersWithLivePats).toHaveBeenCalledWith(ctx, '', 100);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      ctx,
      PAT_OFFBOARDING_JOB_TYPE,
      { userId: userId(1), cause: 'suspended', cutoff: NOW },
      {
        idempotencyKey: `pat-offboarding:${userId(1)}:suspended:sweep:2026-10-20`,
        resourceKey: `user:${userId(1)}`,
      },
    );
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      ctx,
      PAT_OFFBOARDING_JOB_TYPE,
      { userId: userId(2), cause: 'suspended', cutoff: NOW },
      {
        idempotencyKey: `pat-offboarding:${userId(2)}:suspended:sweep:2026-10-20`,
        resourceKey: `user:${userId(2)}`,
      },
    );
    expect(entries).toEqual([
      { level: 'info', event: 'token.offboarding_sweep', orgId: ORG, enqueued: 2 },
    ]);
  });

  it('enqueues nothing and reports zero when no user qualifies', async () => {
    const { run, enqueue, entries } = setup({ users: [] });

    await run();

    expect(enqueue).not.toHaveBeenCalled();
    expect(entries).toEqual([
      { level: 'info', event: 'token.offboarding_sweep', orgId: ORG, enqueued: 0 },
    ]);
  });

  it('counts only jobs that were newly created', async () => {
    const created = [true, false];
    const { run, entries } = setup({
      users: [userId(1), userId(2)],
      enqueue: async () => ({ id: 'j', created: created.shift() === true }),
    });

    await run();

    expect(entries).toEqual([
      { level: 'info', event: 'token.offboarding_sweep', orgId: ORG, enqueued: 1 },
    ]);
  });

  it('reads the clock once and uses that instant as every cutoff', async () => {
    let reads = 0;
    const clock: Clock = {
      now: () => {
        reads += 1;
        return new Date(Date.parse('2026-10-20T10:00:00.000Z') + reads * 1000);
      },
    };
    const { run, enqueue } = setup({ users: [userId(1), userId(2)], clock });

    await run();

    expect(reads).toBe(1);
    const cutoffs = enqueue.mock.calls.map(
      (call: unknown[]) => (call[2] as { cutoff: string }).cutoff,
    );
    expect(cutoffs).toEqual(['2026-10-20T10:00:01.000Z', '2026-10-20T10:00:01.000Z']);
  });

  it('takes the date of the key from the UTC instant, not a local zone', async () => {
    const { run, enqueue } = setup({
      users: [userId(1)],
      clock: fixedClock('2026-12-31T23:30:00.000Z'),
    });

    await run();

    const input = enqueue.mock.calls[0]?.[3] as { idempotencyKey: string };
    expect(input.idempotencyKey).toBe(`pat-offboarding:${userId(1)}:suspended:sweep:2026-12-31`);
  });

  it('reads the clock before the user query', async () => {
    const order: string[] = [];
    const clock: Clock = {
      now: () => {
        order.push('clock');
        return new Date(NOW);
      },
    };
    const store: PatOffboardingSweepStore = {
      suspendedUsersWithLivePats: async () => {
        order.push('query');
        return [];
      },
    };
    const job = createPatOffboardingSweepJob({
      store,
      jobs: { enqueue: async () => ({ id: 'j', created: true }) },
      clock,
      log: () => undefined,
    });

    await job.definition.handler({}, context());

    expect(order).toEqual(['clock', 'query']);
  });

  it('pages by id cursor in pages of 100 until a short page', async () => {
    const users = Array.from({ length: 250 }, (_, n) => userId(n + 1));
    const { run, enqueue, entries, suspendedUsersWithLivePats } = setup({ users });

    await run();

    expect(PAT_OFFBOARDING_SWEEP_PAGE_SIZE).toBe(100);
    expect(suspendedUsersWithLivePats.mock.calls.map((call) => call[1])).toEqual([
      '',
      userId(100),
      userId(200),
    ]);
    expect(enqueue).toHaveBeenCalledTimes(250);
    expect(entries[0]).toMatchObject({ enqueued: 250 });
  });

  it('stops after 20 pages even when every page is full', async () => {
    const users = Array.from({ length: 2500 }, (_, n) => userId(n + 1));
    const { run, enqueue, suspendedUsersWithLivePats } = setup({ users });

    await run();

    expect(PAT_OFFBOARDING_SWEEP_MAX_PAGES).toBe(20);
    expect(suspendedUsersWithLivePats).toHaveBeenCalledTimes(20);
    expect(enqueue).toHaveBeenCalledTimes(2000);
  });

  it('asks for no further page after an exact multiple ends with an empty page', async () => {
    const users = Array.from({ length: 100 }, (_, n) => userId(n + 1));
    const { run, suspendedUsersWithLivePats } = setup({ users });

    await run();

    expect(suspendedUsersWithLivePats).toHaveBeenCalledTimes(2);
  });

  it('counts an idempotency conflict as not created and continues with the next user', async () => {
    const { run, enqueue, entries } = setup({
      users: [userId(1), userId(2), userId(3)],
      enqueue: async (_ctx, _type, payload) => {
        if ((payload as { userId: string }).userId === userId(2)) {
          throw new JobError('idempotency_conflict');
        }
        return { id: 'j', created: true };
      },
    });

    await run();

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(entries[0]).toMatchObject({ enqueued: 2 });
  });

  it('rethrows any other job error', async () => {
    const { run } = setup({
      users: [userId(1)],
      enqueue: async () => {
        throw new JobError('unknown_job_type');
      },
    });

    await expect(run()).rejects.toMatchObject({ code: 'unknown_job_type' });
  });

  it('stops between enqueues when the signal aborts', async () => {
    const controller = new AbortController();
    const { job, enqueue } = setup({
      users: [userId(1), userId(2)],
      enqueue: async () => {
        controller.abort();
        return { id: 'j', created: true };
      },
    });

    await expect(job.definition.handler({}, context(controller.signal))).rejects.toThrow(JobError);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('lets an enqueue failure fail the run so the schedule retries', async () => {
    const { run } = setup({
      users: [userId(1)],
      enqueue: async () => {
        throw new Error('queue down');
      },
    });

    await expect(run()).rejects.toThrow('queue down');
  });

  it('does not let a failing log sink fail a completed run', async () => {
    const { run, enqueue } = setup({
      users: [userId(1)],
      log: () => {
        throw new Error('sink');
      },
    });

    await expect(run()).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('stops with aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { job, enqueue } = setup({ users: [userId(1)] });

    await expect(job.definition.handler({}, context(controller.signal))).rejects.toThrow(JobError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never puts an e-mail address in a log entry', async () => {
    const { run, entries } = setup({ users: [userId(1)] });

    await run();

    expect(JSON.stringify(entries)).not.toMatch(/@/);
  });
});
