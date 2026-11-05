import type { VisibilityAudit } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { auditPendingStatement, auditOperationStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';

/** Must immediately follow the domain mutation, before derivation or postconditions. */
export function visibilityAuditStatements(
  ctx: OrgContext,
  input: VisibilityAudit,
  idempotencyOnlyIfChanged = false,
  reserve?: Statement,
): Statement[] {
  const when = { sql: 'changes() > 0', params: [] };
  return [
    reserve === undefined
      ? auditPendingStatement(ctx, input.audit, when)
      : auditOperationStatement(ctx, input.audit, reserve, when),
    ...(input.idempotency === undefined
      ? []
      : [idempotencyInsertStatement(ctx, input.idempotency, idempotencyOnlyIfChanged)]),
  ];
}
