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
