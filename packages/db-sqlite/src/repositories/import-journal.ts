import { sql, type SqlBool } from 'kysely';
import {
  fenceKind,
  runFenced,
  type DelegatedMutationFence,
  type FencedOutcome,
  type SystemMutationFence,
} from '@package-broker/core/authz/fence';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { auditEvent, type AuditEventInput } from '@package-broker/core/audit/actions';
import {
  D1_STATEMENTS_PER_BATCH,
  type OrgContext,
  type SqlExecutor,
  type SqlValue,
  type Statement,
} from '@package-broker/core/db/port';
import type {
  ImportApplyItem,
  ImportApplyRun,
  ImportApplyStore,
} from '@package-broker/core/import/apply';
import { IMPORT_RUN_JOB, IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
import { parseSha256 } from '@package-broker/core/platform/blob';
import { ulid } from '@package-broker/core/ids';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { permissionRows } from './access.js';
import { auditPendingStatement } from './audit-pending.js';
import { blobLeaseNotLive } from './blob-lease-guard.js';
import { jobLeaseGuard } from './job-lease-guard.js';
import { rederiveStatements } from './visibility-derive.js';
import { monotonicNow } from '../internal/catalogue-write-guard.js';

const ENTITY = {
  project: 'project',
  role: 'role',
  source: 'source',
  name: 'registered_name',
  attachment: 'project_source',
  grant: 'access_grant',
  version_override: 'version',
} as const;
const SESSION_ONLY = PERMISSIONS.filter((p) => p.sessionOnly).map((p) => p.name);
const VERSION_DOMAIN = ['blob_id', 'published_at', 'status', 'metadata_json'] as const;
const MAX_STATEMENT_PARAMETERS = 100;
const MAX_STATEMENT_SQL_BYTES = 100_000;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const ENCODER = new TextEncoder();
export { IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
type Row = Record<string, SqlValue>;
type Chunk = Parameters<ImportApplyStore['applyChunk']>[2];
type ProjectRef = NonNullable<Extract<ImportApplyItem, { type: 'source' }>['project']>;
type SourceRef = Extract<ImportApplyItem, { type: 'name' }>['source'];

export interface ImportRollbackRef {
  readonly id: string;
  readonly runId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly externalRef: string;
  readonly action: 'create' | 'update';
  readonly beforeImageJson: string | null;
  readonly contentHash: string | null;
  readonly publishedAtBasis: 'source_release' | 'packagist_added' | 'import_time' | null;
  readonly beforeImageExpiresAt: string | null;
  readonly conflictState: 'none' | 'changed_after_import' | 'resolved';
  readonly rolledBackAt: string | null;
}

export interface ImportJournalStore extends ImportApplyStore {
  /** Trusted rollback job only; these images must never be included in ordinary run responses. */
  rollbackRefs(ctx: OrgContext, runId: string): Promise<readonly ImportRollbackRef[]>;
  markVerified(
    ctx: OrgContext,
    fence: SystemMutationFence,
    input: { readonly runId: string; readonly verifiedAt: string; readonly expectedEpoch: string },
  ): Promise<FencedOutcome>;
}

function statement(text: string, ...params: SqlValue[]): Statement {
  return { sql: text, params };
}
function bound(query: Statement): Guard {
  const parts = query.sql.split('?');
  return sql<SqlBool>`${sql.join(
    parts.flatMap((part, index) =>
      index < query.params.length ? [sql.raw(part), sql`${query.params[index]}`] : [sql.raw(part)],
    ),
    sql``,
  )}`;
}
function check(query: Statement): readonly Statement[] {
  return assertCheck(bound(query));
}
export function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new TypeError('invalid import timestamp');
  return time;
}
export async function hash(
  domain: Readonly<Record<string, SqlValue | readonly string[]>>,
): Promise<string> {
  const sorted = Object.fromEntries(
    Object.keys(domain)
      .sort()
      .map((key) => [key, domain[key]]),
  );
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(sorted)),
  );
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}
export function withinBatchBudget(statements: readonly Statement[]): boolean {
  if (statements.length > D1_STATEMENTS_PER_BATCH) return false;
  let bytes = 0;
  for (const statement of statements) {
    const sqlBytes = ENCODER.encode(statement.sql).byteLength;
    if (statement.params.length > MAX_STATEMENT_PARAMETERS || sqlBytes > MAX_STATEMENT_SQL_BYTES)
      return false;
    bytes += sqlBytes;
    for (const value of statement.params) {
      bytes +=
        typeof value === 'string'
          ? ENCODER.encode(value).byteLength
          : value instanceof Uint8Array
            ? value.byteLength
            : value === null
              ? 0
              : 8;
    }
    if (bytes > MAX_BATCH_BYTES) return false;
  }
  return true;
}
function runStateAudit(
  ctx: OrgContext,
  runId: string,
  now: string,
  state: 'applied' | 'failed' | 'verified',
  actor: AuditEventInput['actor'],
): Statement {
  const id = ulid();
  const audit = auditEvent({
    id,
    now,
    action:
      state === 'verified'
        ? 'import_run.verify'
        : state === 'failed'
          ? 'import_run.fail'
          : 'import_run.apply',
    actor,
    target: { type: 'import_run', id: runId },
    changes: { state: { old: state === 'verified' ? 'verifying' : 'applying', new: state } },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
  });
  if (!audit.ok) throw new TypeError('invalid import audit');
  return auditPendingStatement(ctx, audit.event);
}
class Conflict extends Error {}

export function createImportJournalStore(options: {
  readonly executor: SqlExecutor;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}): ImportJournalStore {
  const { executor } = options;
  const anchors = [...options.providerAnchors];
  const read = async (query: Statement): Promise<Row> => {
    const rows = await executor.all<Row>(query);
    if (rows.length !== 1 || rows[0] === undefined) throw new Conflict();
    return rows[0];
  };
  function runGuard(ctx: OrgContext, fence: DelegatedMutationFence, runId: string): Guard {
    if (fenceKind(fence) !== 'delegated')
      throw new TypeError('import apply requires a delegated fence');
    return sql<SqlBool>`${fence.runId === runId ? 1 : 0} = 1 and exists (
      select 1 from import_run ijr join job ijj on ijj.org_id = ijr.org_id
      where ijr.org_id = ${ctx.orgId} and ijr.id = ${runId} and ijr.state = 'applying'
      and ijj.id = ${fence.job.id} and ijj.lease_owner = ${fence.job.owner}
      and ijj.fence = ${fence.job.fence} and ijj.state = 'running'
      and ijj.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') and ijj.type = ${IMPORT_RUN_JOB.apply}
      and ijj.resource_key = ${IMPORT_RUN_JOB.resourceKey(runId)}
      and json_extract(ijj.payload_json, '$.runId') = ijr.id)`;
  }
  function approval(ctx: OrgContext, fence: DelegatedMutationFence, runId: string): Guard {
    // Delegation outlives the approving session; recheck usable local authority in the batch.
    const permissions = permissionRows(ctx, fence.approverUserId, null, anchors, {
      localAdmin: sql<SqlBool>`1`,
    }).as('ijpermissions');
    const held = sql<SqlBool>`exists (select 1 from ${permissions}
      where ijpermissions.permission = 'org:import:approve')`;
    return sql<SqlBool>`${held} and exists (select 1 from import_run ija
      where ija.org_id = ${ctx.orgId} and ija.id = ${runId}
      and ija.approved_by_user_id = ${fence.approverUserId}
      and unixepoch(ija.approved_at, 'subsec') <= unixepoch('now', 'subsec') + 60
      and ija.before_image_expires_at is null)`;
  }

  async function apply(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    input: Chunk,
  ): Promise<{ ok: true } | { ok: false; reason: 'guard' | 'conflict' }> {
    instant(input.now);
    if (
      input.items.length > 50 ||
      input.items.length !== input.audits.length ||
      input.items.length !== input.auditProjects.length
    )
      return { ok: false, reason: 'conflict' };
    const allowed = sql<SqlBool>`(${runGuard(ctx, fence, input.runId)} and ${approval(ctx, fence, input.runId)})`;
    const mutations: Statement[] = [...jobLeaseGuard(ctx, fence.job)];
    const resolved = new Map<string, Row>();
    let count = 0;
    async function lookup(
      table: 'project' | 'role' | 'source',
      reference: { readonly ref: string } | { readonly existing: string },
    ): Promise<Row> {
      if ('ref' in reference) {
        const key = `${table}:${reference.ref}`;
        const planned = resolved.get(key);
        if (planned !== undefined) return planned;
        const row = await read(
          statement(
            `SELECT e.id${table === 'source' ? ', e.project_id' : ''} FROM ${table} e JOIN import_ref ijref ON ijref.entity_id = e.id AND ijref.org_id = e.org_id WHERE ijref.org_id = ? AND ijref.import_run_id = ? AND ijref.entity_type = ? AND ijref.external_ref = ?${table === 'project' ? " AND e.status = 'active'" : ''}`,
            ctx.orgId,
            input.runId,
            table,
            reference.ref,
          ),
        );
        mutations.push(
          ...check(
            statement(
              `exists (SELECT 1 FROM ${table} WHERE org_id = ? AND id = ?${table === 'project' ? " AND status = 'active'" : ''})`,
              ctx.orgId,
              row.id!,
            ),
          ),
        );
        return row;
      }
      const column = table === 'project' ? 'slug' : table === 'role' ? 'key' : 'name';
      const query = statement(
        `SELECT id${table === 'role' ? ', scope' : ''} FROM ${table} WHERE org_id = ? AND ${column} = ?${table === 'project' ? " AND status = 'active'" : ''}`,
        ctx.orgId,
        reference.existing,
      );
      const row = await read(query);
      mutations.push(
        ...check(
          statement(
            `exists (SELECT 1 FROM ${table} WHERE org_id = ? AND id = ? AND ${column} = ?${table === 'project' ? " AND status = 'active'" : ''})`,
            ctx.orgId,
            row.id!,
            reference.existing,
          ),
        ),
      );
      return row;
    }
    async function source(reference: SourceRef): Promise<Row> {
      if ('ref' in reference) return lookup('source', reference);
      const project =
        reference.existing.project === null
          ? null
          : (await lookup('project', { existing: reference.existing.project })).id!;
      const row = await read(
        statement(
          'SELECT id, project_id, ecosystem FROM source WHERE org_id = ? AND project_id IS ? AND name = ?',
          ctx.orgId,
          project,
          reference.existing.name,
        ),
      );
      mutations.push(
        ...check(
          statement(
            'exists (SELECT 1 FROM source WHERE org_id = ? AND id = ? AND project_id IS ? AND name = ?)',
            ctx.orgId,
            row.id!,
            project,
            reference.existing.name,
          ),
        ),
      );
      return row;
    }
    const projectId = async (reference: ProjectRef | null): Promise<SqlValue> =>
      reference === null ? null : (await lookup('project', reference)).id!;
    try {
      const applied = new Set(await store.appliedRefs(ctx, input.runId));
      for (const [index, item] of input.items.entries()) {
        const key = `${item.type}:${item.external_ref}`;
        if (applied.has(key)) continue;
        applied.add(key);
        const id = ulid();
        let entityId: SqlValue = id;
        let table: string = ENTITY[item.type];
        let domain: Row;
        let before: Row | null = null;
        let beforeImage: Row | null = null;
        let versionRevision: SqlValue | undefined;
        const additional: Statement[] = [];
        switch (item.type) {
          case 'project':
            domain = {
              slug: item.slug,
              name: item.name,
              status: 'active',
              token_max_scope: 'full',
              require_publish_approval: 0,
            };
            break;
          case 'role': {
            domain = {
              key: item.key,
              name: item.name,
              scope: item.scope,
              is_system: 0,
              protects_last_holder: 0,
            };
            const permissions = [...new Set(item.permissions)].sort();
            const perStatement = Math.floor(MAX_STATEMENT_PARAMETERS / 3);
            for (let offset = 0; offset < permissions.length; offset += perStatement) {
              const chunk = permissions.slice(offset, offset + perStatement);
              additional.push(
                statement(
                  `INSERT INTO role_permission (org_id, role_id, permission) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
                  ...chunk.flatMap((permission) => [ctx.orgId, id, permission]),
                ),
              );
            }
            break;
          }
          case 'source':
            domain = {
              name: item.name,
              ecosystem: item.ecosystem,
              type: item.source_type,
              project_id: await projectId(item.project),
              url: item.url,
              config_json: JSON.stringify(item.config),
              status: 'paused',
              credential_id: null,
              protocol_mode: null,
              has_available_packages: 0,
              user_agent: null,
              default_visible_to_new_projects: 1,
              removal_policy: 'flag',
              retention_days_override: null,
              poll_interval_seconds: 86400,
              next_poll_at: null,
              last_polled_at: null,
              last_success_at: null,
              poll_etag: null,
              poll_last_modified: null,
              root_hash: null,
              listing_hash: null,
              consecutive_failures: 0,
              last_error: null,
              listing_open_stamp: null,
              listing_opened_at: null,
            };
            break;
          case 'name': {
            const owner = await source(item.source);
            domain = { source_id: owner.id!, ecosystem: item.ecosystem, pattern: item.pattern };
            mutations.push(
              ...check(
                statement(
                  'exists (SELECT 1 FROM source WHERE org_id = ? AND id = ? AND ecosystem = ?)',
                  ctx.orgId,
                  owner.id!,
                  item.ecosystem,
                ),
              ),
            );
            break;
          }
          case 'attachment': {
            const project = await projectId(item.project);
            const owner = await source(item.source);
            if (owner.project_id !== null && owner.project_id !== project) throw new Conflict();
            domain = { project_id: project, source_id: owner.id!, precedence: item.precedence };
            entityId = `${String(project)}:${String(owner.id)}`;
            additional.push(
              ...rederiveStatements(ctx, {
                kind: 'projectSource',
                projectId: String(project),
                sourceId: String(owner.id),
              }),
            );
            break;
          }
          case 'grant': {
            const role = await lookup('role', item.role);
            const project = await projectId(item.project);
            if ((item.scope === 'organization') !== (project === null)) throw new Conflict();
            domain = {
              scope: item.scope,
              project_id: project,
              role_id: role.id!,
              subject_type: item.subject.type,
              subject_value: item.subject.value,
              subject_provider: item.subject.type === 'group' ? item.subject.provider : null,
              created_by: null,
            };
            mutations.push(
              ...check(
                statement(
                  'exists (SELECT 1 FROM role WHERE org_id = ? AND id = ? AND scope = ?)',
                  ctx.orgId,
                  role.id!,
                  item.scope,
                ),
              ),
            );
            if (!input.widening.includes(item.external_ref))
              mutations.push(
                ...check(
                  statement(
                    `not exists (SELECT 1 FROM role_permission WHERE org_id = ? AND role_id = ? AND permission IN (${SESSION_ONLY.map(() => '?').join(', ')}))`,
                    ctx.orgId,
                    role.id!,
                    ...SESSION_ONLY,
                  ),
                ),
              );
            break;
          }
          case 'version_override': {
            const owner = await source(item.source);
            const row = await read(
              statement(
                'SELECT v.id, v.revision, v.blob_id, v.published_at, v.status, v.metadata_json, v.published_at_basis FROM version v JOIN package p ON p.id = v.package_id AND p.org_id = v.org_id WHERE v.org_id = ? AND p.source_id = ? AND p.name = ? AND v.version = ?',
                ctx.orgId,
                owner.id!,
                item.package,
                item.version,
              ),
            );
            entityId = row.id!;
            versionRevision = row.revision;
            before = Object.fromEntries(VERSION_DOMAIN.map((column) => [column, row[column]!]));
            beforeImage = { ...before, published_at_basis: row.published_at_basis! };
            domain = { ...before, published_at: item.published_at };
            table = 'version';
            const expected = fence.expected[String(entityId)];
            if (expected !== undefined && expected !== versionRevision) throw new Conflict();
            const lease = blobLeaseNotLive(ctx, 'v');
            mutations.push(
              ...check(
                statement(
                  `exists (SELECT 1 FROM version v JOIN package p ON p.id = v.package_id AND p.org_id = v.org_id WHERE v.org_id = ? AND v.id = ? AND v.revision = ? AND p.source_id = ? AND p.name = ? AND v.version = ? AND ${VERSION_DOMAIN.map((column) => `v.${column} IS ?`).join(' AND ')} AND ${lease.sql})`,
                  ctx.orgId,
                  entityId,
                  versionRevision!,
                  owner.id!,
                  item.package,
                  item.version,
                  ...VERSION_DOMAIN.map((column) => row[column]!),
                  ...lease.params,
                ),
              ),
            );
            break;
          }
        }
        const journalId = ulid();
        const notDuplicate = statement(
          'not exists (SELECT 1 FROM import_ref WHERE org_id = ? AND import_run_id = ? AND entity_type = ? AND external_ref = ?)',
          ctx.orgId,
          input.runId,
          ENTITY[item.type],
          item.external_ref,
        );
        mutations.push(...check(notDuplicate));
        mutations.push(
          statement(
            'INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json, content_hash, published_at_basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            journalId,
            ctx.orgId,
            input.runId,
            ENTITY[item.type],
            entityId,
            item.external_ref,
            before === null ? 'create' : 'update',
            beforeImage === null ? null : JSON.stringify(beforeImage),
            await hash(
              item.type === 'role'
                ? { ...domain, permissions: [...new Set(item.permissions)].sort() }
                : domain,
            ),
            item.type === 'version_override' ? item.basis : null,
            input.now,
          ),
        );
        if (item.type === 'version_override') {
          mutations.push(
            statement(
              'INSERT INTO version_revision (id, org_id, version_id, revision, blob_id, source_ref, metadata_json, reason, op_id, created_at) SELECT ?, org_id, id, revision, blob_id, source_ref, metadata_json, ?, ?, ? FROM version WHERE org_id = ? AND id = ? AND revision = ?',
              ulid(),
              'import_published_at_override',
              input.runId,
              input.now,
              ctx.orgId,
              entityId,
              versionRevision!,
            ),
            statement(
              'UPDATE version SET published_at = ?, published_at_basis = ?, revision = revision + 1, last_op_id = ? WHERE org_id = ? AND id = ? AND revision = ?',
              item.published_at,
              item.basis,
              input.runId,
              ctx.orgId,
              entityId,
              versionRevision!,
            ),
            compile(
              db
                .updateTable('package')
                .set({ rev: sql<number>`package.rev + 1`, modified_at: monotonicNow })
                .where('package.org_id', '=', ctx.orgId)
                .where(
                  'package.id',
                  '=',
                  db
                    .selectFrom('version')
                    .select('package_id')
                    .where('org_id', '=', ctx.orgId)
                    .where('id', '=', String(entityId)),
                ),
            ),
          );
        } else {
          const values: Row = {
            ...(item.type === 'attachment' ? {} : { id }),
            org_id: ctx.orgId,
            ...domain,
          };
          const columns = Object.keys(values);
          mutations.push(
            statement(
              `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              ...Object.values(values),
            ),
            ...additional,
          );
          resolved.set(`${item.type}:${item.external_ref}`, { id: entityId, ...domain });
        }
        const project = input.auditProjects[index];
        if (project === undefined) throw new Conflict();
        const audit = input.audits[index];
        if (audit === undefined) throw new Conflict();
        mutations.push(
          auditPendingStatement(ctx, {
            ...audit,
            projectId: (await projectId(project)) as string | null,
            target: {
              ...audit.target,
              id: String(item.type === 'attachment' ? domain.source_id : entityId),
            },
          }),
        );
        count += 1;
      }
      mutations.push(
        statement(
          "UPDATE import_run SET applied_count = applied_count + ?, updated_at = ? WHERE org_id = ? AND id = ? AND state = 'applying'",
          count,
          input.now,
          ctx.orgId,
          input.runId,
        ),
      );
      const guard = assertGuard(allowed, ctx);
      if (!withinBatchBudget([...guard, ...mutations])) return { ok: false, reason: 'conflict' };
      const outcome = await runFenced(executor, fence, guard, mutations, {
        authority: compile(
          db.selectNoFrom(sql<number>`case when ${allowed} then 0 else 1 end`.as('denied')),
        ),
      });
      if (outcome.ok) return { ok: true };
      return { ok: false, reason: outcome.reason === 'authority' ? 'guard' : 'conflict' };
    } catch (error) {
      if (error instanceof Conflict) return { ok: false, reason: 'conflict' };
      throw error;
    }
  }

  const store: ImportJournalStore = {
    async loadRun(ctx, runId) {
      const [row] = await executor.all<{
        id: string;
        state: ImportApplyRun['state'];
        plan_hash: string | null;
        approved_at: string | null;
        approved_by_user_id: string | null;
        manifest_blob_sha256: string | null;
      }>(
        statement(
          'SELECT id, state, plan_hash, approved_at, approved_by_user_id, manifest_blob_sha256 FROM import_run ijload WHERE ijload.org_id = ? AND ijload.id = ?',
          ctx.orgId,
          runId,
        ),
      );
      return row === undefined
        ? null
        : {
            id: row.id,
            state: row.state,
            planHash: row.plan_hash,
            approvedAt: row.approved_at,
            approvedByUserId: row.approved_by_user_id,
            manifestBlobSha256:
              row.manifest_blob_sha256 === null ? null : parseSha256(row.manifest_blob_sha256),
          };
    },
    async appliedRefs(ctx, runId) {
      const rows = await executor.all<{ entity_type: string; external_ref: string }>(
        statement(
          'SELECT ijref.entity_type, ijref.external_ref FROM import_ref ijref JOIN import_run ijrun ON ijrun.id = ijref.import_run_id AND ijrun.org_id = ijref.org_id WHERE ijref.org_id = ? AND ijref.import_run_id = ?',
          ctx.orgId,
          runId,
        ),
      );
      return rows.map(
        (row) =>
          `${Object.entries(ENTITY).find(([, entity]) => entity === row.entity_type)?.[0] ?? row.entity_type}:${row.external_ref}`,
      );
    },
    async rolePermissions(ctx, roleId) {
      const rows = await executor.all<{ permission: string | null }>(
        statement(
          'SELECT p.permission FROM role r LEFT JOIN role_permission p ON p.role_id = r.id AND p.org_id = r.org_id WHERE r.org_id = ? AND r.key = ?',
          ctx.orgId,
          roleId,
        ),
      );
      return rows.length === 0
        ? null
        : rows.flatMap((row) => (row.permission === null ? [] : [row.permission]));
    },
    async rollbackRefs(ctx, runId) {
      return executor.all<ImportRollbackRef>(
        statement(
          `SELECT ijrollback.id, ijrollback.import_run_id AS runId,
          ijrollback.entity_type AS entityType, ijrollback.entity_id AS entityId,
          ijrollback.external_ref AS externalRef, ijrollback.action,
          ijrollback.before_image_json AS beforeImageJson, ijrollback.content_hash AS contentHash,
          ijrollback.published_at_basis AS publishedAtBasis,
          ijrollbackrun.before_image_expires_at AS beforeImageExpiresAt,
          ijrollback.conflict_state AS conflictState, ijrollback.rolled_back_at AS rolledBackAt
         FROM import_ref ijrollback JOIN import_run ijrollbackrun
          ON ijrollbackrun.id = ijrollback.import_run_id AND ijrollbackrun.org_id = ijrollback.org_id
         WHERE ijrollback.org_id = ? AND ijrollback.import_run_id = ?
         ORDER BY ijrollback.id`,
          ctx.orgId,
          runId,
        ),
      );
    },
    applyChunk: apply,
    async finish(ctx, fence, input) {
      instant(input.now);
      const state = input.outcome === 'applied' ? 'applied' : 'failed';
      const result = await runFenced(
        executor,
        fence,
        assertGuard(runGuard(ctx, fence, input.runId), ctx),
        [
          ...jobLeaseGuard(ctx, fence.job),
          statement(
            'UPDATE import_run SET state = ?, last_error = ?, updated_at = ? WHERE org_id = ? AND id = ?',
            state,
            input.outcome === 'applied' ? null : input.outcome.failed,
            input.now,
            ctx.orgId,
            input.runId,
          ),
          runStateAudit(ctx, input.runId, input.now, state, {
            type: 'user',
            id: fence.approverUserId,
          }),
        ],
        {},
      );
      if (!result.ok) throw new Error('import finish refused');
    },
    async markVerified(ctx, fence, input) {
      const verified = instant(input.verifiedAt);
      const expiry = new Date(verified + RETENTION_MS).toISOString();
      if (fenceKind(fence) !== 'system' || fence.writer !== 'verifier')
        throw new TypeError('import verification requires a verifier fence');
      const allowed = sql<SqlBool>`(exists (select 1 from import_run ijverified where ijverified.org_id = ${ctx.orgId} and ijverified.id = ${input.runId} and ijverified.state = 'verifying' and ijverified.before_image_expires_at is null)
        and abs(unixepoch(${input.verifiedAt}, 'subsec') - unixepoch('now', 'subsec')) <= 60
        and exists (select 1 from cache_epoch where cache_epoch.org_id = ${ctx.orgId} and cache_epoch.version = ${input.expectedEpoch})
        and not exists (select 1 from job ijbusy where ijbusy.org_id = ${ctx.orgId}
          and ijbusy.resource_key = ${IMPORT_RUN_JOB.resourceKey(input.runId)} and ijbusy.type = ${IMPORT_RUN_JOB.rollback} and ijbusy.state in ('queued', 'running'))
        and exists (select 1 from job where job.org_id = ${ctx.orgId} and job.id = ${fence.job.id}
          and job.type = ${IMPORT_VERIFICATION_JOB.type}
          and job.resource_key = ${IMPORT_VERIFICATION_JOB.resourceKey(input.runId)}
          and json_extract(job.payload_json, '$.runId') = ${input.runId}))`;
      return runFenced(
        executor,
        fence,
        assertGuard(allowed, ctx),
        [
          ...jobLeaseGuard(ctx, fence.job),
          statement(
            "UPDATE import_run SET state = 'verified', last_error = NULL, before_image_expires_at = ?, updated_at = ? WHERE org_id = ? AND id = ?",
            expiry,
            input.verifiedAt,
            ctx.orgId,
            input.runId,
          ),
          runStateAudit(ctx, input.runId, input.verifiedAt, 'verified', {
            type: 'system',
            id: null,
          }),
        ],
        {},
      );
    },
  };
  return store;
}
