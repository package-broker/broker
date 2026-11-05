import type { OrgContext, Statement } from '@package-broker/core/db/port';

export function auditCapacityStateStatement(ctx: OrgContext, budget: number): Statement {
  return {
    sql: `UPDATE audit_chain SET capacity_state = CASE
      WHEN policy = 'required' AND journal_bytes >= ? THEN 'refusing'
      WHEN policy = 'required' AND capacity_state = 'refusing' AND journal_bytes > ? THEN 'refusing'
      WHEN journal_bytes >= ? THEN 'warning'
      WHEN capacity_state = 'warning' AND journal_bytes > ? THEN 'warning'
      ELSE 'ok' END WHERE org_id = ?`,
    params: [
      budget,
      budget - Math.ceil(budget / 20),
      Math.ceil(budget * 0.8),
      Math.floor(budget * 0.75),
      ctx.orgId,
    ],
  };
}
