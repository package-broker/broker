import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { AUDIT_GENESIS_HASH, hashRow, type AuditRow } from '@package-broker/core/audit/chain';

export const AUDIT_SEAL_MAX_LIMIT = 100;

export type SealOutcome =
  | {
      readonly outcome: 'sealed';
      readonly sealed: number;
      readonly headSeq: number;
      readonly headHash: string;
    }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'contended' };

export interface AuditSealRepository {
  seal(ctx: OrgContext, limit?: number): Promise<SealOutcome>;
}

type PendingRow = Omit<AuditRow, 'org_id' | 'seq' | 'prev_hash' | 'hash'>;

const HEAD_SQL = 'SELECT seq, hash FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1';
const PENDING_SQL =
  'SELECT id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json FROM audit_pending WHERE org_id = ? ORDER BY id LIMIT ?';
const INSERT_SQL =
  'INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const DELETE_SQL =
  'DELETE FROM audit_pending WHERE org_id = ? AND id IN (SELECT id FROM audit_event WHERE org_id = ? AND seq BETWEEN ? AND ?)';

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_SEAL_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${AUDIT_SEAL_MAX_LIMIT}`);
  }
}

function isChainConflict(error: unknown): boolean {
  return (
    error instanceof DbError &&
    error.kind === 'unique' &&
    (error.constraint ?? '').startsWith('audit_event.')
  );
}

async function readHead(
  executor: SqlExecutor,
  orgId: string,
): Promise<{ seq: number; hash: string }> {
  const [head] = await executor.all<{ seq: number; hash: string }>({
    sql: HEAD_SQL,
    params: [orgId],
  });
  if (head === undefined) return { seq: 0, hash: AUDIT_GENESIS_HASH };
  if (!Number.isSafeInteger(head.seq) || typeof head.hash !== 'string') {
    throw new TypeError('audit head row is malformed');
  }
  return head;
}

function insertStatement(row: AuditRow): Statement {
  return {
    sql: INSERT_SQL,
    params: [
      row.id,
      row.org_id,
      row.seq,
      row.prev_hash,
      row.hash,
      row.created_at,
      row.actor_type,
      row.actor_id,
      row.token_selector,
      row.source_ip,
      row.action,
      row.target_type,
      row.target_id,
      row.project_id,
      row.payload_json,
    ],
  };
}

export function createAuditSealRepository(executor: SqlExecutor): AuditSealRepository {
  return {
    async seal(ctx, limit = AUDIT_SEAL_MAX_LIMIT) {
      assertLimit(limit);
      const orgId = ctx.orgId;
      const head = await readHead(executor, orgId);
      const pending = await executor.all<PendingRow>({ sql: PENDING_SQL, params: [orgId, limit] });
      if (pending.length === 0) return { outcome: 'empty' };

      const statements: Statement[] = [];
      let seq = head.seq;
      let prevHash = head.hash;
      for (const row of pending) {
        seq += 1;
        const unsealed: AuditRow = { ...row, org_id: orgId, seq, prev_hash: prevHash, hash: '' };
        const hash = await hashRow(prevHash, unsealed);
        statements.push(insertStatement({ ...unsealed, hash }));
        prevHash = hash;
      }

      statements.push({ sql: DELETE_SQL, params: [orgId, orgId, head.seq + 1, seq] });

      try {
        await executor.batch(statements);
      } catch (error) {
        if (isChainConflict(error)) return { outcome: 'contended' };
        throw error;
      }
      return { outcome: 'sealed', sealed: pending.length, headSeq: seq, headHash: prevHash };
    },
  };
}
