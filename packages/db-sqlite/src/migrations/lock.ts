import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

export const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const DB_NOW_PLUS = "strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)";

export class MigrationLockedError extends Error {
  readonly holder: string | null;
  readonly expiresAt: string | null;

  constructor(holder: string | null, expiresAt: string | null) {
    super(
      holder === null
        ? 'migration lock is unavailable: the lock row is missing or unowned'
        : `migration lock is held by ${holder} until ${expiresAt ?? 'an unknown time'}`,
    );
    this.name = 'MigrationLockedError';
    this.holder = holder;
    this.expiresAt = expiresAt;
  }
}

function ttlModifier(ttlSeconds: number): string {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive integer');
  }
  return `+${ttlSeconds} seconds`;
}

export function repairLockStatements(): ScalarStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS migration_lock (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  acquired_at TEXT,
  expires_at  TEXT
) STRICT`,
      params: [],
    },
    { sql: 'INSERT OR IGNORE INTO migration_lock (id) VALUES (1)', params: [] },
  ];
}

export function acquireLockStatement(holder: string, ttlSeconds: number): ScalarStatement {
  return {
    sql: `UPDATE migration_lock SET holder = ?, acquired_at = ${DB_NOW}, expires_at = ${DB_NOW_PLUS} WHERE id = 1 AND (holder IS NULL OR expires_at < ${DB_NOW}) RETURNING holder`,
    params: [holder, ttlModifier(ttlSeconds)],
  };
}

export function readLockStatement(): ScalarStatement {
  return { sql: 'SELECT holder, expires_at FROM migration_lock WHERE id = 1', params: [] };
}

export function assertLockHeldStatement(holder: string): ScalarStatement {
  return {
    sql: `INSERT INTO migration_lock (id) SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) WHERE NOT EXISTS (SELECT 1 FROM migration_lock WHERE id = 1 AND holder = ? AND expires_at >= ${DB_NOW})`,
    params: [holder],
  };
}

export function extendLockStatement(holder: string, ttlSeconds: number): ScalarStatement {
  return {
    sql: `UPDATE migration_lock SET expires_at = ${DB_NOW_PLUS} WHERE id = 1 AND holder = ?`,
    params: [ttlModifier(ttlSeconds), holder],
  };
}

export function releaseLockStatement(holder: string): ScalarStatement {
  return {
    sql: 'UPDATE migration_lock SET holder = NULL, acquired_at = NULL, expires_at = NULL WHERE id = 1 AND holder = ?',
    params: [holder],
  };
}

export async function acquireMigrationLock(
  executor: ScalarSqlExecutor,
  holder: string,
  ttlSeconds: number,
): Promise<void> {
  const acquired = await executor.all(acquireLockStatement(holder, ttlSeconds));
  if (acquired.length > 0) return;

  const [row] = await executor.all<{ holder: string | null; expires_at: string | null }>(
    readLockStatement(),
  );
  throw new MigrationLockedError(row?.holder ?? null, row?.expires_at ?? null);
}
