import type { SystemMutationFence } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import { auditCustodySeq, auditRetryDelayMs, auditDurableCoverage } from './export-state.js';
import type { AuditExportOptions, AuditExportPort, AuditExportSnapshot } from './export.js';
import type { AuditLedgerEntry } from './ledger.js';
import type { AuditBatchV1, AuditDelivery } from './plugin-api.js';
import { auditWireMarker } from './wire.js';

function entry(
  snapshot: AuditExportSnapshot,
  kind: 'skipped' | 'uncertain' | 'withheld',
  fromSeq: number,
  toSeq: number,
  reasonCode: string,
  now: Date,
): AuditLedgerEntry & { readonly kind: 'skipped' | 'uncertain' | 'withheld' } {
  return {
    id: ulid(),
    kind,
    chainId: snapshot.chainId,
    epoch: snapshot.epoch,
    fromSeq,
    toSeq,
    count: toSeq - fromSeq + 1,
    sinkId: snapshot.sink.id,
    reasonCode,
    policy: snapshot.policy,
    modeGeneration: snapshot.modeGeneration,
    actorType: 'system',
    actorId: null,
    createdAt: now.toISOString(),
  };
}

export function withheldAuditEntries(
  snapshot: AuditExportSnapshot,
  records: AuditBatchV1['records'],
  now: Date,
): readonly (AuditLedgerEntry & { readonly kind: 'withheld' })[] {
  return records.flatMap((record) =>
    record.kind === 'withheld'
      ? [
          {
            ...entry(snapshot, 'withheld', record.seq, record.seq, record.reasonCode, now),
            kind: 'withheld' as const,
          },
        ]
      : [],
  );
}

export async function resolveAuditRejection(
  port: AuditExportPort,
  org: OrgContext,
  fence: SystemMutationFence,
  snapshot: AuditExportSnapshot,
  batch: AuditBatchV1,
  result: Extract<AuditDelivery, { outcome: 'rejected' | 'uncertain' }>,
  options: AuditExportOptions,
): Promise<boolean> {
  const sink = snapshot.sink;
  let repr: Record<string, unknown>;
  try {
    repr = JSON.parse(sink.inflightRepr!) as Record<string, unknown>;
    if (repr === null || typeof repr !== 'object' || Array.isArray(repr)) throw new Error();
  } catch {
    throw new Error('Audit sink representation malformed');
  }
  delete repr.uncertainOutcome;
  const now = options.now();
  const records = batch.records;
  if (
    repr.registryMarkerBody !== undefined ||
    repr.purpose !== 'events' ||
    records.some((record) => record.kind !== 'event' && record.kind !== 'withheld')
  ) {
    const required = snapshot.policy === 'required';
    const queued = repr.registryMarkerBody !== undefined;
    const tails = repr.rejectionTail as readonly AuditBatchV1[] | undefined;
    const tail = tails?.[0];
    const rest = { ...repr };
    if (queued) {
      delete rest.registryMarkers;
      delete rest.registryMarkerBody;
      delete rest.registryMarkerOriginalAttempt;
      delete rest.registryMarkerOriginalErrorCode;
      const delivered = new Set(
        batch.records.filter((record) => 'markerId' in record).map((record) => record.markerId),
      );
      const remaining = ((repr.registryMarkers ?? []) as AuditBatchV1['records']).filter(
        (record) => !('markerId' in record) || !delivered.has(record.markerId),
      );
      if (remaining.length > 0) rest.registryMarkers = remaining;
    } else {
      delete rest.rejectionTail;
      if (tails && tails.length > 1) rest.rejectionTail = tails.slice(1);
      rest.purpose = tail ? 'events' : 'idle';
    }
    // A passed capacity marker still accounts for the evicted range, like an accepted one.
    const capacity =
      !queued && !required && repr.purpose === 'capacity'
        ? { fromSeq: sink.progressSeq + 1, toSeq: batch.throughSeq }
        : undefined;
    if (capacity) Object.assign(rest, auditDurableCoverage(sink, undefined, [capacity]));
    const saved = await port.save(
      org,
      fence,
      snapshot,
      required
        ? {
            ...sink,
            state: 'blocked',
            blockedReason: result.outcome,
            lastErrorCode: result.code,
            nextAttemptAt: null,
          }
        : {
            ...sink,
            progressSeq: queued ? sink.progressSeq : batch.throughSeq,
            progressHash: queued ? sink.progressHash : batch.throughHash,
            custodySeq: capacity
              ? auditCustodySeq(sink, {
                  from: capacity.fromSeq,
                  to: capacity.toSeq,
                  kind: 'disposed',
                })
              : sink.custodySeq,
            attempt: queued ? (repr.registryMarkerOriginalAttempt as number) : 0,
            nextAttemptAt: null,
            lastErrorCode: queued
              ? ((repr.registryMarkerOriginalErrorCode as string | null) ?? null)
              : result.code,
            inflightFrom: queued ? sink.inflightFrom : tail ? batch.throughSeq + 1 : null,
            inflightTo: queued ? sink.inflightTo : (tail?.throughSeq ?? null),
            inflightBody: queued ? sink.inflightBody : tail ? JSON.stringify(tail) : null,
            inflightRepr: JSON.stringify(rest),
          },
      options.generation,
      capacity ? { capacity } : undefined,
    );
    if (saved) options.alert?.(required ? 'blocked' : 'marker_rejected');
    return saved;
  }
  if (result.outcome === 'rejected' && records.length > 1) {
    const middle = Math.ceil(records.length / 2);
    const left = records.slice(0, middle);
    const last = left.at(-1)!;
    if (!('seq' in last) || !('hash' in last)) throw new Error('Audit rejection range unavailable');
    const tail = [
      { ...batch, records: records.slice(middle) },
      ...((repr.rejectionTail ?? []) as readonly AuditBatchV1[]),
    ];
    return port.save(
      org,
      fence,
      snapshot,
      {
        ...sink,
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: result.code,
        inflightTo: last.seq,
        inflightBody: JSON.stringify({
          ...batch,
          records: left,
          throughSeq: last.seq,
          throughHash: last.hash,
        }),
        inflightRepr: JSON.stringify({ ...repr, rejectionTail: tail }),
      },
      options.generation,
    );
  }
  const count = sink.retryCountForSeq + 1;
  if (result.outcome === 'rejected' && snapshot.policy === 'required') {
    const saved = await port.save(
      org,
      fence,
      snapshot,
      {
        ...sink,
        state: 'blocked',
        blockedReason: 'rejected',
        lastErrorCode: result.code,
        retryCountForSeq: count,
        nextAttemptAt: null,
      },
      options.generation,
    );
    if (saved) options.alert?.('blocked');
    return saved;
  }
  if (
    result.outcome === 'rejected' &&
    options.rejectionRetries !== 'terminal' &&
    count <= options.rejectionRetries
  ) {
    return port.save(
      org,
      fence,
      snapshot,
      {
        ...sink,
        retryCountForSeq: count,
        lastErrorCode: result.code,
        nextAttemptAt: new Date(
          now.getTime() + auditRetryDelayMs(count, 0, options.random),
        ).toISOString(),
      },
      options.generation,
    );
  }
  const first = records[0]!;
  if (!('seq' in first) || !('prevHash' in first))
    throw new Error('Audit rejection range unavailable');
  const kind = result.outcome === 'uncertain' ? 'uncertain' : 'skipped';
  const reasonCode = result.code;
  const marker = await auditWireMarker(
    { chainId: snapshot.chainId, epoch: snapshot.epoch },
    kind === 'uncertain'
      ? {
          kind: 'delivery_uncertain',
          fromSeq: first.seq,
          toSeq: batch.throughSeq,
          hash: batch.throughHash,
          reasonCode,
        }
      : {
          kind: 'tombstone',
          seq: first.seq,
          prevHash: first.prevHash,
          hash: batch.throughHash,
          reasonCode,
        },
  );
  const saved = await port.save(
    org,
    fence,
    snapshot,
    {
      ...sink,
      attempt: 0,
      retryCountForSeq: 0,
      nextAttemptAt: null,
      lastErrorCode: reasonCode,
      state: snapshot.policy === 'required' ? 'blocked' : 'active',
      blockedReason: snapshot.policy === 'required' ? 'uncertain' : sink.blockedReason,
      custodySeq: auditCustodySeq(sink, {
        from: first.seq,
        to: batch.throughSeq,
        kind: 'disposed',
      }),
      inflightBody: JSON.stringify({ ...batch, records: [marker] }),
      inflightRepr: JSON.stringify({
        ...repr,
        purpose: 'disposition',
        ...auditDurableCoverage(sink, undefined, [{ fromSeq: first.seq, toSeq: batch.throughSeq }]),
      }),
    },
    options.generation,
    {
      ledger: [
        {
          ...entry(snapshot, kind, first.seq, batch.throughSeq, reasonCode, now),
          count:
            result.outcome === 'uncertain' &&
            Number.isSafeInteger(result.rejectedCount) &&
            result.rejectedCount >= 1 &&
            result.rejectedCount <= records.length
              ? result.rejectedCount
              : batch.throughSeq - first.seq + 1,
        },
      ],
    },
  );
  if (saved) {
    options.alert?.(kind);
    if (snapshot.policy === 'required') options.alert?.('blocked');
  }
  return saved;
}
