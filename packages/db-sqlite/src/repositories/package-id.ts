import type { PackageIdReads } from '@package-broker/core/db/registry-reads';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';

interface IdRow {
  readonly id: string;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a string`);
}

export function packageIdStatement(
  ctx: OrgContext,
  sourceId: string,
  key: string,
): ScalarStatement {
  return compile(
    db
      .selectFrom('package as pi_p')
      .innerJoin('source as pi_s', 'pi_s.id', 'pi_p.source_id')
      .select('pi_p.id as id')
      .where('pi_p.org_id', '=', ctx.orgId)
      .where('pi_s.org_id', '=', ctx.orgId)
      .where('pi_p.source_id', '=', sourceId)
      .where('pi_p.name', '=', key)
      .limit(1),
  ) as ScalarStatement;
}

export function createPackageIdReads(executor: ScalarSqlExecutor): PackageIdReads {
  return {
    async packageId(ctx, sourceId, key) {
      requireText(sourceId, 'sourceId');
      requireText(key, 'key');
      const rows = await executor.all<IdRow>(packageIdStatement(ctx, sourceId, key));
      return rows[0]?.id ?? null;
    },
  };
}
