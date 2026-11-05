import { sql } from 'kysely';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { DbError } from '@package-broker/core/db/errors';
import type {
  MintedServiceToken,
  WorkloadTokenFence,
  WorkloadTokenInput,
  WorkloadTokenStore,
} from '@package-broker/core/authz/service-token-service';
import { assertCheck, compile, db } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';

function validTime(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function mintedValid(minted: MintedServiceToken): boolean {
  return (
    /^[a-z2-7]{12}$/.test(minted.selector) &&
    /^[0-9a-f]{64}$/.test(minted.hash) &&
    Number.isSafeInteger(minted.pepperVersion) &&
    minted.pepperVersion > 0 &&
    new RegExp(`^pb_svc_${minted.selector}_[A-Za-z0-9_-]{43}$`).test(minted.plaintext)
  );
}

export function workloadTokenStatements(
  ctx: OrgContext,
  fence: WorkloadTokenFence,
  input: WorkloadTokenInput,
  minted: MintedServiceToken,
): readonly Statement[] {
  if (!validTime(input.now) || !validTime(input.expiresAt) || !mintedValid(minted))
    throw new TypeError('invalid_workload_input');
  const publisher = fence.publisher;
  const wildcard = publisher.packageName.startsWith('@')
    ? publisher.packageName.split('/')[0] + '/*'
    : publisher.packageName;
  const allowed = sql<boolean>`exists (
    select 1 from trusted_publisher tp join service_principal sp on sp.id = tp.service_principal_id and sp.org_id = tp.org_id
    where tp.org_id = ${ctx.orgId} and tp.id = ${publisher.id} and tp.revision = ${publisher.revision}
      and tp.disabled_at is null and tp.package_name = ${publisher.packageName}
      and tp.service_principal_id = ${publisher.servicePrincipalId}
      and sp.status = 'active' and sp.project_id is null
      and (select count(*) from service_principal_permission spp where spp.org_id = tp.org_id and spp.service_principal_id = sp.id) = 1
      and exists (select 1 from service_principal_permission spp where spp.org_id = tp.org_id and spp.service_principal_id = sp.id and spp.permission = 'org:packages:publish')
      and exists (select 1 from source s join registered_name rn on rn.source_id = s.id and rn.org_id = s.org_id
        where s.org_id = tp.org_id and s.type = 'hosted' and s.ecosystem = 'npm' and s.project_id is null and s.status = 'active'
        and rn.ecosystem = 'npm' and rn.pattern in (${publisher.packageName}, ${wildcard}))
      and unixepoch(${input.expiresAt}, 'subsec') = unixepoch(${input.now}, 'subsec') + 900
      and unixepoch(${input.expiresAt}, 'subsec') <= unixepoch('now', 'subsec') + 900
      and unixepoch(${input.expiresAt}, 'subsec') > unixepoch('now', 'subsec'))`;
  return fence.replay.appendTo([
    ...assertCheck(allowed),
    compile(
      db.insertInto('token').values({
        id: input.id,
        org_id: ctx.orgId,
        kind: 'svc',
        selector: minted.selector,
        hash: minted.hash,
        pepper_version: minted.pepperVersion,
        name: 'workload',
        scopes_json: '["write"]',
        read_only: 0,
        service_principal_id: publisher.servicePrincipalId,
        project_id: null,
        project_mode: 'all',
        created_by_user_id: null,
        created_at: input.now,
        expires_at: input.expiresAt,
        trusted_publisher_id: publisher.id,
        package_name: publisher.packageName,
      }),
    ),
    compile(
      db
        .updateTable('trusted_publisher')
        .set({ last_used_at: input.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', publisher.id),
    ),
    auditPendingStatement(ctx, input.audit),
  ]);
}

export function createWorkloadTokenStore(executor: SqlExecutor): WorkloadTokenStore {
  return {
    async issueWorkload(ctx, fence, input, mint) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const minted = await mint();
        try {
          await executor.batch(workloadTokenStatements(ctx, fence, input, minted));
          return { status: 'issued', id: input.id, plaintext: minted.plaintext };
        } catch (error) {
          if (!(error instanceof DbError)) throw error;
          if (error.kind === 'unique' && error.constraint === 'token.selector') continue;
          return error.kind === 'unique'
            ? { status: 'refused', reason: 'authority' }
            : { status: 'indeterminate' };
        }
      }
      return { status: 'refused', reason: 'selector_collision' };
    },
  };
}

/** Append to the admin authorization batch; the caller supplies its session fence. */
export function disableTrustedPublisherStatements(
  ctx: OrgContext,
  input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: string;
    readonly audit: AuditEvent;
  },
): readonly Statement[] {
  if (
    !validTime(input.now) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw new TypeError('invalid_publisher_disable');
  return [
    compile(
      db
        .updateTable('trusted_publisher')
        .set({ disabled_at: input.now, revision: sql`revision + 1` })
        .where('trusted_publisher.org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .where('revision', '=', input.expectedRevision)
        .where('disabled_at', 'is', null),
    ),
    ...assertCheck(sql<boolean>`changes() = 1`),
    compile(
      db
        .updateTable('token')
        .set({ revoked_at: input.now })
        .where('token.org_id', '=', ctx.orgId)
        .where('trusted_publisher_id', '=', input.id)
        .where('revoked_at', 'is', null)
        .where(sql<boolean>`unixepoch(expires_at, 'subsec') > unixepoch('now', 'subsec')`),
    ),
    auditPendingStatement(ctx, input.audit),
  ];
}
