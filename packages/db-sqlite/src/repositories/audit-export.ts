import { compile, db } from '../kysely.js';
import { jobLeasePredicate } from './job-lease-guard.js';
import type { AuditRow } from '@package-broker/core/audit/chain';
import type {
  AuditExportPort,
  AuditExportSnapshot,
  AuditExportState,
} from '@package-broker/core/audit/export';
import { fenceKind } from '@package-broker/core/authz/fence';
import type { SqlExecutor, SqlValue } from '@package-broker/core/db/port';

const columns: readonly {
  column: string;
  alias: keyof AuditExportState;
  value: (row: AuditExportState) => SqlValue;
}[] = [
  { column: 'sink_id', alias: 'id', value: (row) => row.id },
  { column: 'plugin_id', alias: 'pluginId', value: (row) => row.pluginId },
  { column: 'kind', alias: 'kind', value: (row) => row.kind },
  { column: 'generation', alias: 'generation', value: (row) => row.generation },
  {
    column: 'receiver_fingerprint',
    alias: 'receiverFingerprint',
    value: (row) => row.receiverFingerprint,
  },
  { column: 'durable_ack', alias: 'durableAck', value: (row) => Number(row.durableAck) },
  { column: 'activation_source', alias: 'activationSource', value: (row) => row.activationSource },
  { column: 'state', alias: 'state', value: (row) => row.state },
  { column: 'progress_seq', alias: 'progressSeq', value: (row) => row.progressSeq },
  { column: 'progress_hash', alias: 'progressHash', value: (row) => row.progressHash },
  { column: 'custody_seq', alias: 'custodySeq', value: (row) => row.custodySeq },
  { column: 'blocked_reason', alias: 'blockedReason', value: (row) => row.blockedReason },
  { column: 'inflight_from', alias: 'inflightFrom', value: (row) => row.inflightFrom },
  { column: 'inflight_to', alias: 'inflightTo', value: (row) => row.inflightTo },
  { column: 'inflight_body', alias: 'inflightBody', value: (row) => row.inflightBody },
  { column: 'inflight_repr', alias: 'inflightRepr', value: (row) => row.inflightRepr },
  { column: 'attempt', alias: 'attempt', value: (row) => row.attempt },
  { column: 'next_attempt_at', alias: 'nextAttemptAt', value: (row) => row.nextAttemptAt },
  { column: 'last_error_code', alias: 'lastErrorCode', value: (row) => row.lastErrorCode },
];
const registryOwned = new Set([
  'sink_id',
  'plugin_id',
  'kind',
  'generation',
  'receiver_fingerprint',
  'durable_ack',
  'activation_source',
]);
const writable = columns.filter(({ column }) => !registryOwned.has(column));
const values = (row: AuditExportState): SqlValue[] => columns.map(({ value }) => value(row));
const highest = 'SELECT COALESCE(MAX(generation), 0) FROM audit_sink WHERE org_id = ?';

export function createAuditExportRepository(executor: SqlExecutor): AuditExportPort {
  return {
    async read(org, sinkId) {
      const [row] = await executor.all<Omit<AuditExportSnapshot, 'sink'> & AuditExportState>({
        sql: `SELECT c.chain_id AS chainId, c.epoch, c.incarnation, c.mode_generation AS modeGeneration,
          c.boundary_seq AS boundarySeq, c.boundary_prev_hash AS boundaryPrevHash, c.policy,
          c.restore_pending AS restorePending, (${highest}) AS highestGeneration,
          ${columns.map(({ column, alias }) => `s.${column} AS "${alias}"`).join(', ')}
          FROM audit_chain c JOIN audit_sink s ON s.org_id = c.org_id
          WHERE c.org_id = ? AND s.sink_id = ?`,
        params: [org.orgId, org.orgId, sinkId],
      });
      if (row === undefined) throw new Error('Audit export snapshot unavailable');
      const {
        chainId,
        epoch,
        incarnation,
        modeGeneration,
        boundarySeq,
        boundaryPrevHash,
        policy,
        restorePending,
        highestGeneration,
        ...sink
      } = row;
      return {
        chainId,
        epoch,
        incarnation,
        modeGeneration,
        boundarySeq,
        boundaryPrevHash,
        policy,
        restorePending: Boolean(restorePending),
        highestGeneration,
        sink: { ...sink, durableAck: Boolean(sink.durableAck) },
      };
    },
    async page(org, afterSeq, limit) {
      if (
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new RangeError('Invalid audit export page');
      return executor.all<AuditRow>({
        sql: `SELECT e.* FROM audit_event e WHERE e.org_id = ? AND e.seq > ?
          AND e.seq <= (SELECT head_seq FROM audit_chain WHERE org_id = ?)
          ORDER BY e.seq ASC LIMIT ?`,
        params: [org.orgId, afterSeq, org.orgId, limit],
      });
    },
    async save(org, fence, expected, next, buildGeneration) {
      if (fenceKind(fence) !== 'system' || fence.writer !== 'audit-export')
        throw new TypeError('Invalid audit export fence');
      if (
        columns.some(
          ({ column, value }) => registryOwned.has(column) && value(next) !== value(expected.sink),
        ) ||
        !Number.isSafeInteger(buildGeneration) ||
        buildGeneration < 0
      )
        return false;
      const lease = compile({
        compile: () =>
          jobLeasePredicate(org, fence.job, `audit-export:${expected.sink.id}`).compile(db),
      });
      const [result] = await executor.batch([
        {
          sql: `UPDATE audit_sink SET ${writable.map(({ column }) => `${column} = ?`).join(', ')},
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE org_id = ? AND ${columns.map(({ column }) => `${column} IS ?`).join(' AND ')}
          AND (${highest}) = ? AND ? >= ?
          AND EXISTS (SELECT 1 FROM audit_chain c WHERE c.org_id = ?
            AND c.chain_id = ? AND c.epoch = ? AND c.incarnation = ? AND c.mode_generation = ?
            AND c.boundary_seq = ? AND c.boundary_prev_hash = ? AND c.policy = ? AND c.restore_pending = ?)
          AND ${lease.sql}
          RETURNING sink_id`,
          params: [
            ...writable.map(({ value }) => value(next)),
            org.orgId,
            ...values(expected.sink),
            org.orgId,
            expected.highestGeneration,
            buildGeneration,
            expected.highestGeneration,
            org.orgId,
            expected.chainId,
            expected.epoch,
            expected.incarnation,
            expected.modeGeneration,
            expected.boundarySeq,
            expected.boundaryPrevHash,
            expected.policy,
            Number(expected.restorePending),
            ...lease.params,
          ],
        },
      ]);
      return result?.rows.length === 1;
    },
  };
}
