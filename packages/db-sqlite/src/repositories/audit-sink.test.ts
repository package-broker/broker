import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reconcileAuditSinks,
  type AuditSinkRegistration,
  type AuditSinkRegistryPort,
} from '@package-broker/core/audit/sinks/registry';
import { DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditSinkRepository } from './audit-sink.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const registration: AuditSinkRegistration = {
  id: 'archive',
  pluginId: 'audit',
  kind: 'webhook',
  durableAck: true,
  destination: { receiverFingerprint: 'a'.repeat(64), activationSource: 'ARCHIVE_URL' },
};
let database: MigratedDatabase;
let port: AuditSinkRegistryPort;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  port = createAuditSinkRepository(database.executor);
});
afterEach(async () => database.close());
const org = () => database.orgs!.a;

describe('SQLite audit sink registry', () => {
  it('creates at the retained boundary, survives restart and is idempotent', async () => {
    await database.executor.batch([
      {
        sql: "UPDATE audit_chain SET boundary_seq = 9, boundary_prev_hash = ?, boundary_reason = 'prune' WHERE org_id = ?",
        params: ['b'.repeat(64), org().orgId],
      },
    ]);
    expect(await reconcileAuditSinks(port, org(), 1, [registration], now)).toBe('applied');
    const saved = await port.read(org());
    expect(saved.sinks[0]).toMatchObject({ progressSeq: 8, custodySeq: 8, state: 'active' });
    expect(JSON.parse(saved.sinks[0]!.inflightBody!)).toMatchObject({
      throughSeq: 8,
      records: [{ kind: 'boundary', boundarySeq: 9 }],
    });
    expect(
      await reconcileAuditSinks(
        createAuditSinkRepository(database.executor),
        org(),
        1,
        [registration],
        now,
      ),
    ).toBe('applied');
    expect(await port.read(org())).toEqual(saved);
  });

  it('persists receiver markers, ledger provenance and the control event atomically', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_sink SET progress_seq = 5, custody_seq = 3 WHERE org_id = ?',
        params: [org().orgId],
      },
    ]);
    const changed = {
      ...registration,
      destination: { ...registration.destination!, receiverFingerprint: 'd'.repeat(64) },
    };
    expect(await reconcileAuditSinks(port, org(), 2, [changed], now)).toBe('applied');
    const sink = (await port.read(org())).sinks[0]!;
    expect(sink).toMatchObject({ progressSeq: 5, custodySeq: 3 });
    expect(JSON.parse(sink.inflightBody!).records[0]).toMatchObject({
      kind: 'receiver_changed',
      oldFingerprint: 'a'.repeat(64),
      newFingerprint: 'd'.repeat(64),
    });
    expect(
      await database.executor.all({
        sql: 'SELECT kind, from_seq, to_seq, reason_code FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ kind: 'rebind', from_seq: 1, to_seq: 3, reason_code: 'receiver_changed' }]);
    expect(
      await database.executor.all({
        sql: 'SELECT action, source_ip, token_selector FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ action: 'audit.sink_admin', source_ip: null, token_selector: null }]);
    const [event] = await database.executor.all<{ payload_json: string }>({
      sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ?',
      params: [org().orgId],
    });
    const [ledger] = await database.executor.all<{ to_seq: number }>({
      sql: 'SELECT to_seq FROM audit_ledger WHERE org_id = ?',
      params: [org().orgId],
    });
    expect(JSON.parse(event!.payload_json).changes.to_seq.new).toBe(ledger!.to_seq);
  });

  it('records a receiver change before any event has custody', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    const changed = {
      ...registration,
      destination: { ...registration.destination!, receiverFingerprint: 'e'.repeat(64) },
    };
    expect(await reconcileAuditSinks(port, org(), 2, [changed], now)).toBe('applied');
    expect((await port.read(org())).sinks[0]!.custodySeq).toBe(0);
    expect(
      await database.executor.all({
        sql: 'SELECT from_seq, to_seq, count FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
    const [event] = await database.executor.all<{ payload_json: string }>({
      sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ?',
      params: [org().orgId],
    });
    expect(JSON.parse(event!.payload_json).changes).not.toHaveProperty('to_seq');
    const before = await port.read(org());
    expect(await reconcileAuditSinks(port, org(), 2, [changed], now)).toBe('applied');
    expect(await port.read(org())).toEqual(before);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toHaveLength(0);
  });

  it('persists a receiver marker queue without replacing an in-flight body', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_sink SET inflight_from = 1, inflight_to = 2, inflight_body = ?, inflight_repr = ? WHERE org_id = ?',
        params: ['{"frozen":true}', '{"v":1,"sourceIp":"omit","custodyFromSeq":1}', org().orgId],
      },
    ]);
    expect(
      await reconcileAuditSinks(
        port,
        org(),
        2,
        [
          {
            ...registration,
            destination: { ...registration.destination!, receiverFingerprint: 'e'.repeat(64) },
          },
        ],
        now,
      ),
    ).toBe('applied');
    const row = (await port.read(org())).sinks[0]!;
    expect(row).toMatchObject({
      inflightFrom: 1,
      inflightTo: 2,
      inflightBody: '{"frozen":true}',
      progressSeq: 0,
      custodySeq: 0,
    });
    expect(JSON.parse(row.inflightRepr!)).toEqual({
      v: 1,
      sourceIp: 'omit',
      custodyFromSeq: 1,
      registryMarkers: [expect.objectContaining({ kind: 'receiver_changed' })],
    });
  });

  it('rolls back a receiver change if staging its control event fails', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    await database.executor.batch([
      { sql: 'UPDATE audit_sink SET custody_seq = 3 WHERE org_id = ?', params: [org().orgId] },
    ]);
    const before = await port.read(org());
    const executor: SqlExecutor = {
      ...database.executor,
      batch: (statements) =>
        database.executor.batch(
          statements.map((statement) =>
            statement.sql.startsWith('INSERT INTO audit_pending')
              ? { ...statement, params: [null, ...statement.params.slice(1)] }
              : statement,
          ),
        ),
    };
    const attempt = reconcileAuditSinks(
      createAuditSinkRepository(executor),
      org(),
      2,
      [
        {
          ...registration,
          destination: { ...registration.destination!, receiverFingerprint: 'd'.repeat(64) },
        },
      ],
      now,
    );
    await expect(attempt).rejects.toMatchObject({
      kind: 'not_null',
      constraint: 'audit_pending.id',
    });
    await expect(attempt).rejects.toThrow(
      new DbError('not_null', 'not_null: NOT NULL constraint failed: audit_pending.id', {
        constraint: 'audit_pending.id',
      }),
    );
    expect(await port.read(org())).toEqual(before);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
  });

  it.each([{ pluginId: 'audit-v2' }, { kind: 'otlp' }, { durableAck: false }])(
    'uses build generations independently and records receiver properties %j with the chain mode generation',
    async (change) => {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET mode_generation = 99 WHERE org_id = ?',
          params: [org().orgId],
        },
      ]);
      await reconcileAuditSinks(port, org(), 1, [registration], now);
      await database.executor.batch([
        { sql: 'UPDATE audit_sink SET custody_seq = 3 WHERE org_id = ?', params: [org().orgId] },
      ]);
      await reconcileAuditSinks(port, org(), 2, [{ ...registration, ...change }], now);
      expect((await port.read(org())).modeGeneration).toBe(99);
      const sink = (await port.read(org())).sinks[0]!;
      expect(sink.generation).toBe(2);
      expect(sink.inflightBody).toBeNull();
      expect(JSON.parse(sink.inflightRepr!).custodyFromSeq).toBe(4);
      expect(
        await database.executor.all({
          sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
          params: [org().orgId],
        }),
      ).toEqual([{ action: 'audit.sink_admin' }]);
      expect(
        await database.executor.all({
          sql: 'SELECT mode_generation FROM audit_ledger WHERE org_id = ?',
          params: [org().orgId],
        }),
      ).toEqual([{ mode_generation: 99 }]);
    },
  );

  it('records only real custody after a retained suffix registration even after pruning moves', async () => {
    await database.executor.batch([
      {
        sql: "UPDATE audit_chain SET boundary_seq = 9, boundary_reason = 'prune' WHERE org_id = ?",
        params: [org().orgId],
      },
    ]);
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    await reconcileAuditSinks(port, org(), 2, [{ ...registration, kind: 'otlp' }], now);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_sink SET custody_seq = 12, inflight_body = NULL, inflight_from = NULL, inflight_to = NULL WHERE org_id = ?',
        params: [org().orgId],
      },
      { sql: 'UPDATE audit_chain SET boundary_seq = 11 WHERE org_id = ?', params: [org().orgId] },
    ]);
    await reconcileAuditSinks(port, org(), 3, [{ ...registration, pluginId: 'audit-v2' }], now);
    expect(
      await database.executor.all({
        sql: 'SELECT from_seq, to_seq FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ from_seq: 9, to_seq: 12 }]);
    const events = await database.executor.all<{ payload_json: string }>({
      sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ? ORDER BY id',
      params: [org().orgId],
    });
    expect(events.map((row) => JSON.parse(row.payload_json).changes.from_seq.new)).toEqual([9, 9]);
  });

  it('advances custody start so successive nonempty rebind ranges do not overlap', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    for (const [index, fingerprint] of ['b', 'c'].entries()) {
      await database.executor.batch([
        {
          sql: 'UPDATE audit_sink SET custody_seq = ? WHERE org_id = ?',
          params: [3 + index * 3, org().orgId],
        },
      ]);
      await reconcileAuditSinks(
        port,
        org(),
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
    }
    expect(
      await database.executor.all({
        sql: 'SELECT from_seq, to_seq FROM audit_ledger WHERE org_id = ? ORDER BY from_seq',
        params: [org().orgId],
      }),
    ).toEqual([
      { from_seq: 1, to_seq: 3 },
      { from_seq: 4, to_seq: 6 },
    ]);
    expect(JSON.parse((await port.read(org())).sinks[0]!.inflightRepr!).custodyFromSeq).toBe(7);
  });

  it('rejects a stale boot without disabling or creating rows', async () => {
    await reconcileAuditSinks(port, org(), 3, [registration], now);
    const before = await port.read(org());
    expect(await reconcileAuditSinks(port, org(), 2, [], now)).toBe('stale');
    expect(await reconcileAuditSinks(port, org(), 2, [{ ...registration, id: 'new' }], now)).toBe(
      'stale',
    );
    expect(await port.read(org())).toEqual(before);
  });

  it.each([
    'generation',
    'boundary',
    'membership',
    'progress',
    'inflight',
    'restore',
    'incarnation',
    'mode',
  ] as const)('rolls back when %s changes after the snapshot', async (race) => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    const snapshot = await port.read(org());
    if (race === 'incarnation' || race === 'mode')
      await database.executor.batch([
        {
          sql: `UPDATE audit_chain SET ${race === 'mode' ? 'mode_generation' : 'incarnation'} = 99 WHERE org_id = ?`,
          params: [org().orgId],
        },
      ]);
    if (race === 'generation') await reconcileAuditSinks(port, org(), 3, [registration], now);
    if (race === 'boundary')
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET boundary_seq = 2 WHERE org_id = ?',
          params: [org().orgId],
        },
      ]);
    if (race === 'membership')
      await reconcileAuditSinks(
        port,
        org(),
        1,
        [registration, { ...registration, id: 'second' }],
        now,
      );
    if (race === 'progress')
      await database.executor.batch([
        { sql: 'UPDATE audit_sink SET progress_seq = 4 WHERE org_id = ?', params: [org().orgId] },
      ]);
    if (race === 'inflight')
      await database.executor.batch([
        {
          sql: "UPDATE audit_sink SET inflight_from = 1, inflight_to = 1, inflight_body = '{}' WHERE org_id = ?",
          params: [org().orgId],
        },
      ]);
    if (race === 'restore')
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
          params: [org().orgId],
        },
      ]);
    const before = await port.read(org());
    expect(
      await port.save(org(), snapshot, {
        generation: 2,
        sinks: [],
        rebinds: [],
        now: now.toISOString(),
      }),
    ).toBe(false);
    expect(await port.read(org())).toEqual(before);
  });

  it('reuses a retired row that has append-only ledger history', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    const snapshot = await port.read(org());
    await database.executor.batch([
      {
        sql: "INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type) VALUES (?, '01JZZZZZZZZZZZZZZZZZZZZZZY', 'retire', ?, 1, 1, 1, 0, 'archive', 'retired', 'availability', 1, 'system')",
        params: [org().orgId, snapshot.chainId],
      },
      { sql: "UPDATE audit_sink SET state = 'retired' WHERE org_id = ?", params: [org().orgId] },
    ]);
    expect(
      await reconcileAuditSinks(
        port,
        org(),
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
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
    expect((await port.read(org())).sinks).toHaveLength(1);
    expect((await port.read(org())).sinks[0]!.state).toBe('active');
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ id: '01JZZZZZZZZZZZZZZZZZZZZZZY' }]);
  });
});
