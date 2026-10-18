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
}

export interface AuditQueryRepository {
  list(ctx: OrgContext, query: AuditQuery): Promise<{ items: AuditRow[]; next: string | null }>;
  head(ctx: OrgContext): Promise<AuditHead | null>;
}

const COLUMNS =
  'id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json';
const HEAD_SQL =
  'SELECT head.seq, head.hash, pending.pending FROM (SELECT count(*) AS pending FROM audit_pending WHERE org_id = ?) AS pending LEFT JOIN (SELECT seq, hash FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1) AS head ON 1 = 1';

export function createAuditQueryRepository(executor: ScalarSqlExecutor): AuditQueryRepository {
  return {
    async list(ctx, query) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
        throw new RangeError('limit must be an integer from 1 to 200');
      }
      let sql = `SELECT ${COLUMNS} FROM audit_event WHERE org_id = ?`;
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
      }>({ sql: HEAD_SQL, params: [ctx.orgId, ctx.orgId] });
      if (row === undefined || (row.seq === null && row.pending === 0)) return null;
      return {
        seq: row.seq ?? 0,
        hash: row.hash ?? AUDIT_GENESIS_HASH,
        pending: row.pending,
      };
    },
  };
}
