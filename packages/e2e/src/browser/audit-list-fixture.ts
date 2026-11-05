import { auditEvent } from '@package-broker/core/audit/actions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';

export async function seedAuditList(file: string, orgId: string, projectId: string): Promise<void> {
  const database = openNodeSqliteExecutor(file);
  try {
    const org = orgContext(orgId);
    const event = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      actor: { type: 'system', id: null },
      action: 'project.create',
      target: { type: 'project', id: projectId },
      projectId,
      context: { opId: ulid(), requestId: null, sourceIp: null, tokenSelector: null },
      changes: { slug: { new: 'browser-fixture' } },
    });
    if (!event.ok) throw new Error('Invalid audit list fixture');
    await database.executor.batch([auditPendingStatement(org, event.event)]);
    const result = await createAuditSealRepository(database.executor).seal(org);
    if (result.outcome !== 'sealed') throw new Error('Audit list fixture was not sealed');
  } finally {
    await database.close();
  }
}
