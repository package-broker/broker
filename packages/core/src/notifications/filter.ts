import { isStoredKey, isValidPattern, matchesPattern } from '../catalogue/patterns.js';

export const DEFAULT_NOTIFICATION_PATTERN = '*';

/**
 * A notification filter is one restricted glob over the stored package key: `*` is the only
 * wildcard and may span `/`; everything else matches itself, case-sensitively.
 */
export function isNotificationPattern(pattern: unknown): pattern is string {
  return typeof pattern === 'string' && isValidPattern(pattern);
}

export const isStoredPackageKey = isStoredKey;

/** False for any key or pattern outside the restricted alphabets, never a display-name match. */
export function notificationFilterMatches(pattern: string, storedKey: string): boolean {
  if (!isNotificationPattern(pattern) || !isStoredPackageKey(storedKey)) return false;
  return matchesPattern(pattern, storedKey);
}
