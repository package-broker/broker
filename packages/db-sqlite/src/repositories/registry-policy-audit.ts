import { auditEvent, type AuditEvent, type AuditValue } from '@package-broker/core/audit/actions';
import {
  RegistryPolicyInputError,
  isPolicyTimestamp,
  type PolicyAuditEnvelope,
  type PolicyWriteOutcome,
} from '@package-broker/core/db/registry-policy';
import { isUlid } from '@package-broker/core/ids';

export type PolicyAuditAction =
  | 'registry_policy.create'
  | 'registry_policy.update'
  | 'registry_policy.disable'
  | 'registry_policy.release'
  | 'registry_policy.members_replace';

export type PolicyAuditChanges = Record<string, { old?: AuditValue; new?: AuditValue }>;

/** The validated audit event of a rule write; any refusal is the fixed audit input error. */
export function policyAuditEvent(
  envelope: PolicyAuditEnvelope,
  actorUserId: string,
  action: PolicyAuditAction,
  ruleId: string,
  projectId: string | null,
  fields: PolicyAuditChanges,
): AuditEvent {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !isUlid(envelope.id) ||
    !isPolicyTimestamp(envelope.occurredAt)
  ) {
    throw new RegistryPolicyInputError('audit');
  }
  const built = auditEvent({
    id: envelope.id,
    now: envelope.occurredAt,
    action,
    actor: { type: 'user', id: actorUserId },
    context: envelope.context,
    target: { type: 'registry_policy', id: ruleId },
    projectId,
    changes: fields,
  });
  if (!built.ok) throw new RegistryPolicyInputError('audit');
  return built.event;
}

export function refused(
  reason: Extract<PolicyWriteOutcome, { ok: false }>['reason'],
): PolicyWriteOutcome {
  return { ok: false, reason };
}
