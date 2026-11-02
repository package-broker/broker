import { sql } from 'kysely';
import { auditEvent } from '@package-broker/core/audit/actions';
import { fenceKind, type SystemMutationFence } from '@package-broker/core/authz/fence';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  POLICY_EXPIRY_PAGE,
  RegistryPolicyInputError,
  isPolicyRuleId,
  isPolicyTimestamp,
  type PolicyExpiryDue,
  type RegistryPolicyExpiry,
} from '@package-broker/core/db/registry-policy';
import { isUlid } from '@package-broker/core/ids';
import { compile, db } from '../kysely.js';
import { auditPendingStatement } from './audit-pending.js';
import { jobLeaseGuard } from './job-lease-guard.js';

const DB_NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

type DueRow = {
  readonly id: string;
  readonly project_id: string | null;
  readonly ecosystem: PolicyExpiryDue['ecosystem'];
  readonly kind: PolicyExpiryDue['kind'];
  readonly package_key: string | null;
  readonly revision: number;
  readonly expires_at: string;
};

/**
 * Records the expiry evidence of a rule once, on database time. The marker never changes the
 * rule revision, the epoch or the interval in which the rule restricted reads.
 */
export function createRegistryPolicyExpiry(executor: SqlExecutor): RegistryPolicyExpiry {
  return {
    async due(ctx, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY_EXPIRY_PAGE) {
        throw new RangeError('limit is out of range');
      }
      const rows = await executor.all<DueRow>(
        compile(
          db
            .selectFrom('registry_policy_rule as r')
            .select([
              'r.id',
              'r.project_id',
              'r.ecosystem',
              'r.kind',
              'r.package_key',
              'r.revision',
              'r.expires_at',
            ])
            .where('r.org_id', '=', ctx.orgId)
            .where('r.disabled_at', 'is', null)
            .where('r.expiry_audited_at', 'is', null)
            .where('r.expires_at', 'is not', null)
            .where('r.expires_at', '<=', DB_NOW)
            .orderBy('r.expires_at')
            .orderBy('r.id')
            .limit(limit),
        ),
      );
      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        ecosystem: row.ecosystem,
        kind: row.kind,
        packageKey: row.package_key,
        revision: row.revision,
        expiresAt: row.expires_at,
      }));
    },

    async mark(ctx, fence, input) {
      if (fenceKind(fence) !== 'system' || (fence as SystemMutationFence).writer !== 'purge') {
        throw new RegistryPolicyInputError('audit');
      }
      if (!isPolicyRuleId(input.id)) throw new RegistryPolicyInputError('id');
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
        throw new RegistryPolicyInputError('expectedRevision');
      }
      const envelope = input.audit;
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        !isUlid(envelope.id) ||
        !isPolicyTimestamp(envelope.occurredAt)
      ) {
        throw new RegistryPolicyInputError('audit');
      }
      const [rule] = await executor.all<DueRow>(
        compile(
          db
            .selectFrom('registry_policy_rule as e')
            .select([
              'e.id',
              'e.project_id',
              'e.ecosystem',
              'e.kind',
              'e.package_key',
              'e.revision',
              'e.expires_at',
            ])
            .where('e.org_id', '=', ctx.orgId)
            .where('e.id', '=', input.id),
        ),
      );
      if (rule === undefined || rule.expires_at === null || rule.revision !== input.revision) {
        return false;
      }
      const built = auditEvent({
        id: envelope.id,
        now: envelope.occurredAt,
        action: 'registry_policy.expire',
        actor: { type: 'system', id: 'registry-policy-expire' },
        context: envelope.context,
        target: { type: 'registry_policy', id: input.id },
        projectId: rule.project_id,
        changes: {
          kind: { new: rule.kind },
          expires_at: { new: rule.expires_at },
          revision: { new: rule.revision },
        },
      });
      if (!built.ok) throw new RegistryPolicyInputError('audit');
      const results = await executor.batch([
        ...jobLeaseGuard(ctx, (fence as SystemMutationFence).job),
        compile(
          db
            .updateTable('registry_policy_rule')
            .set({ expiry_audited_at: DB_NOW })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.id)
            .where('revision', '=', input.revision)
            .where('expires_at', '=', rule.expires_at)
            .where('disabled_at', 'is', null)
            .where('expiry_audited_at', 'is', null)
            .where('expires_at', '<=', DB_NOW)
            .returning('id'),
        ),
        auditPendingStatement(ctx, built.event, { sql: 'changes() = 1', params: [] }),
      ]);
      return (results.at(-2)?.rows ?? []).length === 1;
    },
  };
}
