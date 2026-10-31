import type { AuditCutoverPort } from '@package-broker/core/audit/cutover';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createAuditLedgerRepository, auditLedgerError } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';
import { clearAuditVerificationStatements } from './audit-verify.js';

export function createAuditCutoverRepository(executor: SqlExecutor): AuditCutoverPort & {
  diagnose(
    org: OrgContext,
    generation: number,
    actor: { type: string; id: string },
  ): Promise<string>;
} {
  const ledger = createAuditLedgerRepository(executor);
  return {
    async diagnose(org, generation, actor) {
      const table = actor.type === 'user' ? 'user_account' : 'service_principal';
      const [row] = await executor.all<{ code: string }>({
        sql: `SELECT CASE
          WHEN c.restore_pending <> 0 THEN 'restore_pending'
          WHEN coalesce(c.pending_mode, c.mode) <> 'none' THEN 'mode_not_none'
          WHEN EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.generation > ?) THEN 'stale_generation'
          WHEN NOT EXISTS (SELECT 1 FROM ${table} WHERE org_id = ? AND id = ? AND status = 'active') THEN 'operator_unavailable'
          ELSE 'head_mismatch' END AS code FROM audit_chain c WHERE c.org_id = ?`,
        params: [org.orgId, generation, org.orgId, actor.id, org.orgId],
      });
      return row?.code ?? 'head_mismatch';
    },
    async record(org, artifact, generation, event, entry) {
      const [state] = await executor.all<{
        policy: 'availability' | 'required';
        modeGeneration: number;
        incarnation: number;
      }>({
        sql: 'SELECT policy, mode_generation AS modeGeneration, incarnation FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      });
      if (!state) return false;
      const table = event.actor.type === 'user' ? 'user_account' : 'service_principal';
      if (
        event.action !== 'audit.export' ||
        entry.reasonCode !== 'verified_export' ||
        entry.kind !== 'export' ||
        entry.sinkId !== null ||
        entry.chainId !== artifact.chainId ||
        entry.epoch !== artifact.epoch ||
        entry.fromSeq !== artifact.boundarySeq ||
        entry.toSeq !== artifact.headSeq ||
        entry.count !== artifact.bodies ||
        artifact.withheld !== 0 ||
        artifact.orgId !== org.orgId ||
        artifact.bodies !== artifact.headSeq - artifact.boundarySeq + 1 ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        !['user', 'service_principal'].includes(event.actor.type) ||
        entry.actorType !== event.actor.type ||
        entry.actorId !== event.actor.id
      )
        throw new TypeError('Invalid audit export registration');
      const statements = [
        ...assertCheck(sql`EXISTS (SELECT 1 FROM audit_chain c
          WHERE c.org_id = ${org.orgId} AND c.chain_id = ${artifact.chainId}
          AND c.epoch = ${artifact.epoch} AND c.head_seq >= ${artifact.headSeq}
          AND c.boundary_seq <= ${artifact.boundarySeq}
          AND EXISTS (SELECT 1 FROM audit_event e WHERE e.org_id = ${org.orgId}
            AND e.seq = ${artifact.headSeq} AND e.hash = ${artifact.headHash})
          AND coalesce(c.pending_mode, c.mode) = 'none'
          AND c.incarnation = ${state.incarnation} AND c.mode_generation = ${state.modeGeneration}
          AND c.policy = ${state.policy} AND c.restore_pending = 0
          AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ${org.orgId} AND s.generation > ${generation}))`),
        ...assertCheck(sql`EXISTS (SELECT 1 FROM ${sql.table(table)}
          WHERE org_id = ${org.orgId} AND id = ${event.actor.id} AND status = 'active')`),
        ...ledger.statements(org, [
          { ...entry, policy: state.policy, modeGeneration: state.modeGeneration },
        ]),
        ...clearAuditVerificationStatements(org),
      ];
      const pending = auditPendingStatement(org, event);
      statements.push({ ...pending, sql: `${pending.sql} RETURNING id` });
      try {
        const result = await executor.batch(statements);
        return result.at(-1)?.rows.length === 1;
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        )
          return false;
        throw auditLedgerError(error);
      }
    },
  };
}
