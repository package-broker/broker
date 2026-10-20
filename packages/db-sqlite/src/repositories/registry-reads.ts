import { sql } from 'kysely';
import type { RegistryReads } from '@package-broker/core/db/registry-reads';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { coveredByRegisteredNames } from './registered-name.js';

interface CoverRow {
  readonly covered: number;
}

interface VersionRow {
  readonly name: string;
  readonly version: string;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a string`);
}

export function coversStatement(ctx: OrgContext, sourceId: string, key: string): ScalarStatement {
  const src = sql<string>`${sql.ref('rr_s.id')}`;
  const ecosystem = sql<string>`${sql.ref('rr_s.ecosystem')}`;
  return compile(
    db
      .selectFrom('source as rr_s')
      .select(
        sql<number>`coalesce(${coveredByRegisteredNames(ctx, src, ecosystem, key)}, 0)`.as(
          'covered',
        ),
      )
      .where('rr_s.org_id', '=', ctx.orgId)
      .where('rr_s.id', '=', sourceId),
  ) as ScalarStatement;
}

export function versionByIdStatement(
  ctx: OrgContext,
  packageId: string,
  versionId: string,
): ScalarStatement {
  return compile(
    db
      .selectFrom('version as rr_v')
      .innerJoin('package as rr_p', 'rr_p.id', 'rr_v.package_id')
      .innerJoin('source as rr_s', 'rr_s.id', 'rr_p.source_id')
      .select(['rr_p.name as name', 'rr_v.version as version'])
      .where('rr_v.org_id', '=', ctx.orgId)
      .where('rr_p.org_id', '=', ctx.orgId)
      .where('rr_s.org_id', '=', ctx.orgId)
      .where('rr_v.id', '=', versionId)
      .where('rr_v.package_id', '=', packageId)
      .where(
        sql<boolean>`(rr_v.status = 'active'
          or (rr_v.status = 'removed_upstream' and rr_s.removal_policy = 'flag'))`,
      )
      .where(
        sql<boolean>`(rr_p.status = 'active'
          or (rr_p.status = 'removed_upstream' and rr_s.removal_policy = 'flag'))`,
      )
      .limit(1),
  ) as ScalarStatement;
}

export function createRegistryReads(executor: ScalarSqlExecutor): RegistryReads {
  return {
    async covers(ctx, sourceId, key) {
      requireText(sourceId, 'sourceId');
      requireText(key, 'key');
      const rows = await executor.all<CoverRow>(coversStatement(ctx, sourceId, key));
      return rows[0]?.covered === 1;
    },

    async versionById(ctx, ref) {
      requireText(ref?.packageId, 'packageId');
      requireText(ref.versionId, 'versionId');
      const rows = await executor.all<VersionRow>(
        versionByIdStatement(ctx, ref.packageId, ref.versionId),
      );
      const row = rows[0];
      return row === undefined ? null : { packageName: row.name, version: row.version };
    },
  };
}
