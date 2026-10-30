import { noopObservability, type Observability } from '@package-broker/core/platform/observability';
import type { AuditHeadV1, AuditJournalReader } from '@package-broker/core/audit/plugin-api';
import { auditWireRecord } from '@package-broker/core/audit/wire';
import { AUDIT_GENESIS_HASH, type AuditRow } from '@package-broker/core/audit/chain';
import type { OrgContext, ScalarSqlExecutor, ScalarSqlValue } from '@package-broker/core/db/port';

export interface AuditQuery {
  readonly projectId?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly afterId?: string;
  readonly limit: number;
}

export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
  readonly pending: number;
  readonly lastVerifiedAt: string | null;
}

export interface AuditQueryRepository {
  list(ctx: OrgContext, query: AuditQuery): Promise<{ items: AuditRow[]; next: string | null }>;
  head(ctx: OrgContext): Promise<AuditHead | null>;
}

const COLUMNS = [
  'id',
  'org_id',
  'seq',
  'prev_hash',
  'hash',
  'created_at',
  'actor_type',
  'actor_id',
  'token_selector',
  'source_ip',
  'action',
  'target_type',
  'target_id',
  'project_id',
  'payload_json',
];
const HEAD_SQL =
  'SELECT head.seq, head.hash, pending.pending, (SELECT audit_last_verified_at FROM organization WHERE id = ?) AS last_verified_at FROM (SELECT count(*) AS pending FROM audit_pending WHERE org_id = ?) AS pending LEFT JOIN (SELECT seq, hash FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1) AS head ON 1 = 1';

export function createAuditQueryRepository(executor: ScalarSqlExecutor): AuditQueryRepository {
  return {
    async list(ctx, query) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
        throw new RangeError('limit must be an integer from 1 to 200');
      }
      let sql = `SELECT ${COLUMNS.join(', ')} FROM audit_event WHERE org_id = ?`;
      const params: ScalarSqlValue[] = [ctx.orgId];
      if (query.projectId !== undefined) {
        sql += ' AND project_id = ?';
        params.push(query.projectId);
      }
      if (query.actor !== undefined) {
        sql += ' AND actor_id = ?';
        params.push(query.actor);
      }
      if (query.action !== undefined) {
        sql += ' AND action = ?';
        params.push(query.action);
      }
      if (query.afterId !== undefined) {
        sql += ' AND seq > (SELECT seq FROM audit_event WHERE org_id = ? AND id = ?)';
        params.push(ctx.orgId, query.afterId);
      }
      sql += ' ORDER BY seq ASC LIMIT ?';
      params.push(query.limit + 1);
      const rows = await executor.all<AuditRow>({ sql, params });
      const items = rows.slice(0, query.limit);
      return {
        items,
        next: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      };
    },

    async head(ctx) {
      const [row] = await executor.all<{
        seq: number | null;
        hash: string | null;
        pending: number;
        last_verified_at: string | null;
      }>({ sql: HEAD_SQL, params: [ctx.orgId, ctx.orgId, ctx.orgId] });
      if (
        row === undefined ||
        (row.seq === null && row.pending === 0 && row.last_verified_at === null)
      )
        return null;
      return {
        seq: row.seq ?? 0,
        hash: row.hash ?? AUDIT_GENESIS_HASH,
        pending: row.pending,
        lastVerifiedAt: row.last_verified_at,
      };
    },
  };
}

interface JournalHeadRow {
  chain_id: string;
  epoch: number;
  head_seq: number;
  head_hash: string;
  boundary_seq: number;
  boundary_prev_hash: string;
  pending_count: number;
  verified_from_seq: number | null;
  verified_through_seq: number | null;
  verified_bodies: number | null;
  verified_withheld: number | null;
  verified_at: string | null;
}

/** Runtime assembly binds this reader to the resolved organization before exposing it to a plugin. */
export function createAuditJournalReader(
  executor: ScalarSqlExecutor,
  org: OrgContext,
  observability: Pick<Observability, 'counter'> = noopObservability,
): AuditJournalReader {
  const orgId = org.orgId;
  async function head(): Promise<AuditHeadV1> {
    const [row] = await executor.all<JournalHeadRow>({
      sql: `SELECT chain_id, epoch, head_seq, head_hash, boundary_seq, boundary_prev_hash,
        verified_from_seq, verified_through_seq, verified_bodies, verified_withheld, verified_at,
        (SELECT count(*) FROM audit_pending WHERE org_id = ?) AS pending_count
        FROM audit_chain WHERE org_id = ?`,
      params: [orgId, orgId],
    });
    if (row === undefined) throw new Error('Audit journal unavailable');
    if (
      row.verified_at !== null &&
      [
        row.verified_from_seq,
        row.verified_through_seq,
        row.verified_bodies,
        row.verified_withheld,
      ].some((value) => value === null)
    ) {
      throw new Error('Audit journal unavailable');
    }
    return {
      chainId: row.chain_id,
      epoch: row.epoch,
      headSeq: row.head_seq,
      headHash: row.head_hash,
      boundarySeq: row.boundary_seq,
      boundaryPrevHash: row.boundary_prev_hash,
      pendingCount: row.pending_count,
      verification:
        row.verified_at === null
          ? null
          : {
              fromSeq: row.verified_from_seq!,
              throughSeq: row.verified_through_seq!,
              bodies: row.verified_bodies!,
              withheld: row.verified_withheld!,
              verifiedAt: row.verified_at,
            },
    };
  }
  return Object.freeze({
    head,
    async list(query: Parameters<AuditJournalReader['list']>[0]) {
      const { projectId, actor, action, afterSeq, limit } = query;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new RangeError('limit must be an integer from 1 to 200');
      }
      if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
        throw new RangeError('Invalid audit journal cursor');
      }
      let sql = `SELECT ${COLUMNS.map((column) => `event.${column}`).join(
        ', ',
      )}, chain.chain_id, chain.epoch FROM audit_event AS event JOIN audit_chain AS chain ON chain.org_id = event.org_id WHERE event.org_id = ? AND event.seq >= chain.boundary_seq AND event.seq <= chain.head_seq`;
      const params: ScalarSqlValue[] = [orgId];
      if (projectId !== null) {
        sql += ' AND event.project_id = ?';
        params.push(projectId);
      }
      if (actor !== undefined) {
        sql += ' AND event.actor_id = ?';
        params.push(actor);
      }
      if (action !== undefined) {
        sql += ' AND event.action = ?';
        params.push(action);
      }
      if (afterSeq !== undefined) {
        sql += ' AND event.seq > ?';
        params.push(afterSeq);
      }
      sql += ' ORDER BY event.seq ASC LIMIT ?';
      params.push(limit + 1);
      const rows = await executor.all<AuditRow & { chain_id: string; epoch: number }>({
        sql,
        params,
      });
      const page = rows.slice(0, limit);
      const items = await Promise.all(
        page.map(async (row) => {
          const item = await auditWireRecord(
            { chainId: row.chain_id, epoch: row.epoch, orgId },
            row,
            'include',
          );
          if (item.kind === 'withheld' && item.reasonCode === 'unreadable') {
            observability.counter('pb.audit.journal_unreadable');
          }
          return item;
        }),
      );
      return { items, next: rows.length > limit ? page.at(-1)!.seq : null };
    },
  });
}
