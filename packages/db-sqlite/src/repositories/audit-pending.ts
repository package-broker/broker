import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INSERT = `INSERT INTO audit_pending
  (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip,
   action, target_type, target_id, project_id, payload_json)`;

/** The optional condition is trusted repository SQL, never request input. */
export function auditPendingStatement(
  ctx: OrgContext,
  event: AuditEvent,
  when?: { sql: string; params: readonly SqlValue[] },
): Statement {
  if (typeof event.id !== 'string' || !isUlid(event.id)) {
    throw new TypeError('id must be a ULID');
  }
  const instant = new Date(event.occurredAt);
  if (
    typeof event.occurredAt !== 'string' ||
    !TIMESTAMP.test(event.occurredAt) ||
    Number.isNaN(instant.getTime()) ||
    instant.toISOString() !== event.occurredAt
  ) {
    throw new TypeError('occurredAt must be a UTC timestamp with millisecond precision');
  }
  if (
    typeof event.payloadJson !== 'string' ||
    new TextEncoder().encode(event.payloadJson).byteLength > 4096
  ) {
    throw new TypeError('payloadJson must be at most 4096 bytes');
  }
  const params: SqlValue[] = [
    event.id,
    ctx.orgId,
    event.occurredAt,
    event.actor.type,
    event.actor.id,
    event.tokenSelector,
    event.sourceIp,
    event.action,
    event.target.type,
    event.target.id,
    event.projectId,
    event.payloadJson,
    ...(when?.params ?? []),
  ];
  if (params.length > 100) throw new TypeError('audit insert must bind at most 100 parameters');
  const values = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
  return {
    sql:
      when === undefined
        ? `${INSERT} VALUES (${values})`
        : `${INSERT} SELECT ${values} WHERE ${when.sql}`,
    params,
  };
}
