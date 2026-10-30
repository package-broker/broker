import type { AuditFailurePort } from '@package-broker/core/audit/failure-events';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { auditPendingStatement } from './audit-pending.js';

export function createAuditFailureRepository(executor: SqlExecutor): AuditFailurePort {
  return {
    async stage(ctx, event) {
      if (event.action !== 'session.login_failed' && event.action !== 'access.denied') {
        throw new TypeError('invalid audit failure action');
      }
      await executor.batch([auditPendingStatement(ctx, event)]);
    },
  };
}
