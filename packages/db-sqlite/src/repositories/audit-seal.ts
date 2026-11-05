import { auditCapacityStateStatement } from './audit-capacity-state.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { hashRow, type AuditRow } from '@package-broker/core/audit/chain';

import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { ulid } from '@package-broker/core/ids';
import { auditLedgerError, createAuditLedgerRepository } from './audit-ledger.js';
import {
  AuditSealInterruptedError,
  type AuditIntegrityReason,
  type SealOutcome,
} from '@package-broker/core/audit/sealer';
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
  integrity_incidents: number;
  policy: 'availability' | 'required';
  head_seq: number;
  head_hash: string;
  boundary_reason: string | null;
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
const PENDING_COLUMNS =
  'id, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json';
const PENDING_SQL = `SELECT ${PENDING_COLUMNS} FROM audit_pending WHERE org_id = ? ORDER BY id LIMIT ?`;
const INSERT_SQL =
  'INSERT INTO audit_event (id, org_id, seq, prev_hash, hash, created_at, actor_type, actor_id, token_selector, source_ip, action, target_type, target_id, project_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const DELETE_SQL = `DELETE FROM audit_pending WHERE org_id = ?
  AND audit_pending.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
  AND EXISTS (SELECT 1 FROM json_each(?) snapshot WHERE ${EVENT_COLUMNS.filter(
    (key) => !['org_id', 'seq', 'prev_hash', 'hash'].includes(key),
  )
    .map((key) => `audit_pending.${key} IS json_extract(snapshot.value, '$.${key}')`)
    .join(' AND ')})`;

type ChainState = Pick<
  Head,
  | 'head_seq'
  | 'head_hash'
  | 'boundary_seq'
  | 'boundary_prev_hash'
  | 'boundary_reason'
  | 'journal_rows'
  | 'journal_bytes'
>;
type SeqRange = { readonly from_seq: number; readonly to_seq: number };
/** A capacity gap carries the hash of its last evicted row; a seq_gap has none. */
type GapTop = { readonly top: number; readonly hash: string | null };

const HOLES_SQL = `WITH covered AS (
    SELECT seq AS lo, seq AS hi FROM audit_event WHERE org_id = ? AND seq BETWEEN ? AND ?
    UNION ALL SELECT max(from_seq, ?), min(to_seq, ?) FROM audit_ledger
      WHERE org_id = ? AND chain_id = ? AND epoch = ? AND reason_code = 'seq_gap'
      AND sink_id IS NULL AND kind = 'gap' AND superseded_by IS NULL
      AND from_seq <= ? AND to_seq >= ?
    UNION ALL SELECT ?, ? UNION ALL SELECT ?, ?
  ), frontiers AS (
    SELECT lo, max(hi) OVER (ORDER BY lo, hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_seq
    FROM covered
  ) SELECT previous_seq + 1 AS from_seq, lo - 1 AS to_seq FROM frontiers
    WHERE lo > previous_seq + 1 ORDER BY lo LIMIT ?`;
const GAP_FENCE = ` AND NOT EXISTS (SELECT 1 FROM audit_ledger g JOIN json_each(?) ranges
  ON g.from_seq <= json_extract(ranges.value, '$[1]') AND g.to_seq >= json_extract(ranges.value, '$[0]')
  WHERE g.org_id = ? AND g.chain_id = ? AND g.epoch = ? AND g.kind = 'gap'
  AND g.sink_id IS NULL AND g.reason_code = 'seq_gap' AND g.superseded_by IS NULL)`;
/** Recorded seq holes and capacity evictions both consume their seqs; neither is allocated again. */
const GAP_ABOVE_SQL = `FROM audit_ledger t
  WHERE t.org_id = ? AND t.chain_id = ? AND t.epoch = ? AND t.reason_code IN ('seq_gap', 'capacity')
  AND t.sink_id IS NULL AND t.kind = 'gap' AND t.superseded_by IS NULL`;
const GAP_ABOVE_FENCE = ` AND NOT EXISTS (SELECT 1 ${GAP_ABOVE_SQL} AND t.to_seq > ?)`;
/** 97 gaps, a reset, the CAS and assertion, and the capacity update fit within 200 statements. */
const GAPS_PER_BATCH = 97;
const PENDING_ATTEMPTS = 3;

/**
 * With `countIncident`, the update also counts an integrity incident. The counter must still hold
 * the value this sealer read, so of the sealers that observed one change only the first records it.
 */
function compareAndSet(
  ctx: OrgContext,
  head: Head,
  next: ChainState = head,
  fence?: Statement,
  countIncident = false,
): Statement {
  return {
    sql: `UPDATE audit_chain SET head_seq = ?, head_hash = ?, boundary_seq = ?, boundary_prev_hash = ?,
      boundary_reason = ?, journal_rows = ?, journal_bytes = ?${
        countIncident ? ', integrity_incidents = integrity_incidents + 1' : ''
      }
      WHERE org_id = ? AND head_seq = ? AND head_hash = ? AND boundary_seq = ?
      AND boundary_prev_hash = ? AND boundary_reason IS ? AND chain_id = ? AND epoch = ?
      AND incarnation = ? AND mode_generation = ? AND policy = ? AND restore_pending = 0
      AND journal_rows = ? AND journal_bytes = ?
      AND integrity_incidents = ?
      AND (SELECT seq FROM (${NEWEST_SQL})) IS ?
      AND (SELECT hash FROM (${NEWEST_SQL})) IS ?${fence?.sql ?? ''}`,
    params: [
      next.head_seq,
      next.head_hash,
      next.boundary_seq,
      next.boundary_prev_hash,
      next.boundary_reason,
      next.journal_rows,
      next.journal_bytes,
      ctx.orgId,
      head.head_seq,
      head.head_hash,
      head.boundary_seq,
      head.boundary_prev_hash,
      head.boundary_reason,
      head.chain_id,
      head.epoch,
      head.incarnation,
      head.mode_generation,
      head.policy,
      head.journal_rows,
      head.journal_bytes,
      head.integrity_incidents,
      ctx.orgId,
      head.last_seq,
      ctx.orgId,
      head.last_hash,
      ...(fence?.params ?? []),
    ],
  };
}

function readHead(executor: SqlExecutor, ctx: OrgContext): Promise<Head[]> {
  return executor.all<Head>({ sql: HEAD_SQL, params: Array(6).fill(ctx.orgId) });
}

interface GapCoverage {
  total: number;
  leading: number;
  trailing: number;
}
async function readCoverage(
  executor: SqlExecutor,
  ctx: OrgContext,
  head: Head,
): Promise<GapCoverage> {
  const [row] = await executor.all<GapCoverage>({
    sql: `SELECT coalesce(sum(max(0, min(to_seq, ?) - max(from_seq, ?) + 1)), 0) AS total,
      coalesce(sum(max(0, min(to_seq, ?) - max(from_seq, ?) + 1)), 0) AS leading,
      coalesce(sum(max(0, min(to_seq, ?) - max(from_seq, ?) + 1)), 0) AS trailing
      FROM audit_ledger WHERE org_id = ? AND chain_id = ? AND epoch = ?
      AND reason_code = 'seq_gap' AND sink_id IS NULL AND kind = 'gap' AND superseded_by IS NULL`,
    params: [
      head.head_seq,
      head.boundary_seq,
      (head.first_seq ?? head.boundary_seq) - 1,
      head.boundary_seq,
      head.head_seq,
      (head.last_seq ?? head.head_seq) + 1,
      ctx.orgId,
      head.chain_id,
      head.epoch,
    ],
  });
  return row ?? { total: 0, leading: 0, trailing: 0 };
}

/**
 * Every seq in [boundary_seq, head_seq] is a journal row or inside a recorded seq_gap, the
 * endpoints match the stored hashes and the counters match. Interior rows deleted without the
 * row counter changing are the verifier's to find.
 */
function consistent(head: Head, gaps: GapCoverage): boolean {
  const { head_seq: top, boundary_seq: boundary } = head;
  if (boundary > top + 1) return false;
  if (boundary === top + 1 && head.boundary_prev_hash !== head.head_hash) return false;
  const missing = gaps.total;
  if (head.last_seq === null || head.first_seq === null)
    return missing === top - boundary + 1 && head.journal_rows === 0 && head.journal_bytes === 0;
  return (
    head.first_seq >= boundary &&
    (head.first_seq > boundary || head.first_prev_hash === head.boundary_prev_hash) &&
    gaps.leading === head.first_seq - boundary &&
    head.last_seq <= top &&
    (head.last_seq < top || head.anchor_hash === head.head_hash) &&
    gaps.trailing === top - head.last_seq &&
    head.journal_rows === top - boundary + 1 - missing &&
    head.journal_bytes > 0
  );
}

/**
 * The chain the journal supports. The head never moves below its stored seq or below a recorded
 * gap, so no recorded seq is ever allocated again.
 */
function target(
  head: Head,
  gapTop: GapTop | null,
): {
  next: Omit<ChainState, 'journal_rows' | 'journal_bytes'>;
  reasons: AuditIntegrityReason[];
} {
  const reasons: AuditIntegrityReason[] = [];
  let headSeq = head.head_seq;
  let headHash = head.head_hash;
  if (head.last_seq !== null && head.last_hash !== null && head.last_seq >= head.head_seq) {
    const anchored =
      head.head_seq >= (head.first_seq ?? head.boundary_seq)
        ? head.anchor_hash === head.head_hash
        : head.head_seq === head.boundary_seq - 1 && head.head_hash === head.boundary_prev_hash;
    if (!anchored) reasons.push('head_mismatch');
    headSeq = head.last_seq;
    headHash = head.last_hash;
  }
  if (gapTop !== null && gapTop.top > headSeq) {
    if (!reasons.includes('head_mismatch')) reasons.push('head_mismatch');
    headSeq = gapTop.top;
    if (gapTop.hash !== null) headHash = gapTop.hash;
  }
  let boundarySeq = head.boundary_seq;
  let boundaryHash = head.boundary_prev_hash;
  if (head.first_seq === null || head.first_prev_hash === null) {
    if (boundarySeq > headSeq + 1) boundarySeq = headSeq + 1;
    if (boundarySeq === headSeq + 1) boundaryHash = headHash;
  } else if (head.first_seq <= boundarySeq) {
    boundarySeq = head.first_seq;
    boundaryHash = head.first_prev_hash;
  }
  const rebased = boundarySeq !== head.boundary_seq || boundaryHash !== head.boundary_prev_hash;
  if (rebased) reasons.push('boundary_mismatch');
  return {
    next: {
      head_seq: headSeq,
      head_hash: headHash,
      boundary_seq: boundarySeq,
      boundary_prev_hash: boundaryHash,
      boundary_reason: rebased ? 'chain_reset' : head.boundary_reason,
    },
    reasons,
  };
}

function ledgerEntry(
  id: string,
  head: Head,
  kind: 'gap' | 'chain_reset',
  fromSeq: number,
  toSeq: number,
): AuditLedgerEntry {
  return {
    id,
    kind,
    chainId: head.chain_id,
    epoch: head.epoch,
    fromSeq,
    toSeq,
    count: kind === 'gap' ? toSeq - fromSeq + 1 : 0,
    sinkId: null,
    reasonCode: kind === 'gap' ? 'seq_gap' : 'tamper_detected',
    policy: head.policy,
    modeGeneration: head.mode_generation,
    actorType: 'system',
    actorId: null,
    createdAt: new Date().toISOString(),
  };
}

function sameHead(a: Head, b: Head): boolean {
  return Object.keys(a).every((key) => a[key as keyof Head] === b[key as keyof Head]);
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

export interface AuditSealOptions {
  readonly maxJournalBytes?: number;
  readonly signal?: AbortSignal;
  /** Ledger id generator; ids must be ULIDs. */
  readonly ids?: () => string;
}

export function createAuditSealRepository(
  executor: SqlExecutor,
  options: AuditSealOptions = {},
): AuditSealRepository {
  if (
    options.maxJournalBytes !== undefined &&
    (!Number.isSafeInteger(options.maxJournalBytes) || options.maxJournalBytes < 1)
  )
    throw new TypeError('Invalid audit capacity budget');
  const ledger = createAuditLedgerRepository(executor);
  const ids = options.ids ?? (() => ulid());

  async function submit(ctx: OrgContext, statements: readonly Statement[]): Promise<boolean> {
    if (options.signal?.aborted) return false;
    try {
      await executor.batch([
        ...statements,
        ...(options.maxJournalBytes === undefined
          ? []
          : [auditCapacityStateStatement(ctx, options.maxJournalBytes)]),
      ]);
      return true;
    } catch (error) {
      if (isChainConflict(error)) return false;
      throw auditLedgerError(error);
    }
  }

  async function gapTop(ctx: OrgContext, head: Head): Promise<GapTop | null> {
    const [row] = await executor.all<{ top: number; hash: string | null }>({
      sql: `SELECT t.to_seq AS top, CASE WHEN t.reason_code = 'capacity'
          THEN json_extract(t.capacity_json, '$.hash') END AS hash ${GAP_ABOVE_SQL}
        ORDER BY t.to_seq DESC, t.reason_code = 'capacity' DESC LIMIT 1`,
      params: [ctx.orgId, head.chain_id, head.epoch],
    });
    return row ?? null;
  }

  /**
   * Brings the chain row in line with the journal. The reset and the head or boundary rewrite
   * share the first batch; the remaining gaps follow in later batches fenced on the rewritten
   * state, so an interrupted recovery resumes with gaps only. Ids are minted right before each
   * batch, the reset first, so one recovery's ids follow its commit order. Reasons are added to
   * `committed` as soon as their evidence is durable. Returns null when the chain moved.
   */
  async function recover(
    ctx: OrgContext,
    head: Head,
    committed: AuditIntegrityReason[],
    top?: GapTop | null,
  ): Promise<{ head: Head; repaired: boolean; continuation?: true } | null> {
    const [summary] = await executor.all<{ actual_rows: number; actual_bytes: number }>({
      sql: SUMMARY_SQL,
      params: [ctx.orgId],
    });
    if (summary === undefined) throw new Error('audit journal summary is missing');
    const { next, reasons } = target(head, top === undefined ? await gapTop(ctx, head) : top);
    if (options.signal?.aborted) return { head, repaired: false, continuation: true };
    const holes = await executor.all<SeqRange>({
      sql: HOLES_SQL,
      params: [
        ctx.orgId,
        next.boundary_seq,
        next.head_seq,
        next.boundary_seq,
        next.head_seq,
        ctx.orgId,
        head.chain_id,
        head.epoch,
        next.head_seq,
        next.boundary_seq,
        next.boundary_seq - 1,
        next.boundary_seq - 1,
        next.head_seq + 1,
        next.head_seq + 1,
        GAPS_PER_BATCH + 1,
      ],
    });
    const more = holes.length > GAPS_PER_BATCH;
    const missing = holes.slice(0, GAPS_PER_BATCH);
    const state: ChainState = {
      ...next,
      journal_rows: summary.actual_rows,
      journal_bytes: summary.actual_bytes,
    };
    if (
      reasons.length === 0 &&
      missing.length === 0 &&
      (Object.keys(state) as (keyof ChainState)[]).every((key) => state[key] === head[key])
    )
      return { head, repaired: false };
    if (missing.length > 0) reasons.push('seq_gap');
    const reset = reasons.some((reason) => reason !== 'seq_gap');
    const recovered: Head = {
      ...head,
      ...state,
      anchor_hash: state.head_seq === head.last_seq ? head.last_hash : null,
    };
    for (let i = 0; i === 0 || i < missing.length; i += GAPS_PER_BATCH) {
      if (options.signal?.aborted) return { head, repaired: false, continuation: true };
      const chunk = missing.slice(i, i + GAPS_PER_BATCH);
      const entries = [
        ...(i === 0 && reset
          ? [
              ledgerEntry(
                ids(),
                head,
                'chain_reset',
                Math.max(1, next.boundary_seq),
                Math.max(1, next.boundary_seq, next.head_seq),
              ),
            ]
          : []),
        ...chunk.map((range) => ledgerEntry(ids(), head, 'gap', range.from_seq, range.to_seq)),
      ];
      const fence: Statement | undefined =
        chunk.length === 0
          ? undefined
          : {
              sql: GAP_FENCE,
              params: [
                JSON.stringify(chunk.map((range) => [range.from_seq, range.to_seq])),
                ctx.orgId,
                head.chain_id,
                head.epoch,
              ],
            };
      if (
        !(await submit(ctx, [
          compareAndSet(ctx, i === 0 ? head : recovered, state, fence),
          ...assertCheck(sql`changes() = 1`),
          ...ledger.statements(ctx, entries),
        ]))
      )
        return null;
      if (i === 0) committed.push(...reasons);
    }
    return { head: recovered, repaired: true, ...(more ? { continuation: true } : {}) };
  }

  /**
   * Records a pending row changed in place and returns the head with the committed incident
   * count. Null when another sealer counted an incident since this one read the chain: this
   * sealer then records nothing, and its next pass starts from the fresh count and pending rows.
   */
  async function recordPendingReset(
    ctx: OrgContext,
    head: Head,
    pending: number,
  ): Promise<Head | null> {
    const recorded = await submit(ctx, [
      compareAndSet(ctx, head, head, undefined, true),
      ...assertCheck(sql`changes() = 1`),
      ...ledger.statements(ctx, [
        ledgerEntry(ids(), head, 'chain_reset', head.head_seq + 1, head.head_seq + pending),
      ]),
    ]);
    return recorded ? { ...head, integrity_incidents: head.integrity_incidents + 1 } : null;
  }

  async function modifiedInPlace(
    ctx: OrgContext,
    pending: readonly PendingRow[],
  ): Promise<boolean> {
    const snapshot = await executor.all<PendingRow>({
      sql: `SELECT ${PENDING_COLUMNS} FROM audit_pending WHERE org_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
      params: [ctx.orgId, JSON.stringify(pending)],
    });
    return snapshot.some((row) => {
      const original = pending.find((candidate) => candidate.id === row.id);
      return (
        original !== undefined &&
        Object.keys(original).some(
          (key) => row[key as keyof PendingRow] !== original[key as keyof PendingRow],
        )
      );
    });
  }

  async function sealOnce(
    ctx: OrgContext,
    limit: number,
    committed: AuditIntegrityReason[],
  ): Promise<SealOutcome> {
    if (options.signal?.aborted) return { outcome: 'recovering' };
    const orgId = ctx.orgId;
    const [read] = await readHead(executor, ctx);
    if (read === undefined) throw new Error('audit chain is missing');
    if (read.restore_pending !== 0) return { outcome: 'restore_pending' };
    let head: Head = read;
    let repaired = false;
    const extra = () => ({
      ...(repaired ? { repaired: true as const } : {}),
      ...(committed.length > 0 ? { integrity: [...committed] } : {}),
    });
    if (
      !consistent(head, { total: 0, leading: 0, trailing: 0 }) &&
      !consistent(head, await readCoverage(executor, ctx, head))
    ) {
      const recovery = await recover(ctx, head, committed);
      if (recovery === null) return { outcome: 'contended', ...extra() };
      head = recovery.head;
      repaired = recovery.repaired;
      if (recovery.continuation) return { outcome: 'recovering', ...extra() };
    }

    for (let attempt = 0; attempt < PENDING_ATTEMPTS; attempt += 1) {
      const pending = await executor.all<PendingRow>({
        sql: PENDING_SQL,
        params: [orgId, limit],
      });
      if (pending.length === 0) {
        if (options.maxJournalBytes !== undefined) await submit(ctx, []);
        return { outcome: 'empty', ...extra() };
      }

      const statements: Statement[] = [
        compareAndSet(ctx, head, head, {
          sql: GAP_ABOVE_FENCE,
          params: [orgId, head.chain_id, head.epoch, head.head_seq],
        }),
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

      if (await submit(ctx, statements))
        return {
          outcome: 'sealed',
          sealed: pending.length,
          headSeq: seq,
          headHash: prevHash,
          ...extra(),
        };
      const [current] = await readHead(executor, ctx);
      if (current === undefined || !sameHead(current, head))
        return { outcome: 'contended', ...extra() };
      const top = await gapTop(ctx, head);
      if (top !== null && top.top > head.head_seq) {
        const recovery = await recover(ctx, head, committed, top);
        if (recovery === null) return { outcome: 'contended', ...extra() };
        head = recovery.head;
        repaired ||= recovery.repaired;
        if (recovery.continuation) return { outcome: 'recovering', ...extra() };
        continue;
      }
      const counted: Head | null = (await modifiedInPlace(ctx, pending))
        ? await recordPendingReset(ctx, head, pending.length)
        : null;
      if (counted === null) return { outcome: 'contended', ...extra() };
      head = counted;
      committed.push('head_mismatch');
    }
    return { outcome: 'contended', ...extra() };
  }

  async function seal(ctx: OrgContext, limit = AUDIT_SEAL_MAX_LIMIT): Promise<SealOutcome> {
    assertLimit(limit);
    const committed: AuditIntegrityReason[] = [];
    try {
      return await sealOnce(ctx, limit, committed);
    } catch (error) {
      if (committed.length > 0) throw new AuditSealInterruptedError(committed, { cause: error });
      throw error;
    }
  }

  return {
    async pendingOldestAgeSeconds(ctx) {
      const [row] = await executor.all<{ age: number }>({
        sql: `SELECT coalesce(max(0, (julianday('now') - julianday(min(created_at))) * 86400), 0) AS age FROM audit_pending WHERE org_id = ?`,
        params: [ctx.orgId],
      });
      return row?.age ?? 0;
    },
    seal: (ctx, limit) => seal(ctx, limit),
  };
}
