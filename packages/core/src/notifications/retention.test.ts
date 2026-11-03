import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  NotificationDeliveryRecord,
  NotificationRepairCandidate,
  NotificationRetentionRepository,
} from '../db/notifications.js';
import { jobFences } from '../platform/job-fences.js';
import type { JobContext } from '../platform/jobs.js';
import { CREATED, DELIVERY, LEASE, ORG } from '../test-support/notification-delivery.js';
import {
  NOTIFICATION_RETENTION_EVERY_SECONDS,
  RETENTION_PAGES_PER_RUN,
  createNotificationRetentionJob,
} from './retention.js';

const NOW = new Date('2026-11-01T13:00:00.000Z');
const DELIVERY_RECORD: NotificationDeliveryRecord = {
  id: DELIVERY,
  projectId: '01J0PR0JECT0000000000000PA',
  eventId: '01J0EVENT00000000000000001',
  endpointId: '01J0EEEEEEEEEEEEEEEEEEEEE0',
  endpointRevision: 1,
  configurationCredentialId: 'C',
  bodyCredentialId: null,
  state: 'sending',
  attempts: 3,
  jobGeneration: 1,
  activeJobId: 'J',
  activeFence: 1,
  revision: 4,
  nextAttemptAt: CREATED,
  expiresAt: '2026-11-02T12:00:00.000Z',
  createdAt: CREATED,
  lastFinishedAt: null,
};

function repository(
  pages: (readonly NotificationRepairCandidate[])[] = [],
  pruned: number[] = [],
): { [K in keyof NotificationRetentionRepository]: Mock<NotificationRetentionRepository[K]> } {
  return {
    repairCandidates: vi.fn(
      async (): Promise<readonly NotificationRepairCandidate[]> => pages.shift() ?? [],
    ),
    expire: vi.fn(async () => true),
    reconcileOrphan: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    requeue: vi.fn(async (): Promise<string | null> => '01J0NEWJ0B0000000000000001'),
    redispatch: vi.fn(async (): Promise<readonly string[]> => []),
    prune: vi.fn(async () => {
      const count = pruned.shift() ?? 0;
      return { attempts: 0, deliveries: count, events: 0, endpoints: 0, credentials: 0 };
    }),
  };
}

function context(signal = new AbortController().signal, leased = true): JobContext {
  return {
    org: ORG,
    jobId: LEASE.id,
    idempotencyKey: 'k',
    attempt: 1,
    fence: LEASE.fence,
    signal,
    ports: {} as never,
    observability: {} as never,
    ...(leased ? { fences: jobFences(LEASE) } : {}),
  };
}

function job(retention: NotificationRetentionRepository, wake = vi.fn(async () => undefined)) {
  let id = 0;
  return {
    wake,
    job: createNotificationRetentionJob({
      retention,
      clock: { now: () => NOW },
      ids: { ulid: () => `01J0A0D1T0000000000000000${String(id++ % 10)}` },
      wake,
    }),
  };
}

const finished = (call: unknown[]) =>
  JSON.parse((call[2] as { event: { payloadJson: string } }).event.payloadJson) as {
    changes: Record<string, { new: unknown }>;
  };

describe('notification retention job', () => {
  it('is an hourly core job with an empty payload', () => {
    const { job: definition } = job(repository());
    expect(definition.name).toBe('notification-retention');
    expect(definition.schedule).toEqual({ everySeconds: NOTIFICATION_RETENTION_EVERY_SECONDS });
    expect(NOTIFICATION_RETENTION_EVERY_SECONDS).toBe(3600);
    expect(definition.validate({})).toEqual({});
    expect(() => definition.validate({ deliveryId: DELIVERY })).toThrow();
  });

  it('expires stale work as expired or attempt_limit with a finished audit', async () => {
    const retention = repository([
      [
        { kind: 'expire', delivery: { ...DELIVERY_RECORD, state: 'pending', attempts: 2 } },
        { kind: 'expire', delivery: { ...DELIVERY_RECORD, state: 'pending', attempts: 8 } },
      ],
    ]);
    await job(retention).job.handler({}, context());
    const calls = retention.expire.mock.calls;
    expect(calls.map((call) => (call[2] as { code: string }).code)).toEqual([
      'expired',
      'attempt_limit',
    ]);
    expect(calls[0]![2]).toMatchObject({ deliveryId: DELIVERY, expectedRevision: 4 });
    expect(finished(calls[0]!).changes.reason).toEqual({ new: 'expired' });
  });

  it('settles an orphaned attempt as unknown at the next slot, keeping attempts and deadline', async () => {
    const retention = repository([[{ kind: 'orphan', delivery: DELIVERY_RECORD }]]);
    await job(retention).job.handler({}, context());
    const [call] = retention.reconcileOrphan.mock.calls;
    expect(call![2]).toMatchObject({
      deliveryId: DELIVERY,
      expectedRevision: 4,
      delivery: { state: 'pending', nextAttemptAt: '2026-11-01T14:00:00.000Z' },
    });
    expect(finished(call!).changes).toMatchObject({
      outcome: { new: 'unknown' },
      attempt: { new: 3 },
    });
  });

  it('requeues a reconciled orphan in the same sweep even on a short page', async () => {
    const retention = repository([[{ kind: 'orphan', delivery: DELIVERY_RECORD }]]);
    const { job: definition, wake } = job(retention);
    await definition.handler({}, context());
    expect(retention.requeue).toHaveBeenCalledWith(
      ORG,
      LEASE,
      expect.objectContaining({
        deliveryId: DELIVERY,
        expectedRevision: 5,
      }),
    );
    expect(wake).toHaveBeenCalled();
    expect(retention.requeue).toHaveBeenCalledTimes(1);
  });

  it('requeues an orphan even when it is the last candidate of the bounded run', async () => {
    const full = Array.from({ length: 20 }, () => ({
      kind: 'dead_job' as const,
      delivery: { ...DELIVERY_RECORD, state: 'pending' as const },
    }));
    const retention = repository([
      [...full.slice(0, -1), { kind: 'orphan', delivery: DELIVERY_RECORD }],
    ]);
    await job(retention).job.handler({}, context());
    expect(retention.requeue).toHaveBeenCalledWith(
      ORG,
      LEASE,
      expect.objectContaining({ expectedRevision: 5 }),
    );
  });

  it('fails an orphan whose attempts are spent instead of scheduling another', async () => {
    const retention = repository([
      [{ kind: 'orphan', delivery: { ...DELIVERY_RECORD, attempts: 8 } }],
    ]);
    await job(retention).job.handler({}, context());
    expect(retention.reconcileOrphan.mock.calls[0]![2]).toMatchObject({
      delivery: { state: 'failed', code: 'attempt_limit' },
    });
    expect(retention.requeue).not.toHaveBeenCalled();
  });

  it('cancels obsolete work with its fixed reason', async () => {
    const retention = repository([
      [
        {
          kind: 'obsolete',
          delivery: { ...DELIVERY_RECORD, state: 'pending' },
          code: 'admission_lost',
        },
      ],
    ]);
    await job(retention).job.handler({}, context());
    const [call] = retention.cancel.mock.calls;
    expect(call![2]).toMatchObject({ code: 'admission_lost' });
    expect(finished(call!).changes.reason).toEqual({ new: 'admission_lost' });
  });

  it('requeues a dead job as a new generation and wakes only committed jobs', async () => {
    const retention = repository([
      [
        { kind: 'dead_job', delivery: { ...DELIVERY_RECORD, state: 'pending' } },
        { kind: 'dead_job', delivery: { ...DELIVERY_RECORD, state: 'pending', id: 'other' } },
      ],
    ]);
    retention.requeue
      .mockResolvedValueOnce('01J0NEWJ0B0000000000000001')
      .mockResolvedValueOnce(null);
    retention.redispatch.mockResolvedValueOnce(['01J0D1SPATCH00000000000001']);
    const { job: definition, wake } = job(retention);
    await definition.handler({}, context());
    expect(Object.keys(retention.requeue.mock.calls[0]![2] as object).sort()).toEqual([
      'deliveryId',
      'expectedRevision',
      'jobId',
    ]);
    expect(wake.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      '01J0NEWJ0B0000000000000001',
      '01J0D1SPATCH00000000000001',
    ]);
  });

  it('bounds repair and redispatch to 20 each and prunes until a short page or ten pages', async () => {
    const full = Array.from({ length: 20 }, () => ({
      kind: 'dead_job' as const,
      delivery: { ...DELIVERY_RECORD, state: 'pending' as const },
    }));
    const retention = repository(
      Array.from({ length: 20 }, () => full),
      [100, 100, 7],
    );
    await job(retention).job.handler({}, context());
    expect(retention.repairCandidates).toHaveBeenCalledTimes(1);
    for (const call of retention.repairCandidates.mock.calls) expect(call[2]).toBe(20);
    expect(retention.redispatch.mock.calls[0]![2]).toMatchObject({ limit: 20 });
    expect(RETENTION_PAGES_PER_RUN).toBe(10);
    expect(retention.prune).toHaveBeenCalledTimes(3);
    expect(retention.prune.mock.calls[0]![2]).toEqual({
      now: NOW.toISOString(),
      before: '2026-10-25T13:00:00.000Z',
      limit: 100,
    });
  });

  it('stops on abort and refuses to run without a lease', async () => {
    const retention = repository();
    await expect(
      job(retention).job.handler({}, context(AbortSignal.abort())),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(job(retention).job.handler({}, context(undefined, false))).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(retention.prune).not.toHaveBeenCalled();
    expect(retention.repairCandidates).not.toHaveBeenCalled();
  });
});
