import type { AuditRow } from '@package-broker/core/audit/chain';
import type { AuditVerifyReader } from '@package-broker/core/audit/verify';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';

const PAGE_SQL =
  'SELECT id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json FROM audit_event WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?';

export function createAuditVerifyReader(executor: ScalarSqlExecutor): AuditVerifyReader {
  return {
    async markVerified(ctx, completedAt) {
      await executor.batch([
        {
          sql: 'UPDATE organization SET audit_last_verified_at = ? WHERE id = ? AND (audit_last_verified_at IS NULL OR audit_last_verified_at < ?)',
          params: [completedAt, ctx.orgId, completedAt],
        },
      ]);
    },
    async page(ctx, afterSeq, limit) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new RangeError('afterSeq must be a non-negative safe integer');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError('limit must be an integer from 1 to 500');
      }
      return executor.all<AuditRow>({ sql: PAGE_SQL, params: [ctx.orgId, afterSeq, limit] });
    },
  };
}
