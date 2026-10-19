import type { VisibilityAudit } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { auditPendingStatement } from './audit-pending.js';
import { idempotencyInsertStatement } from './idempotency.js';

/** Must immediately follow the domain mutation, before derivation or postconditions. */
export function visibilityAuditStatements(
  ctx: OrgContext,
  input: VisibilityAudit,
  idempotencyOnlyIfChanged = false,
): Statement[] {
  return [
    auditPendingStatement(ctx, input.audit, { sql: 'changes() > 0', params: [] }),
    ...(input.idempotency === undefined
      ? []
      : [idempotencyInsertStatement(ctx, input.idempotency, idempotencyOnlyIfChanged)]),
  ];
}
