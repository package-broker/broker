import type { PolicyEcosystem } from '../../db/registry-policy.js';
import type { Observability } from '../../platform/observability.js';
import type { PolicyDenialReason } from './types.js';

export const COLLECTION_FILTERED_METRIC = 'pb.registry_policy.collection_filtered';

/**
 * Hidden collection candidates, counted once per request however often the same version is
 * looked at (tag lookup, validator preflight, rendering). Metrics only: nothing durable is written.
 */
export interface CollectionMetrics {
  hidden(key: string, reason: PolicyDenialReason): void;
  counts(): ReadonlyMap<PolicyDenialReason, number>;
  /** Emits and clears the pending counts; never throws. */
  flush(observability: Pick<Observability, 'counter'> | undefined): void;
  /** Forgets every unflushed count and seen version, for a discarded attempt. */
  reset(): void;
}

export function createCollectionMetrics(ecosystem: PolicyEcosystem): CollectionMetrics {
  const seen = new Set<string>();
  const pending = new Map<PolicyDenialReason, number>();
  return {
    hidden(key, reason) {
      if (seen.has(key)) return;
      seen.add(key);
      pending.set(reason, (pending.get(reason) ?? 0) + 1);
    },
    counts: () => new Map(pending),
    flush(observability) {
      if (observability === undefined) return;
      for (const [reason, value] of pending) {
        try {
          observability.counter(
            COLLECTION_FILTERED_METRIC,
            { kind: ecosystem, outcome: reason },
            value,
          );
        } catch {
          // Collection filtering never depends on telemetry.
        }
      }
      pending.clear();
    },
    reset() {
      seen.clear();
      pending.clear();
    },
  };
}
