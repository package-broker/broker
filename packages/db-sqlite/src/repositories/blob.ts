import { sql, type Compilable, type SqlBool } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  BLOB_MEDIA_TYPES,
  BlobBusyError,
  BlobConflictError,
  BlobValidationError,
  blobStorageKey,
  stagedStorageKey,
  parseSha256,
  type BlobInfo,
  type BlobMetadataPort,
  type PurgeGeneration,
  type Sha256,
} from '@package-broker/core/platform/blob';
import { compile, db } from '../kysely.js';
import {
  blobEligibleCondition,
  blobOrphanCondition,
  blobPrematureCondition,
} from './blob-references.js';
import { leaseLive } from './blob-lease-guard.js';

export interface BlobLifecycleMetadata {
  unschedule(ctx: OrgContext, key: Sha256): Promise<boolean>;
  scheduleOrphan(ctx: OrgContext, key: Sha256): Promise<boolean>;
  softDelete(
    ctx: OrgContext,
    key: Sha256,
    input: { removedAt: string; retentionDays?: number },
  ): Promise<boolean>;
  listDue(ctx: OrgContext, page: DuePage): Promise<Sha256[]>;
  claimPurge(ctx: OrgContext, key: Sha256): Promise<PurgeGeneration | null>;
  canStartRemove(
    ctx: OrgContext,
    key: Sha256,
    generation: PurgeGeneration,
    deleteTimeoutMs: number,
  ): Promise<boolean>;
  markDeleted(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
  cancelPurge(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
}

export interface DuePage {
  readonly limit: number;
  readonly after?: Sha256 | null;
}

export const DUE_PAGE_MAX = 100;
const MAX_RETENTION_DAYS = 36_500;

export interface BlobRepositoryOptions {
  readonly purgeLeaseSeconds?: number;
}

const DEFAULT_PURGE_LEASE_SECONDS = 900;
const MIN_PURGE_LEASE_SECONDS = 60;
const GENERATION = /^[0-9a-f]{32}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORMAT = '%Y-%m-%dT%H:%M:%fZ';

const NOW = sql<string>`strftime(${sql.lit(FORMAT)}, 'now')`;
const FRESH = sql<string>`lower(hex(randomblob(16)))`;

interface InfoRow {
  readonly purge_generation: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly purge_after: string | null;
}

function info(row: InfoRow): BlobInfo {
  return {
    generation: row.purge_generation ?? '',
    sha256: row.sha256 as Sha256,
    size: row.size_bytes,
    mediaType: row.media_type,
    purgeAfter: row.purge_after,
  };
}

function statement(query: Compilable): ScalarStatement {
  return compile(query) as ScalarStatement;
}

function eligibleStatement(ctx: OrgContext, query: Compilable, suffix = ''): ScalarStatement {
  const base = statement(query);
  const eligible = blobEligibleCondition(ctx, 'blob');
  return {
    sql: `${base.sql} AND ${eligible.sql}${suffix}`,
    params: [...base.params, ...eligible.params],
  };
}

export function dueBlobsStatement(ctx: OrgContext, page: DuePage): ScalarStatement {
  if (!Number.isInteger(page?.limit) || page.limit < 1 || page.limit > DUE_PAGE_MAX) {
    throw new BlobValidationError();
  }
  const after = page.after === undefined || page.after === null ? '' : parseSha256(page.after);
  return statement(
    db
      .selectFrom('blob')
      .select('sha256')
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where('purge_after', 'is not', null)
      .where(sql<SqlBool>`purge_after <= ${NOW}`)
      .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)
      .where('sha256', '>', after)
      .orderBy('sha256')
      .limit(page.limit),
  );
}

function requireGeneration(generation: string): void {
  if (typeof generation !== 'string' || !GENERATION.test(generation)) {
    throw new BlobValidationError();
  }
}

function requireTimestamp(value: string): void {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) throw new BlobValidationError();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BlobValidationError();
  }
}

export function createBlobRepository(
  executor: ScalarSqlExecutor,
  options: BlobRepositoryOptions = {},
): BlobMetadataPort & BlobLifecycleMetadata {
  const leaseSeconds = options.purgeLeaseSeconds ?? DEFAULT_PURGE_LEASE_SECONDS;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < MIN_PURGE_LEASE_SECONDS) {
    throw new BlobValidationError();
  }

  const keyed = (ctx: OrgContext, sha256: Sha256) => ({ org: ctx.orgId, sha256 });

  async function changed(query: Compilable): Promise<boolean> {
    const [result] = await executor.batch([statement(query)]);
    return result?.changes === 1;
  }

  return {
    /**
     * Returns a generation that is stored on the row, or throws `BlobBusyError` under a purge lease.
     * An absent digest returns an unstored token: publish inserts the row with it.
     */
    async reserve(ctx, key) {
      const sha256 = parseSha256(key);
      const bump = db
        .updateTable('blob')
        .set({ purge_generation: FRESH, purge_lease_until: null })
        .where('org_id', '=', ctx.orgId)
        .where('sha256', '=', sha256)
        .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)
        .returning('purge_generation');
      const probe = db.selectFrom(sql<{ one: number }>`(select 1 as one)`.as('probe')).select([
        FRESH.as('fresh'),
        // Runs after the bump, which clears the lease whenever it changes the row; a lease still set
        // means the bump refused it, so the probe must not read the clock a second time.
        sql<number>`exists (select 1 from blob where org_id = ${ctx.orgId} and sha256 = ${sha256} and purge_lease_until is not null)`.as(
          'busy',
        ),
      ]);
      const [bumped, fresh] = await executor.batch([statement(bump), statement(probe)]);
      const generation = (bumped?.rows[0] as { purge_generation: string } | undefined)
        ?.purge_generation;
      if (generation !== undefined) return generation as PurgeGeneration;
      const row = fresh?.rows[0] as { fresh: string; busy: number } | undefined;
      if (row === undefined) throw new BlobValidationError();
      if (row.busy === 1) throw new BlobBusyError();
      return row.fresh as PurgeGeneration;
    },

    async publish(ctx, input) {
      const sha256 = parseSha256(input?.sha256);
      if (
        !Number.isSafeInteger(input.size) ||
        input.size < 0 ||
        typeof input.mediaType !== 'string' ||
        !BLOB_MEDIA_TYPES.has(input.mediaType) ||
        typeof input.refetchable !== 'boolean'
      ) {
        throw new BlobValidationError();
      }
      requireGeneration(input.generation);
      const upsert = db
        .insertInto('blob')
        .values({
          id: FRESH,
          org_id: ctx.orgId,
          sha256,
          size_bytes: input.size,
          storage_key:
            input.npmPublishHandle === undefined
              ? blobStorageKey(ctx.orgId, sha256)
              : stagedStorageKey(input.npmPublishHandle, sha256),
          media_type: input.mediaType,
          refetchable: input.refetchable ? 1 : 0,
          purge_generation: input.generation,
          published_at: NOW,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['org_id', 'sha256'])
            .doUpdateSet({
              published_at: NOW,
              refetchable: sql<number>`case when blob.deleted_at is not null then excluded.refetchable else min(blob.refetchable, excluded.refetchable) end`,
              upstream_url: sql<
                string | null
              >`case when blob.deleted_at is not null then excluded.upstream_url else blob.upstream_url end`,
              last_fetched_at: sql<
                string | null
              >`case when blob.deleted_at is not null then excluded.last_fetched_at else blob.last_fetched_at end`,
              last_accessed_at: sql<
                string | null
              >`case when blob.deleted_at is not null then excluded.last_accessed_at else blob.last_accessed_at end`,
              purge_lease_until: null,
              size_bytes: sql<number>`excluded.size_bytes`,
              media_type: sql<string>`excluded.media_type`,
              storage_key: sql<string>`excluded.storage_key`,
              purge_after: null,
              deleted_at: null,
            })
            .where(
              sql<SqlBool>`blob.purge_generation = excluded.purge_generation and not ${leaseLive('blob.purge_lease_until')} and (blob.deleted_at is not null or (blob.size_bytes = excluded.size_bytes and blob.media_type = excluded.media_type))`,
            ),
        )
        .returning(['sha256', 'size_bytes', 'media_type', 'purge_after', 'purge_generation']);
      const existing = db
        .selectFrom('blob')
        .select(['size_bytes', 'media_type', 'deleted_at'])
        .where('org_id', '=', ctx.orgId)
        .where('sha256', '=', sha256);
      const [written, current] = await executor.batch([statement(upsert), statement(existing)]);
      const row = written?.rows[0] as InfoRow | undefined;
      if (row !== undefined) return info(row);
      const stored = current?.rows[0] as
        { size_bytes: number; media_type: string; deleted_at: string | null } | undefined;
      if (
        stored !== undefined &&
        stored.deleted_at === null &&
        (stored.size_bytes !== input.size || stored.media_type !== input.mediaType)
      ) {
        throw new BlobConflictError();
      }
      return null;
    },

    async find(ctx, key) {
      const sha256 = parseSha256(key);
      const rows = await executor.all<InfoRow & { storage_key: string }>(
        statement(
          db
            .selectFrom('blob')
            .select([
              'sha256',
              'size_bytes',
              'media_type',
              'purge_after',
              'purge_generation',
              'storage_key',
            ])
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null)
            .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`),
        ),
      );
      return rows[0] === undefined ? null : { ...info(rows[0]), storageKey: rows[0].storage_key };
    },

    async narrowRefetchable(ctx, input) {
      const sha256 = parseSha256(input?.key);
      if (
        !Number.isSafeInteger(input.size) ||
        input.size < 0 ||
        typeof input.mediaType !== 'string' ||
        !BLOB_MEDIA_TYPES.has(input.mediaType)
      ) {
        throw new BlobValidationError();
      }
      const [result] = await executor.batch([
        statement(
          db
            .updateTable('blob')
            .set({ refetchable: 0 })
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null)
            .where('size_bytes', '=', input.size)
            .where('media_type', '=', input.mediaType)
            .where('purge_after', 'is', null)
            .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)
            .returning(['sha256', 'size_bytes', 'media_type', 'purge_after', 'purge_generation']),
        ),
      ]);
      const row = result?.rows[0] as InfoRow | undefined;
      return row === undefined ? null : info(row);
    },

    async inspect(ctx, key) {
      const sha256 = parseSha256(key);
      const rows = await executor.all<InfoRow & { purging: number; storage_key: string }>(
        statement(
          db
            .selectFrom('blob')
            .select([
              'sha256',
              'size_bytes',
              'media_type',
              'purge_after',
              'purge_generation',
              'storage_key',
            ])
            .select(leaseLive('purge_lease_until').as('purging'))
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null),
        ),
      );
      const row = rows[0];
      return row === undefined
        ? null
        : { info: info(row), storageKey: row.storage_key, purging: row.purging === 1 };
    },

    async softDelete(ctx, key, input) {
      const { org, sha256 } = keyed(ctx, parseSha256(key));
      requireTimestamp(input?.removedAt);
      const removedAt = input.removedAt;
      const override = input.retentionDays;
      if (
        override !== undefined &&
        (!Number.isSafeInteger(override) || override < 0 || override > MAX_RETENTION_DAYS)
      ) {
        throw new BlobValidationError();
      }
      const orgDays = sql<number>`(select retention_removed_upstream_days from organization where id = blob.org_id)`;
      const days = override === undefined ? orgDays : sql<number>`max(${orgDays}, ${override})`;
      return changed(
        db
          .updateTable('blob')
          .set({
            purge_after: sql<string>`coalesce(purge_after, strftime(${sql.lit(FORMAT)}, 'now', '+' || ${days} || ' days'))`,
          })
          .where('org_id', '=', org)
          .where('sha256', '=', sha256)
          .where('deleted_at', 'is', null)
          .where(sql<SqlBool>`${removedAt} <= ${NOW}`)
          .where(
            sql<SqlBool>`(select retention_removed_upstream_days from organization where id = blob.org_id) is not null`,
          ),
      );
    },

    async listDue(ctx, page) {
      const rows = await executor.all<{ sha256: Sha256 }>(dueBlobsStatement(ctx, page));
      return rows.map((row) => row.sha256);
    },

    async unschedule(ctx, key) {
      const sha256 = parseSha256(key);
      const eligible = blobEligibleCondition(ctx, 'blob');
      const premature = blobPrematureCondition(ctx, 'blob');
      const [result] = await executor.batch([
        {
          sql: `UPDATE blob SET purge_after = NULL
WHERE org_id = ? AND sha256 = ? AND deleted_at IS NULL AND purge_after IS NOT NULL
AND (purge_lease_until IS NULL OR purge_lease_until <= strftime('${FORMAT}', 'now'))
AND (NOT ${eligible.sql} OR ${premature.sql})`,
          params: [ctx.orgId, sha256, ...eligible.params, ...premature.params],
        } satisfies ScalarStatement,
      ]);
      return result?.changes === 1;
    },

    async scheduleOrphan(ctx, key) {
      const sha256 = parseSha256(key);
      const orphan = blobOrphanCondition(ctx, 'blob');
      const [result] = await executor.batch([
        eligibleStatement(
          ctx,
          db
            .updateTable('blob')
            .set({ purge_after: NOW })
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null)
            .where('purge_after', 'is', null)
            .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)
            .where(sql<SqlBool>`${sql.raw(orphan.sql)}`),
        ),
      ]);
      return result?.changes === 1;
    },

    async claimPurge(ctx, key) {
      const sha256 = parseSha256(key);
      const premature = blobPrematureCondition(ctx, 'blob');
      const [result] = await executor.batch([
        eligibleStatement(
          ctx,
          db
            .updateTable('blob')
            .set({
              purge_generation: FRESH,
              purge_lease_until: sql<string>`strftime(${sql.lit(FORMAT)}, 'now', ${`+${leaseSeconds} seconds`})`,
            })
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null)
            .where('purge_after', 'is not', null)
            .where(sql<SqlBool>`purge_after <= ${NOW}`)
            .where(sql<SqlBool>`not ${leaseLive('purge_lease_until')}`)
            .where(sql<SqlBool>`not ${sql.raw(premature.sql)}`),
          ' RETURNING purge_generation',
        ),
      ]);
      const row = result?.rows[0] as { purge_generation: string } | undefined;
      return row === undefined ? null : (row.purge_generation as PurgeGeneration);
    },

    async canStartRemove(ctx, key, generation, deleteTimeoutMs) {
      const sha256 = parseSha256(key);
      requireGeneration(generation);
      if (!Number.isSafeInteger(deleteTimeoutMs) || deleteTimeoutMs < 0) {
        throw new BlobValidationError();
      }
      const modifier = `+${Math.ceil(deleteTimeoutMs / 1000)} seconds`;
      const premature = blobPrematureCondition(ctx, 'blob');
      const rows = await executor.all(
        eligibleStatement(
          ctx,
          db
            .selectFrom('blob')
            .select(sql<number>`1`.as('ok'))
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', sha256)
            .where('deleted_at', 'is', null)
            .where('purge_generation', '=', generation)
            .where(
              sql<SqlBool>`purge_lease_until > strftime(${sql.lit(FORMAT)}, 'now', ${modifier})`,
            )
            .where(sql<SqlBool>`not ${sql.raw(premature.sql)}`),
        ),
      );
      return rows.length === 1;
    },

    async markDeleted(ctx, key, generation) {
      const sha256 = parseSha256(key);
      requireGeneration(generation);
      return changed(
        db
          .updateTable('blob')
          .set({ deleted_at: NOW, purge_lease_until: null })
          .where('org_id', '=', ctx.orgId)
          .where('sha256', '=', sha256)
          .where('deleted_at', 'is', null)
          .where('purge_lease_until', 'is not', null)
          .where('purge_generation', '=', generation),
      );
    },

    async cancelPurge(ctx, key, generation) {
      const sha256 = parseSha256(key);
      requireGeneration(generation);
      return changed(
        db
          .updateTable('blob')
          .set({ purge_after: null, purge_lease_until: null })
          .where('org_id', '=', ctx.orgId)
          .where('sha256', '=', sha256)
          .where('deleted_at', 'is', null)
          .where('purge_lease_until', 'is not', null)
          .where('purge_generation', '=', generation),
      );
    },
  };
}
