import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertCheck, existsGuard } from '@package-broker/db-sqlite/kysely';
import { collectMigrations, defaultResolvePackageDir } from '../migrations-collect.js';
import { auditEvent } from '@package-broker/core/audit/actions';
import {
  orgContext,
  type ScalarSqlExecutor,
  type ScalarStatement,
  type Statement,
} from '@package-broker/core/db/port';
import { createAuditLedgerRepository } from '@package-broker/db-sqlite/repositories/audit-ledger';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import {
  auditEpochCarryStatements,
  AuditEpochCarryLimitError,
} from '@package-broker/db-sqlite/repositories/audit-epoch-carry';
import { openTarget, type AdminTarget } from './admin.js';
import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '@package-broker/core/db/errors';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { MigrationLockedError } from '@package-broker/db-sqlite/migrations/lock';
import { migrate, MigrationChecksumError } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { isLostResponse } from '../cloudflare/d1-http-executor.js';
import { D1_STATEMENTS_PER_BATCH } from '@package-broker/core/db/port';
import { BuiltManifestError, loadBuiltMigrations, routesAreValid } from './built-manifest.js';

function reportError(error: unknown): void {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  const text =
    typeof name === 'string' && typeof message === 'string'
      ? `${name}: ${message}`
      : `Error: ${String(error)}`;
  console.error(text.replace(/[\r\n]+/g, ' '));
}

export async function runMigrateSqlite(o: {
  file: string;
  outDir: string;
  dryRun: boolean;
}): Promise<number> {
  try {
    const sources = await loadBuiltMigrations(o.outDir);
    if (!(await routesAreValid(o.outDir))) return 2;
    const opened = openBetterSqliteExecutor(o.file);
    try {
      const result = await migrate(opened.executor, sources, { holder: ulid(), dryRun: o.dryRun });
      console.log(JSON.stringify(result));
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    reportError(error);
    if (
      error instanceof MigrationChecksumError ||
      (error instanceof BuiltManifestError &&
        /checksum does not match the file/.test(error.message))
    )
      return 3;
    if (
      error instanceof MigrationLockedError ||
      (error instanceof DbError && error.kind === 'busy')
    )
      return 4;
    return 1;
  }
}

export async function runBootstrapSqlite(o: {
  file: string;
  slug: string;
  name: string;
}): Promise<number> {
  if (!ORG_SLUG_PATTERN.test(o.slug)) {
    reportError(new TypeError(`invalid organization slug ${JSON.stringify(o.slug)}`));
    return 2;
  }
  try {
    const opened = openBetterSqliteExecutor(o.file);
    try {
      const result = await createOrganizationBootstrap(opened.executor).bootstrap({
        id: ulid(),
        slug: o.slug,
        name: o.name,
        now: isoTimestamp(systemClock.now()),
      });
      if (!result.created && result.slug !== o.slug) {
        reportError(
          Object.assign(new Error(`organization already bootstrapped as ${result.slug}`), {
            name: 'AlreadyBootstrapped',
          }),
        );
        return 5;
      }
      console.log(JSON.stringify(result));
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    reportError(error);
    return 1;
  }
}

type RestoreReason =
  | 'target_exists'
  | 'invalid_snapshot'
  | 'migration_mismatch'
  | 'chain_missing'
  | 'fk_violation'
  | 'concurrent_change'
  | 'batch_limit'
  | 'io_error'
  | 'internal';

class RestoreError extends Error {
  constructor(readonly reason: RestoreReason) {
    super(reason);
  }
}

function restoreReason(error: unknown): RestoreReason {
  if (error instanceof RestoreError) return error.reason;
  if (error instanceof BuiltManifestError) return 'migration_mismatch';
  if (error instanceof DbError && error.kind === 'foreign_key') return 'fk_violation';
  if (error instanceof DbError && error.kind === 'busy') return 'concurrent_change';
  if (isLostResponse(error)) return 'io_error';
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (
      code &&
      /^(?:EACCES|EPERM|ENOENT|ENOSPC|EIO|EROFS|EMFILE|ENFILE|ENOTDIR|EISDIR|EFBIG|EDQUOT|SQLITE_IOERR.*|SQLITE_CANTOPEN|SQLITE_FULL|SQLITE_READONLY.*)$/.test(
        code,
      )
    )
      return 'io_error';
  }
  return 'internal';
}

function scalarStatement(statement: Statement): ScalarStatement {
  return {
    ...statement,
    params: statement.params.map((value) => {
      if (value instanceof Uint8Array) throw new RestoreError('invalid_snapshot');
      return value;
    }),
  };
}

interface RestoreChain {
  chainId: string;
  epoch: number;
  incarnation: number;
  headSeq: number;
  policy: 'availability' | 'required';
  modeGeneration: number;
}

/* eslint-disable no-restricted-syntax -- Offline restore and epoch maintenance own schema loading and organization-scoped control SQL. */
async function restoreMarkStatements(
  executor: ScalarSqlExecutor,
  orgId: string,
): Promise<Statement[]> {
  const ctx = orgContext(orgId);
  const [chain] = await executor.all<RestoreChain>({
    sql: `SELECT chain_id AS chainId, epoch, incarnation, head_seq AS headSeq,
      policy, mode_generation AS modeGeneration FROM audit_chain WHERE org_id = ?`,
    params: [orgId],
  });
  if (!chain) throw new RestoreError('chain_missing');
  const epoch = chain.epoch + 1;
  const now = isoTimestamp(systemClock.now());
  let carry: Statement[];
  try {
    carry = await auditEpochCarryStatements(executor, orgId, epoch, now);
  } catch (error) {
    if (error instanceof AuditEpochCarryLimitError) throw new RestoreError('batch_limit');
    throw error;
  }
  const event = auditEvent({
    id: ulid(),
    now,
    action: 'audit.sink_admin',
    actor: { type: 'system', id: null },
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    target: { type: 'organization', id: orgId },
    changes: { operation: { new: 'epoch_bump' }, epoch: { new: epoch } },
  });
  if (!event.ok) throw new Error('audit control event refused');
  const pending = auditPendingStatement(ctx, event.event);
  return [
    ...assertCheck(
      existsGuard((db) =>
        db
          .selectFrom('audit_chain')
          .select('org_id')
          .where('org_id', '=', orgId)
          .where('chain_id', '=', chain.chainId)
          .where('epoch', '=', chain.epoch)
          .where('incarnation', '=', chain.incarnation)
          .where('head_seq', '=', chain.headSeq)
          .where('policy', '=', chain.policy)
          .where('mode_generation', '=', chain.modeGeneration),
      ),
    ),
    ...carry,
    {
      sql: `UPDATE audit_chain SET restore_pending = 1, incarnation = incarnation + 1,
        epoch = epoch + 1, verified_from_seq = NULL, verified_through_seq = NULL,
        verified_bodies = 0, verified_withheld = 0, verified_at = NULL
        WHERE org_id = ? AND chain_id = ? AND epoch = ? AND incarnation = ?
        AND head_seq = ? AND policy = ? AND mode_generation = ?`,
      params: [
        orgId,
        chain.chainId,
        chain.epoch,
        chain.incarnation,
        chain.headSeq,
        chain.policy,
        chain.modeGeneration,
      ],
    },
    {
      sql: `UPDATE audit_sink SET state = 'blocked', blocked_reason = COALESCE(blocked_reason, 'fork'), updated_at = ?
        WHERE org_id = ? AND state IN ('active', 'blocked')`,
      params: [now, orgId],
    },
    ...createAuditLedgerRepository(executor).statements(ctx, [
      {
        id: ulid(),
        kind: 'epoch_bump',
        chainId: chain.chainId,
        epoch,
        fromSeq: Math.max(1, chain.headSeq),
        toSeq: Math.max(1, chain.headSeq),
        count: 0,
        sinkId: null,
        reasonCode: 'restore_detected',
        policy: chain.policy,
        modeGeneration: chain.modeGeneration,
        actorType: 'system',
        actorId: null,
        createdAt: now,
      },
    ]),
    pending,
  ];
}

async function applyRestoreMarks(
  executor: ScalarSqlExecutor,
  statements: Statement[],
): Promise<void> {
  try {
    await executor.batch(statements.map(scalarStatement));
  } catch (error) {
    if (
      error instanceof DbError &&
      (error.kind === 'busy' ||
        error.kind === 'check' ||
        (error.kind === 'unique' && error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT))
    )
      throw new RestoreError('concurrent_change');
    throw error;
  }
}

export async function runAuditEpochBump(o: { target: AdminTarget }): Promise<number> {
  try {
    const opened = openTarget('audit epoch bump', o.target);
    if (opened === null) return 2;
    try {
      // Deployment-wide discovery; every control statement is organization-scoped.
      const organizations = await opened.executor.all<{ id: string }>({
        sql: 'SELECT id FROM organization',
        params: [],
      });
      if (!organizations.length) throw new RestoreError('chain_missing');
      const statements: Statement[] = [];
      for (const { id } of organizations)
        statements.push(...(await restoreMarkStatements(opened.executor, id)));
      if (statements.length > D1_STATEMENTS_PER_BATCH) throw new RestoreError('batch_limit');
      await applyRestoreMarks(opened.executor, statements);
      console.log(JSON.stringify({ restorePending: true, sinksBlocked: true }));
      console.error('audit.restore_detected: confirm restore before resuming audit delivery');
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    console.error(`AuditEpochBumpError: ${restoreReason(error)}`);
    return 1;
  }
}

function snapshotStatements(input: unknown): Statement[] {
  if (!Array.isArray(input)) throw new RestoreError('invalid_snapshot');
  return input.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new RestoreError('invalid_snapshot');
    const { sql, params } = entry as { sql?: unknown; params?: unknown };
    if (
      typeof sql !== 'string' ||
      !Array.isArray(params) ||
      params.length > 100 ||
      Buffer.byteLength(sql) >= 100_000 ||
      !/^(?:CREATE\s+(?:(?:UNIQUE\s+)?INDEX|TABLE|TRIGGER|VIEW)\b|INSERT\s+INTO\b|PRAGMA defer_foreign_keys = ON$)/i.test(
        sql,
      )
    )
      throw new RestoreError('invalid_snapshot');
    return {
      sql,
      params: params.map((value: unknown) => {
        if (value === null || typeof value === 'string') return value;
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value))
        )
          return value;
        if (
          typeof value === 'object' &&
          value !== null &&
          'hex' in value &&
          typeof value.hex === 'string' &&
          /^(?:[0-9a-f]{2})*$/i.test(value.hex)
        )
          return Buffer.from(value.hex, 'hex');
        throw new RestoreError('invalid_snapshot');
      }),
    };
  });
}

interface SchemaObject {
  type: string;
  name: string;
  sql: string | null;
}

async function schemaObjects(executor: ScalarSqlExecutor): Promise<SchemaObject[]> {
  return executor.all<SchemaObject>({
    sql: "SELECT type, name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name",
    params: [],
  });
}

export async function runRestoreSqlite(o: {
  file: string;
  snapshot: string;
  outDir?: string | undefined;
}): Promise<number> {
  let created = false;
  let restored = false;
  let previousUmask: number | undefined;
  try {
    const input = await readFile(o.snapshot, 'utf8');
    let statements: Statement[];
    try {
      statements = snapshotStatements(JSON.parse(input));
    } catch (error) {
      if (error instanceof SyntaxError) throw new RestoreError('invalid_snapshot');
      throw error;
    }
    const sources = o.outDir
      ? await loadBuiltMigrations(o.outDir)
      : await collectMigrations(
          [],
          defaultResolvePackageDir(fileURLToPath(new URL('../', import.meta.url))),
        );
    const reference = openBetterSqliteExecutor(':memory:');
    let expectedSchema: SchemaObject[];
    let allowedSql: Set<string>;
    try {
      await migrate(reference.executor, sources, { holder: ulid() });
      expectedSchema = await schemaObjects(reference.executor);
      allowedSql = new Set(
        expectedSchema
          .filter((row) => row.type === 'trigger' || row.type === 'view')
          .map((row) => row.sql!),
      );
    } finally {
      await reference.close();
    }
    for (const { sql, params } of statements)
      if (/^CREATE\s+(?:TRIGGER|VIEW)\b/i.test(sql) && (params.length || !allowedSql.has(sql)))
        throw new RestoreError('migration_mismatch');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const exists = await lstat(o.file + suffix).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) throw new RestoreError('target_exists');
    }
    const reservation = await open(o.file, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new RestoreError('target_exists');
      throw error;
    });
    created = true;
    await reservation.close();
    previousUmask = process.umask(0o077);
    const opened = openBetterSqliteExecutor(o.file);
    try {
      await opened.executor.all({ sql: 'BEGIN IMMEDIATE', params: [] });
      try {
        await opened.executor.all({ sql: 'PRAGMA defer_foreign_keys = ON', params: [] });
        const schema = statements.filter(({ sql }) =>
          /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\b/i.test(sql),
        );
        const rows = statements.filter(({ sql }) => /^INSERT\s+INTO\b/i.test(sql));
        const triggers = statements.filter(({ sql }) => /^CREATE\s+(?:TRIGGER|VIEW)\b/i.test(sql));
        for (const phase of [schema, rows, triggers]) {
          for (const statement of phase) {
            try {
              await opened.executor.all(statement);
            } catch (error) {
              if (error instanceof DbError) {
                if (phase === rows && ['check', 'unique', 'not_null'].includes(error.kind))
                  throw new RestoreError('invalid_snapshot');
                if (phase !== rows && restoreReason(error) === 'internal')
                  throw new RestoreError('migration_mismatch');
              }
              throw error;
            }
          }
          if (
            phase === schema &&
            JSON.stringify(await schemaObjects(opened.executor)) !==
              JSON.stringify(
                expectedSchema.filter(({ type }) => type === 'table' || type === 'index'),
              )
          )
            throw new RestoreError('migration_mismatch');
        }
        if (JSON.stringify(await schemaObjects(opened.executor)) !== JSON.stringify(expectedSchema))
          throw new RestoreError('migration_mismatch');
        // Organization discovery is deployment-wide; every audit mutation is scoped separately.
        const organizations = await opened.executor.all<{ id: string }>({
          sql: 'SELECT id FROM organization',
          params: [],
        });
        if (!organizations.length) throw new RestoreError('invalid_snapshot');
        const migrations = await opened.executor.all<{ id: string; checksum: string }>({
          sql: 'SELECT id, checksum FROM schema_migration',
          params: [],
        });
        if (
          migrations.length !== sources.length ||
          sources.some(
            (source) =>
              !migrations.some(
                ({ id, checksum }) => id === source.id && checksum === source.checksum,
              ),
          )
        )
          throw new RestoreError('migration_mismatch');
        if ((await opened.executor.all({ sql: 'PRAGMA foreign_key_check', params: [] })).length)
          throw new RestoreError('fk_violation');
        for (const { id } of organizations)
          await applyRestoreMarks(
            opened.executor,
            await restoreMarkStatements(opened.executor, id),
          );
        await opened.executor.all({ sql: 'COMMIT', params: [] });
        restored = true;
      } catch (error) {
        await opened.executor.all({ sql: 'ROLLBACK', params: [] }).catch(() => undefined);
        throw error;
      }
    } finally {
      await opened.close();
    }
    console.log(JSON.stringify({ restored: true, restorePending: true, sinksBlocked: true }));
    console.error('audit.restore_detected: confirm restore before resuming audit delivery');
    return 0;
  } catch (error) {
    console.error(`SqliteRestoreError: ${restoreReason(error)}`);
    return 1;
  } finally {
    if (previousUmask !== undefined) process.umask(previousUmask);
    if (created && !restored) {
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        await unlink(o.file + suffix).catch(() => undefined);
    }
  }
}

/* eslint-enable no-restricted-syntax */
