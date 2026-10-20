import { sql, type SqlBool } from 'kysely';
import { auditEvent } from '@package-broker/core/audit/actions';
import { fenceKind, runFenced, type SystemMutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Manifest } from '@package-broker/core/import/manifest';
import { IMPORT_RUN_JOB, IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
import type {
  ImportVerificationFailure,
  ImportVerificationStore,
} from '@package-broker/core/import/verification';
import { assertGuard, type ProtectedHolderProvider } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { createImportJournalStore, hash, instant } from './import-journal.js';
import { ROLLBACK_ENTITIES } from './import-rollback.js';
import { jobLeaseGuard } from './job-lease-guard.js';

const ENTITY = {
  project: 'project',
  role: 'role',
  source: 'source',
  name: 'registered_name',
  attachment: 'project_source',
  grant: 'access_grant',
  version_override: 'version',
} as const;
type Row = Record<string, SqlValue>;
const statement = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });

export function createImportVerificationStore(options: {
  readonly executor: SqlExecutor;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}): ImportVerificationStore {
  const { executor } = options;
  const journal = createImportJournalStore(options);
  function allowed(ctx: OrgContext, fence: SystemMutationFence, runId: string) {
    if (fenceKind(fence) !== 'system' || fence.writer !== 'verifier')
      throw new TypeError('import verification requires a verifier fence');
    return sql<SqlBool>`(exists (select 1 from import_run ivrun
      where ivrun.org_id = ${ctx.orgId} and ivrun.id = ${runId}
        and ivrun.state = 'verifying' and ivrun.before_image_expires_at is null)
      and exists (select 1 from job ivjob where ivjob.org_id = ${ctx.orgId}
        and ivjob.id = ${fence.job.id} and ivjob.type = ${IMPORT_VERIFICATION_JOB.type}
        and ivjob.resource_key = ${IMPORT_VERIFICATION_JOB.resourceKey(runId)}
        and json_extract(ivjob.payload_json, '$.runId') = ${runId})
      and not exists (select 1 from job ivrollback where ivrollback.org_id = ${ctx.orgId}
        and ivrollback.resource_key = ${IMPORT_RUN_JOB.resourceKey(runId)}
        and ivrollback.state in ('queued', 'running')))`;
  }
  async function fail(
    ctx: OrgContext,
    fence: SystemMutationFence,
    input: {
      readonly runId: string;
      readonly reason: ImportVerificationFailure;
      readonly now: string;
    },
  ) {
    instant(input.now);
    const auditId = ulid();
    const audit = auditEvent({
      id: auditId,
      now: input.now,
      action: 'import_run.fail',
      actor: { type: 'system', id: null },
      target: { type: 'import_run', id: input.runId },
      changes: { state: { old: 'verifying', new: 'applied' }, reason: { new: input.reason } },
      context: { opId: auditId, requestId: auditId, sourceIp: null, tokenSelector: null },
    });
    if (!audit.ok) throw new TypeError('invalid import audit');
    return runFenced(
      executor,
      fence,
      assertGuard(allowed(ctx, fence, input.runId), ctx),
      [
        ...jobLeaseGuard(ctx, fence.job),
        statement(
          "UPDATE import_run SET state = 'applied', last_error = ?, updated_at = ? WHERE org_id = ? AND id = ?",
          input.reason,
          input.now,
          ctx.orgId,
          input.runId,
        ),
        auditPendingStatement(ctx, audit.event),
      ],
      {},
    );
  }
  function visibility(ctx: OrgContext, table: string): Statement {
    const parts: string[] = [];
    const params: SqlValue[] = [];
    if (table === 'project') parts.push("iventity.status = 'active'");
    if (['source', 'access_grant', 'project_source'].includes(table)) {
      parts.push(
        "(iventity.project_id IS NULL OR EXISTS (SELECT 1 FROM project ivproject WHERE ivproject.org_id = ? AND ivproject.id = iventity.project_id AND ivproject.status = 'active'))",
      );
      params.push(ctx.orgId);
    }
    if (table === 'access_grant') {
      parts.push(
        'EXISTS (SELECT 1 FROM role ivrole WHERE ivrole.org_id = ? AND ivrole.id = iventity.role_id AND ivrole.scope = iventity.scope)',
      );
      params.push(ctx.orgId);
    }
    if (table === 'registered_name' || table === 'project_source') {
      parts.push(
        "EXISTS (SELECT 1 FROM source ivsource LEFT JOIN project ivparent ON ivparent.id = ivsource.project_id AND ivparent.org_id = ivsource.org_id WHERE ivsource.org_id = ? AND ivsource.id = iventity.source_id AND ivsource.status IN ('active', 'paused') AND (ivsource.project_id IS NULL OR ivparent.status = 'active')" +
          (table === 'project_source'
            ? ' AND (ivsource.project_id IS NULL OR ivsource.project_id = iventity.project_id)'
            : '') +
          ')',
      );
      params.push(ctx.orgId);
    }
    if (table === 'version') {
      parts.push(
        "iventity.status = 'active' AND EXISTS (SELECT 1 FROM package ivpackage JOIN source ivsource ON ivsource.id = ivpackage.source_id AND ivsource.org_id = ivpackage.org_id LEFT JOIN project ivparent ON ivparent.id = ivsource.project_id AND ivparent.org_id = ivsource.org_id WHERE ivpackage.org_id = ? AND ivpackage.id = iventity.package_id AND ivsource.status IN ('active', 'paused') AND (ivsource.project_id IS NULL OR ivparent.status = 'active'))",
      );
      params.push(ctx.orgId);
    }
    return statement(parts.length === 0 ? '1' : parts.join(' AND '), ...params);
  }
  async function entities(
    ctx: OrgContext,
    refs: readonly { entityType: string; entityId: string }[],
  ) {
    const byType = new Map<string, string[]>();
    for (const ref of refs) {
      const ids = byType.get(ref.entityType) ?? [];
      ids.push(ref.entityId);
      byType.set(ref.entityType, ids);
    }
    const found = new Map<string, Row>();
    for (const [type, ids] of byType) {
      const entity = ROLLBACK_ENTITIES[type];
      if (entity === undefined) continue;
      const visible = visibility(ctx, type);
      const extra =
        type === 'source'
          ? ', EXISTS (SELECT 1 FROM credential ivcredential WHERE ivcredential.org_id = ? AND ivcredential.id = iventity.credential_id AND ivcredential.project_id IS iventity.project_id) AS iv_credential'
          : type === 'role'
            ? ', (SELECT json_group_array(ivpermission.permission) FROM role_permission ivpermission WHERE ivpermission.org_id = ? AND ivpermission.role_id = iventity.id) AS iv_permissions'
            : '';
      for (let offset = 0; offset < ids.length; offset += 40) {
        const keys = ids
          .slice(offset, offset + 40)
          .map((id) => (entity.key.length === 1 ? [id] : id.split(':')))
          .filter((key) => key.length === entity.key.length);
        if (keys.length === 0) continue;
        const match =
          entity.key.length === 1
            ? `iventity.${entity.key[0]!} IN (${keys.map(() => '?').join(', ')})`
            : `(${entity.key.map((key) => `iventity.${key}`).join(', ')}) IN (VALUES ${keys.map(() => `(${entity.key.map(() => '?').join(', ')})`).join(', ')})`;
        const rows = await executor.all<Row>(
          statement(
            `SELECT iventity.*, (${visible.sql}) AS iv_visible${extra} FROM ${entity.table} iventity WHERE iventity.org_id = ? AND ${match}`,
            ...visible.params,
            ...(extra === '' ? [] : [ctx.orgId]),
            ctx.orgId,
            ...keys.flat(),
          ),
        );
        for (const row of rows)
          found.set(`${type}:${entity.key.map((key) => String(row[key])).join(':')}`, row);
      }
    }
    return found;
  }
  async function check(
    ctx: OrgContext,
    runId: string,
    manifest: Manifest,
  ): Promise<ImportVerificationFailure | null> {
    const refs = await journal.rollbackRefs(ctx, runId);
    if (refs.length !== manifest.items.length) return 'item_missing';
    const byRef = new Map(refs.map((ref) => [`${ref.entityType}:${ref.externalRef}`, ref]));
    const rows = await entities(ctx, refs);
    for (const item of manifest.items) {
      const type = ENTITY[item.type];
      const ref = byRef.get(`${type}:${item.external_ref}`);
      if (ref === undefined || ref.rolledBackAt !== null || ref.conflictState !== 'none')
        return 'item_missing';
      const entity = ROLLBACK_ENTITIES[type]!;
      const row = rows.get(`${type}:${ref.entityId}`);
      if (row === undefined) return 'item_missing';
      if (row.iv_visible !== 1) return 'visibility_mismatch';
      const domain: Record<string, SqlValue | readonly string[]> = Object.fromEntries(
        entity.domain.map((key) => [key, row[key]!]),
      );
      if (type === 'role') {
        domain.permissions = (JSON.parse(String(row.iv_permissions ?? '[]')) as string[]).sort();
      }
      if (item.type === 'source') {
        if (row.credential_id !== null) {
          if (item.credential_ref === null) return 'digest_mismatch';
          if (row.iv_credential !== 1) return 'credential_missing';
        } else if (item.credential_ref !== null) return 'credential_missing';
        domain.credential_id = null;
      }
      if (type === 'version' && row.published_at_basis !== ref.publishedAtBasis)
        return 'digest_mismatch';
      if (ref.contentHash === null || (await hash(domain)) !== ref.contentHash)
        return 'digest_mismatch';
    }
    return null;
  }
  return {
    loadRun: (ctx, runId) => journal.loadRun(ctx, runId),
    fail,
    async verify(ctx, fence, input) {
      // Every fenced domain write replaces this epoch; a changed snapshot must be retried.
      const [epoch] = await executor.all<{ version: string }>(
        statement('SELECT version FROM cache_epoch ivepoch WHERE ivepoch.org_id = ?', ctx.orgId),
      );
      if (epoch === undefined) throw new Error('cache_epoch row is missing for the organization');
      const reason = await check(ctx, input.runId, input.manifest);
      if (reason !== null) return fail(ctx, fence, { ...input, reason });
      return journal.markVerified(ctx, fence, {
        runId: input.runId,
        verifiedAt: input.now,
        expectedEpoch: epoch.version,
      });
    },
  };
}
