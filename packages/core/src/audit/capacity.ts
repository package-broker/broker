import type { OrgContext } from '../db/port.js';

export interface AuditCapacityOptions {
  readonly generation: number;
  readonly maxJournalBytes: number;
  readonly limit?: number;
}

export type AuditCapacityOutcome =
  | { readonly outcome: 'evicted'; readonly evicted: number; readonly boundarySeq: number }
  | { readonly outcome: 'retained' | 'contended' };

export interface AuditCapacityPort {
  evict(ctx: OrgContext, options: AuditCapacityOptions): Promise<AuditCapacityOutcome>;
}

/** Eviction starts at the budget minus this reserve for loss records and markers. */
export function auditCapacityReserveBytes(maxJournalBytes: number): number {
  if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1)
    throw new TypeError('Invalid audit capacity budget');
  return Math.ceil(maxJournalBytes / 100);
}

export async function evictAudit(
  port: AuditCapacityPort,
  ctx: OrgContext,
  options: AuditCapacityOptions,
): Promise<AuditCapacityOutcome> {
  auditCapacityReserveBytes(options.maxJournalBytes);
  if (
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    !Number.isInteger(options.limit ?? 500) ||
    (options.limit ?? 500) < 1 ||
    (options.limit ?? 500) > 500
  )
    throw new TypeError('Invalid audit capacity options');
  return port.evict(ctx, options);
}
