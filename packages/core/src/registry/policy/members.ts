import type { PolicyRule } from '../../db/registry-policy.js';
import {
  applicableRules,
  denial,
  earliest,
  type RuleDenial,
  type RuleOutcome,
} from './rule-scope.js';
import type { VersionFact } from './types.js';

const MEMBER_KINDS: ReadonlySet<PolicyRule['kind']> = new Set(['block', 'allowlist', 'quarantine']);

/**
 * Restrictions intersect: every applicable block, quarantine and allowlist is checked by the
 * canonical package key and exact normalized version, so no rule can lift another.
 */
export function evaluateMembers(
  rules: readonly PolicyRule[],
  fact: VersionFact,
  now: string,
): RuleOutcome {
  const denials: RuleDenial[] = [];
  let nextBoundary: string | null = null;
  for (const rule of applicableRules(rules, MEMBER_KINDS, fact.packageKey, now)) {
    if (rule.packageKey === null) continue;
    const listed = rule.members.includes(fact.normalizedVersion);
    let refused: RuleDenial | null = null;
    if (rule.kind === 'block' && (rule.members.length === 0 || listed)) {
      refused = denial(rule, 'blocked');
    } else if (rule.kind === 'quarantine' && listed) {
      refused = denial(rule, 'quarantined');
    } else if (rule.kind === 'allowlist' && !listed) {
      refused = denial(rule, 'not_allowlisted');
    }
    if (refused === null) continue;
    denials.push(refused);
    nextBoundary = earliest(nextBoundary, rule.expiresAt);
  }
  return { denials, nextBoundary };
}
