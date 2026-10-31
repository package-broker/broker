import type { AuditEvent } from '@package-broker/core/audit/actions';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import { isUlid } from '@package-broker/core/ids';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESERVE_ACTIONS = new Set([
  'identity.block',
  'user.suspend',
  'token.revoke',
  'token.rotate',
  'grant.revoke',
  'project_grant.revoke',
  'service_principal.suspend',
  'source.pause',
  'audit.sink_admin',
  'audit.export',
  'audit.mode_change',
]);

const INSERT = `INSERT INTO audit_pending
  (id, org_id, created_at, actor_type, actor_id, token_selector, source_ip,
   action, target_type, target_id, project_id, payload_json)`;

/** The optional condition is trusted repository SQL, never request input. */
export function auditPendingStatement(
  ctx: OrgContext,
  event: AuditEvent,
  when?: { sql: string; params: readonly SqlValue[] },
): Statement {
  return pendingStatement(ctx, event, when, false);
}

function pendingStatement(
  ctx: OrgContext,
  event: AuditEvent,
  when: { sql: string; params: readonly SqlValue[] } | undefined,
  companion: boolean,
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
  const reserved =
    (event.action.startsWith('session.') && event.action !== 'session.login_failed') ||
    RESERVE_ACTIONS.has(event.action);
  // occurredAt is validated above; NULL is reserved for an atomic capacity refusal.
  const createdAt = reserved
    ? 'pending_created_at'
    : `CASE WHEN EXISTS (
        SELECT 1 FROM audit_chain
        WHERE audit_chain.org_id = input.pending_org_id
          AND policy = 'required' AND capacity_state = 'refusing'
      )${companion ? ' AND changes() != 1' : ''} THEN NULL ELSE pending_created_at END`;

  return {
    sql: `${INSERT}
    SELECT pending_id, pending_org_id, ${createdAt}, pending_actor_type, pending_actor_id, pending_token_selector, pending_source_ip,
      pending_action, pending_target_type, pending_target_id, pending_project_id, pending_payload_json
    FROM (
      SELECT ? AS pending_id, ? AS pending_org_id, ? AS pending_created_at, ? AS pending_actor_type, ? AS pending_actor_id,
        ? AS pending_token_selector, ? AS pending_source_ip, ? AS pending_action, ? AS pending_target_type,
        ? AS pending_target_id, ? AS pending_project_id, ? AS pending_payload_json
    ) AS input${when === undefined ? '' : ` WHERE ${when.sql}`}`,
    params,
  };
}

/** Keeps the companion adjacent to the reserve insert whose change count permits it. */
export function auditReserveStatements(
  ctx: OrgContext,
  reserve: AuditEvent,
  companion: AuditEvent,
  when?: { sql: string; params: readonly SqlValue[] },
): readonly Statement[] {
  if (!(
    (reserve.action === 'token.rotate' && companion.action === 'token.issue') ||
    (reserve.action === 'identity.block' && companion.action === 'identity.unlink')
  ))
    throw new TypeError('Invalid audit reserve companion');
  return [
    auditPendingStatement(ctx, reserve, when),
    pendingStatement(ctx, companion, undefined, true),
  ];
}
