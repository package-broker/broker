import { afterEach, expect, it, vi } from 'vitest';
import {
  AuditHealthConflictError,
  createAuditHealthService,
  type AuditHealthPort,
} from '@package-broker/core/audit/health';
import type { OrgContext } from '@package-broker/core/db/port';
import { fixedClock } from '@package-broker/core/ids';
import { AUDIT_EVENTS, KERNEL_REASON_CODES } from '@package-broker/core/kernel/obs-codes';
import { createObservability, type ObsRecord } from '@package-broker/core/platform/observability';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditHealthRepository } from './audit-health.js';

let database: MigratedDatabase;
afterEach(async () => {
  await database?.close();
});
async function fixture() {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const orgs = database.orgs!;
  await database.executor.batch([
    {
      sql: "UPDATE audit_chain SET mode = 'trail' WHERE org_id IN (?, ?)",
      params: [orgs.a.orgId, orgs.b.orgId],
    },
  ]);
  const port = createAuditHealthRepository(database.executor);
  const observability = { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() };
  const service = () =>
    createAuditHealthService({
      port: createAuditHealthRepository(database.executor),
      clock: fixedClock('2026-10-30T01:00:00.000Z'),
      observability,
    });
  return { ...orgs, port, observability, service };
}

it('latches recovery across service recreation, rejects stale ACK and alerts on recurrence', async () => {
  const { a, b, port, service, observability } = await fixture();
  const update = (state: string) =>
    database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET capacity_state = ? WHERE org_id = ?',
        params: [state, a.orgId],
      },
    ]);
  await update('warning');
  expect(await service().read(a)).toEqual({ status: 'degraded', codes: ['audit.capacity'] });
  await service().read(a);
  expect(observability.log).toHaveBeenCalledTimes(1);
  expect(await service().read(b)).toEqual({ status: 'ok', codes: [] });
  await update('ok');
  expect(await service().read(a)).toEqual({ status: 'degraded', codes: ['audit.capacity'] });
  expect(await port.acknowledge(b, 'audit.capacity', 1)).toBe(false);
  await update('refusing');
  expect(await service().read(a)).toEqual({ status: 'failing', codes: ['audit.capacity'] });
  expect(await port.acknowledge(a, 'audit.capacity', 1)).toBe(false);
  expect(await port.acknowledge(a, 'audit.capacity', 2)).toBe(true);
  expect((await service().read(a)).status).toBe('failing');
  await update('ok');
  expect(await service().read(a)).toEqual({ status: 'ok', codes: [] });
  expect(observability.counter).toHaveBeenCalledWith('pb.audit.alerts_total', {
    code: 'audit.capacity',
  });
});

it('reads pending age directly even when no sealer metrics exist and latches its recovery', async () => {
  const { a, b, service } = await fixture();
  await database.executor.batch([
    {
      sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
    VALUES (?, 'pending', '2026-10-30T00:54:59.999Z', 'system', 'project.update', 'project')`,
      params: [a.orgId],
    },
  ]);
  expect((await service().read(a)).codes).toEqual(['audit.pending_old']);
  expect((await service().read(b)).codes).toEqual([]);
  await database.executor.batch([
    { sql: 'DELETE FROM audit_pending WHERE org_id = ?', params: [a.orgId] },
  ]);
  expect((await service().read(a)).status).toBe('degraded');
});

it('historical incidents clear only on acknowledgement and a changed fingerprint raises again', async () => {
  const { a, port } = await fixture();
  const observation = {
    code: 'audit.skipped' as const,
    fingerprint: 'loss:1',
    failing: false,
    active: false,
  };
  expect((await port.observe(a, [observation])).raised).toEqual(['audit.skipped']);
  expect(await port.acknowledge(a, 'audit.skipped', 1)).toBe(true);
  expect((await port.observe(a, [observation])).raised).toEqual([]);
  const next = await port.observe(a, [{ ...observation, fingerprint: 'loss:2' }]);
  expect(next.raised).toEqual(['audit.skipped']);
  expect(next.alerts[0]).toMatchObject({ revision: 2, acknowledgedRevision: 1 });
});

it('validates input without echoing it', async () => {
  const { a, port } = await fixture();
  await expect(
    port.observe(a, [
      { code: 'secret@example.test' as never, fingerprint: 'secret', failing: false },
    ]),
  ).rejects.toThrow('Invalid audit health observation');
  expect((await port.observe(a, [])).alerts).toEqual([]);
});

it('captures transient source alerts without polling and survives telemetry failure', async () => {
  const { a, b, port, service, observability } = await fixture();
  observability.log.mockImplementation(() => {
    throw new Error('telemetry unavailable');
  });
  await service().raise(a, 'audit.marker_rejected');
  expect(await service().read(a)).toEqual({ status: 'degraded', codes: ['audit.marker_rejected'] });
  expect(await service().read(b)).toEqual({ status: 'ok', codes: [] });
  expect(await port.acknowledge(a, 'audit.marker_rejected', 1)).toBe(true);
  expect((await service().read(a)).status).toBe('ok');
  await service().raise(a, 'audit.marker_rejected');
  expect(await port.acknowledge(a, 'audit.marker_rejected', 1)).toBe(false);
  expect((await service().read(a)).status).toBe('degraded');
});

it('rolls back an earlier observation when a later statement fails', async () => {
  const { a, port } = await fixture();
  await database.executor.all({
    sql: `CREATE TRIGGER reject_health BEFORE INSERT ON audit_health
    WHEN NEW.code = 'audit.uncertain' BEGIN SELECT RAISE(ABORT, 'health test failure'); END`,
    params: [],
  });
  await expect(
    port.observe(a, [
      { code: 'audit.capacity', fingerprint: 'warning', failing: false },
      { code: 'audit.uncertain', fingerprint: 'incident', failing: false },
    ]),
  ).rejects.toThrow();
  expect((await port.observe(a, [])).alerts).toEqual([]);
});

it('discovers ledger incidents and detects additional losses without exposing ledger fields', async () => {
  const { a, b, port, service } = await fixture();
  const append = (id: string) =>
    database.executor.batch([
      {
        sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
      reason_code, policy, mode_generation, actor_type, created_at)
      SELECT org_id, ?, 'withheld', chain_id, epoch, 1, 1, 1, 'unreadable', policy, mode_generation,
        'system', '2026-10-30T00:00:00.000Z' FROM audit_chain WHERE org_id = ?`,
        params: [id, a.orgId],
      },
    ]);
  await append('first');
  expect(await service().read(a)).toEqual({ status: 'degraded', codes: ['audit.withheld'] });
  expect(await service().read(b)).toEqual({ status: 'ok', codes: [] });
  expect(await port.acknowledge(a, 'audit.withheld', 1)).toBe(true);
  expect(await service().read(a)).toEqual({ status: 'ok', codes: [] });
  await append('next');
  expect(await service().read(a)).toEqual({ status: 'degraded', codes: ['audit.withheld'] });
  expect(await port.acknowledge(a, 'audit.withheld', 1)).toBe(false);
});

it.each(['audit.capacity', 'audit.fork'] as const)(
  '%s keeps historical and live incidents separate and never raises recovery',
  async (code) => {
    const { a, port } = await fixture();
    const history = {
      code,
      origin: 'ledger' as const,
      fingerprint: 'reason:1',
      active: false,
      failing: false,
    };
    const live = { code, origin: 'live' as const, fingerprint: 'live', failing: true };
    const first = await port.observe(a, [history, live]);
    expect(first.alerts).toHaveLength(2);
    expect(first.raised).toEqual([code]);
    expect(await port.acknowledge(a, code, 2)).toBe(true);
    const recovered = await port.observe(a, [history]);
    expect(recovered.raised).toEqual([]);
    expect(recovered.alerts.map((r) => r.revision)).toEqual(first.alerts.map((r) => r.revision));
    expect(recovered.alerts.every((r) => !r.active && !r.failing)).toBe(true);
    expect((await port.observe(a, [history, live])).raised).toEqual([code]);
    expect(await port.acknowledge(a, code, 2)).toBe(false);
  },
);

it('an explicit active to inactive observation neither raises nor changes its revision', async () => {
  const { a, port } = await fixture();
  const observation = { code: 'audit.capacity' as const, fingerprint: 'warning', failing: false };
  await port.observe(a, [observation]);
  const result = await port.observe(a, [{ ...observation, active: false, fingerprint: 'ok' }]);
  expect(result.raised).toEqual([]);
  expect(result.alerts[0]).toMatchObject({ revision: 1, active: false });
});

it('uses ULID order instead of the minimum pending creation timestamp', async () => {
  const { a, port } = await fixture();
  await database.executor.batch([
    {
      sql: `INSERT INTO audit_pending (org_id, id, created_at, actor_type, action, target_type)
        VALUES (?, '01AAAAAAAAAAAAAAAAAAAAAAAA', '2026-10-30T00:59:00.000Z', 'system', 'project.update', 'project'),
        (?, '01BBBBBBBBBBBBBBBBBBBBBBBB', '2026-10-30T00:00:00.000Z', 'system', 'project.update', 'project')`,
      params: [a.orgId, a.orgId],
    },
  ]);
  expect((await port.snapshot(a)).oldestPendingAt).toBe('2026-10-30T00:59:00.000Z');
});

it('reads one consistent batch, uses a visible ledger index, and writes only changed health', async () => {
  const { a } = await fixture();
  const batch = vi.fn(database.executor.batch.bind(database.executor));
  const port = createAuditHealthRepository({ ...database.executor, batch });
  const service = createAuditHealthService({
    port,
    clock: fixedClock('2026-10-30T01:00:00.000Z'),
    observability: { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() },
  });
  await service.read(a);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]![0]).toHaveLength(5);
  const ledger = batch.mock.calls[0]![0].find((s) => s.sql.includes('FROM audit_ledger'))!;
  const plan = await database.executor.all<{ detail: string }>({
    sql: `EXPLAIN QUERY PLAN ${ledger.sql}`,
    params: ledger.params,
  });
  expect(
    plan.some((r) =>
      /SEARCH audit_ledger USING INDEX audit_ledger_(visible|kind_chain)/.test(r.detail),
    ),
  ).toBe(true);
  expect(plan.some((r) => /SCAN audit_ledger/.test(r.detail))).toBe(false);
  await database.executor.all({
    sql: "UPDATE audit_chain SET capacity_state = 'warning' WHERE org_id = ?",
    params: [a.orgId],
  });
  batch.mockClear();
  await service.read(a);
  expect(batch).toHaveBeenCalledTimes(2);
  batch.mockClear();
  await service.read(a);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]![0].every((s) => s.sql.trimStart().startsWith('SELECT'))).toBe(true);
});

it('fingerprints reason sets and log2 count bands of visible ledger rows', async () => {
  const { a, port } = await fixture();
  const insert = async (id: string, count: number, reason = 'unreadable') => {
    await database.executor.all({
      sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
        reason_code, policy, mode_generation, actor_type, created_at)
        SELECT org_id, ?, 'withheld', chain_id, epoch, 1, ?, ?, ?, policy, mode_generation,
        'system', 'now' FROM audit_chain WHERE org_id = ?`,
      params: [id, count, count, reason, a.orgId],
    });
  };
  const fingerprint = async () => (await port.snapshot(a)).incidents[0]!.fingerprint;
  await insert('first', 4);
  const first = await fingerprint();
  await insert('second', 1);
  expect(await fingerprint()).toBe(first);
  await insert('third', 3);
  expect(await fingerprint()).not.toBe(first);
  const spike = await fingerprint();
  await insert('fourth', 1, 'redacted');
  expect(await fingerprint()).not.toBe(spike);
});

it('enforces strict health storage', async () => {
  const { a } = await fixture();
  await expect(
    database.executor.all({
      sql: `INSERT INTO audit_health (org_id, code, fingerprint, revision, active, failing)
      VALUES (?, 'audit.capacity', '', 'invalid', 0, 0) RETURNING code`,
      params: [a.orgId],
    }),
  ).rejects.toThrow();
});

it('excludes superseded gaps from ledger spike bands', async () => {
  const { a, port } = await fixture();
  await database.executor.all({
    sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
      reason_code, policy, mode_generation, actor_type, created_at)
      SELECT org_id, 'old', 'gap', chain_id, epoch, 1, 4, 4, 'seq_gap', policy, mode_generation,
      'system', 'now' FROM audit_chain WHERE org_id = ?`,
    params: [a.orgId],
  });
  await database.executor.all({
    sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
      reason_code, policy, mode_generation, actor_type, created_at)
      SELECT org_id, 'covering', 'gap', chain_id, epoch, 1, 7, 7, 'seq_gap', policy, mode_generation,
      'system', 'now' FROM audit_chain WHERE org_id = ?`,
    params: [a.orgId],
  });
  expect((await port.snapshot(a)).incidents[0]!.fingerprint).toBe('gap:seq_gap:3');
  await database.executor.all({
    sql: "UPDATE audit_ledger SET superseded_by = 'covering' WHERE org_id = ? AND id = 'old'",
    params: [a.orgId],
  });
  expect((await port.snapshot(a)).incidents[0]!.fingerprint).toBe('gap:seq_gap:2');
});

async function setSink(org: OrgContext, id: string, state: string, reason: string | null = null) {
  await database.executor.batch([
    {
      sql: `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, blocked_reason, progress_seq, progress_hash, custody_seq, created_at, updated_at)
        VALUES (?, ?, 'sink', 'webhook', 0, 'fingerprint', 1, 'build', ?, ?, 0, ?, 0, 'now', 'now')
        ON CONFLICT (org_id, sink_id) DO UPDATE SET state = excluded.state, blocked_reason = excluded.blocked_reason`,
      params: [org.orgId, id, state, reason, '0'.repeat(64)],
    },
  ]);
}
function productionService(port: AuditHealthPort) {
  const records: ObsRecord[] = [];
  const observability = createObservability(
    { emit: (record) => records.push(record) },
    { deploymentId: 'deployment', runtime: 'node', requestId: null },
    { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
  );
  const counters = () =>
    records.flatMap((record) =>
      record.kind === 'counter' && record.name === 'pb.audit.alerts_total'
        ? [record.labels['code']]
        : [],
    );
  const service = createAuditHealthService({
    port,
    clock: fixedClock('2026-10-30T01:00:00.000Z'),
    observability,
  });
  return { service, counters };
}
async function revisions(port: AuditHealthPort, org: OrgContext) {
  return Object.fromEntries(
    ((await port.snapshot(org)).alerts ?? []).map((alert) => [
      `${alert.code}:${alert.origin}`,
      [alert.revision, alert.acknowledgedRevision, alert.active],
    ]),
  );
}

it('a stale recovery cannot clear a newer incident recorded by another reader', async () => {
  const { a, port } = await fixture();
  await setSink(a, 'first', 'blocked', 'rejected');
  const { service, counters } = productionService(port);
  expect(await service.read(a)).toEqual({ status: 'failing', codes: ['audit.blocked'] });
  await setSink(a, 'first', 'active');
  const stale = await port.snapshot(a);
  await setSink(a, 'second', 'blocked', 'rejected');
  expect(await service.read(a)).toEqual({ status: 'failing', codes: ['audit.blocked'] });
  expect(await revisions(port, a)).toEqual({ 'audit.blocked:live': [2, 0, true] });
  await expect(port.observe(a, [], stale.alerts)).rejects.toThrow(AuditHealthConflictError);
  await expect(
    port.observe(
      a,
      [{ code: 'audit.blocked', origin: 'live', fingerprint: 'first|third', failing: true }],
      stale.alerts,
    ),
  ).rejects.toThrow(AuditHealthConflictError);
  expect(await revisions(port, a)).toEqual({ 'audit.blocked:live': [2, 0, true] });
  expect(await port.acknowledge(a, 'audit.blocked', 2)).toBe(true);
  expect(await service.read(a)).toEqual({ status: 'failing', codes: ['audit.blocked'] });
  expect(counters()).toEqual(['audit.blocked', 'audit.blocked']);
});

it('an interleaved reader retries from a fresh snapshot instead of writing stale state', async () => {
  const { a, port } = await fixture();
  await setSink(a, 'first', 'blocked', 'rejected');
  const { service: other } = productionService(port);
  await other.read(a);
  await setSink(a, 'first', 'active');
  const stale = await port.snapshot(a);
  await setSink(a, 'second', 'blocked', 'rejected');
  let snapshots = 0;
  const interleaved: AuditHealthPort = {
    ...port,
    snapshot: async (org) => (++snapshots === 1 ? stale : port.snapshot(org)),
  };
  await other.read(a);
  const { service, counters } = productionService(interleaved);
  expect(await service.read(a)).toEqual({ status: 'failing', codes: ['audit.blocked'] });
  expect(snapshots).toBe(2);
  expect(counters()).toEqual([]);
  expect(await revisions(port, a)).toEqual({ 'audit.blocked:live': [2, 0, true] });
});

it('gives up after a bounded number of conflicting observations', async () => {
  const { a, port } = await fixture();
  const observe = vi.fn<AuditHealthPort['observe']>(async () => {
    throw new AuditHealthConflictError();
  });
  const { service, counters } = productionService({ ...port, observe });
  await database.executor.all({
    sql: "UPDATE audit_chain SET capacity_state = 'warning' WHERE org_id = ?",
    params: [a.orgId],
  });
  await expect(service.read(a)).rejects.toThrow(AuditHealthConflictError);
  expect(observe).toHaveBeenCalledTimes(3);
  expect(counters()).toEqual([]);
});

it('partial recovery keeps the occurrence and its acknowledgement; a returning member raises again', async () => {
  const { a, port } = await fixture();
  const { service, counters } = productionService(port);
  await setSink(a, 'first', 'blocked', 'fork');
  await setSink(a, 'second', 'blocked', 'fork');
  expect(await service.read(a)).toEqual({
    status: 'failing',
    codes: ['audit.blocked', 'audit.fork'],
  });
  expect(counters()).toEqual(['audit.blocked', 'audit.fork']);
  expect(await port.acknowledge(a, 'audit.blocked', 1)).toBe(true);
  expect(await port.acknowledge(a, 'audit.fork', 1)).toBe(true);
  await setSink(a, 'first', 'active');
  expect(await service.read(a)).toEqual({
    status: 'failing',
    codes: ['audit.blocked', 'audit.fork'],
  });
  expect(counters()).toEqual(['audit.blocked', 'audit.fork']);
  expect(await revisions(port, a)).toEqual({
    'audit.blocked:live': [1, 1, true],
    'audit.fork:live': [1, 1, true],
  });
  expect((await port.snapshot(a)).alerts?.map((alert) => alert.fingerprint)).toEqual([
    'second',
    'second',
  ]);
  await setSink(a, 'first', 'blocked', 'fork');
  await service.read(a);
  expect(counters()).toEqual(['audit.blocked', 'audit.fork', 'audit.blocked', 'audit.fork']);
  expect(await revisions(port, a)).toEqual({
    'audit.blocked:live': [2, 1, true],
    'audit.fork:live': [2, 1, true],
  });
  await setSink(a, 'first', 'active');
  await setSink(a, 'second', 'active');
  expect(await service.read(a)).toEqual({
    status: 'degraded',
    codes: ['audit.blocked', 'audit.fork'],
  });
  expect(counters()).toHaveLength(4);
  expect(await revisions(port, a)).toEqual({
    'audit.blocked:live': [2, 1, false],
    'audit.fork:live': [2, 1, false],
  });
});

it('a replaced member is a new occurrence even when the member count is unchanged', async () => {
  const { a, port } = await fixture();
  const { service, counters } = productionService(port);
  await setSink(a, 'first', 'blocked', 'rejected');
  await service.read(a);
  await setSink(a, 'first', 'active');
  await setSink(a, 'second', 'blocked', 'rejected');
  await service.read(a);
  expect(counters()).toEqual(['audit.blocked', 'audit.blocked']);
  expect(await revisions(port, a)).toEqual({ 'audit.blocked:live': [2, 0, true] });
});
