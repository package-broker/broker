import { sql } from 'kysely';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { JobGuard } from '@package-broker/core/platform/job-repository';
import { ulid } from '@package-broker/core/ids';
import type {
  IngestScopeRef,
  IngestSessionHandle,
  IngestSessionLatest,
  IngestSessionMaintenance,
  IngestSessions,
} from '@package-broker/core/ingest/session';
import { assertCheck, compile, db } from '../kysely.js';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { leaseKey } from './fetch-lease.js';
import { FORMAT, NOW, seconds, until } from '../internal/lease-time.js';
import { jobLeaseGuard } from './job-lease-guard.js';

export type {
  IngestScopeRef,
  IngestSessionHandle,
  IngestSessionLatest,
  IngestSessionProgress,
  IngestSessionMaintenance,
  IngestSessionState,
  IngestSessions,
} from '@package-broker/core/ingest/session';

const MAX_TEXT = 512;
const MAX_VALIDATORS_BYTES = 16_384;
const SHA256 = /^[0-9a-f]{64}$/;
export const INGEST_CURSOR_MAX_BYTES = 4096;
export const INGEST_SESSION_GC_LIMIT = 20;
export const INGEST_SESSION_SWEEP_LIMIT = 100;
export const INGEST_SESSION_DEAD_DAYS = 7;

function text(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new RangeError(
      `${field} must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

function positive(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

function sha(field: string, value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new RangeError(`${field} must be 64 lowercase hex characters`);
  }
  return value;
}

function scopeParts(scope: IngestScopeRef): { sourceId: string; packageKey: string | null } {
  const sourceId = text('sourceId', scope.sourceId);
  if (scope.scope === 'package') {
    return { sourceId, packageKey: text('packageKey', scope.packageKey) };
  }
  if (scope.scope === 'source' && !('packageKey' in scope)) return { sourceId, packageKey: null };
  throw new RangeError('scope must be a source listing or a package');
}

function identity(guard: IngestSessionHandle) {
  return {
    id: text('id', guard.id),
    owner: text('owner', guard.owner),
    fence: positive('fence', guard.fence),
  };
}

function holds(ctx: OrgContext, guard: IngestSessionHandle) {
  const { id, owner, fence } = identity(guard);
  return sql<boolean>`ingest_session.id = ${id} AND ingest_session.org_id = ${ctx.orgId}
    AND ingest_session.owner = ${owner} AND ingest_session.fence = ${fence}
    AND ingest_session.state = 'running' AND ingest_session.lease_until > ${NOW}`;
}

export function ingestSessionGuard(
  ctx: OrgContext,
  handle: IngestSessionHandle,
): readonly Statement[] {
  return assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM ingest_session WHERE ${holds(ctx, handle)})`,
  );
}

export function createIngestSessionWriteGuard(
  ctx: OrgContext,
  handle: IngestSessionHandle,
  job?: JobGuard,
): CatalogueWriteGuard {
  return registerCatalogueWriteGuard(ctx, [
    ...ingestSessionGuard(ctx, handle),
    ...(job === undefined ? [] : jobLeaseGuard(ctx, job)),
  ]);
}

interface SessionRow {
  id: string;
  scope_key: string;
  owner: string;
  fence: number;
  generation: number;
  stamp: string | null;
  snapshot_id: string | null;
  snapshot_blob_sha256: string | null;
  cursor: string | null;
  seen_count: number;
  pages_so_far: number;
  pending_validators: string | null;
}

interface LatestRow {
  state: IngestSessionLatest['state'];
  generation: number;
  fence: number;
  seen_count: number;
  pages_so_far: number;
}

function handleOf(row: SessionRow, leaseSeconds: number): IngestSessionHandle {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    owner: row.owner,
    fence: row.fence,
    leaseSeconds,
    generation: row.generation,
    stamp: row.stamp,
    snapshotId: row.snapshot_id,
    snapshotBlobSha256: row.snapshot_blob_sha256,
    cursor: row.cursor,
    seenCount: row.seen_count,
    pagesSoFar: row.pages_so_far,
    pendingValidators:
      row.pending_validators === null
        ? null
        : (JSON.parse(row.pending_validators) as Record<string, unknown>),
  };
}

function cursorOf(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length > INGEST_CURSOR_MAX_BYTES
  ) {
    throw new RangeError(
      `cursor must be a string of at most ${String(INGEST_CURSOR_MAX_BYTES)} bytes`,
    );
  }
  return value;
}

function validatorsOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('pending validators must be a plain object or null');
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > MAX_VALIDATORS_BYTES) {
    throw new RangeError(
      `pending validators must be at most ${String(MAX_VALIDATORS_BYTES)} bytes`,
    );
  }
  return json;
}

export function createIngestSessions(executor: SqlExecutor): IngestSessions {
  async function changed(statement: Statement): Promise<boolean> {
    const [result] = await executor.batch([statement]);
    return (result?.changes ?? 0) === 1;
  }

  return {
    async acquire(ctx, scope, holder, leaseSeconds) {
      const { sourceId, packageKey } = scopeParts(scope);
      const o = text('owner', holder);
      const duration = seconds(leaseSeconds);
      const scopeKey = await leaseKey([
        ctx.orgId,
        'ingest',
        scope.scope,
        sourceId,
        packageKey ?? '',
      ]);
      const acquire = compile(
        db
          .insertInto('ingest_session')
          .columns([
            'id',
            'org_id',
            'scope',
            'scope_key',
            'source_id',
            'package_key',
            'generation',
            'owner',
            'fence',
            'lease_until',
            'state',
            'started_at',
            'updated_at',
          ])
          .expression(
            db
              .selectFrom('source')
              .select([
                sql<string>`${ulid()}`.as('id'),
                'source.org_id',
                sql<string>`${scope.scope}`.as('scope'),
                sql<string>`${scopeKey}`.as('scope_key'),
                sql<string>`${sourceId}`.as('source_id'),
                sql<string | null>`${packageKey}`.as('package_key'),
                sql<number>`(SELECT COALESCE(MAX(prior.generation), 0) + 1 FROM ingest_session AS prior
                  WHERE prior.org_id = ${ctx.orgId} AND prior.scope_key = ${scopeKey})`.as(
                  'generation',
                ),
                sql<string>`${o}`.as('owner'),
                sql<number>`1`.as('fence'),
                until(duration).as('lease_until'),
                sql<'running'>`'running'`.as('state'),
                sql<string>`${NOW}`.as('started_at'),
                sql<string>`${NOW}`.as('updated_at'),
              ])
              .where('source.id', '=', sourceId)
              .where('source.org_id', '=', ctx.orgId),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['org_id', 'scope_key'])
              .where(sql<boolean>`state = 'running'`)
              .doUpdateSet({
                owner: o,
                fence: sql<number>`ingest_session.fence + 1`,
                lease_until: until(duration),
                updated_at: NOW as never,
              })
              .where(sql<boolean>`ingest_session.lease_until <= ${NOW}`),
          )
          .returning([
            'id',
            'scope_key',
            'owner',
            'fence',
            'generation',
            'stamp',
            'snapshot_id',
            'snapshot_blob_sha256',
            'cursor',
            'seen_count',
            'pages_so_far',
            'pending_validators',
          ]),
      );
      const collect = compile(
        db.deleteFrom('ingest_session').where(
          'id',
          'in',
          db
            .selectFrom('ingest_session as old')
            .select('old.id')
            .where('old.org_id', '=', ctx.orgId)
            .where('old.scope_key', '=', scopeKey)
            .where('old.state', '<>', 'running')
            .where(
              'old.generation',
              '<',
              sql<number>`(SELECT MAX(latest.generation) FROM ingest_session AS latest
                WHERE latest.org_id = ${ctx.orgId} AND latest.scope_key = ${scopeKey})`,
            )
            .orderBy('old.generation')
            .limit(INGEST_SESSION_GC_LIMIT),
        ),
      );
      const [result] = await executor.batch([acquire, collect]);
      const row = result?.rows[0] as SessionRow | undefined;
      if (row === undefined) {
        const sources = await executor.all(
          compile(
            db
              .selectFrom('source')
              .select('id')
              .where('id', '=', sourceId)
              .where('org_id', '=', ctx.orgId),
          ),
        );
        if (sources.length === 0) throw new RangeError('no such source in this org');
        return 'held';
      }
      if (row.owner !== o) return 'held';
      return handleOf(row, duration);
    },

    start(ctx, guard, input) {
      const id = text('snapshot id', input.snapshot.id);
      const blob =
        input.snapshot.blobSha256 === undefined
          ? null
          : sha('blobSha256', input.snapshot.blobSha256);
      return changed(
        compile(
          db
            .updateTable('ingest_session')
            .set({
              snapshot_id: id,
              snapshot_blob_sha256: blob,
              stamp: text('stamp', input.stamp),
              updated_at: NOW as never,
            })
            .where(holds(ctx, guard))
            .where('stamp', 'is', null),
        ),
      );
    },

    async advance(ctx, guard, input) {
      const cursor = cursorOf(input.cursor);
      if (
        typeof input.addSeen !== 'number' ||
        !Number.isSafeInteger(input.addSeen) ||
        input.addSeen < 0
      ) {
        throw new RangeError('addSeen must be a non-negative integer');
      }
      const [result] = await executor.batch([
        compile(
          db
            .updateTable('ingest_session')
            .set({
              cursor,
              seen_count: sql<number>`ingest_session.seen_count + ${input.addSeen}`,
              pages_so_far: sql<number>`ingest_session.pages_so_far + 1`,
              lease_until: until(seconds(guard.leaseSeconds)),
              updated_at: NOW as never,
            })
            .where(holds(ctx, guard))
            .returning(['seen_count', 'pages_so_far']),
        ),
      ]);
      const row = result?.rows[0] as { seen_count: number; pages_so_far: number } | undefined;
      return row === undefined ? null : { seenCount: row.seen_count, pagesSoFar: row.pages_so_far };
    },

    setPendingValidators(ctx, guard, validators) {
      return changed(
        compile(
          db
            .updateTable('ingest_session')
            .set({ pending_validators: validatorsOf(validators), updated_at: NOW as never })
            .where(holds(ctx, guard)),
        ),
      );
    },

    async latest(ctx, scope) {
      const { sourceId, packageKey } = scopeParts(scope);
      const scopeKey = await leaseKey([
        ctx.orgId,
        'ingest',
        scope.scope,
        sourceId,
        packageKey ?? '',
      ]);
      const [row] = (await executor.all(
        compile(
          db
            .selectFrom('ingest_session')
            .select(['state', 'generation', 'fence', 'seen_count', 'pages_so_far'])
            .where('org_id', '=', ctx.orgId)
            .where('scope_key', '=', scopeKey)
            .orderBy('generation', 'desc')
            .limit(1),
        ),
      )) as LatestRow[];
      return row === undefined
        ? null
        : {
            state: row.state,
            generation: row.generation,
            fence: row.fence,
            seenCount: row.seen_count,
            pagesSoFar: row.pages_so_far,
          };
    },

    abandon(ctx, guard) {
      return changed(
        compile(
          db
            .updateTable('ingest_session')
            .set({ state: 'abandoned', updated_at: NOW as never })
            .where(holds(ctx, guard)),
        ),
      );
    },
  };
}

export function sweepStatements(limit: number, cutoff: string, now: string): readonly Statement[] {
  return [
    compile(
      db
        .updateTable('ingest_session')
        .set({ state: 'abandoned', updated_at: now })
        .where(
          'id',
          'in',
          db
            .selectFrom('ingest_session as dead')
            .select('dead.id')
            .where('dead.state', '=', 'running')
            .where('dead.lease_until', '<', cutoff)
            .orderBy('dead.lease_until')
            .limit(limit),
        ),
    ),
    compile(
      db.deleteFrom('ingest_session').where(
        'id',
        'in',
        db
          .selectFrom('ingest_session as old')
          .select('old.id')
          .where('old.state', 'in', ['complete', 'abandoned'])
          .where(
            sql<boolean>`EXISTS (SELECT 1 FROM ingest_session AS newer
              WHERE newer.org_id = old.org_id AND newer.scope_key = old.scope_key
                AND newer.generation > old.generation)`,
          )
          .orderBy('old.lease_until')
          .limit(limit),
      ),
    ),
  ];
}

export function createIngestSessionMaintenance(executor: SqlExecutor): IngestSessionMaintenance {
  return {
    async sweep(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > INGEST_SESSION_SWEEP_LIMIT) {
        throw new RangeError(
          `limit must be an integer from 1 to ${String(INGEST_SESSION_SWEEP_LIMIT)}`,
        );
      }
      const [clock] = (await executor.all(
        compile(
          db.selectNoFrom([
            sql<string>`strftime('${sql.raw(FORMAT)}','now')`.as('now'),
            sql<string>`strftime('${sql.raw(FORMAT)}','now', ${`-${String(INGEST_SESSION_DEAD_DAYS)} days`})`.as(
              'cutoff',
            ),
          ]),
        ),
      )) as { now: string; cutoff: string }[];
      if (clock === undefined) throw new Error('database clock unavailable');
      const [abandoned, deleted] = await executor.batch([
        ...sweepStatements(limit, clock.cutoff, clock.now),
      ]);
      return { abandoned: abandoned?.changes ?? 0, deleted: deleted?.changes ?? 0 };
    },
  };
}
