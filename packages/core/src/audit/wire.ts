import { isUlid, ulid } from '../ids.js';
import {
  AUDIT_ACTIONS,
  auditEvent,
  isIpLiteral,
  type AuditAction,
  type AuditEventInput,
} from './actions.js';
import type { AuditRow } from './chain.js';
import type { AuditJournalItemV1, AuditMarkerV1, AuditRecordV1 } from './plugin-api.js';
import { redactValue } from './redact.js';

export interface AuditWireIdentity {
  readonly chainId: string;
  readonly epoch: number;
  readonly orgId: string;
}

type MarkerFields<T> = T extends AuditMarkerV1
  ? Omit<T, 'chainId' | 'epoch' | 'orgId' | 'markerId'>
  : never;
export type AuditMarkerFields = MarkerFields<AuditMarkerV1>;

const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELECTOR = /^[a-z2-7]{12}$/;
const ACTORS = ['user', 'service_principal', 'customer', 'system'];
const ERROR_CODES = ['network', 'timeout', 'refused', 'too_large', 'http_status', 'bad_response'];
const WITHHELD_REASON = 'content_unavailable';

function assert(value: boolean): asserts value {
  if (!value) throw new TypeError('Invalid audit wire data');
}

function id(value: unknown): boolean {
  return typeof value === 'string' && value.length === 26 && isUlid(value);
}

function nullableId(value: unknown): boolean {
  return value === null || id(value);
}

function seq(value: unknown, minimum = 0): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function hash(value: unknown): boolean {
  return typeof value === 'string' && value.length === 64 && HASH.test(value);
}

function text(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const cleaned = redactValue(value, 200, 'text');
  return cleaned.ok && cleaned.value === value;
}

function timestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function identity(input: AuditWireIdentity): void {
  assert(id(input.chainId) && id(input.orgId) && seq(input.epoch));
}

function safeFields(row: Record<string, unknown>): void {
  assert(id(row['id']) && seq(row['seq'], 1));
  assert(hash(row['prevHash']) && hash(row['hash']) && timestamp(row['createdAt']));
  assert(typeof row['actorType'] === 'string' && ACTORS.includes(row['actorType']));
  assert(nullableId(row['actorId']) && nullableId(row['targetId']) && nullableId(row['projectId']));
  assert(
    typeof row['action'] === 'string' &&
      (AUDIT_ACTIONS as readonly string[]).includes(row['action']),
  );
  assert(
    typeof row['targetType'] === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/.exec(row['targetType'])?.[0] === row['targetType'] &&
      text(row['targetType']),
  );
}

/** Creates an unsigned marker with a fresh identity and projects only its declared fields. */
export function auditWireMarker(
  scope: AuditWireIdentity,
  fields: AuditMarkerFields,
): AuditMarkerV1 {
  identity(scope);
  const base = {
    chainId: scope.chainId,
    epoch: scope.epoch,
    markerId: ulid(),
  };
  if (fields.kind === 'withheld' && base.markerId === fields.id) base.markerId = ulid();
  switch (fields.kind) {
    case 'boundary':
      assert(
        seq(fields.boundarySeq, 1) && hash(fields.boundaryPrevHash) && text(fields.provenance),
      );
      assert(fields.priorArchiveHint === undefined || text(fields.priorArchiveHint));
      return Object.freeze({
        ...base,
        kind: fields.kind,
        boundarySeq: fields.boundarySeq,
        boundaryPrevHash: fields.boundaryPrevHash,
        provenance: fields.provenance,
        ...(fields.priorArchiveHint === undefined
          ? {}
          : { priorArchiveHint: fields.priorArchiveHint }),
      });
    case 'gap':
      assert(
        seq(fields.fromSeq, 1) &&
          seq(fields.toSeq, fields.fromSeq) &&
          seq(fields.count, 1) &&
          fields.count === fields.toSeq - fields.fromSeq + 1,
      );
      assert(
        hash(fields.prevHash) &&
          hash(fields.hash) &&
          fields.reason === 'capacity' &&
          seq(fields.policyGeneration),
      );
      return Object.freeze({
        ...base,
        kind: fields.kind,
        fromSeq: fields.fromSeq,
        toSeq: fields.toSeq,
        count: fields.count,
        prevHash: fields.prevHash,
        hash: fields.hash,
        reason: fields.reason,
        policyGeneration: fields.policyGeneration,
      });
    case 'tombstone':
      assert(
        seq(fields.seq, 1) &&
          hash(fields.prevHash) &&
          hash(fields.hash) &&
          ERROR_CODES.includes(fields.reasonCode),
      );
      return Object.freeze({
        ...base,
        kind: fields.kind,
        seq: fields.seq,
        prevHash: fields.prevHash,
        hash: fields.hash,
        reasonCode: fields.reasonCode,
      });
    case 'delivery_uncertain':
      assert(
        seq(fields.fromSeq, 1) &&
          seq(fields.toSeq, fields.fromSeq) &&
          fields.reasonCode === 'partial_rejected' &&
          hash(fields.hash),
      );
      return Object.freeze({
        ...base,
        kind: fields.kind,
        fromSeq: fields.fromSeq,
        toSeq: fields.toSeq,
        hash: fields.hash,
        reasonCode: fields.reasonCode,
      });
    case 'withheld':
      safeFields(fields as unknown as Record<string, unknown>);
      assert(fields.reasonCode === WITHHELD_REASON);
      return Object.freeze({
        ...base,
        kind: fields.kind,
        reasonCode: fields.reasonCode,
        orgId: scope.orgId,
        id: fields.id,
        seq: fields.seq,
        prevHash: fields.prevHash,
        hash: fields.hash,
        createdAt: fields.createdAt,
        actorType: fields.actorType,
        actorId: fields.actorId,
        action: fields.action,
        targetType: fields.targetType,
        targetId: fields.targetId,
        projectId: fields.projectId,
      });
    case 'fork':
      assert(seq(fields.lastCommonSeq) && hash(fields.lastCommonHash));
      return Object.freeze({
        ...base,
        kind: fields.kind,
        lastCommonSeq: fields.lastCommonSeq,
        lastCommonHash: fields.lastCommonHash,
      });
    case 'receiver_changed':
      assert(hash(fields.oldFingerprint) && hash(fields.newFingerprint));
      return Object.freeze({
        ...base,
        kind: fields.kind,
        oldFingerprint: fields.oldFingerprint,
        newFingerprint: fields.newFingerprint,
      });
    case 'head':
      assert(
        seq(fields.seq) &&
          hash(fields.hash) &&
          seq(fields.boundarySeq, 1) &&
          fields.boundarySeq <= fields.seq + 1,
      );
      return Object.freeze({
        ...base,
        kind: fields.kind,
        seq: fields.seq,
        hash: fields.hash,
        boundarySeq: fields.boundarySeq,
      });
    default:
      throw new TypeError('Invalid audit wire data');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// SQLite json_set preserves existing key order and appends new keys. Preserve that
// order in the sanitized output without restoring any keys removed by the sanitizer.
function storedOrder(clean: unknown, stored: unknown): unknown {
  if (!object(clean) || !object(stored)) return clean;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(stored)) {
    if (Object.hasOwn(clean, key)) result[key] = storedOrder(clean[key], stored[key]);
  }
  for (const key of Object.keys(clean)) {
    if (!Object.hasOwn(result, key)) result[key] = clean[key];
  }
  return result;
}

function payloadMatches(row: AuditRow): boolean {
  if (
    typeof row.payload_json !== 'string' ||
    new TextEncoder().encode(row.payload_json).length > 4096
  )
    return false;
  try {
    const payload: unknown = JSON.parse(row.payload_json);
    if (!object(payload)) return false;
    const clean = auditEvent({
      id: row.id,
      now: row.created_at,
      action: row.action as AuditAction,
      actor: { type: row.actor_type, id: row.actor_id },
      target: { type: row.target_type, id: row.target_id },
      projectId: row.project_id,
      context: {
        opId: payload['op_id'] as string,
        requestId: payload['request_id'] as string,
        tokenSelector: row.token_selector,
        sourceIp: row.source_ip,
      },
      ...(payload['changes'] === undefined
        ? {}
        : { changes: payload['changes'] as NonNullable<AuditEventInput['changes']> }),
    });
    return (
      clean.ok &&
      JSON.stringify(storedOrder(JSON.parse(clean.event.payloadJson), payload)) === row.payload_json
    );
  } catch {
    return false;
  }
}

/** Invalid envelopes fail closed; changed or refused payloads become safe withheld markers. */
export function auditWireRecord(
  scope: AuditWireIdentity,
  row: AuditRow,
  sourceIp: 'include' | 'omit' = 'include',
): AuditJournalItemV1 {
  identity(scope);
  assert(row.org_id === scope.orgId);
  const record = recordFields(scope, row);
  safeFields(record as unknown as Record<string, unknown>);
  assert(
    row.token_selector === null ||
      (typeof row.token_selector === 'string' &&
        row.token_selector.length === 12 &&
        SELECTOR.test(row.token_selector)),
  );
  assert(
    row.source_ip === null ||
      (typeof row.source_ip === 'string' &&
        /^[0-9a-fA-F:.]+$/.exec(row.source_ip)?.[0] === row.source_ip &&
        isIpLiteral(row.source_ip)),
  );
  assert(sourceIp === 'include' || sourceIp === 'omit');
  if (!payloadMatches(row)) {
    const marker = auditWireMarker(scope, {
      ...record,
      kind: 'withheld',
      reasonCode: WITHHELD_REASON,
    });
    assert(marker.kind === 'withheld');
    return marker;
  }
  return Object.freeze({
    ...record,
    ...(sourceIp === 'include' && row.source_ip !== null ? { sourceIp: row.source_ip } : {}),
  });
}

function recordFields(scope: AuditWireIdentity, row: AuditRow): AuditRecordV1 {
  return {
    kind: 'event',
    chainId: scope.chainId,
    epoch: scope.epoch,
    id: row.id,
    orgId: row.org_id,
    seq: row.seq,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    tokenSelector: row.token_selector,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    projectId: row.project_id,
    payloadJson: row.payload_json,
  };
}
