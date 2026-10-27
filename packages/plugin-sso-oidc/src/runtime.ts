import { isReservedProviderId, isValidProviderId } from '@package-broker/core/plugin';
import { canonicalAnchor, checkProviderDefinitions, isContainer } from './provider-checks.js';
import type { ProviderConfig, Rejection, RejectionCode } from './provider-checks.js';

export const RUNTIME_PROVIDERS_VARIABLE = 'PB_IDP_PROVIDERS';
export const MAX_RUNTIME_DOCUMENT_BYTES = 5120;
export const MAX_RUNTIME_PROVIDERS = 64;
export type DocumentProblem = 'too_large' | 'syntax' | 'not_array' | 'over_cap' | 'unreadable';
export interface RuntimeProviders {
  readonly accepted: readonly ProviderConfig[];
  readonly rejected: readonly Rejection[];
  readonly suppressedIds: readonly string[];
  readonly documentProblem: DocumentProblem | null;
}

function empty(documentProblem: DocumentProblem | null): RuntimeProviders {
  return Object.freeze({
    accepted: Object.freeze([]),
    rejected: Object.freeze([]),
    suppressedIds: Object.freeze([]),
    documentProblem,
  });
}

export function parseRuntimeProviders(raw: string | undefined): RuntimeProviders {
  if (raw === undefined || raw.trim() === '') return empty(null);
  if (raw.length > MAX_RUNTIME_DOCUMENT_BYTES) return empty('too_large');
  if (new TextEncoder().encode(raw).length > MAX_RUNTIME_DOCUMENT_BYTES) return empty('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return empty('syntax');
  }
  if (!Array.isArray(parsed)) return empty('not_array');
  const entries: unknown[] = parsed;
  if (entries.length > MAX_RUNTIME_PROVIDERS) return empty('over_cap');
  const ids = entries.map((entry) =>
    isContainer(entry) ? (entry as { id?: unknown }).id : undefined,
  );
  const suppressedIds = ids.filter(
    (id): id is string =>
      typeof id === 'string' && isValidProviderId(id) && !isReservedProviderId(id),
  );
  const anchors = entries.map((entry) => {
    if (!isContainer(entry)) return undefined;
    const { kind, issuer, teamDomain, audience } = entry as Record<string, unknown>;
    const anchor =
      kind === 'oidc' && typeof issuer === 'string'
        ? `oidc:${issuer}`
        : kind === 'cloudflare-access' &&
            typeof teamDomain === 'string' &&
            typeof audience === 'string'
          ? `access:${teamDomain}/${audience}`
          : undefined;
    return anchor === undefined ? undefined : canonicalAnchor(anchor);
  });
  const checked = checkProviderDefinitions(entries);
  const byIndex = new Map(checked.rejected.map((entry) => [entry.index, entry]));
  const accepted: ProviderConfig[] = [];
  const rejected: Rejection[] = [];
  let acceptedIndex = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const previous = byIndex.get(index);
    const config = previous === undefined ? checked.accepted[acceptedIndex++] : undefined;
    const codes = new Set<RejectionCode>(previous?.codes);
    const problems = [...(previous?.problems ?? [])];
    for (const [values, code, label] of [
      [ids, 'duplicate_id', 'id'],
      [anchors, 'duplicate_anchor', 'trust anchor'],
    ] as const) {
      if (typeof values[index] !== 'string') continue;
      const other = values.findIndex((value, j) => j !== index && value === values[index]);
      if (other < 0) continue;
      codes.add(code);
      const problem = `providers[${index}]: ${label} duplicates providers[${other}]`;
      if (!problems.includes(problem)) problems.push(problem);
    }
    if (previous !== undefined || codes.size > 0) {
      const identity = previous ?? (config === undefined ? {} : { id: config.id });
      rejected.push(
        Object.freeze({
          ...identity,
          index,
          codes: Object.freeze([...codes].sort()),
          problems: Object.freeze(problems),
        }),
      );
    } else if (config !== undefined) {
      accepted.push(config);
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    suppressedIds: Object.freeze([...new Set(suppressedIds)]),
    documentProblem: null,
  });
}
