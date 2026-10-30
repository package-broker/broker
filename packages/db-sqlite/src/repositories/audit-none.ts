import type { AuditNonePort, AuditNoneSnapshot } from '@package-broker/core/audit/none';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { noopObservability, type Observability } from '@package-broker/core/platform/observability';
import { assertCheck } from '../kysely.js';
import { auditLedgerError, createAuditLedgerRepository } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';
import { clearAuditVerificationStatements } from './audit-verify.js';

export function createAuditNoneRepository(
  executor: SqlExecutor,
  observability: Observability = noopObservability,
): AuditNonePort {
  const ledger = createAuditLedgerRepository(executor);
  return {
    async snapshot(ctx) {
      const [row] = await executor.all<
        Omit<AuditNoneSnapshot, 'restorePending'> & { restorePending: number }
      >({
        sql: `SELECT chain_id AS chainId, epoch, incarnation, head_seq AS headSeq, mode,
          pending_mode AS pendingMode, mode_generation AS modeGeneration,
          cutover_seq AS cutoverSeq, restore_pending AS restorePending, policy FROM audit_chain WHERE org_id = ?`,
        params: [ctx.orgId],
      });
      if (row === undefined) throw new Error('Audit chain unavailable');
      return { ...row, restorePending: Boolean(row.restorePending) };
    },
    async record(ctx, expected, generation, entries, event) {
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        entries.length !== 2 ||
        entries[0]?.kind !== 'mode_change' ||
        entries[1]?.kind !== 'cutover' ||
        entries.some(
          (entry) =>
            entry.chainId !== expected.chainId ||
            entry.epoch !== expected.epoch ||
            entry.modeGeneration !== expected.modeGeneration + 1 ||
            entry.policy !== 'availability' ||
            entry.fromSeq !== Math.max(1, expected.headSeq) ||
            entry.toSeq !== Math.max(1, expected.headSeq) ||
            entry.count !== 0 ||
            entry.sinkId !== null ||
            entry.reasonCode !== 'mode_none',
        ) ||
        event.action !== 'audit.mode_change'
      )
        throw new TypeError('Invalid audit none transition');
      const statements = [
        ...assertCheck(sql`EXISTS (SELECT 1 FROM audit_chain c
          WHERE c.org_id = ${ctx.orgId} AND c.chain_id = ${expected.chainId}
          AND c.epoch = ${expected.epoch} AND c.incarnation = ${expected.incarnation}
          AND c.head_seq = ${expected.headSeq} AND c.mode = ${expected.mode}
          AND c.pending_mode IS ${expected.pendingMode} AND c.mode_generation = ${expected.modeGeneration}
          AND c.cutover_seq IS ${expected.cutoverSeq} AND c.policy = ${expected.policy}
          AND c.restore_pending = ${Number(expected.restorePending)}
          AND c.policy = 'availability' AND c.restore_pending = 0
          AND coalesce(c.pending_mode, c.mode) != 'none'
          AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ${ctx.orgId}
            AND s.generation > ${generation}))`),
      ];
      const modeUpdateIndex = statements.length;
      statements.push(
        {
          sql: `UPDATE audit_chain SET pending_mode = 'none',
            cutover_seq = head_seq, mode_generation = mode_generation + 1
            WHERE org_id = ? RETURNING org_id`,
          params: [ctx.orgId],
        },
        ...ledger.statements(ctx, entries),
        auditPendingStatement(ctx, event),
        ...clearAuditVerificationStatements(ctx),
      );
      try {
        const results = await executor.batch(statements);
        return results.at(modeUpdateIndex)?.rows.length === 1;
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        ) {
          observability.log({ level: 'warn', event: 'audit.none.contended' });
          return false;
        }
        throw auditLedgerError(error);
      }
    },
  };
}
