import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { auditEvent, type AuditAction, type AuditEventInput } from './actions.js';
import { canonicalRow, type AuditRow } from './chain.js';
import { isUlid } from '../ids.js';
import { auditWireMarker, auditWireRecord, type AuditMarkerFields } from './wire.js';

const ID = '01JZZZZZZZZZZZZZZZZZZZZZZY';
const ORG = '01JZZZZZZZZZZZZZZZZZZZZZZX';
const scope = { chainId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', epoch: 1, orgId: ORG };
const now = '2026-10-28T00:00:00.000Z';

function row(
  action: AuditAction = 'session.logout',
  changes?: AuditEventInput['changes'],
): AuditRow {
  const result = auditEvent({
    id: ID,
    now,
    action,
    actor: { type: 'user', id: ID },
    context: { opId: ID, requestId: ID, sourceIp: '127.0.0.1', tokenSelector: 'abcdefghijkl' },
    target: { type: 'session', id: ID },
    projectId: ID,
    ...(changes === undefined ? {} : { changes }),
  });
  if (!result.ok) throw new Error('Invalid test fixture');
  return {
    id: ID,
    org_id: ORG,
    seq: 1,
    prev_hash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    created_at: now,
    actor_type: 'user',
    actor_id: ID,
    token_selector: 'abcdefghijkl',
    source_ip: '127.0.0.1',
    action,
    target_type: 'session',
    target_id: ID,
    project_id: ID,
    payload_json: result.event.payloadJson,
  };
}

function withheld(input: AuditRow): void {
  const output = auditWireRecord(scope, input);
  expect(output).toEqual({
    chainId: scope.chainId,
    epoch: 1,
    orgId: ORG,
    markerId: expect.any(String),
    kind: 'withheld',
    reasonCode: 'content_unavailable',
    id: ID,
    seq: 1,
    prevHash: input.prev_hash,
    hash: input.hash,
    createdAt: now,
    actorType: 'user',
    actorId: ID,
    action: input.action,
    targetType: 'session',
    targetId: ID,
    projectId: ID,
  });
  expect('markerId' in output && isUlid(output.markerId)).toBe(true);
  expect('markerId' in output && output.markerId).not.toBe(ID);
  expect(Object.isFrozen(output)).toBe(true);
}

function sqlPatch(payload: string, sql: string, value: string | number): string {
  const db = new DatabaseSync(':memory:');
  try {
    return (db.prepare(sql).get(payload, value) as { payload: string }).payload;
  } finally {
    db.close();
  }
}

describe('audit wire records', () => {
  it('projects every chain field verbatim and labels source IP outside the hash input', () => {
    const input = row('role.rename', { name: { old: 'Old name', new: 'New name' } });
    const output = auditWireRecord(scope, { ...input, extra: 'hidden@example.test' } as AuditRow);
    const ip = input.source_ip;
    expect(output).toEqual({
      kind: 'event',
      chainId: scope.chainId,
      epoch: 1,
      id: input.id,
      orgId: input.org_id,
      seq: input.seq,
      prevHash: input.prev_hash,
      hash: input.hash,
      createdAt: input.created_at,
      actorType: input.actor_type,
      actorId: input.actor_id,
      tokenSelector: input.token_selector,
      action: input.action,
      targetType: input.target_type,
      targetId: input.target_id,
      projectId: input.project_id,
      payloadJson: input.payload_json,
      sourceIp: ip,
    });
    expect(Object.isFrozen(output)).toBe(true);
    if (output.kind !== 'event') throw new Error('Expected a record');
    const toRow = (record: typeof output): AuditRow => ({
      id: record.id,
      org_id: record.orgId,
      seq: record.seq,
      prev_hash: record.prevHash,
      hash: record.hash,
      created_at: record.createdAt,
      actor_type: record.actorType,
      actor_id: record.actorId,
      token_selector: record.tokenSelector,
      action: record.action,
      target_type: record.targetType,
      target_id: record.targetId,
      project_id: record.projectId,
      payload_json: record.payloadJson,
      source_ip: record.sourceIp ?? null,
    });
    expect(canonicalRow(toRow(output))).toBe(canonicalRow(input));
    const omitted = auditWireRecord(scope, input, 'omit');
    expect(omitted).not.toHaveProperty('sourceIp');
    if (omitted.kind !== 'event') throw new Error('Expected a record');
    expect(canonicalRow(toRow(omitted))).toBe(canonicalRow(input));
    expect(auditWireRecord(scope, { ...input, source_ip: null })).not.toHaveProperty('sourceIp');
  });

  it('passes the actual token json_set patch, including its appended key order', () => {
    const input = row('token.rotate', { replacement_id: { new: ID }, overlap_days: { new: 7 } });
    const payload = JSON.parse(input.payload_json);
    payload.changes = { replacement_id: { new: ID }, overlap_days: { new: 7 } };
    input.payload_json = sqlPatch(
      JSON.stringify(payload),
      "select json_set(?, '$.changes.expires_at', json_object('new', ?)) as payload",
      now,
    );
    expect(input.payload_json.indexOf('replacement_id')).toBeLessThan(
      input.payload_json.indexOf('expires_at'),
    );
    expect(auditWireRecord(scope, input)).toHaveProperty('payloadJson', input.payload_json);
  });

  it('passes the actual source-removal absent-count json_set patch', () => {
    const input = row('source.removal_applied', {
      source_id: { new: ID },
      absent: { new: 0 },
      listed: { new: 10 },
    });
    input.payload_json = sqlPatch(
      input.payload_json,
      "select json_set(?, '$.changes.absent.new', (select count(*) from json_each(?))) as payload",
      JSON.stringify(Array.from({ length: 8 }, () => null)),
    );
    expect(JSON.parse(input.payload_json).changes.absent.new).toBe(8);
    expect(auditWireRecord(scope, input)).toHaveProperty('payloadJson', input.payload_json);
  });

  it.each([
    ['invalid JSON', '{'],
    ['non-object', '[]'],
    ['null', 'null'],
    ['oversize', ' '.repeat(4097)],
    ['noncompact bytes', JSON.stringify({ op_id: ID, request_id: ID }, null, 2)],
    [
      'extra root field',
      JSON.stringify({ op_id: ID, request_id: ID, secret: 'hidden@example.test' }),
    ],
    ['duplicate key', `{"op_id":"${ID}","op_id":"${ID}","request_id":"${ID}"}`],
    ['missing request id', JSON.stringify({ op_id: ID })],
    [
      'unknown change',
      JSON.stringify({
        op_id: ID,
        request_id: ID,
        changes: { secret: { new: 'hidden@example.test' } },
      }),
    ],
  ])('withholds %s without exposing payload, selector or IP', (_label, payload) => {
    withheld({ ...row(), payload_json: payload });
  });

  it.each([
    'hidden@example.test',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'https://user:password@host.test/repo?token=secret',
  ])('withholds refused or transformed content', (value) => {
    const input = row('source.update', { url: { new: 'https://host.test/repo' } });
    const payload = JSON.parse(input.payload_json);
    payload.changes.url.new = value;
    withheld({ ...input, payload_json: JSON.stringify(payload) });
  });

  it.each([
    ['id', 'bad'],
    ['id', ID + '\n'],
    ['hash', 'a'.repeat(64) + '\n'],
    ['token_selector', 'abcdefghijkl\n'],
    ['target_type', 'session\n'],
    ['org_id', ID],
    ['seq', 0],
    ['seq', 1.5],
    ['seq', Number.MAX_SAFE_INTEGER + 1],
    ['prev_hash', 'a'.repeat(63)],
    ['hash', 'A'.repeat(64)],
    ['created_at', '2026-02-30T00:00:00.000Z'],
    ['created_at', '2026-10-28T00:00:00Z'],
    ['actor_type', 'admin'],
    ['actor_id', 'hidden@example.test'],
    ['target_id', 'bad'],
    ['project_id', 'bad'],
    ['action', 'unknown.action'],
    ['target_type', 'hidden@example.test'],
    ['token_selector', 'abcdefghijklmnop'],
    ['source_ip', 'host.test'],
    ['source_ip', '127.0.0.1\n'],
    ['source_ip', '::1\n'],
    ['source_ip', '127.0.0.1:80'],
  ])('rejects invalid envelope field %s with a fixed error', (field, value) => {
    expect(() => auditWireRecord(scope, { ...row(), [field]: value })).toThrow(
      new TypeError('Invalid audit wire data'),
    );
  });

  it('validates envelope fields even when payloads are withheld or source IP omitted', () => {
    expect(() =>
      auditWireRecord(scope, { ...row(), payload_json: '{', actor_id: 'hidden@example.test' }),
    ).toThrow('Invalid audit wire data');
    expect(() =>
      auditWireRecord(scope, { ...row(), source_ip: 'hidden@example.test' }, 'omit'),
    ).toThrow('Invalid audit wire data');
    expect(auditWireRecord(scope, { ...row(), source_ip: '::1' })).toHaveProperty(
      'sourceIp',
      '::1',
    );
    expect(
      auditWireRecord(scope, {
        ...row(),
        actor_type: 'system',
        actor_id: null,
        target_id: null,
        project_id: null,
        token_selector: null,
      }),
    ).toHaveProperty('actorId', null);
  });

  it.each([
    { ...scope, orgId: 'bad' },
    { ...scope, chainId: 'bad' },
    { ...scope, epoch: -1 },
    { ...scope, epoch: 1.5 },
  ])('rejects invalid chain scope', (invalid) => {
    expect(() => auditWireRecord(invalid, row())).toThrow('Invalid audit wire data');
  });
});

const markers: AuditMarkerFields[] = [
  {
    kind: 'boundary',
    boundarySeq: 1,
    boundaryPrevHash: '0'.repeat(64),
    provenance: 'retained',
    priorArchiveHint: 'archive',
  },
  {
    kind: 'gap',
    fromSeq: 1,
    toSeq: 2,
    count: 2,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    reason: 'capacity',
    policyGeneration: 1,
  },
  {
    kind: 'tombstone',
    seq: 1,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    reasonCode: 'http_status',
  },
  {
    kind: 'delivery_uncertain',
    fromSeq: 1,
    toSeq: 2,
    hash: 'a'.repeat(64),
    reasonCode: 'partial_rejected',
  },
  {
    id: ID,
    seq: 1,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    createdAt: now,
    actorType: 'user',
    actorId: ID,
    action: 'session.logout',
    targetType: 'session',
    targetId: ID,
    projectId: ID,
    kind: 'withheld',
    reasonCode: 'content_unavailable',
  },
  { kind: 'fork', lastCommonSeq: 0, lastCommonHash: '0'.repeat(64) },
  { kind: 'receiver_changed', oldFingerprint: 'a'.repeat(64), newFingerprint: 'b'.repeat(64) },
  { kind: 'head', seq: 0, hash: '0'.repeat(64), boundarySeq: 1 },
];

describe('audit wire markers', () => {
  it.each(markers)(
    'creates a distinct immutable $kind marker and strips undeclared fields',
    (fields) => {
      const output = auditWireMarker(scope, {
        ...fields,
        markerId: ID,
        payloadJson: 'hidden@example.test',
        sourceIp: '127.0.0.1',
        tokenSelector: 'abcdefghijkl',
      } as unknown as AuditMarkerFields);
      expect(output).toEqual({
        ...fields,
        markerId: expect.any(String),
        chainId: scope.chainId,
        epoch: 1,
        ...(fields.kind === 'withheld' ? { orgId: ORG } : {}),
        kind: fields.kind,
      });
      expect(isUlid(output.markerId)).toBe(true);
      expect(output.markerId).not.toBe(ID);
      expect(output.markerId).not.toBe(auditWireMarker(scope, fields).markerId);
      expect(output).not.toHaveProperty('payloadJson');
      expect(output).not.toHaveProperty('sourceIp');
      expect(output).not.toHaveProperty('tokenSelector');
      expect(Object.isFrozen(output)).toBe(true);
    },
  );

  it.each([
    { ...markers[0], provenance: 'hidden@example.test' },
    { ...markers[0], priorArchiveHint: 'https://user:password@host.test/' },
    { ...markers[1], count: 3 },
    { ...markers[1], fromSeq: 3 },
    { ...markers[1], policyGeneration: -1 },
    { ...markers[2], reasonCode: 'hidden@example.test' },
    { ...markers[3], reasonCode: 'hidden@example.test' },
    { ...markers[3], toSeq: 0 },
    { ...markers[3], hash: 'bad' },
    { ...markers[4], reasonCode: 'hidden@example.test' },
    { ...markers[4], actorId: 'hidden@example.test' },
    { ...markers[5], lastCommonHash: 'bad' },
    { ...markers[6], newFingerprint: 'hidden@example.test' },
    { ...markers[7], boundarySeq: 2 },
    { kind: 'unknown' },
  ])('rejects malformed markers without echoing data', (invalid) => {
    expect(() => auditWireMarker(scope, invalid as AuditMarkerFields)).toThrow(
      new TypeError('Invalid audit wire data'),
    );
  });
});
