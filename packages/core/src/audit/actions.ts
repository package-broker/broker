import { PERMISSIONS } from '../authz/permissions.js';
import { MAX_KEY_LENGTH, displayName, packageKey } from '../catalogue/names.js';
import { isValidProviderId } from '../identity/port.js';
import { isValidPattern } from '../catalogue/patterns.js';
import { isUlid } from '../ids.js';
import { AUDIT_ALERT_CODES } from '../platform/observability.js';
import { isWorkflowFilename } from '../registry/npm/oidc/claim-values.js';
import {
  POLICY_CLIENT_FAMILIES,
  POLICY_ECOSYSTEMS,
  POLICY_OVERRIDE_REASONS,
  POLICY_REASON_CODES,
  POLICY_RULE_KINDS,
  MAX_MIN_AGE_SECONDS,
  MAX_POLICY_MEMBERS,
  POLICY_PROJECT_ID,
  isPolicyClientVersion,
  isPolicyPackageKey,
  isPolicyTimestamp,
} from '../db/registry-policy.js';
import { validDistTag } from '../registry/npm/dist-tags.js';
import { redactValue } from './redact.js';

export const AUDIT_ACTIONS = [
  'package.publish',
  'package.deprecate',
  'package.dist_tag',
  'package.unpublish',
  'package.access_update',
  'publish.approve',
  'publish.reject',
  'publish.expire',
  'publish.scan',
  'token.workload_issue',
  'trusted_publisher.create',
  'trusted_publisher.update',
  'trusted_publisher.disable',
  'package.access_request',
  'package.access_decide',
  'session.login',
  'session.login_failed',
  'access.denied',
  'session.logout',
  'session.reauth',
  'setup.complete',
  'identity.unblock',
  'identity.unlink',
  'identity.block',
  'user.suspend',
  'user.reactivate',
  'role.create',
  'role.rename',
  'role.permissions_set',
  'role.delete',
  'grant.create',
  'grant.revoke',
  'grant.role_change',
  'project.create',
  'project.update',
  'project.archive',
  'project.restore',
  'project_grant.create',
  'project_grant.revoke',
  'project_grant.role_change',
  'token.issue',
  'token.revoke',
  'token.rotate',
  'service_principal.create',
  'service_principal.permissions_set',
  'service_principal.suspend',
  'service_principal.restore',
  'discovery_rule.create',
  'discovery_rule.update',
  'discovery_rule.delete',
  'discovery_rule.run_requested',
  'discovery_rule.run_started',
  'discovery_rule.run_finished',
  'source.create',
  'source.update',
  'source.pause',
  'source.sync_requested',
  'source.package_requested',
  'source.removal_accepted',
  'source.removal_applied',
  'source.resume',
  'source.credential_set',
  'source.attach',
  'source.detach',
  'source.reorder',
  'registered_name.add',
  'registered_name.update',
  'registered_name.remove',
  'version.state_change',
  'version.rebuilt',
  'version.published_at_set',
  'import_run.create',
  'import_run.approve',
  'import_run.apply',
  'import_run.fail',
  'import_run.verify',
  'import_run.rollback',
  'import_run.accept',
  'import_run.cancel',
  'import_run.credential_set',
  'purge.batch',
  'sync_session.finalize',
  'audit.export',
  'audit.mode_change',
  'audit.sink_admin',
  'registry_policy.create',
  'registry_policy.update',
  'registry_policy.disable',
  'registry_policy.release',
  'registry_policy.members_replace',
  'registry_policy.expire',
  'policy.read_denied',
  'policy.inspect',
  'notification.create',
  'notification.update',
  'notification.enable',
  'notification.disable',
  'notification.delete',
  'notification.credential_set',
  'notification.auto_disable',
  'notification.delivery_started',
  'notification.delivery_finished',
  'notification.delivery_cancelled',
  'notification.overflow',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const TRUSTED_PUBLISHER_FIELDS = [
  'package',
  'repository',
  'workflow',
  'environment',
  'ref_pattern',
  'repository_id',
  'repository_owner_id',
] as const;

const GRANT_FIELDS = ['subject_kind', 'role_id'] as const;
const POLICY_RULE_FIELDS = [
  'kind',
  'ecosystem',
  'package_key',
  'project_id',
  'min_age_seconds',
  'client_family',
  'client_min_version',
  'deny_unknown',
  'reason_code',
  'incident_id',
  'expires_at',
  'revision',
  'member_count',
  'changed_fields',
] as const;
const POLICY_OVERRIDE_FIELDS = [...POLICY_RULE_FIELDS, 'override_reason'] as const;
const POLICY_MEMBER_FIELDS = [
  'kind',
  'revision',
  'member_count',
  'members_added',
  'members_removed',
  'override_reason',
] as const;
const IMPORT_RUN_FIELDS = ['state', 'plan_hash', 'count', 'external_ref_count'] as const;
const IMPORT_ROLLBACK_FIELDS = [...IMPORT_RUN_FIELDS, 'restored', 'conflict', 'expired'] as const;
const ATTACH_FIELDS = ['project_id', 'position'] as const;
const REGISTERED_NAME_FIELDS = ['pattern'] as const;
const IDENTITY_FIELDS = ['provider'] as const;
const NOTIFICATION_CONFIG_FIELDS = [
  'revision',
  'method',
  'events',
  'pattern',
  'changed',
  'headers_configured',
  'template_configured',
] as const;
const NOTIFICATION_STATE_FIELDS = ['revision', 'reason'] as const;
const NOTIFICATION_DELIVERY_FIELDS = ['endpoint_id', 'event_id', 'delivery_id', 'attempt'] as const;
const IDENTITY_ACTIONS: ReadonlySet<string> = new Set([
  'identity.unblock',
  'identity.unlink',
  'identity.block',
]);

export const AUDIT_FIELDS: Record<AuditAction, readonly string[]> = {
  'package.deprecate': ['version', 'deprecated', 'deprecated_sha256'],
  'package.dist_tag': ['tag', 'version'],
  'package.unpublish': ['versions', 'removed_version_count'],
  'package.publish': [
    'authority',
    'package',
    'version',
    'hold_approval',
    'hold_scan',
    'integrity',
    'size_bytes',
    'source',
  ],
  'publish.approve': ['package', 'version', 'token_id'],
  'publish.reject': ['package', 'version', 'reason_sha256', 'token_id'],
  'publish.expire': ['package', 'version'],
  'publish.scan': ['plugin', 'verdict', 'reason_sha256'],
  'trusted_publisher.create': TRUSTED_PUBLISHER_FIELDS,
  'trusted_publisher.update': TRUSTED_PUBLISHER_FIELDS,
  'trusted_publisher.disable': TRUSTED_PUBLISHER_FIELDS,
  'token.workload_issue': [
    'trusted_publisher_id',
    'repository_id',
    'repository_owner_id',
    'repository_visibility',
    'workflow',
    'environment',
    'ref',
    'package',
    'token_id',
    'expires_at',
  ],
  'package.access_update': ['visible_to_new_projects', 'new_project_access_mode'],
  'package.access_request': ['package', 'project_id', 'reason_sha256'],
  'package.access_decide': ['package', 'project_id', 'state', 'reason_sha256'],
  'session.login': [],
  'session.login_failed': ['method', 'reason', 'count', 'window_start'],
  'access.denied': ['permission', 'boundary', 'count', 'window_start'],
  'session.logout': [],
  'session.reauth': [],
  'setup.complete': [],
  'identity.unblock': IDENTITY_FIELDS,
  'identity.unlink': IDENTITY_FIELDS,
  'identity.block': IDENTITY_FIELDS,
  'user.suspend': [],
  'user.reactivate': [],
  'role.create': ['key', 'name', 'scope', 'permissions'],
  'role.rename': ['name'],
  'role.permissions_set': ['permissions'],
  'role.delete': [],
  'grant.create': GRANT_FIELDS,
  'grant.revoke': GRANT_FIELDS,
  'grant.role_change': GRANT_FIELDS,
  'project.create': ['slug', 'name', 'token_max_scope', 'require_publish_approval'],
  'project.update': ['name', 'token_max_scope', 'require_publish_approval'],
  'project.archive': [],
  'project.restore': [],
  'project_grant.create': GRANT_FIELDS,
  'project_grant.revoke': GRANT_FIELDS,
  'project_grant.role_change': GRANT_FIELDS,
  'token.issue': ['kind', 'name', 'scope', 'expires_at', 'project_mode', 'project_count'],
  'token.revoke': ['cause'],
  'token.rotate': ['replacement_id', 'overlap_days', 'expires_at'],
  'service_principal.create': ['name', 'project_id', 'permissions'],
  'service_principal.permissions_set': ['permissions'],
  'service_principal.suspend': [],
  'service_principal.restore': [],
  'discovery_rule.create': [],
  'discovery_rule.update': [],
  'discovery_rule.delete': [],
  'discovery_rule.run_requested': [],
  'discovery_rule.run_started': [],
  'discovery_rule.run_finished': [],
  'source.create': ['name', 'type', 'ecosystem', 'project_id', 'url', 'require_publish_approval'],
  'source.update': [
    'name',
    'url',
    'status',
    'removal_policy',
    'poll_interval_seconds',
    'retention_days_override',
    'default_visible_to_new_projects',
    'require_publish_approval',
  ],
  'source.pause': [],
  'source.sync_requested': [],
  'source.package_requested': ['package_name'],
  'source.removal_accepted': ['source_id', 'refused_at', 'absent', 'listed', 'successful'],
  'source.removal_applied': ['source_id', 'absent', 'listed'],
  'source.resume': [],
  'source.credential_set': ['credential_kind'],
  'source.attach': ATTACH_FIELDS,
  'source.detach': ATTACH_FIELDS,
  'source.reorder': ['positions'],
  'registered_name.add': REGISTERED_NAME_FIELDS,
  'registered_name.update': REGISTERED_NAME_FIELDS,
  'registered_name.remove': REGISTERED_NAME_FIELDS,
  'version.state_change': ['reason_sha256', 'from_status', 'to_status', 'package_name', 'version'],
  'version.rebuilt': ['package_name', 'version', 'sha256_old', 'sha256_new'],
  'version.published_at_set': ['package_name', 'version', 'published_at', 'published_at_basis'],
  'import_run.create': IMPORT_RUN_FIELDS,
  'import_run.approve': IMPORT_RUN_FIELDS,
  'import_run.apply': IMPORT_RUN_FIELDS,
  'import_run.fail': [...IMPORT_RUN_FIELDS, 'reason'],
  'import_run.verify': IMPORT_RUN_FIELDS,
  'import_run.rollback': IMPORT_ROLLBACK_FIELDS,
  'import_run.accept': IMPORT_RUN_FIELDS,
  'import_run.cancel': IMPORT_RUN_FIELDS,
  'import_run.credential_set': ['external_ref'],
  'purge.batch': ['count', 'kind'],
  'sync_session.finalize': ['source_id', 'added', 'updated', 'removed'],
  'audit.export': ['from_seq', 'to_seq', 'count', 'withheld', 'format'],
  'audit.mode_change': [
    'from_mode',
    'to_mode',
    'policy',
    'source',
    'mode_generation',
    'cutover_seq',
  ],
  // A rebind always includes from_seq; to_seq is omitted when custody is empty.
  'audit.sink_admin': [
    'operation',
    'policy',
    'sink_id',
    'from_seq',
    'to_seq',
    'epoch',
    'generation',
    'reason_code',
    'alert_code',
    'revision',
  ],
  'registry_policy.create': POLICY_RULE_FIELDS,
  'registry_policy.update': POLICY_OVERRIDE_FIELDS,
  'registry_policy.disable': POLICY_OVERRIDE_FIELDS,
  'registry_policy.release': POLICY_OVERRIDE_FIELDS,
  'registry_policy.members_replace': POLICY_MEMBER_FIELDS,
  'registry_policy.expire': ['kind', 'expires_at', 'revision'],
  'policy.read_denied': [
    'read_kind',
    'ecosystem',
    'package_key',
    'version_id',
    'version_revision',
    'reasons',
  ],
  'policy.inspect': ['scope', 'ecosystem', 'package_key', 'result_count'],
  'notification.create': NOTIFICATION_CONFIG_FIELDS,
  'notification.update': NOTIFICATION_CONFIG_FIELDS,
  'notification.credential_set': NOTIFICATION_CONFIG_FIELDS,
  'notification.enable': NOTIFICATION_STATE_FIELDS,
  'notification.disable': NOTIFICATION_STATE_FIELDS,
  'notification.delete': NOTIFICATION_STATE_FIELDS,
  'notification.auto_disable': [...NOTIFICATION_STATE_FIELDS, 'failure_streak'],
  'notification.delivery_started': NOTIFICATION_DELIVERY_FIELDS,
  'notification.delivery_finished': [
    ...NOTIFICATION_DELIVERY_FIELDS,
    'outcome',
    'reason',
    'status',
    'duration_ms',
    'delivery_state',
  ],
  'notification.delivery_cancelled': ['endpoint_id', 'event_id', 'delivery_id', 'reason'],
  'notification.overflow': ['operation_id', 'event_type', 'event_count'],
};

const NOTIFICATION_EVENTS = [
  'npm.package.published',
  'npm.package.released',
  'npm.package.unpublished',
  'npm.package.deprecation_changed',
  'npm.package.dist_tag_changed',
];
const NOTIFICATION_DISABLE_REASONS = [
  'manual',
  'configuration_changed',
  'failures',
  'credentials',
  'policy',
  'gone',
];
const NOTIFICATION_ATTEMPT_CODES = [
  'ok',
  'network',
  'timeout',
  'http_retry',
  'http_permanent',
  'redirect',
  'policy',
  'credentials',
  'template',
  'unknown',
];
const NOTIFICATION_REASONS: Readonly<Record<string, readonly string[]>> = {
  'notification.disable': NOTIFICATION_DISABLE_REASONS,
  'notification.auto_disable': ['failures', 'credentials', 'policy', 'gone'],
  'notification.delete': ['deleted'],
  'notification.delivery_finished': [...NOTIFICATION_ATTEMPT_CODES, 'expired', 'attempt_limit'],
  'notification.delivery_cancelled': [
    'disabled',
    'superseded',
    'project_inactive',
    'admission_lost',
    'deleted',
  ],
};
const NOTIFICATION_CHANGED = [
  'name',
  'method',
  'events',
  'package_pattern',
  'destination',
  'headers',
  'signing_key',
  'template',
];

function count(min: number, max: number): (value: unknown) => boolean {
  return (value) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function oneOf(values: readonly string[]): (value: unknown) => boolean {
  return (value) => typeof value === 'string' && values.includes(value);
}

function distinctOf(values: readonly string[]): (value: unknown) => boolean {
  return (value) =>
    Array.isArray(value) &&
    value.length <= values.length &&
    new Set(value).size === value.length &&
    value.every(oneOf(values));
}

/** Notification audit carries only identifiers, counts and fixed codes, never receiver or user text. */
const NOTIFICATION_VALUES: Readonly<Record<string, (value: unknown) => boolean>> = {
  revision: count(1, Number.MAX_SAFE_INTEGER),
  method: oneOf(['POST', 'PUT']),
  events: (value) => distinctOf(NOTIFICATION_EVENTS)(value) && (value as unknown[]).length > 0,
  pattern: (value) => typeof value === 'string' && isValidPattern(value),
  changed: distinctOf(NOTIFICATION_CHANGED),
  headers_configured: (value) => typeof value === 'boolean',
  template_configured: (value) => typeof value === 'boolean',
  failure_streak: count(0, Number.MAX_SAFE_INTEGER),
  endpoint_id: isBrokerId,
  event_id: isBrokerId,
  delivery_id: isBrokerId,
  operation_id: isBrokerId,
  attempt: count(1, 8),
  outcome: oneOf(['started', 'delivered', 'retry', 'failed', 'unknown']),
  status: (value) => value === null || count(100, 599)(value),
  duration_ms: count(0, 3_600_000),
  delivery_state: oneOf(['pending', 'sending', 'delivered', 'failed', 'cancelled']),
  event_type: oneOf(NOTIFICATION_EVENTS),
  event_count: count(1, 10_000),
};

function cleanNotificationValue(value: unknown, field: string, action: string): Cleaned {
  const valid =
    field === 'reason' ? oneOf(NOTIFICATION_REASONS[action] ?? []) : NOTIFICATION_VALUES[field];
  return valid?.(value) === true
    ? { ok: true, value: value as AuditValue }
    : { ok: false, reason: 'bad_value' };
}

export type AuditValue = string | number | boolean | null | readonly string[];

export type AuditActorType = 'user' | 'service_principal' | 'customer' | 'system';

export interface AuditContext {
  opId: string;
  requestId: string;
  sourceIp: string | null;
  tokenSelector: string | null;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  action: AuditAction;
  actor: { type: AuditActorType; id: string | null };
  tokenSelector: string | null;
  sourceIp: string | null;
  target: { type: string; id: string | null };
  projectId: string | null;
  payloadJson: string;
}

export function withPackageAuditName(event: AuditEvent, packageName: string): AuditEvent {
  const payload = JSON.parse(event.payloadJson) as { changes?: Record<string, unknown> };
  return validateAuditEvent({
    ...event,
    payloadJson: sortedJson({
      ...payload,
      changes: { ...payload.changes, package: { new: packageName } },
    }),
  });
}

export interface AuditEventInput {
  id: string;
  now: string;
  action: AuditAction;
  actor: { type: AuditActorType; id: string | null };
  context: Omit<AuditContext, 'opId' | 'requestId'> & {
    opId: string | null;
    requestId: string | null;
  };
  target: { type: string; id: string | null };
  projectId?: string | null;
  changes?: Record<string, { old?: AuditValue; new?: AuditValue }>;
}

export type AuditRefusal = 'unknown_action' | 'unknown_field' | 'bad_value' | 'credential_value';

export type AuditEventResult =
  { ok: true; event: AuditEvent } | { ok: false; reason: AuditRefusal | 'too_large' };

const MAX_PAYLOAD_BYTES = 4096;
const MAX_STRING = 200;
const WORKLOAD_CLAIM_LIMITS: Readonly<Record<string, number>> = {
  workflow: 255,
  repository: 140,
  environment: 255,
  ref: 1024,
  ref_pattern: 255,
  repository_id: 20,
  repository_owner_id: 20,
  repository_visibility: 8,
};

function cleanWorkloadClaim(value: unknown, field: string, limit: number): Cleaned {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit)
    return { ok: false, reason: 'bad_value' };
  const valid =
    field === 'repository'
      ? /^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(value)
      : field === 'workflow'
        ? isWorkflowFilename(value)
        : field === 'environment'
          ? !/\p{Cc}/u.test(value)
          : field === 'ref' || field === 'ref_pattern'
            ? /^[^\s\p{Cc}]+$/u.test(value)
            : field === 'repository_visibility'
              ? ['public', 'private', 'internal'].includes(value)
              : /^[1-9][0-9]*$/.test(value);
  if (!valid) return { ok: false, reason: 'bad_value' };
  // UUIDs are verified workflow/ref identifiers; other credential forms and e-mails remain private.
  const scanned = value.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    'identifier',
  );
  const clean = redactValue(scanned, limit, 'text');
  if (!clean.ok) return clean;
  return clean.value === scanned ? { ok: true, value } : { ok: false, reason: 'bad_value' };
}
const MAX_ARRAY = 50;
const MAX_ARRAY_STRING = 100;
const CHANGE_KEYS: ReadonlySet<string> = new Set(['old', 'new']);

type Cleaned = { ok: true; value: AuditValue } | { ok: false; reason: AuditRefusal };

function cleanString(value: string, limit: number, field: string): Cleaned {
  const result = redactValue(value, limit, field);
  return result.ok ? { ok: true, value: result.value } : result;
}

function stringLimit(value: string, field: string): number {
  if ((field === 'package_name' || field === 'package') && value.length <= MAX_KEY_LENGTH) {
    for (const ecosystem of field === 'package'
      ? (['npm'] as const)
      : (['composer', 'npm'] as const)) {
      try {
        if (
          displayName(packageKey(value, { ecosystem, legacyCase: ecosystem === 'npm' })) === value
        )
          return MAX_KEY_LENGTH;
      } catch {
        // The other ecosystem may accept this name.
      }
    }
  }
  if (field === 'version' && /^[0-9A-Za-z][0-9A-Za-z.+_~/-]{0,255}$/.test(value)) return 256;
  return MAX_STRING;
}

function cleanValue(value: unknown, field: string): Cleaned {
  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'bad_value' };
  }
  if (typeof value === 'string') return cleanString(value, stringLimit(value, field), field);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return { ok: false, reason: 'bad_value' };
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, reason: 'bad_value' };
      const cleaned = cleanString(item, MAX_ARRAY_STRING, field);
      if (!cleaned.ok) return cleaned;
      items.push(cleaned.value as string);
    }
    return { ok: true, value: items };
  }
  return { ok: false, reason: 'bad_value' };
}

/** A provider id is an operator-configured identifier held to the config grammar, not a secret. */
function cleanProviderId(value: unknown): Cleaned {
  return typeof value === 'string' && isValidProviderId(value)
    ? { ok: true, value }
    : { ok: false, reason: 'bad_value' };
}

const AUDIT_CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  'audit.export',
  'audit.mode_change',
  'audit.sink_admin',
]);
const AUDIT_CONTROL_ENUMS: Record<string, readonly string[]> = {
  format: ['api', 'jsonl'],
  from_mode: ['trail', 'export', 'none'],
  to_mode: ['trail', 'export', 'none'],
  source: ['build', 'env', 'cli'],
  policy: ['availability', 'required'],
  alert_code: AUDIT_ALERT_CODES,
  operation: [
    'alert_ack',
    'resolve',
    'rebind',
    'retire',
    'unblock',
    'skip',
    'replay',
    'confirm_restore',
    'policy_set',
    'epoch_bump',
    'chain_reset',
  ],
};
const AUDIT_CONTROL_INTEGERS: ReadonlySet<string> = new Set([
  'from_seq',
  'to_seq',
  'count',
  'withheld',
  'mode_generation',
  'cutover_seq',
  'epoch',
  'generation',
  'revision',
]);

function cleanAuditControlValue(value: unknown, field: string): Cleaned {
  const values = AUDIT_CONTROL_ENUMS[field];
  if (values !== undefined) {
    return typeof value === 'string' && values.includes(value)
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  if (field === 'sink_id') {
    return value === null ||
      (typeof value === 'string' && /^[a-z0-9-]{1,32}$/.exec(value)?.[0] === value)
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  if (field === 'reason_code') {
    return typeof value === 'string' && /^[a-z][a-z_]{0,31}$/.exec(value)?.[0] === value
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  if (AUDIT_CONTROL_INTEGERS.has(field)) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  return cleanValue(value, field);
}

export const LOGIN_FAILURE_METHODS = ['local', 'oidc', 'cloudflare_access', 'reauth'] as const;
export const LOGIN_FAILURE_REASONS = [
  'bad_credentials',
  'unknown_account',
  'blocked',
  'suspended',
  'provider_error',
  'state_mismatch',
  'expired',
] as const;

function cleanFailureValue(value: unknown, field: string): Cleaned {
  if (field === 'permission' && value === null) return { ok: true, value: null };
  const enums: Record<string, readonly string[]> = {
    method: LOGIN_FAILURE_METHODS,
    reason: LOGIN_FAILURE_REASONS,
    boundary: ['organization', 'project', 'authenticated'],
    permission: PERMISSIONS.map(({ name }) => name),
  };
  if (field === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  if (field === 'window_start') {
    return typeof value === 'string' &&
      isUtcTimestamp(value) &&
      new Date(value).toISOString() === value
      ? { ok: true, value }
      : { ok: false, reason: 'bad_value' };
  }
  return typeof value === 'string' && (enums[field]?.includes(value) ?? false)
    ? { ok: true, value }
    : { ok: false, reason: 'bad_value' };
}

function isFailureAction(action: AuditAction): boolean {
  return action === 'session.login_failed' || action === 'access.denied';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const ACTOR_TYPES: readonly unknown[] = ['user', 'service_principal', 'customer', 'system'];
const TOKEN_SELECTOR = /^[a-z2-7]{12}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_CHARS = /^[0-9a-fA-F:.]+$/;

export function isIpLiteral(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (IPV4.test(value)) return true;
  if (!value.includes(':') || !IPV6_CHARS.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname !== '';
  } catch {
    return false;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isBrokerId(value: unknown): boolean {
  return typeof value === 'string' && (isUlid(value) || UUID.test(value));
}

function isUtcTimestamp(value: unknown): boolean {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function envelopeString(value: unknown, field: string, nullable: boolean): AuditRefusal | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value === '') return 'bad_value';
  const cleaned = cleanString(value, MAX_STRING, field);
  if (!cleaned.ok) return cleaned.reason;
  return cleaned.value === value ? null : 'bad_value';
}

function checkEnvelope(input: AuditEventInput): AuditRefusal | null {
  const actorType: unknown = input.actor?.type;
  if (!ACTOR_TYPES.includes(actorType)) return 'bad_value';
  const context: unknown = input.context;
  if (!isPlainObject(context)) return 'bad_value';
  const checks: Array<[unknown, string, boolean]> = [
    [context.opId, 'id', actorType === 'system'],
    [context.requestId, 'id', actorType === 'system'],
    [input.id, 'id', false],
    [input.now, 'now', false],
    [input.actor.id, 'id', true],
    [input.target?.type, 'target_type', false],
    [input.target?.id, 'id', true],
    [input.projectId ?? null, 'id', true],
  ];
  for (const [value, field, nullable] of checks) {
    const refusal = envelopeString(value, field, nullable);
    if (refusal !== null) return refusal;
  }
  if (
    (context.opId !== null && !isBrokerId(context.opId)) ||
    (context.requestId !== null && !isBrokerId(context.requestId))
  )
    return 'bad_value';
  if (!isUtcTimestamp(input.now)) return 'bad_value';
  if (context.tokenSelector !== null && !TOKEN_SELECTOR.test(String(context.tokenSelector))) {
    return 'bad_value';
  }
  if (context.sourceIp !== null && !isIpLiteral(context.sourceIp)) return 'bad_value';
  return null;
}

const POLICY_CHANGED_FIELDS: ReadonlySet<string> = new Set([
  'min_age_seconds',
  'client_min_version',
  'deny_unknown',
  'reason_code',
  'incident_id',
  'expires_at',
  'disabled',
  'members',
]);
const POLICY_READ_KINDS: readonly string[] = ['version', 'tag', 'dist'];
const POLICY_DENIAL_REASONS =
  'min_age|blocked|not_allowlisted|quarantined|client_floor|restricted|client_unsupported';
const POLICY_RULE_REASON = new RegExp(
  `^rule:[0-9A-HJKMNP-TV-Z]{26}:[1-9][0-9]{0,9}:(?:${POLICY_DENIAL_REASONS})$`,
);
const POLICY_PLUGIN_REASON = new RegExp(
  `^plugin:[a-z0-9][a-z0-9._@/-]{0,63}:(?:${POLICY_DENIAL_REASONS})$`,
);
const POLICY_IDENTIFIER = POLICY_PROJECT_ID;
const MAX_POLICY_REASONS = 32;

function bounded(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Policy events carry identifiers, enums and counts only; nothing a request could fill freely. */
function cleanPolicyValue(field: string, value: unknown): Cleaned {
  const ok = { ok: true as const, value: value as AuditValue };
  const bad = { ok: false as const, reason: 'bad_value' as const };
  const member = (list: readonly string[]) =>
    typeof value === 'string' && list.includes(value) ? ok : bad;
  switch (field) {
    case 'kind':
      return member(POLICY_RULE_KINDS);
    case 'ecosystem':
      return member(POLICY_ECOSYSTEMS);
    case 'client_family':
      return value === null ? ok : member(POLICY_CLIENT_FAMILIES);
    case 'reason_code':
      return member(POLICY_REASON_CODES);
    case 'override_reason':
      return member(POLICY_OVERRIDE_REASONS);
    case 'read_kind':
      return member(POLICY_READ_KINDS);
    case 'scope':
      return member(['organization', 'project']);
    case 'package_key':
      return value === null ||
        isPolicyPackageKey('npm', value) ||
        isPolicyPackageKey('composer', value)
        ? ok
        : bad;
    case 'project_id':
    case 'version_id':
      if (value === null) return ok;
      return typeof value === 'string' && POLICY_IDENTIFIER.test(value)
        ? cleanString(value, MAX_STRING, field)
        : bad;
    case 'incident_id':
      return value === null || (typeof value === 'string' && isUlid(value)) ? ok : bad;
    case 'client_min_version':
      return value === null || isPolicyClientVersion(value) ? ok : bad;
    case 'expires_at':
      return value === null || isPolicyTimestamp(value) ? ok : bad;
    case 'deny_unknown':
      return typeof value === 'boolean' ? ok : bad;
    case 'min_age_seconds':
      return value === null || bounded(value, 0, MAX_MIN_AGE_SECONDS) ? ok : bad;
    case 'revision':
    case 'version_revision':
      return bounded(value, 1, Number.MAX_SAFE_INTEGER) ? ok : bad;
    case 'member_count':
    case 'members_added':
    case 'members_removed':
    case 'result_count':
      return bounded(value, 0, field === 'result_count' ? 10_000 : MAX_POLICY_MEMBERS) ? ok : bad;
    case 'changed_fields':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every((name) => typeof name === 'string' && POLICY_CHANGED_FIELDS.has(name)) &&
        new Set(value).size === value.length
        ? ok
        : bad;
    case 'reasons':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAX_POLICY_REASONS &&
        value.every(
          (entry) =>
            typeof entry === 'string' &&
            (POLICY_RULE_REASON.test(entry) || POLICY_PLUGIN_REASON.test(entry)),
        ) &&
        new Set(value).size === value.length
        ? ok
        : bad;
    default:
      return bad;
  }
}

const POLICY_OVERRIDES: ReadonlySet<string> = new Set([
  'registry_policy.disable',
  'registry_policy.release',
]);

/**
 * A disable, a release, a block or quarantine member removal and the first member of an empty
 * block name their fixed reason; emptying a block covers every version again and is no removal.
 * A member replacement without its rule kind cannot be judged and is refused.
 */
function missingOverrideReason(
  action: AuditAction,
  changes: Record<string, Record<string, AuditValue>>,
): boolean {
  const kind = changes.kind?.new;
  if (action === 'registry_policy.members_replace' && kind === undefined) return true;
  if (changes.override_reason?.new !== undefined) return false;
  if (POLICY_OVERRIDES.has(action)) return true;
  if (action !== 'registry_policy.members_replace') return false;
  const removed = changes.members_removed?.new;
  const count = changes.member_count;
  if (kind === 'block' && count?.new === 0) return false;
  if (kind === 'block' && count?.old === 0 && typeof count.new === 'number' && count.new > 0) {
    return true;
  }
  return (kind === 'block' || kind === 'quarantine') && typeof removed === 'number' && removed > 0;
}

const NPM_AUDIT_ACTIONS = new Set<string>([
  'package.publish',
  'package.deprecate',
  'package.dist_tag',
  'package.unpublish',
  'package.access_update',
  'package.access_request',
  'package.access_decide',
  'publish.approve',
  'publish.reject',
  'publish.expire',
  'publish.scan',
  'token.workload_issue',
  'trusted_publisher.create',
  'trusted_publisher.update',
  'trusted_publisher.disable',
]);

function cleanNpmValue(value: unknown, field: string, action: AuditAction): Cleaned {
  if (typeof value === 'string') {
    if (/\p{Cc}/u.test(value)) return { ok: false, reason: 'bad_value' };
    const clean = cleanString(value, field === 'package' ? MAX_KEY_LENGTH : 256, field);
    if (!clean.ok) return clean;
    if (clean.value !== value) return { ok: false, reason: 'bad_value' };
  }
  let valid: boolean;
  switch (field) {
    case 'package':
      try {
        valid =
          typeof value === 'string' &&
          (isUlid(value) ||
            ((action === 'package.access_request' || action === 'package.access_decide') &&
              isPolicyPackageKey('composer', value)) ||
            displayName(packageKey(value, { ecosystem: 'npm', legacyCase: true })) === value);
      } catch {
        valid = false;
      }
      break;
    case 'version':
      if (value === null) return { ok: true, value: null };
      valid = typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,255}$/.test(value);
      break;
    case 'versions':
      valid =
        Array.isArray(value) &&
        value.length <= 64 &&
        value.every(
          (item) => typeof item === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,255}$/.test(item),
        );
      break;
    case 'tag':
      valid = typeof value === 'string' && validDistTag(value);
      break;
    case 'authority':
      valid = oneOf(['project', 'organization'])(value);
      break;
    case 'hold_approval':
    case 'hold_scan':
    case 'visible_to_new_projects':
      valid = typeof value === 'boolean';
      break;
    case 'new_project_access_mode':
      valid = oneOf(['none', 'request'])(value);
      break;
    case 'state':
      valid = oneOf(['pending', 'approved', 'rejected', 'expired'])(value);
      break;
    case 'verdict':
      valid = oneOf([
        'allow',
        'deny',
        'not_required',
        'queued',
        'running',
        'allowed',
        'denied',
        'failed',
      ])(value);
      break;
    case 'size_bytes':
    case 'removed_version_count':
      valid = count(0, Number.MAX_SAFE_INTEGER)(value);
      break;
    case 'source':
    case 'token_id':
    case 'trusted_publisher_id':
    case 'project_id':
      valid = typeof value === 'string' && POLICY_PROJECT_ID.test(value);
      break;
    case 'expires_at':
      valid = isPolicyTimestamp(value);
      break;
    case 'plugin':
      valid = typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
      break;
    default:
      return { ok: false, reason: 'bad_value' };
  }
  if (!valid) return { ok: false, reason: 'bad_value' };
  // Names and versions still pass the credential and e-mail detector.
  return typeof value === 'string'
    ? cleanString(value, field === 'package' ? MAX_KEY_LENGTH : 256, field)
    : { ok: true, value: value as AuditValue };
}

function specializedPrivacyRefusal(
  action: AuditAction,
  field: string,
  value: unknown,
): AuditRefusal | null {
  if (
    (action.startsWith('notification.') ||
      action.startsWith('policy.') ||
      action.startsWith('registry_policy.') ||
      NPM_AUDIT_ACTIONS.has(action)) &&
    WORKLOAD_CLAIM_LIMITS[field] === undefined &&
    !(action === 'package.publish' && field === 'integrity') &&
    field !== 'reason_sha256' &&
    field !== 'deprecated_sha256'
  ) {
    const strings = Array.isArray(value) ? value : [value];
    for (const item of strings) {
      if (typeof item !== 'string') continue;
      const scanField =
        field.endsWith('_id') || field === 'source'
          ? 'id'
          : field === 'versions'
            ? 'version'
            : field;
      const scanned = cleanString(item, MAX_PAYLOAD_BYTES, scanField);
      if (!scanned.ok) return scanned.reason;
      if (scanned.value !== item) return 'bad_value';
      if (field === 'package_key') {
        try {
          const decoded = cleanString(displayName(item), MAX_KEY_LENGTH, 'package');
          if (!decoded.ok) return decoded.reason;
        } catch {
          return 'bad_value';
        }
      }
    }
  }
  return null;
}

function cleanChanges(
  action: AuditAction,
  changes: unknown,
):
  | { ok: true; value: Record<string, Record<string, AuditValue>> }
  | { ok: false; reason: AuditRefusal } {
  if (!isPlainObject(changes)) return { ok: false, reason: 'bad_value' };
  const allowed = AUDIT_FIELDS[action];
  const out: Record<string, Record<string, AuditValue>> = {};
  for (const field of Object.keys(changes)) {
    if (!allowed.includes(field)) return { ok: false, reason: 'unknown_field' };
  }
  for (const field of Object.keys(changes)) {
    const entry = changes[field];
    if (!isPlainObject(entry)) return { ok: false, reason: 'bad_value' };
    const cleanedEntry: Record<string, AuditValue> = {};
    for (const key of Object.keys(entry)) {
      if (!CHANGE_KEYS.has(key) || (isFailureAction(action) && key === 'old'))
        return { ok: false, reason: 'bad_value' };
      if (entry[key] === undefined) continue;
      const integrity = action === 'package.publish' && field === 'integrity';
      const value = entry[key];
      if (
        action === 'registered_name.update' &&
        (typeof value !== 'string' || !isValidPattern(value))
      )
        return { ok: false, reason: 'bad_value' };
      const validIntegrity =
        typeof value === 'string' &&
        /^(?:sha512-[A-Za-z0-9+/]{85}[AQgw]==|sha1-[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=)$/.test(
          value,
        );
      if (action.startsWith('registry_policy.') || action.startsWith('policy.')) {
        const cleanedPolicy = cleanPolicyValue(field, value);
        if (!cleanedPolicy.ok) return cleanedPolicy;
        const privacy = specializedPrivacyRefusal(action, field, value);
        if (privacy !== null) return { ok: false, reason: privacy };
        cleanedEntry[key] = cleanedPolicy.value;
        continue;
      }
      const workloadLimit =
        action === 'token.workload_issue' || action.startsWith('trusted_publisher.')
          ? WORKLOAD_CLAIM_LIMITS[field]
          : undefined;
      const cleaned =
        action.startsWith('trusted_publisher.') && value === null
          ? { ok: true as const, value: null }
          : isFailureAction(action)
            ? cleanFailureValue(value, field)
            : AUDIT_CONTROL_ACTIONS.has(action)
              ? cleanAuditControlValue(value, field)
              : action.startsWith('notification.')
                ? cleanNotificationValue(value, field, action)
                : field === 'reason_sha256' || field === 'deprecated_sha256'
                  ? value === null ||
                    (typeof value === 'string' &&
                      value.length === 64 &&
                      /^[0-9a-f]{64}$/.test(value))
                    ? { ok: true as const, value: value as string | null }
                    : { ok: false as const, reason: 'bad_value' as const }
                  : action === 'package.deprecate' && field === 'deprecated'
                    ? typeof value === 'boolean'
                      ? { ok: true as const, value }
                      : { ok: false as const, reason: 'bad_value' as const }
                    : workloadLimit !== undefined &&
                        !(value === null && action.startsWith('trusted_publisher.'))
                      ? cleanWorkloadClaim(value, field, workloadLimit)
                      : integrity
                        ? validIntegrity
                          ? { ok: true as const, value: value as string }
                          : { ok: false as const, reason: 'bad_value' as const }
                        : field === 'provider' && IDENTITY_ACTIONS.has(action)
                          ? cleanProviderId(entry[key])
                          : NPM_AUDIT_ACTIONS.has(action)
                            ? cleanNpmValue(value, field, action)
                            : cleanValue(entry[key], field);
      if (!cleaned.ok) return cleaned;
      const privacy = specializedPrivacyRefusal(action, field, value);
      if (privacy !== null) return { ok: false, reason: privacy };
      cleanedEntry[key] = cleaned.value;
    }
    if (Object.keys(cleanedEntry).length === 0) return { ok: false, reason: 'bad_value' };
    out[field] = cleanedEntry;
  }
  if (
    action === 'audit.sink_admin' &&
    (out.operation?.old === 'alert_ack' || out.operation?.new === 'alert_ack')
  ) {
    if (
      out.operation?.new !== 'alert_ack' ||
      out.sink_id !== undefined ||
      out.alert_code?.new === undefined ||
      out.revision?.new === undefined
    )
      return { ok: false, reason: 'bad_value' };
  }
  if (missingOverrideReason(action, out)) return { ok: false, reason: 'bad_value' };
  return { ok: true, value: out };
}

export function auditEnvelopeRefusal(input: AuditEventInput): AuditRefusal | null {
  const action: unknown = input.action;
  if (typeof action !== 'string' || !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return 'unknown_action';
  }
  const envelope = checkEnvelope(input);
  if (envelope !== null) return envelope;
  if (isFailureAction(input.action)) {
    if (
      !isUlid(input.id) ||
      input.context.tokenSelector !== null ||
      (input.actor.id !== null && !isUlid(input.actor.id)) ||
      (input.projectId != null && !isUlid(input.projectId))
    ) {
      return 'bad_value';
    }
    if (input.action === 'session.login_failed') {
      if (
        input.target.type !== 'session' ||
        input.target.id !== null ||
        !(
          (input.actor.type === 'system' && input.actor.id === null) ||
          (input.actor.type === 'user' && input.actor.id !== null)
        )
      ) {
        return 'bad_value';
      }
    } else if (
      input.actor.type === 'system' ||
      input.actor.id === null ||
      input.target.type !== 'route' ||
      typeof input.target.id !== 'string' ||
      (input.target.id !== '/' &&
        !/^\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))*$/.test(
          input.target.id,
        ))
    ) {
      return 'bad_value';
    }
  }
  return null;
}

export function auditEvent(input: AuditEventInput): AuditEventResult {
  const envelope = auditEnvelopeRefusal(input);
  if (envelope !== null) return { ok: false, reason: envelope };
  if (isFailureAction(input.action)) {
    if (
      input.changes === undefined ||
      !AUDIT_FIELDS[input.action].every((field) => input.changes?.[field]?.new !== undefined)
    ) {
      return { ok: false, reason: 'bad_value' };
    }
  }
  const payload: Record<string, unknown> = {
    op_id: input.context.opId,
    request_id: input.context.requestId,
  };
  if (
    input.changes === undefined &&
    (POLICY_OVERRIDES.has(input.action) || input.action === 'registry_policy.members_replace')
  ) {
    return { ok: false, reason: 'bad_value' };
  }
  if (input.changes !== undefined) {
    const changes = cleanChanges(input.action, input.changes);
    if (!changes.ok) return changes;
    payload.changes = changes.value;
  }
  const payloadJson = sortedJson(payload);
  if (new TextEncoder().encode(payloadJson).length > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  return {
    ok: true,
    event: {
      id: input.id,
      occurredAt: input.now,
      action: input.action,
      actor: { type: input.actor.type, id: input.actor.id },
      tokenSelector: input.context.tokenSelector,
      sourceIp: input.context.sourceIp,
      target: { type: input.target.type, id: input.target.id },
      projectId: input.projectId ?? null,
      payloadJson,
    },
  };
}

export function validateAuditEvent(event: AuditEvent): AuditEvent {
  try {
    const payload: unknown = JSON.parse(event.payloadJson);
    if (
      !isPlainObject(payload) ||
      Object.keys(payload).some((key) => !['op_id', 'request_id', 'changes'].includes(key))
    )
      throw new TypeError('invalid audit event');
    const result = auditEvent({
      id: event.id,
      now: event.occurredAt,
      action: event.action,
      actor: event.actor,
      target: event.target,
      projectId: event.projectId,
      context: {
        opId: payload.op_id as string,
        requestId: payload.request_id as string,
        sourceIp: event.sourceIp,
        tokenSelector: event.tokenSelector,
      },
      ...(payload.changes === undefined
        ? {}
        : { changes: payload.changes as NonNullable<AuditEventInput['changes']> }),
    });
    if (!result.ok || result.event.payloadJson !== sortedJson(payload))
      throw new TypeError('invalid audit event');
    return result.event;
  } catch {
    throw new TypeError('invalid audit event');
  }
}
