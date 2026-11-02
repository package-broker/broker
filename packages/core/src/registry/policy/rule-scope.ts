import type { PolicyRule, PolicyRuleKind } from '../../db/registry-policy.js';
import type { PolicyDenialReason } from './types.js';

/** One rule that refuses a candidate or a request; identifiers and the fixed reason only. */
export interface RuleDenial {
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly reason: PolicyDenialReason;
}

export interface RuleOutcome {
  readonly denials: readonly RuleDenial[];
  /** The earliest instant after `now` at which this outcome can change without a write. */
  readonly nextBoundary: string | null;
}

/** Active while `now < expiresAt`; a rule without expiry is active until disabled. */
export function applicableRules(
  rules: readonly PolicyRule[],
  kinds: ReadonlySet<PolicyRuleKind>,
  packageKey: string | null,
  now: string,
): PolicyRule[] {
  return rules.filter(
    (rule) =>
      kinds.has(rule.kind) &&
      (rule.expiresAt === null || now < rule.expiresAt) &&
      (rule.packageKey === null || rule.packageKey === packageKey),
  );
}

export function earliest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left <= right ? left : right;
}

export function denial(rule: PolicyRule, reason: PolicyDenialReason): RuleDenial {
  return Object.freeze({ ruleId: rule.id, ruleRevision: rule.revision, reason });
}
