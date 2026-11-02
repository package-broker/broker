import { STORED_PUBLISHED_AT_BASES } from '../../catalogue/version-rules.js';
import { isPolicyTimestamp, type PolicyRule } from '../../db/registry-policy.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import {
  applicableRules,
  denial,
  earliest,
  type RuleDenial,
  type RuleOutcome,
} from './rule-scope.js';
import type { AgeBasis, VersionFact } from './types.js';

/** The stored, immutable date facts of one version row. */
export interface StoredDates {
  readonly publishedAt: string;
  readonly publishedAtBasis: string | undefined;
  readonly createdAt: string | undefined;
}

const MIN_AGE: ReadonlySet<PolicyRule['kind']> = new Set(['min_age']);

/**
 * The date a minimum age counts from: the frozen release date for a recognized basis, the import
 * date for import_time, otherwise the row's created_at. Never clamped to the current time.
 */
export function effectiveDate(stored: StoredDates): {
  readonly publishedAt: string;
  readonly ageBasis: AgeBasis;
} {
  const basis = stored.publishedAtBasis;
  if (basis !== undefined && isPolicyTimestamp(stored.publishedAt)) {
    if (basis === 'import_time') return { publishedAt: stored.publishedAt, ageBasis: 'imported' };
    if (STORED_PUBLISHED_AT_BASES.has(basis)) {
      return { publishedAt: stored.publishedAt, ageBasis: 'published' };
    }
  }
  if (isPolicyTimestamp(stored.createdAt)) {
    return { publishedAt: stored.createdAt, ageBasis: 'first_seen' };
  }
  throw new RegistryPolicyUnavailableError();
}

/** Eligible when `now >= publishedAt + minimum` for every applicable minimum-age rule. */
export function evaluateMinAge(
  rules: readonly PolicyRule[],
  fact: VersionFact,
  now: string,
): RuleOutcome {
  if (!isPolicyTimestamp(fact.publishedAt) || !isPolicyTimestamp(now)) {
    throw new RegistryPolicyUnavailableError();
  }
  const nowMs = Date.parse(now);
  const publishedMs = Date.parse(fact.publishedAt);
  const denials: RuleDenial[] = [];
  let nextBoundary: string | null = null;
  for (const rule of applicableRules(rules, MIN_AGE, fact.packageKey, now)) {
    const minimum = rule.minAgeSeconds;
    if (minimum === null || !Number.isSafeInteger(minimum) || minimum < 0) {
      throw new RegistryPolicyUnavailableError();
    }
    const eligibleMs = publishedMs + minimum * 1000;
    if (nowMs >= eligibleMs) continue;
    denials.push(denial(rule, 'min_age'));
    nextBoundary = earliest(nextBoundary, new Date(eligibleMs).toISOString());
    nextBoundary = earliest(nextBoundary, rule.expiresAt);
  }
  return { denials, nextBoundary };
}
