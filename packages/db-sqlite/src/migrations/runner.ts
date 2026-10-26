import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  acquireMigrationLock,
  assertLockHeldStatement,
  DB_NOW,
  extendLockStatement,
  MigrationLockedError,
  releaseLockStatement,
  repairLockStatements,
} from './lock.js';
import { assertPlannedSources } from './plan.js';
import type { MigrationSource } from './source.js';
import { splitStatements } from './split.js';

const DEFAULT_LOCK_TTL_SECONDS = 600;
const DEFAULT_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 500;

export interface MigrateLogEvent {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly id?: string;
  readonly holder?: string;
}

export interface MigrateOptions {
  readonly holder: string;
  readonly lockTtlSeconds?: number;
  readonly lockWaitMs?: number;
  readonly dryRun?: boolean;
  readonly onBeforeApply?: (source: MigrationSource) => void | Promise<void>;
  readonly log?: (event: MigrateLogEvent) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
  readonly unknown: string[];
  readonly pending: string[];
}

export class MigrationChecksumError extends Error {
  readonly id: string;
  readonly stored: string;
  readonly computed: string;

  constructor(id: string, stored: string, computed: string) {
    super(`${id}: applied checksum ${stored} does not match the shipped checksum ${computed}`);
    this.name = 'MigrationChecksumError';
    this.id = id;
    this.stored = stored;
    this.computed = computed;
  }
}

export class MigrationApplyError extends Error {
  readonly id: string;

  constructor(id: string, cause: unknown) {
    super(`${id}: migration failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'MigrationApplyError';
    this.id = id;
  }
}

export class MigrationOrderError extends Error {
  readonly id: string;
  readonly appliedId: string;

  constructor(id: string, appliedId: string) {
    super(`${id}: pending migration sorts before the already applied ${appliedId}`);
    this.name = 'MigrationOrderError';
    this.id = id;
    this.appliedId = appliedId;
  }
}

export class MigrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationStateError';
  }
}

interface AppliedState {
  readonly appliedIds: Set<string>;
  readonly unknown: string[];
  readonly pending: MigrationSource[];
}

async function readTables(executor: ScalarSqlExecutor): Promise<Set<string>> {
  const rows = await executor.all<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migration', 'migration_lock')",
    params: [],
  });
  return new Set(rows.map((row) => row.name));
}

function bookkeepingInsert(source: MigrationSource): ScalarStatement {
  return {
    sql: 'INSERT INTO schema_migration (id, name, checksum) VALUES (?, ?, ?)',
    params: [source.id, source.name, source.checksum],
  };
}

function migrationBatch(source: MigrationSource): ScalarStatement[] {
  return [
    ...splitStatements(source.sql).map((sql) => ({ sql, params: [] })),
    bookkeepingInsert(source),
  ];
}

/** Migration bookkeeping is database-wide, independent of organization data. */
export async function schemaMigrationsMatch(
  executor: ScalarSqlExecutor,
  sources: readonly Pick<MigrationSource, 'id' | 'checksum'>[],
): Promise<boolean> {
  let applied: Map<string, string>;
  try {
    applied = await readApplied(executor);
  } catch (error) {
    if (isMissingSchemaTable(error)) return false;
    throw error;
  }
  return sources.every(({ id, checksum }) => applied.has(id) && applied.get(id) === checksum);
}

function isMissingSchemaTable(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (/\bno such table: (?:main\.)?schema_migration(?=[:\s]|$)/i.test(error.message)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

async function readApplied(executor: ScalarSqlExecutor): Promise<Map<string, string>> {
  const rows = await executor.all<{ id: string; checksum: string }>({
    sql: 'SELECT id, checksum FROM schema_migration',
    params: [],
  });
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

async function readAppliedState(
  executor: ScalarSqlExecutor,
  sources: readonly MigrationSource[],
): Promise<AppliedState> {
  const stored = await readApplied(executor);
  const shipped = new Set(sources.map((source) => source.id));

  for (const source of sources) {
    const checksum = stored.get(source.id);
    if (checksum !== undefined && checksum !== source.checksum) {
      throw new MigrationChecksumError(source.id, checksum, source.checksum);
    }
  }

  const pending = sources.filter((source) => !stored.has(source.id));
  for (const source of pending) {
    const later = sources.find(
      (other) =>
        stored.has(other.id) && other.owner === source.owner && other.sequence > source.sequence,
    );
    if (later !== undefined) throw new MigrationOrderError(source.id, later.id);
  }

  return {
    appliedIds: new Set(stored.keys()),
    unknown: [...stored.keys()].filter((id) => !shipped.has(id)),
    pending,
  };
}

async function isRecorded(executor: ScalarSqlExecutor, source: MigrationSource): Promise<boolean> {
  const tables = await readTables(executor);
  if (!tables.has('schema_migration')) return false;
  const rows = await executor.all<{ checksum: string }>({
    sql: 'SELECT checksum FROM schema_migration WHERE id = ?',
    params: [source.id],
  });
  return rows[0]?.checksum === source.checksum;
}

async function lockRow(
  executor: ScalarSqlExecutor,
): Promise<
  { holder: string | null; expires_at: string | null; expired: number | null } | undefined
> {
  const [row] = await executor.all<{
    holder: string | null;
    expires_at: string | null;
    expired: number | null;
  }>({
    sql: `SELECT holder, expires_at, expires_at < ${DB_NOW} AS expired FROM migration_lock WHERE id = 1`,
    params: [],
  });
  return row;
}

function safeLog(emit: (event: MigrateLogEvent) => void, event: MigrateLogEvent): void {
  try {
    const result: unknown = emit(event);
    if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
      Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // a failing logger must not change the outcome of a migration
  }
}

function attachCause(error: unknown, cause: unknown): void {
  if (error instanceof Error && error.cause === undefined) error.cause = cause;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && (error as { kind?: unknown }).kind === 'unique';
}

function validateOptions(options: MigrateOptions): void {
  if (typeof options.holder !== 'string' || options.holder === '') {
    throw new TypeError('holder must be a non-empty string');
  }
  const { lockTtlSeconds, lockWaitMs } = options;
  if (
    lockTtlSeconds !== undefined &&
    (!Number.isSafeInteger(lockTtlSeconds) || lockTtlSeconds <= 0)
  ) {
    throw new RangeError('lockTtlSeconds must be a positive integer');
  }
  if (lockWaitMs !== undefined && (!Number.isFinite(lockWaitMs) || lockWaitMs < 0)) {
    throw new RangeError('lockWaitMs must be a non-negative number');
  }
}

export async function migrate(
  executor: ScalarSqlExecutor,
  sources: readonly MigrationSource[],
  options: MigrateOptions,
): Promise<MigrateResult> {
  await assertPlannedSources(sources);
  validateOptions(options);
  const { holder } = options;
  const ttl = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const emit = options.log ?? ((): void => undefined);
  const log = (event: MigrateLogEvent): void => safeLog(emit, { ...event, holder });
  const [init] = sources as readonly [MigrationSource, ...MigrationSource[]];

  const applied: string[] = [];
  let tables = await readTables(executor);

  if (tables.has('migration_lock') && !tables.has('schema_migration')) {
    throw new MigrationStateError(
      'migration_lock exists but schema_migration does not: the database is half-initialized and needs manual repair',
    );
  }

  if (!tables.has('schema_migration')) {
    if (options.dryRun === true) {
      return { applied: [], skipped: [], unknown: [], pending: sources.map((s) => s.id) };
    }
    let freshApplied = false;
    try {
      await executor.batch(migrationBatch(init));
      freshApplied = true;
    } catch (error) {
      let recorded: boolean;
      try {
        recorded = await isRecorded(executor, init);
      } catch (recoveryError) {
        attachCause(error, recoveryError);
        throw error;
      }
      if (!recorded) throw error;
      log({
        level: 'warn',
        message: `${init.id} is already recorded; another runner applied it, or this runner's own response was lost`,
        id: init.id,
      });
    }
    if (freshApplied) {
      applied.push(init.id);
      log({ level: 'info', message: `applied ${init.id}`, id: init.id });
    }
    tables = await readTables(executor);
  }

  const state = await readAppliedState(executor, sources);
  const reportedUnknown = new Set<string>();
  const reportUnknown = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (reportedUnknown.has(id)) continue;
      reportedUnknown.add(id);
      log({ level: 'warn', message: `applied migration ${id} is not shipped by this build`, id });
    }
  };
  reportUnknown(state.unknown);
  const skippedOf = (current: AppliedState): string[] =>
    sources.filter((s) => current.appliedIds.has(s.id) && !applied.includes(s.id)).map((s) => s.id);

  if (state.pending.length === 0) {
    return { applied, skipped: skippedOf(state), unknown: state.unknown, pending: [] };
  }
  if (options.dryRun === true) {
    return {
      applied,
      skipped: skippedOf(state),
      unknown: state.unknown,
      pending: state.pending.map((s) => s.id),
    };
  }

  if (!tables.has('migration_lock') || (await lockRow(executor)) === undefined) {
    await executor.batch(repairLockStatements());
  }

  const deadline = now() + waitMs;
  let announcedWait = false;
  for (;;) {
    try {
      await acquireMigrationLock(executor, holder, ttl);
      break;
    } catch (error) {
      if (!(error instanceof MigrationLockedError)) throw error;
      if (error.holder === null && (await lockRow(executor)) === undefined) throw error;
      if (now() >= deadline) {
        log({ level: 'warn', message: 'timed out waiting for the migration lock' });
        throw error;
      }
      if (error.holder === null) continue;
      if (!announcedWait) {
        announcedWait = true;
        log({ level: 'info', message: `migration lock is held by ${error.holder}, waiting` });
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  try {
    log({ level: 'info', message: 'migration lock acquired' });
    const current = await readAppliedState(executor, sources);
    reportUnknown(current.unknown);
    const lostRace: string[] = [];
    for (const source of current.pending) {
      await options.onBeforeApply?.(source);
      try {
        await executor.batch([
          assertLockHeldStatement(holder),
          ...migrationBatch(source),
          extendLockStatement(holder, ttl),
        ]);
      } catch (error) {
        if (await recordedAfterError(executor, source, error)) {
          if (await holdsLease(executor, holder)) {
            log({
              level: 'warn',
              message: `${source.id} is recorded although the batch reported an error: applied, response lost`,
              id: source.id,
            });
          } else {
            lostRace.push(source.id);
            log({
              level: 'warn',
              message: `${source.id} is recorded but this runner no longer holds the lock: another runner applied it`,
              id: source.id,
            });
            continue;
          }
        } else {
          await rethrowApplyFailure(executor, source, holder, error);
        }
      }
      applied.push(source.id);
      log({ level: 'info', message: `applied ${source.id}`, id: source.id });
    }
    return {
      applied,
      skipped: [...skippedOf(current), ...lostRace],
      unknown: current.unknown,
      pending: [],
    };
  } finally {
    await executor.all(releaseLockStatement(holder)).then(
      () => log({ level: 'info', message: 'migration lock released' }),
      (error: unknown) => {
        log({
          level: 'warn',
          message: `lock release failed, it expires on its own: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
  }
}

async function recordedAfterError(
  executor: ScalarSqlExecutor,
  source: MigrationSource,
  error: unknown,
): Promise<boolean> {
  try {
    return await isRecorded(executor, source);
  } catch (readError) {
    attachCause(error, readError);
    return false;
  }
}

async function holdsLease(executor: ScalarSqlExecutor, holder: string): Promise<boolean> {
  const row = await lockRow(executor).catch(() => undefined);
  return row !== undefined && row.holder === holder && row.expired !== 1;
}

async function rethrowApplyFailure(
  executor: ScalarSqlExecutor,
  source: MigrationSource,
  holder: string,
  error: unknown,
): Promise<never> {
  if (isUniqueViolation(error)) {
    const row = await lockRow(executor).catch(() => undefined);
    if (row !== undefined && row.holder === holder && row.expired === 1) {
      throw new MigrationApplyError(
        source.id,
        new Error('the lock lease expired during the run', { cause: error }),
      );
    }
    if (row === undefined || row.holder !== holder) {
      const locked = new MigrationLockedError(row?.holder ?? null, row?.expires_at ?? null);
      locked.cause = error;
      throw locked;
    }
  }
  throw new MigrationApplyError(source.id, error);
}
