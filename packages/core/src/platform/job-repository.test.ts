import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OrgContext } from '../db/port.js';
import type { PluginPorts } from '../plugin.js';
import { JobError, jobErrorCode, type JobAttemptOutcome, type JobStatus } from './jobs.js';
import {
  IdempotencyConflictError,
  JOB_ATTEMPT_OUTCOMES,
  JOB_HANDLER_BUDGET_SECONDS,
  JOB_HEARTBEAT_SECONDS,
  JOB_LEASE_SECONDS,
  JOB_REAP_PAGE_LIMIT,
  JOB_RELEASE_DELAY_SECONDS,
  JOB_STATUS_HISTORY_LIMIT,
  StaleFenceError,
  type JobClaim,
  type JobGuard,
  type JobRepository,
  type JobSettle,
} from './job-repository.js';

describe('job repository errors', () => {
  it.each([
    { Ctor: StaleFenceError, name: 'StaleFenceError', code: 'lease_lost' },
    {
      Ctor: IdempotencyConflictError,
      name: 'IdempotencyConflictError',
      code: 'idempotency_conflict',
    },
  ] as const)('$name carries the fixed code', ({ Ctor, name, code }) => {
    const error = new Ctor();
    expect(error).toBeInstanceOf(Ctor);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.message).toBe(code);
    expect(jobErrorCode(error)).toBe(code);
  });
});

describe('job repository constants', () => {
  it('holds the lease timing contract', () => {
    expect([
      JOB_LEASE_SECONDS,
      JOB_HEARTBEAT_SECONDS,
      JOB_HANDLER_BUDGET_SECONDS,
      JOB_RELEASE_DELAY_SECONDS,
      JOB_STATUS_HISTORY_LIMIT,
      JOB_REAP_PAGE_LIMIT,
    ]).toEqual([60, 20, 240, 60, 20, 50]);
    expect(JOB_HEARTBEAT_SECONDS * 3).toBe(JOB_LEASE_SECONDS);
    expect(JOB_HANDLER_BUDGET_SECONDS % JOB_HEARTBEAT_SECONDS).toBe(0);
  });

  it('lists the attempt outcomes in CHECK order', () => {
    expect(Object.isFrozen(JOB_ATTEMPT_OUTCOMES)).toBe(true);
    expect(JOB_ATTEMPT_OUTCOMES).toEqual([
      'running',
      'succeeded',
      'failed',
      'lease_expired',
      'released',
    ]);
    expect(new Set(JOB_ATTEMPT_OUTCOMES).size).toBe(5);
    expectTypeOf<
      Exclude<JobAttemptOutcome, (typeof JOB_ATTEMPT_OUTCOMES)[number]>
    >().toEqualTypeOf<never>();
  });
});

describe('job repository types', () => {
  it('constrains settle outcomes', () => {
    expectTypeOf<{ outcome: 'succeeded' }>().toExtend<JobSettle>();
    // @ts-expect-error failed needs errorCode and permanent
    const failed: JobSettle = { outcome: 'failed' };
    // @ts-expect-error released needs delaySeconds
    const released: JobSettle = { outcome: 'released' };
    // @ts-expect-error dead is not a settle outcome
    const dead: JobSettle = { outcome: 'dead' };
    expect([failed, released, dead]).toHaveLength(3);
  });

  it('keeps JobClaim a JobGuard and the repository complete', async () => {
    expectTypeOf<JobClaim>().toExtend<JobGuard>();
    const repo: JobRepository = {
      enqueue: () => Promise.resolve({ id: 'a', created: true }),
      status: () => Promise.resolve(null as JobStatus | null),
      claim: () => Promise.resolve(null),
      heartbeat: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      reap: () => Promise.resolve(0),
    };
    expect(await repo.reap(undefined as unknown as OrgContext, 1)).toBe(0);
    expectTypeOf<'enqueue' | 'status' | 'claim' | 'heartbeat' | 'settle' | 'reap'>().toExtend<
      keyof JobRepository
    >();
    expectTypeOf<
      Extract<keyof JobRepository, `schedule${string}` | `tick${string}`>
    >().toEqualTypeOf<never>();
    expectTypeOf<keyof PluginPorts & ('jobRepository' | 'JobRepository')>().toEqualTypeOf<never>();
    expectTypeOf<PluginPorts[keyof PluginPorts]>().not.toExtend<JobRepository>();
    expectTypeOf<JobRepository['claim']>().parameters.toEqualTypeOf<
      [
        OrgContext,
        string,
        {
          readonly id?: string;
          readonly types: readonly string[];
          readonly leaseSeconds: number;
          readonly maxRunning: number;
        },
      ]
    >();
    expectTypeOf<JobRepository['settle']>().parameters.toEqualTypeOf<
      [OrgContext, JobGuard, JobSettle]
    >();
    expectTypeOf<JobRepository['heartbeat']>().parameters.toEqualTypeOf<[OrgContext, JobGuard]>();
    expectTypeOf<ReturnType<JobRepository['enqueue']>>().toEqualTypeOf<
      Promise<{ readonly id: string; readonly created: boolean }>
    >();
  });
});
