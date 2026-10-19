import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { catalogueWriteGuard, type CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';

const guardOrgs = new WeakMap<CatalogueWriteGuard, string>();

/** Db repository modules register only statements that enforce their organization lease. */
export function registerCatalogueWriteGuard(
  ctx: OrgContext,
  statements: readonly Statement[],
): CatalogueWriteGuard {
  if (statements.length === 0) throw new TypeError('a catalogue write guard must not be empty');
  const built = catalogueWriteGuard(statements);
  guardOrgs.set(built, ctx.orgId);
  return built;
}

export function assertCatalogueWriteGuard(ctx: OrgContext, guard: CatalogueWriteGuard): void {
  if (guardOrgs.get(guard) !== ctx.orgId) {
    throw new TypeError(
      'the catalogue write guard was not built by createCatalogueWriteGuard for this organization',
    );
  }
}

export const monotonicNow = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', max(
  unixepoch('now', 'subsec'),
  unixepoch(package.modified_at, 'subsec') + 0.001
), 'unixepoch')`;

/** Expiry alone does not revoke markDeleted; put must clear the lease and bump its generation. */
export function blobReferenceFence(expectedGeneration?: string): RawBuilder<SqlBool> {
  if (
    expectedGeneration !== undefined &&
    (typeof expectedGeneration !== 'string' || !/^[0-9a-f]{32}$/.test(expectedGeneration))
  ) {
    throw new RangeError('expectedGeneration must be 32 lower-case hexadecimal characters');
  }
  return expectedGeneration === undefined
    ? sql<SqlBool>`blob.purge_lease_until IS NULL`
    : sql<SqlBool>`(blob.purge_lease_until IS NULL AND blob.purge_generation = ${expectedGeneration})`;
}
