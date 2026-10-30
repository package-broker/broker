import type { OrgContext } from '../db/port.js';

export interface AuditPruneOptions {
  readonly generation: number;
  readonly configuredSinkIds: readonly string[];
  /** Effective trail state, including the build and environment configuration. */
  readonly trailActive: boolean;
  readonly limit?: number;
}

export type AuditPruneOutcome =
  | { readonly outcome: 'pruned'; readonly pruned: number; readonly boundarySeq: number }
  | { readonly outcome: 'retained' | 'contended' };

export interface AuditPrunePort {
  prune(ctx: OrgContext, options: AuditPruneOptions): Promise<AuditPruneOutcome>;
}

/** One invocation does at most one bounded, atomic prune. Runtime scheduling belongs to G33/G34. */
export async function pruneAudit(
  port: AuditPrunePort,
  ctx: OrgContext,
  options: AuditPruneOptions,
): Promise<AuditPruneOutcome> {
  if (
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    !Number.isInteger(options.limit ?? 500) ||
    (options.limit ?? 500) < 1 ||
    (options.limit ?? 500) > 500 ||
    options.configuredSinkIds.some((id) => !/^[a-z0-9-]{1,32}$/.test(id))
  )
    throw new TypeError('Invalid audit prune options');
  if (options.trailActive) return { outcome: 'retained' };
  return port.prune(ctx, options);
}
