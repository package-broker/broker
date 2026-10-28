import {
  assertAuditLedgerEntry,
  mergeAuditLedgerGaps,
  type AuditLedgerEntry,
  type AuditLedgerPort,
} from '@package-broker/core/audit/ledger';
import { isUlid } from '@package-broker/core/ids';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

export interface AuditLedgerRepository extends AuditLedgerPort {
  statements(ctx: OrgContext, entries: readonly AuditLedgerEntry[]): readonly ScalarStatement[];
}

const COLUMNS = `id, kind, chain_id AS chainId, epoch, from_seq AS fromSeq,
  to_seq AS toSeq, count, sink_id AS sinkId, reason_code AS reasonCode, policy,
  mode_generation AS modeGeneration, actor_type AS actorType, actor_id AS actorId,
  created_at AS createdAt`;

const EFFECTIVE_GAP = `(kind <> 'gap' OR NOT EXISTS (
              SELECT 1 FROM audit_ledger AS later
              WHERE later.org_id = ? AND later.kind = 'gap'
                AND later.rowid > current.rowid
                AND later.chain_id = current.chain_id AND later.epoch = current.epoch
                AND later.sink_id IS current.sink_id AND later.reason_code = current.reason_code
                AND later.from_seq <= current.from_seq AND later.to_seq >= current.to_seq
            ))`;

export class AuditLedgerIntegrityError extends Error {
  constructor() {
    super('audit ledger integrity failure');
    this.name = 'AuditLedgerIntegrityError';
  }
}

function validatedRows(rows: readonly AuditLedgerEntry[]): readonly AuditLedgerEntry[] {
  for (const row of rows) {
    try {
      assertAuditLedgerEntry(row);
    } catch {
      throw new AuditLedgerIntegrityError();
    }
  }
  return rows;
}

export function createAuditLedgerRepository(executor: ScalarSqlExecutor): AuditLedgerRepository {
  const statements = (
    ctx: OrgContext,
    entries: readonly AuditLedgerEntry[],
  ): readonly ScalarStatement[] =>
    mergeAuditLedgerGaps(entries).map((entry) => ({
      sql: `WITH incoming (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
        count, sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at)
        AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
        latest AS (
          SELECT l.* FROM audit_ledger l, incoming i
          WHERE l.org_id = ? AND i.kind = 'gap' AND l.kind = 'gap'
            AND l.chain_id = i.chain_id AND l.epoch = i.epoch
            AND l.sink_id IS i.sink_id AND l.reason_code = i.reason_code
          ORDER BY l.rowid DESC LIMIT 1
        ), combined AS (
          SELECT i.org_id, i.id, i.kind, i.chain_id, i.epoch,
            min(i.from_seq, coalesce(l.from_seq, i.from_seq)) AS from_seq,
            max(i.to_seq, coalesce(l.to_seq, i.to_seq)) AS to_seq,
            i.count + coalesce(l.count, 0) AS count,
            i.sink_id, i.reason_code, i.policy, i.mode_generation,
            i.actor_type, i.actor_id, i.created_at
          FROM incoming i LEFT JOIN latest l
            ON i.from_seq - l.to_seq <= 1 AND l.from_seq - i.to_seq <= 1
        )
        INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq,
          count, sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at)
        SELECT org_id, id, kind, chain_id, epoch, from_seq, to_seq,
          CASE WHEN count <= to_seq - from_seq + 1 AND count <= 9007199254740991
            THEN count ELSE -1 END,
          sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at
        FROM combined`,
      params: [
        ctx.orgId,
        entry.id,
        entry.kind,
        entry.chainId,
        entry.epoch,
        entry.fromSeq,
        entry.toSeq,
        entry.count,
        entry.sinkId,
        entry.reasonCode,
        entry.policy,
        entry.modeGeneration,
        entry.actorType,
        entry.actorId,
        entry.createdAt,
        ctx.orgId,
      ],
    }));
  return {
    statements,
    async append(ctx, entries) {
      const batch = statements(ctx, entries);
      if (batch.length > 0) await executor.batch(batch);
    },
    async effectiveGaps(ctx) {
      const rows = await executor.all<AuditLedgerEntry>({
        sql: `SELECT ${COLUMNS} FROM audit_ledger AS current
          WHERE current.org_id = ? AND kind = 'gap' AND ${EFFECTIVE_GAP} ORDER BY id`,
        params: [ctx.orgId, ctx.orgId],
      });
      return validatedRows(rows);
    },
    async page(ctx, afterId, limit) {
      if (
        (afterId !== null && !isUlid(afterId)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        throw new RangeError('invalid audit ledger page');
      }
      const rows = await executor.all<AuditLedgerEntry>({
        sql: `SELECT ${COLUMNS} FROM audit_ledger AS current
          WHERE current.org_id = ? AND id > ?
            AND ${EFFECTIVE_GAP}
          ORDER BY id LIMIT ?`,
        params: [ctx.orgId, afterId ?? '', ctx.orgId, limit],
      });
      return validatedRows(rows);
    },
  };
}
