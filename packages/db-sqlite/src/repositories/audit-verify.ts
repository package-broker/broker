import type { AuditRow } from '@package-broker/core/audit/chain';
import type { AuditVerifySnapshot, AuditVerifyReader } from '@package-broker/core/audit/verify';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

const PAGE_SQL =
  'SELECT id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json FROM audit_event WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?';

export function clearAuditVerificationStatements(ctx: OrgContext): readonly ScalarStatement[] {
  return [
    {
      sql: `UPDATE audit_chain SET verified_from_seq = NULL, verified_through_seq = NULL,
            verified_bodies = NULL, verified_withheld = NULL, verified_at = NULL WHERE org_id = ?`,
      params: [ctx.orgId],
    },
    {
      sql: 'UPDATE organization SET audit_last_verified_at = NULL WHERE id = ?',
      params: [ctx.orgId],
    },
  ];
}

export function createAuditVerifyReader(executor: ScalarSqlExecutor): AuditVerifyReader {
  return {
    async snapshot(ctx) {
      const [row] = await executor.all<
        AuditVerifySnapshot & { stored_seq: number; stored_hash: string }
      >({
        sql: `SELECT head_seq AS stored_seq, head_hash AS stored_hash, chain_id, epoch, incarnation, mode_generation, boundary_seq, boundary_prev_hash,
          COALESCE((SELECT seq FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1), head_seq) AS head_seq,
          COALESCE((SELECT hash FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1), head_hash) AS head_hash
          FROM audit_chain WHERE org_id = ?`,
        params: [ctx.orgId, ctx.orgId, ctx.orgId],
      });
      if (row === undefined) throw new Error('audit chain unavailable');
      const snapshot = row;
      const { stored_seq, stored_hash } = snapshot;
      if (stored_seq >= snapshot.head_seq) {
        snapshot.head_seq = stored_seq;
        snapshot.head_hash = stored_hash;
      }
      return snapshot;
    },
    async markVerified(ctx, completedAt, scope, snapshot) {
      const [result] = await executor.batch([
        {
          sql: `UPDATE audit_chain SET verified_from_seq = ?, verified_through_seq = ?,
            verified_bodies = ?, verified_withheld = ?, verified_at = ?
            WHERE org_id = ? AND chain_id = ? AND epoch = ? AND incarnation = ?
              AND mode_generation = ? AND boundary_seq = ? AND boundary_prev_hash = ?
              AND ((? = boundary_seq - 1 AND ? = boundary_prev_hash)
                OR EXISTS (SELECT 1 FROM audit_event h WHERE h.org_id = ? AND h.seq = ? AND h.hash = ?))
              AND ((? = boundary_seq - 1 AND ? = boundary_prev_hash)
                OR EXISTS (SELECT 1 FROM audit_event s WHERE s.org_id = ? AND s.seq = ? AND s.hash = ?))
              AND (verified_at IS NULL OR verified_at <= ?) RETURNING org_id`,
          params: [
            scope.fromSeq,
            scope.throughSeq,
            scope.bodies,
            scope.withheld,
            completedAt,
            ctx.orgId,
            snapshot.chain_id,
            snapshot.epoch,
            snapshot.incarnation,
            snapshot.mode_generation,
            snapshot.boundary_seq,
            snapshot.boundary_prev_hash,
            snapshot.head_seq,
            snapshot.head_hash,
            ctx.orgId,
            snapshot.head_seq,
            snapshot.head_hash,
            snapshot.stored_seq,
            snapshot.stored_hash,
            ctx.orgId,
            snapshot.stored_seq,
            snapshot.stored_hash,
            completedAt,
          ],
        },
        {
          sql: `UPDATE organization SET audit_last_verified_at = ? WHERE id = ?
            AND ? = 1 AND changes() = 1
            AND (audit_last_verified_at IS NULL OR audit_last_verified_at <= ?)`,
          params: [completedAt, ctx.orgId, scope.fromSeq, completedAt],
        },
      ]);
      return (result?.rows.length ?? 0) === 1;
    },
    async clearVerification(ctx) {
      await executor.batch(clearAuditVerificationStatements(ctx));
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
