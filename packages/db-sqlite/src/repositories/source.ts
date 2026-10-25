import { sql, type SqlBool } from 'kysely';
import type { FailureProbes, MutationFence } from '@package-broker/core/authz/fence';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  RemovalPolicy,
  SourceEcosystem,
  SourceErrorCode,
  SourceListQuery,
  SourceRecord,
  SourceRepository,
  SourceStatus,
  SourceType,
} from '@package-broker/core/db/source';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { sourceAttachmentCountsStatement } from './source-attachment-counts.js';
import { acceptRemovalStatement } from './source-removal.js';
import { holdsPermission, permissionRows } from './access.js';
import { actorHolds } from './actor-authority.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';

export type { NewSource, SourceRepository } from '@package-broker/core/db/source';

const MAX_DUE = 50;
const MAX_BACKOFF_EXPONENT = 20;
const FAILING_AFTER = 5;
const DB_NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const PROXY_TYPES = ['packagist_proxy', 'npmjs_proxy'] as const;

export const SOURCE_ERROR_CODES = [
  'network',
  'timeout',
  'http_error',
  'unauthorized',
  'rate_limited',
  'not_found',
  'invalid_response',
  'mass_absence',
  'too_large',
  'policy_denied',
  'credential_unavailable',
  'internal',
] as const;

const CREDENTIAL_REPLACEABLE_ERRORS = [
  'network',
  'timeout',
  'http_error',
  'rate_limited',
] as const satisfies readonly SourceErrorCode[];

const CHANGE_KEYS: ReadonlySet<string> = new Set([
  'url',
  'configJson',
  'credentialId',
  'userAgent',
  'pollIntervalSeconds',
  'removalPolicy',
  'retentionDaysOverride',
  'defaultVisibleToNewProjects',
]);

function positiveInteger(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

function jsonText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('configJson must be a JSON string');
  try {
    JSON.parse(value);
  } catch {
    throw new TypeError('configJson must be valid JSON');
  }
  return value;
}

function removalPolicy(value: unknown): RemovalPolicy {
  if (value !== 'flag' && value !== 'exclude') {
    throw new TypeError('removalPolicy must be flag or exclude');
  }
  return value;
}

function retentionDays(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('retentionDaysOverride must be null or a non-negative integer');
  }
  return value;
}

function nullableText(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
  return value;
}

function errorCode(value: unknown): SourceErrorCode {
  if (!SOURCE_ERROR_CODES.includes(value as SourceErrorCode)) {
    throw new TypeError('last_error must be one of the fixed source error codes');
  }
  return value as SourceErrorCode;
}

function isProxy(type: SourceType): boolean {
  return (PROXY_TYPES as readonly string[]).includes(type);
}

function probe(condition: Guard, negate: boolean): Statement {
  const expression = negate ? sql<number>`(${condition}) is not 1` : sql<number>`(${condition})`;
  return compile(db.selectNoFrom(expression.as('held')));
}

function allOf(conditions: readonly Guard[]): Guard {
  return sql<SqlBool>`(${sql.join(conditions, sql` and `)})`;
}

function authority(
  ctx: OrgContext,
  fence: MutationFence,
  ownerProjectId: string | null,
  providerAnchors: readonly ProtectedHolderProvider[],
): Guard {
  return actorHolds(ctx, fence, {
    permission: ownerProjectId === null ? 'org:sources:write' : 'project:sources:write',
    projectId: ownerProjectId,
    providerAnchors,
  });
}

function sourceOwnedBy(ctx: OrgContext, id: string, ownerProjectId: string | null): Guard {
  return sql<SqlBool>`exists (select 1 from source as target
    where target.id = ${id} and target.org_id = ${ctx.orgId} and target.project_id is ${ownerProjectId})`;
}

function credentialOwnedBy(ctx: OrgContext, id: string, ownerProjectId: string | null): Guard {
  return sql<SqlBool>`exists (select 1 from credential as owned
    where owned.id = ${id} and owned.org_id = ${ctx.orgId} and owned.project_id is ${ownerProjectId})`;
}

interface SourceRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly name: string;
  readonly ecosystem: SourceEcosystem;
  readonly type: SourceType;
  readonly url: string | null;
  readonly credential_id: string | null;
  readonly config_json: string;
  readonly user_agent: string | null;
  readonly default_visible_to_new_projects: number;
  readonly removal_policy: RemovalPolicy;
  readonly retention_days_override: number | null;
  readonly status: SourceStatus;
  readonly poll_interval_seconds: number;
  readonly next_poll_at: string | null;
  readonly last_polled_at: string | null;
  readonly last_success_at: string | null;
  readonly last_error: string | null;
  readonly consecutive_failures: number;
  readonly root_hash: string | null;
  readonly listing_hash: string | null;
  readonly poll_etag: string | null;
  readonly poll_last_modified: string | null;
  readonly last_refusal_at: string | null;
  readonly last_refusal_absent: number | null;
  readonly last_refusal_listed: number | null;
  readonly last_refusal_successful: number | null;
  readonly removal_accepted: number;
}

function removalRefusalOf(row: SourceRow): SourceRecord['removalRefusal'] {
  const { last_refusal_at: at, last_refusal_absent: absent } = row;
  const { last_refusal_listed: listed, last_refusal_successful: successful } = row;
  if (at === null && absent === null && listed === null && successful === null) return null;
  if (at === null || absent === null || listed === null || successful === null)
    throw new TypeError('source removal refusal facts are incomplete');
  return { at, absent, listed, successful };
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    ecosystem: row.ecosystem,
    type: row.type,
    url: row.url,
    credentialId: row.credential_id,
    configJson: row.config_json,
    userAgent: row.user_agent,
    defaultVisibleToNewProjects: row.default_visible_to_new_projects === 1,
    removalPolicy: row.removal_policy,
    retentionDaysOverride: row.retention_days_override,
    status: row.status,
    pollIntervalSeconds: row.poll_interval_seconds,
    nextPollAt: row.next_poll_at,
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    rootHash: row.root_hash,
    listingHash: row.listing_hash,
    pollEtag: row.poll_etag,
    pollLastModified: row.poll_last_modified,
    removalRefusal: removalRefusalOf(row),
    removalAccepted: row.removal_accepted === 1,
  };
}

const SOURCE_COLUMNS = [
  'id',
  'project_id',
  'name',
  'ecosystem',
  'type',
  'url',
  'credential_id',
  'config_json',
  'user_agent',
  'default_visible_to_new_projects',
  'removal_policy',
  'retention_days_override',
  'status',
  'poll_interval_seconds',
  'next_poll_at',
  'last_polled_at',
  'last_success_at',
  'last_error',
  'consecutive_failures',
  'root_hash',
  'listing_hash',
  'poll_etag',
  'poll_last_modified',
  'last_refusal_at',
  'last_refusal_absent',
  'last_refusal_listed',
  'last_refusal_successful',
  'removal_accepted',
] as const;

export function findByRepositoryStatement(
  ctx: OrgContext,
  input: { provider: string; repository: string },
): Statement {
  const config = sql`case when json_valid(config_json) then
    case when json_type(config_json) = 'object' then config_json end end`;
  return compile(
    db
      .selectFrom('source')
      .select([...SOURCE_COLUMNS])
      .where('org_id', '=', ctx.orgId)
      .where('type', '=', sql.lit('vcs'))
      .where(sql`json_extract(${config}, '$.provider')`, '=', input.provider)
      .where(
        sql`lower(json_extract(${config}, '$.repository'))`,
        '=',
        input.repository.toLowerCase(),
      )
      .orderBy('id')
      .limit(1),
  );
}

export function dueStatement(ctx: OrgContext, limit: number): Statement {
  return compile(
    db
      .selectFrom('source')
      .select([...SOURCE_COLUMNS])
      .where('org_id', '=', ctx.orgId)
      .where('status', '<>', sql.lit('paused'))
      .where('next_poll_at', '<=', DB_NOW)
      .orderBy('next_poll_at')
      .orderBy('id')
      .limit(limit),
  );
}

export function listSourcesStatement(ctx: OrgContext, input: SourceListQuery): Statement {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('limit must be an integer from 1 to 100');
  let query = db
    .selectFrom('source')
    .select([...SOURCE_COLUMNS])
    .where('org_id', '=', ctx.orgId);
  if (input.projectId === null) {
    if (input.ownership === 'project') query = query.where('project_id', 'is not', null);
    else if (input.ownership !== 'all') query = query.where('project_id', 'is', null);
    const visibility = input.projectVisibility;
    if (visibility !== undefined && input.ownership !== 'organization') {
      let projects = db
        .selectFrom('project as source_owner')
        .select('source_owner.id')
        .where('source_owner.org_id', '=', ctx.orgId)
        .where('source_owner.id', '=', sql.ref<string>('source.project_id'));
      if (visibility.restrictTo !== undefined) {
        projects = projects.where(
          'source_owner.id',
          'in',
          db
            .selectFrom(
              db
                .fn<{ value: string }>('json_each', [
                  sql.val(JSON.stringify(visibility.restrictTo)),
                ])
                .as('project_cap'),
            )
            .select('project_cap.value'),
        );
      }
      if (!visibility.includeArchived)
        projects = projects.where('source_owner.status', '=', 'active');
      const servicePrincipalId = visibility.servicePrincipalId;
      if (servicePrincipalId !== undefined) {
        projects = projects.where((eb) =>
          eb.exists(
            db
              .selectFrom('service_principal as source_service')
              .innerJoin(
                'service_principal_permission as source_permission',
                'source_permission.service_principal_id',
                'source_service.id',
              )
              .select('source_service.id')
              .where('source_service.org_id', '=', ctx.orgId)
              .where('source_permission.org_id', '=', ctx.orgId)
              .where('source_service.id', '=', servicePrincipalId)
              .where('source_service.status', '=', 'active')
              .where('source_permission.permission', '=', 'project:read')
              .where((service) =>
                service.or([
                  service('source_service.project_id', 'is', null),
                  service('source_service.project_id', '=', sql.ref<string>('source_owner.id')),
                ]),
              ),
          ),
        );
      } else if (!visibility.allProjects) {
        projects = projects.where(
          holdsPermission(ctx, {
            userId: visibility.userId,
            projectId: sql.ref('source_owner.id'),
            permission: 'project:read',
            projectState: 'any',
            providerAnchors: visibility.providerAnchors,
          }),
        );
      }
      query = query.where((eb) =>
        eb.or([eb('source.project_id', 'is', null), eb.exists(projects)]),
      );
    }
  } else {
    query = query.where(sql<SqlBool>`exists (select 1 from project as visible_project
      where visible_project.id = ${input.projectId} and visible_project.org_id = ${ctx.orgId}
        and visible_project.status = 'active')`)
      .where(sql<SqlBool>`(source.project_id = ${input.projectId} or
        (source.project_id is null and exists (select 1 from project_source as attachment
          where attachment.org_id = ${ctx.orgId} and attachment.project_id = ${input.projectId}
            and attachment.source_id = source.id)))`);
  }
  query = query.select((eb) =>
    eb
      .selectFrom('project as owner_project')
      .select('owner_project.name')
      .where('owner_project.org_id', '=', ctx.orgId)
      .whereRef('owner_project.id', '=', 'source.project_id')
      .as('projectName'),
  );
  if (input.after !== null) query = query.where('id', '>', input.after);
  return compile(query.orderBy('id').limit(input.limit + 1));
}

export function getVisibleSourceStatement(
  ctx: OrgContext,
  input: { readonly projectId: string; readonly sourceId: string },
): Statement {
  return compile(
    db
      .selectFrom('source')
      .select([...SOURCE_COLUMNS])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.sourceId)
      .where(sql<SqlBool>`exists (select 1 from project as visible_project
        where visible_project.id = ${input.projectId} and visible_project.org_id = ${ctx.orgId}
          and visible_project.status = 'active')`)
      .where(sql<SqlBool>`(source.project_id = ${input.projectId} or
        (source.project_id is null and exists (select 1 from project_source as attachment
          where attachment.org_id = ${ctx.orgId} and attachment.project_id = ${input.projectId}
            and attachment.source_id = source.id)))`),
  );
}

export function pauseSourceStatement(ctx: OrgContext, id: string): Statement {
  return compile(
    db
      .updateTable('source')
      .set({ status: 'paused', updated_at: DB_NOW })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id),
  );
}

export function deferPollStatement(
  ctx: OrgContext,
  id: string,
  expectedNextPollAt: string,
): Statement {
  return compile(
    db
      .updateTable('source')
      .set({
        next_poll_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || poll_interval_seconds || ' seconds')`,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id)
      .where('status', '<>', sql.lit('paused'))
      .where('next_poll_at', '=', expectedNextPollAt),
  );
}

export function attachedProxyStatement(
  ctx: OrgContext,
  projectId: string,
  ecosystem: SourceEcosystem,
): Statement {
  return compile(
    db
      .selectFrom('project_source')
      .innerJoin('source', (join) =>
        join
          .onRef('source.id', '=', 'project_source.source_id')
          .onRef('source.org_id', '=', 'project_source.org_id'),
      )
      .select('source.id')
      .where('project_source.org_id', '=', ctx.orgId)
      .where('project_source.project_id', '=', projectId)
      .where('source.ecosystem', '=', ecosystem)
      .where('source.type', '=', ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy')
      .limit(1),
  );
}

export function createSourceRepository(executor: SqlExecutor): SourceRepository {
  async function read(ctx: OrgContext, id: string): Promise<SourceRecord | null> {
    const [row] = await executor.all<SourceRow>(
      compile(
        db
          .selectFrom('source')
          .select([...SOURCE_COLUMNS])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      ),
    );
    return row === undefined ? null : toRecord(row);
  }

  async function holdsRight(
    ctx: OrgContext,
    fence: MutationFence,
    owner: string | null,
    anchors: readonly ProtectedHolderProvider[],
  ): Promise<boolean> {
    const [row] = await executor.all<{ held: number }>(
      probe(authority(ctx, fence, owner, anchors), false),
    );
    return row?.held === 1;
  }

  async function locate(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    anchors: readonly ProtectedHolderProvider[],
  ): Promise<SourceRecord | 'forbidden' | 'not_found'> {
    const current = await read(ctx, id);
    if (current === null) {
      return (await holdsRight(ctx, fence, null, anchors)) ? 'not_found' : 'forbidden';
    }
    return (await holdsRight(ctx, fence, current.projectId, anchors)) ? current : 'forbidden';
  }

  async function failureResult(
    ctx: OrgContext,
    id: string,
    reason: string,
  ): Promise<'not_found' | 'forbidden' | 'conflict' | 'indeterminate'> {
    if (reason === 'indeterminate') return 'indeterminate';
    if (reason === 'authority') return 'forbidden';
    return (await read(ctx, id)) === null ? 'not_found' : 'conflict';
  }

  return {
    async syncNow(ctx, fence, input) {
      const current = await locate(ctx, fence, input.id, input.providerAnchors);
      if (typeof current === 'string') return current;
      if (current.status === 'paused') return 'source_paused';
      const held = authority(ctx, fence, current.projectId, input.providerAnchors);
      const owned = sourceOwnedBy(ctx, input.id, current.projectId);
      const active = sql<SqlBool>`exists (select 1 from source
        where org_id = ${ctx.orgId} and id = ${input.id} and status <> 'paused')`;
      const collision = liveIdempotencyCollision(ctx, input.idempotency);
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allOf([held, owned]), ctx),
        [
          ...assertCheck(active),
          compile(
            db
              .updateTable('source')
              .set({ next_poll_at: DB_NOW, updated_at: DB_NOW })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', input.id)
              .where('status', '!=', 'paused'),
          ),
          auditPendingStatement(ctx, input.audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        { authority: probe(held, true), conflict: probe(collision, false) },
      );
      if (outcome.ok) return 'requested';
      if (outcome.reason === 'authority' || outcome.reason === 'indeterminate')
        return failureResult(ctx, input.id, outcome.reason);
      const after = await read(ctx, input.id);
      if (after === null || after.projectId !== current.projectId) return 'not_found';
      return after.status === 'paused' ? 'source_paused' : 'conflict';
    },
    async acceptRemoval(ctx, fence, input) {
      const held = authority(ctx, fence, null, input.providerAnchors);
      const localAdmin = sql<SqlBool>`EXISTS (SELECT 1 FROM session
        WHERE org_id = ${ctx.orgId} AND id = ${fence.sessionId} AND identity_id IS NULL)`;
      const permissions = permissionRows(ctx, fence.userId, null, input.providerAnchors, {
        localAdmin,
      });
      const admin = sql<SqlBool>`EXISTS (SELECT 1 FROM (${permissions}) AS removal_admin
        WHERE removal_admin.scope = 'organization' AND removal_admin.protects = 1)`;
      const visible = sql<SqlBool>`EXISTS (SELECT 1 FROM source
        WHERE org_id = ${ctx.orgId} AND id = ${input.id}
          AND (project_id IS NULL OR EXISTS (SELECT 1 FROM project
            WHERE project.org_id = ${ctx.orgId} AND project.id = source.project_id AND project.status = 'active')))`;
      const [permission] = await executor.all<{ held: number }>(probe(held, false));
      const [administrator] = await executor.all<{ held: number }>(probe(admin, false));
      if (permission?.held !== 1 || administrator?.held !== 1) return 'forbidden';
      const [source] = await executor.all<{ held: number }>(probe(visible, false));
      if (source?.held !== 1) return 'not_found';
      const accept = acceptRemovalStatement(ctx, { sourceId: input.id, refusal: input.refusal });
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(held, ctx),
        [
          ...assertCheck(admin),
          ...assertCheck(visible),
          accept,
          ...assertCheck(sql<boolean>`changes() = 1`),
          auditPendingStatement(ctx, input.audit),
        ],
        { authority: probe(allOf([held, admin]), true) },
      );
      if (outcome.ok) return 'accepted';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'indeterminate') return 'indeterminate';
      const [remaining] = await executor.all<{ held: number }>(probe(visible, false));
      return remaining?.held === 1 ? 'conflict' : 'not_found';
    },
    async getVisible(ctx, input) {
      const [row] = await executor.all<SourceRow>(getVisibleSourceStatement(ctx, input));
      return row === undefined ? null : toRecord(row);
    },
    async list(ctx, input) {
      const rows = await executor.all<SourceRow & { projectName: string | null }>(
        listSourcesStatement(ctx, input),
      );
      return rows.map((row) => ({ ...toRecord(row), projectName: row.projectName }));
    },
    async countAttachedProjects(ctx, input) {
      const rows = await executor.all<{ sourceId: string; count: number }>(
        sourceAttachmentCountsStatement(ctx, input),
      );
      return new Map(rows.map((row) => [row.sourceId, row.count]));
    },
    async pause(ctx, fence, input) {
      const current = await locate(ctx, fence, input.id, input.providerAnchors);
      if (typeof current === 'string') return current;
      const collision = liveIdempotencyCollision(ctx, input.idempotency);
      if (input.idempotency !== undefined) {
        const [row] = await executor.all<{ held: number }>(probe(collision, false));
        if (row?.held === 1) return 'conflict';
      }
      const held = authority(ctx, fence, current.projectId, input.providerAnchors);
      const allowed = allOf([held, sourceOwnedBy(ctx, input.id, current.projectId)]);
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          pauseSourceStatement(ctx, input.id),
          auditPendingStatement(ctx, input.audit, { sql: 'changes() > 0', params: [] }),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        { authority: probe(held, true), conflict: probe(collision, false) },
      );
      return outcome.ok ? 'paused' : failureResult(ctx, input.id, outcome.reason);
    },
    async hasAttachedProxy(ctx, projectId, ecosystem) {
      return (await executor.all(attachedProxyStatement(ctx, projectId, ecosystem))).length > 0;
    },
    async create(ctx, fence, input) {
      const jsonConfig = jsonText(input.configJson);
      const interval =
        input.pollIntervalSeconds === undefined
          ? undefined
          : positiveInteger('pollIntervalSeconds', input.pollIntervalSeconds);
      const policy =
        input.removalPolicy === undefined ? undefined : removalPolicy(input.removalPolicy);
      const retention =
        input.retentionDaysOverride === undefined
          ? undefined
          : retentionDays(input.retentionDaysOverride);
      const allowed = authority(ctx, fence, input.projectId, input.providerAnchors);
      if (
        input.credential !== null &&
        'statement' in input.credential &&
        input.credential.projectId !== input.projectId
      ) {
        return 'credential_scope_mismatch';
      }
      const credentialOk =
        input.credential === null
          ? null
          : credentialOwnedBy(ctx, input.credential.id, input.projectId);
      const duplicate = sql<SqlBool>`exists (select 1 from source as existing
        where existing.org_id = ${ctx.orgId}
          and (existing.id = ${input.id}
            or (existing.project_id is ${input.projectId} and existing.name = ${input.name})))`;
      const insert = compile(
        db.insertInto('source').values({
          id: input.id,
          org_id: ctx.orgId,
          project_id: input.projectId,
          name: input.name,
          ecosystem: input.ecosystem,
          type: input.type,
          url: input.url,
          credential_id: input.credential?.id ?? null,
          config_json: jsonConfig,
          user_agent: input.userAgent ?? null,
          status: isProxy(input.type) ? 'active' : 'paused',
          ...(interval === undefined ? {} : { poll_interval_seconds: interval }),
          ...(policy === undefined ? {} : { removal_policy: policy }),
          ...(retention === undefined ? {} : { retention_days_override: retention }),
          ...(input.defaultVisibleToNewProjects === undefined
            ? {}
            : { default_visible_to_new_projects: input.defaultVisibleToNewProjects ? 1 : 0 }),
          next_poll_at: DB_NOW,
        }),
      );
      const probes: FailureProbes = {
        authority: probe(allowed, true),
        collision: probe(duplicate, false),
        ...(credentialOk === null
          ? {}
          : {
              conflict: probe(
                allOf([sql<SqlBool>`not ${duplicate}`, sql<SqlBool>`not ${credentialOk}`]),
                false,
              ),
            }),
      };
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          ...(input.credential !== null && 'statement' in input.credential
            ? [input.credential.statement]
            : []),
          ...(credentialOk === null ? [] : assertCheck(credentialOk)),
          insert,
          auditPendingStatement(ctx, input.audit, { sql: 'changes() > 0', params: [] }),
        ],
        probes,
      );
      if (outcome.ok) return 'created';
      if (outcome.reason === 'authority') return 'forbidden';
      if (outcome.reason === 'conflict') return 'credential_scope_mismatch';
      if (outcome.reason === 'collision') return 'duplicate';
      return outcome.reason === 'indeterminate' ? 'indeterminate' : 'conflict';
    },

    async update(ctx, fence, input) {
      const keys = Object.keys(input.changes);
      if (keys.length === 0 || keys.some((key) => !CHANGE_KEYS.has(key))) {
        throw new TypeError('changes must name one or more updatable source fields');
      }
      const changes = input.changes;
      if (
        input.preparedCredential !== undefined &&
        input.preparedCredential.id !== changes.credentialId
      ) {
        return 'credential_scope_mismatch';
      }
      const set: Record<string, string | number | null> = {};
      if (changes.url !== undefined) set.url = nullableText('url', changes.url);
      if (changes.configJson !== undefined) set.config_json = jsonText(changes.configJson);
      if (changes.credentialId !== undefined) {
        set.credential_id = nullableText('credentialId', changes.credentialId);
      }
      if (changes.userAgent !== undefined) {
        set.user_agent = nullableText('userAgent', changes.userAgent);
      }
      if (changes.pollIntervalSeconds !== undefined) {
        set.poll_interval_seconds = positiveInteger(
          'pollIntervalSeconds',
          changes.pollIntervalSeconds,
        );
      }
      if (changes.removalPolicy !== undefined)
        set.removal_policy = removalPolicy(changes.removalPolicy);
      if (changes.retentionDaysOverride !== undefined) {
        set.retention_days_override = retentionDays(changes.retentionDaysOverride);
      }
      if (changes.defaultVisibleToNewProjects !== undefined) {
        set.default_visible_to_new_projects = changes.defaultVisibleToNewProjects ? 1 : 0;
      }
      const current = await locate(ctx, fence, input.id, input.providerAnchors);
      if (typeof current === 'string') return current;
      const allowed = allOf([
        authority(ctx, fence, current.projectId, input.providerAnchors),
        sourceOwnedBy(ctx, input.id, current.projectId),
      ]);
      const credentialOk =
        typeof set.credential_id === 'string'
          ? credentialOwnedBy(ctx, set.credential_id, current.projectId)
          : null;
      const touchesCoverage =
        !isProxy(current.type) && (changes.configJson !== undefined || changes.url !== undefined);
      const statusBefore = compile(
        db
          .selectFrom('source')
          .select('status')
          .where('id', '=', input.id)
          .where('org_id', '=', ctx.orgId),
      );
      const update = compile(
        db
          .updateTable('source')
          .set({
            ...set,
            ...(touchesCoverage
              ? {
                  status: sql<SourceStatus>`case when status <> 'paused' then 'paused' else status end`,
                }
              : {}),
            updated_at: DB_NOW,
          })
          .where('id', '=', input.id)
          .where('org_id', '=', ctx.orgId),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          ...(input.preparedCredential === undefined ? [] : [input.preparedCredential.statement]),
          ...(credentialOk === null ? [] : assertCheck(credentialOk)),
          statusBefore,
          update,
          ...input.audit.map((event) =>
            auditPendingStatement(ctx, event, { sql: 'changes() > 0', params: [] }),
          ),
        ],
        {
          authority: probe(authority(ctx, fence, current.projectId, input.providerAnchors), true),
          ...(credentialOk === null || input.preparedCredential !== undefined
            ? {}
            : { conflict: probe(credentialOk, true) }),
        },
      );
      if (outcome.ok) {
        const before = outcome.results[outcome.results.length - 2 - input.audit.length]?.rows[0];
        return touchesCoverage && before?.status !== 'paused'
          ? 'paused_for_reactivation'
          : 'updated';
      }
      if (outcome.reason === 'conflict' && credentialOk !== null) {
        return (await read(ctx, input.id)) === null ? 'not_found' : 'credential_scope_mismatch';
      }
      return failureResult(ctx, input.id, outcome.reason);
    },

    async resume(ctx, fence, input) {
      const current = await locate(ctx, fence, input.id, input.providerAnchors);
      if (typeof current === 'string') return current;
      if (!isProxy(current.type)) return 'activation_requires_registered_names';
      const held = authority(ctx, fence, current.projectId, input.providerAnchors);
      const allowed = allOf([
        held,
        sourceOwnedBy(ctx, input.id, current.projectId),
        sql<SqlBool>`exists (select 1 from source as proxy
          where proxy.id = ${input.id} and proxy.type in (${sql.join(PROXY_TYPES)}))`,
      ]);
      const update = compile(
        db
          .updateTable('source')
          .set({ status: 'active', updated_at: DB_NOW })
          .where('id', '=', input.id)
          .where('org_id', '=', ctx.orgId)
          .where('type', 'in', [...PROXY_TYPES]),
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          auditPendingStatement(ctx, input.audit, {
            sql: `EXISTS (SELECT 1 FROM source WHERE org_id = ? AND id = ? AND status <> 'active'
              AND type IN (${PROXY_TYPES.map(() => '?').join(', ')}))`,
            params: [ctx.orgId, input.id, ...PROXY_TYPES],
          }),
          update,
        ],
        {
          authority: probe(held, true),
        },
      );
      if (outcome.ok) return 'resumed';
      return failureResult(ctx, input.id, outcome.reason);
    },

    async delete(ctx, fence, input) {
      const current = await locate(ctx, fence, input.id, input.providerAnchors);
      if (typeof current === 'string') return current;
      const held = authority(ctx, fence, current.projectId, input.providerAnchors);
      const allowed = allOf([held, sourceOwnedBy(ctx, input.id, current.projectId)]);
      const packages = sql<SqlBool>`exists (select 1 from package as referencing
        where referencing.source_id = ${input.id})`;
      const history = sql<SqlBool>`exists (select 1 from webhook_delivery as delivered
        where delivered.org_id = ${ctx.orgId} and delivered.source_id = ${input.id})`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          ...assertCheck(sql<SqlBool>`not ${packages}`),
          ...assertCheck(sql<SqlBool>`not ${history}`),
          compile(db.deleteFrom('project_package_pattern').where('source_id', '=', input.id)),
          compile(db.deleteFrom('project_source').where('source_id', '=', input.id)),
          compile(
            db.deleteFrom('source').where('id', '=', input.id).where('org_id', '=', ctx.orgId),
          ),
        ],
        {
          authority: probe(held, true),
          conflict: probe(packages, false),
          collision: probe(history, false),
        },
      );
      if (outcome.ok) return 'deleted';
      if (outcome.reason === 'conflict') return 'has_packages';
      if (outcome.reason === 'collision') return 'has_history';
      return failureResult(ctx, input.id, outcome.reason);
    },

    get: read,

    async findByRepository(ctx, input) {
      const [row] = await executor.all<SourceRow>(findByRepositoryStatement(ctx, input));
      return row === undefined ? null : toRecord(row);
    },

    async listDue(ctx, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DUE) {
        throw new RangeError(`limit must be an integer from 1 to ${String(MAX_DUE)}`);
      }
      const rows = await executor.all<SourceRow>(dueStatement(ctx, limit));
      return rows.map(toRecord);
    },

    async deferPoll(ctx, id, expectedNextPollAt) {
      const [result] = await executor.batch([deferPollStatement(ctx, id, expectedNextPollAt)]);
      return result?.changes === 1;
    },

    async markCredentialUnavailable(ctx, id) {
      const code: SourceErrorCode = 'credential_unavailable';
      await executor.batch([
        compile(
          db
            .updateTable('source')
            .set({ last_error: code })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', id)
            .where((eb) =>
              eb.or([
                eb('last_error', 'is', null),
                eb('last_error', 'in', [...CREDENTIAL_REPLACEABLE_ERRORS]),
              ]),
            ),
        ),
      ]);
    },

    async pollState(ctx, guard, input) {
      const format = '%Y-%m-%dT%H:%M:%fZ';
      const keep = (column: string, value: string | null | undefined) =>
        value === undefined ? sql<string | null>`${sql.ref(column)}` : sql<string | null>`${value}`;
      let update;
      if (input.outcome === 'success') {
        update = db.updateTable('source').set({
          status: sql<'active'>`case when status = 'paused' then 'paused' else 'active' end`,
          consecutive_failures: 0,
          last_error: null,
          last_polled_at: DB_NOW,
          last_success_at: DB_NOW,
          next_poll_at: sql<string>`strftime(${format}, 'now', '+' || poll_interval_seconds || ' seconds')`,
          root_hash: keep('root_hash', input.rootHash),
          listing_hash: keep('listing_hash', input.listingHash),
          poll_etag: keep('poll_etag', input.pollEtag),
          poll_last_modified: keep('poll_last_modified', input.pollLastModified),
        });
      } else {
        const code = errorCode(input.error);
        update = db.updateTable('source').set({
          status: sql<'degraded'>`case when status = 'paused' then 'paused'
              when consecutive_failures + 1 >= ${FAILING_AFTER} then 'failing' else 'degraded' end`,
          consecutive_failures: sql<number>`consecutive_failures + 1`,
          last_error: code,
          last_polled_at: DB_NOW,
          next_poll_at: sql<string>`strftime(${format}, 'now', '+' ||
              min(poll_interval_seconds, 300 * (1 << min(consecutive_failures, ${MAX_BACKOFF_EXPONENT}))) ||
              ' seconds')`,
        });
      }
      const statement = compile(update.where('id', '=', input.id).where('org_id', '=', ctx.orgId));
      let results;
      try {
        results = await executor.batch([
          ...jobLeaseGuard(ctx, guard),
          ...assertCheck(
            sql<SqlBool>`exists (select 1 from job as polling
              where polling.id = ${guard.id} and polling.org_id = ${ctx.orgId}
                and polling.resource_key = ${`source:${input.id}`})`,
          ),
          statement,
        ]);
      } catch (error) {
        if (error instanceof DbError && error.kind === 'unique') return 'stale';
        throw error;
      }
      return results[results.length - 1]?.changes === 1 ? 'written' : 'not_found';
    },
  };
}
