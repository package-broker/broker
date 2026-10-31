export const DEFAULT_AUDIT_REJECTION_RETRIES = 3;

import type { AuditSinkState } from './sinks/registry.js';

interface CustodyRepresentation {
  custodyFromSeq: number;
  durableCustodySeq?: number;
  durableAckRanges?: { from: number; to: number }[];
}

function custodyRepresentation(raw: string | null): CustodyRepresentation {
  try {
    return { custodyFromSeq: 1, ...(JSON.parse(raw ?? '{}') as CustodyRepresentation | null) };
  } catch {
    throw new Error('Audit sink representation malformed');
  }
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

/** Disposed ranges require an atomic ledger write. */
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
  const start = custodyRepresentation(sink.inflightRepr).custodyFromSeq;
  return (range.kind === 'disposed' || sink.durableAck) &&
    range.from <= Math.max(sink.custodySeq, start - 1) + 1
    ? Math.max(sink.custodySeq, range.to)
    : sink.custodySeq;
}

export function validateAuditSkipAfter(retries: unknown = DEFAULT_AUDIT_REJECTION_RETRIES): void {
  if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 1 || retries > 10)
    throw new TypeError('Invalid audit rejection configuration');
}

export function auditDurableCoverage(
  sink: AuditSinkState,
  ack?: { readonly from: number; readonly to: number },
  disposed: readonly { readonly fromSeq: number; readonly toSeq: number }[] = [],
): { durableCustodySeq: number; durableAckRanges: readonly { from: number; to: number }[] } {
  const repr = custodyRepresentation(sink.inflightRepr);
  let prior = repr.durableCustodySeq ?? repr.custodyFromSeq - 1;
  const ranges = [
    ...(repr.durableAckRanges ??
      (prior >= repr.custodyFromSeq ? [{ from: repr.custodyFromSeq, to: prior }] : [])),
    ...(ack ? [ack] : []),
  ].sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  for (const range of [...disposed].sort((a, b) => a.fromSeq - b.fromSeq)) {
    if (range.fromSeq <= prior + 1) prior = Math.max(prior, range.toSeq);
  }
  return {
    durableCustodySeq: ack && ack.from <= prior + 1 ? Math.max(prior, ack.to) : prior,
    durableAckRanges: merged,
  };
}
