import {
  auditCapacityReserveBytes,
  evictAudit,
  type AuditCapacityOptions,
  type AuditCapacityPort,
} from '@package-broker/core/audit/capacity';
import { ulid } from '@package-broker/core/ids';
import { AUDIT_VERIFIED_EXPORT } from '@package-broker/core/audit/ledger';
import type {
  AuditPruneOptions,
  AuditPruneOutcome,
  AuditPrunePort,
} from '@package-broker/core/audit/prune';
import { pruneAudit } from '@package-broker/core/audit/prune';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { noopObservability, type Observability } from '@package-broker/core/platform/observability';
import { assertCheck } from '../kysely.js';
import { auditLedgerError, createAuditLedgerRepository } from './audit-ledger.js';
import { clearAuditVerificationStatements } from './audit-verify.js';

const columns = [
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
const rowJson = `json_object(${columns.map((key) => `'${key}', e.${key}`).join(', ')})`;
const chainFields = [
  'chain_id',
  'epoch',
  'incarnation',
  'mode_generation',
  'integrity_incidents',
  'boundary_seq',
  'boundary_prev_hash',
] as const;

type Chain = {
  chain_id: string;
  epoch: number;
  incarnation: number;
  mode_generation: number;
  integrity_incidents: number;
  boundary_seq: number;
  boundary_prev_hash: string;
  head_seq: number;
  head_hash: string;
  journal_rows: number;
  journal_bytes: number;
};
type Candidate = { seq: number; hash: string; bytes: number; row_json: string };

function snapshotChunks(rows: readonly Candidate[]): readonly (readonly Candidate[])[] {
  const chunks: Candidate[][] = [];
  let chunk: Candidate[] = [];
  let bytes = 2;
  for (const row of rows) {
    if (bytes + row.bytes + 1 > 256 * 1024 && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(row);
    bytes += row.bytes + 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Evaluated both when choosing a prefix and inside the boundary CAS. */
function eligible(ctx: OrgContext, options: AuditPruneOptions, through: number): Statement {
  return {
    sql: `c.restore_pending = 0 AND coalesce(c.pending_mode, c.mode) IN ('export', 'none')
      AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.generation > ?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) configured WHERE NOT EXISTS (
        SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.sink_id = configured.value))
      AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ?
        AND s.state NOT IN ('inactive', 'retired') AND s.progress_seq < ?)
      AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ?
        AND s.state NOT IN ('inactive', 'retired') AND s.inflight_from <= ?
        AND coalesce(json_extract(s.inflight_repr, '$.purpose'), '') NOT IN ('marker', 'registry_markers', 'capacity'))
      AND (
        (coalesce(c.pending_mode, c.mode) = 'none' AND c.policy = 'availability'
          AND EXISTS (SELECT 1 FROM audit_ledger l WHERE l.org_id = ?
            AND l.chain_id = c.chain_id AND l.epoch = c.epoch AND l.kind = '${AUDIT_VERIFIED_EXPORT.kind}'
            AND l.sink_id IS NULL AND l.reason_code = '${AUDIT_VERIFIED_EXPORT.reasonCode}'
            AND l.from_seq <= c.boundary_seq AND l.to_seq >= max(?, coalesce(c.cutover_seq, 0))))
        OR (coalesce(c.pending_mode, c.mode) = 'export' AND EXISTS (
          SELECT 1 FROM audit_sink d WHERE d.org_id = ? AND d.state = 'active' AND d.durable_ack = 1
            AND d.custody_seq >= max(?, coalesce(c.cutover_seq, 0))
            AND (c.policy != 'required' OR NOT EXISTS (
              SELECT 1 FROM audit_ledger l WHERE l.org_id = ? AND l.chain_id = c.chain_id
                AND l.epoch = c.epoch AND l.kind IN ('withheld', 'uncertain')
                AND (l.sink_id IS NULL OR l.sink_id = d.sink_id)
                AND l.from_seq <= ? AND l.to_seq >= c.boundary_seq
                AND NOT (l.kind = 'uncertain' AND l.sink_id IS NOT NULL AND l.sink_id = d.sink_id AND EXISTS (
                  SELECT 1 FROM audit_ledger r WHERE r.org_id = ? AND r.chain_id = l.chain_id
                    AND r.epoch = l.epoch AND r.sink_id = l.sink_id AND r.kind = 'replay'
                    AND r.resolves_id = l.id AND r.from_seq <= l.from_seq AND r.to_seq >= l.to_seq)))))))`,
    params: [
      ctx.orgId,
      options.generation,
      JSON.stringify(options.configuredSinkIds),
      ctx.orgId,
      ctx.orgId,
      through,
      ctx.orgId,
      through,
      ctx.orgId,
      through,
      ctx.orgId,
      through,
      ctx.orgId,
      through,
      ctx.orgId,
    ],
  };
}

const sinkFence = `SELECT json_group_array(json(snapshot)) AS snapshot FROM (
  SELECT json_object('id', s.sink_id, 'generation', s.generation,
    'from', CASE WHEN coalesce(json_extract(s.inflight_repr, '$.purpose'), '')
      NOT IN ('marker', 'registry_markers', 'capacity') THEN s.inflight_from END,
    'to', CASE WHEN coalesce(json_extract(s.inflight_repr, '$.purpose'), '')
      NOT IN ('marker', 'registry_markers', 'capacity') THEN s.inflight_to END) AS snapshot
  FROM audit_sink s WHERE s.org_id = ? ORDER BY s.sink_id)`;

const sinkSnapshot = `SELECT json_group_array(json(snapshot)) AS snapshot FROM (
  SELECT json_object('id', s.sink_id, 'state', s.state, 'progress', s.progress_seq) AS snapshot
  FROM audit_sink s WHERE s.org_id = ? ORDER BY s.sink_id)`;

function capacityEligible(ctx: OrgContext, options: AuditCapacityOptions): Statement {
  return {
    sql: `c.restore_pending = 0 AND c.policy = 'availability' AND c.journal_bytes >= ?
      AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ? AND s.generation > ?)`,
    params: [
      options.maxJournalBytes - auditCapacityReserveBytes(options.maxJournalBytes),
      ctx.orgId,
      options.generation,
    ],
  };
}

export function createAuditPruneRepository(
  executor: SqlExecutor,
  observability: Observability = noopObservability,
): AuditPrunePort & AuditCapacityPort {
  async function prune(
    ctx: OrgContext,
    options: AuditPruneOptions | AuditCapacityOptions,
  ): Promise<AuditPruneOutcome> {
    const capacity = 'maxJournalBytes' in options ? options : undefined;
    const retention = 'configuredSinkIds' in options ? options : undefined;
    const [chain] = await executor.all<Chain>({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [ctx.orgId],
    });
    if (chain === undefined) throw new Error('Audit chain unavailable');
    const capacityGuard = capacity === undefined ? undefined : capacityEligible(ctx, capacity);
    const [fence] =
      capacity === undefined
        ? []
        : await executor.all<{ snapshot: string }>({ sql: sinkFence, params: [ctx.orgId] });
    const [sinks] =
      capacity === undefined
        ? []
        : await executor.all<{ snapshot: string }>({
            sql: sinkSnapshot,
            params: [ctx.orgId],
          });
    const candidates = await executor.all<Candidate>({
      sql: `WITH snapshot AS MATERIALIZED (SELECT e.seq, e.hash, ${rowJson} AS row_json
        FROM audit_event e WHERE e.org_id = ? AND e.seq >= ? AND e.seq <= ? AND e.seq < 9007199254740991 ORDER BY e.seq LIMIT ?)
        SELECT seq, hash, length(CAST(row_json AS BLOB)) AS bytes, row_json FROM snapshot ORDER BY seq`,
      params: [ctx.orgId, chain.boundary_seq, chain.head_seq, options.limit ?? 500],
    });
    if (candidates.length === 0) return { outcome: 'retained' };
    let selected: readonly Candidate[] = [];
    let low = 0;
    let high = candidates.length - 1;
    while (capacity === undefined && low <= high) {
      const middle = Math.floor((low + high) / 2);
      const guard = eligible(ctx, retention!, candidates.at(middle)!.seq);
      const rows = await executor.all({
        sql: `SELECT 1 FROM audit_chain c WHERE c.org_id = ? AND ${guard.sql}`,
        params: [ctx.orgId, ...guard.params],
      });
      if (rows.length > 0) {
        selected = candidates.slice(0, middle + 1);
        low = middle + 1;
      } else high = middle - 1;
    }
    if (capacity !== undefined) {
      const allowed = await executor.all({
        sql: `SELECT 1 FROM audit_chain c WHERE c.org_id = ? AND ${capacityGuard!.sql}`,
        params: [ctx.orgId, ...capacityGuard!.params],
      });
      if (allowed.length === 0) return { outcome: 'retained' };
      let removed = 0;
      const lowWater = capacity.maxJournalBytes - Math.ceil(capacity.maxJournalBytes / 20);
      const prefix: Candidate[] = [];
      for (const row of candidates) {
        if (row.seq !== chain.boundary_seq + prefix.length) break;
        if (removed >= chain.journal_bytes - lowWater) break;
        prefix.push(row);
        removed += row.bytes;
      }
      selected = prefix;
    }
    // One snapshot assertion per chunk leaves room for all other atomic statements.
    selected = snapshotChunks(selected).slice(0, 180).flat();
    const last = selected.at(-1);
    if (last === undefined) return { outcome: 'retained' };
    const guard = capacity === undefined ? eligible(ctx, retention!, last.seq) : capacityGuard!;
    const sinkGuard: Statement =
      capacity === undefined
        ? { sql: '1', params: [] }
        : {
            sql: `(${sinkFence}) = ?`,
            params: [ctx.orgId, fence!.snapshot],
          };
    const bytes = selected.reduce((sum, row) => sum + row.bytes, 0);
    const integrity: Statement = {
      sql: `NOT EXISTS (SELECT 1 FROM audit_event anchor WHERE anchor.org_id = ?
            AND anchor.seq = c.boundary_seq AND anchor.prev_hash != c.boundary_prev_hash)
          AND NOT EXISTS (SELECT 1 FROM audit_event anchor WHERE anchor.org_id = ?
            AND anchor.seq = c.head_seq AND anchor.hash != c.head_hash)
          AND NOT EXISTS (SELECT 1 FROM audit_event successor WHERE successor.org_id = ?
            AND successor.seq = ? AND successor.prev_hash != ?)
          AND NOT EXISTS (
            SELECT 1 FROM (
              SELECT e.seq, e.prev_hash, lag(e.hash) OVER (ORDER BY e.seq) AS previous_hash,
                lag(e.seq, 1, ?) OVER (ORDER BY e.seq) AS previous_seq
              FROM audit_event e WHERE e.org_id = ? AND e.seq >= ? AND e.seq <= ?
            ) holes WHERE (seq = previous_seq + 1 AND prev_hash != previous_hash)
              OR (seq > previous_seq + 1 AND NOT EXISTS (
              SELECT 1 FROM audit_ledger g WHERE g.org_id = ? AND g.chain_id = c.chain_id
                AND g.epoch = c.epoch AND g.kind = 'gap' AND g.sink_id IS NULL
                AND g.reason_code = 'seq_gap' AND g.superseded_by IS NULL
                AND g.from_seq <= holes.previous_seq + 1 AND g.to_seq >= holes.seq - 1)))`,
      params: [
        ctx.orgId,
        ctx.orgId,
        ctx.orgId,
        last.seq + 1,
        last.hash,
        chain.boundary_seq - 1,
        ctx.orgId,
        chain.boundary_seq,
        last.seq,
        ctx.orgId,
      ],
    };
    const statements: Statement[] = [
      {
        sql: `UPDATE audit_chain AS c SET boundary_seq = ?, boundary_prev_hash = ?, boundary_reason = ?,
          journal_rows = journal_rows - ?, journal_bytes = max(0, journal_bytes - ?)
          WHERE c.org_id = ? AND ${chainFields.map((key) => `c.${key} IS ?`).join(' AND ')}
          AND ${guard.sql} AND ${sinkGuard.sql}
          AND c.journal_rows >= ? AND ${integrity.sql}
          AND (SELECT count(*) FROM audit_event prefix WHERE prefix.org_id = ?
            AND prefix.seq >= ? AND prefix.seq <= ?) = ?`,
        params: [
          last.seq + 1,
          last.hash,
          capacity === undefined ? 'prune' : 'capacity',
          selected.length,
          bytes,
          ctx.orgId,
          chain.chain_id,
          chain.epoch,
          chain.incarnation,
          chain.mode_generation,
          chain.integrity_incidents,
          chain.boundary_seq,
          chain.boundary_prev_hash,
          ...guard.params,
          ...sinkGuard.params,
          selected.length,
          ...integrity.params,
          ctx.orgId,
          chain.boundary_seq,
          last.seq,
          selected.length,
        ],
      },
      ...assertCheck(sql`changes() = 1`),
      ...snapshotChunks(selected).flatMap((chunk) =>
        assertCheck(sql`(SELECT json_group_array(json(row_json)) FROM (
          SELECT ${sql.raw(rowJson)} AS row_json FROM audit_event e WHERE e.org_id = ${ctx.orgId}
            AND e.seq >= ${chunk[0]!.seq} AND e.seq <= ${chunk.at(-1)!.seq} ORDER BY e.seq
        )) = ${`[${chunk.map((row) => row.row_json).join(',')}]`}`),
      ),
    ];
    if (capacity !== undefined) {
      const affectedSinkIds = (
        JSON.parse(sinks!.snapshot) as { id: string; state: string; progress: number }[]
      )
        .filter((s) => !['inactive', 'retired'].includes(s.state) && s.progress < last.seq)
        .map((s) => s.id)
        .sort();
      statements.push(
        ...createAuditLedgerRepository(executor).statements(ctx, [
          {
            id: ulid(),
            kind: 'gap',
            chainId: chain.chain_id,
            epoch: chain.epoch,
            fromSeq: chain.boundary_seq,
            toSeq: last.seq,
            count: selected.length,
            sinkId: null,
            reasonCode: 'capacity',
            capacity: {
              prevHash: chain.boundary_prev_hash,
              hash: last.hash,
              affectedSinkIds: affectedSinkIds.slice(0, 1000),
              ...(affectedSinkIds.length > 1000 ? { affectedSinkIdsOverflow: true as const } : {}),
            },
            policy: 'availability',
            modeGeneration: chain.mode_generation,
            actorType: 'system',
            actorId: null,
            createdAt: new Date().toISOString(),
          },
        ]),
      );
    }
    const deleteIndex = statements.length;
    statements.push(
      {
        sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq >= ? AND seq <= ? RETURNING seq',
        params: [ctx.orgId, chain.boundary_seq, last.seq],
      },
      ...clearAuditVerificationStatements(ctx),
    );
    try {
      const results = await executor.batch(statements);
      const deleted = results.at(deleteIndex)!.rows.length;
      if (capacity !== undefined) {
        observability.log({ level: 'warn', event: 'audit.loss', reason_code: 'capacity' });
        observability.counter('pb.audit.loss_events_total', { kind: 'gap' }, deleted);
      }
      return { outcome: 'pruned', pruned: deleted, boundarySeq: last.seq + 1 };
    } catch (error) {
      if (
        error instanceof DbError &&
        error.kind === 'unique' &&
        error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
      ) {
        const allowed = await executor.all({
          sql: `SELECT 1 FROM audit_chain c WHERE c.org_id = ? AND ${guard.sql}`,
          params: [ctx.orgId, ...guard.params],
        });
        if (allowed.length === 0) return { outcome: 'retained' };
        const [current] = await executor.all<Chain>({
          sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
          params: [ctx.orgId],
        });
        const broken = await executor.all({
          sql: `SELECT 1 FROM audit_chain c WHERE c.org_id = ? AND NOT (${integrity.sql})`,
          params: [ctx.orgId, ...integrity.params],
        });
        if (broken.length > 0) {
          observability.log({
            level: 'error',
            event: 'audit.chain_integrity',
            reason_code: 'prune_anchor',
          });
          observability.counter('pb.audit.chain_integrity');
        }
        const currentRows = await executor.all<{ row_json: string }>({
          sql: `SELECT ${rowJson} AS row_json FROM audit_event e WHERE e.org_id = ?
            AND e.seq >= ? AND e.seq <= ? ORDER BY e.seq`,
          params: [ctx.orgId, chain.boundary_seq, last.seq],
        });
        const changed =
          current === undefined ||
          current.chain_id !== chain.chain_id ||
          current.epoch !== chain.epoch ||
          current.incarnation !== chain.incarnation ||
          current.mode_generation !== chain.mode_generation ||
          current.integrity_incidents !== chain.integrity_incidents ||
          current.boundary_seq !== chain.boundary_seq ||
          current.boundary_prev_hash !== chain.boundary_prev_hash ||
          (capacity !== undefined &&
            (await executor.all<{ snapshot: string }>({ sql: sinkFence, params: [ctx.orgId] }))[0]
              ?.snapshot !== fence!.snapshot) ||
          JSON.stringify(currentRows.map((row) => row.row_json)) !==
            JSON.stringify(selected.map((row) => row.row_json));
        return { outcome: changed ? 'contended' : 'retained' };
      }
      throw auditLedgerError(error);
    }
  }
  const port: AuditPrunePort & AuditCapacityPort = {
    prune,
    async evict(ctx, options) {
      const result = await prune(ctx, options);
      return result.outcome === 'pruned'
        ? { outcome: 'evicted', evicted: result.pruned, boundarySeq: result.boundarySeq }
        : result;
    },
  };
  return {
    prune: (ctx, options) => pruneAudit(port, ctx, options),
    evict: (ctx, options) => evictAudit(port, ctx, options),
  };
}
