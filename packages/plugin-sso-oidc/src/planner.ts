import { canonicalAnchor, type ProviderConfig } from './provider-checks.js';
import { providerPresentation } from './presentation.js';
import { MAX_RUNTIME_PROVIDERS, type RuntimeProviders } from './runtime.js';

export interface ProviderPlan {
  readonly effective: readonly ProviderConfig[];
  readonly overridden: readonly string[];
  readonly suppressed: readonly string[];
  readonly displaced: readonly { readonly compiled: string; readonly by: string }[];
  readonly overflow: readonly string[];
}

export function planProviders(
  compiled: readonly ProviderConfig[],
  runtime: RuntimeProviders,
): ProviderPlan {
  const overridden = new Set<string>();
  const suppressed = new Set<string>();
  const displaced: { readonly compiled: string; readonly by: string }[] = [];
  const overflow: string[] = [];
  let effective = [...compiled];
  if (runtime.documentProblem === null) {
    const suppressedIds = new Set(runtime.suppressedIds);
    const acceptedIds = new Set(runtime.accepted.map((entry) => entry.id));
    const anchors = new Map(
      compiled.map((entry) => [entry, canonicalAnchor(providerPresentation(entry).trustAnchor)]),
    );
    effective = effective.filter((entry) => {
      if (!suppressedIds.has(entry.id)) return true;
      (acceptedIds.has(entry.id) ? overridden : suppressed).add(entry.id);
      return false;
    });
    const priority = new Set(overridden);
    for (const entry of runtime.accepted) {
      const anchor = canonicalAnchor(providerPresentation(entry).trustAnchor);
      effective = effective.filter((candidate) => {
        if (candidate.id !== entry.id && anchors.get(candidate) !== anchor) return true;
        priority.add(entry.id);
        if (candidate.id === entry.id) overridden.add(candidate.id);
        else displaced.push(Object.freeze({ compiled: candidate.id, by: entry.id }));
        return false;
      });
    }
    const admitted = new Set<ProviderConfig>();
    for (const preferred of [true, false]) {
      for (const entry of runtime.accepted) {
        if (priority.has(entry.id) !== preferred) continue;
        if (effective.length + admitted.size < MAX_RUNTIME_PROVIDERS) admitted.add(entry);
      }
    }
    for (const entry of runtime.accepted) {
      if (admitted.has(entry)) effective.push(entry);
      else overflow.push(entry.id);
    }
  }
  return Object.freeze({
    effective: Object.freeze(effective),
    overridden: Object.freeze([...overridden]),
    suppressed: Object.freeze([...suppressed]),
    displaced: Object.freeze(displaced),
    overflow: Object.freeze(overflow),
  });
}
