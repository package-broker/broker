import { withPackageAuditName } from '@package-broker/core/audit/actions';
import { sql, type Selectable, type SqlBool } from 'kysely';
import { redactValue } from '@package-broker/core/audit/redact';
import {
  fenceKind,
  runFenced,
  type AnyMutationFence,
  type MutationFence,
  type SystemMutationFence,
} from '@package-broker/core/authz/fence';
import {
  PackageAccessRequestError,
  type PackageAccessRequest,
  type PackageAccessRequestRepository,
  type AccessRequestPage,
} from '@package-broker/core/db/publishes';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import type { PackageAccessRequestTable } from '../schema.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { actorHolds } from './actor-authority.js';
import { auditPendingStatement } from './audit-pending.js';
import { explicitPackageStatement } from './visibility-subset.js';

type Row = Selectable<PackageAccessRequestTable> & {
  package_name: string;
  project_slug: string;
  project_name: string;
  requester_name: string | null;
  decider_name: string | null;
};
const DB_NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function safeName(value: string | null): string {
  if (value === null) return 'User';
  const result = redactValue(value, 200, 'name');
  return result.ok && result.value === value ? value : 'User';
}

function mapped(r: Row): PackageAccessRequest {
  return {
    id: r.id,
    packageId: r.package_id,
    packageName: r.package_name,
    requestedBy: { type: 'user', name: safeName(r.requester_name) },
    decidedBy: r.decided_by_user_id === null ? null : { name: safeName(r.decider_name) },
    project: { id: r.project_id, slug: r.project_slug, name: r.project_name },
    projectId: r.project_id,
    state: r.state,
    requestedByUserId: r.requested_by_user_id,
    reason: r.reason,
    decidedByUserId: r.decided_by_user_id,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    expiresAt: r.expires_at,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function read(ctx: OrgContext) {
  return db
    .selectFrom('package_access_request as ar')
    .innerJoin('package as ap', (join) =>
      join.onRef('ap.id', '=', 'ar.package_id').onRef('ap.org_id', '=', 'ar.org_id'),
    )
    .innerJoin('project as aj', (join) =>
      join.onRef('aj.id', '=', 'ar.project_id').onRef('aj.org_id', '=', 'ar.org_id'),
    )
    .leftJoin('user_account as au', (join) =>
      join.onRef('au.id', '=', 'ar.requested_by_user_id').onRef('au.org_id', '=', 'ar.org_id'),
    )
    .leftJoin('user_account as ad', (join) =>
      join.onRef('ad.id', '=', 'ar.decided_by_user_id').onRef('ad.org_id', '=', 'ar.org_id'),
    )
    .selectAll('ar')
    .select([
      'ap.name as package_name',
      'aj.slug as project_slug',
      'aj.name as project_name',
      'au.display_name as requester_name',
      'ad.display_name as decider_name',
    ])
    .where('ar.org_id', '=', ctx.orgId);
}

function page(input: AccessRequestPage) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50 ||
    (input.cursor !== undefined &&
      (input.cursor.length === 0 || input.cursor.length > 512 || input.cursor.includes('\0')))
  )
    throw new PackageAccessRequestError('invalid_request');
  return input;
}

function reason(value: string | undefined) {
  if (
    value !== undefined &&
    (new TextEncoder().encode(value).length > 1000 ||
      !/^[\t\n\r\u0020-\u007e\u0080-\uffff]*$/.test(value))
  )
    throw new PackageAccessRequestError('invalid_request');
}

function instant(value: string) {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new PackageAccessRequestError('invalid_request');
}

function requestable(ctx: OrgContext, projectId: string): Guard {
  return sql<SqlBool>`p.org_id = ${ctx.orgId} and p.visible_to_new_projects = 0
    and p.new_project_access_mode = 'request' and p.held_until_active = 0 and p.status = 'active'
    and exists (select 1 from source as rs join project_source as ra on ra.source_id = rs.id
      join project as rp on rp.id = ra.project_id
      where rs.id = p.source_id and rs.org_id = ${ctx.orgId} and ra.org_id = ${ctx.orgId}
      and rp.org_id = ${ctx.orgId} and rp.id = ${projectId} and rp.status = 'active'
      and rs.status = 'active' and rs.ecosystem = p.ecosystem
      and (rs.project_id is null or rs.project_id = rp.id))
    and not exists (select 1 from project_package as rm where rm.org_id = ${ctx.orgId}
      and rm.project_id = ${projectId} and rm.package_id = p.id)`;
}

function probe(guard: Guard): Statement {
  return compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));
}

export function createPackageAccessRequestRepository(
  executor: SqlExecutor,
  anchors: readonly ProtectedHolderProvider[],
): PackageAccessRequestRepository {
  async function get(ctx: OrgContext, id: string) {
    const [r] = await executor.all<Row>(compile(read(ctx).where('ar.id', '=', id)));
    return r === undefined ? null : mapped(r);
  }
  function authority(
    ctx: OrgContext,
    fence: AnyMutationFence,
    permission: string,
    projectId: string | null,
    userId: string | null,
  ): Guard {
    if (fenceKind(fence) !== 'session' || (fence as MutationFence).userId !== userId)
      throw new PackageAccessRequestError('forbidden');
    return actorHolds(ctx, fence as MutationFence, {
      permission,
      projectId,
      providerAnchors: anchors,
    });
  }
  return {
    get,
    async list(ctx, query) {
      page(query);
      let q = read(ctx)
        .orderBy('ar.id')
        .limit(query.limit + 1);
      if (query.state !== undefined) q = q.where('ar.state', '=', query.state);
      if (query.cursor !== undefined) q = q.where('ar.id', '>', query.cursor);
      const rows = await executor.all<Row>(compile(q));
      return {
        items: rows.slice(0, query.limit).map(mapped),
        next: rows.length > query.limit ? rows.slice(0, query.limit).at(-1)!.id : null,
      };
    },
    async requestable(ctx, projectId, input) {
      page(input);
      let q = db
        .selectFrom('package as p')
        .select(['p.id', 'p.name', 'p.new_project_access_mode as newProjectAccessMode'])
        .where(requestable(ctx, projectId))
        .orderBy('p.id')
        .limit(input.limit + 1);
      if (input.cursor !== undefined) q = q.where('p.id', '>', input.cursor);
      const rows = await executor.all<{
        id: string;
        name: string;
        newProjectAccessMode: 'request';
      }>(compile(q));
      return {
        items: rows.slice(0, input.limit),
        next: rows.length > input.limit ? rows.slice(0, input.limit).at(-1)!.id : null,
      };
    },
    async due(ctx) {
      return (
        await executor.all<Row>(
          compile(
            read(ctx)
              .where('ar.state', '=', 'pending')
              .where('ar.expires_at', '<=', DB_NOW)
              .orderBy('ar.expires_at')
              .orderBy('ar.id')
              .limit(10),
          ),
        )
      ).map(mapped);
    },
    async request(ctx, fence, input) {
      reason(input.reason);
      instant(input.now);
      instant(input.expiresAt);
      if (Date.parse(input.expiresAt) - Date.parse(input.now) !== 30 * 86400_000)
        throw new PackageAccessRequestError('invalid_request');
      const held = authority(
        ctx,
        fence,
        'project:packages:manage',
        input.projectId,
        input.requestedByUserId,
      );
      const [pkg] = await executor.all<{ name: string }>(
        compile(
          db
            .selectFrom('package')
            .select('name')
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.packageId),
        ),
      );
      const event = withPackageAuditName(input.event, pkg?.name ?? '');
      const eligible = sql<SqlBool>`exists (select 1 from package as p where p.id = ${input.packageId} and ${requestable(ctx, input.projectId)})
        and not exists (select 1 from package_access_request as pending where pending.org_id = ${ctx.orgId}
          and pending.package_id = ${input.packageId} and pending.project_id = ${input.projectId} and pending.state = 'pending')`;
      const insert = compile(
        db.insertInto('package_access_request').values({
          id: input.id,
          org_id: ctx.orgId,
          package_id: input.packageId,
          project_id: input.projectId,
          requested_by_user_id: input.requestedByUserId,
          reason: input.reason ?? null,
          expires_at: input.expiresAt,
          created_at: input.now,
          updated_at: input.now,
          decided_by_user_id: null,
          decided_at: null,
          decision_reason: null,
        }),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence as MutationFence,
        assertGuard(sql<SqlBool>`(${held} and ${eligible})`, ctx),
        [insert, auditPendingStatement(ctx, event, { sql: 'changes() = 1', params: [] })],
        { authority: probe(held), conflict: probe(eligible) },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') {
          const [unattached] = await executor.all(
            compile(
              db
                .selectFrom('package as p')
                .innerJoin('source as s', (join) =>
                  join.onRef('s.id', '=', 'p.source_id').onRef('s.org_id', '=', 'p.org_id'),
                )
                .select('p.id')
                .where('p.org_id', '=', ctx.orgId)
                .where('p.id', '=', input.packageId)
                .where('s.type', '=', 'hosted')
                .where(
                  sql<SqlBool>`not exists (select 1 from project_source as a where a.org_id = ${ctx.orgId} and a.project_id = ${input.projectId} and a.source_id = p.source_id)`,
                ),
            ),
          );
          if (unattached !== undefined) throw new PackageAccessRequestError('source_not_attached');
        }
        const [project] = await executor.all<{ status: string }>(
          compile(
            db
              .selectFrom('project')
              .select('status')
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', input.projectId),
          ),
        );
        throw new PackageAccessRequestError(
          project?.status === 'archived'
            ? 'conflict'
            : outcome.reason === 'authority'
              ? 'forbidden'
              : outcome.reason === 'conflict' || outcome.reason === 'collision'
                ? 'conflict'
                : 'unavailable',
        );
      }
      const result = await get(ctx, input.id);
      if (result === null) throw new PackageAccessRequestError('unavailable');
      return result;
    },
    async decide(ctx, fence, input) {
      reason(input.reason);
      instant(input.now);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
        throw new PackageAccessRequestError('invalid_request');
      let held: Guard;
      if (input.state === 'expired') {
        if (
          fenceKind(fence) !== 'system' ||
          (fence as SystemMutationFence).writer !== 'purge' ||
          input.decidedByUserId !== null
        )
          throw new PackageAccessRequestError('forbidden');
        const job = (fence as SystemMutationFence).job;
        held = sql<SqlBool>`exists (select 1 from job as expiry_job where expiry_job.org_id = ${ctx.orgId} and expiry_job.id = ${job.id}
          and expiry_job.lease_owner = ${job.owner} and expiry_job.fence = ${job.fence}
          and expiry_job.type = 'core:package-access-expire:v1' and expiry_job.state = 'running' and expiry_job.lease_until > ${DB_NOW})`;
      } else {
        held = authority(ctx, fence, 'org:packages:manage', null, input.decidedByUserId);
      }
      const [authorization] = await executor.all<{ failed: number }>(probe(held));
      if (authorization?.failed !== 0) throw new PackageAccessRequestError('forbidden');
      const row = await get(ctx, input.id);
      if (row === null) throw new PackageAccessRequestError('not_found');
      const ready = sql<SqlBool>`exists (select 1 from package_access_request as deciding where deciding.org_id = ${ctx.orgId}
        and deciding.id = ${input.id} and deciding.state = 'pending' and deciding.revision = ${input.expectedRevision}
        and ${input.state === 'expired' ? sql<SqlBool>`deciding.expires_at <= ${DB_NOW}` : sql<SqlBool>`deciding.expires_at > ${DB_NOW}`}
        and ${
          input.state === 'approved'
            ? sql<SqlBool>`exists (select 1 from project as dp join package as dk on dk.id = deciding.package_id
          join source as ds on ds.id = dk.source_id join project_source as da on da.source_id = ds.id and da.project_id = dp.id
          where dp.id = deciding.project_id and dp.org_id = ${ctx.orgId} and dk.org_id = ${ctx.orgId} and ds.org_id = ${ctx.orgId}
          and da.org_id = ${ctx.orgId} and dp.status = 'active' and dk.status = 'active' and dk.held_until_active = 0
          and ds.status = 'active' and (ds.project_id is null or ds.project_id = dp.id))`
            : sql<SqlBool>`1`
        })`;
      const update = compile(
        db
          .updateTable('package_access_request')
          .set({
            state: input.state,
            decided_by_user_id: input.decidedByUserId,
            decided_at: input.now,
            decision_reason: input.reason ?? null,
            updated_at: input.now,
            revision: sql<number>`revision + 1`,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.id)
          .where('state', '=', 'pending')
          .where('revision', '=', input.expectedRevision),
      );
      const mutations = [
        update,
        auditPendingStatement(ctx, input.event, { sql: 'changes() = 1', params: [] }),
      ];
      if (input.state === 'approved')
        mutations.push(
          explicitPackageStatement(ctx, row.projectId, row.packageId),
          compile(
            db
              .updateTable('package')
              .set({ rev: sql<number>`rev + 1`, modified_at: monotonicNow })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', row.packageId),
          ),
        );
      const guard = assertGuard(sql<SqlBool>`(${held} and ${ready})`, ctx);
      const outcome =
        fenceKind(fence) === 'system'
          ? await runFenced(executor, fence, guard, mutations, {
              authority: probe(held),
              conflict: probe(ready),
            })
          : await runOrgFenced(executor, ctx, fence as MutationFence, guard, mutations, {
              authority: probe(held),
              conflict: probe(ready),
            });
      if (!outcome.ok && outcome.reason === 'authority')
        throw new PackageAccessRequestError('forbidden');
      if (!outcome.ok && outcome.reason !== 'conflict')
        throw new PackageAccessRequestError('unavailable');
      return {
        changed: outcome.ok,
        revision: outcome.ok
          ? input.expectedRevision + 1
          : ((await get(ctx, input.id))?.revision ?? row.revision),
      };
    },
  };
}
