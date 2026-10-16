import { sql, type SqlBool } from 'kysely';
import type { Guard } from '../kysely.js';

export const DEFAULT_IDLE_SECONDS = 3600;

/** Integer seconds from 60 to 86400; `RangeError` otherwise. */
export function requireIdleSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 60 || value > 86400) {
    throw new RangeError('idleSeconds must be an integer from 60 to 86400');
  }
  return value;
}

/**
 * The session row under `alias` is not revoked, not expired and was seen (or created) within the
 * last `idleSeconds`, all against database time. A stored timestamp SQLite cannot parse yields
 * NULL, so the session counts as not live. Binds no parameters.
 */
export function liveSessionCondition(alias: string, idleSeconds: number): Guard {
  const idle = sql.lit(requireIdleSeconds(idleSeconds));
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<SqlBool>`(${column('revoked_at')} is null
    and unixepoch(${column('expires_at')}, 'subsec') > unixepoch('now', 'subsec')
    and unixepoch(coalesce(${column('last_seen_at')}, ${column('created_at')}), 'subsec') > unixepoch('now', 'subsec') - ${idle})`;
}
