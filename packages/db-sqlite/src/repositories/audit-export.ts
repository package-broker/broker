import { sql } from 'kysely';
import { createAuditLedgerRepository, auditLedgerError } from './audit-ledger.js';
import { DbError, ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { ulid } from '@package-broker/core/ids';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { assertCheck, compile, db } from '../kysely.js';
import { jobLeasePredicate } from './job-lease-guard.js';
import type { AuditRow } from '@package-broker/core/audit/chain';
import { auditDurableCoverage } from '@package-broker/core/audit/export';
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
  {
    column: 'retry_count_for_seq',
    alias: 'retryCountForSeq',
    value: (row) => row.retryCountForSeq,
  },
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

/** Workers deployments require Workers Paid (1,000 D1 queries per invocation).
 * Saves keep chunks of 100 ledger rows, at most 102 batch statements and 100 parameters per statement.
 */
export function createAuditExportRepository(executor: SqlExecutor): AuditExportPort {
  async function unresolved(
    orgId: string,
    snapshot: AuditExportSnapshot,
    ranges: readonly { from: number; to: number }[],
    limit: number,
  ) {
    if (ranges.length === 0 || limit === 0) return [];
    return executor.all<{ id: string; fromSeq: number; toSeq: number; count: number }>({
      sql: `SELECT u.id, u.from_seq AS fromSeq, u.to_seq AS toSeq, u.count FROM audit_ledger u
        WHERE u.org_id = ? AND u.chain_id = ? AND u.epoch = ? AND u.sink_id = ?
          AND u.kind = 'uncertain' AND EXISTS (SELECT 1 FROM json_each(?) coverage
            WHERE u.from_seq >= json_extract(coverage.value, '$.from')
              AND u.to_seq <= json_extract(coverage.value, '$.to'))
          AND NOT EXISTS (SELECT 1 FROM audit_ledger r WHERE r.org_id = ?
            AND r.kind = 'replay' AND r.resolves_id = u.id) ORDER BY u.id LIMIT ?`,
      params: [
        orgId,
        snapshot.chainId,
        snapshot.epoch,
        snapshot.sink.id,
        JSON.stringify(ranges),
        orgId,
        limit,
      ],
    });
  }
  return {
    async capacityGap(org, snapshot, afterSeq) {
      const gap = await createAuditLedgerRepository(executor).capacityGap(
        org,
        snapshot.chainId,
        snapshot.epoch,
        afterSeq,
      );
      if (gap === null || gap.capacity === undefined) return null;
      return {
        id: gap.id,
        fromSeq: gap.fromSeq,
        toSeq: gap.toSeq,
        count: gap.count,
        modeGeneration: gap.modeGeneration,
        prevHash: gap.capacity.prevHash,
        hash: gap.capacity.hash,
      };
    },
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
      const snapshot: AuditExportSnapshot = {
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
      const coverage = auditDurableCoverage(snapshot.sink);
      return {
        ...snapshot,
        replayPending:
          (await unresolved(org.orgId, snapshot, coverage.durableAckRanges, 1)).length > 0,
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
    async hold(org, fence, expected, next, buildGeneration) {
      if (fenceKind(fence) !== 'system' || fence.writer !== 'audit-export')
        throw new TypeError('Invalid audit export fence');
      const parse = (raw: string | null) => {
        try {
          const value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
          return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
        } catch {
          return null;
        }
      };
      const before = parse(expected.sink.inflightRepr);
      const after = parse(next.inflightRepr);
      const held = after?.uncertainOutcome as { rejectedCount?: unknown } | undefined;
      const rest = after === null ? null : { ...after };
      if (rest !== null) delete rest.uncertainOutcome;
      if (
        before === null ||
        before.purpose !== 'events' ||
        'uncertainOutcome' in before ||
        expected.sink.inflightBody === null ||
        held === null ||
        typeof held !== 'object' ||
        Object.keys(held).join() !== 'rejectedCount' ||
        (held.rejectedCount !== null && !Number.isSafeInteger(held.rejectedCount)) ||
        JSON.stringify(rest) !== JSON.stringify(before) ||
        columns.some(
          ({ column, value }) => column !== 'inflight_repr' && value(next) !== value(expected.sink),
        ) ||
        !Number.isSafeInteger(buildGeneration) ||
        buildGeneration < 0
      )
        throw new TypeError('Invalid audit export hold');
      const lease = compile({
        compile: () =>
          jobLeasePredicate(org, fence.job, `audit-export:${expected.sink.id}`).compile(db),
      });
      try {
        const rows = await executor.all<{ sink_id: string }>({
          sql: `UPDATE audit_sink SET inflight_repr = ?, body_version = body_version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE org_id = ? AND ${columns.map(({ column }) => `${column} IS ?`).join(' AND ')}
            AND (${highest}) = ? AND ? >= ?
            AND EXISTS (SELECT 1 FROM audit_chain c WHERE c.org_id = ?
              AND c.chain_id = ? AND c.epoch = ? AND c.incarnation = ? AND c.mode_generation = ?
              AND c.policy = ? AND c.restore_pending = 0)
            AND ${lease.sql}
            RETURNING sink_id`,
          params: [
            next.inflightRepr,
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
            expected.policy,
            ...lease.params,
          ],
        });
        return rows.length === 1;
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
    async save(org, fence, expected, next, buildGeneration, effects) {
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
      if (
        (effects?.ledger?.length ?? 0) > 100 ||
        effects?.ledger?.some((entry) => !['skipped', 'uncertain', 'withheld'].includes(entry.kind))
      )
        throw new TypeError('Invalid audit export ledger entries');
      const entries: AuditLedgerEntry[] = [...(effects?.ledger ?? [])];
      const ack = effects?.durableAck;
      if (ack !== undefined) {
        if (
          !expected.sink.durableAck ||
          ack.from !== expected.sink.inflightFrom ||
          ack.to !== expected.sink.inflightTo ||
          next.progressSeq !== ack.to
        )
          throw new TypeError('Invalid audit durable acknowledgement');
      }
      const capacity = effects?.capacity;
      if (capacity !== undefined) {
        let purpose: unknown;
        try {
          purpose = (JSON.parse(expected.sink.inflightRepr ?? 'null') as { purpose?: unknown })
            ?.purpose;
        } catch {
          purpose = undefined;
        }
        const gap =
          purpose === 'capacity' &&
          ack === undefined &&
          capacity.fromSeq === expected.sink.progressSeq + 1 &&
          capacity.fromSeq === expected.sink.inflightFrom &&
          capacity.toSeq === expected.sink.inflightTo &&
          next.progressSeq === capacity.toSeq
            ? await createAuditLedgerRepository(executor).capacityGap(
                org,
                expected.chainId,
                expected.epoch,
                capacity.fromSeq - 1,
              )
            : null;
        if (gap === null || gap.fromSeq > capacity.fromSeq || gap.toSeq < capacity.toSeq)
          throw new TypeError('Invalid audit capacity disposition');
      }
      const coverage = auditDurableCoverage(expected.sink, ack, [
        ...(effects?.ledger ?? []),
        ...(capacity === undefined ? [] : [capacity]),
      ]);
      const nextCoverage = auditDurableCoverage(next);
      if (nextCoverage.durableCustodySeq !== coverage.durableCustodySeq)
        throw new TypeError('Invalid audit durable custody frontier');
      if (
        JSON.stringify(nextCoverage.durableAckRanges) !== JSON.stringify(coverage.durableAckRanges)
      )
        throw new TypeError('Invalid audit durable acknowledgement coverage');

      if (coverage.durableAckRanges.length > 0) {
        const uncertain = await unresolved(
          org.orgId,
          expected,
          coverage.durableAckRanges,
          100 - entries.length,
        );
        const createdAt = effects?.replayCreatedAt;
        if (
          uncertain.length > 0 &&
          (createdAt === undefined || !Number.isFinite(Date.parse(createdAt)))
        )
          throw new TypeError('Audit replay timestamp unavailable');
        entries.push(
          ...uncertain.map((row): AuditLedgerEntry => ({
            id: ulid(Date.parse(createdAt!)),
            kind: 'replay',
            chainId: expected.chainId,
            epoch: expected.epoch,
            fromSeq: row.fromSeq,
            toSeq: row.toSeq,
            count: row.count,
            sinkId: expected.sink.id,
            resolvesId: row.id,
            reasonCode: 'durable_ack',
            policy: expected.policy,
            modeGeneration: expected.modeGeneration,
            actorType: 'system',
            actorId: null,
            createdAt: createdAt!,
          })),
        );
      }
      if (
        entries.length > 100 ||
        entries.some(
          (entry) =>
            entry.chainId !== expected.chainId ||
            entry.epoch !== expected.epoch ||
            entry.sinkId !== expected.sink.id ||
            entry.kind === 'gap',
        )
      )
        throw new TypeError('Invalid audit export ledger entries');
      const ledger = entries.flatMap((entry) =>
        createAuditLedgerRepository(executor)
          .statements(org, [entry])
          .map((statement) => {
            if (entry.kind !== 'replay' && entry.kind !== 'withheld') return statement;
            return {
              sql: `${statement.sql} AND NOT EXISTS (SELECT 1 FROM audit_ledger duplicate
            WHERE duplicate.org_id = ? AND duplicate.kind = ? AND ${
              entry.kind === 'replay'
                ? 'duplicate.resolves_id = ?'
                : 'duplicate.chain_id = ? AND duplicate.epoch = ? AND duplicate.sink_id IS ? AND duplicate.from_seq = ?'
            })`,
              params: [
                ...statement.params,
                org.orgId,
                entry.kind,
                ...(entry.kind === 'replay'
                  ? [entry.resolvesId ?? null]
                  : [entry.chainId, entry.epoch, entry.sinkId, entry.fromSeq]),
              ],
            };
          }),
      );
      try {
        const [result] = await executor.batch([
          {
            sql: `UPDATE audit_sink SET ${writable.map(({ column }) => `${column} = ?`).join(', ')},
          body_version = body_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
          ...(ledger.length === 0 ? [] : assertCheck(sql`changes() = 1`)),
          ...ledger,
        ]);
        return result?.rows.length === 1;
      } catch (error) {
        if (
          error instanceof DbError &&
          error.kind === 'unique' &&
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
        )
          return false;
        throw auditLedgerError(error);
      }
    },
  };
}
