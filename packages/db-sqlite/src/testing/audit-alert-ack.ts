import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { createAuditHealthRepository } from '../repositories/audit-health.js';

export async function auditAlertAcknowledgementContract(
  executor: SqlExecutor,
  a: OrgContext,
  b: OrgContext,
) {
  const actorId = ulid();
  await executor.all({
    sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    params: [actorId, a.orgId, 'operator@example.test'],
  });
  const operator = {
    actor: { type: 'user' as const, id: actorId },
    generation: 0,
    now: new Date('2026-10-31T00:00:00.000Z'),
  };
  const port = createAuditHealthRepository(
    {
      ...executor,
      batch: async (statements) => {
        expect(statements.length).toBeLessThanOrEqual(200);
        expect(statements.every((statement) => statement.params.length <= 90)).toBe(true);
        return (await executor.batch(statements)).map((result) => ({ ...result, changes: 999 }));
      },
    },
    operator,
  );
  expect(await port.operatorStatus(a)).toBe('ready');
  expect(await port.operatorStatus(b)).toBe('actor_unavailable');
  await port.raise(a, 'audit.capacity');
  await port.raise(a, 'audit.capacity');
  await port.raise(b, 'audit.capacity');
  await port.observe(a, [{ code: 'audit.capacity', fingerprint: 'live', failing: true }]);
  const pending = () =>
    executor.all({
      sql: 'SELECT actor_id, action, payload_json FROM audit_pending WHERE org_id = ?',
      params: [a.orgId],
    });
  expect(await port.acknowledge(a, 'audit.capacity', 0)).toBe(false);
  expect(await port.acknowledge(a, 'audit.capacity', 2)).toBe(false);
  expect(await pending()).toEqual([]);
  await executor.all({
    sql: "UPDATE audit_chain SET policy = 'required', capacity_state = 'refusing' WHERE org_id = ?",
    params: [a.orgId],
  });
  expect(await port.acknowledge(a, 'audit.capacity', 3)).toBe(true);
  expect(await port.acknowledge(a, 'audit.capacity', 3)).toBe(false);
  const rows = await pending();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_id: actorId, action: 'audit.sink_admin' });
  expect(JSON.parse(String(rows[0]!['payload_json']))).toMatchObject({
    changes: {
      operation: { new: 'alert_ack' },
      alert_code: { new: 'audit.capacity' },
      revision: { new: 3 },
    },
  });
  expect(
    (await port.snapshot(a)).alerts?.every((row) => row.acknowledgedRevision === row.revision),
  ).toBe(true);
  expect((await port.snapshot(a)).alerts?.some((row) => row.active)).toBe(true);
  expect((await port.snapshot(b)).alerts?.[0]?.acknowledgedRevision).toBe(0);
  expect(
    await executor.all({ sql: 'SELECT id FROM audit_ledger WHERE org_id = ?', params: [a.orgId] }),
  ).toEqual([]);

  await port.raise(a, 'audit.capacity');
  await executor.all({
    sql: `CREATE TRIGGER reject_alert_ack BEFORE UPDATE ON audit_health
      WHEN NEW.acknowledged_revision > OLD.acknowledged_revision
      BEGIN SELECT RAISE(ABORT, 'acknowledgement failure'); END`,
    params: [],
  });
  await expect(port.acknowledge(a, 'audit.capacity', 4)).rejects.toThrow();
  expect(await pending()).toHaveLength(1);
  expect(
    (await port.snapshot(a)).alerts?.find((row) => row.origin === 'source')?.acknowledgedRevision,
  ).toBe(2);
  await executor.all({ sql: 'DROP TRIGGER reject_alert_ack', params: [] });
  await executor.all({
    sql: `CREATE TRIGGER reject_alert_event BEFORE INSERT ON audit_pending
      BEGIN SELECT RAISE(ABORT, 'control event failure'); END`,
    params: [],
  });
  await expect(port.acknowledge(a, 'audit.capacity', 4)).rejects.toThrow();
  expect(
    (await port.snapshot(a)).alerts?.find((row) => row.origin === 'source')?.acknowledgedRevision,
  ).toBe(2);
  await executor.all({ sql: 'DROP TRIGGER reject_alert_event', params: [] });

  await executor.all({
    sql: "UPDATE user_account SET status = 'suspended' WHERE org_id = ? AND id = ?",
    params: [a.orgId, actorId],
  });
  expect(await port.operatorStatus(a)).toBe('actor_unavailable');
  await expect(port.acknowledge(a, 'audit.capacity', 4)).rejects.toThrow();
  expect(await pending()).toHaveLength(1);
  await executor.all({
    sql: "UPDATE user_account SET status = 'active' WHERE org_id = ? AND id = ?",
    params: [a.orgId, actorId],
  });
  expect(
    await createAuditHealthRepository(executor, { ...operator, generation: 1 }).operatorStatus(a),
  ).toBe('generation_ahead');
  await expect(
    createAuditHealthRepository(executor, { ...operator, generation: 1 }).acknowledge(
      a,
      'audit.capacity',
      4,
    ),
  ).rejects.toThrow();
  expect(await pending()).toHaveLength(1);
  expect(await port.acknowledge(a, 'audit.capacity', 4)).toBe(true);
  expect(await pending()).toHaveLength(2);
}
