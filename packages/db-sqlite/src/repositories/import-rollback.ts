import { sql, type SqlBool } from 'kysely';
import { ulid } from '@package-broker/core/ids';
import {
  fenceKind,
  runFenced,
  type DelegatedMutationFence,
} from '@package-broker/core/authz/fence';
import { auditPendingStatement } from './audit-pending.js';
import type {
  ImportRollbackAction,
  ImportRollbackDomainValue,
  ImportRollbackGuard,
  ImportRollbackLiveState,
  ImportRollbackOutcome,
  ImportRollbackStore,
} from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { assertGuard, compile, db, type Guard, type ProtectedHolderProvider } from '../kysely.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';
import { permissionRows } from './access.js';
import { blobLeaseNotLive } from './blob-lease-guard.js';
import { createImportJournalStore, hash, instant, withinBatchBudget } from './import-journal.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { rederiveStatements } from './visibility-derive.js';
import { patInvalidationStatement } from './pat-offboarding.js';

type Row = Record<string, SqlValue>;
type Dependent = readonly [table: string, column: string];

interface RollbackEntity {
  readonly table: string;
  readonly key: readonly string[];
  readonly domain: readonly string[];
  readonly revision: boolean;
  readonly deletable: boolean;
  readonly restorable: readonly string[];
  readonly dependents: readonly Dependent[];
  readonly permissions?: true;
}

const LOOKUP_CHUNK = 40;
const BASES: ReadonlySet<unknown> = new Set(['source_release', 'packagist_added', 'import_time']);
const RUN_STATES = "('failed', 'applied', 'verifying', 'verified')";
const SOURCE_DOMAIN = [
  'name',
  'ecosystem',
  'type',
  'project_id',
  'url',
  'config_json',
  'status',
  'credential_id',
  'protocol_mode',
  'has_available_packages',
  'user_agent',
  'default_visible_to_new_projects',
  'removal_policy',
  'retention_days_override',
  'poll_interval_seconds',
  'next_poll_at',
  'last_polled_at',
  'last_success_at',
  'poll_etag',
  'poll_last_modified',
  'root_hash',
  'listing_hash',
  'consecutive_failures',
  'last_error',
  'listing_open_stamp',
  'listing_opened_at',
  'last_refusal_at',
  'last_refusal_absent',
  'last_refusal_listed',
  'last_refusal_successful',
  'removal_accepted',
] as const;
const PROJECT_DOMAIN = [
  'slug',
  'name',
  'status',
  'token_max_scope',
  'require_publish_approval',
] as const;

export const ROLLBACK_ENTITIES: Readonly<Record<string, RollbackEntity>> = {
  project: {
    table: 'project',
    key: ['id'],
    domain: PROJECT_DOMAIN,
    revision: true,
    deletable: true,
    restorable: PROJECT_DOMAIN,
    dependents: [
      ['access_grant', 'project_id'],
      ['credential', 'project_id'],
      ['source', 'project_id'],
      ['project_source', 'project_id'],
      ['project_package', 'project_id'],
      ['project_package_pattern', 'project_id'],
      ['customer_grant', 'project_id'],
      ['service_principal', 'project_id'],
      ['token', 'project_id'],
      ['token_project', 'project_id'],
      ['job', 'project_id'],
    ],
  },
  role: {
    table: 'role',
    key: ['id'],
    domain: ['key', 'name', 'scope', 'is_system', 'protects_last_holder'],
    revision: true,
    deletable: true,
    restorable: [],
    dependents: [['access_grant', 'role_id']],
    permissions: true,
  },
  source: {
    table: 'source',
    key: ['id'],
    domain: SOURCE_DOMAIN,
    revision: false,
    deletable: true,
    restorable: [],
    dependents: [
      ['registered_name', 'source_id'],
      ['package', 'source_id'],
      ['project_source', 'source_id'],
      ['project_package_pattern', 'source_id'],
      ['webhook_delivery', 'source_id'],
      ['ingest_session', 'source_id'],
    ],
  },
  registered_name: {
    table: 'registered_name',
    key: ['id'],
    domain: ['source_id', 'ecosystem', 'pattern'],
    revision: false,
    deletable: true,
    restorable: [],
    dependents: [],
  },
  project_source: {
    table: 'project_source',
    key: ['project_id', 'source_id'],
    domain: ['project_id', 'source_id', 'precedence'],
    revision: false,
    deletable: true,
    restorable: [],
    dependents: [],
  },
  access_grant: {
    table: 'access_grant',
    key: ['id'],
    domain: [
      'scope',
      'project_id',
      'role_id',
      'subject_type',
      'subject_value',
      'subject_provider',
      'created_by',
    ],
    revision: true,
    deletable: true,
    restorable: [],
    dependents: [],
  },
  version: {
    table: 'version',
    key: ['id'],
    domain: ['blob_id', 'published_at', 'status', 'metadata_json'],
    revision: true,
    deletable: false,
    restorable: ['blob_id', 'published_at', 'status', 'metadata_json', 'published_at_basis'],
    dependents: [],
  },
};

function entityOf(type: string): RollbackEntity | null {
  return Object.hasOwn(ROLLBACK_ENTITIES, type) ? (ROLLBACK_ENTITIES[type] ?? null) : null;
}

function identity(entity: RollbackEntity, entityId: string): string[] | null {
  const parts = entity.key.length === 1 ? [entityId] : entityId.split(':');
  return parts.length === entity.key.length && parts.every((part) => part !== '') ? parts : null;
}

function statement(text: string, ...params: SqlValue[]): Statement {
  return { sql: text, params };
}

function scalarValue(value: ImportRollbackDomainValue | undefined): SqlValue | undefined {
  return value === undefined || Array.isArray(value) ? undefined : (value as SqlValue);
}

function dependentsAbsent(entity: RollbackEntity, owner: string): string {
  return entity.dependents
    .map(
      ([table, column]) =>
        ` AND NOT EXISTS (SELECT 1 FROM ${table} AS rbdep WHERE rbdep.${column} = ${owner}.id)`,
    )
    .join('');
}

function referencedColumn(entity: RollbackEntity): string {
  return entity.dependents.length === 0
    ? '0'
    : `(${entity.dependents
        .map(
          ([table, column]) =>
            `EXISTS (SELECT 1 FROM ${table} AS rbdep WHERE rbdep.${column} = rblive.id)`,
        )
        .join(' OR ')})`;
}

function guardClause(
  entity: RollbackEntity,
  guard: ImportRollbackGuard,
): { sql: string; params: SqlValue[] } | null {
  if (guard.kind === 'revision') {
    if (!entity.revision || !Number.isSafeInteger(guard.revision)) return null;
    return { sql: 'rbent.revision = ?', params: [guard.revision] };
  }
  if (entity.revision) return null;
  const keys = Object.keys(guard.values).sort();
  if (keys.join() !== [...entity.domain].sort().join()) return null;
  const params: SqlValue[] = [];
  for (const column of entity.domain) {
    const value = scalarValue(guard.values[column]);
    if (value === undefined) return null;
    params.push(value);
  }
  return { sql: entity.domain.map((column) => `rbent.${column} IS ?`).join(' AND '), params };
}

export function createImportRollbackStore(options: {
  readonly executor: SqlExecutor;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}): ImportRollbackStore {
  const { executor } = options;
  const anchors = [...options.providerAnchors];
  const journal = createImportJournalStore(options);

  function allowed(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    runId: string,
    approvedBy: string | null,
  ): Guard {
    const permission = (userId: string, alias: string): Guard => {
      const rows = permissionRows(ctx, userId, null, anchors, {
        localAdmin: sql<SqlBool>`1`,
      }).as(alias);
      return sql<SqlBool>`exists (select 1 from ${rows} where ${sql.ref(`${alias}.permission`)} = 'org:import:approve')`;
    };
    const approver =
      approvedBy === null
        ? sql<SqlBool>`1 = 1`
        : sql<SqlBool>`rbrun.approved_by_user_id = ${approvedBy}`;
    const checks =
      approvedBy === null
        ? sql<SqlBool>`1 = 1`
        : sql<SqlBool>`${permission(fence.approverUserId, 'rbrequester')} and ${permission(approvedBy, 'rbapprover')}`;
    return sql<SqlBool>`(${fence.runId === runId ? 1 : 0} = 1 and exists (
      select 1 from import_run as rbrun join job as rbjob on rbjob.id = ${fence.job.id} and rbjob.org_id = ${ctx.orgId}
      where rbrun.org_id = ${ctx.orgId} and rbrun.id = ${runId}
        and rbrun.state in ${sql.raw(RUN_STATES)} and ${approver}
        and rbjob.type = ${IMPORT_RUN_JOB.rollback}
        and rbjob.resource_key = ${IMPORT_RUN_JOB.resourceKey(runId)}
        and json_extract(rbjob.payload_json, '$.runId') = rbrun.id
        and json_extract(rbjob.payload_json, '$.requestedBy') = ${fence.approverUserId})
      and ${checks})`;
  }

  interface Planned {
    readonly statements: readonly Statement[];
    readonly decided: number | null;
    readonly fixed: ImportRollbackOutcome | null;
  }

  function conflictMark(ctx: OrgContext, runId: string, refId: string): Statement {
    return statement(
      `UPDATE import_ref AS rbmark SET conflict_state = 'changed_after_import'
       WHERE rbmark.org_id = ? AND rbmark.id = ? AND rbmark.import_run_id = ?
         AND rbmark.rolled_back_at IS NULL AND rbmark.expired_at IS NULL
         AND rbmark.conflict_state IN ('none', 'resolved')`,
      ctx.orgId,
      refId,
      runId,
    );
  }

  function plan(
    ctx: OrgContext,
    runId: string,
    now: string,
    action: ImportRollbackAction,
  ): Planned {
    const downgrade: Planned = {
      statements: [conflictMark(ctx, runId, action.refId)],
      decided: null,
      fixed: 'conflict',
    };
    if (action.kind === 'conflict') return downgrade;
    if (action.kind === 'expired') {
      return {
        statements: [
          statement(
            `UPDATE import_ref AS rbmark SET expired_at = COALESCE(rbmark.expired_at, ?)
             WHERE rbmark.org_id = ? AND rbmark.id = ? AND rbmark.import_run_id = ?
               AND rbmark.rolled_back_at IS NULL AND rbmark.conflict_state IN ('none', 'resolved')
               AND EXISTS (SELECT 1 FROM import_run AS rbexp WHERE rbexp.org_id = rbmark.org_id AND rbexp.id = rbmark.import_run_id
                 AND ((rbexp.before_image_expires_at IS NULL AND rbexp.state = 'verified')
                   OR (rbexp.before_image_expires_at IS NOT NULL AND unixepoch(rbexp.before_image_expires_at, 'subsec') IS NULL)
                   OR unixepoch(rbexp.before_image_expires_at, 'subsec') <= unixepoch(?, 'subsec')))
             RETURNING id`,
            now,
            ctx.orgId,
            action.refId,
            runId,
            now,
          ),
          conflictMark(ctx, runId, action.refId),
        ],
        decided: 0,
        fixed: null,
      };
    }

    const entity = entityOf(action.entityType);
    const ids = entity === null ? null : identity(entity, action.entityId);
    if (entity === null || ids === null) return downgrade;
    const guard = guardClause(entity, action.guard);
    if (guard === null) return downgrade;
    const restore = action.kind === 'restore';
    if (!restore && !entity.deletable) return downgrade;
    const columns = restore ? Object.keys(action.domain).sort() : [];
    if (restore && (columns.length === 0 || columns.some((c) => !entity.restorable.includes(c))))
      return downgrade;
    const values: SqlValue[] = [];
    for (const column of columns) {
      const value = scalarValue(restore ? action.domain[column] : undefined);
      if (value === undefined) return downgrade;
      values.push(value);
    }
    if (
      restore &&
      entity.table === 'version' &&
      !BASES.has(scalarValue(action.domain['published_at_basis']))
    )
      return downgrade;
    const restoredBlob = restore && columns.includes('blob_id');
    const blobIndex = columns.indexOf('blob_id');
    const lease = blobLeaseNotLive(ctx, 'rbtarget');
    const where = (alias: string): string =>
      entity.key.map((column) => `${alias}.${column} = ?`).join(' AND ');
    const unqualified = entity.key.map((column) => `${column} = ?`).join(' AND ');
    const extra =
      (restore ? '' : dependentsAbsent(entity, 'rbent')) +
      (!restore && entity.table === 'access_grant'
        ? ' AND NOT EXISTS (SELECT 1 FROM role AS rbprotected WHERE rbprotected.id = rbent.role_id AND rbprotected.org_id = rbent.org_id AND rbprotected.protects_last_holder = 1)'
        : '') +
      (restore && entity.table === 'version'
        ? ' AND rbent.published_at_basis IS rbmark.published_at_basis'
        : '') +
      (restoredBlob
        ? ` AND EXISTS (SELECT 1 FROM (SELECT ? AS blob_id) AS rbtarget WHERE (rbtarget.blob_id IS rbent.blob_id OR rbtarget.blob_id IS NULL OR EXISTS (SELECT 1 FROM blob AS rbblob WHERE rbblob.org_id = ? AND rbblob.id = rbtarget.blob_id)) AND (rbtarget.blob_id IS rbent.blob_id OR ${lease.sql}))`
        : '');
    const extraParams: SqlValue[] = restoredBlob
      ? [values[blobIndex] ?? null, ctx.orgId, ...(lease.params as SqlValue[])]
      : [];
    const done = {
      sql: 'EXISTS (SELECT 1 FROM import_ref AS rbdone WHERE rbdone.org_id = ? AND rbdone.id = ? AND rbdone.import_run_id = ? AND rbdone.rolled_back_at = ?)',
      params: [ctx.orgId, action.refId, runId, now] as SqlValue[],
    };
    const marker = statement(
      `UPDATE import_ref AS rbmark SET rolled_back_at = ?
       WHERE rbmark.org_id = ? AND rbmark.id = ? AND rbmark.import_run_id = ?
         AND rbmark.entity_type = ? AND rbmark.entity_id = ? AND rbmark.action = ?
         AND rbmark.rolled_back_at IS NULL AND rbmark.expired_at IS NULL
         AND rbmark.conflict_state IN ('none', 'resolved')
         AND EXISTS (SELECT 1 FROM ${entity.table} AS rbent
           WHERE rbent.org_id = ? AND ${where('rbent')} AND ${guard.sql}${extra})
       RETURNING id`,
      now,
      ctx.orgId,
      action.refId,
      runId,
      action.entityType,
      action.entityId,
      restore ? 'update' : 'create',
      ctx.orgId,
      ...ids,
      ...guard.params,
      ...extraParams,
    );
    const mutations: Statement[] = [];
    if (restore) {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      const bump = entity.revision
        ? ', revision = revision + 1, updated_at = ?, last_op_id = ?'
        : '';
      if (entity.table === 'version') {
        mutations.push(
          statement(
            `INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason, op_id, created_at)
             SELECT ?, rbver.org_id, rbver.id, rbver.revision, rbver.blob_id, rbver.source_ref, rbver.metadata_json, 'import_rollback', ?, ?
             FROM version AS rbver WHERE rbver.org_id = ? AND rbver.id = ? AND ${done.sql}`,
            ulid(),
            runId,
            now,
            ctx.orgId,
            action.entityId,
            ...done.params,
          ),
        );
      }
      mutations.push(
        statement(
          `UPDATE ${entity.table} SET ${assignments}${bump} WHERE org_id = ? AND ${unqualified} AND ${done.sql}`,
          ...values,
          ...(entity.revision ? [now, runId] : []),
          ctx.orgId,
          ...ids,
          ...done.params,
        ),
      );
      if (entity.table === 'version') {
        mutations.push(
          compile(
            db
              .updateTable('package')
              .set({ rev: sql<number>`package.rev + 1`, modified_at: monotonicNow })
              .where(
                'package.id',
                '=',
                db
                  .selectFrom('version')
                  .select('package_id')
                  .where('version.org_id', '=', ctx.orgId)
                  .where('version.id', '=', action.entityId),
              )
              .where('package.org_id', '=', ctx.orgId)
              .where(
                sql<SqlBool>`exists (select 1 from import_ref as rbdone where rbdone.org_id = ${ctx.orgId}
                  and rbdone.id = ${action.refId} and rbdone.import_run_id = ${runId} and rbdone.rolled_back_at = ${now})`,
              ),
          ),
        );
      }
    } else {
      if (entity.table === 'role') {
        mutations.push(
          statement(
            `DELETE FROM role_permission WHERE org_id = ? AND role_id = ? AND ${done.sql}`,
            ctx.orgId,
            action.entityId,
            ...done.params,
          ),
        );
      }
      if (entity.table === 'access_grant') {
        mutations.push(patInvalidationStatement(ctx, action.entityId, done));
      }
      mutations.push(
        statement(
          `DELETE FROM ${entity.table} WHERE org_id = ? AND ${unqualified} AND ${done.sql}`,
          ctx.orgId,
          ...ids,
          ...done.params,
        ),
      );
      if (entity.table === 'project_source') {
        mutations.push(
          ...rederiveStatements(ctx, {
            kind: 'projectSource',
            projectId: ids[0]!,
            sourceId: ids[1]!,
          }),
        );
      }
    }
    mutations.push(
      auditPendingStatement(ctx, action.audit, done),
      conflictMark(ctx, runId, action.refId),
    );
    return { statements: [marker, ...mutations], decided: 0, fixed: null };
  }

  return {
    loadRun: (ctx, runId) => journal.loadRun(ctx, runId),
    rollbackRefs: (ctx, runId) => journal.rollbackRefs(ctx, runId),

    async liveStates(ctx, targets) {
      const states: ImportRollbackLiveState[] = targets.map(() => ({
        exists: false,
        contentHash: null,
        referenced: false,
        guard: null,
      }));
      const byType = new Map<string, number[]>();
      targets.forEach((target, index) => {
        byType.set(target.entityType, [...(byType.get(target.entityType) ?? []), index]);
      });
      for (const [type, indexes] of byType) {
        const entity = entityOf(type);
        if (entity === null) continue;
        for (let offset = 0; offset < indexes.length; offset += LOOKUP_CHUNK) {
          const slice = indexes.slice(offset, offset + LOOKUP_CHUNK);
          const wanted = new Map<string, number[]>();
          for (const index of slice) {
            const parts = identity(entity, targets[index]!.entityId);
            if (parts === null) continue;
            const key = parts.join('\u0000');
            wanted.set(key, [...(wanted.get(key) ?? []), index]);
          }
          if (wanted.size === 0) continue;
          const keys = [...wanted.keys()].map((key) => key.split('\u0000'));
          const match =
            entity.key.length === 1
              ? `rblive.${entity.key[0]!} IN (${keys.map(() => '?').join(', ')})`
              : `(${entity.key.map((c) => `rblive.${c}`).join(', ')}) IN (VALUES ${keys.map(() => `(${entity.key.map(() => '?').join(', ')})`).join(', ')})`;
          const selected = [
            ...new Set([...entity.key, ...(entity.revision ? ['revision'] : []), ...entity.domain]),
          ]
            .map((column) => `rblive.${column} AS ${column}`)
            .join(', ');
          const permissions =
            entity.permissions === true
              ? ', (SELECT json_group_array(rbperm.permission) FROM role_permission AS rbperm WHERE rbperm.role_id = rblive.id AND rbperm.org_id = rblive.org_id) AS permissions'
              : '';
          const found = await executor.all<Row>(
            statement(
              `SELECT ${selected}, ${referencedColumn(entity)} AS referenced${permissions}
               FROM ${entity.table} AS rblive WHERE rblive.org_id = ? AND ${match}`,
              ctx.orgId,
              ...keys.flat(),
            ),
          );
          for (const row of found) {
            const key = entity.key.map((column) => String(row[column])).join('\u0000');
            const domain: Record<string, SqlValue | readonly string[]> = {};
            const values: Record<string, ImportRollbackDomainValue> = {};
            for (const column of entity.domain) {
              domain[column] = row[column] as SqlValue;
              values[column] = row[column] as ImportRollbackDomainValue;
            }
            if (entity.permissions === true) {
              domain.permissions = (JSON.parse(String(row.permissions ?? '[]')) as string[]).sort();
            }
            const live: ImportRollbackLiveState = {
              exists: true,
              contentHash: await hash(domain),
              referenced: Number(row.referenced) !== 0,
              guard: entity.revision
                ? { kind: 'revision', revision: Number(row.revision) }
                : { kind: 'domain', values },
            };
            for (const index of wanted.get(key) ?? []) states[index] = live;
          }
        }
      }
      return states;
    },

    async applyChunk(ctx, fence, input) {
      instant(input.now);
      if (fenceKind(fence) !== 'delegated')
        throw new TypeError('import rollback requires a delegated fence');
      const now = input.now;
      const planned: Planned[] = [];
      if (new Set(input.actions.map((action) => action.refId)).size !== input.actions.length)
        return { ok: false, reason: 'conflict' };
      for (const action of input.actions) {
        if (
          (action.kind === 'restore' || action.kind === 'delete') &&
          action.guard.kind === 'revision' &&
          fence.expected[action.entityId] !== action.guard.revision
        )
          return { ok: false, reason: 'conflict' };
        planned.push(plan(ctx, input.runId, now, action));
      }
      const condition = allowed(ctx, fence, input.runId, input.approvedByUserId);
      const guard = assertGuard(condition, ctx);
      const mutations: Statement[] = [
        ...jobLeaseGuard(ctx, fence.job),
        ...planned.flatMap((entry) => entry.statements),
      ];
      if (!withinBatchBudget([...guard, ...mutations])) return { ok: false, reason: 'too_large' };
      const outcome = await runFenced(executor, fence, guard, mutations, {
        authority: compile(
          db.selectNoFrom(sql<number>`case when ${condition} then 0 else 1 end`.as('denied')),
        ),
      });
      if (!outcome.ok)
        return { ok: false, reason: outcome.reason === 'authority' ? 'guard' : 'conflict' };
      let cursor = guard.length + jobLeaseGuard(ctx, fence.job).length;
      const outcomes: ImportRollbackOutcome[] = [];
      for (const [index, entry] of planned.entries()) {
        const action = input.actions[index]!;
        const decided =
          entry.decided === null ? null : outcome.results[cursor + entry.decided]?.rows.length;
        cursor += entry.statements.length;
        if (entry.fixed !== null) outcomes.push(entry.fixed);
        else if (decided === 1) outcomes.push(action.kind === 'expired' ? 'expired' : 'restored');
        else outcomes.push('conflict');
      }
      return { ok: true, outcomes };
    },

    async finish(ctx, fence, input) {
      instant(input.now);
      if (fenceKind(fence) !== 'delegated')
        throw new TypeError('import rollback requires a delegated fence');
      const { restored, conflict, expired } = input.counts;
      for (const value of [restored, conflict, expired]) {
        if (!Number.isSafeInteger(value) || value < 0)
          throw new RangeError('rollback counts must be non-negative integers');
      }
      const condition = allowed(ctx, fence, input.runId, null);
      const update =
        input.outcome === 'rolled_back'
          ? statement(
              `UPDATE import_run SET state = 'rolled_back', last_error = NULL,
                 rollback_restored_count = ?, rollback_conflict_count = ?, rollback_expired_count = ?, updated_at = ?
               WHERE org_id = ? AND id = ? AND state IN ${RUN_STATES}`,
              restored,
              conflict,
              expired,
              input.now,
              ctx.orgId,
              input.runId,
            )
          : statement(
              `UPDATE import_run SET last_error = ?, updated_at = ?
               WHERE org_id = ? AND id = ? AND state IN ${RUN_STATES}`,
              input.outcome.failed,
              input.now,
              ctx.orgId,
              input.runId,
            );
      const guard = assertGuard(condition, ctx);
      const mutations = [
        ...jobLeaseGuard(ctx, fence.job),
        update,
        ...input.audits.map((audit) => auditPendingStatement(ctx, audit)),
      ];
      if (!withinBatchBudget([...guard, ...mutations]))
        throw new RangeError('import rollback finish exceeds the batch budget');
      const result = await runFenced(executor, fence, guard, mutations, {});
      if (!result.ok) throw new Error('import rollback finish refused');
    },
  };
}
