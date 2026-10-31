import { DbError } from '../db/errors.js';
import type { OrgContext } from '../db/port.js';
import { isUlid } from '../ids.js';

export class AuditLedgerOverlapError extends DbError {
  constructor() {
    super('check', 'audit ledger overlapping report');
    this.name = 'AuditLedgerOverlapError';
  }
}

export class AuditLedgerIntegrityError extends Error {
  constructor() {
    super('audit ledger integrity failure');
    this.name = 'AuditLedgerIntegrityError';
  }
}

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

/** Registration follows verification of the artifact's final chain, epoch, seq and hash. */
export const AUDIT_VERIFIED_EXPORT = {
  kind: 'export',
  sinkId: null,
  reasonCode: 'verified_export',
} as const;

export interface AuditLedgerEntry {
  readonly id: string;
  readonly kind: (typeof AUDIT_LEDGER_KINDS)[number];
  readonly chainId: string;
  readonly epoch: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
  readonly sinkId: string | null;
  readonly resolvesId?: string | null;
  readonly capacity?: {
    readonly prevHash: string;
    readonly hash: string;
    /** Possibly affected sinks, including disabled sinks; attribution can race progress and state changes. */
    readonly affectedSinkIds: readonly string[];
    readonly affectedSinkIdsOverflow?: true;
  };
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
  /**
   * Visible rows in id order. Ids are not a durable append cursor: a row committed later, by
   * another worker, can carry a smaller id than one already read. Gap totals come from
   * `effectiveGaps()`, never from paging past a remembered id.
   */
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
    (entry.capacity !== undefined &&
      (entry.kind !== 'gap' ||
        entry.reasonCode !== 'capacity' ||
        entry.sinkId !== null ||
        !/^[a-f0-9]{64}$/.test(entry.capacity.prevHash) ||
        !/^[a-f0-9]{64}$/.test(entry.capacity.hash) ||
        Object.keys(entry.capacity).some(
          (key) =>
            !['prevHash', 'hash', 'affectedSinkIds', 'affectedSinkIdsOverflow'].includes(key),
        ) ||
        (entry.capacity.affectedSinkIdsOverflow !== undefined &&
          entry.capacity.affectedSinkIdsOverflow !== true) ||
        !Array.isArray(entry.capacity.affectedSinkIds) ||
        entry.capacity.affectedSinkIds.length > 1000 ||
        JSON.stringify(entry.capacity).length > 65536 ||
        entry.capacity.affectedSinkIds.some(
          (id, i, ids) => !/^[a-z0-9-]{1,32}$/.test(id) || (i > 0 && ids[i - 1]! >= id),
        ))) ||
    !isUlid(entry.id) ||
    (entry.resolvesId != null && (entry.kind !== 'replay' || !isUlid(entry.resolvesId))) ||
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

const capacityJson = (capacity: AuditLedgerEntry['capacity']) =>
  capacity === undefined
    ? null
    : JSON.stringify({
        prevHash: capacity.prevHash,
        hash: capacity.hash,
        affectedSinkIds: capacity.affectedSinkIds,
        ...(capacity.affectedSinkIdsOverflow ? { affectedSinkIdsOverflow: true } : {}),
      });

const sameEntry = (a: AuditLedgerEntry, b: AuditLedgerEntry) =>
  (a.resolvesId ?? null) === (b.resolvesId ?? null) &&
  capacityJson(a.capacity) === capacityJson(b.capacity) &&
  (Object.keys(a) as (keyof AuditLedgerEntry)[]).every(
    (key) => key === 'resolvesId' || key === 'capacity' || a[key] === b[key],
  );

/**
 * Validates a batch and drops exact repeats; a changed report under a repeated id is a duplicate.
 * Each remaining report is persisted as its own row in submission order, so adjacent gaps merge
 * in the database exactly as they do across appends.
 */
export function normalizeAuditLedgerEntries(
  entries: readonly AuditLedgerEntry[],
): readonly AuditLedgerEntry[] {
  for (const entry of entries) assertAuditLedgerEntry(entry);
  const byId = new Map<string, AuditLedgerEntry>();
  return entries.filter((entry) => {
    const seen = byId.get(entry.id);
    if (seen === undefined) {
      byId.set(entry.id, entry);
      return true;
    }
    if (sameEntry(seen, entry)) return false;
    throw new DbError('unique', 'audit ledger duplicate id', {
      constraint: 'audit_ledger.org_id, audit_ledger.id',
    });
  });
}
