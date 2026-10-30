import { raiseAuditAlert, type AuditHealthPort } from './health.js';
import type { SystemMutationFence } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import { JOB_LEASE_SECONDS } from '../platform/job-repository.js';
import { auditExportFence } from '../platform/job-fences.js';
import { JobError, type JobDefinition } from '../platform/jobs.js';
import {
  auditCustodySeq,
  auditRetryDelayMs,
  auditDurableCoverage,
  validateAuditSkipAfter,
} from './export-state.js';
export { auditCustodySeq, auditRetryDelayMs, auditDurableCoverage } from './export-state.js';
import { resolveAuditRejection, withheldAuditEntries } from './export-rejections.js';
import type { AuditLedgerEntry } from './ledger.js';
import type { AuditRow } from './chain.js';
import type { AuditBatchV1, AuditDelivery, AuditMarkerV1, AuditSink } from './plugin-api.js';
import type { AuditSinkState } from './sinks/registry.js';
import { AUDIT_SANITIZER_VERSION, auditWireRecord } from './wire.js';

export interface AuditExportState extends AuditSinkState {
  readonly attempt: number;
  readonly retryCountForSeq: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface AuditExportSnapshot {
  readonly chainId: string;
  readonly epoch: number;
  readonly incarnation: number;
  readonly modeGeneration: number;
  readonly boundarySeq: number;
  readonly boundaryPrevHash: string;
  readonly policy: 'availability' | 'required';
  readonly highestGeneration: number;
  readonly restorePending: boolean;
  /** Advisory: earned, unresolved replay resolutions remain for a drain-only save. */
  readonly replayPending?: boolean;
  readonly sink: AuditExportState;
}

export interface AuditCapacityGap {
  readonly id: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
  readonly modeGeneration: number;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditExportPort {
  capacityGap(
    org: OrgContext,
    snapshot: AuditExportSnapshot,
    afterSeq: number,
  ): Promise<AuditCapacityGap | null>;
  read(org: OrgContext, sinkId: string): Promise<AuditExportSnapshot>;
  /** Return only this organization’s sealed rows (seq <= audit_chain.head_seq), in seq order. */
  page(org: OrgContext, afterSeq: number, limit: number): Promise<readonly AuditRow[]>;
  /** In one transaction, require the org-scoped job lease identified by fence.job to
   * match id/owner/fence and resource_key = audit-export:<sink_id>, and remain unexpired at database time. CAS every field of
   * expected: chain id, epoch, incarnation, mode generation, boundary seq/hash,
   * policy, restore flag, highest build generation and every sink field (including
   * nullable body/repr and retry state). Require the acting buildGeneration >=
   * the organization’s highest stored sink generation in the same atomic batch.
   * Require next pluginId, kind, generation, receiverFingerprint, durableAck and
   * activationSource to equal expected; only the sink registry may change them.
   * Write exporter-owned fields and ledger entries atomically or nothing, including
   * retryCountForSeq in the snapshot CAS. Durable ACK saves append covering replay
   * resolutions in the same batch. Later saves drain any remaining resolutions
   * covered by persisted durableAckRanges, at most 100 ledger rows per save, even
   * after durableAck is disabled. durableCustodySeq counts dispositions as accounted
   * progress; only ACK ranges establish replay coverage. Custody is computed in core.
   * A capacity effect disposes the sink's frozen capacity marker range; it must lie inside
   * a recorded capacity gap and never adds ACK coverage.
   * Receivers must be idempotent per throughSeq when frozen batches are replayed.
   * Accepted at-least-once window: a crash or lost lease between a partial-success response
   * and its persisted disposition or hold redelivers that batch; a failed hold is alerted
   * as `hold_failed` and counted.
   */
  save(
    org: OrgContext,
    fence: SystemMutationFence,
    expected: AuditExportSnapshot,
    next: AuditExportState,
    buildGeneration: number,
    effects?: {
      readonly ledger?: readonly (AuditLedgerEntry & {
        readonly kind: 'skipped' | 'uncertain' | 'withheld';
      })[];
      readonly replayCreatedAt?: string;
      readonly durableAck?: { readonly from: number; readonly to: number } | undefined;
      /** Accepted or passed capacity marker: a disposition backed by the recorded capacity gap. */
      readonly capacity?: { readonly fromSeq: number; readonly toSeq: number } | undefined;
    },
  ): Promise<boolean>;
  /** Persist a partly accepted delivery on its frozen events batch so it is never sent again.
   * Same lease, build generation, chain identity (without the boundary) and sink CAS as save;
   * next may differ from expected.sink only by adding `uncertainOutcome` to inflightRepr. */
  hold(
    org: OrgContext,
    fence: SystemMutationFence,
    expected: AuditExportSnapshot,
    next: AuditExportState,
    buildGeneration: number,
  ): Promise<boolean>;
}

/** The partly accepted outcome held on a frozen events batch; null marks an invalid count. */
export interface AuditHeldOutcome {
  readonly rejectedCount: number | null;
}

function heldOutcome(
  repr: Representation,
): Extract<AuditDelivery, { outcome: 'uncertain' }> | undefined {
  const held = repr.uncertainOutcome as AuditHeldOutcome | undefined;
  if (held === undefined) return undefined;
  if (
    held === null ||
    typeof held !== 'object' ||
    (held.rejectedCount !== null && !Number.isSafeInteger(held.rejectedCount))
  )
    throw new Error('Audit sink representation malformed');
  return { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: held.rejectedCount ?? 0 };
}

interface Representation {
  readonly custodyFromSeq: number;
  readonly purpose?: string;
  readonly registryMarkerBody?: string;
  readonly registryMarkerOriginalAttempt?: number;
  readonly registryMarkerOriginalErrorCode?: string | null;
  readonly registryMarkers?: readonly AuditMarkerV1[];
  readonly [key: string]: unknown;
}

function representation(raw: string | null): Representation {
  try {
    const value = JSON.parse(raw ?? 'null') as Representation | null;
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Number.isSafeInteger(value.custodyFromSeq) ||
      value.custodyFromSeq < 1 ||
      (value.registryMarkers !== undefined && !Array.isArray(value.registryMarkers)) ||
      (value.registryMarkerBody !== undefined &&
        (typeof value.registryMarkerBody !== 'string' ||
          !Number.isSafeInteger(value.registryMarkerOriginalAttempt) ||
          value.registryMarkerOriginalAttempt! < 0))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('Audit sink representation malformed');
  }
}

/** Marker frontiers describe the existing progress; they never identify in-flight event seqs. */
export function auditInflightEventRange(sink: AuditSinkState): { from: number; to: number } | null {
  if (sink.inflightBody === null) return null;
  const repr = representation(sink.inflightRepr);
  if (['registry_markers', 'marker', 'disposition', 'capacity'].includes(repr.purpose ?? ''))
    return null;
  try {
    const batch = JSON.parse(sink.inflightBody) as AuditBatchV1;
    if (!batch.records.some((record) => record.kind === 'event' || record.kind === 'withheld'))
      throw new Error();
  } catch {
    throw new Error('Audit sink in-flight batch malformed');
  }
  if (sink.inflightFrom === null || sink.inflightTo === null)
    throw new Error('Audit sink in-flight range unavailable');
  return { from: sink.inflightFrom, to: sink.inflightTo };
}

const DELIVERY_ALERT_CODES = {
  skipped: 'audit.skipped',
  uncertain: 'audit.uncertain',
  blocked: 'audit.blocked',
  withheld: 'audit.withheld',
  marker_rejected: 'audit.marker_rejected',
} as const;

export interface AuditExportOptions {
  readonly health?: Pick<AuditHealthPort, 'raise'>;
  readonly id: string;
  readonly generation: number;
  /** Version of the registered plugin that supplies this sink. */
  readonly pluginVersion: string;
  /** Must match the runner lease; defaults to JOB_LEASE_SECONDS.
   * JobContext exposes no expiry; the budget assumes a fresh lease at handler entry. */
  readonly leaseSeconds?: number;
  readonly sourceIp: 'include' | 'omit';
  readonly maxBatchEvents?: number;
  readonly sink: AuditSink;
  readonly now: () => Date;
  readonly random?: () => number;
  readonly warning?: (code: 'partial_success') => void;
  /** Protocol policy: terminal for OTLP; webhook skipAfter counts retries. */
  readonly rejectionRetries: 'terminal' | number;
  /** A partial success could be neither disposed nor held; the next run redelivers it. */
  readonly holdFailed?: () => void | Promise<void>;
  readonly alert?: (
    reason: 'skipped' | 'uncertain' | 'blocked' | 'withheld' | 'marker_rejected',
  ) => void | Promise<void>;
}

function batchLimit(options: AuditExportOptions): number {
  const limit = options.maxBatchEvents ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid audit batch limit');
  return Math.min(limit, 100);
}

function deliveryBudgetMs(options: AuditExportOptions): number {
  const seconds = options.leaseSeconds ?? JOB_LEASE_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 20) throw new TypeError('Invalid audit export lease');
  return Math.max(5_000, (seconds - 15) * 1_000);
}

function frozenBatch(body: string, org: OrgContext, snapshot: AuditExportSnapshot): AuditBatchV1 {
  try {
    const batch = JSON.parse(body) as AuditBatchV1;
    if (
      batch.v !== 1 ||
      batch.orgId !== org.orgId ||
      batch.chainId !== snapshot.chainId ||
      batch.epoch !== snapshot.epoch ||
      !Array.isArray(batch.records) ||
      batch.records.length === 0 ||
      !Number.isSafeInteger(batch.throughSeq) ||
      batch.throughSeq < snapshot.sink.progressSeq ||
      !/^[a-f0-9]{64}$/.test(batch.throughHash) ||
      new TextEncoder().encode(body).length > 512 * 1024
    )
      throw new Error();
    for (const record of batch.records) {
      if (
        record.chainId !== batch.chainId ||
        record.epoch !== batch.epoch ||
        ('orgId' in record && record.orgId !== org.orgId)
      )
        throw new Error();
      Object.freeze(record);
    }
    const advancing = batch.records.filter(
      (record) => record.kind === 'event' || record.kind === 'withheld',
    );
    if (advancing.some((record, index) => record.seq !== snapshot.sink.progressSeq + index + 1))
      throw new Error();
    const last = advancing.at(-1);
    if (representation(snapshot.sink.inflightRepr).purpose === 'disposition') {
      const marker = batch.records[0];
      if (
        batch.records.length !== 1 ||
        marker === undefined ||
        (marker.kind !== 'tombstone' && marker.kind !== 'delivery_uncertain') ||
        batch.throughSeq !== snapshot.sink.inflightTo ||
        marker.hash !== batch.throughHash ||
        snapshot.sink.inflightFrom !== snapshot.sink.progressSeq + 1 ||
        (marker.kind === 'tombstone'
          ? marker.seq !== batch.throughSeq ||
            snapshot.sink.inflightFrom !== snapshot.sink.inflightTo ||
            marker.prevHash !== snapshot.sink.progressHash
          : marker.fromSeq !== snapshot.sink.inflightFrom || marker.toSeq !== batch.throughSeq)
      )
        throw new Error();
    } else if (representation(snapshot.sink.inflightRepr).purpose === 'capacity') {
      const gap = batch.records[0];
      if (
        batch.records.length !== 1 ||
        gap?.kind !== 'gap' ||
        gap.fromSeq > snapshot.sink.progressSeq + 1 ||
        gap.toSeq <= snapshot.sink.progressSeq ||
        batch.throughSeq !== gap.toSeq ||
        batch.throughHash !== gap.hash ||
        (gap.fromSeq === snapshot.sink.progressSeq + 1 &&
          gap.prevHash !== snapshot.sink.progressHash)
      )
        throw new Error();
    } else if (last === undefined) {
      if (
        batch.throughSeq !== snapshot.sink.progressSeq ||
        batch.throughHash !== snapshot.sink.progressHash ||
        !['marker', 'registry_markers'].includes(
          representation(snapshot.sink.inflightRepr).purpose ?? '',
        )
      )
        throw new Error();
    } else if (
      last.seq !== batch.throughSeq ||
      last.hash !== batch.throughHash ||
      snapshot.sink.inflightFrom !== snapshot.sink.progressSeq + 1 ||
      snapshot.sink.inflightTo !== last.seq
    )
      throw new Error();
    Object.freeze(batch.records);
    return Object.freeze(batch);
  } catch {
    throw new Error('Audit sink in-flight batch malformed');
  }
}

/** Retries a post-delivery save while only capacity eviction moves the boundary since `expected`. */
async function reconcileEviction(
  port: AuditExportPort,
  org: OrgContext,
  expected: AuditExportSnapshot,
  signal: AbortSignal,
  leaseDeadline: number,
  save: (current: AuditExportSnapshot) => Promise<boolean>,
): Promise<boolean> {
  const fields = (snapshot: AuditExportSnapshot) =>
    JSON.stringify({ ...snapshot, boundarySeq: 0, boundaryPrevHash: '', replayPending: undefined });
  const live = () => !signal.aborted && Date.now() < leaseDeadline;
  for (let attempt = 0; attempt < 10 && live(); attempt++) {
    const current = await port.read(org, expected.sink.id);
    const { boundarySeq: oldBoundary, boundaryPrevHash: oldHash } = expected;
    const { boundarySeq: newBoundary, boundaryPrevHash: newHash } = current;
    if (newBoundary <= oldBoundary || fields(expected) !== fields(current)) return false;
    let cursor = oldBoundary - 1;
    let hash = oldHash;
    for (let lookups = 0; cursor < newBoundary - 1 && lookups < 100 && live(); lookups++) {
      const gap = await port.capacityGap(org, current, cursor);
      if (
        gap === null ||
        gap.fromSeq > cursor + 1 ||
        (gap.fromSeq === cursor + 1 && gap.prevHash !== hash) ||
        gap.toSeq >= newBoundary
      )
        break;
      cursor = gap.toSeq;
      hash = gap.hash;
    }
    if (cursor !== newBoundary - 1 || hash !== newHash) return false;
    if (await save(current)) return true;
  }
  return false;
}

export async function exportAuditBatch(
  port: AuditExportPort,
  org: OrgContext,
  fence: SystemMutationFence,
  options: AuditExportOptions,
  signal: AbortSignal,
  timeoutMs = deliveryBudgetMs(options),
): Promise<'idle' | 'contended' | 'accepted' | 'retry' | 'resolved'> {
  const originalOptions = options;
  options = {
    ...options,
    alert: async (reason) => {
      await raiseAuditAlert(originalOptions.health, org, DELIVERY_ALERT_CODES[reason]);
      await originalOptions.alert?.(reason);
    },
    holdFailed: async () => {
      await raiseAuditAlert(originalOptions.health, org, 'audit.hold_failed');
      await originalOptions.holdFailed?.();
    },
  };
  if (options.rejectionRetries !== 'terminal') validateAuditSkipAfter(options.rejectionRetries);
  const originalPort = port;
  port = {
    ...port,
    save: (org, fence, expected, next, generation, effects) =>
      originalPort.save(org, fence, expected, next, generation, {
        ...effects,
        replayCreatedAt: options.now().toISOString(),
      }),
  };
  if (signal.aborted) return 'idle';
  const deadline = Date.now() + Math.min(timeoutMs, deliveryBudgetMs(options));
  let snapshot = await port.read(org, options.id);
  let sink = snapshot.sink;
  if (sink.id !== options.id || fence.writer !== 'audit-export')
    throw new Error('Invalid audit export context');
  if (
    snapshot.restorePending ||
    sink.state !== 'active' ||
    options.generation < snapshot.highestGeneration ||
    (sink.nextAttemptAt !== null && Date.parse(sink.nextAttemptAt) > options.now().getTime())
  )
    return 'idle';
  let repr = representation(sink.inflightRepr);
  let ledger: readonly (AuditLedgerEntry & { readonly kind: 'withheld' })[] = [];
  // Queued registry markers precede a frozen original, without replacing its persisted bytes.
  const queued = repr.registryMarkers;
  let body = sink.inflightBody;
  if (queued !== undefined && queued.length > 0) {
    body =
      repr.registryMarkerBody ??
      JSON.stringify({
        v: 1,
        chainId: snapshot.chainId,
        epoch: snapshot.epoch,
        orgId: org.orgId,
        records: queued,
        throughSeq: sink.progressSeq,
        throughHash: sink.progressHash,
      });
    repr = {
      ...repr,
      registryMarkerBody: body,
      registryMarkerOriginalAttempt: repr.registryMarkerOriginalAttempt ?? sink.attempt,
      registryMarkerOriginalErrorCode:
        repr.registryMarkerBody === undefined
          ? sink.lastErrorCode
          : (repr.registryMarkerOriginalErrorCode ?? null),
    };
    sink = { ...sink, inflightRepr: JSON.stringify(repr) };
  } else if (body === null) {
    const limit = batchLimit(options);
    const gap = await port.capacityGap(org, snapshot, sink.progressSeq);
    if (gap != null) {
      const count = gap.count - (sink.progressSeq + 1 - gap.fromSeq);
      if (
        count < 1 ||
        gap.fromSeq > sink.progressSeq + 1 ||
        gap.toSeq <= sink.progressSeq ||
        (gap.fromSeq === sink.progressSeq + 1 && gap.prevHash !== sink.progressHash)
      )
        throw new Error('Audit delivery range unavailable');
      body = JSON.stringify({
        v: 1,
        chainId: snapshot.chainId,
        epoch: snapshot.epoch,
        orgId: org.orgId,
        records: [
          {
            kind: 'gap',
            markerId: gap.id,
            chainId: snapshot.chainId,
            epoch: snapshot.epoch,
            fromSeq: sink.progressSeq + 1,
            toSeq: gap.toSeq,
            count,
            prevHash: sink.progressHash,
            hash: gap.hash,
            reason: 'capacity',
            policyGeneration: gap.modeGeneration,
          },
        ],
        throughSeq: gap.toSeq,
        throughHash: gap.hash,
      });
      repr = { ...repr, purpose: 'capacity' };
      sink = {
        ...sink,
        inflightFrom: sink.progressSeq + 1,
        inflightTo: gap.toSeq,
        inflightBody: body,
        inflightRepr: JSON.stringify(repr),
      };
    } else {
      const rows = await port.page(org, sink.progressSeq, limit);
      const records: AuditBatchV1['records'][number][] = [];
      let throughSeq = sink.progressSeq;
      let throughHash = sink.progressHash;
      for (const row of rows.slice(0, limit)) {
        if (row.org_id !== org.orgId || row.seq !== throughSeq + 1 || row.prev_hash !== throughHash)
          throw new Error('Audit delivery range unavailable');
        const record = await auditWireRecord(
          { chainId: snapshot.chainId, epoch: snapshot.epoch, orgId: org.orgId },
          row,
          options.sourceIp,
        );
        const candidate: AuditBatchV1 = {
          v: 1,
          chainId: snapshot.chainId,
          epoch: snapshot.epoch,
          orgId: org.orgId,
          records: [...records, record],
          throughSeq: row.seq,
          throughHash: row.hash,
        };
        if (new TextEncoder().encode(JSON.stringify(candidate)).length > 512 * 1024) break;
        records.push(record);
        throughSeq = row.seq;
        throughHash = row.hash;
      }
      if (records.length === 0) {
        if (rows.length > 0) throw new Error('Audit delivery record too large');
        if (snapshot.replayPending)
          return (await port.save(org, fence, snapshot, sink, options.generation))
            ? 'resolved'
            : 'contended';
        return 'idle';
      }
      body = JSON.stringify({
        v: 1,
        chainId: snapshot.chainId,
        epoch: snapshot.epoch,
        orgId: org.orgId,
        records,
        throughSeq,
        throughHash,
      });
      repr = {
        ...repr,
        v: 1,
        sanitizerVersion: AUDIT_SANITIZER_VERSION,
        pluginVersion: options.pluginVersion,
        sourceIp: options.sourceIp,
        purpose: 'events',
      };
      ledger = withheldAuditEntries(snapshot, records, options.now());
      sink = {
        ...sink,
        inflightFrom: sink.progressSeq + 1,
        inflightTo: throughSeq,
        inflightBody: body,
        inflightRepr: JSON.stringify(repr),
      };
    }
  }
  const markersOnly = queued !== undefined && queued.length > 0;
  const batch = frozenBatch(body!, org, {
    ...snapshot,
    sink: markersOnly
      ? { ...sink, inflightRepr: JSON.stringify({ ...repr, purpose: 'registry_markers' }) }
      : sink,
  });
  let custodySeq = sink.custodySeq;
  for (const entry of ledger)
    custodySeq = auditCustodySeq(
      { ...sink, custodySeq },
      {
        from: entry.fromSeq,
        to: entry.toSeq,
        kind: 'disposed',
      },
    );
  const sending = {
    ...sink,
    custodySeq,
    attempt: sink.attempt + 1,
    inflightRepr: JSON.stringify({ ...repr, ...auditDurableCoverage(sink, undefined, ledger) }),
  };
  repr = representation(sending.inflightRepr);
  // Outcomes of a completed delivery survive a concurrent capacity eviction; a retry schedule
  // does not need to, because contention re-sends the same frozen batch.
  // deliveryBudgetMs leaves 15 s of the lease after the delivery deadline.
  const leaseDeadline = deadline + 10_000;
  const sendingPort = port;
  const reconciling: AuditExportPort = {
    ...port,
    save: async (org, fence, expected, next, generation, effects) =>
      (await sendingPort.save(org, fence, expected, next, generation, effects)) ||
      (await reconcileEviction(sendingPort, org, expected, signal, leaseDeadline, (current) =>
        sendingPort.save(org, fence, current, next, generation, effects),
      )),
  };
  const held = !markersOnly && repr.purpose === 'events' ? heldOutcome(repr) : undefined;
  if (held !== undefined)
    return (await resolveAuditRejection(reconciling, org, fence, snapshot, batch, held, options))
      ? 'resolved'
      : 'contended';
  if (signal.aborted || Date.now() >= deadline) return 'idle';
  if (!(await port.save(org, fence, snapshot, sending, options.generation, { ledger })))
    return 'contended';
  if (ledger.length > 0) await options.alert?.('withheld');
  snapshot = { ...snapshot, sink: sending };
  if (signal.aborted || Date.now() >= deadline) return 'idle';
  let result: AuditDelivery;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => options.sink.deliver(batch, controller.signal)),
      new Promise<AuditDelivery>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => resolve({ outcome: 'retry', code: 'timeout' }),
          { once: true },
        );
        timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } catch {
    result = { outcome: 'retry', code: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  // A partly accepted batch must never be sent again, so its outcome is kept even when aborting.
  if (signal.aborted && result?.outcome !== 'uncertain') return 'idle';
  const codes = ['network', 'timeout', 'refused', 'too_large', 'http_status', 'bad_response'];
  if (result?.outcome === 'rejected' && !codes.includes(result.code))
    result = { outcome: 'retry', code: 'bad_response' };
  if (result?.outcome === 'rejected' || result?.outcome === 'uncertain') {
    if (await resolveAuditRejection(reconciling, org, fence, snapshot, batch, result, options))
      return 'resolved';
    if (result.outcome === 'uncertain' && !markersOnly && repr.purpose === 'events') {
      const held: AuditHeldOutcome = {
        rejectedCount: Number.isSafeInteger(result.rejectedCount) ? result.rejectedCount : null,
      };
      if (
        !(await port.hold(
          org,
          fence,
          snapshot,
          { ...snapshot.sink, inflightRepr: JSON.stringify({ ...repr, uncertainOutcome: held }) },
          options.generation,
        ))
      )
        await options.holdFailed?.();
    }
    return 'contended';
  }
  if (
    (result?.outcome === 'accepted' || result?.outcome === 'accepted_with_warning') &&
    result.chainId === batch.chainId &&
    result.epoch === batch.epoch &&
    result.throughSeq === batch.throughSeq &&
    result.throughHash === batch.throughHash &&
    (result.outcome !== 'accepted_with_warning' || result.code === 'partial_success')
  ) {
    const rest = { ...repr };
    delete rest.registryMarkers;
    delete rest.registryMarkerBody;
    delete rest.registryMarkerOriginalAttempt;
    delete rest.registryMarkerOriginalErrorCode;
    if (markersOnly) {
      const delivered = new Set(
        batch.records.filter((record) => 'markerId' in record).map((record) => record.markerId),
      );
      const remaining = queued!.filter((marker) => !delivered.has(marker.markerId));
      if (remaining.length > 0) rest.registryMarkers = remaining;
    }
    const tails = !markersOnly
      ? (repr.rejectionTail as readonly AuditBatchV1[] | undefined)
      : undefined;
    const tail = tails?.[0];
    if (!markersOnly) {
      delete rest.rejectionTail;
      if (tails !== undefined && tails.length > 1) rest.rejectionTail = tails.slice(1);
    }
    // Marker acceptance recomputes the ledger-backed custody frontier idempotently.
    const disposed = repr.purpose === 'disposition';
    const capacityLoss = !markersOnly && repr.purpose === 'capacity';
    const capacity = capacityLoss
      ? { fromSeq: sending.progressSeq + 1, toSeq: batch.throughSeq }
      : undefined;
    const durableAck =
      !markersOnly && !disposed && sending.durableAck && auditInflightEventRange(sending) !== null
        ? { from: sending.inflightFrom!, to: batch.throughSeq }
        : undefined;
    Object.assign(rest, auditDurableCoverage(sending, durableAck, capacity ? [capacity] : []));
    const next = {
      ...sending,
      retryCountForSeq: markersOnly ? sending.retryCountForSeq : 0,
      attempt: markersOnly ? repr.registryMarkerOriginalAttempt! : 0,
      nextAttemptAt: null,
      lastErrorCode: markersOnly
        ? (repr.registryMarkerOriginalErrorCode ?? null)
        : result.outcome === 'accepted_with_warning'
          ? result.code
          : null,
      progressSeq: markersOnly ? sending.progressSeq : batch.throughSeq,
      progressHash: markersOnly ? sending.progressHash : batch.throughHash,
      custodySeq:
        !markersOnly && (disposed || capacityLoss || auditInflightEventRange(sending) !== null)
          ? auditCustodySeq(sending, {
              from: capacity ? capacity.fromSeq : sending.inflightFrom!,
              to: batch.throughSeq,
              kind: disposed || capacityLoss ? 'disposed' : 'durable_ack',
            })
          : sending.custodySeq,
      inflightFrom: markersOnly ? sending.inflightFrom : tail ? batch.throughSeq + 1 : null,
      inflightTo: markersOnly ? sending.inflightTo : (tail?.throughSeq ?? null),
      inflightBody: markersOnly ? sending.inflightBody : tail ? JSON.stringify(tail) : null,
      inflightRepr: JSON.stringify(
        markersOnly ? rest : { ...rest, purpose: tail ? 'events' : 'idle' },
      ),
    };
    const saved = await reconciling.save(org, fence, snapshot, next, options.generation, {
      durableAck,
      capacity,
    });
    if (saved && result.outcome === 'accepted_with_warning') options.warning?.(result.code);
    return saved ? 'accepted' : 'contended';
  }
  const retry = result?.outcome === 'retry' && codes.includes(result.code) ? result : null;
  const retryAfter = retry?.retryAfterMs;
  const delay = auditRetryDelayMs(
    sending.attempt,
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter
      : 0,
    options.random,
  );
  const now = options.now().getTime();
  const next = {
    ...sending,
    lastErrorCode: retry?.code ?? 'bad_response',
    nextAttemptAt: new Date(now + Math.min(delay, 8.64e15 - now)).toISOString(),
  };
  return (await port.save(org, fence, snapshot, next, options.generation)) ? 'retry' : 'contended';
}

export function auditExportJob(
  port: AuditExportPort,
  options: AuditExportOptions,
): JobDefinition<Record<string, never>> {
  if (
    !/^[a-z0-9-]{1,32}$/.test(options.id) ||
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    typeof options.pluginVersion !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(options.pluginVersion)
  )
    throw new TypeError('Invalid audit export configuration');
  if (options.rejectionRetries !== 'terminal') validateAuditSkipAfter(options.rejectionRetries);
  options = { ...options, maxBatchEvents: batchLimit(options) };
  const budgetMs = deliveryBudgetMs(options);
  return {
    name: `audit-export-${options.id}`,
    version: 1,
    schedule: { everySeconds: 60, resourceKey: `audit-export:${options.id}` },
    maxAttempts: 3,
    validate(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        (Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null) ||
        Reflect.ownKeys(input).length !== 0
      )
        throw new JobError('invalid_payload');
      return {};
    },
    async handler(_payload, ctx) {
      const fence = auditExportFence(ctx);
      if (fence === null) throw new JobError('lease_lost');
      const deadline = Date.now() + budgetMs;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || ctx.signal.aborted) break;
        const result = await exportAuditBatch(
          port,
          ctx.org,
          fence,
          {
            ...options,
            alert: async (reason) => {
              ctx.observability.log({
                level: 'error',
                event: 'audit.delivery_loss',
                reason_code: DELIVERY_ALERT_CODES[reason],
                sink_id: options.id,
              });
              await options.alert?.(reason);
            },
            holdFailed: async () => {
              ctx.observability.log({
                level: 'error',
                event: 'audit.delivery_loss',
                reason_code: 'audit.hold_failed',
                sink_id: options.id,
              });
              ctx.observability.counter('pb.audit.hold_failed_total');
              await options.holdFailed?.();
            },
            warning: (code) => {
              ctx.observability.log({
                level: 'warn',
                event: 'audit.delivery_partial_success',
                reason_code: 'audit.partial_success',
                sink_id: options.id,
              });
              options.warning?.(code);
            },
          },
          ctx.signal,
          remaining,
        );
        if (
          result !== 'accepted' &&
          (result !== 'resolved' ||
            (await port.read(ctx.org, options.id)).sink.nextAttemptAt !== null)
        )
          break;
      } while (!ctx.signal.aborted && Date.now() < deadline);
    },
  };
}
