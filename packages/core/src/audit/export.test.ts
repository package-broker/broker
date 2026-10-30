import { describe, expect, it, vi } from 'vitest';
import { systemMutationFence } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { jobFences } from '../platform/job-fences.js';
import { AUDIT_EVENTS, KERNEL_REASON_CODES } from '../kernel/obs-codes.js';
import { createObservability, safeRecord } from '../platform/observability.js';
import type { JobContext } from '../platform/jobs.js';
import { auditEvent } from './actions.js';
import { hashRow, type AuditRow } from './chain.js';
import type { AuditBatchV1, AuditDelivery } from './plugin-api.js';
import {
  auditCustodySeq,
  auditExportJob,
  auditInflightEventRange,
  auditRetryDelayMs,
  exportAuditBatch,
  type AuditExportOptions,
  type AuditExportPort,
  type AuditExportSnapshot,
} from './export.js';

const org = orgContext('01J00000000000000000000001');
const chainId = 'a'.repeat(32);
const hash = '0'.repeat(64);
const lease = { id: 'job', owner: 'owner', fence: 1 };
const fence = systemMutationFence('audit-export', lease, {});
const signal = new AbortController().signal;
const ack = (batch: AuditBatchV1): Extract<AuditDelivery, { outcome: 'accepted' }> => ({
  outcome: 'accepted',
  chainId: batch.chainId,
  epoch: batch.epoch,
  throughSeq: batch.throughSeq,
  throughHash: batch.throughHash,
});

async function setup(durableAck = true) {
  let now = new Date('2026-10-30T00:00:00.000Z');
  let active = true;
  const event = auditEvent({
    id: '01J00000000000000000000003',
    now: now.toISOString(),
    actor: { type: 'system', id: null },
    action: 'session.logout',
    target: { type: 'session', id: null },
    context: {
      opId: '01J00000000000000000000004',
      requestId: '01J00000000000000000000005',
      sourceIp: null,
      tokenSelector: null,
    },
  });
  if (!event.ok) throw new Error('fixture refused');
  const row: AuditRow = {
    id: event.event.id,
    org_id: org.orgId,
    seq: 1,
    prev_hash: hash,
    hash,
    created_at: now.toISOString(),
    actor_type: 'system',
    actor_id: null,
    token_selector: null,
    source_ip: null,
    action: 'session.logout',
    target_type: 'session',
    target_id: null,
    project_id: null,
    payload_json: event.event.payloadJson,
  };
  row.hash = await hashRow(hash, row);
  let stored: AuditExportSnapshot = {
    chainId,
    epoch: 0,
    incarnation: 0,
    modeGeneration: 0,
    boundarySeq: 1,
    boundaryPrevHash: hash,
    policy: 'availability',
    highestGeneration: 1,
    restorePending: false,
    sink: {
      id: 'test',
      pluginId: 'plugin',
      kind: 'webhook',
      generation: 1,
      receiverFingerprint: 'a'.repeat(64),
      activationSource: 'build',
      state: 'active',
      blockedReason: null,
      durableAck,
      progressSeq: 0,
      progressHash: hash,
      custodySeq: 0,
      inflightFrom: null,
      inflightTo: null,
      inflightBody: null,
      inflightRepr: JSON.stringify({ custodyFromSeq: 1, custom: 'preserved' }),
      attempt: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
    },
  };
  const saves: AuditExportSnapshot[] = [];
  const port: AuditExportPort = {
    capacityGap: async () => null,
    read: vi.fn(async (ctx) => {
      expect(ctx).toEqual(org);
      return structuredClone(stored);
    }),
    page: vi.fn(async (ctx, after, limit) => {
      expect(ctx).toEqual(org);
      expect(limit).toBeLessThanOrEqual(100);
      return after === 0 ? [row] : [];
    }),
    save: vi.fn(async (ctx, guard, expected, next, buildGeneration) => {
      expect(ctx).toEqual(org);
      expect(guard).toEqual(fence);
      if (
        buildGeneration < stored.highestGeneration ||
        !active ||
        JSON.stringify(expected) !== JSON.stringify(stored)
      )
        return false;
      stored = structuredClone({ ...expected, sink: next });
      saves.push(structuredClone(stored));
      return true;
    }),
  };
  const deliver = vi.fn<(batch: AuditBatchV1) => Promise<AuditDelivery>>(async (batch) =>
    ack(batch),
  );
  const options: AuditExportOptions = {
    id: 'test',
    generation: 1,
    pluginVersion: '1.2.3',
    sourceIp: 'omit',
    sink: { deliver },
    now: () => now,
    random: () => 1,
    resolve: vi.fn(async () => {}),
  };
  return {
    port,
    options,
    deliver,
    saves,
    row,
    get: () => stored,
    change: (patch: Partial<AuditExportSnapshot>) => {
      stored = { ...stored, ...patch };
    },
    expire: () => {
      active = false;
    },
    advance: () => {
      now = new Date(now.getTime() + 3_600_000);
    },
    run: () => exportAuditBatch(port, org, fence, options, signal),
  };
}

describe('audit delivery', () => {
  it.each([true, false])(
    'persists before HTTP and separates custody (durable=%s)',
    async (durable) => {
      const f = await setup(durable);
      f.deliver.mockImplementation(async (batch) => {
        expect(f.get().sink.inflightBody).toBe(JSON.stringify(batch));
        expect(Object.isFrozen(batch.records)).toBe(true);
        expect(Object.isFrozen(batch.records[0])).toBe(true);
        return ack(batch);
      });
      expect(await f.run()).toBe('accepted');
      expect(f.get().sink).toMatchObject({
        progressSeq: 1,
        custodySeq: durable ? 1 : 0,
        inflightBody: null,
      });
      expect(JSON.parse(f.get().sink.inflightRepr!)).toMatchObject({
        custodyFromSeq: 1,
        custom: 'preserved',
      });
    },
  );

  it('resumes custody from the durable registration start after a flip', async () => {
    const f = await setup(false);
    expect(await f.run()).toBe('accepted');
    const second = { ...f.row, seq: 2, prev_hash: f.row.hash };
    second.hash = await hashRow(second.prev_hash, second);
    f.change({
      sink: {
        ...f.get().sink,
        durableAck: true,
        inflightRepr: JSON.stringify({ custodyFromSeq: 2 }),
      },
    });
    f.port.page = async (ctx, after) => (after === 1 ? [second] : []);
    expect(await f.run()).toBe('accepted');
    expect(f.get().sink.custodySeq).toBe(2);
  });

  it('advances an explicitly disposed range before subsequent durable ACKs', async () => {
    const f = await setup();
    const custodySeq = auditCustodySeq(f.get().sink, { from: 1, to: 1, kind: 'disposed' });
    f.change({ sink: { ...f.get().sink, custodySeq, progressSeq: 1, progressHash: f.row.hash } });
    const second = { ...f.row, seq: 2, prev_hash: f.row.hash };
    second.hash = await hashRow(second.prev_hash, second);
    f.port.page = async (ctx, after) => (after === 1 ? [second] : []);
    expect(await f.run()).toBe('accepted');
    expect(f.get().sink.custodySeq).toBe(2);
  });

  it('times out a receiver slower than the lease and saves backoff', async () => {
    const f = await setup();
    vi.useFakeTimers();
    try {
      let deliverySignal: AbortSignal | undefined;
      f.options.sink.deliver = vi.fn<typeof f.options.sink.deliver>((_batch, receivedSignal) => {
        deliverySignal = receivedSignal;
        return new Promise(() => {});
      });
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toBe('retry');
      expect(deliverySignal?.aborted).toBe(true);
      expect(f.get().sink).toMatchObject({
        lastErrorCode: 'timeout',
        nextAttemptAt: '2026-10-30T00:00:05.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains several batches in one job and clamps the construction limit', async () => {
    const f = await setup();
    const rows = [f.row];
    for (let seq = 2; seq <= 4; seq++) {
      const row = { ...f.row, seq, prev_hash: rows.at(-1)!.hash };
      row.hash = await hashRow(row.prev_hash, row);
      rows.push(row);
    }
    f.port.page = vi.fn(async (_ctx, after, limit) =>
      rows.filter((row) => row.seq > after).slice(0, limit),
    );
    await auditExportJob(f.port, { ...f.options, maxBatchEvents: 1 }).handler({}, {
      org,
      signal,
      fences: jobFences(lease),
    } as JobContext);
    expect(f.deliver).toHaveBeenCalledTimes(4);
    expect(f.get().sink).toMatchObject({ progressSeq: 4, custodySeq: 4 });
    await auditExportJob(f.port, { ...f.options, maxBatchEvents: 999 }).handler({}, {
      org,
      signal,
      fences: jobFences(lease),
    } as JobContext);
    expect(f.port.page).toHaveBeenLastCalledWith(org, 4, 100);
    for (const maxBatchEvents of [0, -1, 1.5, NaN])
      expect(() => auditExportJob(f.port, { ...f.options, maxBatchEvents })).toThrow(
        'Invalid audit batch limit',
      );
    expect(JSON.parse(f.saves[0]!.sink.inflightRepr!)).toMatchObject({
      sanitizerVersion: 1,
      pluginVersion: '1.2.3',
    });
  });

  it('ends the batch loop when its lease budget or caller signal ends', async () => {
    for (const cancel of [false, true]) {
      const f = await setup();
      const controller = new AbortController();
      vi.useFakeTimers();
      try {
        f.deliver.mockImplementation(async (batch) => {
          if (cancel) controller.abort();
          else vi.setSystemTime(Date.now() + 45_000);
          return ack(batch);
        });
        await auditExportJob(f.port, f.options).handler({}, {
          org,
          signal: controller.signal,
          fences: jobFences(lease),
        } as JobContext);
        expect(f.deliver).toHaveBeenCalledTimes(1);
        expect(f.port.read).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each(['read', 'page', 'save'] as const)(
    'returns idle if the deadline expires during %s',
    async (phase) => {
      const f = await setup();
      const before = structuredClone(f.get());
      vi.useFakeTimers();
      try {
        if (phase === 'read') {
          const read = f.port.read;
          f.port.read = async (...args) => {
            const result = await read(...args);
            vi.setSystemTime(Date.now() + 45_000);
            return result;
          };
        } else if (phase === 'page') {
          f.port.page = async () => {
            vi.setSystemTime(Date.now() + 45_000);
            return [f.row];
          };
        } else {
          const save = f.port.save;
          f.port.save = async (...args) => {
            const result = await save(...args);
            vi.setSystemTime(Date.now() + 45_000);
            return result;
          };
        }
        expect(await f.run()).toBe('idle');
        expect(f.deliver).not.toHaveBeenCalled();
        expect(f.saves).toHaveLength(phase === 'save' ? 1 : 0);
        if (phase !== 'save') expect(f.get()).toEqual(before);
        expect(f.get().sink.lastErrorCode).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['', ' ', 'a b', 'a\t', 'a\n', '\x7f', 'é', 'a'.repeat(129)])(
    'rejects invalid plugin version %j at job construction',
    async (pluginVersion) => {
      const f = await setup();
      expect(() => auditExportJob(f.port, { ...f.options, pluginVersion })).toThrow(
        'Invalid audit export configuration',
      );
      expect(() =>
        auditExportJob(f.port, { ...f.options, pluginVersion: 'a'.repeat(128) }),
      ).not.toThrow();
    },
  );

  it('caps Retry-After at 24 hours', async () => {
    const f = await setup();
    f.deliver.mockResolvedValue({
      outcome: 'retry',
      code: 'http_status',
      retryAfterMs: Number.MAX_VALUE,
    });
    expect(await f.run()).toBe('retry');
    expect(f.get().sink.nextAttemptAt).toBe('2026-10-31T00:00:00.000Z');
  });

  it.each(['hole', 'from', 'to'] as const)(
    'rejects frozen range corruption: %s',
    async (corruption) => {
      const f = await setup();
      f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'network' });
      await f.run();
      const sink = f.get().sink;
      const batch = JSON.parse(sink.inflightBody!) as AuditBatchV1;
      f.change({
        sink: {
          ...sink,
          inflightFrom: corruption === 'from' ? 2 : sink.inflightFrom,
          inflightTo: corruption === 'to' ? 2 : sink.inflightTo,
          inflightBody:
            corruption === 'hole'
              ? JSON.stringify({ ...batch, records: [{ ...batch.records[0], seq: 2 }] })
              : sink.inflightBody,
        },
      });
      f.advance();
      await expect(f.run()).rejects.toThrow('Audit sink in-flight batch malformed');
      expect(f.deliver).toHaveBeenCalledTimes(1);
    },
  );

  it('replays identical bytes after a lost ACK despite journal changes', async () => {
    const f = await setup();
    f.deliver.mockRejectedValueOnce(new Error('untrusted response'));
    expect(await f.run()).toBe('retry');
    const original = f.get().sink.inflightBody;
    expect(f.get().sink).toMatchObject({
      progressSeq: 0,
      custodySeq: 0,
      attempt: 1,
      lastErrorCode: 'network',
    });
    f.row.payload_json = '{}';
    expect(await f.run()).toBe('idle');
    f.advance();
    expect(await f.run()).toBe('accepted');
    expect(JSON.stringify(f.deliver.mock.calls[1]![0])).toBe(original);
    expect(f.port.page).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after persisting the body before HTTP', async () => {
    const f = await setup();
    const save = f.port.save;
    f.port.save = async (...args) => {
      await save(...args);
      throw new Error('crash');
    };
    await expect(f.run()).rejects.toThrow('crash');
    expect(f.deliver).not.toHaveBeenCalled();
    const body = f.get().sink.inflightBody;
    f.port.save = save;
    expect(await f.run()).toBe('accepted');
    expect(JSON.stringify(f.deliver.mock.calls[0]![0])).toBe(body);
  });

  it('does not advance after a lease expires during HTTP', async () => {
    const f = await setup();
    f.deliver.mockImplementation(async (batch) => {
      f.expire();
      return ack(batch);
    });
    expect(await f.run()).toBe('contended');
    expect(f.get().sink).toMatchObject({ progressSeq: 0, custodySeq: 0 });
    expect(f.get().sink.inflightBody).not.toBeNull();
  });

  it('ignores a late original ACK after another worker commits', async () => {
    const f = await setup();
    let release!: (result: AuditDelivery) => void;
    f.deliver.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const late = f.run();
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(1));
    expect(await f.run()).toBe('accepted');
    const committed = structuredClone(f.get());
    release(ack(f.deliver.mock.calls[0]![0]));
    expect(await late).toBe('contended');
    expect(f.get()).toEqual(committed);
  });

  it.each(['chainId', 'epoch', 'throughSeq', 'throughHash'] as const)(
    'retries a mismatched %s without advancing',
    async (field) => {
      const f = await setup();
      f.deliver.mockImplementation(
        async (batch) =>
          ({
            ...ack(batch),
            [field]: field === 'epoch' || field === 'throughSeq' ? 99 : 'invalid',
          }) as AuditDelivery,
      );
      expect(await f.run()).toBe('retry');
      expect(f.get().sink).toMatchObject({
        progressSeq: 0,
        custodySeq: 0,
        lastErrorCode: 'bad_response',
      });
    },
  );

  it('honours Retry-After beyond the jitter cap', async () => {
    const f = await setup();
    f.deliver.mockResolvedValue({ outcome: 'retry', code: 'http_status', retryAfterMs: 3_600_000 });
    await f.run();
    expect(f.get().sink.nextAttemptAt).toBe('2026-10-30T01:00:00.000Z');
    expect(auditRetryDelayMs(100, 0, () => 1)).toBe(900_000);
  });

  it.each(['inactive', 'blocked', 'disabled', 'retired'] as const)(
    'does not deliver a %s sink',
    async (state) => {
      const f = await setup();
      f.change({ sink: { ...f.get().sink, state } });
      expect(await f.run()).toBe('idle');
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );

  it('uses state to allow an active sink with a retained blocked reason', async () => {
    const f = await setup();
    f.change({ sink: { ...f.get().sink, blockedReason: 'fork' } });
    expect(await f.run()).toBe('accepted');
  });

  it.each([{ highestGeneration: 2 }, { restorePending: true }])(
    'refuses stale builds or restore pending',
    async (patch) => {
      const f = await setup();
      f.change(patch);
      expect(await f.run()).toBe('idle');
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );

  it.each([4, 5])(
    'passes acting build %s to both saves while retaining the sink generation',
    async (generation) => {
      const f = await setup();
      f.change({ highestGeneration: 4 });
      expect(await exportAuditBatch(f.port, org, fence, { ...f.options, generation }, signal)).toBe(
        'accepted',
      );
      expect(f.get().sink.generation).toBe(1);
      expect(f.port.save).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(f.port.save).mock.calls) expect(call[4]).toBe(generation);
    },
  );

  it('fails closed without custody metadata', async () => {
    const f = await setup();
    f.change({ sink: { ...f.get().sink, inflightRepr: '{}' } });
    await expect(f.run()).rejects.toThrow('Audit sink representation malformed');
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('drains queued registry markers ahead of the frozen original', async () => {
    const f = await setup();
    f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'network' });
    await f.run();
    const body = f.get().sink.inflightBody;
    const marker = {
      kind: 'boundary' as const,
      chainId,
      epoch: 0,
      markerId: '01J00000000000000000000006',
      boundarySeq: 1,
      boundaryPrevHash: hash,
      provenance: 'backfill',
    };
    f.change({
      sink: {
        ...f.get().sink,
        inflightRepr: JSON.stringify({ custodyFromSeq: 1, registryMarkers: [marker] }),
      },
    });
    f.advance();
    f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'refused' });
    expect(await f.run()).toBe('retry');
    expect(f.get().sink.lastErrorCode).toBe('refused');
    const markerRepr = JSON.parse(f.get().sink.inflightRepr!);
    const markerBody = markerRepr.registryMarkerBody;
    const laterMarker = { ...marker, markerId: '01J00000000000000000000007' };
    f.change({
      sink: {
        ...f.get().sink,
        inflightRepr: JSON.stringify({ ...markerRepr, registryMarkers: [marker, laterMarker] }),
      },
    });
    f.advance();
    expect(await f.run()).toBe('accepted');
    expect(JSON.stringify(f.deliver.mock.calls[2]![0])).toBe(markerBody);
    expect(f.get().sink).toMatchObject({ attempt: 1, lastErrorCode: 'network' });
    expect(f.deliver.mock.calls[1]![0].records).toEqual([marker]);
    expect(f.get().sink).toMatchObject({ progressSeq: 0, custodySeq: 0, inflightBody: body });
    expect(await f.run()).toBe('accepted');
    expect(f.deliver.mock.calls[3]![0].records).toEqual([laterMarker]);
    expect(f.get().sink).toMatchObject({ attempt: 1, lastErrorCode: 'network' });
    expect(await f.run()).toBe('accepted');
    expect(JSON.stringify(f.deliver.mock.calls[4]![0])).toBe(body);
  });

  it.each(['marker', 'registry_markers', 'events'] as const)(
    'marker-only %s batches never advance custody or count as event ranges',
    async (purpose) => {
      const f = await setup();
      const batch = {
        v: 1,
        chainId,
        epoch: 0,
        orgId: org.orgId,
        records: [
          {
            kind: 'head',
            chainId,
            epoch: 0,
            markerId: '01J00000000000000000000006',
            seq: 0,
            hash,
            boundarySeq: 1,
          },
        ],
        throughSeq: 0,
        throughHash: hash,
      };
      f.change({
        sink: {
          ...f.get().sink,
          inflightFrom: 1,
          inflightTo: 1,
          inflightBody: JSON.stringify(batch),
          inflightRepr: JSON.stringify({ custodyFromSeq: 1, purpose }),
        },
      });
      if (purpose === 'events') {
        expect(() => auditInflightEventRange(f.get().sink)).toThrow(
          'Audit sink in-flight batch malformed',
        );
        await expect(f.run()).rejects.toThrow('Audit sink in-flight batch malformed');
        expect(f.port.save).not.toHaveBeenCalled();
        expect(f.deliver).not.toHaveBeenCalled();
        return;
      }
      expect(auditInflightEventRange(f.get().sink)).toBeNull();
      expect(await f.run()).toBe('accepted');
      expect(f.get().sink).toMatchObject({ progressSeq: 0, custodySeq: 0, inflightBody: null });
    },
  );

  it.each([
    { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 },
    { outcome: 'rejected', code: 'http_status' },
  ] as const)('delegates $outcome to G15b without treating it as an ACK', async (result) => {
    const f = await setup();
    f.deliver.mockResolvedValue(result);
    expect(await f.run()).toBe('resolved');
    expect(f.options.resolve).toHaveBeenCalledWith(
      org,
      fence,
      f.get(),
      f.deliver.mock.calls[0]![0],
      result,
    );
    expect(f.get().sink.progressSeq).toBe(0);
  });

  it('one stalled sink does not prevent a healthy sink delivering', async () => {
    const unhealthy = await setup();
    const healthy = await setup();
    let release!: (result: AuditDelivery) => void;
    unhealthy.deliver.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = unhealthy.run();
    await vi.waitFor(() => expect(unhealthy.deliver).toHaveBeenCalledTimes(1));
    expect(await healthy.run()).toBe('accepted');
    expect(healthy.get().sink.progressSeq).toBe(1);
    expect(unhealthy.get().sink.progressSeq).toBe(0);
    release({ outcome: 'retry', code: 'timeout' });
    expect(await pending).toBe('retry');
  });

  it('registers an empty-payload scheduled job with a sink-specific resource and captured lease', async () => {
    const f = await setup();
    const job = auditExportJob(f.port, f.options);
    expect(job.name).toBe('audit-export-test');
    expect(job.schedule).toEqual({ everySeconds: 60, resourceKey: 'audit-export:test' });
    for (const input of [null, [], { id: 'test' }, new Date()])
      expect(() => job.validate(input)).toThrow();
    expect(job.validate({})).toEqual({});
    await job.handler({}, { org, signal, fences: jobFences(lease) } as JobContext);
    expect(f.get().sink.progressSeq).toBe(1);
    await expect(job.handler({}, { org, signal } as JobContext)).rejects.toThrow('lease_lost');
  });
  it('logs only the fixed warning event for an exact warning ACK', async () => {
    const f = await setup();
    f.deliver.mockImplementation(async (batch) => ({
      ...ack(batch),
      outcome: 'accepted_with_warning',
      code: 'partial_success',
    }));
    const log = vi.fn();
    await auditExportJob(f.port, f.options).handler({}, {
      org,
      signal,
      fences: jobFences(lease),
      observability: { log },
    } as unknown as JobContext);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'audit.delivery_partial_success',
      reason_code: 'audit.partial_success',
      sink_id: 'test',
    });
    expect(safeRecord(log.mock.calls[0]![0])).toMatchObject({
      reason_code: 'audit.partial_success',
      sink_id: 'test',
    });
    expect(f.get().sink).toMatchObject({
      progressSeq: 1,
      custodySeq: 1,
      lastErrorCode: 'partial_success',
    });
    const emit = vi.fn();
    const observability = createObservability(
      { emit },
      {
        deploymentId: 'test',
        runtime: 'node',
        requestId: '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11',
      },
      { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
    );
    observability.log(log.mock.calls[0]![0]);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      kind: 'log',
      record: expect.objectContaining({
        reason_code: 'audit.partial_success',
        sink_id: 'test',
      }),
    });
  });

  it('does not send when the initial persistence guard fails', async () => {
    const f = await setup();
    f.expire();
    expect(await f.run()).toBe('contended');
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('does not hide earlier unresolved custody behind a later durable ACK', async () => {
    const f = await setup();
    f.change({
      sink: { ...f.get().sink, progressSeq: 1, progressHash: f.row.hash, custodySeq: 0 },
    });
    const row = { ...f.row, seq: 2, prev_hash: f.row.hash };
    row.hash = await hashRow(row.prev_hash, row);
    f.port.page = async () => [row];
    expect(await f.run()).toBe('accepted');
    expect(f.get().sink).toMatchObject({ progressSeq: 2, custodySeq: 0 });
  });

  it('refuses foreign rows and holes before persisting or sending', async () => {
    for (const patch of [{ org_id: 'foreign' }, { seq: 2 }, { prev_hash: 'a'.repeat(64) }]) {
      const f = await setup();
      Object.assign(f.row, patch);
      await expect(f.run()).rejects.toThrow();
      expect(f.port.save).not.toHaveBeenCalled();
      expect(f.deliver).not.toHaveBeenCalled();
    }
  });

  it('does not call HTTP for a pre-aborted job or settle an aborted HTTP call', async () => {
    const f = await setup();
    const controller = new AbortController();
    controller.abort();
    expect(await exportAuditBatch(f.port, org, fence, f.options, controller.signal)).toBe('idle');
    expect(f.port.read).not.toHaveBeenCalled();
    const during = new AbortController();
    f.deliver.mockImplementation(async (batch) => {
      during.abort();
      return ack(batch);
    });
    expect(await exportAuditBatch(f.port, org, fence, f.options, during.signal)).toBe('idle');
    expect(f.get().sink).toMatchObject({ progressSeq: 0, custodySeq: 0 });
    expect(f.get().sink.inflightBody).not.toBeNull();
  });

  it('persists a UTF-8 batch within 512 KiB even with heavily escaped payloads', async () => {
    const f = await setup();
    const payload = JSON.parse(f.row.payload_json) as Record<string, unknown>;
    payload['changes'] = {
      permissions: { new: Array.from({ length: 18 }, () => '"'.repeat(100)) },
    };
    const rows: AuditRow[] = [];
    let previous = hash;
    for (let i = 1; i <= 100; i++) {
      const row = {
        ...f.row,
        id: String(i).padStart(26, '0'),
        seq: i,
        prev_hash: previous,
        action: 'role.permissions_set',
        target_type: 'role',
        payload_json: JSON.stringify(payload),
      };
      row.hash = await hashRow(previous, row);
      rows.push(row);
      previous = row.hash;
    }
    f.port.page = async () => rows;
    expect(await f.run()).toBe('accepted');
    const batch = f.deliver.mock.calls[0]![0];
    expect(batch.records.every((record) => record.kind === 'event')).toBe(true);
    expect(batch.records.length).toBeGreaterThan(1);
    expect(batch.records.length).toBeLessThan(100);
    expect(new TextEncoder().encode(f.saves[0]!.sink.inflightBody!).length).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(batch.throughSeq).toBe(batch.records.length);
  });

  it('obeys the configured event limit', async () => {
    const f = await setup();
    const second = { ...f.row, seq: 2, prev_hash: f.row.hash };
    second.hash = await hashRow(second.prev_hash, second);
    f.port.page = vi.fn(async () => [f.row, second]);
    expect(
      await exportAuditBatch(f.port, org, fence, { ...f.options, maxBatchEvents: 1 }, signal),
    ).toBe('accepted');
    expect(f.port.page).toHaveBeenCalledWith(org, 0, 1);
    expect(f.deliver.mock.calls[0]![0].records).toHaveLength(1);
    expect(f.get().sink.progressSeq).toBe(1);
  });
  it('recovers a crash after the ACK transaction commits without redelivering', async () => {
    const f = await setup();
    const save = f.port.save;
    f.port.save = async (...args) => {
      const saved = await save(...args);
      if (args[3].progressSeq === 1) throw new Error('lost commit response');
      return saved;
    };
    await expect(f.run()).rejects.toThrow('lost commit response');
    expect(f.get().sink).toMatchObject({ progressSeq: 1, custodySeq: 1, inflightBody: null });
    f.port.save = save;
    expect(await f.run()).toBe('idle');
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it.each([null, undefined, {}, { outcome: 'unexpected' }])(
    'retries a malformed ACK without response data',
    async (result) => {
      const f = await setup();
      f.deliver.mockResolvedValue(result as AuditDelivery);
      expect(await f.run()).toBe('retry');
      expect(f.get().sink).toMatchObject({
        progressSeq: 0,
        custodySeq: 0,
        lastErrorCode: 'bad_response',
      });
    },
  );

  it('refuses a frozen batch with a foreign record before HTTP', async () => {
    const f = await setup();
    f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'network' });
    await f.run();
    const batch = JSON.parse(f.get().sink.inflightBody!) as AuditBatchV1;
    const body = JSON.stringify({
      ...batch,
      records: batch.records.map((record) => ({ ...record, orgId: 'foreign' })),
    });
    f.change({ sink: { ...f.get().sink, inflightBody: body } });
    f.advance();
    await expect(f.run()).rejects.toThrow('Audit sink in-flight batch malformed');
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
});

it('bounds capacity reconciliation even when the port returns one row per sequence', async () => {
  const f = await setup();
  const capacityGap = vi.fn<AuditExportPort['capacityGap']>(
    async (_org, _snapshot, afterSeq: number) => ({
      id: 'gap',
      fromSeq: afterSeq + 1,
      toSeq: afterSeq + 1,
      count: 1,
      modeGeneration: 0,
      prevHash: hash,
      hash,
    }),
  );
  f.port.capacityGap = capacityGap;
  // The initial lookup must still allow the event batch to freeze.
  capacityGap.mockResolvedValueOnce(null);
  f.deliver.mockImplementation(async (batch) => {
    f.change({ boundarySeq: 102, boundaryPrevHash: hash });
    return ack(batch);
  });
  expect(await f.run()).toBe('contended');
  expect(capacityGap).toHaveBeenCalledTimes(101);
  expect(f.get().sink.progressSeq).toBe(0);
});

it.each([1, 2])(
  'rejects a clipped capacity marker with original count %s before delivery',
  async (count) => {
    const f = await setup();
    f.change({ sink: { ...f.get().sink, progressSeq: 2 } });
    f.port.capacityGap = async () => ({
      id: 'gap',
      fromSeq: 1,
      toSeq: 3,
      count,
      modeGeneration: 0,
      prevHash: hash,
      hash,
    });
    await expect(f.run()).rejects.toThrow('Audit delivery range unavailable');
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.port.save).not.toHaveBeenCalled();
  },
);
