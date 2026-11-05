import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { AUDIT_NONE_WARNING, validateAuditBuild } from './effective.js';
import {
  auditNoneStatus,
  enterAuditNone,
  pruneAuditNone,
  type AuditNoneOptions,
  type AuditNonePort,
  type AuditNoneSnapshot,
} from './none.js';

const ctx = orgContext('org-a');
const initial: AuditNoneSnapshot = {
  chainId: 'a'.repeat(32),
  epoch: 0,
  incarnation: 1,
  headSeq: 4,
  mode: 'trail',
  pendingMode: null,
  modeGeneration: 2,
  cutoverSeq: null,
  policy: 'availability',
  restorePending: false,
};
function options(acceptance: 'build' | 'env' = 'build'): AuditNoneOptions {
  return {
    audit: {
      build: validateAuditBuild(
        {
          platform: 'cloudflare',
          plugins: [],
          audit: acceptance === 'build' ? { acceptNoDurableAudit: true } : {},
        },
        (name) =>
          acceptance === 'env' && name === 'PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT' ? 'true' : undefined,
        'cloudflare',
      ),
      sinks: [],
      alertPathActive: false,
    },
    generation: 3,
    now: '2026-10-30T12:00:00.000Z',
    ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX'],
  };
}
function storage(state = initial) {
  let stored = { ...state };
  const snapshot = vi.fn<AuditNonePort['snapshot']>(async () => ({ ...stored }));
  const record = vi.fn<AuditNonePort['record']>(async (_ctx, expected) => {
    stored = {
      ...expected,
      pendingMode: 'none',
      modeGeneration: expected.modeGeneration + 1,
      cutoverSeq: expected.headSeq,
    };
    return true;
  });
  return { snapshot, record };
}

describe('mode none', () => {
  it.each(['build', 'env'] as const)(
    'records %s acceptance and cutover before pruning',
    async (source) => {
      const port = storage();
      const prune = vi.fn(async () => {
        expect(port.record).toHaveBeenCalledTimes(1);
        expect(auditNoneStatus(await port.snapshot(ctx)).degraded).toBe(true);
        return { outcome: 'retained' } as const;
      });
      const result = await pruneAuditNone(port, { prune }, ctx, {
        ...options(source),
        prune: { configuredSinkIds: [], limit: 100 },
      });
      expect(result).toEqual({
        outcome: 'degraded',
        status: { degraded: true, warning: AUDIT_NONE_WARNING, modeGeneration: 3, cutoverSeq: 4 },
        prune: { outcome: 'retained' },
      });
      expect(port.record.mock.calls[0]?.slice(0, 3)).toEqual([ctx, initial, 3]);
      const entries = port.record.mock.calls[0]![3];
      expect(entries.map((entry) => entry.kind)).toEqual(['mode_change', 'cutover']);
      expect(entries).toEqual([
        expect.objectContaining({
          policy: 'availability',
          modeGeneration: 3,
          fromSeq: 4,
          toSeq: 4,
        }),
        expect.objectContaining({
          policy: 'availability',
          modeGeneration: 3,
          fromSeq: 4,
          toSeq: 4,
        }),
      ]);
      const event = port.record.mock.calls[0]![4];
      expect(event).toMatchObject({
        action: 'audit.mode_change',
        sourceIp: null,
        tokenSelector: null,
      });
      const payload = JSON.parse(event.payloadJson);
      expect(payload.op_id).toBeNull();
      expect(payload.request_id).toBeNull();
      expect(JSON.parse(event.payloadJson).changes).toEqual({
        from_mode: { new: 'trail' },
        to_mode: { new: 'none' },
        policy: { new: 'availability' },
        source: { new: source },
        mode_generation: { new: 3 },
        cutover_seq: { new: 4 },
      });
      expect(prune).toHaveBeenCalledExactlyOnceWith(ctx, {
        generation: 3,
        trailActive: false,
        configuredSinkIds: [],
        limit: 100,
      });
    },
  );

  it('retains degraded status after successful deletion and across coordinator instances', async () => {
    const port = storage();
    const prune = vi.fn().mockResolvedValue({ outcome: 'pruned', pruned: 4, boundarySeq: 5 });
    await pruneAuditNone(port, { prune }, ctx, { ...options(), prune: { configuredSinkIds: [] } });
    const persisted = await port.snapshot(ctx);
    expect(auditNoneStatus(persisted)).toMatchObject({
      degraded: true,
      warning: AUDIT_NONE_WARNING,
    });
    const restarted = storage(persisted);
    expect(await enterAuditNone(restarted, ctx, options())).toMatchObject({ outcome: 'degraded' });
    expect(restarted.record).not.toHaveBeenCalled();
  });

  it.each(['mode', 'pendingMode'] as const)(
    'recognizes persisted none in %s without duplicate entries',
    async (key) => {
      const port = storage({ ...initial, [key]: 'none' });
      expect(await enterAuditNone(port, ctx, options())).toMatchObject({ outcome: 'degraded' });
      expect(port.record).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'none'] as const)(
    'refuses a restored chain with pending mode %s before pruning',
    async (pendingMode) => {
      const port = storage({ ...initial, restorePending: true, pendingMode });
      const prune = vi.fn();
      expect(
        await pruneAuditNone(port, { prune }, ctx, {
          ...options(),
          prune: { configuredSinkIds: [] },
        }),
      ).toEqual({ outcome: 'refused', code: 'restore_pending' });
      expect(port.record).not.toHaveBeenCalled();
      expect(prune).not.toHaveBeenCalled();
    },
  );

  it('records validated acceptance even when a caller supplies a conflicting source', async () => {
    const port = storage();
    const input = { ...options('env'), source: 'build' };
    await enterAuditNone(port, ctx, input);
    expect(JSON.parse(port.record.mock.calls[0]![4].payloadJson).changes.source).toEqual({
      new: 'env',
    });
  });

  it('refuses stored required policy without recording or deleting', async () => {
    const port = storage({ ...initial, policy: 'required' });
    const prune = vi.fn();
    expect(
      await pruneAuditNone(port, { prune }, ctx, {
        ...options(),
        prune: { configuredSinkIds: [] },
      }),
    ).toEqual({ outcome: 'refused', code: 'required_acceptance' });
    expect(port.record).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('refuses unaccepted none after environment sinks become inactive', async () => {
    const input = options();
    const build = { ...input.audit.build, accepted: false };
    const port = storage();
    const prune = vi.fn();
    expect(
      await pruneAuditNone(port, { prune }, ctx, {
        ...input,
        audit: { ...input.audit, build },
        prune: { configuredSinkIds: [] },
      }),
    ).toEqual({ outcome: 'refused', code: 'none_not_accepted' });
    expect(port.record).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('does not enter none when the effective trail is active', async () => {
    const input = options();
    const port = storage();
    const prune = vi.fn();
    expect(
      await pruneAuditNone(port, { prune }, ctx, {
        ...input,
        audit: {
          ...input.audit,
          build: { ...input.audit.build, trailPresent: true, trailEnabled: true },
        },
        prune: { configuredSinkIds: [] },
      }),
    ).toEqual({ outcome: 'not_none' });
    expect(port.record).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('does not delete when the atomic mode write loses its fence', async () => {
    const port = storage();
    port.record.mockResolvedValue(false);
    const prune = vi.fn();
    expect(
      await pruneAuditNone(port, { prune }, ctx, {
        ...options(),
        prune: { configuredSinkIds: [] },
      }),
    ).toEqual({ outcome: 'contended' });
    expect(prune).not.toHaveBeenCalled();
  });

  it('waits for the mode transaction to commit before requesting deletion', async () => {
    const port = storage();
    let commit!: (saved: boolean) => void;
    port.record.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const prune = vi.fn().mockResolvedValue({ outcome: 'retained' });
    const pending = pruneAuditNone(port, { prune }, ctx, {
      ...options(),
      prune: { configuredSinkIds: [] },
    });
    await vi.waitFor(() => expect(port.record).toHaveBeenCalledTimes(1));
    expect(prune).not.toHaveBeenCalled();
    commit(true);
    await expect(pending).resolves.toMatchObject({ outcome: 'degraded' });
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed event id with a fixed error message', async () => {
    const port = storage();
    const input = options();
    await expect(
      enterAuditNone(port, ctx, {
        ...input,
        ids: [input.ids[0], input.ids[1], 'invalid-control-id'],
      }),
    ).rejects.toThrow('Invalid audit none options');
    expect(port.record).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids across the ledger and pending event', async () => {
    const port = storage();
    const input = options();
    await expect(
      enterAuditNone(port, ctx, {
        ...input,
        ids: [input.ids[0], input.ids[1], input.ids[0]],
      }),
    ).rejects.toThrow('Invalid audit none options');
    expect(port.record).not.toHaveBeenCalled();
  });

  it('propagates persistence failures without attempting deletion', async () => {
    const port = storage();
    port.record.mockRejectedValue(new Error('storage unavailable'));
    const prune = vi.fn();
    await expect(
      pruneAuditNone(port, { prune }, ctx, {
        ...options(),
        prune: { configuredSinkIds: [] },
      }),
    ).rejects.toThrow('storage unavailable');
    expect(prune).not.toHaveBeenCalled();
  });

  it('records an empty-chain transition with a valid control range', async () => {
    const port = storage({ ...initial, headSeq: 0 });
    await enterAuditNone(port, ctx, options());
    expect(port.record.mock.calls[0]![3]).toEqual([
      expect.objectContaining({ fromSeq: 1, toSeq: 1, count: 0 }),
      expect.objectContaining({ fromSeq: 1, toSeq: 1, count: 0 }),
    ]);
    expect(auditNoneStatus(await port.snapshot(ctx)).cutoverSeq).toBe(0);
  });

  it('refuses to replace an already pending cutover', async () => {
    const port = storage({ ...initial, pendingMode: 'export' });
    expect(await enterAuditNone(port, ctx, options())).toEqual({ outcome: 'contended' });
    expect(port.record).not.toHaveBeenCalled();
  });

  it.each([{ generation: -1 }, { generation: NaN }, { ids: ['invalid', 'invalid', 'invalid'] }])(
    'rejects malformed control inputs before writing: %j',
    async (change) => {
      const port = storage();
      await expect(
        enterAuditNone(port, ctx, { ...options(), ...change } as AuditNoneOptions),
      ).rejects.toThrow();
      expect(port.record).not.toHaveBeenCalled();
    },
  );
});
