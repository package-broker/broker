import type { AuditAction, AuditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';

export function visibilityAudit(action: AuditAction = 'source.update'): AuditEvent {
  return {
    id: ulid(),
    occurredAt: new Date().toISOString(),
    action,
    actor: { type: 'user', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    tokenSelector: null,
    sourceIp: null,
    target: { type: 'source', id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    projectId: null,
    payloadJson: '{}',
  };
}
