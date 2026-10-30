import type { OrgContext } from '../db/port.js';
import { ulid } from '../ids.js';
import { auditEvent, type AuditEvent } from './actions.js';
import type { AuditLedgerEntry } from './ledger.js';
import type { AuditPositionV1, AuditSink } from './plugin-api.js';
import type { AuditSinkSnapshot } from './sinks/registry.js';
import type { AuditExportState } from './export.js';
import { auditDurableCoverage } from './export-state.js';
import { auditWireMarker } from './wire.js';

export const AUDIT_FRONTIER_INTERVAL_MS = 86_400_000;

export interface AuditForkSnapshot extends Omit<AuditSinkSnapshot, 'sinks'> {
  readonly headSeq: number;
  readonly headHash: string;
  readonly history?: readonly {
    id: string;
    kind: string;
    chainId: string;
    epoch: number;
    fromSeq: number;
    toSeq: number;
    reasonCode: string;
  }[];
  /** Incremented by every writer of inflightBody or inflightRepr; the save CAS compares it
   * instead of the frozen bytes. */
  readonly sinks: readonly (AuditExportState & { readonly bodyVersion: number })[];
}

export type AuditForkReason =
  'restore_detected' | 'local_fork' | 'receiver_fork' | 'history_limit' | 'batch_limit';

export class AuditForkLimitError extends Error {
  override readonly name = 'AuditForkLimitError';
  constructor(readonly reason: 'history_limit' | 'batch_limit') {
    super('Audit fork capacity exceeded');
  }
}

function isGap(snapshot: AuditForkSnapshot, seq: number): boolean {
  return (
    snapshot.history?.some(
      (row) =>
        row.chainId === snapshot.chainId &&
        row.epoch === snapshot.epoch &&
        row.kind === 'gap' &&
        row.reasonCode === 'seq_gap' &&
        row.fromSeq <= seq &&
        row.toSeq >= seq,
    ) ?? false
  );
}

export interface AuditForkChange {
  readonly epoch: number;
  readonly restorePending: boolean;
  readonly boundaryReason: string | null;
  readonly sinks: readonly AuditExportState[];
  readonly ledger: readonly AuditLedgerEntry[];
  readonly event: AuditEvent | null;
  readonly now: string;
}

export interface AuditForkPort {
  read(org: OrgContext): Promise<AuditForkSnapshot>;
  /** Read only the named organization's retained journal; null means unavailable.
   * The boundary predecessor is supplied by the snapshot instead. */
  hashAt(org: OrgContext, seq: number): Promise<string | null>;
  /** Atomically CAS every snapshot field and the complete sink set, including each sink's
   * bodyVersion, against expected, and require generation >= every stored sink generation.
   * Recheck all observed journal hashes in that batch. Apply change, increment bodyVersion
   * of every rewritten sink, clear verification, append ledger via the ledger repository,
   * and stage event together or do nothing. When change.epoch differs from expected.epoch,
   * carry the governing ledger rows into the new epoch in the same batch (G19b carry rule).
   * Preserve head, boundary position, incarnation, counters and mode generation.
   * Return false on contention. No delivery may start before this succeeds. */
  save(
    org: OrgContext,
    expected: AuditForkSnapshot,
    observed: readonly { readonly seq: number; readonly hash: string | null }[],
    change: AuditForkChange,
    generation: number,
  ): Promise<boolean>;
}

export interface AuditForkOptions {
  readonly generation: number;
  readonly now: Date;
  /** Supply configured, organization-bound probes at boot and once each day. */
  readonly probes?: readonly { readonly id: string; readonly sink: AuditSink }[];
  readonly signal: AbortSignal;
  readonly alert: (reason: AuditForkReason) => void;
}

function generationIsCurrent(snapshot: AuditForkSnapshot, generation: number): boolean {
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new TypeError('Invalid audit generation');
  return snapshot.sinks.every((sink) => sink.generation <= generation);
}

function control(
  org: OrgContext,
  epoch: number,
  operation: 'epoch_bump' | 'confirm_restore',
  now: string,
  fromSeq?: number,
  actor: AuditEvent['actor'] = { type: 'system', id: null },
): AuditEvent {
  const result = auditEvent({
    id: ulid(),
    now,
    action: 'audit.sink_admin',
    actor,
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    target: { type: 'organization', id: org.orgId },
    changes: {
      operation: { new: operation },
      epoch: { new: epoch },
      ...(fromSeq === undefined ? {} : { from_seq: { new: fromSeq } }),
    },
  });
  if (!result.ok) throw new Error('Audit control event refused');
  return result.event;
}

function ledger(
  snapshot: AuditForkSnapshot,
  epoch: number,
  kind: 'epoch_bump' | 'restore_confirmed',
  reasonCode: string,
  now: string,
  fromSeq = Math.max(1, snapshot.headSeq),
  actor: AuditEvent['actor'] = { type: 'system', id: null },
): AuditLedgerEntry {
  return {
    id: ulid(),
    kind,
    chainId: snapshot.chainId,
    epoch,
    fromSeq,
    toSeq: Math.max(fromSeq, snapshot.headSeq),
    count: 0,
    sinkId: null,
    reasonCode,
    policy: snapshot.policy,
    modeGeneration: snapshot.modeGeneration,
    actorType: actor.type,
    actorId: actor.id,
    createdAt: now,
  };
}

/**
 * Ledger dispositions for frozen delivery state that confirmation discards, in the frozen
 * batch's own chain and epoch: a held partial outcome, and frozen or tail ranges above the
 * head that can no longer be delivered again.
 */
function discardedDispositions(
  snapshot: AuditForkSnapshot,
  sink: AuditExportState,
  repr: Record<string, unknown>,
  now: string,
): AuditLedgerEntry[] {
  const identity = (batch: unknown) => {
    const value = batch as { chainId?: unknown; epoch?: unknown; records?: unknown } | null;
    if (
      typeof value?.chainId !== 'string' ||
      !Number.isSafeInteger(value.epoch) ||
      !Array.isArray(value.records)
    )
      throw new Error('Audit sink representation malformed');
    return { chainId: value.chainId, epoch: value.epoch as number, records: value.records };
  };
  const entry = (
    batch: { chainId: string; epoch: number },
    kind: 'uncertain' | 'skipped',
    fromSeq: number,
    toSeq: number,
    count: number,
    reasonCode: string,
  ): AuditLedgerEntry => ({
    id: ulid(),
    kind,
    chainId: batch.chainId,
    epoch: batch.epoch,
    fromSeq,
    toSeq,
    count,
    sinkId: sink.id,
    reasonCode,
    policy: snapshot.policy,
    modeGeneration: snapshot.modeGeneration,
    actorType: 'system',
    actorId: null,
    createdAt: now,
  });
  const result: AuditLedgerEntry[] = [];
  const head = snapshot.headSeq;
  if (
    repr.purpose === 'events' &&
    sink.inflightBody !== null &&
    sink.inflightFrom !== null &&
    sink.inflightTo !== null
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sink.inflightBody);
    } catch {
      throw new Error('Audit sink representation malformed');
    }
    const batch = identity(parsed);
    const from = sink.inflightFrom;
    const to = sink.inflightTo;
    const held = repr.uncertainOutcome as { rejectedCount?: unknown } | undefined;
    if (held !== undefined) {
      const rejected = held?.rejectedCount;
      const count =
        Number.isSafeInteger(rejected) &&
        (rejected as number) >= 1 &&
        (rejected as number) <= batch.records.length
          ? (rejected as number)
          : to - from + 1;
      result.push(entry(batch, 'uncertain', from, to, count, 'partial_rejected'));
      // Retained records are delivered again in the current epoch, so the obligation moves
      // with them under an id a current-epoch durable ACK can resolve.
      if (from <= head && batch.chainId === snapshot.chainId && batch.epoch !== snapshot.epoch) {
        const kept = Math.min(to, head);
        result.push(
          entry(
            snapshot,
            'uncertain',
            from,
            kept,
            Math.min(count, kept - from + 1),
            'partial_rejected',
          ),
        );
      }
    }
    if (to > head) {
      const lost = Math.max(from, head + 1);
      result.push(entry(batch, 'uncertain', lost, to, to - lost + 1, 'fork_discarded'));
    }
  }
  if (repr.rejectionTail !== undefined) {
    if (!Array.isArray(repr.rejectionTail)) throw new Error('Audit sink representation malformed');
    for (const tail of repr.rejectionTail) {
      const batch = identity(tail);
      const first = batch.records.find(
        (record): record is { seq: number } =>
          record !== null && typeof record === 'object' && Number.isSafeInteger(record.seq),
      );
      const through = (tail as { throughSeq?: unknown }).throughSeq;
      if (first === undefined || !Number.isSafeInteger(through))
        throw new Error('Audit sink representation malformed');
      const to = through as number;
      if (to <= head) continue;
      const lost = Math.max(first.seq, head + 1);
      result.push(entry(batch, 'skipped', lost, to, to - lost + 1, 'fork_discarded'));
    }
  }
  return result;
}

function hashReader(port: AuditForkPort, org: OrgContext, snapshot: AuditForkSnapshot) {
  const observed = new Map<number, string | null>();
  return {
    observed: () => [...observed].map(([seq, hash]) => ({ seq, hash })),
    async at(seq: number): Promise<string | null> {
      if (seq === snapshot.boundarySeq - 1) return snapshot.boundaryPrevHash;
      if (seq < snapshot.boundarySeq || seq > snapshot.headSeq) return null;
      if (!observed.has(seq)) observed.set(seq, await port.hashAt(org, seq));
      return observed.get(seq)!;
    },
  };
}

function validPosition(position: AuditPositionV1): boolean {
  return (
    /^[a-f0-9]{32}$/.test(position.chainId) &&
    Number.isSafeInteger(position.epoch) &&
    position.epoch >= 0 &&
    Number.isSafeInteger(position.seq) &&
    position.seq >= 0 &&
    /^[a-f0-9]{64}$/.test(position.hash)
  );
}

async function receiverFrontier(
  sink: AuditSink,
  signal: AbortSignal,
): Promise<AuditPositionV1 | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new Error('Audit frontier unavailable'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(abort, 10_000);
  try {
    if (signal.aborted) abort();
    return await Promise.race([
      Promise.resolve().then(() =>
        controller.signal.aborted ? aborted : sink.frontier!(controller.signal),
      ),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** Run before delivery at boot; repeat with receiver probes once a day. */
async function detectOnce(
  port: AuditForkPort,
  org: OrgContext,
  options: AuditForkOptions,
  observedFork: (reason: AuditForkReason) => void,
): Promise<'clear' | 'blocked' | 'stale' | 'contended' | 'unavailable'> {
  const snapshot = await port.read(org);
  if (!generationIsCurrent(snapshot, options.generation)) return 'stale';
  if (options.signal.aborted) return 'unavailable';
  const hashes = hashReader(port, org, snapshot);
  let reason: AuditForkReason | null = snapshot.restorePending ? 'restore_detected' : null;
  const mismatch = async (seq: number, hash: string) => {
    const local = await hashes.at(seq);
    return local === null && isGap(snapshot, seq) ? false : local !== hash;
  };
  for (const sink of snapshot.sinks) {
    if (reason !== null) break;
    if (sink.state === 'retired') continue;
    if (
      sink.progressSeq > snapshot.headSeq ||
      (sink.progressSeq >= snapshot.boundarySeq - 1 &&
        (await mismatch(sink.progressSeq, sink.progressHash)))
    )
      reason = 'local_fork';
    let repr: { registryMarkerBody?: string; rejectionTail?: unknown };
    try {
      repr = JSON.parse(sink.inflightRepr ?? '{}') as typeof repr;
      if (
        repr === null ||
        typeof repr !== 'object' ||
        Array.isArray(repr) ||
        (repr.rejectionTail !== undefined && !Array.isArray(repr.rejectionTail))
      )
        throw new Error();
    } catch {
      reason = 'local_fork';
      break;
    }
    const frozen: unknown[] = [];
    for (const body of [sink.inflightBody, repr.registryMarkerBody]) {
      if (body == null) continue;
      try {
        frozen.push(JSON.parse(body));
      } catch {
        reason = 'local_fork';
      }
    }
    for (const batch of [...frozen, ...((repr.rejectionTail as unknown[] | undefined) ?? [])]) {
      const identity = batch as { chainId?: unknown; epoch?: unknown } | null;
      if (identity?.chainId !== snapshot.chainId || identity.epoch !== snapshot.epoch)
        reason = 'local_fork';
    }
  }
  let unavailable = false;
  if (reason === null) {
    const probes = await Promise.all(
      (options.probes ?? [])
        .filter((probe) =>
          snapshot.sinks.some(
            (sink) => sink.id === probe.id && ['active', 'blocked'].includes(sink.state),
          ),
        )
        .map(async (probe) => {
          try {
            return {
              probe,
              frontier:
                probe.sink.frontier === undefined
                  ? null
                  : await receiverFrontier(probe.sink, options.signal),
              failed: false,
            };
          } catch {
            return { probe, frontier: null, failed: true };
          }
        }),
    );
    for (const { probe, frontier, failed } of probes) {
      const stored = snapshot.sinks.find((sink) => sink.id === probe.id);
      if (
        stored === undefined ||
        !['active', 'blocked'].includes(stored.state) ||
        probe.sink.frontier === undefined
      )
        continue;
      if (options.signal.aborted) return 'unavailable';
      if (failed || (frontier !== null && !validPosition(frontier))) {
        unavailable = true;
        continue;
      }
      if (frontier === null) continue;
      if (frontier.chainId !== snapshot.chainId) {
        if (
          snapshot.history?.some(
            (row) => row.kind === 'chain_reset' && row.chainId === frontier.chainId,
          )
        )
          continue;
        reason = 'receiver_fork';
        break;
      }
      const confirmed = snapshot.history?.find(
        (row) =>
          row.kind === 'restore_confirmed' &&
          row.chainId === snapshot.chainId &&
          row.epoch === snapshot.epoch,
      );
      if (confirmed && frontier.epoch < snapshot.epoch && frontier.seq > confirmed.fromSeq - 1)
        continue;
      if (
        frontier.epoch > snapshot.epoch ||
        frontier.seq > snapshot.headSeq ||
        (frontier.seq >= snapshot.boundarySeq - 1 && (await mismatch(frontier.seq, frontier.hash)))
      ) {
        reason = 'receiver_fork';
        break;
      }
    }
  }
  if (reason === null) return unavailable ? 'unavailable' : 'clear';
  observedFork(reason);
  if (snapshot.restorePending && snapshot.sinks.every((sink) => sink.state !== 'active'))
    return 'blocked';
  const epoch = snapshot.epoch + (snapshot.restorePending ? 0 : 1);
  if (!Number.isSafeInteger(epoch)) throw new Error('Audit epoch exhausted');
  const now = options.now.toISOString();
  const saved = await port.save(
    org,
    snapshot,
    hashes.observed(),
    {
      epoch,
      restorePending: true,
      boundaryReason: snapshot.boundaryReason,
      sinks: snapshot.sinks.map((sink) =>
        ['active', 'blocked'].includes(sink.state)
          ? { ...sink, state: 'blocked', blockedReason: sink.blockedReason ?? 'fork' }
          : sink,
      ),
      ledger: snapshot.restorePending ? [] : [ledger(snapshot, epoch, 'epoch_bump', reason, now)],
      event: snapshot.restorePending ? null : control(org, epoch, 'epoch_bump', now),
      now,
    },
    options.generation,
  );
  if (!saved) return 'contended';
  options.alert(reason);
  return 'blocked';
}

export async function detectAuditFork(
  port: AuditForkPort,
  org: OrgContext,
  options: AuditForkOptions,
): Promise<'clear' | 'blocked' | 'stale' | 'contended' | 'unavailable'> {
  let observed: AuditForkReason | null = null;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const result = await detectOnce(port, org, { ...options, signal }, (reason) => {
        observed = reason;
      });
      if (result !== 'contended') {
        if (result === 'unavailable' && deadline.signal.aborted && observed !== null) {
          options.alert(observed);
          return 'contended';
        }
        return result;
      }
    }
    if (observed !== null) options.alert(observed);
    return 'contended';
  } catch (error) {
    if (error instanceof AuditForkLimitError) options.alert(error.reason);
    if (observed !== null) options.alert(observed);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function confirmAuditRestore(
  port: AuditForkPort,
  org: OrgContext,
  options: {
    readonly generation: number;
    readonly fromSeq: number;
    readonly now: Date;
    readonly actor: AuditEvent['actor'] & { type: 'user' | 'service_principal' };
    readonly alert: (reason: AuditForkReason) => void;
  },
): Promise<'confirmed' | 'stale' | 'contended'> {
  if (options.actor.type !== 'user' && options.actor.type !== 'service_principal')
    throw new TypeError('Invalid audit restore actor');
  try {
    const snapshot = await port.read(org);
    if (!generationIsCurrent(snapshot, options.generation)) return 'stale';
    if (!snapshot.restorePending) throw new Error('Audit restore confirmation unavailable');
    const from = options.fromSeq;
    if (!Number.isSafeInteger(from) || from < snapshot.boundarySeq || from - 1 > snapshot.headSeq)
      throw new TypeError('Invalid audit restore range');
    const hashes = hashReader(port, org, snapshot);
    const hash = await hashes.at(from - 1);
    if (hash === null) throw new Error('Audit restore position unavailable');
    const marker = await auditWireMarker(snapshot, {
      kind: 'fork',
      lastCommonSeq: from - 1,
      lastCommonHash: hash,
    });
    const now = options.now.toISOString();
    const dispositions: AuditLedgerEntry[] = [];
    const sinks = await Promise.all(
      snapshot.sinks.map(async (sink) => {
        if (sink.state === 'retired') return sink;
        const progressSeq = Math.min(sink.progressSeq, from - 1);
        const progressHash = sink.progressSeq > from - 1 ? hash : sink.progressHash;
        const local = await hashes.at(progressSeq);
        if (
          progressSeq >= snapshot.boundarySeq - 1 &&
          !(local === null && isGap(snapshot, progressSeq)) &&
          local !== progressHash
        )
          throw new Error('Audit restore sink position unavailable');
        let repr: Record<string, unknown>;
        try {
          repr = JSON.parse(sink.inflightRepr ?? '{}') as Record<string, unknown>;
          if (repr === null || typeof repr !== 'object' || Array.isArray(repr)) throw new Error();
        } catch {
          throw new Error('Audit sink representation malformed');
        }
        const custodyFromSeq = repr.custodyFromSeq;
        if (!Number.isSafeInteger(custodyFromSeq) || Number(custodyFromSeq) < 1)
          throw new Error('Audit sink representation malformed');
        delete repr.registryMarkerBody;
        delete repr.registryMarkerOriginalAttempt;
        delete repr.registryMarkerOriginalErrorCode;
        dispositions.push(...discardedDispositions(snapshot, sink, repr, now));
        delete repr.rejectionTail;
        delete repr.uncertainOutcome;
        const coverage = auditDurableCoverage(sink);
        if (
          coverage.durableCustodySeq > from - 1 ||
          coverage.durableAckRanges.some((range) => range.to > from - 1)
        ) {
          repr.durableCustodySeq = Math.min(coverage.durableCustodySeq, from - 1);
          repr.durableAckRanges = coverage.durableAckRanges
            .filter((range) => range.from <= from - 1)
            .map((range) => ({ from: range.from, to: Math.min(range.to, from - 1) }));
        }
        return {
          ...sink,
          state: sink.state === 'blocked' && sink.blockedReason === 'fork' ? 'active' : sink.state,
          blockedReason: sink.blockedReason === 'fork' ? null : sink.blockedReason,
          attempt: 0,
          retryCountForSeq: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          progressSeq,
          progressHash,
          custodySeq: Math.min(sink.custodySeq, from - 1),
          inflightFrom: null,
          inflightTo: null,
          inflightBody: null,
          inflightRepr: JSON.stringify({
            ...repr,
            custodyFromSeq,
            purpose: 'idle',
            registryMarkers: [
              marker,
              ...(Array.isArray(repr.registryMarkers) ? repr.registryMarkers : []),
            ],
          }),
        };
      }),
    );
    return (await port.save(
      org,
      snapshot,
      hashes.observed(),
      {
        epoch: snapshot.epoch,
        restorePending: false,
        boundaryReason: snapshot.boundaryReason,
        sinks,
        ledger: [
          ...dispositions,
          ledger(
            snapshot,
            snapshot.epoch,
            'restore_confirmed',
            'restore_confirmed',
            now,
            from,
            options.actor,
          ),
        ],
        event: control(org, snapshot.epoch, 'confirm_restore', now, from, options.actor),
        now,
      },
      options.generation,
    ))
      ? 'confirmed'
      : 'contended';
  } catch (error) {
    if (error instanceof AuditForkLimitError) options.alert(error.reason);
    throw error;
  }
}
