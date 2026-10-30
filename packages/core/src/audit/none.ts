import type { OrgContext } from '../db/port.js';
import { isUlid, ulid } from '../ids.js';
import { auditEvent, type AuditEvent } from './actions.js';
import {
  AUDIT_NONE_WARNING,
  resolveOrgAudit,
  type AuditMode,
  type AuditPolicy,
  type OrgAuditOptions,
  type OrgAuditRefusalCode,
} from './effective.js';
import { assertAuditLedgerEntry, type AuditLedgerEntry } from './ledger.js';
import { pruneAudit, type AuditPruneOptions, type AuditPrunePort } from './prune.js';

export interface AuditNoneSnapshot {
  readonly chainId: string;
  readonly epoch: number;
  readonly incarnation: number;
  readonly headSeq: number;
  readonly mode: AuditMode;
  readonly pendingMode: AuditMode | null;
  readonly modeGeneration: number;
  readonly cutoverSeq: number | null;
  readonly policy: AuditPolicy;
  readonly restorePending: boolean;
}

export interface AuditNonePort {
  snapshot(ctx: OrgContext): Promise<AuditNoneSnapshot>;
  /**
   * Atomically compare the complete snapshot and acting build generation, refuse restored or
   * required chains, set pending_mode to none and cutover_seq to the snapshot head,
   * increment mode_generation, append entries through the ledger repository, stage the event,
   * and clear verification. A stale snapshot or build returns false without writing anything.
   * The prune transaction commits mode and clears pending_mode when its boundary passes cutover_seq.
   * Empty chains use seq 1 for control ledger rows; cutover_seq remains 0.
   */
  record(
    ctx: OrgContext,
    snapshot: AuditNoneSnapshot,
    generation: number,
    entries: readonly AuditLedgerEntry[],
    event: AuditEvent,
  ): Promise<boolean>;
}

export function auditNoneStatus(snapshot: AuditNoneSnapshot) {
  const degraded = (snapshot.pendingMode ?? snapshot.mode) === 'none';
  return {
    degraded,
    warning: degraded ? AUDIT_NONE_WARNING : null,
    modeGeneration: snapshot.modeGeneration,
    cutoverSeq: snapshot.cutoverSeq,
  };
}

export type AuditNoneOutcome =
  | { readonly outcome: 'refused'; readonly code: OrgAuditRefusalCode | 'restore_pending' }
  | { readonly outcome: 'not_none' | 'contended' }
  | { readonly outcome: 'degraded'; readonly status: ReturnType<typeof auditNoneStatus> };

export interface AuditNoneOptions {
  readonly audit: Omit<OrgAuditOptions, 'storedPolicy'>;
  readonly generation: number;
  readonly now: string;
  /** Three distinct ULIDs for the mode ledger row, cutover ledger row and pending event. */
  readonly ids: readonly [string, string, string];
}

/** Persist none before allowing retention; a verified export never clears degraded health. */
export async function enterAuditNone(
  port: AuditNonePort,
  ctx: OrgContext,
  options: AuditNoneOptions,
): Promise<AuditNoneOutcome> {
  if (
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    options.ids.length !== 3 ||
    !options.ids.every(isUlid) ||
    new Set(options.ids).size !== 3
  ) {
    throw new TypeError('Invalid audit none options');
  }
  const snapshot = await port.snapshot(ctx);
  if (snapshot.restorePending) return { outcome: 'refused', code: 'restore_pending' };
  const resolved = resolveOrgAudit({ ...options.audit, storedPolicy: snapshot.policy });
  if (!resolved.ok) return { outcome: 'refused', code: resolved.code };
  if (resolved.effective.mode !== 'none') return { outcome: 'not_none' };
  if ((snapshot.pendingMode ?? snapshot.mode) === 'none') {
    return { outcome: 'degraded', status: auditNoneStatus(snapshot) };
  }
  const modeGeneration = snapshot.modeGeneration + 1;
  const common = {
    chainId: snapshot.chainId,
    epoch: snapshot.epoch,
    fromSeq: Math.max(1, snapshot.headSeq),
    toSeq: Math.max(1, snapshot.headSeq),
    count: 0,
    sinkId: null,
    reasonCode: 'mode_none',
    policy: resolved.effective.policy,
    modeGeneration,
    actorType: 'system',
    actorId: null,
    createdAt: options.now,
  } as const;
  const entries: readonly AuditLedgerEntry[] = [
    { ...common, id: options.ids[0], kind: 'mode_change' },
    { ...common, id: options.ids[1], kind: 'cutover' },
  ];
  for (const entry of entries) assertAuditLedgerEntry(entry);
  const event = auditEvent({
    id: options.ids[2],
    now: options.now,
    action: 'audit.mode_change',
    actor: { type: 'system', id: null },
    context: {
      opId: ulid(),
      requestId: ulid(),
      sourceIp: null,
      tokenSelector: null,
    },
    target: { type: 'audit', id: null },
    changes: {
      from_mode: { new: snapshot.pendingMode ?? snapshot.mode },
      to_mode: { new: 'none' },
      policy: { new: resolved.effective.policy },
      source: { new: options.audit.build.acceptanceSource },
      mode_generation: { new: modeGeneration },
      cutover_seq: { new: snapshot.headSeq },
    },
  });
  if (!event.ok) {
    throw new TypeError('Invalid audit none options');
  }
  const recorded = await port.record(ctx, snapshot, options.generation, entries, event.event);
  if (!recorded) return { outcome: 'contended' };
  return {
    outcome: 'degraded',
    status: auditNoneStatus({
      ...snapshot,
      pendingMode: 'none',
      modeGeneration,
      cutoverSeq: snapshot.headSeq,
    }),
  };
}

/** The prune repository independently checks registered-export coverage and its atomic fences. */
export async function pruneAuditNone(
  port: AuditNonePort,
  prune: AuditPrunePort,
  ctx: OrgContext,
  options: AuditNoneOptions & {
    readonly prune: Omit<AuditPruneOptions, 'generation' | 'trailActive'>;
  },
) {
  const entered = await enterAuditNone(port, ctx, options);
  if (entered.outcome !== 'degraded') return entered;
  const result = await pruneAudit(prune, ctx, {
    ...options.prune,
    generation: options.generation,
    trailActive: false,
  });
  return { ...entered, prune: result };
}
