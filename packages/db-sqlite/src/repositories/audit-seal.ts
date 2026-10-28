import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { hashRow, type AuditRow } from '@package-broker/core/audit/chain';

import { AuditIntegrityError, type SealOutcome } from '@package-broker/core/audit/sealer';
export type { SealOutcome } from '@package-broker/core/audit/sealer';

export const AUDIT_SEAL_MAX_LIMIT = 100;

export interface AuditSealRepository {
  seal(ctx: OrgContext, limit?: number): Promise<SealOutcome>;
  pendingOldestAgeSeconds(ctx: OrgContext): Promise<number>;
}

type PendingRow = Omit<AuditRow, 'org_id' | 'seq' | 'prev_hash' | 'hash'>;

const EVENT_COLUMNS = [
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
const EVENT_BYTES = `length(CAST(json_object(${EVENT_COLUMNS.map((key) => `'${key}', e.${key}`).join(', ')}) AS BLOB))`;
const NEWEST_SQL = 'SELECT seq, hash FROM audit_event WHERE org_id = ? ORDER BY seq DESC LIMIT 1';
const HEAD_SQL = `SELECT c.*,
  (SELECT seq FROM (${NEWEST_SQL})) AS last_seq,
  (SELECT hash FROM (${NEWEST_SQL})) AS last_hash,
  (SELECT seq FROM audit_event WHERE org_id = ? ORDER BY seq LIMIT 1) AS first_seq,
  (SELECT prev_hash FROM audit_event WHERE org_id = ? ORDER BY seq LIMIT 1) AS first_prev_hash,
  (SELECT hash FROM audit_event WHERE org_id = ? AND seq = c.head_seq) AS anchor_hash
  FROM audit_chain c WHERE c.org_id = ?`;
const SUMMARY_SQL = `SELECT count(*) AS actual_rows, coalesce(sum(${EVENT_BYTES}), 0) AS actual_bytes
  FROM audit_event e WHERE e.org_id = ?`;
type Head = {
  restore_pending: number;
  head_seq: number;
  head_hash: string;
  boundary_seq: number;
  boundary_prev_hash: string;
  chain_id: string;
  epoch: number;
  incarnation: number;
  mode_generation: number;
  journal_rows: number;
  journal_bytes: number;
  first_seq: number | null;
  first_prev_hash: string | null;
  anchor_hash: string | null;
  last_seq: number | null;
  last_hash: string | null;
};
const PENDING_SQL =
  'SELECT id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json FROM audit_pending WHERE org_id = ? ORDER BY id LIMIT ?';
const INSERT_SQL =
  'INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const DELETE_SQL = `DELETE FROM audit_pending WHERE org_id = ?
  AND audit_pending.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
  AND EXISTS (SELECT 1 FROM json_each(?) snapshot WHERE ${EVENT_COLUMNS.filter(
    (key) => !['org_id', 'seq', 'prev_hash', 'hash'].includes(key),
  )
    .map((key) => `audit_pending.${key} IS json_extract(snapshot.value, '$.${key}')`)
    .join(' AND ')})`;

function unchanged(
  ctx: OrgContext,
  head: Head,
  rows = head.journal_rows,
  bytes = head.journal_bytes,
): Statement {
  return {
    sql: `UPDATE audit_chain SET head_seq = ?, head_hash = ?, journal_rows = ?, journal_bytes = ?
      WHERE org_id = ? AND head_seq = ? AND head_hash = ? AND boundary_seq = ?
      AND boundary_prev_hash = ? AND chain_id = ? AND epoch = ? AND incarnation = ?
      AND mode_generation = ? AND restore_pending = ? AND journal_rows = ? AND journal_bytes = ?
      AND (SELECT seq FROM (${NEWEST_SQL})) IS ?
      AND (SELECT hash FROM (${NEWEST_SQL})) IS ?`,
    params: [
      head.last_seq ?? head.head_seq,
      head.last_hash ?? head.head_hash,
      rows,
      bytes,
      ctx.orgId,
      head.head_seq,
      head.head_hash,
      head.boundary_seq,
      head.boundary_prev_hash,
      head.chain_id,
      head.epoch,
      head.incarnation,
      head.mode_generation,
      head.restore_pending,
      head.journal_rows,
      head.journal_bytes,
      ctx.orgId,
      head.last_seq,
      ctx.orgId,
      head.last_hash,
    ],
  };
}

function readHead(executor: SqlExecutor, ctx: OrgContext): Promise<Head[]> {
  return executor.all<Head>({ sql: HEAD_SQL, params: Array(6).fill(ctx.orgId) });
}

function validateHead(head: Head): void {
  if (head.last_seq === null) {
    if (head.boundary_seq !== head.head_seq + 1) throw new AuditIntegrityError('seq_gap');
    if (head.boundary_prev_hash !== head.head_hash)
      throw new AuditIntegrityError('boundary_mismatch');
    return;
  }
  if (head.first_seq !== head.boundary_seq) throw new AuditIntegrityError('seq_gap');
  if (head.first_prev_hash !== head.boundary_prev_hash)
    throw new AuditIntegrityError('boundary_mismatch');
  if (head.last_seq < head.head_seq) throw new AuditIntegrityError('head_mismatch');
  if (head.head_seq < head.boundary_seq) {
    if (head.head_seq !== head.boundary_seq - 1 || head.head_hash !== head.boundary_prev_hash) {
      throw new AuditIntegrityError('head_mismatch');
    }
  } else if (head.anchor_hash !== head.head_hash) {
    throw new AuditIntegrityError('head_mismatch');
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_SEAL_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${AUDIT_SEAL_MAX_LIMIT}`);
  }
}

function isChainConflict(error: unknown): boolean {
  return (
    error instanceof DbError &&
    error.kind === 'unique' &&
    ((error.constraint ?? '').startsWith('audit_event.') ||
      error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT)
  );
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
    async pendingOldestAgeSeconds(ctx) {
      const [row] = await executor.all<{ age: number }>({
        sql: `SELECT coalesce(max(0, (julianday('now') - julianday(min(created_at))) * 86400), 0) AS age FROM audit_pending WHERE org_id = ?`,
        params: [ctx.orgId],
      });
      return row?.age ?? 0;
    },
    async seal(ctx, limit = AUDIT_SEAL_MAX_LIMIT) {
      assertLimit(limit);
      const orgId = ctx.orgId;
      try {
        const [head] = await readHead(executor, ctx);
        if (head === undefined) throw new AuditIntegrityError('head_mismatch');
        validateHead(head);
        if (head.restore_pending === 1) throw new AuditIntegrityError('head_mismatch');
        let repaired = false;
        const expectedRows = head.last_seq === null ? 0 : head.last_seq - head.boundary_seq + 1;
        if (
          (head.last_seq !== null && head.last_seq > head.head_seq) ||
          expectedRows !== head.journal_rows ||
          (expectedRows === 0 ? head.journal_bytes !== 0 : head.journal_bytes === 0)
        ) {
          const [summary] = await executor.all<{ actual_rows: number; actual_bytes: number }>({
            sql: SUMMARY_SQL,
            params: [orgId],
          });
          if (summary === undefined || summary.actual_rows !== expectedRows) {
            const [current] = await readHead(executor, ctx);
            if (
              current === undefined ||
              Object.keys(head).some(
                (key) => current[key as keyof Head] !== head[key as keyof Head],
              )
            )
              return { outcome: 'contended' };
            throw new AuditIntegrityError('seq_gap');
          }
          try {
            await executor.batch([
              unchanged(ctx, head, summary.actual_rows, summary.actual_bytes),
              ...assertCheck(sql`changes() = 1`),
            ]);
          } catch (error) {
            if (isChainConflict(error)) return { outcome: 'contended' };
            throw error;
          }
          head.head_seq = head.last_seq ?? head.head_seq;
          head.head_hash = head.last_hash ?? head.head_hash;
          head.anchor_hash = head.last_hash;
          head.journal_rows = summary.actual_rows;
          head.journal_bytes = summary.actual_bytes;
          repaired = true;
        }
        const repair = repaired ? { repaired: true as const } : {};
        const pending = await executor.all<PendingRow>({
          sql: PENDING_SQL,
          params: [orgId, limit],
        });
        if (pending.length === 0) return { outcome: 'empty', ...repair };

        const statements: Statement[] = [
          unchanged(ctx, head),
          ...assertCheck(sql`changes() = 1`),
          { sql: DELETE_SQL, params: [orgId, JSON.stringify(pending), JSON.stringify(pending)] },
          ...assertCheck(sql`changes() = ${pending.length}`),
        ];
        let seq = head.head_seq;
        let prevHash = head.head_hash;
        for (const row of pending) {
          seq += 1;
          const unsealed: AuditRow = { ...row, org_id: orgId, seq, prev_hash: prevHash, hash: '' };
          const hash = await hashRow(prevHash, unsealed);
          statements.push(insertStatement({ ...unsealed, hash }));
          prevHash = hash;
        }

        statements.push({
          sql: `UPDATE audit_chain SET head_seq = ?, head_hash = ?, journal_rows = journal_rows + ?,
          journal_bytes = journal_bytes + (SELECT coalesce(sum(${EVENT_BYTES}), 0) FROM audit_event e
            WHERE e.org_id = ? AND e.seq BETWEEN ? AND ?) WHERE org_id = ?`,
          params: [seq, prevHash, pending.length, orgId, head.head_seq + 1, seq, orgId],
        });

        try {
          await executor.batch(statements);
        } catch (error) {
          if (isChainConflict(error)) {
            const [current] = await readHead(executor, ctx);
            if (
              current !== undefined &&
              Object.keys(head).every(
                (key) => current[key as keyof Head] === head[key as keyof Head],
              )
            ) {
              const snapshot = await executor.all<PendingRow>({
                sql: `SELECT id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json
                FROM audit_pending WHERE org_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
                params: [orgId, JSON.stringify(pending)],
              });
              if (
                snapshot.some((row) => {
                  const original = pending.find((candidate) => candidate.id === row.id);
                  return (
                    original !== undefined &&
                    Object.keys(original).some(
                      (key) => row[key as keyof PendingRow] !== original[key as keyof PendingRow],
                    )
                  );
                })
              )
                throw new AuditIntegrityError('head_mismatch');
            }
            return { outcome: 'contended', ...repair };
          }
          throw error;
        }
        return {
          outcome: 'sealed',
          sealed: pending.length,
          headSeq: seq,
          headHash: prevHash,
          ...repair,
        };
      } catch (error) {
        if (error instanceof AuditIntegrityError) {
          await executor.batch([
            { sql: 'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?', params: [orgId] },
          ]);
        }
        throw error;
      }
    },
  };
}
