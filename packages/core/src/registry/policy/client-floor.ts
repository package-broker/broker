import { comparePolicyClientVersions, type PolicyRule } from '../../db/registry-policy.js';
import {
  applicableRules,
  denial,
  earliest,
  type RuleDenial,
  type RuleOutcome,
} from './rule-scope.js';
import type { ClientHints } from './types.js';

const FLOOR: ReadonlySet<PolicyRule['kind']> = new Set(['client_floor']);

/**
 * Opt-in floors: a known family meets every floor configured for it, an unconfigured family
 * passes, and an unknown client passes unless an applicable rule sets denyUnknown.
 */
export function evaluateClientFloor(
  rules: readonly PolicyRule[],
  client: ClientHints,
  now: string,
): RuleOutcome {
  const known = client.family !== 'unknown' && client.version !== null;
  const denials: RuleDenial[] = [];
  let nextBoundary: string | null = null;
  for (const rule of applicableRules(rules, FLOOR, null, now)) {
    let refused: RuleDenial | null = null;
    if (!known) {
      if (rule.denyUnknown) refused = denial(rule, 'client_unsupported');
    } else if (
      rule.clientFamily === client.family &&
      rule.clientMinVersion !== null &&
      comparePolicyClientVersions(client.version as string, rule.clientMinVersion) < 0
    ) {
      refused = denial(rule, 'client_floor');
    }
    if (refused === null) continue;
    denials.push(refused);
    nextBoundary = earliest(nextBoundary, rule.expiresAt);
  }
  return { denials, nextBoundary };
}
