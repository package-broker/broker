import { redactValue } from '@package-broker/core/audit/redact';
import { sql, type RawBuilder } from 'kysely';
import {
  fenceKind,
  type AnyMutationFence,
  type MutationFence,
  type SystemMutationFence,
} from '@package-broker/core/authz/fence';
import type {
  PublishDecision,
  PublishTransition,
  PublishTransitionResult,
  PublishScanTransition,
} from '@package-broker/core/db/publishes';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import {
  PUBLISH_SCAN_JOB,
  PUBLISH_SCAN_JOB_OPTIONS,
} from '@package-broker/core/ingest/publish-scan-job';
import { createJobRepository } from './job.js';
import { actorHolds } from './actor-authority.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { auditPendingStatement } from './audit-pending.js';
import { compile as compiled, newOpId, type ProtectedHolderProvider } from '../kysely.js';
import { compareNpmVersions } from '@package-broker/core/catalogue/versions';
import {
  PUBLISH_APPROVAL_STATES,
  PUBLISH_APPROVAL_EXPIRY_BATCH_SIZE,
  PUBLISH_PURGE_WINDOW_DAYS,
  type PublishApproval,
  type PublishInspection,
  type PublishesRepository,
} from '@package-broker/core/db/publishes';
import { validateLimit } from '@package-broker/core/db/catalogue';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import type { Selectable } from 'kysely';
import type { PublishApprovalTable } from '../schema.js';
import { db } from '../kysely.js';

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
export function createPublishesRepository(
  executor: ScalarSqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[] = [],
): PublishesRepository {
  const statement = (value: RawBuilder<unknown>) =>
    compiled({ compile: () => value.compile(db) }) as ScalarStatement;
  async function transition(
    ctx: Parameters<PublishesRepository['get']>[0],
    fence: AnyMutationFence,
    input: PublishTransition,
    decision?: PublishDecision,
    scan?: PublishScanTransition,
    rescan = false,
  ): Promise<PublishTransitionResult> {
    const kind = fenceKind(fence);
    const session = !!decision || rescan;
    if (scan) {
      const from = input.expectedScanState;
      const to = scan.scanState;
      if (!(
        (from === 'queued' && to === 'running') ||
        (from === 'running' && ['queued', 'allowed', 'denied', 'failed'].includes(to)) ||
        (from === 'queued' && to === 'failed')
      ))
        throw new TypeError('invalid_scan_transition');
      for (const verdict of scan.verdicts) {
        if (
          !['allow', 'deny'].includes(verdict.verdict) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(verdict.plugin)
        )
          throw new TypeError('invalid_scan_verdict');
        if (verdict.reason !== undefined) {
          const safe = redactValue(verdict.reason, 1000, 'reason');
          if (
            !safe.ok ||
            safe.value !== verdict.reason ||
            new TextEncoder().encode(verdict.reason).length > 1000
          )
            throw new TypeError('invalid_scan_verdict');
        }
      }
    }
    if (
      session
        ? kind !== 'session'
        : kind !== 'system' || (fence as SystemMutationFence).writer !== 'verifier'
    )
      throw new TypeError('invalid_publish_fence');
    if (decision && decision.decidedByUserId !== (fence as MutationFence).userId)
      throw new TypeError('invalid_publish_actor');
    if (decision?.decision === 'rejected' && !decision.reason?.trim())
      throw new TypeError('invalid_decision_reason');
    if (decision?.reason !== undefined && new TextEncoder().encode(decision.reason).length > 1000)
      throw new TypeError('invalid_decision_reason');
    if (decision?.reason !== undefined) {
      const safe = redactValue(decision.reason, 1000, 'reason');
      if (!safe.ok || safe.value !== decision.reason)
        throw new TypeError('invalid_decision_reason');
    }
    const current = await executor.all<{
      package_id: string;
      version_id: string;
      version: string;
      latest_id: string | null;
      latest: string | null;
      dist_tags_json: string;
    }>(
      statement(sql`
      select pa.package_id, pa.version_id, v.version, dt.version_id as latest_id, lv.version as latest, pa.dist_tags_json
      from publish_approval pa join version v on v.org_id=pa.org_id and v.id=pa.version_id
      left join dist_tag dt on dt.org_id=pa.org_id and dt.package_id=pa.package_id and dt.tag='latest'
      left join version lv on lv.org_id=dt.org_id and lv.id=dt.version_id
      where pa.org_id=${ctx.orgId} and pa.id=${input.id}`),
    );
    const row = current[0];
    if (!row) return { changed: false, active: false, revision: input.expectedRevision };
    const tags = JSON.parse(row.dist_tags_json) as Record<string, string>;
    if (row.latest && compareNpmVersions(row.version, row.latest) <= 0) delete tags.latest;
    const opId = newOpId();
    const state = decision?.decision ?? (scan || rescan ? input.expectedApprovalState : 'expired');
    const tombstone = scan ? scan.scanState === 'denied' : rescan ? false : state !== 'approved';
    const canActivate = scan ? scan.scanState === 'allowed' : !rescan && state === 'approved';
    const authority = session
      ? actorHolds(ctx, fence as MutationFence, {
          permission: 'org:packages:approve',
          projectId: null,
          providerAnchors,
        })
      : sql<boolean>`1`;
    const expireDenied = !decision && !scan && !rescan && input.expectedScanState === 'denied';
    const versionReady = expireDenied
      ? sql<boolean>`v.status='tombstoned' and v.tombstone_reason='scan_denied'`
      : sql<boolean>`v.status='quarantined'`;
    const ready = sql<boolean>`exists (select 1 from version v where v.org_id=${ctx.orgId} and v.id=publish_approval.version_id and v.package_id=publish_approval.package_id and ${versionReady})`;
    const succeeded = sql<boolean>`exists (select 1 from version v where v.org_id=${ctx.orgId} and v.id=(select version_id from publish_approval where org_id=${ctx.orgId} and id=${input.id}) and v.last_op_id=${opId})`;
    const active = sql<boolean>`exists (select 1 from version v where v.org_id=${ctx.orgId} and v.package_id=${row.package_id} and v.last_op_id=${opId} and v.status='active')`;
    const statements: ScalarStatement[] = [
      ...(session
        ? []
        : (jobLeaseGuard(ctx, (fence as SystemMutationFence).job) as ScalarStatement[])),
      statement(sql`update publish_approval set
        approval_state=${state},
        hold_approval=case when ${state}='rejected' then 1 else hold_approval end,
        scan_state=${scan?.scanState ?? (rescan ? 'queued' : input.expectedScanState)},
        scan_attempts=case when ${Number(rescan)} then 0 when ${Number(scan?.scanState === 'running')} then scan_attempts+1 else scan_attempts end,
        scan_verdict_json=case when ${Number(!!scan || rescan)} then ${JSON.stringify(scan?.verdicts ?? [])} else scan_verdict_json end,
        decided_by_user_id=case when ${Number(!!scan || rescan)} then decided_by_user_id else ${decision?.decidedByUserId ?? null} end,
        decided_at=case when ${Number(!!scan || rescan)} then decided_at else ${input.now} end,
        decision_reason=case when ${Number(!!scan || rescan)} then decision_reason else ${decision?.reason ?? null} end,
        revision=revision+1, updated_at=${input.now}
        where org_id=${ctx.orgId} and id=${input.id} and revision=${input.expectedRevision}
        and approval_state=${input.expectedApprovalState} and scan_state=${input.expectedScanState}
        and ${scan || rescan ? sql<boolean>`hold_scan=1 and approval_state in ('not_required','pending','approved')` : decision?.decision === 'rejected' ? sql<boolean>`(approval_state='pending' or (approval_state='not_required' and hold_scan=1))` : sql<boolean>`approval_state='pending'`}
        and ${rescan ? sql<boolean>`scan_state='failed'` : sql<boolean>`1`}
        and ${scan?.scanState === 'running' ? sql<boolean>`scan_attempts<3` : sql<boolean>`1`}
        and ${ready} and ${authority}
        and ${
          scan &&
          ['queued', 'failed'].includes(scan.scanState) &&
          input.expectedScanState === 'running'
            ? sql<boolean>`not exists (select 1 from job j where j.org_id=publish_approval.org_id and j.resource_key='publish:' || publish_approval.version_id and j.state='running' and j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') and j.id<>${(fence as SystemMutationFence).job.id})`
            : sql<boolean>`1`
        }
        and ${scan || rescan ? sql<boolean>`(approval_state<>'pending' or expires_at > ${input.now})` : decision ? sql<boolean>`(approval_state<>'pending' or expires_at > ${input.now})` : sql<boolean>`expires_at <= ${input.now}`}
        and ${decision?.decision === 'approved' ? sql<boolean>`(requested_by_type != 'user' or requested_by_id != ${decision.decidedByUserId})` : sql<boolean>`1`}
        and ${canActivate ? sql<boolean>`(select version_id from dist_tag where org_id=${ctx.orgId} and package_id=${row.package_id} and tag='latest') is ${row.latest_id}` : sql<boolean>`1`}`),
      statement(sql`update version set
        status=case when ${Number(expireDenied)} then status when ${Number(tombstone)} then 'tombstoned' when ${Number(canActivate)} and exists (select 1 from publish_approval pa where pa.org_id=${ctx.orgId} and pa.id=${input.id} and (pa.hold_scan=0 or pa.scan_state='allowed') and (pa.hold_approval=0 or pa.approval_state='approved')) then 'active' else 'quarantined' end,
        tombstoned_at=case when ${Number(expireDenied)} then tombstoned_at when ${Number(tombstone)} then ${input.now} else null end,
        tombstone_reason=case when ${Number(expireDenied)} then tombstone_reason when ${Number(tombstone)} then ${scan ? 'scan_denied' : state} else null end,
        revision=revision+1,last_op_id=${opId}
        where changes()=1 and org_id=${ctx.orgId} and id=(select version_id from publish_approval where org_id=${ctx.orgId} and id=${input.id}) and ${expireDenied ? sql<boolean>`status='tombstoned' and tombstone_reason='scan_denied'` : sql<boolean>`status='quarantined'`}`),
      statement(
        sql`update publish_approval set readme_pending=0 where org_id=${ctx.orgId} and id=${input.id} and ${active}`,
      ),
      statement(sql`update package set rev=rev+1, modified_at=${input.now}, held_until_active=case when ${active} then 0 else held_until_active end,
        description=case when ${active} and ${Number(tags.latest !== undefined)}=1 then (select json_extract(metadata_json,'$.description') from version where org_id=${ctx.orgId} and last_op_id=${opId}) else description end
        where org_id=${ctx.orgId} and id=${row.package_id} and ${succeeded}`),
      statement(
        sql`update blob set purge_after=strftime('%Y-%m-%dT%H:%M:%fZ',${input.now},${'+' + PUBLISH_PURGE_WINDOW_DAYS + ' days'}) where ${Number(!expireDenied)}=1 and org_id=${ctx.orgId} and id in (select blob_id from version where org_id=${ctx.orgId} and last_op_id=${opId} and status='tombstoned') and not exists (select 1 from version live where live.org_id=blob.org_id and live.blob_id=blob.id and live.status='active')`,
      ),
    ];
    if (canActivate)
      for (const tag of Object.keys(tags)) {
        statements.push(
          statement(sql`insert into dist_tag_history (id,org_id,package_id,tag,version_id,previous_version_id,action,actor_type,actor_id,op_id)
          select ${newOpId()},${ctx.orgId},${row.package_id},${tag},v.id,(select version_id from dist_tag where org_id=${ctx.orgId} and package_id=${row.package_id} and tag=${tag}),'set',${decision ? 'user' : 'system'},${decision?.decidedByUserId ?? null},${opId}
          from version v where v.org_id=${ctx.orgId} and v.last_op_id=${opId} and v.status='active'`),
          statement(sql`insert into dist_tag (org_id,package_id,tag,version_id)
          select ${ctx.orgId},${row.package_id},${tag},v.id from version v where v.org_id=${ctx.orgId} and v.last_op_id=${opId} and v.status='active'
          on conflict(package_id,tag) do update set version_id=excluded.version_id,updated_at=${input.now} where dist_tag.org_id=${ctx.orgId}`),
        );
      }
    if (rescan) {
      const store = createJobRepository(executor);
      const jobs = createRepositoryJobs({
        store: {
          ...store,
          enqueueStatements: (ctx, job) => store.enqueueStatements(ctx, job, succeeded),
        },
        jobs: [{ qualifiedName: PUBLISH_SCAN_JOB, definition: PUBLISH_SCAN_JOB_OPTIONS }],
        clock: { now: () => new Date(input.now) },
        ids: { ulid: newOpId },
      })('core', { projectId: null, tokenId: null });
      const queued = await jobs.enqueueStatements(
        ctx,
        PUBLISH_SCAN_JOB,
        { id: input.id },
        {
          resourceKey: `publish:${row.version_id}`,
          idempotencyKey: `rescan:${row.version_id}:${input.expectedRevision + 1}`,
        },
      );
      statements.push(...(queued.statements as ScalarStatement[]));
    }
    statements.push(
      auditPendingStatement(ctx, input.event, statement(succeeded)) as ScalarStatement,
      statement(
        sql`update cache_epoch set version=hex(randomblob(16)) where org_id=${ctx.orgId} and ${succeeded}`,
      ),
      statement(
        sql`select revision, ${succeeded} as changed, ${active} as active from publish_approval where org_id=${ctx.orgId} and id=${input.id}`,
      ),
    );
    const result = (await executor.batch(statements)).at(-1)?.rows[0];
    if (
      scan?.scanState === 'allowed' &&
      result?.changed !== 1 &&
      Number(result?.revision) === input.expectedRevision
    ) {
      const latest = await executor.all<{ version_id: string }>(
        statement(
          sql`select version_id from dist_tag where org_id=${ctx.orgId} and package_id=${row.package_id} and tag='latest'`,
        ),
      );
      if ((latest[0]?.version_id ?? null) !== row.latest_id)
        return transition(ctx, fence, input, undefined, scan);
    }
    return {
      changed: result?.changed === 1,
      active: result?.active === 1,
      revision: Number(result?.revision ?? input.expectedRevision),
    };
  }
  type InspectionRow = Row & {
    package_name: string;
    version: string;
    source_name: string;
    requester: string | null;
    decider: string | null;
    project_id: string | null;
    project_slug: string | null;
    project_name: string | null;
  };
  const inspection = sql`select pa.*, p.name package_name,v.version,s.name source_name,
    case when pa.requested_by_type='user' then u.display_name else sp.name end requester,
    d.display_name decider,pr.id project_id,pr.slug project_slug,pr.name project_name
    from publish_approval pa
    join package p on p.org_id=pa.org_id and p.id=pa.package_id
    join version v on v.org_id=pa.org_id and v.package_id=p.id and v.id=pa.version_id
    join source s on s.org_id=pa.org_id and s.id=pa.source_id
    left join user_account u on u.org_id=pa.org_id and u.id=pa.requested_by_id
    left join service_principal sp on sp.org_id=pa.org_id and sp.id=pa.requested_by_id
    left join user_account d on d.org_id=pa.org_id and d.id=pa.decided_by_user_id
    left join project pr on pr.org_id=pa.org_id and pr.id=pa.route_project_id`;
  function inspect(row: InspectionRow): PublishInspection {
    const names = row;
    const safe = (name: string | null, fallback: string) => {
      if (!name) return fallback;
      const clean = redactValue(name, 200, 'name');
      return clean.ok && clean.value === name ? name : fallback;
    };
    return {
      ...approval(row),
      packageName: names.package_name,
      version: names.version,
      sourceName: safe(names.source_name, 'Source'),
      requestedBy: {
        type: row.requested_by_type,
        name: safe(names.requester, row.requested_by_type === 'user' ? 'User' : 'Service'),
      },
      decidedBy: row.decided_by_user_id ? { name: safe(names.decider, 'User') } : null,
      project: names.project_id
        ? {
            id: names.project_id,
            slug: names.project_slug!,
            name: safe(names.project_name, 'Project'),
          }
        : null,
    };
  }
  return {
    async listExpired(ctx, now) {
      const rows = await executor.all<InspectionRow>(
        statement(sql`${inspection}
        where pa.org_id=${ctx.orgId} and pa.approval_state='pending' and pa.expires_at<=${now}
        order by pa.id limit ${PUBLISH_APPROVAL_EXPIRY_BATCH_SIZE}`),
      );
      return rows.map(inspect);
    },
    decide: (ctx, fence, input) => transition(ctx, fence, input, input),
    expire: (ctx, fence, input) => transition(ctx, fence, input),
    scan: (ctx, fence, input) => transition(ctx, fence, input, undefined, input),
    rescan: (ctx, fence, input) => transition(ctx, fence, input, undefined, undefined, true),
    async listScanQueued(ctx, before, runningBefore = before) {
      const rows = await executor.all<InspectionRow>(
        statement(
          sql`${inspection} where pa.org_id=${ctx.orgId} and pa.hold_scan=1 and ((pa.scan_state='queued' and pa.updated_at<=${before}) or (pa.scan_state='running' and pa.updated_at<=${runningBefore} and not exists (select 1 from job j where j.org_id=pa.org_id and j.resource_key='publish:' || pa.version_id and j.state='running' and j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))) and pa.approval_state in ('not_required','pending','approved') and (pa.approval_state<>'pending' or pa.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) and v.status='quarantined' order by pa.id limit 50`,
        ),
      );
      return rows.map(inspect);
    },
    async scanInput(ctx, id) {
      const rows = await executor.all<{
        sha256: import('@package-broker/core/platform/blob').Sha256;
        metadata_json: string;
        integrity: string;
        size_bytes: number;
      }>(
        statement(
          sql`select b.sha256,v.metadata_json,v.npm_integrity as integrity,b.size_bytes from publish_approval pa join version v on v.org_id=pa.org_id and v.id=pa.version_id join blob b on b.org_id=v.org_id and b.id=v.blob_id where pa.org_id=${ctx.orgId} and pa.id=${id} and v.status='quarantined'`,
        ),
      );
      const row = rows[0];
      return row
        ? {
            sha256: row.sha256,
            manifest: JSON.parse(row.metadata_json) as Record<string, unknown>,
            integrity: row.integrity,
            sizeBytes: row.size_bytes,
          }
        : null;
    },
    async get(ctx, id) {
      const rows = await executor.all<InspectionRow>(
        statement(sql`${inspection} where pa.org_id=${ctx.orgId} and pa.id=${id}`),
      );
      return rows[0] ? inspect(rows[0]) : null;
    },
    async list(ctx, query) {
      const limit = validateLimit(query.limit, 50);
      if (query.state !== undefined && !PUBLISH_APPROVAL_STATES.includes(query.state))
        throw new TypeError('invalid publish state');
      if (query.cursor !== undefined && typeof query.cursor !== 'string')
        throw new TypeError('invalid publish cursor');
      const rows = await executor.all<InspectionRow>(
        statement(sql`${inspection}
        where pa.org_id=${ctx.orgId}
        and ${query.state === undefined ? sql`1` : sql`pa.approval_state=${query.state}`}
        and ${query.state === 'pending' ? sql`pa.scan_state<>'denied'` : sql`1`}
        and ${query.cursor === undefined ? sql`1` : sql`pa.id > ${query.cursor}`}
        order by pa.id limit ${limit + 1}`),
      );
      const items = rows.slice(0, limit).map(inspect);
      return { items, next: rows.length > limit ? items.at(-1)!.id : null };
    },
  };
}
