import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { auditPendingStatement } from './audit-pending.js';

const event: AuditEvent = {
  id: '01K7R5V0000000000000000001',
  occurredAt: '2026-10-17T10:00:00.000Z',
  actor: { type: 'user', id: 'actor' },
  tokenSelector: 'abcdefghijkl',
  sourceIp: '203.0.113.7',
  action: 'project.update',
  target: { type: 'project', id: 'target' },
  projectId: 'project',
  payloadJson: '{}',
};
let database: MigratedDatabase;
let ctx: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ctx = database.orgs.a;
});
afterEach(async () => database.close());

function rows() {
  return database.executor.all({
    sql: 'SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id',
    params: [ctx.orgId],
  });
}
function business(): Statement {
  return {
    sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('business', ?, 'business', 'before')",
    params: [ctx.orgId],
  };
}

describe('auditPendingStatement', () => {
  it('commits all event columns alongside a business change', async () => {
    await database.executor.batch([business(), auditPendingStatement(ctx, event)]);
    expect(await rows()).toEqual([
      {
        id: event.id,
        org_id: ctx.orgId,
        created_at: event.occurredAt,
        actor_type: event.actor.type,
        actor_id: event.actor.id,
        token_selector: event.tokenSelector,
        source_ip: event.sourceIp,
        action: event.action,
        target_type: event.target.type,
        target_id: event.target.id,
        project_id: event.projectId,
        payload_json: event.payloadJson,
      },
    ]);
  });

  it('rolls back the audit row when a later business insert violates uniqueness', async () => {
    await expect(
      database.executor.batch([business(), auditPendingStatement(ctx, event), business()]),
    ).rejects.toMatchObject({ kind: 'unique' });
    expect(await rows()).toEqual([]);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM project WHERE org_id = ?',
        params: [ctx.orgId],
      }),
    ).toEqual([]);
  });

  it('binds the context organization once despite foreign organization data in the event', async () => {
    const foreign = database.orgs!.b.orgId;
    const input = {
      ...event,
      orgId: foreign,
      actor: { ...event.actor, id: foreign },
      target: { type: foreign, id: foreign },
      projectId: foreign,
      payloadJson: JSON.stringify({ orgId: foreign }),
    };
    const statement = auditPendingStatement(ctx, input);
    expect(statement.params.filter((param) => param === ctx.orgId)).toHaveLength(1);
    expect(statement.sql).not.toContain(ctx.orgId);
    await database.executor.batch([statement]);
    expect(await rows()).toEqual([expect.objectContaining({ org_id: ctx.orgId })]);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [foreign],
      }),
    ).toEqual([]);
  });

  it.each([
    ['bad id length', { id: 'short' }],
    ['invalid ULID alphabet', { id: 'I'.repeat(26) }],
    ['ULID overflow', { id: '8'.repeat(26) }],
    ['timestamp without Z', { occurredAt: '2026-10-17T10:00:00.000' }],
    ['timestamp without milliseconds', { occurredAt: '2026-10-17T10:00:00Z' }],
    ['invalid calendar date', { occurredAt: '2026-02-30T10:00:00.000Z' }],
    ['4097-byte payload', { payloadJson: 'a'.repeat(4097) }],
    ['multibyte payload over 4096 bytes', { payloadJson: 'é'.repeat(2049) }],
  ])('rejects %s before returning a statement', (_name, override) => {
    expect(() => auditPendingStatement(ctx, { ...event, ...override })).toThrow(TypeError);
  });

  it.each([false, true])(
    'conditionally stages an audit row when the condition is %s',
    async (matches) => {
      await database.executor.batch([
        business(),
        auditPendingStatement(ctx, event, {
          sql: 'EXISTS (SELECT 1 FROM project WHERE org_id = ? AND name = ?)',
          params: [ctx.orgId, matches ? 'before' : 'after'],
        }),
      ]);
      expect(await rows()).toHaveLength(matches ? 1 : 0);
    },
  );

  it('accepts a 4096-byte UTF-8 payload and nullable fields', async () => {
    const payloadJson = JSON.stringify('é'.repeat(2047));
    await database.executor.batch([
      auditPendingStatement(ctx, {
        ...event,
        payloadJson,
        actor: { type: 'system', id: null },
        tokenSelector: null,
        sourceIp: null,
        target: { type: 'system', id: null },
        projectId: null,
      }),
    ]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        payload_json: payloadJson,
        actor_id: null,
        token_selector: null,
        source_ip: null,
        target_id: null,
        project_id: null,
      }),
    ]);
  });

  it('stages two distinct event ids in one batch', async () => {
    const second = { ...event, id: '01K7R5V0000000000000000002' };
    await database.executor.batch([
      auditPendingStatement(ctx, event),
      auditPendingStatement(ctx, second),
    ]);
    expect((await rows()).map((row) => row.id)).toEqual([event.id, second.id]);
  });

  it('rolls back both rows when an event id is repeated', async () => {
    await expect(
      database.executor.batch([
        auditPendingStatement(ctx, event),
        auditPendingStatement(ctx, event),
      ]),
    ).rejects.toMatchObject({ kind: 'unique' });
    expect(await rows()).toEqual([]);
  });

  it('rejects a condition that would exceed 100 bound parameters', () => {
    expect(() =>
      auditPendingStatement(ctx, event, {
        sql: Array.from({ length: 89 }, () => '? IS NOT NULL').join(' AND '),
        params: Array.from({ length: 89 }, () => 1),
      }),
    ).toThrow(TypeError);
  });
});
