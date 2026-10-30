import type { AuditStatusReader, AuditStatusSnapshot } from '@package-broker/core/audit/status';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';

export function createAuditStatusReader(executor: ScalarSqlExecutor): AuditStatusReader {
  return {
    async read(ctx) {
      const results = await executor.batch([
        {
          sql: `SELECT chain_id AS chainId, epoch, head_seq AS headSeq, head_hash AS headHash,
            boundary_seq AS boundarySeq, boundary_prev_hash AS boundaryPrevHash,
            mode, pending_mode AS pendingMode, capacity_state AS capacityState,
            journal_rows AS journalRows, journal_bytes AS journalBytes,
            restore_pending AS restorePending, verified_from_seq AS fromSeq,
            verified_through_seq AS throughSeq, verified_bodies AS bodies,
            verified_withheld AS withheld, verified_at AS verifiedAt
            FROM audit_chain WHERE org_id = ?`,
          params: [ctx.orgId],
        },
        {
          sql: 'SELECT count(*) AS count FROM audit_pending WHERE org_id = ?',
          params: [ctx.orgId],
        },
        {
          sql: `SELECT sink_id AS id, state, progress_seq AS progressSeq,
            custody_seq AS custodySeq, durable_ack AS durableAck, activation_source AS activationSource
            FROM audit_sink WHERE org_id = ? ORDER BY sink_id`,
          params: [ctx.orgId],
        },
        {
          sql: `SELECT kind, sum(count) AS count FROM audit_ledger
            WHERE org_id = ? AND superseded_by IS NULL
              AND kind IN ('gap', 'withheld', 'skipped', 'uncertain')
              AND (chain_id, epoch) = (SELECT chain_id, epoch FROM audit_chain AS current_chain WHERE current_chain.org_id = ?)
              AND (kind <> 'uncertain' OR NOT EXISTS (
                SELECT 1 FROM audit_ledger AS resolution
                WHERE resolution.org_id = ? AND resolution.resolves_id = audit_ledger.id
              ))
            GROUP BY kind ORDER BY kind`,
          params: [ctx.orgId, ctx.orgId, ctx.orgId],
        },
      ]);
      const row = results[0]!.rows[0];
      if (row === undefined) throw new Error('Audit status unavailable');
      if (
        row['verifiedAt'] !== null &&
        [row['fromSeq'], row['throughSeq'], row['bodies'], row['withheld']].some(
          (value) => value === null,
        )
      ) {
        throw new Error('Audit status unavailable');
      }
      return {
        chainId: String(row['chainId']),
        epoch: Number(row['epoch']),
        headSeq: Number(row['headSeq']),
        headHash: String(row['headHash']),
        boundarySeq: Number(row['boundarySeq']),
        boundaryPrevHash: String(row['boundaryPrevHash']),
        mode: row['mode'] as AuditStatusSnapshot['mode'],
        pendingMode: row['pendingMode'] as AuditStatusSnapshot['pendingMode'],
        pendingCount: Number(results[1]!.rows[0]!['count']),
        restorePending: Boolean(row['restorePending']),
        capacity: {
          state: row['capacityState'] as AuditStatusSnapshot['capacity']['state'],
          journalRows: Number(row['journalRows']),
          journalBytes: Number(row['journalBytes']),
        },
        verification:
          row['verifiedAt'] === null
            ? null
            : {
                fromSeq: Number(row['fromSeq']),
                throughSeq: Number(row['throughSeq']),
                bodies: Number(row['bodies']),
                withheld: Number(row['withheld']),
                verifiedAt: String(row['verifiedAt']),
              },
        sinks: results[2]!.rows.map((sink) => ({
          id: String(sink['id']),
          state: sink['state'] as AuditStatusSnapshot['sinks'][number]['state'],
          progressSeq: Number(sink['progressSeq']),
          custodySeq: Number(sink['custodySeq']),
          durableAck: Boolean(sink['durableAck']),
          activationSource: String(sink['activationSource']),
        })),
        ledger: results[3]!.rows.map((entry) => ({
          kind: String(entry['kind']),
          count: Number(entry['count']),
        })),
      };
    },
  };
}
