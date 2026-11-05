import {
  RegistryPolicyInputError,
  isPolicyMemberKind,
  policyMembers,
  type PolicyOverrideReason,
} from '../../db/registry-policy.js';
import {
  policyRuleView,
  type PolicyCaller,
  type PolicyIdempotency,
  type PolicyManageDeps,
  type PolicyManageOutcome,
  type PolicyManageService,
  type PolicyRuleView,
} from './manage.js';

export interface PolicyMemberService {
  /** Sets the exact member set of a block, allowlist or quarantine in one revisioned write. */
  replace(
    caller: PolicyCaller,
    id: string,
    expectedRevision: number,
    members: readonly unknown[],
    overrideReason: PolicyOverrideReason | undefined,
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
  /** Disables exactly one malware quarantine; version status and other holds are untouched. */
  release(
    caller: PolicyCaller,
    id: string,
    expectedRevision: number,
    reason: PolicyOverrideReason,
    idempotency: PolicyIdempotency,
  ): Promise<PolicyManageOutcome<PolicyRuleView>>;
}

export function createPolicyMemberService(
  deps: PolicyManageDeps & { readonly manage: PolicyManageService },
): PolicyMemberService {
  return {
    async replace(caller, id, expectedRevision, raw, overrideReason, idempotency) {
      const found = await deps.manage.managed(caller, id);
      if (!found.ok) return found;
      const rule = found.rule;
      if (!isPolicyMemberKind(rule.kind)) {
        return { ok: false, error: 'invalid_request', field: 'members' };
      }
      let members: readonly string[];
      try {
        members = policyMembers(rule.ecosystem, raw);
      } catch (error) {
        if (error instanceof RegistryPolicyInputError) {
          return { ok: false, error: 'invalid_request', field: error.field };
        }
        throw error;
      }
      if (rule.kind === 'quarantine' && members.length === 0) {
        return { ok: false, error: 'invalid_request', field: 'members' };
      }
      const earlier = await deps.manage.replay(idempotency);
      if (earlier !== null) return earlier;
      if (rule.disabledAt !== null || rule.revision !== expectedRevision) {
        return { ok: false, error: 'conflict' };
      }
      const now = deps.clock.now().toISOString();
      const body = policyRuleView({
        ...rule,
        memberCount: members.length,
        revision: expectedRevision + 1,
        updatedAt: now,
      });
      try {
        return await deps.manage.write(caller, idempotency, 200, body, (record) =>
          deps.members.replace(caller.org, caller.fence!, {
            id,
            expectedRevision,
            members,
            now,
            audit: { id: deps.ids.ulid(), occurredAt: now, context: caller.audit },
            idempotency: record,
            ...(overrideReason === undefined ? {} : { overrideReason }),
          }),
        );
      } catch (error) {
        if (error instanceof RegistryPolicyInputError) {
          return { ok: false, error: 'invalid_request', field: error.field };
        }
        throw error;
      }
    },

    async release(caller, id, expectedRevision, reason, idempotency) {
      const found = await deps.manage.managed(caller, id);
      if (!found.ok) return found;
      if (found.rule.kind !== 'quarantine') {
        return { ok: false, error: 'invalid_request', field: 'kind' };
      }
      return deps.manage.disable(caller, id, expectedRevision, reason, idempotency);
    },
  };
}
