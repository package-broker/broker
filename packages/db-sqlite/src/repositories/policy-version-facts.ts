import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  POLICY_FACTS_PAGE_MAX,
  type PolicyVersionFacts,
  type PolicyVersionFactsReader,
} from '@package-broker/core/db/package-admin';
import { compile, db } from '../kysely.js';

const ID = /^[0-9A-Za-z]{1,64}$/;

type Row = {
  readonly package_id: string;
  readonly source_id: string;
  readonly ecosystem: PolicyVersionFacts['ecosystem'];
  readonly package_key: string;
  readonly version_id: string;
  readonly version: string;
  readonly version_normalized: string;
  readonly revision: number;
  readonly status: PolicyVersionFacts['status'];
  readonly published_at: string;
  readonly published_at_basis: string;
  readonly created_at: string;
};

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createPolicyVersionFactsReader(
  executor: ScalarSqlExecutor,
): PolicyVersionFactsReader {
  return {
    async versionFacts(ctx: OrgContext, query) {
      const packageId = id(query.packageId, 'packageId');
      const limit = query.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY_FACTS_PAGE_MAX) {
        throw new RangeError('limit is out of range');
      }
      const ids =
        query.versionIds === undefined
          ? null
          : query.versionIds.map((value) => id(value, 'versionIds'));
      if (ids !== null && ids.length > POLICY_FACTS_PAGE_MAX) {
        throw new RangeError('too many version ids');
      }
      const after = query.after === undefined ? null : id(query.after, 'after');
      const newest = query.newest === true;
      if (newest && after !== null) throw new RangeError('newest reads have no cursor');
      const raw = sql`select v.id as version_id, v.version, v.version_normalized, v.revision,
          v.status, v.published_at, v.published_at_basis, v.created_at,
          pkg.id as package_id, pkg.source_id, pkg.ecosystem, pkg.name as package_key
        from version as v
        join package as pkg on pkg.id = v.package_id and pkg.org_id = ${ctx.orgId}
        where v.org_id = ${ctx.orgId} and v.package_id = ${packageId}
          and not (v.status = 'quarantined' and exists (select 1 from publish_approval pa where pa.org_id = ${ctx.orgId} and pa.version_id = v.id and (pa.approval_state = 'pending' or pa.scan_state in ('queued', 'running', 'failed'))))
          and ${ids === null ? sql`1 = 1` : sql`v.id in (select value from json_each(${JSON.stringify(ids)}))`}
          and ${after === null ? sql`1 = 1` : sql`v.id > ${after}`}
        order by ${newest ? sql`v.published_at desc, v.id desc` : sql`v.id`} limit ${limit}`;
      const rows = await executor.all<Row>(
        compile({ compile: () => raw.compile(db) }) as ScalarStatement,
      );
      return rows.map((row) => ({
        packageId: row.package_id,
        sourceId: row.source_id,
        ecosystem: row.ecosystem,
        packageKey: row.package_key,
        versionId: row.version_id,
        version: row.version,
        versionNormalized: row.version_normalized,
        revision: row.revision,
        status: row.status,
        publishedAt: row.published_at,
        publishedAtBasis: row.published_at_basis,
        createdAt: row.created_at,
      }));
    },
  };
}
