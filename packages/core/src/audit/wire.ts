import { isUlid } from '../ids.js';
import { sha256Hex } from '../auth/primitives.js';
import {
  auditEnvelopeRefusal,
  auditEvent,
  type AuditAction,
  type AuditEventInput,
} from './actions.js';
import type { AuditRow } from './chain.js';
import type { AuditJournalItemV1, AuditMarkerV1, AuditRecordV1 } from './plugin-api.js';
import { redactValue } from './redact.js';

export const AUDIT_SANITIZER_VERSION = 1;

export interface AuditWireIdentity {
  readonly chainId: string;
  readonly epoch: number;
  readonly orgId: string;
}

type MarkerFields<T> = T extends AuditMarkerV1
  ? Omit<T, 'chainId' | 'epoch' | 'orgId' | 'markerId'> &
      (T extends { kind: 'receiver_changed' } ? { readonly custodySeq: number } : unknown)
  : never;
export type AuditMarkerFields = MarkerFields<AuditMarkerV1>;

const HASH = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[a-z][a-z_]{0,31}$/;
const WITHHELD_REASON = 'content_unavailable';

function assert(value: boolean): asserts value {
  if (!value) throw new TypeError('Invalid audit wire data');
}

function id(value: unknown): boolean {
  return typeof value === 'string' && value.length === 26 && isUlid(value);
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

function chainId(value: unknown): boolean {
  return (
    id(value) || (typeof value === 'string' && value.length === 32 && /^[0-9a-f]{32}$/.test(value))
  );
}

function identity(input: AuditWireIdentity): void {
  assert(chainId(input.chainId) && id(input.orgId) && seq(input.epoch));
}

function chainFields(row: Record<string, unknown>): void {
  assert(seq(row['seq'], 1) && hash(row['prevHash']) && hash(row['hash']));
}

function validEnvelope(row: Record<string, unknown>): boolean {
  return (
    auditEnvelopeRefusal({
      id: row['id'] as string,
      now: row['createdAt'] as string,
      actor: {
        type: row['actorType'] as AuditEventInput['actor']['type'],
        id: row['actorId'] as string | null,
      },
      action: row['action'] as AuditAction,
      target: { type: row['targetType'] as string, id: row['targetId'] as string | null },
      projectId: row['projectId'] as string | null,
      context: {
        opId: '00000000000000000000000000',
        requestId: '00000000000000000000000000',
        tokenSelector: (Object.hasOwn(row, 'tokenSelector') ? row['tokenSelector'] : null) as
          string | null,
        sourceIp: (Object.hasOwn(row, 'sourceIp') ? row['sourceIp'] : null) as string | null,
      },
    }) === null
  );
}

function safeFields(row: Record<string, unknown>): void {
  chainFields(row);
  assert(validEnvelope(row));
}

type MarkerScope = Omit<AuditWireIdentity, 'orgId'> & { readonly orgId?: string };

async function markerId(scope: MarkerScope, fields: AuditMarkerFields): Promise<string> {
  let position: readonly unknown[];
  switch (fields.kind) {
    case 'boundary':
      position = [fields.boundarySeq];
      break;
    case 'gap':
    case 'delivery_uncertain':
      position = [fields.fromSeq, fields.toSeq];
      break;
    case 'tombstone':
    case 'withheld':
    case 'head':
      position = [fields.seq];
      break;
    case 'fork':
      position = [fields.lastCommonSeq];
      break;
    case 'receiver_changed':
      assert(seq(fields.custodySeq));
      position = [fields.custodySeq, fields.oldFingerprint, fields.newFingerprint];
      break;
    default:
      throw new TypeError('Invalid audit wire data');
  }
  assert(position.every((value) => (typeof value === 'number' ? seq(value) : hash(value))));
  const digest = await sha256Hex(
    JSON.stringify([scope.chainId, scope.epoch, fields.kind, ...position]),
  );
  let bits = BigInt('0x' + digest.slice(0, 30));
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let encoded = '';
  for (let i = 0; i < 24; i++) {
    encoded = alphabet[Number(bits & 31n)] + encoded;
    bits >>= 5n;
  }
  return '00' + encoded;
}

/** Creates a stable unsigned marker; receiver custodySeq affects identity but is not emitted. */
export async function auditWireMarker(
  scope: MarkerScope,
  fields: AuditMarkerFields,
): Promise<AuditMarkerV1> {
  assert(chainId(scope.chainId) && seq(scope.epoch));
  if (scope.orgId !== undefined) assert(id(scope.orgId));
  const base = {
    chainId: scope.chainId,
    epoch: scope.epoch,
    markerId: await markerId(scope, fields),
  };
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
          typeof fields.reasonCode === 'string' &&
          REASON_CODE.exec(fields.reasonCode)?.[0] === fields.reasonCode,
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
      assert(typeof scope.orgId === 'string' && id(scope.orgId));
      if (fields.reasonCode === 'unreadable') {
        chainFields(fields as unknown as Record<string, unknown>);
        return Object.freeze({
          ...base,
          kind: fields.kind,
          reasonCode: fields.reasonCode,
          orgId: scope.orgId,
          seq: fields.seq,
          prevHash: fields.prevHash,
          hash: fields.hash,
        });
      }
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

// Accept any key order of the sanitized object, including SQLite json_set patches,
// without restoring keys removed by the sanitizer.
function storedOrder(clean: unknown, stored: unknown): unknown {
  if (!object(clean) || !object(stored)) return clean;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(stored)) {
    if (Object.hasOwn(clean, key)) result[key] = storedOrder(clean[key], stored[key]);
  }
  for (const key of Object.keys(clean)) {
    if (!Object.hasOwn(result, key)) result[key] = clean[key];
  }
  return result;
}

export function payloadMatches(row: AuditRow): boolean {
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

/** Compares stored payloads with the writer sanitizer before projecting public fields. */
export async function auditWireRecord(
  scope: AuditWireIdentity,
  row: AuditRow,
  sourceIp: 'include' | 'omit',
): Promise<AuditJournalItemV1> {
  identity(scope);
  assert(row.org_id === scope.orgId);
  const record = recordFields(scope, row);
  chainFields(record as unknown as Record<string, unknown>);
  assert(sourceIp === 'include' || sourceIp === 'omit');
  if (!validEnvelope({ ...record, sourceIp: row.source_ip })) {
    const marker = await auditWireMarker(scope, {
      kind: 'withheld',
      reasonCode: 'unreadable',
      seq: row.seq,
      prevHash: row.prev_hash,
      hash: row.hash,
    });
    assert(marker.kind === 'withheld');
    return marker;
  }
  if (!payloadMatches(row)) {
    const marker = await auditWireMarker(scope, {
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
