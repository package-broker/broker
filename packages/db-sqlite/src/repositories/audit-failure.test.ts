import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { OrgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditFailureRepository } from './audit-failure.js';

let database: MigratedDatabase;
let ctx: OrgContext;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  ctx = database.orgs!.a;
});
afterEach(async () => database.close());

function event(): AuditEvent {
  const id = ulid();
  const result = auditEvent({
    id,
    now: '2026-10-30T10:00:00.000Z',
    action: 'session.login_failed',
    actor: { type: 'system', id: null },
    target: { type: 'session', id: null },
    context: { opId: id, requestId: id, sourceIp: '203.0.113.7', tokenSelector: null },
    changes: {
      method: { new: 'local' },
      reason: { new: 'unknown_account' },
      count: { new: 1 },
      window_start: { new: '2026-10-30T10:00:00.000Z' },
    },
  });
  if (!result.ok) throw new Error('invalid fixture');
  return result.event;
}

it('stages a failure in exactly one statement within D1 limits and in the context organization', async () => {
  const batch = vi.fn(database.executor.batch.bind(database.executor));
  const repository = createAuditFailureRepository({
    driver: database.executor.driver,
    all: database.executor.all.bind(database.executor),
    batch,
  });
  const failure = event();
  await repository.stage(ctx, failure);
  expect(batch).toHaveBeenCalledTimes(1);
  const statements = batch.mock.calls[0]![0];
  expect(statements).toHaveLength(1);
  expect(statements[0]!.params.length).toBeLessThanOrEqual(100);
  expect(
    await database.executor.all({
      sql: 'SELECT org_id, action, payload_json FROM audit_pending WHERE org_id = ?',
      params: [ctx.orgId],
    }),
  ).toEqual([{ org_id: ctx.orgId, action: failure.action, payload_json: failure.payloadJson }]);
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
      params: [database.orgs!.b.orgId],
    }),
  ).toEqual([]);
});

it('propagates staging errors to the best effort core boundary without inserting another row', async () => {
  const repository = createAuditFailureRepository(database.executor);
  const failure = event();
  await repository.stage(ctx, failure);
  await expect(repository.stage(ctx, failure)).rejects.toMatchObject({ kind: 'unique' });
  expect(
    await database.executor.all({
      sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
      params: [ctx.orgId],
    }),
  ).toEqual([{ id: failure.id }]);
});

it('refuses non-failure actions before touching the executor', async () => {
  const batch = vi.fn(database.executor.batch.bind(database.executor));
  const repository = createAuditFailureRepository({
    driver: database.executor.driver,
    all: database.executor.all.bind(database.executor),
    batch,
  });
  await expect(repository.stage(ctx, { ...event(), action: 'session.login' })).rejects.toThrow(
    'invalid audit failure action',
  );
  expect(batch).not.toHaveBeenCalled();
});
