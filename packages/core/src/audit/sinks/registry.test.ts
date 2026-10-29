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

const ctx = orgContext('organization');
const now = new Date('2026-10-28T12:00:00.000Z');
const registration: AuditSinkRegistration = {
  id: 'archive',
  kind: 'webhook',
  pluginId: 'audit',
  durableAck: true,
  destination: { receiverFingerprint: 'a'.repeat(64), activationSource: 'ARCHIVE_URL' },
};
const snapshot = (): AuditSinkSnapshot => ({
  chainId: 'chain',
  epoch: 1,
  generation: 1,
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
    inflightRepr: null,
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
      inflightRepr: '{"v":1}',
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
      inflightRepr: '{"v":1,"sourceIp":"include","pluginVersion":"1"}',
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

  it('disables removed sinks and keeps them holding pruning', async () => {
    const old = await existing();
    const f = fixture({ ...snapshot(), sinks: [old] });
    await reconcileAuditSinks(f.port, ctx, 2, [], now);
    expect(f.next()).toEqual({ ...old, generation: 2, state: 'disabled' });
    expect(auditSinkPruneProgress([], [f.next()])).toBe(12);
    expect(auditSinkPruneProgress(['missing'], [f.next()])).toBe(0);
    expect(auditSinkPruneProgress([], [{ ...old, state: 'inactive' }])).toBe(0);
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

  it('rejects older generations even if a sink row is ahead of the chain', async () => {
    for (const state of [
      snapshot(),
      { ...snapshot(), generation: 0, sinks: [{ ...(await existing()), generation: 2 }] },
    ]) {
      const f = fixture(state);
      expect(await reconcileAuditSinks(f.port, ctx, 0, [], now)).toBe('stale');
      expect(f.save).not.toHaveBeenCalled();
    }
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
    ]) {
      await expect(reconcileAuditSinks(f.port, ctx, 1, [unsafe], now)).rejects.toThrow(
        'Invalid audit sink registration',
      );
    }
    await expect(
      reconcileAuditSinks(f.port, ctx, 1, [registration, registration], now),
    ).rejects.toThrow('Invalid audit sink registration');
    expect(f.port.read).not.toHaveBeenCalled();
  });
});
