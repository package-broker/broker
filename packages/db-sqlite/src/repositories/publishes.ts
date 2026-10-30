import { sql } from 'kysely';
import {
  createPublishesRepository as unavailable,
  PUBLISH_APPROVAL_STATES,
  type PublishApproval,
  type PublishesRepository,
} from '@package-broker/core/db/publishes';
import { validateLimit } from '@package-broker/core/db/catalogue';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { Selectable } from 'kysely';
import type { PublishApprovalTable } from '../schema.js';
import { compile, db } from '../kysely.js';

type Row = Selectable<PublishApprovalTable>;
function approval(row: Row): PublishApproval {
  return {
    id: row.id,
    packageId: row.package_id,
    versionId: row.version_id,
    sourceId: row.source_id,
    holdApproval: row.hold_approval === 1,
    holdScan: row.hold_scan === 1,
    approvalState: row.approval_state,
    scanState: row.scan_state,
    requiredScanners: JSON.parse(row.required_scanners_json) as string[],
    scanAttempts: row.scan_attempts,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    tokenId: row.token_id,
    routeProjectId: row.route_project_id,
    distTags: JSON.parse(row.dist_tags_json) as Record<string, string>,
    readmePending: row.readme_pending === 1,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    scanVerdicts: JSON.parse(row.scan_verdict_json) as PublishApproval['scanVerdicts'],
    expiresAt: row.expires_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function createPublishesRepository(executor: ScalarSqlExecutor): PublishesRepository {
  return {
    ...unavailable(),
    async get(ctx, id) {
      const rows = await executor.all<Row>(
        compile(
          db
            .selectFrom('publish_approval')
            .selectAll()
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id),
        ) as ScalarStatement,
      );
      return rows[0] ? approval(rows[0]) : null;
    },
    async list(ctx, query) {
      const limit = validateLimit(query.limit, 50);
      if (query.state !== undefined && !PUBLISH_APPROVAL_STATES.includes(query.state))
        throw new TypeError('invalid publish state');
      if (query.cursor !== undefined && typeof query.cursor !== 'string')
        throw new TypeError('invalid publish cursor');
      const rows = await executor.all<Row>(
        compile(
          db
            .selectFrom('publish_approval')
            .selectAll()
            .where('org_id', '=', ctx.orgId)
            .where(
              query.state === undefined
                ? sql<boolean>`1`
                : sql<boolean>`approval_state = ${query.state}`,
            )
            .where(
              query.cursor === undefined ? sql<boolean>`1` : sql<boolean>`id > ${query.cursor}`,
            )
            .orderBy('id')
            .limit(limit + 1),
        ) as ScalarStatement,
      );
      const items = rows.slice(0, limit).map(approval);
      return { items, next: rows.length > limit ? items.at(-1)!.id : null };
    },
  };
}
