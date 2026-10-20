import { describe, expect, it, vi } from 'vitest';
import { fenceKind, type DelegatedMutationFence } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { systemClock, ulid } from '../ids.js';
import { jobFences } from '../platform/job-fences.js';
import { JobError, type JobContext } from '../platform/jobs.js';
import { importApplyJob, importRollbackJob } from './jobs.js';
import { IMPORT_RUN_JOB } from './run-service.js';

const RUN = ulid();
const USER = ulid();
const LEASE = { id: '01J0000000000000000000JOB1', owner: '01J0000000000000000000OWN1', fence: 2 };

function spyStore() {
  const calls: string[] = [];
  const store = new Proxy(
    {},
    {
      get: (_target, name) => () => {
        calls.push(String(name));
        return Promise.resolve(null);
      },
    },
  );
  return { store, calls };
}

function context(fences?: JobContext['fences']): JobContext {
  return {
    org: orgContext('01J0000000000000000000ORG1'),
    jobId: LEASE.id,
    idempotencyKey: 'k',
    attempt: 1,
    fence: LEASE.fence,
    signal: new AbortController().signal,
    ports: {} as JobContext['ports'],
    observability: {} as JobContext['observability'],
    ...(fences === undefined ? {} : { fences }),
  };
}

function deps() {
  const spy = spyStore();
  return {
    spy,
    apply: {
      store: spy.store,
      blobs: { get: () => Promise.resolve(null) },
      clock: systemClock,
      ids: { ulid },
    } as unknown as Parameters<typeof importApplyJob>[0],
    rollback: { store: spy.store, clock: systemClock, ids: { ulid } } as unknown as Parameters<
      typeof importRollbackJob
    >[0],
  };
}

describe('import jobs', () => {
  it('qualify to the names the run service enqueues', () => {
    const d = deps();
    const apply = importApplyJob(d.apply);
    const rollback = importRollbackJob(d.rollback);
    expect(`core:${apply.name}:v${apply.version}`).toBe(IMPORT_RUN_JOB.apply);
    expect(`core:${rollback.name}:v${rollback.version}`).toBe(IMPORT_RUN_JOB.rollback);
  });

  it('apply validate accepts exactly { runId: ULID }', () => {
    const job = importApplyJob(deps().apply);
    expect(job.validate({ runId: RUN })).toEqual({ runId: RUN });
    expect(() => job.validate({ runId: RUN, extra: 1 })).toThrow();
    expect(() => job.validate({ runId: 'not-a-ulid' })).toThrow();
    expect(() => job.validate({})).toThrow();
    expect(() => job.validate(null)).toThrow();
    expect(() => job.validate([RUN])).toThrow();
  });

  it('rollback validate accepts exactly { runId: ULID, requestedBy: ULID }', () => {
    const job = importRollbackJob(deps().rollback);
    expect(job.validate({ runId: RUN, requestedBy: USER })).toEqual({
      runId: RUN,
      requestedBy: USER,
    });
    expect(() => job.validate({ runId: RUN })).toThrow();
    expect(() => job.validate({ runId: RUN, requestedBy: USER, extra: 1 })).toThrow();
    expect(() => job.validate({ runId: 'x', requestedBy: USER })).toThrow();
    expect(() => job.validate({ runId: RUN, requestedBy: 'x' })).toThrow();
  });

  it.each([
    ['apply', (d: ReturnType<typeof deps>) => importApplyJob(d.apply), { runId: RUN }],
    [
      'rollback',
      (d: ReturnType<typeof deps>) => importRollbackJob(d.rollback),
      { runId: RUN, requestedBy: USER },
    ],
  ])(
    '%s without context.fences throws handler_error and makes no store call',
    async (_n, build, payload) => {
      const d = deps();
      const job = build(d) as { handler: (p: unknown, c: JobContext) => Promise<void> };
      const error = await job.handler(payload, context()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JobError);
      expect((error as JobError).code).toBe('handler_error');
      expect(d.spy.calls).toEqual([]);
    },
  );

  it('apply with fences reaches the store with the context org', async () => {
    const d = deps();
    const load = vi.fn(() => Promise.resolve(null));
    const job = importApplyJob({ ...d.apply, store: { loadRun: load } as never });
    await job.handler({ runId: RUN }, context(jobFences(LEASE)));
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '01J0000000000000000000ORG1' }),
      RUN,
    );
  });

  it('rollback with fences reaches the store with the context org', async () => {
    const d = deps();
    const load = vi.fn(() => Promise.resolve(null));
    const job = importRollbackJob({ ...d.rollback, store: { loadRun: load } as never });
    await job.handler({ runId: RUN, requestedBy: USER }, context(jobFences(LEASE)));
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '01J0000000000000000000ORG1' }),
      RUN,
    );
  });

  it('apply hands the store a delegated fence bound to the context lease', async () => {
    const d = deps();
    const fences: unknown[] = [];
    const store = {
      loadRun: () =>
        Promise.resolve({
          id: RUN,
          state: 'applying',
          planHash: null,
          approvedAt: new Date().toISOString(),
          approvedByUserId: USER,
          manifestBlobSha256: null,
        }),
      finish: (_ctx: unknown, fence: unknown) => {
        fences.push(fence);
        return Promise.resolve();
      },
    };
    const job = importApplyJob({ ...d.apply, store: store as never });
    await job.handler({ runId: RUN }, context(jobFences(LEASE)));
    expect(fences).toHaveLength(1);
    const fence = fences[0] as DelegatedMutationFence;
    expect(fenceKind(fence)).toBe('delegated');
    expect(fence.job).toEqual(LEASE);
    expect(fence.approverUserId).toBe(USER);
    expect(fence.runId).toBe(RUN);
  });
});
