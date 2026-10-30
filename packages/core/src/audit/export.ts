import type { SystemMutationFence } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import { JOB_LEASE_SECONDS } from '../platform/job-repository.js';
import { auditExportFence } from '../platform/job-fences.js';
import { JobError, type JobDefinition } from '../platform/jobs.js';
import type { AuditRow } from './chain.js';
import type { AuditBatchV1, AuditDelivery, AuditMarkerV1, AuditSink } from './plugin-api.js';
import type { AuditSinkState } from './sinks/registry.js';
import { AUDIT_SANITIZER_VERSION, auditWireRecord } from './wire.js';

export interface AuditExportState extends AuditSinkState {
  readonly attempt: number;
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
  readonly sink: AuditExportState;
}

export interface AuditExportPort {
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
   * activationSource to equal expected; only the G13 registry may change them.
   * Write all other next sink fields atomically or nothing. G15b must add
   * retry_count_for_seq to this CAS when it introduces that retry state.
   * Return false on any mismatch or lease expiry. No HTTP precedes a true save.
   * Custody is computed in core, including ledger-backed G15b dispositions; the
   * adapter must not infer custody from progress or independently reconcile it.
   * Receivers must be idempotent per throughSeq when frozen batches are replayed.
   */
  save(
    org: OrgContext,
    fence: SystemMutationFence,
    expected: AuditExportSnapshot,
    next: AuditExportState,
    buildGeneration: number,
  ): Promise<boolean>;
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
  if (repr.purpose === 'registry_markers' || repr.purpose === 'marker') return null;
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

export function auditRetryDelayMs(attempt: number, retryAfterMs = 0, random = Math.random): number {
  const jitter = random();
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs < 0 ||
    !Number.isFinite(jitter) ||
    jitter < 0 ||
    jitter > 1
  )
    throw new TypeError('Invalid audit retry delay');
  return Math.max(
    Math.min(900_000, 5_000 * 2 ** Math.min(attempt - 1, 30)) * (0.8 + 0.2 * jitter),
    Math.min(retryAfterMs, 86_400_000),
  );
}

export interface AuditExportOptions {
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
  /** G15b owns atomic rejection/uncertainty dispositions, markers and alerts. */
  readonly resolve: (
    org: OrgContext,
    fence: SystemMutationFence,
    snapshot: AuditExportSnapshot,
    batch: AuditBatchV1,
    result: Extract<AuditDelivery, { outcome: 'rejected' | 'uncertain' }>,
  ) => Promise<void>;
}

/** G15b passes disposed ranges only after arranging their atomic ledger write. */
export function auditCustodySeq(
  sink: AuditSinkState,
  range: { readonly from: number; readonly to: number; readonly kind: 'durable_ack' | 'disposed' },
): number {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 1 ||
    range.to < range.from
  )
    throw new TypeError('Invalid audit custody range');
  const start = representation(sink.inflightRepr).custodyFromSeq;
  return (range.kind === 'disposed' || sink.durableAck) &&
    range.from <= Math.max(sink.custodySeq, start - 1) + 1
    ? Math.max(sink.custodySeq, range.to)
    : sink.custodySeq;
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
    if (last === undefined) {
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

export async function exportAuditBatch(
  port: AuditExportPort,
  org: OrgContext,
  fence: SystemMutationFence,
  options: AuditExportOptions,
  signal: AbortSignal,
  timeoutMs = deliveryBudgetMs(options),
): Promise<'idle' | 'contended' | 'accepted' | 'retry' | 'resolved'> {
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
    sink = {
      ...sink,
      inflightFrom: sink.progressSeq + 1,
      inflightTo: throughSeq,
      inflightBody: body,
      inflightRepr: JSON.stringify(repr),
    };
  }
  const markersOnly = queued !== undefined && queued.length > 0;
  const batch = frozenBatch(body!, org, {
    ...snapshot,
    sink: markersOnly
      ? { ...sink, inflightRepr: JSON.stringify({ ...repr, purpose: 'registry_markers' }) }
      : sink,
  });
  const sending = { ...sink, attempt: sink.attempt + 1 };
  if (signal.aborted || Date.now() >= deadline) return 'idle';
  if (!(await port.save(org, fence, snapshot, sending, options.generation))) return 'contended';
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
  if (signal.aborted) return 'idle';
  if (result?.outcome === 'rejected' || result?.outcome === 'uncertain') {
    await options.resolve(org, fence, snapshot, batch, result);
    return 'resolved';
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
    const next = {
      ...sending,
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
        !markersOnly && auditInflightEventRange(sending) !== null
          ? auditCustodySeq(sending, {
              from: sending.inflightFrom!,
              to: batch.throughSeq,
              kind: 'durable_ack',
            })
          : sending.custodySeq,
      inflightFrom: markersOnly ? sending.inflightFrom : null,
      inflightTo: markersOnly ? sending.inflightTo : null,
      inflightBody: markersOnly ? sending.inflightBody : null,
      inflightRepr: JSON.stringify(markersOnly ? rest : { ...rest, purpose: 'idle' }),
    };
    const saved = await port.save(org, fence, snapshot, next, options.generation);
    if (saved && result.outcome === 'accepted_with_warning') options.warning?.(result.code);
    return saved ? 'accepted' : 'contended';
  }
  const codes = ['network', 'timeout', 'refused', 'too_large', 'http_status', 'bad_response'];
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
        if (result !== 'accepted') break;
      } while (!ctx.signal.aborted && Date.now() < deadline);
    },
  };
}
