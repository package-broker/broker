import { ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';

export const JOURNAL_TIME = '2026-10-28T00:00:00.000Z';

export async function seedAuditJournal(
  executor: ScalarSqlExecutor,
  org: OrgContext,
  count = 5,
): Promise<void> {
  for (let seq = 1; seq <= count; seq++) {
    const id = ulid(Date.parse(JOURNAL_TIME));
    const event = auditEvent({
      id,
      now: JOURNAL_TIME,
      actor: { type: 'system', id: null },
      action: 'source.update',
      target: { type: 'source', id: 'source' },
      projectId: seq % 2 === 0 ? 'project-b' : 'project-a',
      context: {
        opId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
        requestId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
      changes: { url: { new: 'https://host.test/repo' } },
    });
    if (!event.ok) throw new Error('Invalid audit journal fixture');
    await executor.batch([
      {
        sql: `INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, action, target_type, target_id, project_id, payload_json, source_ip)
        VALUES (?, ?, ?, ?, ?, ?, 'system', 'source.update', 'source', 'source', ?, ?, '203.0.113.7')`,
        params: [
          id,
          org.orgId,
          seq,
          String(seq - 1).repeat(64),
          String(seq).repeat(64),
          JOURNAL_TIME,
          seq % 2 === 0 ? 'project-b' : 'project-a',
          event.event.payloadJson,
        ],
      },
    ]);
  }
  await executor.batch([
    {
      sql: 'UPDATE audit_chain SET head_seq = ?, head_hash = ? WHERE org_id = ?',
      params: [count, String(count).repeat(64), org.orgId],
    },
  ]);
}
