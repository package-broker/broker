import type { AuditExportState } from '@package-broker/core/audit/export';
import {
  AuditForkLimitError,
  type AuditForkPort,
  type AuditForkSnapshot,
} from '@package-broker/core/audit/fork';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { auditPendingStatement } from './audit-pending.js';
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
const relevantHistory = `audit_ledger.superseded_by IS NULL AND (
  (audit_ledger.kind = 'gap' AND audit_ledger.reason_code = 'seq_gap' AND audit_ledger.sink_id IS NULL
    AND audit_ledger.chain_id = c.chain_id AND audit_ledger.epoch = c.epoch
    AND audit_ledger.to_seq >= c.boundary_seq - 1 AND audit_ledger.from_seq <= c.head_seq)
  OR audit_ledger.id = (SELECT reset.id FROM audit_ledger reset WHERE reset.org_id = c.org_id
    AND reset.kind = 'chain_reset' AND reset.chain_id = audit_ledger.chain_id
    AND reset.chain_id <> c.chain_id AND reset.superseded_by IS NULL
    ORDER BY reset.created_at DESC, reset.id DESC LIMIT 1)
  OR audit_ledger.id = (SELECT latest.id FROM audit_ledger latest WHERE latest.org_id = c.org_id
    AND latest.chain_id = c.chain_id AND latest.epoch = c.epoch
    AND latest.kind = 'restore_confirmed' AND latest.superseded_by IS NULL
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1))`;
const historyOrder = `ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`;

export function createAuditForkRepository(executor: SqlExecutor): AuditForkPort {
  return {
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
          FROM audit_ledger WHERE org_id = ? AND superseded_by IS NULL
          AND EXISTS (SELECT 1 FROM audit_chain c WHERE c.org_id = audit_ledger.org_id AND ${relevantHistory})
          ${historyOrder}`,
          params: [org.orgId],
        },
      ]);
      const row = chainResult!.rows[0] as unknown as Omit<AuditForkSnapshot, 'sinks'> | undefined;
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
      const carried = change.carriedGaps ?? [];
      const carriedHistory = (Array.isArray(expected.history) ? expected.history : []).filter(
        (row) =>
          row.kind === 'gap' &&
          row.reasonCode === 'seq_gap' &&
          row.chainId === expected.chainId &&
          row.epoch === expected.epoch,
      );
      if (
        (carried.length > 0 && change.epoch === expected.epoch) ||
        new Set(carried.map((row) => row.sourceId)).size !== carried.length ||
        carried.some((row) => !carriedHistory.some((gap) => gap.id === row.sourceId))
      )
        throw new TypeError('Invalid audit fork carried gaps');
      const statements: Statement[] = [
        ...assertCheck(sql`EXISTS (SELECT 1 FROM audit_chain c, json_each(${`[${snapshot}]`}) e
          WHERE c.org_id = ${org.orgId} AND ${sql.raw(
            Object.entries(chain)
              .map(([column, key]) => `c.${column} IS json_extract(e.value, '$.${key}')`)
              .join(' AND '),
          )} AND (SELECT json_group_array(json_object('id', id, 'kind', kind, 'chainId', chain_id, 'epoch', epoch, 'fromSeq', from_seq, 'toSeq', to_seq, 'reasonCode', reason_code))
            FROM (SELECT * FROM audit_ledger WHERE org_id = c.org_id AND superseded_by IS NULL
              AND ${sql.raw(relevantHistory)} ${sql.raw(historyOrder)})) IS ${JSON.stringify(expected.history ?? [])})`),
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
      const chainUpdateIndex = statements.length;
      statements.push(
        {
          sql: `UPDATE audit_chain SET epoch = ?, restore_pending = ?, boundary_reason = ? WHERE org_id = ? RETURNING org_id`,
          params: [change.epoch, Number(change.restorePending), change.boundaryReason, org.orgId],
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
        ...(carried.length === 0
          ? []
          : [
              {
                sql: `INSERT INTO audit_ledger (org_id, id, kind, chain_id, epoch, from_seq, to_seq, count,
                  sink_id, reason_code, policy, mode_generation, actor_type, actor_id, created_at)
                SELECT g.org_id, json_extract(m.value, '$.id'), 'gap', g.chain_id, ?, g.from_seq, g.to_seq,
                  g.count, NULL, 'seq_gap', g.policy, g.mode_generation, 'system', NULL, ?
                FROM json_each(?) m JOIN audit_ledger g ON g.org_id = ?
                  AND g.id = json_extract(m.value, '$.sourceId')
                WHERE g.kind = 'gap' AND g.reason_code = 'seq_gap' AND g.sink_id IS NULL
                  AND g.superseded_by IS NULL AND g.chain_id = ? AND g.epoch = ?`,
                params: [
                  change.epoch,
                  change.now,
                  JSON.stringify(carried),
                  org.orgId,
                  expected.chainId,
                  expected.epoch,
                ],
              },
            ]),
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
