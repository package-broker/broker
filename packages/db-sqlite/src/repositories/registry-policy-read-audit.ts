import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type { PolicyReadAuditSink } from '@package-broker/core/registry/policy/read-audit';
import { auditPendingStatement } from './audit-pending.js';

/** Direct-denial evidence of one request, persisted in one batch before the denial is answered. */
export function createPolicyReadAuditSink(executor: SqlExecutor): PolicyReadAuditSink {
  return {
    async record(ctx: OrgContext, events: readonly AuditEvent[]) {
      if (events.length === 0) return;
      await executor.batch(events.map((event) => auditPendingStatement(ctx, event)));
    },
  };
}
