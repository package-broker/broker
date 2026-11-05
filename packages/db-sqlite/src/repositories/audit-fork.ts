import type {
  AuditSinkAdminPort,
  AuditSinkAdminSnapshot,
} from '@package-broker/core/audit/sink-admin';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import type { AuditExportState } from '@package-broker/core/audit/export';
import { AuditForkLimitError, type AuditForkSnapshot } from '@package-broker/core/audit/fork';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';
import { auditEpochCarryStatements, AuditEpochCarryLimitError } from './audit-epoch-carry.js';
import { clearAuditVerificationStatements } from './audit-verify.js';

const chain = {
  chain_id: 'chainId',
  epoch: 'epoch',
  incarnation: 'incarnation',
  mode_generation: 'modeGeneration',
  boundary_seq: 'boundarySeq',
  boundary_prev_hash: 'boundaryPrevHash',
  boundary_reason: 'boundaryReason',
  policy: 'policy',
  mode: 'mode',
  pending_mode: 'pendingMode',
  restore_pending: 'restorePending',
  head_seq: 'headSeq',
  head_hash: 'headHash',
} as const;
const sink = {
  sink_id: 'id',
  plugin_id: 'pluginId',
  kind: 'kind',
  generation: 'generation',
  receiver_fingerprint: 'receiverFingerprint',
  durable_ack: 'durableAck',
  activation_source: 'activationSource',
  state: 'state',
  blocked_reason: 'blockedReason',
  progress_seq: 'progressSeq',
  progress_hash: 'progressHash',
  custody_seq: 'custodySeq',
  inflight_from: 'inflightFrom',
  inflight_to: 'inflightTo',
  inflight_body: 'inflightBody',
  inflight_repr: 'inflightRepr',
  attempt: 'attempt',
  retry_count_for_seq: 'retryCountForSeq',
  next_attempt_at: 'nextAttemptAt',
  last_error_code: 'lastErrorCode',
  body_version: 'bodyVersion',
} as const;
const projection = (fields: Readonly<Record<string, string>>) =>
  Object.entries(fields)
    .map(([column, alias]) => `${column} AS "${alias}"`)
    .join(', ');

const HISTORY_LIMIT = 1024;
const historyColumns = (alias: string) =>
  ['id', 'kind', 'chain_id', 'epoch', 'from_seq', 'to_seq', 'reason_code', 'created_at']
    .map((column) => `${alias}.${column}`)
    .join(', ');
/**
 * Current-window seq gaps, the latest reset of each other chain and the latest confirmation.
 * Reset chains are walked one distinct chain id at a time, so the work grows with the number
 * of reset chains, not with the number of resets.
 */
const HISTORY_SQL = `WITH RECURSIVE
  history_chain AS (SELECT * FROM audit_chain history_source WHERE history_source.org_id = ?),
  reset_chains(chain_id) AS (
    SELECT (SELECT min(first_reset.chain_id) FROM audit_ledger first_reset
      WHERE first_reset.org_id = history_chain.org_id AND first_reset.kind = 'chain_reset'
        AND first_reset.superseded_by IS NULL) FROM history_chain
    UNION ALL
    SELECT (SELECT min(following.chain_id) FROM audit_ledger following
      WHERE following.org_id = history_chain.org_id AND following.kind = 'chain_reset'
        AND following.superseded_by IS NULL AND following.chain_id > reset_chains.chain_id)
    FROM reset_chains JOIN history_chain WHERE reset_chains.chain_id IS NOT NULL)
  SELECT * FROM (
    SELECT ${historyColumns('gap')} FROM history_chain JOIN audit_ledger gap
      ON gap.org_id = history_chain.org_id AND gap.kind = 'gap' AND gap.superseded_by IS NULL
        AND gap.chain_id = history_chain.chain_id AND gap.epoch = history_chain.epoch
        AND gap.reason_code = 'seq_gap' AND gap.sink_id IS NULL
        AND gap.from_seq <= history_chain.head_seq AND gap.to_seq >= history_chain.boundary_seq - 1
    UNION ALL
    SELECT ${historyColumns('reset')} FROM reset_chains JOIN history_chain
        ON reset_chains.chain_id <> history_chain.chain_id
      JOIN audit_ledger reset ON reset.org_id = history_chain.org_id
        AND reset.id = (SELECT pick.id FROM audit_ledger pick WHERE pick.org_id = history_chain.org_id
          AND pick.kind = 'chain_reset' AND pick.superseded_by IS NULL
          AND pick.chain_id = reset_chains.chain_id
          ORDER BY pick.created_at DESC, pick.id DESC LIMIT 1)
    UNION ALL
    SELECT * FROM (SELECT ${historyColumns('latest')} FROM history_chain JOIN audit_ledger latest
      ON latest.org_id = history_chain.org_id AND latest.kind = 'restore_confirmed'
        AND latest.superseded_by IS NULL AND latest.chain_id = history_chain.chain_id
        AND latest.epoch = history_chain.epoch
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
  ) ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`;

const [historyHead, historyTail] = HISTORY_SQL.split('?') as [string, string];

export function createAuditForkRepository(executor: SqlExecutor): AuditSinkAdminPort {
  return {
    async actorExists(org, actor) {
      const table = actor.type === 'user' ? 'user_account' : 'service_principal';
      const rows = await executor.all({
        sql: `SELECT 1 FROM ${table} WHERE org_id = ? AND id = ? AND status = 'active'`,
        params: [org.orgId, actor.id],
      });
      return rows.length === 1;
    },
    async resolution(org, id) {
      const [row] = await executor.all<AuditLedgerEntry & { resolved: number }>({
        sql: `SELECT l.id, l.kind, l.chain_id AS chainId, l.epoch, l.from_seq AS fromSeq,
          l.to_seq AS toSeq, l.count, l.sink_id AS sinkId, l.reason_code AS reasonCode,
          l.policy, l.mode_generation AS modeGeneration, l.actor_type AS actorType,
          l.actor_id AS actorId, l.created_at AS createdAt,
          EXISTS (SELECT 1 FROM audit_ledger r
            WHERE r.org_id = ? AND r.resolves_id = l.id AND r.kind = 'replay'
              AND r.superseded_by IS NULL) AS resolved
          FROM audit_ledger l WHERE l.org_id = ? AND l.id = ? AND l.superseded_by IS NULL`,
        params: [org.orgId, org.orgId, id],
      });
      return { target: row ?? null, resolved: Boolean(row?.resolved) };
    },
    async read(org) {
      const [chainResult, sinkResult, historyResult] = await executor.batch([
        {
          sql: `SELECT ${projection(chain)} FROM audit_chain WHERE org_id = ?`,
          params: [org.orgId],
        },
        {
          sql: `SELECT ${projection(sink)} FROM audit_sink WHERE org_id = ? ORDER BY sink_id`,
          params: [org.orgId],
        },
        {
          sql: `SELECT id, kind, chain_id AS chainId, epoch, from_seq AS fromSeq, to_seq AS toSeq, reason_code AS reasonCode
          FROM (${HISTORY_SQL})`,
          params: [org.orgId],
        },
      ]);
      const row = chainResult!.rows[0] as unknown as
        Omit<AuditSinkAdminSnapshot, 'sinks'> | undefined;
      if (row === undefined) throw new Error('Audit chain unavailable');
      const history = historyResult!.rows;
      if (history.length >= HISTORY_LIMIT) throw new AuditForkLimitError('history_limit');
      return {
        ...row,
        history: history as unknown as NonNullable<AuditForkSnapshot['history']>,
        restorePending: Boolean(row.restorePending),
        sinks: (sinkResult!.rows as unknown as AuditForkSnapshot['sinks']).map((value) => ({
          ...value,
          durableAck: Boolean(value.durableAck),
        })),
      };
    },
    async hashAt(org, seq) {
      const [row] = await executor.all<{ hash: string }>({
        sql: 'SELECT hash FROM audit_event WHERE org_id = ? AND seq = ?',
        params: [org.orgId, seq],
      });
      return row?.hash ?? null;
    },
    async save(org, expected, observed, change, generation) {
      if (!Number.isSafeInteger(generation) || generation < 0)
        throw new TypeError('Invalid audit generation');
      if (
        change.sinks.length !== expected.sinks.length ||
        new Set(change.sinks.map((row) => row.id)).size !== expected.sinks.length ||
        change.sinks.some((row) => !expected.sinks.some((old) => old.id === row.id))
      )
        throw new TypeError('Invalid audit fork sink set');
      const changedSinks = change.sinks.filter(
        (row) =>
          JSON.stringify(row) !== JSON.stringify(expected.sinks.find((old) => old.id === row.id)),
      );
      const bytes = (value: string | null) =>
        value === null ? null : new TextEncoder().encode(value).length;
      const compact = (row: AuditExportState) => ({
        ...row,
        inflightBody: undefined,
        inflightRepr: undefined,
        inflightBodyBytes: bytes(row.inflightBody),
        inflightReprBytes: bytes(row.inflightRepr),
      });
      const chainSnapshot = { ...expected, sinks: undefined, history: undefined };
      const snapshot = JSON.stringify(chainSnapshot);
      let carry: Statement[] = [];
      if (change.epoch !== expected.epoch) {
        try {
          carry = await auditEpochCarryStatements(executor, org.orgId, change.epoch, change.now);
        } catch (error) {
          if (error instanceof AuditEpochCarryLimitError)
            throw new AuditForkLimitError('batch_limit');
          throw error;
        }
      }
      const statements: Statement[] = [
        ...assertCheck(sql`EXISTS (SELECT 1 FROM audit_chain c, json_each(${`[${snapshot}]`}) e
          WHERE c.org_id = ${org.orgId} AND ${sql.raw(
            Object.entries(chain)
              .map(([column, key]) => `c.${column} IS json_extract(e.value, '$.${key}')`)
              .join(' AND '),
          )} AND (${change.policy ?? 'availability'} <> 'required' OR
            (c.mode <> 'none' AND c.pending_mode IS NOT 'none'
              AND (coalesce(c.pending_mode, c.mode) = 'trail' OR ${Number(expected.sinks.some((row) => row.durableAck && ['active', 'blocked'].includes(row.state)))} = 1)))
            AND (SELECT json_group_array(json_object('id', id, 'kind', kind, 'chainId', chain_id, 'epoch', epoch, 'fromSeq', from_seq, 'toSeq', to_seq, 'reasonCode', reason_code))
            FROM (${sql.raw(historyHead)}${org.orgId}${sql.raw(historyTail)})) IS ${JSON.stringify(expected.history ?? [])})`),
        ...assertCheck(sql`((SELECT count(*) FROM audit_sink WHERE org_id = ${org.orgId}) = ${expected.sinks.length}
          AND NOT EXISTS (SELECT 1 FROM audit_sink s WHERE s.org_id = ${org.orgId} AND (
            s.generation > ${generation} OR NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(expected.sinks.map(compact))}) e
              WHERE ${sql.raw(
                Object.entries(sink)
                  .filter(([column]) => !['inflight_body', 'inflight_repr'].includes(column))
                  .map(([column, key]) => `s.${column} IS json_extract(e.value, '$.${key}')`)
                  .join(' AND '),
              )} AND length(CAST(s.inflight_body AS BLOB)) IS json_extract(e.value, '$.inflightBodyBytes')
                AND length(CAST(s.inflight_repr AS BLOB)) IS json_extract(e.value, '$.inflightReprBytes')))))`),
        ...assertCheck(sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(observed)}) e
          WHERE (SELECT hash FROM audit_event WHERE org_id = ${org.orgId}
            AND seq = json_extract(e.value, '$.seq')) IS NOT json_extract(e.value, '$.hash'))`),
      ];
      if (change.event?.actor.type === 'user' || change.event?.actor.type === 'service_principal') {
        const table = change.event.actor.type === 'user' ? 'user_account' : 'service_principal';
        statements.push(
          ...assertCheck(sql`EXISTS (SELECT 1 FROM ${sql.table(table)}
          WHERE org_id = ${org.orgId} AND id = ${change.event.actor.id} AND status = 'active')`),
        );
      }
      for (const row of change.ledger) {
        if (row.resolvesId != null) {
          statements.push(
            ...assertCheck(sql`NOT EXISTS (SELECT 1 FROM audit_ledger
            WHERE org_id = ${org.orgId}
            AND resolves_id = ${row.resolvesId} AND kind = 'replay' AND superseded_by IS NULL)`),
          );
        }
      }
      statements.push(...carry);
      const chainUpdateIndex = statements.length;
      statements.push(
        {
          sql: `UPDATE audit_chain SET epoch = ?, restore_pending = ?, boundary_reason = ?,
            mode_generation = mode_generation + CASE WHEN policy <> ? THEN 1 ELSE 0 END, policy = ?
            WHERE org_id = ? RETURNING org_id`,
          params: [
            change.epoch,
            Number(change.restorePending),
            change.boundaryReason,
            change.policy ?? expected.policy,
            change.policy ?? expected.policy,
            org.orgId,
          ],
        },
        {
          sql: `WITH next AS MATERIALIZED (SELECT value FROM json_each(?))
            UPDATE audit_sink SET ${Object.entries(sink)
              .filter(([column]) => column !== 'sink_id' && column !== 'body_version')
              .map(
                ([column, key]) =>
                  `${column} = CASE WHEN (SELECT json_type(value, '$.${key}') FROM next WHERE json_extract(value, '$.id') = audit_sink.sink_id) IS NULL THEN ${column} ELSE (SELECT json_extract(value, '$.${key}') FROM next WHERE json_extract(value, '$.id') = audit_sink.sink_id) END`,
              )
              .join(', ')},
              body_version = body_version + 1, updated_at = ? WHERE org_id = ? AND sink_id IN (
                SELECT json_extract(value, '$.id') FROM next) RETURNING sink_id`,
          params: [
            JSON.stringify(
              changedSinks.map((row) => {
                const old = expected.sinks.find((value) => value.id === row.id)!;
                return {
                  ...row,
                  inflightBody:
                    row.inflightBody === old.inflightBody ? undefined : row.inflightBody,
                  inflightRepr:
                    row.inflightRepr === old.inflightRepr ? undefined : row.inflightRepr,
                };
              }),
            ),
            change.now,
            org.orgId,
          ],
        },
        ...clearAuditVerificationStatements(org),
        ...createAuditLedgerRepository(executor).statements(org, change.ledger),
        ...(change.event === null ? [] : [auditPendingStatement(org, change.event)]),
      );
      if (statements.length >= 200 || statements.some((statement) => statement.params.length > 90))
        throw new AuditForkLimitError('batch_limit');
      try {
        const results = await executor.batch(statements);
        const sinkUpdateIndex = chainUpdateIndex + 1;
        return (
          results[chainUpdateIndex]!.rows.length === 1 &&
          results[sinkUpdateIndex]!.rows.length === changedSinks.length
        );
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
