import { sql, type SqlBool } from 'kysely';
import { fenceKind } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import {
  MAX_POLICY_RULES,
  validatePolicyRuleCreate,
  type RegistryPolicyStore,
} from '@package-broker/core/db/registry-policy';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';
import { auditPendingStatement } from './audit-pending.js';
import { policyAuditEvent, refused } from './registry-policy-audit.js';
import { policyAuthorityGuard } from './registry-policy-authority.js';

const failed = (guard: Guard) =>
  compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));

/**
 * Bounds the rules a read of this package can see: enabled package-less rules plus the largest
 * per-package set stay below the snapshot cap after this insert.
 */
function underCap(ctx: OrgContext, ecosystem: string, packageKey: string | null): Guard {
  const enabled = sql`org_id = ${ctx.orgId} and ecosystem = ${ecosystem} and disabled_at is null`;
  const packageless = sql`(select count(*) from registry_policy_rule where ${enabled} and package_key is null)`;
  const packaged =
    packageKey === null
      ? sql`(select coalesce(max(n), 0) from (select count(*) as n from registry_policy_rule
          where ${enabled} and package_key is not null group by package_key))`
      : sql`(select count(*) from registry_policy_rule where ${enabled} and package_key = ${packageKey})`;
  return sql<SqlBool>`${packageless} + ${packaged} < ${MAX_POLICY_RULES}`;
}

export function createRegistryPolicyStore(
  executor: SqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[],
): RegistryPolicyStore {
  return {
    async create(ctx, fence, raw) {
      if (fenceKind(fence) !== 'session' || !('sessionId' in fence)) return refused('forbidden');
      const input = validatePolicyRuleCreate(raw);
      const projectId = input.scope.kind === 'project' ? input.scope.projectId : null;
      const authority = policyAuthorityGuard(ctx, fence, {
        scope: input.scope,
        kind: input.kind,
        fresh: false,
        providerAnchors,
      });
      const audit = policyAuditEvent(
        input.audit,
        fence.userId,
        'registry_policy.create',
        input.id,
        projectId,
        {
          kind: { new: input.kind },
          ecosystem: { new: input.ecosystem },
          package_key: { new: input.packageKey },
          project_id: { new: projectId },
          min_age_seconds: { new: input.minAgeSeconds },
          client_family: { new: input.clientFamily },
          client_min_version: { new: input.clientMinVersion },
          deny_unknown: { new: input.denyUnknown },
          reason_code: { new: input.reasonCode },
          incident_id: { new: input.incidentId },
          expires_at: { new: input.expiresAt },
          revision: { new: 1 },
          member_count: { new: input.members.length },
        },
      );
      const cap = underCap(ctx, input.ecosystem, input.packageKey);
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(authority, ctx),
        [
          ...assertCheck(cap),
          compile(
            db.insertInto('registry_policy_rule').values({
              id: input.id,
              org_id: ctx.orgId,
              project_id: projectId,
              ecosystem: input.ecosystem,
              package_key: input.packageKey,
              kind: input.kind,
              min_age_seconds: input.minAgeSeconds,
              client_family: input.clientFamily,
              client_min_version: input.clientMinVersion,
              deny_unknown: input.denyUnknown ? 1 : 0,
              reason_code: input.reasonCode,
              incident_id: input.incidentId,
              expires_at: input.expiresAt,
              revision: 1,
              created_at: input.now,
              updated_at: input.now,
            }),
          ),
          ...(input.members.length === 0
            ? []
            : [
                {
                  sql: `INSERT INTO registry_policy_version (org_id, rule_id, version_normalized)
                    SELECT ?, ?, value FROM json_each(?)`,
                  params: [ctx.orgId, input.id, JSON.stringify(input.members)],
                },
              ]),
          auditPendingStatement(ctx, audit),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        { authority: failed(authority) },
      );
      if (outcome.ok) return { ok: true, revision: 1 };
      if (outcome.reason === 'authority') return refused('forbidden');
      if (outcome.reason === 'indeterminate') return refused('indeterminate');
      const [state] = await executor.all<{ replayed: number; taken: number; full: number }>(
        compile(
          db.selectNoFrom([
            sql<number>`${liveIdempotencyCollision(ctx, input.idempotency)}`.as('replayed'),
            sql<number>`exists ${db
              .selectFrom('registry_policy_rule')
              .select('id')
              .where('id', '=', input.id)
              .where('org_id', '=', ctx.orgId)}`.as('taken'),
            sql<number>`(${cap}) is not 1`.as('full'),
          ]),
        ),
      );
      if (state?.replayed === 1) return refused('replayed');
      if (state?.full === 1) return refused('limit_exceeded');
      return refused(state?.taken === 1 ? 'conflict' : 'indeterminate');
    },
  };
}
