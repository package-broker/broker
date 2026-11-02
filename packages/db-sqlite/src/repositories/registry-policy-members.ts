import { sql, type SqlBool } from 'kysely';
import { fenceKind } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import {
  POLICY_OVERRIDE_REASONS,
  RegistryPolicyInputError,
  isPolicyMemberKind,
  isPolicyRuleId,
  isPolicyTimestamp,
  policyMembers,
  type PolicyEcosystem,
  type PolicyRuleKind,
  type RegistryPolicyMembers,
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
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement, liveIdempotencyCollision } from './idempotency.js';
import { policyAuditEvent, refused } from './registry-policy-audit.js';
import { policyAuthorityGuard } from './registry-policy-authority.js';

interface CurrentRule {
  readonly project_id: string | null;
  readonly ecosystem: PolicyEcosystem;
  readonly kind: PolicyRuleKind;
  readonly disabled_at: string | null;
  readonly revision: number;
}

/** The rule left the revision a refused batch expected: it changed, was disabled or is gone. */
function movedSince(ctx: OrgContext, id: string, revision: number): Guard {
  return sql<SqlBool>`not exists ${db
    .selectFrom('registry_policy_rule')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .where('revision', '=', revision)
    .where('disabled_at', 'is', null)}`;
}

const failed = (guard: Guard) =>
  compile(db.selectNoFrom(sql<number>`(${guard}) is not 1`.as('failed')));

/**
 * An empty block covers every version, so emptying it tightens while its first member narrows it.
 * A block or quarantine otherwise weakens when it loses a member; an allowlist when it gains one.
 */
function weakens(
  kind: PolicyRuleKind,
  before: readonly string[],
  after: readonly string[],
  added: number,
  removed: number,
) {
  if (kind === 'allowlist') return added > 0;
  if (kind === 'block' && after.length === 0) return false;
  return removed > 0 || (kind === 'block' && before.length === 0);
}

export function createRegistryPolicyMembers(
  executor: SqlExecutor,
  providerAnchors: readonly ProtectedHolderProvider[],
): RegistryPolicyMembers {
  return {
    async replace(ctx, fence, input) {
      if (!isPolicyRuleId(input.id)) throw new RegistryPolicyInputError('id');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new RegistryPolicyInputError('expectedRevision');
      }
      if (!isPolicyTimestamp(input.now)) throw new RegistryPolicyInputError('now');
      if (
        input.overrideReason !== undefined &&
        !(POLICY_OVERRIDE_REASONS as readonly string[]).includes(input.overrideReason)
      ) {
        throw new RegistryPolicyInputError('overrideReason');
      }
      if (fenceKind(fence) !== 'session' || !('sessionId' in fence)) return refused('forbidden');
      const [rules, stored] = await executor.batch([
        compile(
          db
            .selectFrom('registry_policy_rule as r')
            .select(['r.project_id', 'r.ecosystem', 'r.kind', 'r.disabled_at', 'r.revision'])
            .where('r.org_id', '=', ctx.orgId)
            .where('r.id', '=', input.id),
        ),
        compile(
          db
            .selectFrom('registry_policy_version as m')
            .select('m.version_normalized')
            .where('m.org_id', '=', ctx.orgId)
            .where('m.rule_id', '=', input.id)
            .orderBy('m.version_normalized'),
        ),
      ]);
      const rule = rules?.rows[0] as CurrentRule | undefined;
      if (rule === undefined) return refused('not_found');
      if (!isPolicyMemberKind(rule.kind)) throw new RegistryPolicyInputError('members');
      if (rule.disabled_at !== null || rule.revision !== input.expectedRevision) {
        return refused('conflict');
      }
      const members = policyMembers(rule.ecosystem, input.members);
      if (rule.kind === 'quarantine' && members.length === 0) {
        throw new RegistryPolicyInputError('members');
      }
      const before = (stored?.rows ?? []).map((row) => String(row['version_normalized']));
      const kept = new Set(before);
      const next = new Set(members);
      const added = members.filter((member) => !kept.has(member)).length;
      const removed = before.filter((member) => !next.has(member)).length;
      const weakening = weakens(rule.kind, before, members, added, removed);
      if (weakening && rule.kind !== 'allowlist' && input.overrideReason === undefined) {
        throw new RegistryPolicyInputError('overrideReason');
      }
      const scope =
        rule.project_id === null
          ? ({ kind: 'organization' } as const)
          : ({ kind: 'project', projectId: rule.project_id } as const);
      const authority = (fresh: boolean) =>
        policyAuthorityGuard(ctx, fence, { scope, kind: rule.kind, fresh, providerAnchors });
      const held = authority(weakening);
      const packed = JSON.stringify(members);
      const event = policyAuditEvent(
        input.audit,
        fence.userId,
        'registry_policy.members_replace',
        input.id,
        rule.project_id,
        {
          kind: { new: rule.kind },
          revision: { old: input.expectedRevision, new: input.expectedRevision + 1 },
          member_count: { old: before.length, new: members.length },
          members_added: { new: added },
          members_removed: { new: removed },
          ...(input.overrideReason === undefined
            ? {}
            : { override_reason: { new: input.overrideReason } }),
        },
      );
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(held, ctx),
        [
          compile(
            db
              .updateTable('registry_policy_rule')
              .set({ revision: sql<number>`revision + 1`, updated_at: input.now })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', input.id)
              .where('revision', '=', input.expectedRevision)
              .where('disabled_at', 'is', null),
          ),
          ...assertCheck(sql<SqlBool>`changes() = 1`),
          {
            sql: `DELETE FROM registry_policy_version WHERE org_id = ? AND rule_id = ?
              AND version_normalized NOT IN (SELECT value FROM json_each(?))`,
            params: [ctx.orgId, input.id, packed],
          },
          {
            sql: `INSERT INTO registry_policy_version (org_id, rule_id, version_normalized)
              SELECT ?, ?, value FROM json_each(?) WHERE 1
              ON CONFLICT (org_id, rule_id, version_normalized) DO NOTHING`,
            params: [ctx.orgId, input.id, packed],
          },
          ...assertCheck(
            sql<SqlBool>`(select count(*) from registry_policy_version
              where org_id = ${ctx.orgId} and rule_id = ${input.id}) = ${members.length}`,
          ),
          auditPendingStatement(ctx, event),
          ...(input.idempotency === undefined
            ? []
            : [idempotencyInsertStatement(ctx, input.idempotency)]),
        ],
        { authority: failed(held) },
      );
      if (outcome.ok) return { ok: true, revision: input.expectedRevision + 1 };
      if (outcome.reason === 'indeterminate') return refused('indeterminate');
      const [state] = await executor.all<{ live: number; replayed: number; moved: number }>(
        compile(
          db.selectNoFrom([
            sql<number>`${authority(false)}`.as('live'),
            sql<number>`${liveIdempotencyCollision(ctx, input.idempotency)}`.as('replayed'),
            sql<number>`${movedSince(ctx, input.id, input.expectedRevision)}`.as('moved'),
          ]),
        ),
      );
      if (outcome.reason === 'authority') {
        return refused(weakening && state?.live === 1 ? 'reauth_required' : 'forbidden');
      }
      if (state?.replayed === 1) return refused('replayed');
      return refused(state?.moved === 1 ? 'conflict' : 'indeterminate');
    },
  };
}
