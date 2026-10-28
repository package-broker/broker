import type { OrgContext } from '../db/port.js';
import { isUlid } from '../ids.js';

export const AUDIT_LEDGER_KINDS = [
  'skipped',
  'uncertain',
  'gap',
  'withheld',
  'mode_change',
  'policy_change',
  'cutover',
  'rebind',
  'retire',
  'unblock',
  'restore_confirmed',
  'export',
  'replay',
  'chain_reset',
  'epoch_bump',
] as const;

export interface AuditLedgerEntry {
  readonly id: string;
  readonly kind: (typeof AUDIT_LEDGER_KINDS)[number];
  readonly chainId: string;
  readonly epoch: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
  readonly sinkId: string | null;
  readonly reasonCode: string;
  readonly policy: 'availability' | 'required';
  readonly modeGeneration: number;
  readonly actorType: 'user' | 'service_principal' | 'customer' | 'system';
  readonly actorId: string | null;
  readonly createdAt: string;
}

export interface AuditLedgerPort {
  append(ctx: OrgContext, entries: readonly AuditLedgerEntry[]): Promise<void>;
  effectiveGaps(ctx: OrgContext): Promise<readonly AuditLedgerEntry[]>;
  page(
    ctx: OrgContext,
    afterId: string | null,
    limit: number,
  ): Promise<readonly AuditLedgerEntry[]>;
}

export function assertAuditLedgerEntry(entry: AuditLedgerEntry): void {
  const integer = (value: number, minimum: number) =>
    Number.isSafeInteger(value) && value >= minimum;
  if (
    !isUlid(entry.id) ||
    !AUDIT_LEDGER_KINDS.includes(entry.kind) ||
    !/^[a-f0-9]{32}$/.test(entry.chainId) ||
    !integer(entry.epoch, 0) ||
    !integer(entry.fromSeq, 1) ||
    !integer(entry.toSeq, entry.fromSeq) ||
    !integer(entry.count, entry.kind === 'gap' || entry.kind === 'skipped' ? 1 : 0) ||
    entry.count > entry.toSeq - entry.fromSeq + 1 ||
    (['rebind', 'retire', 'unblock', 'skipped'].includes(entry.kind) && entry.sinkId === null) ||
    !integer(entry.modeGeneration, 0) ||
    (entry.sinkId !== null && !/^[a-z0-9-]{1,32}$/.test(entry.sinkId)) ||
    !/^[a-z][a-z_]{0,31}$/.test(entry.reasonCode) ||
    !['availability', 'required'].includes(entry.policy) ||
    !['user', 'service_principal', 'customer', 'system'].includes(entry.actorType) ||
    (entry.actorId !== null &&
      !isUlid(entry.actorId) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.actorId)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.createdAt) ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    new Date(entry.createdAt).toISOString() !== entry.createdAt
  ) {
    throw new TypeError('invalid audit ledger entry');
  }
}

/** Coalesce losses before insertion; persisted ledger rows are never rewritten. */
export function mergeAuditLedgerGaps(
  entries: readonly AuditLedgerEntry[],
): readonly AuditLedgerEntry[] {
  for (const entry of entries) assertAuditLedgerEntry(entry);
  const gaps = entries
    .filter((entry) => entry.kind === 'gap')
    .sort(
      (a, b) =>
        a.chainId.localeCompare(b.chainId) ||
        a.epoch - b.epoch ||
        (a.sinkId ?? '').localeCompare(b.sinkId ?? '') ||
        a.fromSeq - b.fromSeq,
    );
  const merged: AuditLedgerEntry[] = [];
  const latest = new Map<string, number>();
  for (const entry of gaps) {
    const key = JSON.stringify([entry.chainId, entry.epoch, entry.sinkId, entry.reasonCode]);
    const index = latest.get(key) ?? -1;
    const previous = merged[index];
    if (previous !== undefined && entry.fromSeq - previous.toSeq <= 1) {
      const combined = {
        ...previous,
        toSeq: Math.max(previous.toSeq, entry.toSeq),
        count: previous.count + entry.count,
      };
      assertAuditLedgerEntry(combined);
      merged[index] = combined;
    } else {
      latest.set(key, merged.length);
      merged.push({ ...entry });
    }
  }
  return [...merged, ...entries.filter((entry) => entry.kind !== 'gap')];
}
