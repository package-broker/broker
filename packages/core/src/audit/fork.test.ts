import { describe, expect, it, vi } from 'vitest';
import { systemMutationFence } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { assertAuditLedgerEntry } from './ledger.js';
import {
  AuditForkLimitError,
  confirmAuditRestore,
  detectAuditFork,
  type AuditForkPort,
  type AuditForkSnapshot,
} from './fork.js';
import {
  exportAuditBatch,
  type AuditExportPort,
  type AuditExportSnapshot,
  type AuditExportState,
} from './export.js';
import type { AuditPositionV1, AuditSink } from './plugin-api.js';

const org = orgContext('01JZZZZZZZZZZZZZZZZZZZZZZX');
const now = new Date('2026-10-30T12:00:00.000Z');
const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const chainId = 'c'.repeat(32);
function sink(overrides: Partial<AuditExportState> = {}): AuditExportState {
  return {
    id: 'archive',
    pluginId: 'audit',
    kind: 'webhook',
    generation: 3,
    receiverFingerprint: hash,
    durableAck: true,
    activationSource: 'ARCHIVE_URL',
    state: 'active',
    progressSeq: 5,
    progressHash: hash,
    custodySeq: 4,
    blockedReason: null,
    inflightBody: null,
    inflightRepr: '{"custodyFromSeq":1}',
    inflightFrom: null,
    inflightTo: null,
    attempt: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}
function snapshot(overrides: Partial<AuditForkSnapshot> = {}): AuditForkSnapshot {
  return {
    chainId,
    epoch: 2,
    incarnation: 7,
    modeGeneration: 10,
    policy: 'availability',
    boundarySeq: 1,
    boundaryPrevHash: '0'.repeat(64),
    boundaryReason: null,
    restorePending: false,
    headSeq: 5,
    headHash: hash,
    sinks: [sink()],
    ...overrides,
  };
}
function fixture(state = snapshot()) {
  const save = vi.fn<AuditForkPort['save']>().mockResolvedValue(true);
  const hashAt = vi.fn<AuditForkPort['hashAt']>().mockResolvedValue(hash);
  const port: AuditForkPort = { read: vi.fn().mockResolvedValue(state), hashAt, save };
  const alert = vi.fn();
  const options = { generation: 3, now, signal: new AbortController().signal, alert };
  return { port, save, hashAt, alert, options, change: () => save.mock.calls[0]![3] };
}
const position = (overrides: Partial<AuditPositionV1> = {}): AuditPositionV1 => ({
  chainId,
  epoch: 2,
  seq: 5,
  hash,
  ...overrides,
});
function probe(value: AuditPositionV1 | null): AuditSink {
  return { deliver: vi.fn(), frontier: vi.fn().mockResolvedValue(value) };
}

describe('restore and fork detection', () => {
  it('leaves matching progress and receiver frontier unchanged', async () => {
    const f = fixture();
    const receiver = probe(position());
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        probes: [{ id: 'archive', sink: receiver }],
      }),
    ).toBe('clear');
    expect(receiver.frontier).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(f.save).not.toHaveBeenCalled();
    expect(f.alert).not.toHaveBeenCalled();
  });

  it.each(['availability', 'required'] as const)(
    'handles tooling restore once under %s',
    async (policy) => {
      const f = fixture(
        snapshot({
          restorePending: true,
          epoch: 3,
          policy,
          sinks: [
            sink(),
            sink({ id: 'refused', state: 'blocked', blockedReason: 'rejected' }),
            sink({ id: 'absent', state: 'inactive' }),
            sink({ id: 'removed', state: 'disabled' }),
            sink({ id: 'retired', state: 'retired' }),
          ],
        }),
      );
      expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
      expect(f.change()).toMatchObject({
        epoch: 3,
        restorePending: true,
        boundaryReason: null,
        ledger: [],
        event: null,
      });
      expect(f.change().sinks.map((s) => [s.state, s.blockedReason])).toEqual([
        ['blocked', 'fork'],
        ['blocked', 'rejected'],
        ['inactive', null],
        ['disabled', null],
        ['retired', null],
      ]);
      expect(f.alert).toHaveBeenCalledWith('restore_detected');
    },
  );

  it.each([
    { progressSeq: 6 },
    { progressHash: other },
    { progressSeq: 3, progressHash: other },
    { inflightBody: JSON.stringify({ chainId, epoch: 1 }) },
    { inflightBody: 'malformed' },
  ])('detects divergent local state %j', async (overrides) => {
    const f = fixture(snapshot({ sinks: [sink(overrides)] }));
    expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
    expect(f.change()).toMatchObject({
      epoch: 3,
      restorePending: true,
      boundaryReason: null,
      sinks: [{ state: 'blocked', blockedReason: 'fork' }],
    });
    expect(f.change().ledger).toHaveLength(1);
    assertAuditLedgerEntry(f.change().ledger[0]!);
    expect(f.change().ledger[0]).toMatchObject({ kind: 'epoch_bump', reasonCode: 'local_fork' });
    expect(f.change().event?.action).toBe('audit.sink_admin');
    expect(f.alert).toHaveBeenCalledWith('local_fork');
  });

  it.each([
    { seq: 6 },
    { hash: other },
    { seq: 3, hash: other },
    { epoch: 3 },
    { chainId: 'd'.repeat(32) },
  ])('detects receiver divergence %j', async (overrides) => {
    const f = fixture();
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        probes: [{ id: 'archive', sink: probe(position(overrides)) }],
      }),
    ).toBe('blocked');
    expect(f.change().epoch).toBe(3);
    expect(f.alert).toHaveBeenCalledWith('receiver_fork');
  });

  it('checks the retained journal at the head even when the stored head agrees with the cursor', async () => {
    const f = fixture();
    f.hashAt.mockResolvedValue(other);
    expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
    expect(f.save.mock.calls[0]![2]).toEqual([{ seq: 5, hash: other }]);
    expect(f.alert).toHaveBeenCalledWith('local_fork');
  });

  it('pins an observed interior hash for the atomic write', async () => {
    const f = fixture(snapshot({ sinks: [sink({ progressSeq: 3, progressHash: other })] }));
    await detectAuditFork(f.port, org, f.options);
    expect(f.hashAt).toHaveBeenCalledWith(org, 3);
    expect(f.save.mock.calls[0]![2]).toEqual([{ seq: 3, hash }]);
    expect(f.save.mock.calls[0]![0]).toBe(org);
    expect(f.save.mock.calls[0]![4]).toBe(3);
  });

  it('compares boundary predecessors but does not guess pruned hashes', async () => {
    const f = fixture(
      snapshot({
        boundarySeq: 4,
        boundaryPrevHash: hash,
        sinks: [sink({ progressSeq: 2, progressHash: other })],
      }),
    );
    expect(await detectAuditFork(f.port, org, f.options)).toBe('clear');
    expect(f.hashAt).not.toHaveBeenCalled();
    const mismatch = fixture(
      snapshot({
        boundarySeq: 4,
        boundaryPrevHash: hash,
        sinks: [sink({ progressSeq: 3, progressHash: other })],
      }),
    );
    expect(await detectAuditFork(mismatch.port, org, mismatch.options)).toBe('blocked');
  });

  it('allows absent and older receiver frontiers and sinks without a query', async () => {
    for (const receiver of [probe(null), probe(position({ epoch: 1 })), { deliver: vi.fn() }]) {
      const f = fixture();
      expect(
        await detectAuditFork(f.port, org, {
          ...f.options,
          probes: [{ id: 'archive', sink: receiver }],
        }),
      ).toBe('clear');
    }
  });

  it('does not expose probe exceptions or treat invalid replies as a clean check', async () => {
    const f = fixture();
    for (const receiver of [
      { deliver: vi.fn(), frontier: vi.fn().mockRejectedValue(new Error('private request data')) },
      probe(position({ seq: -1 })),
    ]) {
      expect(
        await detectAuditFork(f.port, org, {
          ...f.options,
          probes: [{ id: 'archive', sink: receiver }],
        }),
      ).toBe('unavailable');
    }
    expect(f.save).not.toHaveBeenCalled();
    expect(f.alert).not.toHaveBeenCalled();
  });

  it('still blocks on a second receiver when the first receiver is unavailable', async () => {
    const f = fixture(snapshot({ sinks: [sink(), sink({ id: 'second' })] }));
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        probes: [
          {
            id: 'archive',
            sink: {
              deliver: vi.fn(),
              frontier: vi.fn().mockRejectedValue(new Error('unavailable')),
            },
          },
          { id: 'second', sink: probe(position({ hash: other })) },
        ],
      }),
    ).toBe('blocked');
    expect(f.change().sinks.every((s) => s.state === 'blocked')).toBe(true);
  });

  it('does not mutate or probe from an older build', async () => {
    const f = fixture(snapshot({ restorePending: true }));
    const receiver = probe(position());
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        generation: 2,
        probes: [{ id: 'archive', sink: receiver }],
      }),
    ).toBe('stale');
    expect(f.save).not.toHaveBeenCalled();
    expect(receiver.frontier).not.toHaveBeenCalled();
  });

  it('retries contention three times and alerts on the observed fork', async () => {
    const f = fixture(snapshot({ restorePending: true }));
    f.save.mockResolvedValue(false);
    expect(await detectAuditFork(f.port, org, f.options)).toBe('contended');
    expect(f.save).toHaveBeenCalledTimes(4);
    expect(f.alert).toHaveBeenCalledWith('restore_detected');
  });
});

describe('frontier deadlines', () => {
  it('returns unavailable when a probe ignores cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const receiver = {
      deliver: vi.fn(),
      frontier: vi.fn(() => new Promise<AuditPositionV1 | null>(() => {})),
    };
    const result = detectAuditFork(f.port, org, {
      ...f.options,
      signal: controller.signal,
      probes: [{ id: 'archive', sink: receiver }],
    });
    await vi.waitFor(() => expect(receiver.frontier).toHaveBeenCalled());
    controller.abort();
    expect(await result).toBe('unavailable');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('bounds a receiver that never settles to ten seconds', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const receiver = {
        deliver: vi.fn(),
        frontier: vi.fn(() => new Promise<AuditPositionV1 | null>(() => {})),
      };
      const result = detectAuditFork(f.port, org, {
        ...f.options,
        probes: [{ id: 'archive', sink: receiver }],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe('unavailable');
      expect(f.save).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restore confirmation', () => {
  it('replaces old frozen batches with a fork marker before replay and preserves unrelated blocks', async () => {
    const old = sink({
      state: 'blocked',
      blockedReason: 'fork',
      progressSeq: 9,
      inflightBody: '{"epoch":1}',
      inflightFrom: 10,
      inflightTo: 11,
      attempt: 5,
      nextAttemptAt: '2026-10-31T12:00:00.000Z',
      lastErrorCode: 'timeout',
    });
    const retired = sink({ id: 'retired', state: 'retired' });
    const f = fixture(
      snapshot({
        restorePending: true,
        sinks: [
          old,
          sink({ id: 'refused', state: 'blocked', blockedReason: 'rejected' }),
          sink({ id: 'absent', state: 'inactive', blockedReason: 'fork' }),
          sink({ id: 'disabled', state: 'disabled' }),
          retired,
        ],
      }),
    );
    expect(
      await confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 4,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).toBe('confirmed');
    expect(f.change()).toMatchObject({
      epoch: 2,
      restorePending: false,
      boundaryReason: null,
    });
    const next = f.change().sinks[0]!;
    expect(next).toMatchObject({
      state: 'active',
      blockedReason: null,
      progressSeq: 3,
      progressHash: hash,
      custodySeq: 3,
      inflightBody: null,
      inflightFrom: null,
      inflightTo: null,
      attempt: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
    });
    expect(JSON.parse(next.inflightRepr!)).toMatchObject({
      custodyFromSeq: 1,
      purpose: 'idle',
      registryMarkers: [
        { kind: 'fork', chainId, epoch: 2, lastCommonSeq: 3, lastCommonHash: hash },
      ],
    });
    expect(f.change().sinks.map((s) => s.state)).toEqual([
      'active',
      'blocked',
      'inactive',
      'disabled',
      'retired',
    ]);
    expect(f.change().sinks[4]).toBe(retired);
    assertAuditLedgerEntry(f.change().ledger[0]!);
    expect(f.change().ledger[0]).toMatchObject({ kind: 'restore_confirmed', fromSeq: 4 });
    expect(f.change().event).toMatchObject({ action: 'audit.sink_admin' });
    expect(f.save.mock.calls[0]![2]).toEqual([{ seq: 3, hash }]);
  });

  it('delivers the new-epoch fork marker through the existing exporter before replay', async () => {
    const f = fixture(
      snapshot({
        restorePending: true,
        sinks: [
          sink({
            state: 'blocked',
            blockedReason: 'fork',
            inflightBody: JSON.stringify({ chainId, epoch: 1 }),
          }),
        ],
      }),
    );
    await confirmAuditRestore(f.port, org, {
      alert: () => {},
      generation: 3,
      fromSeq: 4,
      now,
      actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
    });
    let stored: AuditExportSnapshot = {
      ...snapshot(),
      highestGeneration: 3,
      sink: f.change().sinks[0]!,
    };
    const page = vi.fn<AuditExportPort['page']>().mockResolvedValue([]);
    const port: AuditExportPort = {
      read: async () => stored,
      page,
      save: async (_org, _fence, expected, next) => {
        if (expected.sink !== stored.sink) return false;
        stored = { ...stored, sink: next };
        return true;
      },
    };
    const deliver = vi.fn<AuditSink['deliver']>().mockImplementation(async (batch) => ({
      outcome: 'accepted',
      chainId: batch.chainId,
      epoch: batch.epoch,
      throughSeq: batch.throughSeq,
      throughHash: batch.throughHash,
    }));
    const fence = systemMutationFence('audit-export', { id: 'job', owner: 'owner', fence: 1 }, {});
    const options = {
      id: 'archive',
      generation: 3,
      pluginVersion: '1.0.0',
      sourceIp: 'include' as const,
      sink: { deliver },
      now: () => now,
      resolve: vi.fn(),
    };
    expect(await exportAuditBatch(port, org, fence, options, f.options.signal)).toBe('accepted');
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0]).toMatchObject({
      epoch: 2,
      throughSeq: 3,
      throughHash: hash,
      records: [{ kind: 'fork', epoch: 2, lastCommonSeq: 3, lastCommonHash: hash }],
    });
    expect(page).not.toHaveBeenCalled();
    expect(stored.sink).toMatchObject({ progressSeq: 3, custodySeq: 3, inflightBody: null });
    expect(await exportAuditBatch(port, org, fence, options, f.options.signal)).toBe('idle');
    expect(page).toHaveBeenCalledWith(org, 3, 100);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each([1, 6])('supports replay from %i, including an empty suffix', async (fromSeq) => {
    const f = fixture(snapshot({ restorePending: true }));
    expect(
      await confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).toBe('confirmed');
    if (fromSeq === 1) expect(f.hashAt).not.toHaveBeenCalled();
    else expect(f.hashAt).toHaveBeenCalledWith(org, fromSeq - 1);
    expect(f.change().sinks[0]!.progressSeq).toBe(fromSeq - 1);
  });

  it.each([0, -1, 7, 2.5, NaN])('refuses invalid replay position %s', async (fromSeq) => {
    const f = fixture(snapshot({ restorePending: true }));
    await expect(
      confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).rejects.toThrow('Invalid audit restore range');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('refuses replay before retention or across a missing predecessor', async () => {
    const f = fixture(snapshot({ restorePending: true, boundarySeq: 4 }));
    await expect(
      confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 3,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).rejects.toThrow('Invalid audit restore range');
    const missing = fixture(snapshot({ restorePending: true }));
    missing.hashAt.mockResolvedValue(null);
    await expect(
      confirmAuditRestore(missing.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 4,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).rejects.toThrow('Audit restore position unavailable');
    expect(missing.save).not.toHaveBeenCalled();
  });

  it('requires pending restore, current build, and a successful CAS', async () => {
    const clear = fixture();
    await expect(
      confirmAuditRestore(clear.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 1,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).rejects.toThrow('Audit restore confirmation unavailable');
    const f = fixture(snapshot({ restorePending: true }));
    expect(
      await confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 2,
        fromSeq: 1,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).toBe('stale');
    expect(f.save).not.toHaveBeenCalled();
    f.save.mockResolvedValue(false);
    expect(
      await confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 1,
        now,
        actor: { type: 'user', id: '01JZZZZZZZZZZZZZZZZZZZZZZX' },
      }),
    ).toBe('contended');
  });
});

describe('restore replay invariants', () => {
  it.each(['active', 'inactive', 'disabled', 'blocked'] as const)(
    'keeps lagging %s progress, custody start, queued markers and operator identity',
    async (state) => {
      const queued = [
        'boundary',
        'receiver_changed',
        'gap',
        'tombstone',
        'delivery_uncertain',
        'withheld',
      ].map((kind) => ({ kind }));
      const f = fixture(
        snapshot({
          restorePending: true,
          sinks: [
            sink({
              state,
              blockedReason: state === 'blocked' ? 'rejected' : null,
              progressSeq: 2,
              progressHash: other,
              custodySeq: 1,
              inflightRepr: JSON.stringify({
                custodyFromSeq: 1,
                registryMarkers: queued,
                registryMarkerBody: '{"epoch":1}',
                registryMarkerOriginalAttempt: 7,
                registryMarkerOriginalErrorCode: 'timeout',
              }),
            }),
          ],
        }),
      );
      f.hashAt.mockImplementation(async (_org, seq) => (seq === 2 ? other : hash));
      const actor = { type: 'user' as const, id: org.orgId };
      expect(
        await confirmAuditRestore(f.port, org, {
          alert: () => {},
          generation: 3,
          fromSeq: 5,
          now,
          actor,
        }),
      ).toBe('confirmed');
      const next = f.change().sinks[0]!;
      expect(next).toMatchObject({
        state,
        progressSeq: 2,
        progressHash: other,
        custodySeq: 1,
        retryCountForSeq: 0,
      });
      expect(f.hashAt).toHaveBeenCalledWith(org, 2);
      expect(JSON.parse(next.inflightRepr!)).toEqual({
        custodyFromSeq: 1,
        purpose: 'idle',
        registryMarkers: [expect.objectContaining({ kind: 'fork' }), ...queued],
      });
      expect(f.change().ledger[0]).toMatchObject({ actorType: 'user', actorId: actor.id });
      expect(f.change().event?.actor).toEqual(actor);
    },
  );

  it('refuses to replace a mismatching common-point sink hash', async () => {
    const f = fixture(
      snapshot({ restorePending: true, sinks: [sink({ progressSeq: 3, progressHash: other })] }),
    );
    await expect(
      confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        fromSeq: 4,
        now,
        actor: { type: 'user', id: org.orgId },
      }),
    ).rejects.toThrow('Audit restore sink position unavailable');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not rewrite an already blocked restore', async () => {
    const f = fixture(
      snapshot({
        restorePending: true,
        sinks: [sink({ state: 'blocked', blockedReason: 'fork' })],
      }),
    );
    expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('checks registry marker frozen epochs', async () => {
    const f = fixture(
      snapshot({
        sinks: [
          sink({
            inflightRepr: JSON.stringify({
              custodyFromSeq: 1,
              registryMarkerBody: JSON.stringify({ chainId, epoch: 1 }),
            }),
          }),
        ],
      }),
    );
    expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
    expect(f.alert).toHaveBeenCalledWith('local_fork');
  });

  it('accepts recorded seq gaps at both local and receiver positions', async () => {
    const f = fixture(
      snapshot({
        history: [{ kind: 'gap', chainId, epoch: 2, fromSeq: 5, toSeq: 5, reasonCode: 'seq_gap' }],
      }),
    );
    f.hashAt.mockResolvedValue(null);
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        probes: [{ id: 'archive', sink: probe(position()) }],
      }),
    ).toBe('clear');
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each(['batch_limit', 'history_limit'] as const)(
    'alerts and refuses a %s failure',
    async (reason) => {
      const f = fixture(snapshot({ restorePending: true }));
      if (reason === 'history_limit')
        vi.mocked(f.port.read).mockRejectedValue(new AuditForkLimitError(reason));
      else f.save.mockRejectedValue(new AuditForkLimitError(reason));
      await expect(detectAuditFork(f.port, org, f.options)).rejects.toMatchObject({
        name: 'AuditForkLimitError',
        reason,
      });
      expect(f.alert).toHaveBeenCalledWith(reason);
      await expect(
        confirmAuditRestore(f.port, org, {
          ...f.options,
          fromSeq: 1,
          actor: { type: 'user', id: org.orgId },
        }),
      ).rejects.toMatchObject({ name: 'AuditForkLimitError', reason });
      expect(f.alert).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['customer', 'system'] as const)(
    'rejects a %s restore actor before reading',
    async (type) => {
      const f = fixture(snapshot({ restorePending: true }));
      await expect(
        confirmAuditRestore(f.port, org, {
          alert: () => {},
          generation: 3,
          now,
          fromSeq: 1,
          // Exercise callers that bypass the TypeScript actor restriction.
          // @ts-expect-error invalid operator type
          actor: { type, id: org.orgId },
        }),
      ).rejects.toThrow('Invalid audit restore actor');
      expect(f.port.read).not.toHaveBeenCalled();
    },
  );
  it('does not exempt a gap from another epoch', async () => {
    const f = fixture(
      snapshot({
        history: [{ kind: 'gap', chainId, epoch: 1, fromSeq: 5, toSeq: 5, reasonCode: 'seq_gap' }],
      }),
    );
    f.hashAt.mockResolvedValue(null);
    expect(await detectAuditFork(f.port, org, f.options)).toBe('blocked');
  });
  it.each([1, 2])(
    'confirms kept progress on a gap only in the current epoch: epoch=%s',
    async (epoch) => {
      const f = fixture(
        snapshot({
          restorePending: true,
          sinks: [sink({ progressSeq: 3 })],
          history: [{ kind: 'gap', chainId, epoch, fromSeq: 3, toSeq: 3, reasonCode: 'seq_gap' }],
        }),
      );
      f.hashAt.mockImplementation(async (_org, seq) => (seq === 3 ? null : hash));
      const result = confirmAuditRestore(f.port, org, {
        alert: () => {},
        generation: 3,
        now,
        fromSeq: 5,
        actor: { type: 'service_principal', id: org.orgId },
      });
      if (epoch === 2) {
        expect(await result).toBe('confirmed');
        expect(f.change().sinks[0]).toMatchObject({ progressSeq: 3, progressHash: hash });
      } else {
        await expect(result).rejects.toThrow('Audit restore sink position unavailable');
        expect(f.save).not.toHaveBeenCalled();
      }
    },
  );
  it('accepts an older chain only when a chain reset records it', async () => {
    const oldChain = 'd'.repeat(32);
    const f = fixture(
      snapshot({
        history: [
          {
            kind: 'chain_reset',
            chainId: oldChain,
            epoch: 1,
            fromSeq: 1,
            toSeq: 5,
            reasonCode: 'tamper_detected',
          },
        ],
      }),
    );
    expect(
      await detectAuditFork(f.port, org, {
        ...f.options,
        probes: [{ id: 'archive', sink: probe(position({ chainId: oldChain })) }],
      }),
    ).toBe('clear');
  });

  it('starts receiver probes together', async () => {
    const f = fixture(snapshot({ sinks: [sink(), sink({ id: 'second' })] }));
    let release!: (value: null) => void;
    const first = {
      deliver: vi.fn(),
      frontier: vi.fn(
        () =>
          new Promise<null>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const second = probe(null);
    const result = detectAuditFork(f.port, org, {
      ...f.options,
      probes: [
        { id: 'archive', sink: first },
        { id: 'second', sink: second },
      ],
    });
    await vi.waitFor(() => expect(second.frontier).toHaveBeenCalledOnce());
    release(null);
    expect(await result).toBe('clear');
  });
});

describe('contended receiver checks', () => {
  it('re-reads and re-detects instead of replaying a stale change', async () => {
    const f = fixture(snapshot({ restorePending: true }));
    f.save.mockResolvedValue(false);
    vi.mocked(f.port.read)
      .mockResolvedValueOnce(snapshot({ restorePending: true }))
      .mockResolvedValue(snapshot());
    expect(await detectAuditFork(f.port, org, f.options)).toBe('clear');
    expect(f.port.read).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.alert).not.toHaveBeenCalled();
  });

  it('bounds all probe retries to thirty seconds and keeps an observed fork alert', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(snapshot({ sinks: [sink(), sink({ id: 'slow' })] }));
      f.save.mockResolvedValue(false);
      const result = detectAuditFork(f.port, org, {
        ...f.options,
        probes: [
          { id: 'archive', sink: probe(position({ seq: 6 })) },
          {
            id: 'slow',
            sink: { deliver: vi.fn(), frontier: vi.fn(() => new Promise<null>(() => {})) },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBe('contended');
      expect(f.alert).toHaveBeenCalledWith('receiver_fork');
    } finally {
      vi.useRealTimers();
    }
  });
});
