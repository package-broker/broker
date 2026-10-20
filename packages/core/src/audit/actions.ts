import { MAX_KEY_LENGTH, packageKey } from '../catalogue/names.js';
import { isUlid } from '../ids.js';
import { redactValue } from './redact.js';

export const AUDIT_ACTIONS = [
  'session.login',
  'session.logout',
  'session.reauth',
  'setup.complete',
  'identity.unblock',
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
  'service_principal.create',
  'service_principal.permissions_set',
  'service_principal.suspend',
  'service_principal.restore',
  'source.create',
  'source.update',
  'source.pause',
  'source.resume',
  'source.credential_set',
  'source.attach',
  'source.detach',
  'source.reorder',
  'registered_name.add',
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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const GRANT_FIELDS = ['subject_kind', 'role_id'] as const;
const IMPORT_RUN_FIELDS = ['state', 'plan_hash', 'count', 'external_ref_count'] as const;
const ATTACH_FIELDS = ['project_id', 'position'] as const;
const REGISTERED_NAME_FIELDS = ['pattern'] as const;

export const AUDIT_FIELDS: Record<AuditAction, readonly string[]> = {
  'session.login': [],
  'session.logout': [],
  'session.reauth': [],
  'setup.complete': [],
  'identity.unblock': [],
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
  'service_principal.create': ['name', 'project_id', 'permissions'],
  'service_principal.permissions_set': ['permissions'],
  'service_principal.suspend': [],
  'service_principal.restore': [],
  'source.create': ['name', 'type', 'ecosystem', 'project_id', 'url'],
  'source.update': ['name', 'url', 'status', 'removal_policy'],
  'source.pause': [],
  'source.resume': [],
  'source.credential_set': ['credential_kind'],
  'source.attach': ATTACH_FIELDS,
  'source.detach': ATTACH_FIELDS,
  'source.reorder': ['positions'],
  'registered_name.add': REGISTERED_NAME_FIELDS,
  'registered_name.remove': REGISTERED_NAME_FIELDS,
  'version.state_change': ['from_status', 'to_status', 'package_name', 'version'],
  'version.rebuilt': ['package_name', 'version', 'sha256_old', 'sha256_new'],
  'version.published_at_set': ['package_name', 'version', 'published_at', 'published_at_basis'],
  'import_run.create': IMPORT_RUN_FIELDS,
  'import_run.approve': IMPORT_RUN_FIELDS,
  'import_run.apply': IMPORT_RUN_FIELDS,
  'import_run.fail': IMPORT_RUN_FIELDS,
  'import_run.verify': IMPORT_RUN_FIELDS,
  'import_run.rollback': IMPORT_RUN_FIELDS,
  'import_run.accept': IMPORT_RUN_FIELDS,
  'import_run.cancel': IMPORT_RUN_FIELDS,
  'import_run.credential_set': ['external_ref'],
  'purge.batch': ['count', 'kind'],
  'sync_session.finalize': ['source_id', 'added', 'updated', 'removed'],
};

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

export interface AuditEventInput {
  id: string;
  now: string;
  action: AuditAction;
  actor: { type: AuditActorType; id: string | null };
  context: AuditContext;
  target: { type: string; id: string | null };
  projectId?: string | null;
  changes?: Record<string, { old?: AuditValue; new?: AuditValue }>;
}

export type AuditRefusal = 'unknown_action' | 'unknown_field' | 'bad_value' | 'credential_value';

export type AuditEventResult =
  { ok: true; event: AuditEvent } | { ok: false; reason: AuditRefusal | 'too_large' };

const MAX_PAYLOAD_BYTES = 4096;
const MAX_STRING = 200;
const MAX_ARRAY = 50;
const MAX_ARRAY_STRING = 100;
const CHANGE_KEYS: ReadonlySet<string> = new Set(['old', 'new']);

type Cleaned = { ok: true; value: AuditValue } | { ok: false; reason: AuditRefusal };

function cleanString(value: string, limit: number, field: string): Cleaned {
  const result = redactValue(value, limit, field);
  return result.ok ? { ok: true, value: result.value } : result;
}

function stringLimit(value: string, field: string): number {
  if (field === 'package_name' && value.length <= MAX_KEY_LENGTH) {
    for (const ecosystem of ['composer', 'npm'] as const) {
      try {
        if (packageKey(value, { ecosystem }) === value) return MAX_KEY_LENGTH;
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

function isIpLiteral(value: unknown): boolean {
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
    [context.opId, 'id', false],
    [context.requestId, 'id', false],
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
  if (!isBrokerId(context.opId) || !isBrokerId(context.requestId)) return 'bad_value';
  if (!isUtcTimestamp(input.now)) return 'bad_value';
  if (context.tokenSelector !== null && !TOKEN_SELECTOR.test(String(context.tokenSelector))) {
    return 'bad_value';
  }
  if (context.sourceIp !== null && !isIpLiteral(context.sourceIp)) return 'bad_value';
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
      if (!CHANGE_KEYS.has(key)) return { ok: false, reason: 'bad_value' };
      if (entry[key] === undefined) continue;
      const cleaned = cleanValue(entry[key], field);
      if (!cleaned.ok) return cleaned;
      cleanedEntry[key] = cleaned.value;
    }
    if (Object.keys(cleanedEntry).length === 0) return { ok: false, reason: 'bad_value' };
    out[field] = cleanedEntry;
  }
  return { ok: true, value: out };
}

export function auditEvent(input: AuditEventInput): AuditEventResult {
  const action: unknown = input.action;
  if (typeof action !== 'string' || !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, reason: 'unknown_action' };
  }
  const envelope = checkEnvelope(input);
  if (envelope !== null) return { ok: false, reason: envelope };
  const payload: Record<string, unknown> = {
    op_id: input.context.opId,
    request_id: input.context.requestId,
  };
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
