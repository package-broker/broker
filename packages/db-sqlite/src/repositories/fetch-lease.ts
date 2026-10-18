import { sql } from 'kysely';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import type { FetchLeaseHandle, FetchLeases } from '@package-broker/core/ingest/coalesce';
import { assertCheck, compile, db } from '../kysely.js';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { FORMAT, NOW, seconds, until } from '../internal/lease-time.js';

const MAX_TEXT = 512;
export const FETCH_LEASE_GC_LIMIT = 20;
const LEASE_KEY = /^[0-9a-f]{64}$/;

export function leaseKey(parts: readonly string[]): Promise<string> {
  return sha256Hex(JSON.stringify(['v1', ...parts]));
}

function key(value: unknown): string {
  if (typeof value !== 'string' || !LEASE_KEY.test(value)) {
    throw new RangeError('lease key must be 64 lowercase hex characters');
  }
  return value;
}

function owner(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new RangeError(
      `owner must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

function fence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('fence must be a positive integer');
  }
  return value;
}

export function fetchLeaseGuard(ctx: OrgContext, handle: FetchLeaseHandle): readonly Statement[] {
  const leaseKeyValue = key(handle.key);
  const holder = owner(handle.owner);
  const generation = fence(handle.fence);
  return assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM fetch_lease
      WHERE fetch_lease.lease_key = ${leaseKeyValue} AND fetch_lease.org_id = ${ctx.orgId}
        AND fetch_lease.owner = ${holder} AND fetch_lease.fence = ${generation}
        AND fetch_lease.lease_until > ${NOW})`,
  );
}

export function createFetchLeaseWriteGuard(
  ctx: OrgContext,
  handle: FetchLeaseHandle,
): CatalogueWriteGuard {
  return registerCatalogueWriteGuard(ctx, fetchLeaseGuard(ctx, handle));
}

export function createFetchLeases(executor: SqlExecutor): FetchLeases {
  return {
    async acquire(ctx, leaseKeyValue, holder, leaseSeconds) {
      const k = key(leaseKeyValue);
      const o = owner(holder);
      const duration = seconds(leaseSeconds);
      const collect = compile(
        db.deleteFrom('fetch_lease').where(
          'lease_key',
          'in',
          db
            .selectFrom('fetch_lease')
            .select('lease_key')
            .where('org_id', '=', ctx.orgId)
            .where('lease_key', '<>', k)
            .where('lease_until', '<', sql<string>`strftime('${sql.raw(FORMAT)}','now','-1 hour')`)
            .orderBy('lease_until')
            .limit(FETCH_LEASE_GC_LIMIT),
        ),
      );
      const acquire = compile(
        db
          .insertInto('fetch_lease')
          .values({
            org_id: ctx.orgId,
            lease_key: k,
            owner: o,
            fence: 1,
            lease_until: until(duration),
            acquired_at: NOW as never,
          })
          .onConflict((conflict) =>
            conflict
              .column('lease_key')
              .doUpdateSet({
                owner: o,
                fence: sql<number>`fetch_lease.fence + 1`,
                lease_until: until(duration),
                acquired_at: NOW as never,
              })
              .where(
                sql<boolean>`fetch_lease.lease_until <= ${NOW} AND fetch_lease.org_id = excluded.org_id`,
              ),
          )
          .returning(['owner', 'fence']),
      );
      const [, result] = await executor.batch([collect, acquire]);
      const row = result?.rows[0] as { owner: string; fence: number } | undefined;
      if (row === undefined || row.owner !== o) return 'held';
      return { key: k, owner: o, fence: row.fence };
    },

    async renew(ctx, handle, leaseSeconds) {
      const duration = seconds(leaseSeconds);
      const [result] = await executor.batch([
        compile(
          db
            .updateTable('fetch_lease')
            .set({ lease_until: until(duration) })
            .where('lease_key', '=', key(handle.key))
            .where('org_id', '=', ctx.orgId)
            .where('owner', '=', owner(handle.owner))
            .where('fence', '=', fence(handle.fence))
            .where('lease_until', '>', NOW as never),
        ),
      ]);
      return (result?.changes ?? 0) === 1;
    },

    async release(ctx, handle) {
      await executor.batch([
        compile(
          db
            .deleteFrom('fetch_lease')
            .where('lease_key', '=', key(handle.key))
            .where('org_id', '=', ctx.orgId)
            .where('owner', '=', owner(handle.owner))
            .where('fence', '=', fence(handle.fence)),
        ),
      ]);
    },
  };
}
