import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import {
  administerAuditSink,
  type AuditSinkAdminPort,
  type AuditSinkAdminSnapshot,
} from './sink-admin.js';
import { AuditForkLimitError, type AuditForkPort } from './fork.js';
import { assertAuditLedgerEntry } from './ledger.js';
import type { AuditBatchV1 } from './plugin-api.js';

const now = new Date('2026-10-30T00:00:00.000Z');
const org = orgContext(ulid());
const hash = 'a'.repeat(64);
const options = {
  alert: vi.fn(),
  generation: 2,
  now,
  actor: { type: 'user' as const, id: ulid() },
};
function fixture() {
  const snapshot: { -readonly [K in keyof AuditSinkAdminSnapshot]: AuditSinkAdminSnapshot[K] } = {
    chainId: 'c'.repeat(32),
    epoch: 1,
    incarnation: 1,
    modeGeneration: 1,
    policy: 'required',
    mode: 'export',
    pendingMode: null,
    boundarySeq: 1,
    boundaryPrevHash: '0'.repeat(64),
    boundaryReason: null,
    restorePending: false,
    headSeq: 2,
    headHash: hash,
    sinks: [
      {
        id: 'archive',
        pluginId: 'audit',
        kind: 'webhook',
        generation: 2,
        receiverFingerprint: hash,
        durableAck: true,
        activationSource: 'ARCHIVE_URL',
        state: 'blocked',
        blockedReason: 'rejected',
        progressSeq: 0,
        progressHash: '0'.repeat(64),
        custodySeq: 0,
        inflightFrom: 1,
        inflightTo: 1,
        inflightBody: null,
        inflightRepr: '{"custodyFromSeq":1}',
        attempt: 1,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: 'rejected',
        bodyVersion: 0,
      },
    ],
  };
  const save = vi.fn<AuditForkPort['save']>().mockResolvedValue(true);
  const port: AuditSinkAdminPort = {
    actorExists: vi.fn().mockResolvedValue(true),
    resolution: vi.fn().mockResolvedValue({ target: null, resolved: false }),
    read: vi.fn().mockResolvedValue(snapshot),
    hashAt: vi.fn().mockResolvedValue(hash),
    save,
  };
  const admin = (command: Parameters<typeof administerAuditSink>[2], opts = options) =>
    administerAuditSink(port, org, command, opts);
  const change = () => save.mock.calls[0]![3];
  const single = { kind: 'event', seq: 1, prevHash: '0'.repeat(64), hash };
  const batch = {
    chainId: snapshot.chainId,
    epoch: 1,
    throughSeq: 1,
    throughHash: hash,
    records: [single],
  } as unknown as AuditBatchV1;
  const frozen = (repr = {}) => {
    snapshot.sinks = [
      {
        ...snapshot.sinks[0]!,
        inflightBody: JSON.stringify(batch),
        inflightRepr: JSON.stringify({ custodyFromSeq: 1, purpose: 'events', ...repr }),
      },
    ];
  };
  return { snapshot, save, port, admin, change, frozen, batch };
}

describe('audit sink administration', () => {
  it('unblocks a rejection without losing frozen bytes, queued markers or custody', async () => {
    const f = fixture();
    f.frozen({ registryMarkers: [{ kind: 'boundary' }] });
    await f.admin({ operation: 'unblock', sinkId: 'archive' });
    expect(f.change().sinks[0]).toMatchObject({
      state: 'active',
      blockedReason: null,
      custodySeq: 0,
      inflightBody: f.snapshot.sinks[0]!.inflightBody,
      inflightRepr: f.snapshot.sinks[0]!.inflightRepr,
    });
    expect(f.change().ledger[0]).toMatchObject({
      kind: 'unblock',
      actorType: 'user',
      actorId: options.actor.id,
    });
    assertAuditLedgerEntry(f.change().ledger[0]!);
  });
  it('refuses unblocking a fork and all sink writes during restore', async () => {
    const f = fixture();
    f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, blockedReason: 'fork' }];
    await expect(f.admin({ operation: 'unblock', sinkId: 'archive' })).rejects.toThrow(
      'unblock unavailable',
    );
    f.snapshot.restorePending = true;
    await expect(
      f.admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive:1-2' }),
    ).rejects.toThrow('restore confirmation required');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('turns an explicitly skipped rejected singleton into a tombstone and one loss row', async () => {
    const f = fixture();
    f.frozen({ rejectionTail: [{ ...f.batch, throughSeq: 2 }] });
    await f.admin({ operation: 'skip', sinkId: 'archive', seq: 1 });
    const change = f.change();
    expect(change.ledger[0]).toMatchObject({ kind: 'skipped', fromSeq: 1, toSeq: 1, count: 1 });
    assertAuditLedgerEntry(change.ledger[0]!);
    expect(change.sinks[0]).toMatchObject({ state: 'active', progressSeq: 0, custodySeq: 1 });
    expect(JSON.parse(change.sinks[0]!.inflightBody!).records[0]).toMatchObject({
      kind: 'tombstone',
      seq: 1,
    });
    expect(JSON.parse(change.sinks[0]!.inflightRepr!).rejectionTail).toHaveLength(1);
  });
  it.each([{ uncertainOutcome: {} }, { registryMarkerBody: '{}' }, { purpose: 'marker' }])(
    'refuses skipping held or marker state: %j',
    async (repr) => {
      const f = fixture();
      f.frozen(repr);
      await expect(f.admin({ operation: 'skip', sinkId: 'archive', seq: 1 })).rejects.toThrow(
        'skip unavailable',
      );
      expect(f.save).not.toHaveBeenCalled();
    },
  );
  it('refuses skipping a missing frozen batch with a fixed error', async () => {
    const f = fixture();
    await expect(f.admin({ operation: 'skip', sinkId: 'archive', seq: 1 })).rejects.toThrow(
      'Audit skip unavailable',
    );
  });
  it('refuses replay over a frozen delivery', async () => {
    const f = fixture();
    f.frozen();
    await expect(f.admin({ operation: 'replay', sinkId: 'archive', fromSeq: 1 })).rejects.toThrow(
      'Invalid audit replay range',
    );
    expect(f.save).not.toHaveBeenCalled();
  });
  it('confirms restore with the operator actor without fast forwarding custody', async () => {
    const f = fixture();
    f.snapshot.restorePending = true;
    f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, blockedReason: 'fork' }];
    await f.admin({ operation: 'confirm_restore', fromSeq: 1 });
    expect(f.change()).toMatchObject({
      restorePending: false,
      event: { actor: options.actor },
      ledger: [expect.objectContaining({ kind: 'restore_confirmed', actorId: options.actor.id })],
      sinks: [expect.objectContaining({ progressSeq: 0, custodySeq: 0 })],
    });
  });
  it.each(['replay', 'rebind'] as const)(
    'preserves and clips durable ACK ranges below %s start',
    async (operation) => {
      const f = fixture();
      f.snapshot.headSeq = 10;
      f.snapshot.sinks = [
        {
          ...f.snapshot.sinks[0]!,
          progressSeq: 10,
          custodySeq: 10,
          inflightRepr: JSON.stringify({
            custodyFromSeq: 1,
            durableCustodySeq: 10,
            durableAckRanges: [
              { from: 1, to: 2 },
              { from: 4, to: 7 },
              { from: 9, to: 10 },
            ],
            registryMarkers: [{ kind: 'boundary' }],
          }),
        },
      ];
      await f.admin({ operation, sinkId: 'archive', fromSeq: 6 });
      expect(JSON.parse(f.change().sinks[0]!.inflightRepr!)).toMatchObject({
        durableCustodySeq: 5,
        durableAckRanges: [
          { from: 1, to: 2 },
          { from: 4, to: 5 },
        ],
        registryMarkers: [{ kind: 'boundary' }],
      });
      expect(f.change().ledger[0]).toMatchObject({
        kind: 'rebind',
        reasonCode: operation === 'replay' ? 'replay' : 'operator_rebind',
      });
      expect(JSON.parse(f.change().event!.payloadJson).changes).toMatchObject({
        operation: { new: operation },
      });
    },
  );
  it.each(['history_limit', 'batch_limit'] as const)(
    'passes confirm-restore %s alerts through to the caller',
    async (reason) => {
      const f = fixture();
      f.snapshot.restorePending = true;
      if (reason === 'history_limit')
        vi.mocked(f.port.read).mockRejectedValueOnce(new AuditForkLimitError(reason));
      else f.save.mockRejectedValueOnce(new AuditForkLimitError(reason));
      const alert = vi.fn();
      await expect(
        f.admin({ operation: 'confirm_restore', fromSeq: 1 }, { ...options, alert }),
      ).rejects.toMatchObject({ reason });
      expect(alert).toHaveBeenCalledExactlyOnceWith(reason);
    },
  );
  it.each([
    { mode: 'none', pendingMode: null },
    { mode: 'trail', pendingMode: 'none' },
    { mode: 'export', pendingMode: null },
    { mode: 'trail', pendingMode: 'export' },
  ] as const)('refuses unavailable required policy before save: %j', async (modes) => {
    const f = fixture();
    Object.assign(f.snapshot, modes, { policy: 'availability', sinks: [] });
    await expect(
      f.admin({ operation: 'policy_set', policy: 'required' }, { ...options, generation: 0 }),
    ).rejects.toMatchObject({
      reason: 'policy_unavailable',
    });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('refuses a sink operation without a durable active or blocked witness under required', async () => {
    const f = fixture();
    f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, state: 'disabled' }];
    await expect(
      f.admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive:1-2' }),
    ).rejects.toMatchObject({ reason: 'required_witness' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each(['active', 'blocked'] as const)(
    'accepts a durable %s witness in export mode',
    async (state) => {
      const f = fixture();
      f.snapshot.policy = 'availability';
      f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, state }];
      expect(await f.admin({ operation: 'policy_set', policy: 'required' })).toEqual({
        result: 'applied',
      });
    },
  );
  it.each(['disabled', 'inactive', 'retired'] as const)(
    'refuses an unavailable durable %s witness in export mode',
    async (state) => {
      const f = fixture();
      f.snapshot.policy = 'availability';
      f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, state }];
      await expect(f.admin({ operation: 'policy_set', policy: 'required' })).rejects.toMatchObject({
        reason: 'policy_unavailable',
      });
      expect(f.save).not.toHaveBeenCalled();
    },
  );
  it('refuses a non-durable active export sink as a required witness', async () => {
    const f = fixture();
    f.snapshot.policy = 'availability';
    f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, state: 'active', durableAck: false }];
    await expect(f.admin({ operation: 'policy_set', policy: 'required' })).rejects.toMatchObject({
      reason: 'policy_unavailable',
    });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('allows retirement under required when another durable witness remains', async () => {
    const f = fixture();
    f.snapshot.sinks = [
      { ...f.snapshot.sinks[0]!, state: 'disabled' },
      { ...f.snapshot.sinks[0]!, id: 'backup' },
    ];
    expect(
      await f.admin({ operation: 'retire', sinkId: 'archive', confirm: 'archive:1-2' }),
    ).toEqual({ result: 'applied' });
    expect(f.change().sinks.map((sink) => sink.state)).toEqual(['retired', 'blocked']);
  });
  it('alerts for a save batch limit on a normal mutation', async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new AuditForkLimitError('batch_limit'));
    const alert = vi.fn();
    await expect(
      f.admin({ operation: 'unblock', sinkId: 'archive' }, { ...options, alert }),
    ).rejects.toMatchObject({ reason: 'batch_limit' });
    expect(alert).toHaveBeenCalledExactlyOnceWith('batch_limit');
  });
  it.each(['active', 'blocked', 'retired', 'disabled', 'inactive'] as const)(
    'lists retirement confirmation only for an eligible nonempty range in state %s',
    async (state) => {
      const f = fixture();
      f.snapshot.sinks = [{ ...f.snapshot.sinks[0]!, state }];
      const result = await f.admin({ operation: 'list' });
      if (['disabled', 'inactive'].includes(state))
        expect(result.sinks![0]).toHaveProperty('retireConfirmation', 'archive:1-2');
      else expect(result.sinks![0]).not.toHaveProperty('retireConfirmation');
      f.snapshot.headSeq = 0;
      expect((await f.admin({ operation: 'list' })).sinks![0]).not.toHaveProperty(
        'retireConfirmation',
      );
      expect(f.save).not.toHaveBeenCalled();
    },
  );
  it('does not accept system actors or reflect invalid values in errors', async () => {
    const f = fixture();
    await expect(
      f.admin({ operation: 'list' }, {
        ...options,
        actor: { type: 'system', id: null },
      } as unknown as typeof options),
    ).rejects.toThrow('Invalid audit administration input');
    expect(f.port.read).not.toHaveBeenCalled();
  });
});
