import { MAX_KEY_LENGTH } from './names.js';

export const MAX_PATTERN_BYTES = 50;
export const MAX_PATTERN_WILDCARDS = 4;
export const MAX_PATTERNS_PER_RULE = 64;

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

export interface VisibilityRule {
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly flag: 0 | 1;
}

export const PATTERN_ALPHABET = /^[a-z0-9._~@!/*-]+$/;

export function isValidPattern(pattern: string): boolean {
  return isPatternSyntax(pattern, MAX_PATTERN_BYTES);
}

export function isPatternSyntax(pattern: string, maxLength: number): boolean {
  if (pattern.length < 1 || pattern.length > maxLength || !PATTERN_ALPHABET.test(pattern)) {
    return false;
  }
  return pattern.split('*').length - 1 <= MAX_PATTERN_WILDCARDS;
}

export function matchesPattern(pattern: string, key: string): boolean {
  if (!isPatternSyntax(pattern, MAX_KEY_LENGTH)) {
    throw new PatternError('invalid_pattern');
  }
  const segments = pattern.split('*');
  const first = segments[0] ?? '';
  if (segments.length === 1) {
    return key === first;
  }
  const last = segments[segments.length - 1] ?? '';
  if (key.length < first.length + last.length || !key.startsWith(first) || !key.endsWith(last)) {
    return false;
  }
  const end = key.length - last.length;
  let position = first.length;
  for (const segment of segments.slice(1, -1)) {
    const found = key.indexOf(segment, position);
    if (found < 0 || found + segment.length > end) {
      return false;
    }
    position = found + segment.length;
  }
  return true;
}

export function patternAdmits(rule: VisibilityRule, key: string): boolean {
  if (rule.flag !== 1) {
    return false;
  }
  if (
    rule.includes.length > MAX_PATTERNS_PER_RULE ||
    rule.excludes.length > MAX_PATTERNS_PER_RULE
  ) {
    return false;
  }
  if (![...rule.includes, ...rule.excludes].every(isValidPattern)) {
    return false;
  }
  if (rule.includes.length > 0 && !rule.includes.some((p) => matchesPattern(p, key))) {
    return false;
  }
  return !rule.excludes.some((p) => matchesPattern(p, key));
}
