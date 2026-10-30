import {
  assertAuditLedgerEntry,
  AuditLedgerIntegrityError,
  AuditLedgerOverlapError,
  normalizeAuditLedgerEntries,
  type AuditLedgerEntry,
  type AuditLedgerPort,
} from '@package-broker/core/audit/ledger';
import { DbError } from '@package-broker/core/db/errors';
import { isUlid, ulid } from '@package-broker/core/ids';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarSqlValue,
  ScalarStatement,
} from '@package-broker/core/db/port';

export interface AuditLedgerRepository extends AuditLedgerPort {
  capacityGap(
    ctx: OrgContext,
    chainId: string,
    epoch: number,
    afterSeq: number,
  ): Promise<AuditLedgerEntry | null>;
  statements(ctx: OrgContext, entries: readonly AuditLedgerEntry[]): readonly ScalarStatement[];
}

export { AuditLedgerIntegrityError } from '@package-broker/core/audit/ledger';

/** NOT NULL sentinels the append statement raises; SQLite checks to_seq before count. */
const INTEGRITY_SENTINEL = 'audit_ledger.to_seq';
const OVERLAP_SENTINEL = 'audit_ledger.count';

const COLUMNS = `current.id, current.kind, current.chain_id AS chainId, current.epoch,
  current.from_seq AS fromSeq, current.to_seq AS toSeq, current.count, current.sink_id AS sinkId,
  current.resolves_id AS resolvesId, current.capacity_json AS capacityJson, current.reason_code AS reasonCode, current.policy, current.mode_generation AS modeGeneration,
  current.actor_type AS actorType, current.actor_id AS actorId, current.created_at AS createdAt`;

const OPEN_GAPS = `open AS NOT MATERIALIZED (
    SELECT visible_gap.id, visible_gap.chain_id, visible_gap.epoch, visible_gap.reason_code,
      visible_gap.sink_id, visible_gap.from_seq, visible_gap.to_seq
    FROM audit_ledger AS visible_gap
    WHERE visible_gap.org_id = ? AND visible_gap.kind = 'gap' AND visible_gap.superseded_by IS NULL
  )`;

const CONFLICT = `current.kind = 'gap' AND (
    coalesce((SELECT before.to_seq FROM open AS before
      WHERE before.chain_id = current.chain_id AND before.epoch = current.epoch
        AND before.reason_code = current.reason_code AND before.sink_id IS current.sink_id
        AND before.from_seq < current.from_seq
      ORDER BY before.from_seq DESC LIMIT 1) >= current.from_seq, 0)
    OR EXISTS (SELECT 1 FROM open AS inside
      WHERE inside.chain_id = current.chain_id AND inside.epoch = current.epoch
        AND inside.reason_code = current.reason_code AND inside.sink_id IS current.sink_id
        AND inside.from_seq BETWEEN current.from_seq AND current.to_seq
        AND inside.id <> current.id)
  ) AS conflict`;

const APPEND = `WITH incoming (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id,
    reason_code, policy, mode_generation, actor_type, actor_id, created_at, resolves_id, capacity_json)
    AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
  open AS NOT MATERIALIZED (
    SELECT open_gap.id, open_gap.from_seq, open_gap.to_seq, open_gap.count, open_gap.capacity_json
    FROM audit_ledger AS open_gap
    WHERE open_gap.org_id = ? AND open_gap.kind = 'gap' AND open_gap.superseded_by IS NULL
      AND ? = 'gap' AND open_gap.chain_id = ? AND open_gap.epoch = ?
      AND open_gap.reason_code = ? AND open_gap.sink_id IS ?
  ),
  before AS (SELECT * FROM open WHERE from_seq < ? ORDER BY from_seq DESC, id DESC LIMIT 1),
  near AS (
    SELECT * FROM before
    UNION ALL
    SELECT * FROM open WHERE from_seq BETWEEN ? AND ? + 1
  ),
  scope AS (
    SELECT * FROM near
    UNION ALL
    SELECT * FROM (SELECT * FROM open WHERE (from_seq, id) < (SELECT from_seq, id FROM before)
      ORDER BY from_seq DESC, id DESC LIMIT 1)
    UNION ALL
    SELECT * FROM (SELECT * FROM open WHERE from_seq > ? + 1 ORDER BY from_seq, id LIMIT 1)
  ),
  conflict AS (
    SELECT coalesce(max(count < 1 OR count > to_seq - from_seq + 1 OR previous_to >= from_seq), 0)
      AS found
    FROM (SELECT *, lag(to_seq) OVER (ORDER BY from_seq, id) AS previous_to FROM scope)
  ),
  touched AS (
    SELECT min(CASE WHEN near.capacity_json IS NULL AND i.capacity_json IS NULL THEN near.from_seq END) AS from_seq,
      max(CASE WHEN near.capacity_json IS NULL AND i.capacity_json IS NULL THEN near.to_seq END) AS to_seq,
      coalesce(sum(CASE WHEN near.capacity_json IS NULL AND i.capacity_json IS NULL THEN near.count ELSE 0 END), 0) AS count,
      coalesce(max(near.from_seq <= i.to_seq AND near.to_seq >= i.from_seq), 0) AS overlaps
    FROM incoming AS i CROSS JOIN near WHERE near.to_seq >= i.from_seq - 1
  ),
  existing AS MATERIALIZED (
    SELECT stored.* FROM incoming AS i CROSS JOIN audit_ledger AS stored
    WHERE stored.org_id = ? AND stored.id = i.id
  ),
  absorbed AS MATERIALIZED (
    SELECT coalesce(sum(hidden.count), 0) AS count,
      coalesce(sum(hidden.to_seq - hidden.from_seq + 1), 0) AS span,
      coalesce(max(hidden.from_seq <= i.to_seq AND hidden.to_seq >= i.from_seq), 0) AS overlaps
    FROM incoming AS i CROSS JOIN audit_ledger AS hidden
    WHERE hidden.org_id = ? AND hidden.superseded_by = i.id
  )
INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id,
  reason_code, policy, mode_generation, actor_type, actor_id, created_at, resolves_id, capacity_json)
SELECT i.org_id, i.id, i.kind, i.chain_id, i.epoch,
  CASE WHEN EXISTS (SELECT 1 FROM existing) THEN i.from_seq
    ELSE min(i.from_seq, coalesce(t.from_seq, i.from_seq)) END,
  CASE WHEN c.found THEN NULL WHEN EXISTS (SELECT 1 FROM existing) THEN i.to_seq
    ELSE max(i.to_seq, coalesce(t.to_seq, i.to_seq)) END,
  CASE WHEN EXISTS (SELECT 1 FROM existing) THEN i.count
    WHEN t.overlaps THEN NULL ELSE i.count + t.count END,
  i.sink_id, i.reason_code, i.policy, i.mode_generation, i.actor_type, i.actor_id, i.created_at, i.resolves_id, i.capacity_json
FROM incoming AS i CROSS JOIN touched AS t CROSS JOIN conflict AS c
WHERE c.found OR NOT EXISTS (
  SELECT 1 FROM existing AS e CROSS JOIN absorbed AS a
  WHERE e.kind = i.kind AND e.chain_id = i.chain_id AND e.epoch = i.epoch
    AND e.sink_id IS i.sink_id AND e.reason_code = i.reason_code AND e.policy = i.policy
    AND e.mode_generation = i.mode_generation AND e.actor_type = i.actor_type
    AND e.capacity_json IS i.capacity_json AND e.resolves_id IS i.resolves_id AND e.actor_id IS i.actor_id AND e.created_at = i.created_at
    AND e.from_seq <= i.from_seq AND e.to_seq >= i.to_seq AND NOT a.overlaps
    AND e.count = i.count + a.count
    AND e.to_seq - e.from_seq = i.to_seq - i.from_seq + a.span
)`;

const SUPERSEDE = `WITH covering AS (
    SELECT min(covering_gap.from_seq) AS from_seq, max(covering_gap.to_seq) AS to_seq,
      max(covering_gap.count) AS count
    FROM audit_ledger AS covering_gap
    WHERE covering_gap.org_id = ? AND covering_gap.id = ? AND covering_gap.superseded_by IS NULL
  ),
  candidate AS NOT MATERIALIZED (
    SELECT candidate_gap.id, candidate_gap.from_seq, candidate_gap.to_seq, candidate_gap.count
    FROM audit_ledger AS candidate_gap
    WHERE candidate_gap.org_id = ? AND candidate_gap.kind = 'gap'
      AND candidate_gap.superseded_by IS NULL AND candidate_gap.chain_id = ?
      AND candidate_gap.epoch = ? AND candidate_gap.reason_code = ? AND candidate_gap.sink_id IS ?
      AND candidate_gap.capacity_json IS ? AND candidate_gap.id <> ?
      AND candidate_gap.from_seq BETWEEN (SELECT from_seq FROM covering)
        AND (SELECT to_seq FROM covering)
      AND candidate_gap.to_seq <= (SELECT to_seq FROM covering)
  ),
  fresh AS (
    SELECT c.count = ? + coalesce((SELECT sum(count) FROM candidate), 0)
      AND c.to_seq - c.from_seq
        = ? - ? + coalesce((SELECT sum(to_seq - from_seq + 1) FROM candidate), 0)
      AND NOT EXISTS (
        SELECT 1 FROM audit_ledger AS absorbed_gap
        WHERE absorbed_gap.org_id = ? AND absorbed_gap.superseded_by = ?
      ) AS inserted
    FROM covering AS c
  )
UPDATE audit_ledger SET superseded_by = ?
WHERE audit_ledger.org_id = ? AND audit_ledger.id IN (SELECT id FROM candidate)
  AND (SELECT inserted FROM fresh)`;

type Row = AuditLedgerEntry & { readonly conflict: number; readonly capacityJson: string | null };

/** Maps the append statement's sentinel failures to the named ledger errors; other errors pass through. */
export function auditLedgerError(error: unknown): unknown {
  if (error instanceof DbError && error.kind === 'not_null') {
    if (error.constraint === INTEGRITY_SENTINEL) return new AuditLedgerIntegrityError();
    if (error.constraint === OVERLAP_SENTINEL) return new AuditLedgerOverlapError();
  }
  return error;
}

function validatedRows(rows: readonly Row[]): readonly AuditLedgerEntry[] {
  return rows.map(({ conflict, capacityJson, ...row }) => {
    if (conflict !== 0) throw new AuditLedgerIntegrityError();
    try {
      const entry = {
        ...row,
        ...(capacityJson == null
          ? {}
          : {
              capacity: JSON.parse(capacityJson) as NonNullable<AuditLedgerEntry['capacity']>,
            }),
      };
      if (entry.resolvesId === null) delete entry.resolvesId;
      assertAuditLedgerEntry(entry);
      return entry;
    } catch {
      throw new AuditLedgerIntegrityError();
    }
  });
}

function appendStatements(ctx: OrgContext, entry: AuditLedgerEntry): readonly ScalarStatement[] {
  const key: ScalarSqlValue[] = [entry.chainId, entry.epoch, entry.reasonCode, entry.sinkId];
  const append: ScalarStatement = {
    sql: APPEND,
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
      entry.resolvesId ?? null,
      entry.capacity === undefined
        ? null
        : JSON.stringify({
            prevHash: entry.capacity.prevHash,
            hash: entry.capacity.hash,
            affectedSinkIds: entry.capacity.affectedSinkIds,
            ...(entry.capacity.affectedSinkIdsOverflow ? { affectedSinkIdsOverflow: true } : {}),
          }),
      ctx.orgId,
      entry.kind,
      ...key,
      entry.fromSeq,
      entry.fromSeq,
      entry.toSeq,
      entry.toSeq,
      ctx.orgId,
      ctx.orgId,
    ],
  };
  if (entry.kind !== 'gap') return [append];
  if (entry.capacity !== undefined) return [append, ...capacityMergeStatements(ctx, entry)];
  return [
    append,
    {
      sql: SUPERSEDE,
      params: [
        ctx.orgId,
        entry.id,
        ctx.orgId,
        ...key,
        null,
        entry.id,
        entry.count,
        entry.toSeq,
        entry.fromSeq,
        ctx.orgId,
        entry.id,
        entry.id,
        ctx.orgId,
      ],
    },
  ];
}

/** Keep original reports immutable so retries can still compare every submitted field. */
function capacityMergeStatements(
  ctx: OrgContext,
  entry: AuditLedgerEntry,
): readonly ScalarStatement[] {
  const mergedId = ulid();
  return [
    {
      sql: `WITH incoming AS MATERIALIZED (
      SELECT * FROM audit_ledger WHERE org_id = ? AND id = ? AND superseded_by IS NULL
    ), members AS MATERIALIZED (
      SELECT neighbor.* FROM audit_ledger neighbor CROSS JOIN incoming i
      WHERE neighbor.org_id = ? AND neighbor.chain_id = i.chain_id AND neighbor.epoch = i.epoch
        AND neighbor.kind = 'gap' AND neighbor.reason_code = 'capacity' AND neighbor.sink_id IS NULL
        AND neighbor.superseded_by IS NULL AND neighbor.capacity_json IS NOT NULL
        AND (neighbor.id = i.id
          OR (neighbor.to_seq + 1 = i.from_seq
            AND json_extract(neighbor.capacity_json, '$.hash') = json_extract(i.capacity_json, '$.prevHash'))
          OR (i.to_seq + 1 = neighbor.from_seq
            AND json_extract(i.capacity_json, '$.hash') = json_extract(neighbor.capacity_json, '$.prevHash')))
    ), sinks AS MATERIALIZED (
      SELECT DISTINCT s.value AS id FROM members m, json_each(m.capacity_json, '$.affectedSinkIds') s ORDER BY id
    ), metadata AS (
      SELECT json_patch(json_object(
        'prevHash', (SELECT json_extract(capacity_json, '$.prevHash') FROM members ORDER BY from_seq LIMIT 1),
        'hash', (SELECT json_extract(capacity_json, '$.hash') FROM members ORDER BY to_seq DESC LIMIT 1),
        'affectedSinkIds', json((SELECT json_group_array(id) FROM (SELECT id FROM sinks ORDER BY id LIMIT 1000)))),
        CASE WHEN (SELECT count(*) FROM sinks) > 1000
          OR EXISTS (SELECT 1 FROM members WHERE json_extract(capacity_json, '$.affectedSinkIdsOverflow') = 1)
          THEN '{"affectedSinkIdsOverflow":true}' ELSE '{}' END) AS value
    )
    INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count, sink_id,
      reason_code, policy, mode_generation, actor_type, actor_id, created_at, resolves_id, capacity_json)
    SELECT i.org_id, ?, i.kind, i.chain_id, i.epoch,
      (SELECT min(from_seq) FROM members), (SELECT max(to_seq) FROM members),
      (SELECT sum(count) FROM members), i.sink_id, i.reason_code, i.policy, i.mode_generation,
      i.actor_type, i.actor_id, i.created_at, i.resolves_id, metadata.value
    FROM incoming i CROSS JOIN metadata WHERE (SELECT count(*) FROM members) > 1`,
      params: [ctx.orgId, entry.id, ctx.orgId, mergedId],
    },
    {
      sql: `UPDATE audit_ledger SET superseded_by = ?
      WHERE org_id = ? AND superseded_by IS NULL AND id <> ? AND kind = 'gap'
        AND reason_code = 'capacity' AND sink_id IS NULL AND capacity_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM audit_ledger covering WHERE covering.org_id = ? AND covering.id = ?
          AND covering.chain_id = audit_ledger.chain_id AND covering.epoch = audit_ledger.epoch
          AND covering.from_seq <= audit_ledger.from_seq AND covering.to_seq >= audit_ledger.to_seq)`,
      params: [mergedId, ctx.orgId, mergedId, ctx.orgId, mergedId],
    },
  ];
}

export function createAuditLedgerRepository(executor: ScalarSqlExecutor): AuditLedgerRepository {
  const statements = (
    ctx: OrgContext,
    entries: readonly AuditLedgerEntry[],
  ): readonly ScalarStatement[] =>
    normalizeAuditLedgerEntries(entries).flatMap((entry) => appendStatements(ctx, entry));
  return {
    statements,
    async capacityGap(ctx, chainId, epoch, afterSeq) {
      const rows = await executor.all<Row>({
        sql: `WITH ${OPEN_GAPS} SELECT ${COLUMNS}, ${CONFLICT} FROM audit_ledger AS current
          WHERE current.org_id = ? AND current.chain_id = ? AND current.epoch = ?
            AND current.kind = 'gap' AND current.sink_id IS NULL AND current.reason_code = 'capacity'
            AND current.superseded_by IS NULL AND current.from_seq <= ? AND current.to_seq > ?
          ORDER BY current.from_seq DESC LIMIT 1`,
        params: [ctx.orgId, ctx.orgId, chainId, epoch, afterSeq + 1, afterSeq],
      });
      return validatedRows(rows)[0] ?? null;
    },
    async append(ctx, entries) {
      const batch = statements(ctx, entries);
      try {
        if (batch.length > 0) await executor.batch(batch);
      } catch (error) {
        throw auditLedgerError(error);
      }
    },
    async effectiveGaps(ctx) {
      const rows = await executor.all<Row>({
        sql: `WITH ${OPEN_GAPS}
          SELECT ${COLUMNS}, ${CONFLICT} FROM audit_ledger AS current
          WHERE current.org_id = ? AND current.kind = 'gap' AND current.superseded_by IS NULL
          ORDER BY current.id`,
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
      const rows = await executor.all<Row>({
        sql: `WITH ${OPEN_GAPS}
          SELECT ${COLUMNS}, ${CONFLICT} FROM audit_ledger AS current
          WHERE current.org_id = ? AND current.superseded_by IS NULL AND current.id > ?
          ORDER BY current.id LIMIT ?`,
        params: [ctx.orgId, ctx.orgId, afterId ?? '', limit],
      });
      return validatedRows(rows);
    },
  };
}
