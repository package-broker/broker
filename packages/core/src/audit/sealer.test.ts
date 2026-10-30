import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { AUDIT_EVENTS, KERNEL_EVENTS, KERNEL_REASON_CODES } from '../kernel/obs-codes.js';
import { registerCoreJob } from '../runtime/core-jobs.js';
import { JobError, type JobContext, type CoreJobs as Jobs } from '../platform/jobs.js';
import { createObservability, type ObsRecord } from '../platform/observability.js';
import { auditSealJob, requestAuditSeal, type SealOutcome } from './sealer.js';

const org = orgContext('org-a');
const sealed: SealOutcome = { outcome: 'sealed', sealed: 4, headSeq: 9, headHash: 'private-hash' };

function context(signal = new AbortController().signal, orgId = 'org-a'): JobContext {
  return {
    org: orgContext(orgId),
    jobId: 'job-a',
    idempotencyKey: 'kick-a',
    attempt: 1,
    fence: 1,
    signal,
    ports: {} as JobContext['ports'],
    observability: { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() },
  };
}

function jobs() {
  return {
    async enqueueStatements() {
      throw new Error('not_implemented');
    },

    enqueue: vi.fn<Jobs['enqueue']>().mockResolvedValue({ id: 'job-a', created: true }),
    get: vi.fn<Jobs['get']>(),
  };
}

describe('auditSealJob', () => {
  it('registers the scheduled core job with three attempts', () => {
    const job = auditSealJob({ seal: vi.fn() });
    expect(registerCoreJob(job).qualifiedName).toBe('core:audit-seal:v1');
    expect(job).toMatchObject({
      name: 'audit-seal',
      version: 1,
      schedule: { everySeconds: 60 },
      maxAttempts: 3,
    });
    expect(job.validate({})).toEqual({});
  });

  it.each([
    ['unknown field x', { x: 1 }],
    ['null', null],
    ['undefined', undefined],
    ['string', ''],
    ['number', 0],
    ['boolean', false],
    ['array', []],
    ['class instance', new Date(0)],
    ['inherited field', Object.create({ x: 1 }) as unknown],
    ['symbol field', { [Symbol('x')]: 1 }],
    ['non-enumerable field', Object.defineProperty({}, 'x', { value: 1 })],
  ])('rejects payload with %s', (_name, input) => {
    const job = auditSealJob({ seal: vi.fn() });
    expect(() => job.validate(input)).toThrowError(new JobError('invalid_payload'));
  });

  it('drains sealed batches until empty and reports counts as metrics', async () => {
    const seal = vi
      .fn()
      .mockResolvedValueOnce(sealed)
      .mockResolvedValueOnce(sealed)
      .mockResolvedValue({ outcome: 'empty' });
    const ctx = context();
    await auditSealJob({ seal }).handler({}, ctx);
    expect(seal.mock.calls).toEqual([[ctx.org], [ctx.org], [ctx.org]]);
    expect(ctx.observability.log).toHaveBeenCalledExactlyOnceWith({
      level: 'info',
      event: 'audit.sealed',
    });
    expect(ctx.observability.counter).toHaveBeenCalledWith('audit_sealed_total', undefined, 8);
    expect(ctx.observability.counter).toHaveBeenCalledWith('audit_seal_rounds_total', undefined, 2);
  });

  it('returns after the first contended answer without failing', async () => {
    const seal = vi.fn().mockResolvedValue({ outcome: 'contended' });
    await expect(auditSealJob({ seal }).handler({}, context())).resolves.toBeUndefined();
    expect(seal).toHaveBeenCalledTimes(1);
  });

  it('bounds a perpetually productive port to ten rounds', async () => {
    const seal = vi.fn().mockImplementation(() => {
      if (seal.mock.calls.length > 11) throw new Error('unbounded seal');
      return Promise.resolve(sealed);
    });
    await auditSealJob({ seal }).handler({}, context());
    expect(seal).toHaveBeenCalledTimes(10);
  });

  it('does not call the port when already aborted', async () => {
    const seal = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await auditSealJob({ seal }).handler({}, context(controller.signal));
    expect(seal).not.toHaveBeenCalled();
  });

  it('stops before the next round when aborted during a seal', async () => {
    const controller = new AbortController();
    const seal = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(sealed);
    });
    await auditSealJob({ seal }).handler({}, context(controller.signal));
    expect(seal).toHaveBeenCalledTimes(1);
  });

  it('propagates seal failures for job retries', async () => {
    const error = new Error('seal failed');
    const seal = vi.fn().mockRejectedValue(error);
    await expect(auditSealJob({ seal }).handler({}, context())).rejects.toBe(error);
  });

  it('reports committed counts when the second batch fails and propagates the error', async () => {
    const error = new Error('seal failed');
    const seal = vi.fn().mockResolvedValueOnce(sealed).mockRejectedValueOnce(error);
    const ctx = context();

    await expect(auditSealJob({ seal }).handler({}, ctx)).rejects.toBe(error);

    expect(seal.mock.calls).toEqual([[ctx.org], [ctx.org]]);
    expect(ctx.observability.counter).toHaveBeenCalledTimes(2);
    expect(ctx.observability.counter).toHaveBeenCalledWith('audit_sealed_total', undefined, 4);
    expect(ctx.observability.counter).toHaveBeenCalledWith('audit_seal_rounds_total', undefined, 1);
  });

  it('reports persistent contention on the third run and retries only on a new run', async () => {
    const seal = vi.fn().mockResolvedValue({ outcome: 'contended' });
    const job = auditSealJob({ seal });
    const ctx = context();
    await job.handler({}, ctx);
    await job.handler({}, ctx);
    expect(ctx.observability.log).not.toHaveBeenCalled();
    await job.handler({}, ctx);
    expect(seal).toHaveBeenCalledTimes(3);
    expect(ctx.observability.log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'audit.seal.contended',
    });
    expect(ctx.observability.counter).toHaveBeenCalledWith('audit_seal_contended_total');
    expect(
      vi
        .mocked(ctx.observability.counter)
        .mock.calls.filter(([name]) => name === 'audit_seal_contended_total'),
    ).toHaveLength(3);
    await job.handler({}, ctx);
    expect(seal).toHaveBeenCalledTimes(4);
    expect(ctx.observability.log).toHaveBeenCalledTimes(2);
  });

  it('counts contention independently by organization across distinct contexts', async () => {
    const seal = vi.fn().mockResolvedValue({ outcome: 'contended' });
    const job = auditSealJob({ seal });
    await job.handler({}, context());
    await job.handler({}, context());
    const other = context(undefined, 'org-b');
    await job.handler({}, other);
    expect(other.observability.log).not.toHaveBeenCalled();
    const third = context();
    await job.handler({}, third);
    expect(third.observability.log).toHaveBeenCalledOnce();
  });

  it.each(['sealed', 'empty'] as const)(
    'resets consecutive contention after %s',
    async (outcome) => {
      const seal = vi.fn().mockResolvedValue({ outcome: 'contended' });
      const job = auditSealJob({ seal });
      const ctx = context();
      await job.handler({}, ctx);
      await job.handler({}, ctx);
      if (outcome === 'sealed') seal.mockResolvedValueOnce(sealed);
      else seal.mockResolvedValueOnce({ outcome: 'empty' });
      await job.handler({}, ctx);
      await job.handler({}, ctx);
      expect(ctx.observability.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'audit.seal.contended' }),
      );
    },
  );
});

describe('auditSealJob through the real observability port', () => {
  function observedContext() {
    const records: ObsRecord[] = [];
    const ctx: JobContext = {
      ...context(),
      observability: createObservability(
        { emit: (record) => void records.push(record) },
        { deploymentId: 'test', runtime: 'node', requestId: null, jobId: 'job-a' },
        {
          events: new Set([...KERNEL_EVENTS, ...AUDIT_EVENTS]),
          reasonCodes: KERNEL_REASON_CODES,
          routeTemplates: new Set(),
        },
      ),
    };
    return { ctx, records };
  }

  it('emits the registered sealed event', async () => {
    const seal = vi.fn().mockResolvedValueOnce(sealed).mockResolvedValue({ outcome: 'empty' });
    const { ctx, records } = observedContext();
    await auditSealJob({ seal }).handler({}, ctx);
    expect(records.filter((record) => record.kind === 'log')).toEqual([
      {
        kind: 'log',
        record: expect.objectContaining({ level: 'info', event: 'audit.sealed', job_id: 'job-a' }),
      },
    ]);
    expect(records).not.toContainEqual(expect.objectContaining({ name: 'pb.obs.dropped' }));
  });

  it('emits a registered warning only after three consecutive contended runs', async () => {
    const seal = vi.fn().mockResolvedValue({ outcome: 'contended' });
    const job = auditSealJob({ seal });
    const { ctx, records } = observedContext();
    await job.handler({}, ctx);
    await job.handler({}, ctx);
    expect(records.filter((record) => record.kind === 'log')).toEqual([]);
    await job.handler({}, ctx);
    expect(records.filter((record) => record.kind === 'log')).toEqual([
      {
        kind: 'log',
        record: expect.objectContaining({ level: 'warn', event: 'audit.seal.contended' }),
      },
    ]);
    expect(records).not.toContainEqual(expect.objectContaining({ name: 'pb.obs.dropped' }));
    expect(
      records.filter(
        (record) => record.kind === 'counter' && record.name === 'audit_seal_contended_total',
      ),
    ).toEqual([
      { kind: 'counter', name: 'audit_seal_contended_total', labels: {}, value: 1 },
      { kind: 'counter', name: 'audit_seal_contended_total', labels: {}, value: 1 },
      { kind: 'counter', name: 'audit_seal_contended_total', labels: {}, value: 1 },
    ]);
  });

  it('preserves sealed counts and productive rounds as metrics on every run', async () => {
    const seal = vi
      .fn()
      .mockResolvedValueOnce(sealed)
      .mockResolvedValueOnce(sealed)
      .mockResolvedValue({ outcome: 'empty' });
    const job = auditSealJob({ seal });
    const { ctx, records } = observedContext();
    await job.handler({}, ctx);
    await job.handler({}, ctx);
    expect(
      records.filter((record) => record.kind === 'counter' && record.name === 'audit_sealed_total'),
    ).toEqual([
      { kind: 'counter', name: 'audit_sealed_total', labels: {}, value: 8 },
      { kind: 'counter', name: 'audit_sealed_total', labels: {}, value: 0 },
    ]);
    expect(
      records.filter(
        (record) => record.kind === 'counter' && record.name === 'audit_seal_rounds_total',
      ),
    ).toEqual([
      { kind: 'counter', name: 'audit_seal_rounds_total', labels: {}, value: 2 },
      { kind: 'counter', name: 'audit_seal_rounds_total', labels: {}, value: 0 },
    ]);
  });
});

describe('requestAuditSeal', () => {
  it('enqueues the core job with an empty payload and single-flight resource', async () => {
    const port = jobs();
    await expect(requestAuditSeal(port, org, new Date('2026-10-18T12:34:00Z'))).resolves.toBe(true);
    expect(port.enqueue).toHaveBeenCalledExactlyOnceWith(
      org,
      'core:audit-seal:v1',
      {},
      { idempotencyKey: 'audit-seal:2026-10-18T12:34', resourceKey: 'audit-seal' },
    );
  });

  it('collapses kicks in the same UTC minute', async () => {
    const port = jobs();
    await requestAuditSeal(port, org, new Date('2026-10-18T12:34:00Z'));
    await requestAuditSeal(port, org, new Date('2026-10-18T14:34:59.999+02:00'));
    expect(port.enqueue.mock.calls[0]?.[3].idempotencyKey).toBe(
      port.enqueue.mock.calls[1]?.[3].idempotencyKey,
    );
  });

  it('uses a new key at the next minute', async () => {
    const port = jobs();
    await requestAuditSeal(port, org, new Date('2026-10-18T23:59:59.999Z'));
    await requestAuditSeal(port, org, new Date('2026-10-19T00:00:00Z'));
    expect(port.enqueue.mock.calls[0]?.[3].idempotencyKey).not.toBe(
      port.enqueue.mock.calls[1]?.[3].idempotencyKey,
    );
  });

  it('returns true for an existing collapsed job', async () => {
    const port = jobs();
    port.enqueue.mockResolvedValue({ id: 'job-a', created: false });
    await expect(requestAuditSeal(port, org, new Date())).resolves.toBe(true);
  });

  it('returns false when enqueue rejects', async () => {
    const port = jobs();
    port.enqueue.mockRejectedValue(new Error('enqueue failed'));
    await expect(requestAuditSeal(port, org, new Date())).resolves.toBe(false);
  });

  it('returns false when enqueue throws synchronously', async () => {
    const port = jobs();
    port.enqueue.mockImplementation(() => {
      throw new Error('enqueue failed');
    });
    await expect(requestAuditSeal(port, org, new Date())).resolves.toBe(false);
  });

  it('returns false for an invalid clock without enqueueing', async () => {
    const port = jobs();
    await expect(requestAuditSeal(port, org, new Date(NaN))).resolves.toBe(false);
    expect(port.enqueue).not.toHaveBeenCalled();
  });
});
