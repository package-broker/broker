import { domainPolicyProblems, type DomainPolicy } from '@package-broker/core/plugin';

export const MAX_LIST_LENGTH = 32;
export const OVER_CAP: unique symbol = Symbol('over cap');
export const HIDDEN_KEYS_PROBLEM = 'keys must be own, enumerable string keys';

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'verifiedDomains',
  'emailAuthoritativeDomains',
  'autoJoin',
]);
const NO_KEYS: ReadonlySet<string> = new Set();

export function isPlainContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasHiddenKeys(raw: object, ignored: ReadonlySet<string> = NO_KEYS): boolean {
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === 'string' && ignored.has(key)) {
      continue;
    }
    if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(raw, key)) {
      return true;
    }
  }
  for (const key in raw) {
    if (!ignored.has(key) && !Object.hasOwn(raw, key)) {
      return true;
    }
  }
  return false;
}

export function copyOwn(raw: object): Record<string, unknown> {
  const source = raw as Record<string, unknown>;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

export function copyList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.length > MAX_LIST_LENGTH ? OVER_CAP : Array.from(value as unknown[]);
}

/** The over-cap verifiedDomains list is never read, so membership in it cannot be checked. */
function authoritativeProblemsWithoutMembership(authoritative: unknown): string[] {
  if (authoritative === OVER_CAP) {
    return [];
  }
  const verifiedDomains = Array.isArray(authoritative)
    ? authoritative.filter((domain): domain is string => typeof domain === 'string')
    : [];
  return domainPolicyProblems({
    verifiedDomains,
    emailAuthoritativeDomains: authoritative,
    autoJoin: false,
  } as DomainPolicy).filter((problem) => problem.startsWith('emailAuthoritativeDomains'));
}

export interface PolicyCheck {
  readonly snapshot: unknown;
  readonly problems: readonly string[];
  readonly groups: boolean;
}

export function checkPolicy(raw: unknown): PolicyCheck {
  if (!isPlainContainer(raw)) {
    return { snapshot: raw, problems: domainPolicyProblems(raw as DomainPolicy), groups: false };
  }
  const problems: string[] = [];
  const groups = 'groups' in raw;
  if (hasHiddenKeys(raw, new Set(['groups']))) {
    problems.push(HIDDEN_KEYS_PROBLEM);
  }
  const copy = copyOwn(raw);
  for (const key of Object.keys(copy)) {
    if (!POLICY_KEYS.has(key) && key !== 'groups') {
      problems.push(`unsupported key ${JSON.stringify(key.slice(0, 40))}`);
    }
  }
  const snapshot = Object.freeze({
    verifiedDomains: copyList(copy['verifiedDomains']),
    emailAuthoritativeDomains:
      copy['emailAuthoritativeDomains'] === undefined
        ? []
        : copyList(copy['emailAuthoritativeDomains']),
    autoJoin: copy['autoJoin'],
  });
  if (snapshot.emailAuthoritativeDomains === OVER_CAP) {
    problems.push(`emailAuthoritativeDomains must list at most ${MAX_LIST_LENGTH} domains`);
  }
  if (snapshot.verifiedDomains === OVER_CAP) {
    problems.push(`verifiedDomains must list at most ${MAX_LIST_LENGTH} domains`);
    if (typeof snapshot.autoJoin !== 'boolean') {
      problems.push('autoJoin must be a boolean');
    }
    problems.push(...authoritativeProblemsWithoutMembership(snapshot.emailAuthoritativeDomains));
  } else {
    problems.push(
      ...domainPolicyProblems({
        ...snapshot,
        emailAuthoritativeDomains:
          snapshot.emailAuthoritativeDomains === OVER_CAP
            ? undefined
            : snapshot.emailAuthoritativeDomains,
      } as DomainPolicy),
    );
  }
  return { snapshot, problems, groups };
}
