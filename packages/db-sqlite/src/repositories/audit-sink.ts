import type {
  AuditSinkRegistryPort,
  AuditSinkSnapshot,
  AuditSinkState,
} from '@package-broker/core/audit/sinks/registry';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';

const columns: readonly {
  column: string;
  alias: string;
  value: (row: AuditSinkState) => SqlValue;
}[] = [
  { column: 'sink_id', alias: 'id', value: (row) => row.id },
  { column: 'plugin_id', alias: 'pluginId', value: (row) => row.pluginId },
  { column: 'kind', alias: 'kind', value: (row) => row.kind },
  { column: 'generation', alias: 'generation', value: (row) => row.generation },
  {
    column: 'receiver_fingerprint',
    alias: 'receiverFingerprint',
    value: (row) => row.receiverFingerprint,
  },
  { column: 'durable_ack', alias: 'durableAck', value: (row) => Number(row.durableAck) },
  { column: 'activation_source', alias: 'activationSource', value: (row) => row.activationSource },
  { column: 'state', alias: 'state', value: (row) => row.state },
  { column: 'blocked_reason', alias: 'blockedReason', value: (row) => row.blockedReason },
  { column: 'progress_seq', alias: 'progressSeq', value: (row) => row.progressSeq },
  { column: 'progress_hash', alias: 'progressHash', value: (row) => row.progressHash },
  { column: 'custody_seq', alias: 'custodySeq', value: (row) => row.custodySeq },
  { column: 'inflight_from', alias: 'inflightFrom', value: (row) => row.inflightFrom },
  { column: 'inflight_to', alias: 'inflightTo', value: (row) => row.inflightTo },
  { column: 'inflight_body', alias: 'inflightBody', value: (row) => row.inflightBody },
  { column: 'inflight_repr', alias: 'inflightRepr', value: (row) => row.inflightRepr },
];
const select = columns.map(({ column, alias }) => `${column} AS "${alias}"`).join(', ');
const values = (row: AuditSinkState): SqlValue[] => columns.map(({ value }) => value(row));

export function createAuditSinkRepository(executor: SqlExecutor): AuditSinkRegistryPort {
  return {
    async read(ctx) {
      const [chain] = await executor.all<Omit<AuditSinkSnapshot, 'sinks'>>({
        sql: `SELECT chain_id AS chainId, epoch, incarnation, mode_generation AS modeGeneration, boundary_seq AS boundarySeq,
          boundary_prev_hash AS boundaryPrevHash, boundary_reason AS boundaryReason, policy, restore_pending AS restorePending
          FROM audit_chain WHERE org_id = ?`,
        params: [ctx.orgId],
      });
      if (chain === undefined) throw new Error('Audit chain unavailable');
      const sinks = await executor.all<AuditSinkState>({
        sql: `SELECT ${select} FROM audit_sink WHERE org_id = ? ORDER BY sink_id`,
        params: [ctx.orgId],
      });
      return {
        ...chain,
        restorePending: Boolean(chain.restorePending),
        sinks: sinks.map((row) => ({ ...row, durableAck: Boolean(row.durableAck) })),
      };
    },
    async save(ctx, expected, change) {
      if (expected.sinks.some((sink) => sink.generation > change.generation)) return false;
      const statements: Statement[] = [
        {
          sql: `UPDATE audit_chain SET incarnation = incarnation WHERE org_id = ? AND mode_generation = ? AND incarnation = ?
          AND chain_id = ? AND epoch = ? AND boundary_seq = ? AND boundary_prev_hash = ? AND policy = ? AND restore_pending = ?`,
          params: [
            ctx.orgId,
            expected.modeGeneration,
            expected.incarnation,
            expected.chainId,
            expected.epoch,
            expected.boundarySeq,
            expected.boundaryPrevHash,
            expected.policy,
            Number(expected.restorePending),
          ],
        },
        ...assertCheck(sql`changes() = 1`),
      ];
      // Guard membership as well as row contents: another boot may have added a sink.
      statements.push(
        ...assertCheck(
          sql`(SELECT count(*) FROM audit_sink WHERE org_id = ${ctx.orgId}) = ${expected.sinks.length}`,
        ),
      );
      for (const old of expected.sinks) {
        const comparisons = columns.map(({ column }) => `${column} IS ?`).join(' AND ');
        const guard: Statement = {
          sql: `UPDATE audit_sink SET generation = generation WHERE org_id = ? AND ${comparisons}`,
          params: [ctx.orgId, ...values(old)],
        };
        statements.push(guard, ...assertCheck(sql`changes() = 1`));
      }
      for (const sink of change.sinks) {
        statements.push({
          sql: `INSERT INTO audit_sink (org_id, ${columns.map(({ column }) => column).join(', ')}, updated_at)
            VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
            ON CONFLICT (org_id, sink_id) DO UPDATE SET ${columns
              .filter(({ column }) => column !== 'sink_id')
              .map(({ column }) => `${column} = excluded.${column}`)
              .join(
                ', ',
              )}, body_version = audit_sink.body_version + 1, updated_at = excluded.updated_at`,
          params: [ctx.orgId, ...values(sink), change.now],
        });
      }
      const ledger = createAuditLedgerRepository(executor);
      for (const rebind of change.rebinds) {
        if (rebind.custodySeq >= rebind.fromSeq) {
          statements.push(
            ...ledger.statements(ctx, [
              {
                id: rebind.id,
                kind: 'rebind',
                chainId: expected.chainId,
                epoch: expected.epoch,
                fromSeq: rebind.fromSeq,
                toSeq: rebind.custodySeq,
                count: 0,
                sinkId: rebind.sinkId,
                reasonCode: 'receiver_changed',
                policy: expected.policy,
                modeGeneration: expected.modeGeneration,
                actorType: 'system',
                actorId: null,
                createdAt: change.now,
              },
            ]),
          );
        }
        statements.push(auditPendingStatement(ctx, rebind.event));
      }
      try {
        await executor.batch(statements);
        return true;
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        )
          return false;
        throw error;
      }
    },
  };
}
