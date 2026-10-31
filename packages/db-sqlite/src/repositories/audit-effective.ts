import type { EffectiveAuditConfig } from '@package-broker/core/audit/effective';
import type { AuditNoneSnapshot } from '@package-broker/core/audit/none';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { SqlExecutor, OrgContext } from '@package-broker/core/db/port';
import { DbError, ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createAuditLedgerRepository, auditLedgerError } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';
import { clearAuditVerificationStatements } from './audit-verify.js';

export function createAuditEffectiveRepository(executor: SqlExecutor) {
  const ledger = createAuditLedgerRepository(executor);
  return {
    async initialize(
      org: OrgContext,
      expected: AuditNoneSnapshot,
      effective: EffectiveAuditConfig,
      generation: number,
    ): Promise<boolean> {
      if (!Number.isSafeInteger(generation) || generation < 0)
        throw new TypeError('Invalid audit effective transition');
      if (
        expected.modeGeneration !== 0 ||
        expected.headSeq !== 0 ||
        expected.epoch !== 0 ||
        expected.incarnation !== 0 ||
        expected.mode !== 'trail' ||
        expected.policy !== 'availability' ||
        expected.pendingMode !== null ||
        expected.cutoverSeq !== null ||
        expected.restorePending
      )
        return false;
      const rows = await executor.all({
        sql: `UPDATE audit_chain SET mode = ?, policy = ?, mode_generation = 1
          WHERE org_id = ? AND chain_id = ? AND epoch = 0 AND incarnation = 0
            AND mode = 'trail' AND policy = 'availability' AND mode_generation = 0
            AND head_seq = 0 AND head_hash = ? AND boundary_seq = 1 AND boundary_reason IS NULL
            AND journal_rows = 0 AND journal_bytes = 0 AND pending_mode IS NULL
            AND cutover_seq IS NULL AND restore_pending = 0 AND verified_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM audit_pending p WHERE p.org_id = ?)
            AND NOT EXISTS (SELECT 1 FROM audit_ledger l WHERE l.org_id = ?)
            AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.generation > ?)
          RETURNING org_id`,
        params: [
          effective.mode,
          effective.policy,
          org.orgId,
          expected.chainId,
          '0'.repeat(64),
          org.orgId,
          org.orgId,
          org.orgId,
          generation,
        ],
      });
      return rows.length === 1;
    },
    async save(
      org: OrgContext,
      expected: AuditNoneSnapshot,
      effective: EffectiveAuditConfig,
      generation: number,
      now: string,
      policyOnly = false,
    ): Promise<boolean> {
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        (expected.policy === 'required' && effective.policy !== 'required') ||
        (effective.mode === 'none' && !policyOnly)
      )
        throw new TypeError('Invalid audit effective transition');
      const policyChanged = expected.policy !== effective.policy;
      const modeChanged = !policyOnly && (expected.pendingMode ?? expected.mode) !== effective.mode;
      if (!policyOnly && expected.pendingMode !== null && expected.pendingMode !== effective.mode)
        return false;
      if (!policyChanged && !modeChanged) return true;
      const cutover = modeChanged && expected.mode === 'trail' && effective.mode === 'export';
      if (modeChanged && expected.pendingMode !== null) return false;
      const modeGeneration = expected.modeGeneration + 1;
      const event = auditEvent({
        id: ulid(),
        now,
        action: 'audit.mode_change',
        actor: { type: 'system', id: null },
        context: { opId: null, requestId: null, sourceIp: null, tokenSelector: null },
        target: { type: 'audit', id: null },
        changes: {
          from_mode: { new: expected.pendingMode ?? expected.mode },
          to_mode: { new: effective.mode },
          policy: { new: effective.policy },
          source: { new: effective.policySource === 'stored' ? 'cli' : effective.policySource },
          mode_generation: { new: modeGeneration },
          ...(cutover ? { cutover_seq: { new: expected.headSeq } } : {}),
        },
      });
      if (!event.ok) throw new TypeError('Invalid audit effective event');
      const common = {
        chainId: expected.chainId,
        epoch: expected.epoch,
        fromSeq: Math.max(1, expected.headSeq),
        toSeq: Math.max(1, expected.headSeq),
        count: 0,
        sinkId: null,
        policy: effective.policy,
        modeGeneration,
        actorType: 'system',
        actorId: null,
        createdAt: now,
      } as const;
      const statements = [
        ...assertCheck(sql`(${Number(!expected.restorePending || policyOnly)} = 1) AND EXISTS (SELECT 1 FROM audit_chain c WHERE c.org_id = ${org.orgId}
          AND c.chain_id = ${expected.chainId} AND c.epoch = ${expected.epoch}
          AND c.incarnation = ${expected.incarnation} AND c.mode_generation = ${expected.modeGeneration}
          AND c.policy = ${expected.policy} AND c.mode = ${expected.mode}
          AND c.pending_mode IS ${expected.pendingMode} AND c.head_seq = ${expected.headSeq}
          AND c.cutover_seq IS ${expected.cutoverSeq}
          AND c.restore_pending = ${Number(expected.restorePending)} AND NOT EXISTS (SELECT 1 FROM audit_sink s
            WHERE s.org_id = ${org.orgId} AND s.generation > ${generation}))`),
        ...ledger.statements(org, [
          ...(policyChanged
            ? [{ ...common, id: ulid(), kind: 'policy_change' as const, reasonCode: 'policy_set' }]
            : []),
          ...(modeChanged
            ? [{ ...common, id: ulid(), kind: 'mode_change' as const, reasonCode: 'mode_change' }]
            : []),
          ...(cutover
            ? [{ ...common, id: ulid(), kind: 'cutover' as const, reasonCode: 'mode_change' }]
            : []),
        ]),
        auditPendingStatement(org, event.event),
        ...clearAuditVerificationStatements(org),
        cutover
          ? {
              sql: `UPDATE audit_chain SET policy = ?, pending_mode = ?, cutover_seq = ?,
                mode_generation = ? WHERE org_id = ? RETURNING org_id`,
              params: [
                effective.policy,
                effective.mode,
                expected.headSeq,
                modeGeneration,
                org.orgId,
              ],
            }
          : policyOnly || expected.pendingMode !== null
            ? {
                sql: `UPDATE audit_chain SET policy = ?, mode_generation = ? WHERE org_id = ? RETURNING org_id`,
                params: [effective.policy, modeGeneration, org.orgId],
              }
            : {
                sql: `UPDATE audit_chain SET policy = ?, mode = ?, mode_generation = ? WHERE org_id = ? RETURNING org_id`,
                params: [effective.policy, effective.mode, modeGeneration, org.orgId],
              },
      ];
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
