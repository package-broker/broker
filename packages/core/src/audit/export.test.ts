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
      retryCountForSeq: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
    },
  };
  const saves: AuditExportSnapshot[] = [];
  const port: AuditExportPort = {
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
    rejectionRetries: 3,
    sink: { deliver },
    now: () => now,
    random: () => 1,
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
  ] as const)('resolves $outcome without treating it as an ACK', async (result) => {
    const f = await setup();
    f.deliver.mockResolvedValue(result);
    expect(
      await exportAuditBatch(
        f.port,
        org,
        fence,
        { ...f.options, rejectionRetries: 'terminal' },
        signal,
      ),
    ).toBe('resolved');
    expect(f.get().sink.progressSeq).toBe(0);
    expect(JSON.parse(f.get().sink.inflightBody!).records[0].kind).toBe(
      result.outcome === 'uncertain' ? 'delivery_uncertain' : 'tombstone',
    );
    expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger?.[0]?.kind).toBe(
      result.outcome === 'uncertain' ? 'uncertain' : 'skipped',
    );
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
  it.each([
    null,
    undefined,
    {},
    { outcome: 'unexpected' },
    { outcome: 'rejected', code: 'unexpected' },
  ])('retries a malformed ACK without response data', async (result) => {
    const f = await setup();
    f.deliver.mockResolvedValue(result as AuditDelivery);
    expect(await f.run()).toBe('retry');
    expect(f.get().sink).toMatchObject({
      progressSeq: 0,
      custodySeq: 0,
      lastErrorCode: 'bad_response',
    });
  });

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

describe('audit rejection delivery', () => {
  async function fixture(kind = 'webhook', policy: 'availability' | 'required' = 'availability') {
    const f = await setup(false);
    f.change({ policy, sink: { ...f.get().sink, kind } });
    const alert = vi.fn();
    const options = {
      ...f.options,
      rejectionRetries: kind === 'otlp' ? ('terminal' as const) : 3,
      alert,
    };
    const run = () => exportAuditBatch(f.port, org, fence, options, signal);
    return { ...f, run, alert, options };
  }

  it.each(['webhook', 'otlp'])(
    'disposes %s rejections with an independent tombstone before advancing',
    async (kind) => {
      const f = await fixture(kind);
      f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'http_status' });
      const attempts = kind === 'otlp' ? 1 : 4;
      for (let i = 1; i <= attempts; i++) {
        expect(await f.run()).toBe('resolved');
        expect(f.get().sink.progressSeq).toBe(0);
        if (i < attempts) {
          expect(f.get().sink.retryCountForSeq).toBe(i);
          expect(f.alert).not.toHaveBeenCalled();
          f.advance();
        }
      }
      expect(f.alert).toHaveBeenCalledExactlyOnceWith('skipped');
      const save = vi.mocked(f.port.save).mock.calls.at(-1)!;
      expect(save[5]?.ledger).toEqual([
        expect.objectContaining({ kind: 'skipped', sinkId: 'test', fromSeq: 1, toSeq: 1 }),
      ]);
      expect(f.get().sink.custodySeq).toBe(1);
      const marker = JSON.parse(f.get().sink.inflightBody!).records[0];
      expect(marker).toMatchObject({ kind: 'tombstone', seq: 1 });
      expect(marker.markerId).not.toBe(f.row.id);
      f.deliver.mockImplementation(async (batch) => ack(batch));
      expect(await f.run()).toBe('accepted');
      expect(f.get().sink).toMatchObject({ progressSeq: 1, custodySeq: 1, retryCountForSeq: 0 });
      // A late duplicate of the original cannot replace the recorded disposition.
      expect(await f.run()).toBe('idle');
      expect(f.deliver.mock.calls.at(-1)![0].records[0]?.kind).toBe('tombstone');
    },
  );

  it.each([
    ['custom-otlp', 'terminal', 1],
    ['otlp', 1, 2],
  ] as const)(
    'uses protocol retry policy for kind %s',
    async (kind, rejectionRetries, attempts) => {
      const f = await fixture(kind);
      f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'too_large' });
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await exportAuditBatch(f.port, org, fence, { ...f.options, rejectionRetries }, signal);
        expect(f.get().sink.lastErrorCode).toBe('too_large');
        expect(f.alert).toHaveBeenCalledTimes(attempt === attempts ? 1 : 0);
        f.advance();
      }
      expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger?.[0]?.reasonCode).toBe(
        'too_large',
      );
    },
  );

  it.each(['range', 'prevHash'])('refuses a corrupt frozen tombstone %s', async (corruption) => {
    const f = await fixture('otlp');
    f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'refused' });
    await f.run();
    const sink = f.get().sink;
    const batch = JSON.parse(sink.inflightBody!);
    if (corruption === 'prevHash') batch.records[0].prevHash = 'f'.repeat(64);
    f.change({
      sink: {
        ...sink,
        inflightFrom: corruption === 'range' ? 0 : sink.inflightFrom,
        inflightBody: JSON.stringify(batch),
      },
    });
    await expect(f.run()).rejects.toThrow('Audit sink in-flight batch malformed');
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it.each(['availability', 'required'] as const)(
    'handles a rejected registry marker under %s',
    async (policy) => {
      const f = await fixture('otlp', policy);
      f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'network' });
      await f.run();
      const sink = f.get().sink;
      const marker = { kind: 'cutover', chainId, epoch: 0, markerId: 'marker' };
      f.change({
        sink: {
          ...sink,
          nextAttemptAt: null,
          inflightRepr: JSON.stringify({
            ...JSON.parse(sink.inflightRepr!),
            registryMarkers: [marker],
          }),
        },
      });
      f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'refused' });
      await f.run();
      expect(f.get().sink.state).toBe(policy === 'required' ? 'blocked' : 'active');
      expect(f.get().sink.inflightBody).toBe(sink.inflightBody);
      expect(f.alert).toHaveBeenCalledWith(policy === 'required' ? 'blocked' : 'marker_rejected');
      if (policy === 'availability') {
        expect(JSON.parse(f.get().sink.inflightRepr!).registryMarkers).toBeUndefined();
        expect(f.get().sink.lastErrorCode).toBe('network');
      }
    },
  );

  it('retains registry markers queued after a frozen rejected marker batch', async () => {
    const f = await fixture('otlp');
    const first = { kind: 'cutover', chainId, epoch: 0, markerId: 'first' };
    const later = { ...first, markerId: 'later' };
    const sink = f.get().sink;
    f.change({
      sink: {
        ...sink,
        inflightRepr: JSON.stringify({
          custodyFromSeq: 1,
          registryMarkers: [first, later],
          registryMarkerOriginalAttempt: 0,
          registryMarkerBody: JSON.stringify({
            v: 1,
            orgId: org.orgId,
            chainId,
            epoch: 0,
            records: [first],
            throughSeq: 0,
            throughHash: hash,
          }),
        }),
      },
    });
    f.deliver.mockResolvedValue({
      outcome: 'uncertain',
      code: 'partial_rejected',
      rejectedCount: 1,
    });
    await f.run();
    expect(JSON.parse(f.get().sink.inflightRepr!).registryMarkers).toEqual([later]);
    expect(f.get().sink.state).toBe('active');
    expect(f.alert).toHaveBeenCalledWith('marker_rejected');
  });

  it('passes a rejected tombstone under availability without disposing evidence again', async () => {
    const f = await fixture('otlp');
    f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'http_status' });
    await f.run();
    await f.run();
    expect(f.get().sink).toMatchObject({ state: 'active', progressSeq: 1, inflightBody: null });
    expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger).toBeUndefined();
    expect(f.alert.mock.calls).toEqual([['skipped'], ['marker_rejected']]);
  });

  it.each(['availability', 'required'] as const)(
    'never replays a partially accepted request under %s',
    async (policy) => {
      const f = await fixture('otlp', policy);
      f.deliver.mockResolvedValueOnce({
        outcome: 'uncertain',
        code: 'partial_rejected',
        rejectedCount: 1,
      });
      await f.run();
      expect(f.alert.mock.calls).toEqual(
        policy === 'required' ? [['uncertain'], ['blocked']] : [['uncertain']],
      );
      expect(f.get().sink).toMatchObject({
        progressSeq: 0,
        custodySeq: 1,
        state: policy === 'required' ? 'blocked' : 'active',
      });
      expect(JSON.parse(f.get().sink.inflightBody!).records[0].kind).toBe('delivery_uncertain');
      expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger?.[0]?.kind).toBe('uncertain');
      if (policy === 'required') {
        expect(await f.run()).toBe('idle');
        f.change({ sink: { ...f.get().sink, state: 'active', blockedReason: null } });
      }
      expect(await f.run()).toBe('accepted');
      expect(f.deliver.mock.calls[1]![0].records[0]?.kind).toBe('delivery_uncertain');
      expect(f.get().sink.progressSeq).toBe(1);
    },
  );

  it('records the known rejected count rather than the uncertain span', async () => {
    const f = await fixture('otlp');
    const second = { ...f.row, seq: 2, id: '01J00000000000000000000009', prev_hash: f.row.hash };
    second.hash = await hashRow(second.prev_hash, second);
    f.port.page = async () => [f.row, second];
    f.deliver.mockResolvedValue({
      outcome: 'uncertain',
      code: 'partial_rejected',
      rejectedCount: 1,
    });
    await f.run();
    expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger).toEqual([
      expect.objectContaining({ kind: 'uncertain', fromSeq: 1, toSeq: 2, count: 1 }),
    ]);
  });

  it('blocks a required single-record rejection without disposing it', async () => {
    const f = await fixture('webhook', 'required');
    f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'http_status' });
    await f.run();
    expect(f.get().sink).toMatchObject({
      state: 'blocked',
      blockedReason: 'rejected',
      progressSeq: 0,
      custodySeq: 0,
    });
    expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger).toBeUndefined();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith('blocked');
  });

  it('bisects a poison batch and preserves the frozen suffix through nested splits', async () => {
    const f = await fixture('otlp');
    const rows = [f.row];
    for (let seq = 2; seq <= 4; seq++) {
      const row = {
        ...f.row,
        seq,
        id: `01J0000000000000000000000${seq + 3}`,
        prev_hash: rows.at(-1)!.hash,
      };
      row.hash = await hashRow(row.prev_hash, row);
      rows.push(row);
    }
    f.port.page = async (_org, after) => rows.filter((row) => row.seq > after);
    f.deliver.mockImplementation(async (batch) =>
      batch.records.some((record) => record.kind === 'event' && record.seq === 2)
        ? { outcome: 'rejected', code: 'http_status' }
        : ack(batch),
    );
    await f.run();
    const frozen = f.deliver.mock.calls[0]![0];
    await f.run();
    expect(await f.run()).toBe('accepted');
    rows[2]!.payload_json = '{}';
    await f.run();
    expect(await f.run()).toBe('accepted');
    expect(await f.run()).toBe('accepted');
    expect(
      f.deliver.mock.calls.map(([batch]) =>
        batch.records.map((r) => (r.kind === 'event' ? r.seq : r.kind)),
      ),
    ).toEqual([[1, 2, 3, 4], [1, 2], [1], [2], ['tombstone'], [3, 4]]);
    expect(f.deliver.mock.calls.at(-1)![0].records).toEqual(frozen.records.slice(2));
    expect(f.get().sink.progressSeq).toBe(4);
  });

  it('rejects a late original ACK after another worker commits the tombstone', async () => {
    const f = await fixture('otlp');
    let release!: (result: AuditDelivery) => void;
    f.deliver.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const late = f.run();
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(1));
    f.deliver.mockResolvedValueOnce({ outcome: 'rejected', code: 'http_status' });
    expect(await f.run()).toBe('resolved');
    expect(await f.run()).toBe('accepted');
    const committed = structuredClone(f.get());
    release(ack(f.deliver.mock.calls[0]![0]));
    expect(await late).toBe('contended');
    expect(f.get()).toEqual(committed);
    expect(f.alert).toHaveBeenCalledExactlyOnceWith('skipped');
  });

  it('recovers a lost disposition commit response by sending only the marker', async () => {
    const f = await fixture('otlp');
    f.deliver.mockResolvedValueOnce({
      outcome: 'uncertain',
      code: 'partial_rejected',
      rejectedCount: 1,
    });
    const save = f.port.save;
    f.port.save = async (...args) => {
      const saved = await save(...args);
      if (args[5]?.ledger?.some((entry) => entry.kind === 'uncertain'))
        throw new Error('lost commit response');
      return saved;
    };
    await expect(f.run()).rejects.toThrow('lost commit response');
    f.port.save = save;
    expect(await f.run()).toBe('accepted');
    expect(f.deliver.mock.calls[1]![0].records[0]?.kind).toBe('delivery_uncertain');
    expect(f.get().sink.progressSeq).toBe(1);
  });

  it('retryable transport failures never increment the rejection counter or skip', async () => {
    const f = await fixture('otlp');
    f.deliver.mockResolvedValue({ outcome: 'retry', code: 'network' });
    for (let i = 0; i < 12; i++) {
      await f.run();
      f.advance();
    }
    expect(f.get().sink).toMatchObject({ progressSeq: 0, retryCountForSeq: 0 });
    expect(f.alert).not.toHaveBeenCalled();
  });

  it('does not record or alert a disposition after lease expiry during HTTP', async () => {
    const f = await fixture('otlp');
    f.deliver.mockImplementation(async () => {
      f.expire();
      return { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 };
    });
    await f.run();
    expect(f.get().sink).toMatchObject({ progressSeq: 0, custodySeq: 0, state: 'active' });
    expect(f.alert).not.toHaveBeenCalled();
    expect(JSON.parse(f.get().sink.inflightBody!).records[0].kind).toBe('event');
  });

  it.each([0, -1, 11, 1.5])('refuses invalid skipAfter %s before delivery', async (skipAfter) => {
    const f = await fixture();
    expect(() => auditExportJob(f.port, { ...f.options, rejectionRetries: skipAfter })).toThrow(
      'Invalid audit rejection configuration',
    );
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2, 1.5, NaN])(
    'disposes an invalid partial-success count %s as unknown uncertainty',
    async (rejectedCount) => {
      const f = await fixture('otlp');
      f.deliver.mockResolvedValue({
        outcome: 'uncertain',
        code: 'partial_rejected',
        rejectedCount,
      });
      await f.run();
      expect(f.get().sink).toMatchObject({
        progressSeq: 0,
        custodySeq: 1,
        lastErrorCode: 'partial_rejected',
      });
      expect(f.alert).toHaveBeenCalledWith('uncertain');
      expect(vi.mocked(f.port.save).mock.calls.at(-1)![5]?.ledger?.[0]?.count).toBe(1);
      expect(JSON.parse(f.get().sink.inflightBody!).records[0].kind).toBe('delivery_uncertain');
    },
  );

  it('emits allowlisted loss alerts through production observability', async () => {
    const f = await fixture('otlp');
    f.deliver.mockResolvedValue({ outcome: 'rejected', code: 'http_status' });
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
    await auditExportJob(f.port, f.options).handler({}, {
      org,
      signal,
      fences: jobFences(lease),
      observability,
    } as unknown as JobContext);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, {
      kind: 'log',
      record: expect.objectContaining({
        event: 'audit.delivery_loss',
        reason_code: 'audit.skipped',
        sink_id: 'test',
      }),
    });
  });

  it('records withheld payloads once with the frozen representation and alerts', async () => {
    const f = await fixture();
    f.row.payload_json = '{}';
    f.deliver.mockResolvedValue({ outcome: 'retry', code: 'network' });
    await f.run();
    expect(vi.mocked(f.port.save).mock.calls[0]![5]?.ledger?.[0]).toMatchObject({
      kind: 'withheld',
      fromSeq: 1,
      toSeq: 1,
      reasonCode: JSON.parse(f.get().sink.inflightBody!).records[0].reasonCode,
    });
    f.advance();
    await f.run();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith('withheld');
  });
});
