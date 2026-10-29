import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reconcileAuditSinks,
  type AuditSinkRegistration,
  type AuditSinkRegistryPort,
} from '@package-broker/core/audit/sinks/registry';
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
    ).toEqual([{ from_seq: 1, to_seq: 1, count: 0 }]);
    const before = await port.read(org());
    expect(await reconcileAuditSinks(port, org(), 2, [changed], now)).toBe('applied');
    expect(await port.read(org())).toEqual(before);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toHaveLength(1);
  });

  it('persists a receiver marker queue without replacing an in-flight body', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_sink SET inflight_from = 1, inflight_to = 2, inflight_body = ?, inflight_repr = ? WHERE org_id = ?',
        params: ['{"frozen":true}', '{"v":1,"sourceIp":"omit"}', org().orgId],
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
      registryMarkers: [expect.objectContaining({ kind: 'receiver_changed' })],
    });
  });

  it('rolls back a receiver change if staging its control event fails', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
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
    await expect(
      reconcileAuditSinks(
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
      ),
    ).rejects.toThrow();
    expect(await port.read(org())).toEqual(before);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
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

  it.each(['generation', 'boundary', 'membership', 'progress', 'inflight', 'restore'] as const)(
    'rolls back when %s changes after the snapshot',
    async (race) => {
      await reconcileAuditSinks(port, org(), 1, [registration], now);
      const snapshot = await port.read(org());
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
    },
  );

  it('reuses a retired row that has append-only ledger history', async () => {
    await reconcileAuditSinks(port, org(), 1, [registration], now);
    const snapshot = await port.read(org());
    await database.executor.batch([
      {
        sql: "INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id, reason_code, policy, mode_generation, actor_type) VALUES (?, 'retirement', 'retire', ?, 1, 1, 1, 0, 'archive', 'retired', 'availability', 1, 'system')",
        params: [org().orgId, snapshot.chainId],
      },
      { sql: "UPDATE audit_sink SET state = 'retired' WHERE org_id = ?", params: [org().orgId] },
    ]);
    expect(await reconcileAuditSinks(port, org(), 2, [registration], now)).toBe('applied');
    expect((await port.read(org())).sinks).toHaveLength(1);
    expect((await port.read(org())).sinks[0]!.state).toBe('active');
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_ledger WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ id: 'retirement' }]);
  });
});
