import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import {
  auditSinkPruneProgress,
  reconcileAuditSinks,
  type AuditSinkRegistration,
  type AuditSinkRegistryPort,
  type AuditSinkSnapshot,
  type AuditSinkState,
} from './registry.js';

const ctx = orgContext('01JZZZZZZZZZZZZZZZZZZZZZZX');
const now = new Date('2026-10-28T12:00:00.000Z');
const registration: AuditSinkRegistration = {
  id: 'archive',
  kind: 'webhook',
  pluginId: 'audit',
  durableAck: true,
  destination: { receiverFingerprint: 'a'.repeat(64), activationSource: 'ARCHIVE_URL' },
};
const snapshot = (): AuditSinkSnapshot => ({
  chainId: 'a'.repeat(32),
  epoch: 1,
  incarnation: 0,
  modeGeneration: 50,
  boundarySeq: 8,
  boundaryPrevHash: 'b'.repeat(64),
  boundaryReason: 'prune',
  policy: 'availability',
  restorePending: false,
  sinks: [],
});
function fixture(state = snapshot()) {
  const save = vi.fn<AuditSinkRegistryPort['save']>().mockResolvedValue(true);
  const port: AuditSinkRegistryPort = { read: vi.fn().mockResolvedValue(state), save };
  return { port, save, next: () => save.mock.calls[0]![2].sinks[0]! };
}
async function existing(): Promise<AuditSinkState> {
  const f = fixture();
  await reconcileAuditSinks(f.port, ctx, 1, [registration], now);
  return {
    ...f.next(),
    inflightFrom: null,
    inflightTo: null,
    inflightBody: null,
    inflightRepr: JSON.stringify({ custodyFromSeq: 8 }),
    progressSeq: 12,
    progressHash: 'c'.repeat(64),
    custodySeq: 10,
  };
}

describe('audit sink registry', () => {
  it('starts at the retained boundary and persists a non-advancing boundary batch', async () => {
    const f = fixture();
    expect(await reconcileAuditSinks(f.port, ctx, 1, [registration], now)).toBe('applied');
    expect(f.next()).toMatchObject({
      state: 'active',
      progressSeq: 7,
      custodySeq: 7,
      progressHash: 'b'.repeat(64),
    });
    expect(JSON.parse(f.next().inflightBody!)).toMatchObject({
      orgId: ctx.orgId,
      throughSeq: 7,
      throughHash: 'b'.repeat(64),
      records: [{ kind: 'boundary', boundarySeq: 8, provenance: 'prune' }],
    });
  });

  it('creates no marker at genesis, and records absent destinations as inactive', async () => {
    const f = fixture({ ...snapshot(), boundarySeq: 1, boundaryPrevHash: '0'.repeat(64) });
    await reconcileAuditSinks(f.port, ctx, 1, [{ ...registration, destination: null }], now);
    expect(f.next()).toMatchObject({
      state: 'inactive',
      progressSeq: 0,
      custodySeq: 0,
      inflightBody: null,
    });
  });

  it('keeps inactive cursors and frozen bytes, then reactivates without replay', async () => {
    const old = {
      ...(await existing()),
      inflightBody: '{"frozen":true}',
      inflightRepr: '{"v":1,"custodyFromSeq":8}',
      inflightFrom: 13,
      inflightTo: 14,
    };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 2, [{ ...registration, destination: null }], now);
    expect(f.next()).toEqual({ ...old, state: 'inactive', generation: 2 });
    const active = fixture({ ...snapshot(), sinks: [f.next()] });
    await reconcileAuditSinks(active.port, ctx, 2, [registration], now);
    expect(active.next()).toEqual({ ...old, generation: 2 });
  });

  it('changes receivers without resetting either watermark and records custody provenance', async () => {
    const old = await existing();
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(
      f.port,
      ctx,
      2,
      [
        {
          ...registration,
          destination: { ...registration.destination!, receiverFingerprint: 'd'.repeat(64) },
        },
      ],
      now,
    );
    expect(f.next()).toMatchObject({ progressSeq: 12, custodySeq: 10 });
    expect(JSON.parse(f.next().inflightBody!).records).toEqual([
      expect.objectContaining({
        kind: 'receiver_changed',
        oldFingerprint: old.receiverFingerprint,
        newFingerprint: 'd'.repeat(64),
      }),
    ]);
    expect(f.save.mock.calls[0]![2].rebinds).toEqual([
      expect.objectContaining({
        sinkId: 'archive',
        custodySeq: 10,
        fromSeq: 8,
        event: expect.objectContaining({
          action: 'audit.sink_admin',
          sourceIp: null,
          tokenSelector: null,
        }),
      }),
    ]);
  });

  it('queues a receiver marker ahead of a frozen batch without changing its bytes or representation fields', async () => {
    const old = {
      ...(await existing()),
      inflightBody: '{"frozen":true}',
      inflightRepr: '{"v":1,"sourceIp":"include","pluginVersion":"1","custodyFromSeq":8}',
      inflightFrom: 13,
      inflightTo: 14,
    };
    const f = fixture({ ...snapshot(), sinks: [old] });
    expect(
      await reconcileAuditSinks(
        f.port,
        ctx,
        2,
        [
          {
            ...registration,
            destination: { ...registration.destination!, receiverFingerprint: 'd'.repeat(64) },
          },
        ],
        now,
      ),
    ).toBe('applied');
    expect(f.next()).toMatchObject({
      inflightBody: old.inflightBody,
      inflightFrom: 13,
      inflightTo: 14,
      progressSeq: 12,
      custodySeq: 10,
    });
    expect(JSON.parse(f.next().inflightRepr!)).toEqual({
      ...JSON.parse(old.inflightRepr),
      custodyFromSeq: 11,
      durableCustodySeq: 10,
      durableAckRanges: [],
      registryMarkers: [
        expect.objectContaining({
          kind: 'receiver_changed',
          oldFingerprint: old.receiverFingerprint,
          newFingerprint: 'd'.repeat(64),
        }),
      ],
    });
  });

  it('refuses malformed stored representation without exposing its bytes', async () => {
    const old = { ...(await existing()), inflightBody: '{}', inflightRepr: 'secret@example.com' };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await expect(
      reconcileAuditSinks(
        f.port,
        ctx,
        2,
        [
          {
            ...registration,
            destination: { ...registration.destination!, receiverFingerprint: 'd'.repeat(64) },
          },
        ],
        now,
      ),
    ).rejects.toThrow(new Error('Audit sink representation malformed'));
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([null, '{}', '{"custodyFromSeq":0}', '{"custodyFromSeq":"8"}'])(
    'fails closed when a non-fresh row lacks valid custody start metadata: %s',
    async (inflightRepr) => {
      const f = fixture({ ...snapshot(), sinks: [{ ...(await existing()), inflightRepr }] });
      await expect(reconcileAuditSinks(f.port, ctx, 2, [registration], now)).rejects.toThrow(
        new Error('Audit sink custody start unavailable'),
      );
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('distinguishes repeated receiver transitions by custody position', async () => {
    let old = await existing();
    const ids: string[] = [];
    for (const [index, fingerprint] of ['d', 'a', 'd'].entries()) {
      const f = fixture({ ...snapshot(), sinks: [old] });
      await reconcileAuditSinks(
        f.port,
        ctx,
        index + 2,
        [
          {
            ...registration,
            destination: {
              ...registration.destination!,
              receiverFingerprint: fingerprint.repeat(64),
            },
          },
        ],
        now,
      );
      const marker = JSON.parse(f.next().inflightBody!).records[0];
      ids.push(marker.markerId);
      old = {
        ...f.next(),
        custodySeq: old.custodySeq + 2,
        inflightBody: null,
        inflightFrom: null,
        inflightTo: null,
      };
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('disables removed sinks and keeps them holding pruning', async () => {
    const old = await existing();
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 2, [], now);
    expect(f.next()).toEqual({ ...old, generation: 2, state: 'disabled' });
    expect(auditSinkPruneProgress([], [f.next()])).toBe(12);
    expect(auditSinkPruneProgress(['missing'], [f.next()])).toBe(0);
    expect(auditSinkPruneProgress([], [{ ...old, state: 'inactive' }])).toBeNull();
  });

  it('does not unblock a sink when it is disabled and re-added', async () => {
    const old = { ...(await existing()), state: 'disabled' as const, blockedReason: 'fork' };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 2, [registration], now);
    expect(f.next()).toMatchObject({ state: 'blocked', blockedReason: 'fork' });
  });

  it('blocks newly configured sinks while a restore is pending', async () => {
    const f = fixture({ ...snapshot(), restorePending: true });
    await reconcileAuditSinks(f.port, ctx, 2, [registration], now);
    expect(f.next()).toMatchObject({ state: 'blocked', blockedReason: 'fork' });
  });

  it('gates builds by sink generation independently of mode generation', async () => {
    const fresh = fixture();
    expect(await reconcileAuditSinks(fresh.port, ctx, 0, [], now)).toBe('applied');
    const f = fixture({ ...snapshot(), sinks: [{ ...(await existing()), generation: 2 }] });
    expect(await reconcileAuditSinks(f.port, ctx, 1, [], now)).toBe('stale');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('leaves retired rows alone until a newer build reuses them', async () => {
    const old = { ...(await existing()), state: 'retired' as const };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 1, [registration], now);
    expect(f.next()).toEqual(old);
    const newer = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(newer.port, ctx, 2, [registration], now);
    expect(newer.next()).toMatchObject({ state: 'active', progressSeq: 7, custodySeq: 7 });
  });

  it('preserves an existing block and keeps absent destinations inactive during restore', async () => {
    const old = { ...(await existing()), blockedReason: 'operator_block' };
    for (const destination of [registration.destination, null]) {
      const f = fixture({ ...snapshot(), restorePending: true, sinks: [old] });
      await reconcileAuditSinks(f.port, ctx, 2, [{ ...registration, destination }], now);
      expect(f.next()).toMatchObject({
        state: destination === null ? 'inactive' : 'blocked',
        blockedReason: 'operator_block',
      });
    }
    const f = fixture({ ...snapshot(), restorePending: true });
    await reconcileAuditSinks(f.port, ctx, 2, [{ ...registration, destination: null }], now);
    expect(f.next()).toMatchObject({ state: 'inactive', blockedReason: 'fork' });
    expect(auditSinkPruneProgress(['archive'], [f.next()])).toBeNull();
    expect(auditSinkPruneProgress([], [])).toBeNull();
    expect(auditSinkPruneProgress([], [{ ...old, state: 'retired' }])).toBeNull();
  });

  it('treats a retired receiver as a fresh registration even when all receiver properties change', async () => {
    const f = fixture({ ...snapshot(), sinks: [{ ...(await existing()), state: 'retired' }] });
    await reconcileAuditSinks(
      f.port,
      ctx,
      2,
      [
        {
          ...registration,
          pluginId: 'other',
          kind: 'otlp',
          durableAck: false,
          destination: { ...registration.destination!, receiverFingerprint: 'e'.repeat(64) },
        },
      ],
      now,
    );
    expect(f.save.mock.calls[0]![2].rebinds).toEqual([]);
    expect(JSON.parse(f.next().inflightBody!).records).toEqual([
      expect.objectContaining({ kind: 'boundary' }),
    ]);
    expect(f.next()).toMatchObject({ progressSeq: 7, custodySeq: 7 });
  });

  it.each([{ pluginId: 'audit-v2-archive' }, { kind: 'otlp' }, { durableAck: false }])(
    'records receiver configuration changes %j',
    async (change) => {
      const old = {
        ...(await existing()),
        inflightRepr: JSON.stringify({
          custodyFromSeq: 8,
          durableCustodySeq: 99,
          durableAckRanges: [{ from: 8, to: 99 }],
        }),
      };
      const f = fixture({ ...snapshot(), sinks: [old] });
      await reconcileAuditSinks(f.port, ctx, 2, [{ ...registration, ...change }], now);
      expect(f.save.mock.calls[0]![2].rebinds).toHaveLength(1);
      expect(f.next().inflightBody).toBeNull();
      expect(JSON.parse(f.next().inflightRepr!)).toMatchObject({
        custodyFromSeq: 11,
        durableCustodySeq: 10,
        durableAckRanges: [],
      });
    },
  );

  it('starts durable custody after existing progress when durableAck flips on', async () => {
    const old = { ...(await existing()), durableAck: false };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 2, [registration], now);
    expect(JSON.parse(f.next().inflightRepr!)).toMatchObject({
      custodyFromSeq: 13,
      durableCustodySeq: 12,
      durableAckRanges: [],
    });
    expect(f.save.mock.calls[0]![2].rebinds).toHaveLength(1);
    expect(f.next()).toMatchObject({ custodySeq: 10, progressSeq: 12, durableAck: true });
  });

  it('records a configuration change while a previously registered receiver is inactive', async () => {
    const old = { ...(await existing()), state: 'inactive' as const };
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(
      f.port,
      ctx,
      2,
      [{ ...registration, destination: null, durableAck: false }],
      now,
    );
    expect(f.next().state).toBe('inactive');
    expect(f.save.mock.calls[0]![2].rebinds).toHaveLength(1);
    expect(f.next().inflightBody).toBeNull();
  });

  it('collapses repeated queued receiver changes to first-old and last-new with stable ids', async () => {
    let old: AuditSinkState = { ...(await existing()), inflightBody: '{"frozen":true}' };
    for (const fingerprint of ['d', 'e', 'f', 'a']) {
      const f = fixture({ ...snapshot(), sinks: [old] });
      await reconcileAuditSinks(
        f.port,
        ctx,
        2,
        [
          {
            ...registration,
            destination: {
              ...registration.destination!,
              receiverFingerprint: fingerprint.repeat(64),
            },
          },
        ],
        now,
      );
      old = f.next();
      expect(old.inflightBody).toBe('{"frozen":true}');
      expect(JSON.parse(old.inflightRepr!).registryMarkers).toEqual([
        expect.objectContaining({
          kind: 'receiver_changed',
          oldFingerprint: 'a'.repeat(64),
          newFingerprint: fingerprint.repeat(64),
        }),
      ]);
    }
    const f = fixture();
    const retry = fixture();
    await reconcileAuditSinks(f.port, ctx, 1, [registration], now);
    await reconcileAuditSinks(retry.port, ctx, 1, [registration], new Date(now.getTime() + 1000));
    expect(f.next().inflightBody).toBe(retry.next().inflightBody);
  });

  it.each([null, 'retained_suffix', 'secret@example.com'])(
    'refuses invalid boundary provenance %s',
    async (boundaryReason) => {
      const f = fixture({ ...snapshot(), boundaryReason });
      await expect(reconcileAuditSinks(f.port, ctx, 1, [registration], now)).rejects.toThrow(
        new TypeError('Invalid audit boundary reason'),
      );
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('reports a lost compare-and-swap without claiming success', async () => {
    const f = fixture();
    f.save.mockResolvedValue(false);
    expect(await reconcileAuditSinks(f.port, ctx, 2, [registration], now)).toBe('contended');
  });

  it('refuses unsafe identifiers without echoing input', async () => {
    const f = fixture();
    for (const unsafe of [
      { ...registration, id: 'secret@example.com' },
      { ...registration, id: 'archive\n' },
      ...['1audit', 'audit\n', 'audit.v2', 'audit_v2', 'core'].map((pluginId) => ({
        ...registration,
        pluginId,
      })),
    ]) {
      await expect(reconcileAuditSinks(f.port, ctx, 1, [unsafe], now)).rejects.toThrow(
        new TypeError('Invalid audit sink registration'),
      );
    }
    await expect(
      reconcileAuditSinks(f.port, ctx, 1, [registration, registration], now),
    ).rejects.toThrow(new TypeError('Invalid audit sink registration'));
    expect(f.port.read).not.toHaveBeenCalled();
  });
});
