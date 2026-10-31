import type { AuditRow } from './chain.js';
import type {
  AuditBatchV1,
  AuditBoundFetch,
  AuditDelivery,
  AuditMarkerV1,
  AuditPositionV1,
  AuditRecordV1,
  AuditSink,
  AuditSinkContext,
} from './plugin-api.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface AuditCanonicalVector {
  readonly name: string;
  readonly format: 'audit-chain/1';
  readonly row: Readonly<AuditRow>;
  /** Exact JSON, before the prev_hash prefix and UTF-8 SHA-256. */
  readonly canonical: string;
  readonly record: AuditRecordV1;
  /** Expected snake_case fields, before a protocol-specific envelope or attribute prefix. */
  readonly wire: Readonly<Record<string, string | number | null>>;
}

/** Fixed expectations computed independently of the core canonicalizer and wire projection. */
export const auditCanonicalVectors: readonly AuditCanonicalVector[] = freeze([
  {
    name: 'unicode-and-escaping',
    format: 'audit-chain/1',
    row: {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 1,
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      hash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      created_at: '2026-10-28T00:00:01.000Z',
      actor_type: 'user',
      actor_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      token_selector: 'abcdefghijkl',
      source_ip: '203.0.113.7',
      action: 'role.rename',
      target_type: 'role',
      target_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      project_id: null,
      payload_json:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    canonical:
      '{"action":"role.rename","actor_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","actor_type":"user","created_at":"2026-10-28T00:00:01.000Z","id":"01JZZZZZZZZZZZZZZZZZZZZZZX","org_id":"01JZZZZZZZZZZZZZZZZZZZZZZY","payload_json":"{\\"changes\\":{\\"name\\":{\\"old\\":\\"Old name\\",\\"new\\":\\"Łódź \\\\\\"audit\\\\\\"\\\\\\\\line\\\\nnext\\"}},\\"op_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\",\\"request_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\"}","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","project_id":null,"seq":1,"target_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","target_type":"role","token_selector":"abcdefghijkl"}',
    record: {
      kind: 'event',
      chainId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      orgId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 1,
      prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      hash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      createdAt: '2026-10-28T00:00:01.000Z',
      actorType: 'user',
      actorId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      tokenSelector: 'abcdefghijkl',
      sourceIp: '203.0.113.7',
      action: 'role.rename',
      targetType: 'role',
      targetId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      projectId: null,
      payloadJson:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    wire: {
      kind: 'event',
      chain_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 1,
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      hash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      created_at: '2026-10-28T00:00:01.000Z',
      actor_type: 'user',
      actor_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      token_selector: 'abcdefghijkl',
      source_ip: '203.0.113.7',
      action: 'role.rename',
      target_type: 'role',
      target_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      project_id: null,
      payload_json:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
  },
  {
    name: 'nulls-and-seal-order',
    format: 'audit-chain/1',
    row: {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZW',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 2,
      prev_hash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      hash: 'c265ab5eddc5f83e4e6c486b619dcd078a55ec6a4ca618781f6e213793d09fc5',
      created_at: '2026-10-28T00:00:00.000Z',
      actor_type: 'system',
      actor_id: null,
      token_selector: null,
      source_ip: null,
      action: 'session.logout',
      target_type: 'session',
      target_id: null,
      project_id: null,
      payload_json:
        '{"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    canonical:
      '{"action":"session.logout","actor_id":null,"actor_type":"system","created_at":"2026-10-28T00:00:00.000Z","id":"01JZZZZZZZZZZZZZZZZZZZZZZW","org_id":"01JZZZZZZZZZZZZZZZZZZZZZZY","payload_json":"{\\"op_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\",\\"request_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\"}","prev_hash":"77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746","project_id":null,"seq":2,"target_id":null,"target_type":"session","token_selector":null}',
    record: {
      kind: 'event',
      chainId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZW',
      orgId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 2,
      prevHash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      hash: 'c265ab5eddc5f83e4e6c486b619dcd078a55ec6a4ca618781f6e213793d09fc5',
      createdAt: '2026-10-28T00:00:00.000Z',
      actorType: 'system',
      actorId: null,
      tokenSelector: null,
      action: 'session.logout',
      targetType: 'session',
      targetId: null,
      projectId: null,
      payloadJson:
        '{"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    wire: {
      kind: 'event',
      chain_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZW',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 2,
      prev_hash: '77b18f14f83503cddbb12f3f388188ea2bb1ed13518141bc9a6ee37841faa746',
      hash: 'c265ab5eddc5f83e4e6c486b619dcd078a55ec6a4ca618781f6e213793d09fc5',
      created_at: '2026-10-28T00:00:00.000Z',
      actor_type: 'system',
      actor_id: null,
      token_selector: null,
      action: 'session.logout',
      target_type: 'session',
      target_id: null,
      project_id: null,
      payload_json:
        '{"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
  },
  {
    // Independent, non-contiguous vector; its predecessor is outside this fixture set.
    name: 'maximum-safe-sequence',
    format: 'audit-chain/1',
    row: {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 9007199254740991,
      prev_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hash: 'ce071543dde27ffc68b0d944aed0af0c2529226001f8b0b799b29c7fa59ec44b',
      created_at: '2026-10-28T00:00:01.000Z',
      actor_type: 'user',
      actor_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      token_selector: 'abcdefghijkl',
      source_ip: '203.0.113.7',
      action: 'role.rename',
      target_type: 'role',
      target_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      project_id: null,
      payload_json:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    canonical:
      '{"action":"role.rename","actor_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","actor_type":"user","created_at":"2026-10-28T00:00:01.000Z","id":"01JZZZZZZZZZZZZZZZZZZZZZZX","org_id":"01JZZZZZZZZZZZZZZZZZZZZZZY","payload_json":"{\\"changes\\":{\\"name\\":{\\"old\\":\\"Old name\\",\\"new\\":\\"Łódź \\\\\\"audit\\\\\\"\\\\\\\\line\\\\nnext\\"}},\\"op_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\",\\"request_id\\":\\"01JZZZZZZZZZZZZZZZZZZZZZZX\\"}","prev_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","project_id":null,"seq":9007199254740991,"target_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","target_type":"role","token_selector":"abcdefghijkl"}',
    record: {
      kind: 'event',
      chainId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      orgId: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 9007199254740991,
      prevHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hash: 'ce071543dde27ffc68b0d944aed0af0c2529226001f8b0b799b29c7fa59ec44b',
      createdAt: '2026-10-28T00:00:01.000Z',
      actorType: 'user',
      actorId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      tokenSelector: 'abcdefghijkl',
      sourceIp: '203.0.113.7',
      action: 'role.rename',
      targetType: 'role',
      targetId: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      projectId: null,
      payloadJson:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
    wire: {
      kind: 'event',
      chain_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      epoch: 3,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      org_id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      seq: 9007199254740991,
      prev_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hash: 'ce071543dde27ffc68b0d944aed0af0c2529226001f8b0b799b29c7fa59ec44b',
      created_at: '2026-10-28T00:00:01.000Z',
      actor_type: 'user',
      actor_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      token_selector: 'abcdefghijkl',
      source_ip: '203.0.113.7',
      action: 'role.rename',
      target_type: 'role',
      target_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
      project_id: null,
      payload_json:
        '{"changes":{"name":{"old":"Old name","new":"Łódź \\"audit\\"\\\\line\\nnext"}},"op_id":"01JZZZZZZZZZZZZZZZZZZZZZZX","request_id":"01JZZZZZZZZZZZZZZZZZZZZZZX"}',
    },
  },
]);

const first = auditCanonicalVectors[0]!.record;
const second = auditCanonicalVectors[1]!.record;
const genesis = '0'.repeat(64);
const markerBase = { chainId: first.chainId, epoch: first.epoch };
const { payloadJson: _payload, tokenSelector: _selector, sourceIp: _ip, ...safe } = first;
void _payload;
void _selector;
void _ip;

/** Covers every v1 marker. Marker IDs are arbitrary stable fixture IDs, not core-derived IDs. */
export const auditMarkerFixtures: readonly {
  readonly marker: AuditMarkerV1;
  readonly wire: Readonly<Record<string, string | number | null>>;
}[] = freeze([
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ01',
      kind: 'boundary',
      boundarySeq: 1,
      boundaryPrevHash: genesis,
      provenance: 'backfill',
      priorArchiveHint: 'archive-1',
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ01',
      kind: 'boundary',
      boundary_seq: 1,
      boundary_prev_hash: genesis,
      provenance: 'backfill',
      prior_archive_hint: 'archive-1',
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ02',
      kind: 'gap',
      fromSeq: 1,
      toSeq: 2,
      count: 2,
      prevHash: genesis,
      hash: second.hash,
      reason: 'capacity',
      policyGeneration: 1,
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ02',
      kind: 'gap',
      from_seq: 1,
      to_seq: 2,
      count: 2,
      prev_hash: genesis,
      hash: second.hash,
      reason: 'capacity',
      policy_generation: 1,
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ03',
      kind: 'tombstone',
      seq: 1,
      prevHash: first.prevHash,
      hash: first.hash,
      reasonCode: 'http_status',
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ03',
      kind: 'tombstone',
      seq: 1,
      prev_hash: first.prevHash,
      hash: first.hash,
      reason_code: 'http_status',
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ04',
      kind: 'delivery_uncertain',
      fromSeq: 1,
      toSeq: 2,
      hash: second.hash,
      reasonCode: 'partial_rejected',
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ04',
      kind: 'delivery_uncertain',
      from_seq: 1,
      to_seq: 2,
      hash: second.hash,
      reason_code: 'partial_rejected',
    },
  },
  {
    marker: {
      ...safe,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ05',
      kind: 'withheld',
      reasonCode: 'content_unavailable',
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ05',
      kind: 'withheld',
      id: first.id,
      org_id: first.orgId,
      seq: 1,
      prev_hash: genesis,
      hash: first.hash,
      created_at: '2026-10-28T00:00:01.000Z',
      actor_type: 'user',
      actor_id: first.actorId,
      action: 'role.rename',
      target_type: 'role',
      target_id: first.targetId,
      project_id: null,
      reason_code: 'content_unavailable',
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ06',
      kind: 'fork',
      lastCommonSeq: 1,
      lastCommonHash: first.hash,
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ06',
      kind: 'fork',
      last_common_seq: 1,
      last_common_hash: first.hash,
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ07',
      kind: 'receiver_changed',
      oldFingerprint: 'a'.repeat(64),
      newFingerprint: 'b'.repeat(64),
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ07',
      kind: 'receiver_changed',
      old_fingerprint: 'a'.repeat(64),
      new_fingerprint: 'b'.repeat(64),
    },
  },
  {
    marker: {
      ...markerBase,
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ08',
      kind: 'head',
      seq: 2,
      hash: second.hash,
      boundarySeq: 1,
    },
    wire: {
      chain_id: first.chainId,
      epoch: 3,
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ08',
      kind: 'head',
      seq: 2,
      hash: second.hash,
      boundary_seq: 1,
    },
  },
]);

const futureMarkerFixture = freeze({
  marker: {
    ...markerBase,
    kind: 'future_marker',
    markerId: '01JZZZZZZZZZZZZZZZZZZZZZ09',
    futureField: 'preserved',
  } as unknown as AuditMarkerV1,
  wire: {
    chain_id: first.chainId,
    epoch: 3,
    kind: 'future_marker',
    marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ09',
    future_field: 'preserved',
  },
});

function batch(
  records: AuditBatchV1['records'],
  throughSeq = first.seq,
  throughHash = first.hash,
): AuditBatchV1 {
  return freeze({
    v: 1,
    frozenAt: Date.parse('2026-10-28T00:00:02.000Z'),
    chainId: first.chainId,
    epoch: first.epoch,
    orgId: first.orgId,
    records,
    throughSeq,
    throughHash,
  });
}

export type AuditConformanceReply =
  'accepted' | 'partial' | 'rejected' | 'wrong_epoch' | 'retry' | 'bad_response';
export interface AuditConformanceResponseOptions {
  /** For partial replies, encode exactly this many rejected records. */
  readonly rejectedCount?: number;
  /** For retry replies, use this HTTP status and preserve retryAfterMs. */
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** For bad_response replies, send a 2xx defect; ack is application/json with body {}. */
  readonly invalid?: 'body' | 'content_type' | 'ack';
}
export interface AuditConformanceStep extends AuditConformanceResponseOptions {
  readonly batch: AuditBatchV1;
  readonly reply: AuditConformanceReply;
  /** Receiver committed, but the caller never obtained its ACK. */
  readonly loseAck?: boolean;
  readonly crashBeforeCommit?: boolean;
  /** Recreate the sink, retaining the receiver and frozen request expectations. */
  readonly restart?: boolean;
}
export interface AuditConformanceFixture {
  readonly name: string;
  readonly steps: readonly AuditConformanceStep[];
  /** Deliver the same frozen batch from two overlapping workers. */
  readonly overlap?: boolean;
  /** Receiver remains ahead after both local chain and cursor roll back. */
  readonly probeRestore?: boolean;
}

const eventBatch = batch([first]);
const markerBatch = batch([auditMarkerFixtures[2]!.marker]);
const accepted = (input: AuditBatchV1): AuditConformanceStep => ({
  batch: input,
  reply: 'accepted',
});

/** Webhook-default fixtures; use auditSinkConformanceFixturesFor for protocol-specific lists. */
export const auditSinkConformanceFixtures: readonly AuditConformanceFixture[] = freeze([
  {
    name: 'canonical-vectors',
    steps: auditCanonicalVectors.map(({ record }) =>
      accepted(batch([record], record.seq, record.hash)),
    ),
  },
  {
    name: 'lost-ack-after-commit',
    steps: [{ ...accepted(eventBatch), loseAck: true }, accepted(eventBatch)],
  },
  {
    name: 'overlapping-leases',
    overlap: true,
    steps: [accepted(eventBatch), accepted(eventBatch)],
  },
  {
    name: 'partial-success',
    steps: [
      { batch: batch([first, second], 2, second.hash), reply: 'partial', rejectedCount: 1 },
      {
        batch: batch([first, second, auditMarkerFixtures[2]!.marker], 2, second.hash),
        reply: 'partial',
        rejectedCount: 2,
      },
    ],
  },
  {
    name: 'retryable-http-status',
    steps: [
      ...[408, 429, 500, 503].map(
        (status) =>
          ({
            batch: eventBatch,
            reply: 'retry',
            status,
            retryAfterMs: 1234,
          }) as const,
      ),
      { batch: eventBatch, reply: 'retry', status: 503 },
    ],
  },
  {
    name: 'invalid-success-response',
    steps: (['body', 'content_type', 'ack'] as const).map((invalid) => ({
      batch: eventBatch,
      reply: 'bad_response',
      invalid,
    })),
  },
  { name: 'permanent-rejection', steps: [{ batch: eventBatch, reply: 'rejected' }] },
  {
    name: 'terminal-http-status',
    steps: [{ batch: eventBatch, reply: 'rejected', status: 400 }],
  },
  {
    name: 'crash-before-marker-commit',
    steps: [
      { ...accepted(markerBatch), crashBeforeCommit: true },
      { ...accepted(markerBatch), restart: true },
    ],
  },
  {
    name: 'crash-after-marker-commit',
    steps: [
      { ...accepted(markerBatch), loseAck: true },
      { ...accepted(markerBatch), restart: true },
    ],
  },
  { name: 'late-original-after-tombstone', steps: [accepted(markerBatch), accepted(eventBatch)] },
  {
    name: 'restore-chain-and-cursor',
    probeRestore: true,
    steps: [accepted(batch([first, second], 2, second.hash))],
  },
  {
    name: 'schema-change-during-frozen-batch',
    steps: [
      { ...accepted(eventBatch), loseAck: true },
      { ...accepted(eventBatch), restart: true },
    ],
  },
  {
    name: 'marker-only-batches',
    steps: auditMarkerFixtures.map(({ marker }) => {
      switch (marker.kind) {
        case 'gap':
        case 'delivery_uncertain':
          return accepted(batch([marker], marker.toSeq, marker.hash));
        case 'tombstone':
        case 'withheld':
          return accepted(batch([marker], marker.seq, marker.hash));
        default:
          return accepted(batch([marker], 0, genesis));
      }
    }),
  },
  { name: 'wrong-epoch-ack', steps: [{ batch: eventBatch, reply: 'wrong_epoch' }] },
  {
    name: 'additive-fields-and-marker-kind',
    steps: [
      accepted(
        batch([
          { ...first, futureField: 'preserved' } as AuditRecordV1,
          futureMarkerFixture.marker,
        ]),
      ),
    ],
  },
  {
    name: 'fresh-chain-epoch-zero',
    probeRestore: true,
    steps: [
      accepted(
        freeze({
          ...batch([{ ...auditMarkerFixtures[0]!.marker, epoch: 0 }], 0, genesis),
          epoch: 0,
        }),
      ),
      accepted(freeze({ ...eventBatch, epoch: 0, records: [{ ...first, epoch: 0 }] })),
    ],
  },
]);

export type AuditConformanceResponse = Awaited<ReturnType<AuditBoundFetch>>;
export interface AuditSinkConformanceAdapter {
  /** OTLP acknowledges transport success; a webhook echoes the receiver's position. */
  readonly acknowledgement: 'transport' | 'receiver';
  /** Retryable HTTP statuses; defaults to the wire protocol's retry policy. */
  readonly retryableStatuses?: readonly number[];
  /** Terminal HTTP statuses; defaults to 408/500 for OTLP, otherwise 400. */
  readonly terminalStatuses?: readonly number[];
  /** A new build generation may change encoder defaults, but must retain v1 encoding. */
  readonly create: (ctx: AuditSinkContext, generation: number) => AuditSink;
  /** Decode the actual protocol body to public camelCase fields; null denotes a frontier probe. */
  readonly decode: (body: string) => AuditBatchV1 | null;
  /**
   * Extract actual snake_case record objects from the body, removing only envelopes and prefixes.
   * Never reconstruct fields from decode() or coerce their types. JSON preserves numbers/nulls;
   * OTLP omits null attributes and unwraps stringValue attributes; all other fields are strings.
   * OTLP includes source_ip.hashed='false' when source_ip is present.
   * decode() removes that qualifier and may omit null fields or restore them as null.
   */
  readonly wireRecords: (body: string) => readonly Readonly<Record<string, unknown>>[];
  readonly wireFormat: 'json' | 'otlp';
  /**
   * Encode protocol responses. Supported partial replies encode options.rejectedCount exactly.
   * Retry replies use options.status/retryAfterMs; bad_response uses options.invalid.
   * wrong_epoch changes only the receiver epoch, or is ordinary transport success.
   */
  readonly respond: (
    reply: AuditConformanceReply,
    batch: AuditBatchV1,
    options: AuditConformanceResponseOptions,
  ) => AuditConformanceResponse;
  readonly frontierResponse?: (position: AuditPositionV1) => AuditConformanceResponse;
  /** Unsupported protocols require full ACKs or failure and must never report partial success. */
  readonly partialOutcome: 'uncertain' | 'accepted_with_warning' | 'unsupported';
}

export class AuditSinkConformanceError extends Error {
  readonly fixture: string;
  constructor(fixture: string) {
    super('Audit sink conformance failed');
    this.name = 'AuditSinkConformanceError';
    this.fixture = fixture;
  }
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

function ackMatches(result: AuditDelivery, input: AuditBatchV1): boolean {
  return (
    (result.outcome === 'accepted' || result.outcome === 'accepted_with_warning') &&
    result.chainId === input.chainId &&
    result.epoch === input.epoch &&
    result.throughSeq === input.throughSeq &&
    result.throughHash === input.throughHash
  );
}

export interface AuditSinkConformanceResult {
  readonly passed: readonly string[];
  readonly frontier: 'passed' | 'unsupported';
  readonly acknowledgement: AuditSinkConformanceAdapter['acknowledgement'];
  readonly partialOutcome: AuditSinkConformanceAdapter['partialOutcome'];
}

/** Resolves the exact fixtures run for this protocol, including declared status cases. */
export function auditSinkConformanceFixturesFor(
  adapter: Pick<
    AuditSinkConformanceAdapter,
    'wireFormat' | 'retryableStatuses' | 'terminalStatuses'
  >,
): readonly AuditConformanceFixture[] {
  const otlp = adapter.wireFormat === 'otlp';
  const otlpRetryable = [429, 502, 503, 504];
  const retryable = adapter.retryableStatuses ?? (otlp ? otlpRetryable : [408, 429, 500, 503]);
  const terminal = adapter.terminalStatuses ?? (otlp ? [408, 500] : [400]);
  const httpStatus = (status: number) => Number.isInteger(status) && status >= 100 && status <= 599;
  if (
    retryable.length === 0 ||
    !retryable.every(httpStatus) ||
    (otlp &&
      (!otlpRetryable.every((status) => retryable.includes(status)) ||
        retryable.some((status) => !otlpRetryable.includes(status))))
  )
    throw new AuditSinkConformanceError('retryable-http-status');
  if (
    terminal.length === 0 ||
    !terminal.every(
      (status) =>
        httpStatus(status) && (status < 200 || status >= 300) && !retryable.includes(status),
    ) ||
    (otlp && ![408, 500].every((status) => terminal.includes(status)))
  )
    throw new AuditSinkConformanceError('terminal-http-status');
  return freeze(
    auditSinkConformanceFixtures.map((template) => ({
      ...template,
      steps:
        template.name === 'retryable-http-status'
          ? [
              ...retryable.map((status) => ({
                batch: eventBatch,
                reply: 'retry' as const,
                status,
                retryAfterMs: 1234,
              })),
              { batch: eventBatch, reply: 'retry' as const, status: retryable.at(-1)! },
            ]
          : template.name === 'terminal-http-status'
            ? terminal.map((status) => ({ batch: eventBatch, reply: 'rejected' as const, status }))
            : template.steps,
    })),
  );
}

/** Runs without a test framework, network, timers, or database. Failure text never includes sink data. */
export async function runAuditSinkConformance(
  adapter: AuditSinkConformanceAdapter,
): Promise<AuditSinkConformanceResult> {
  const passed: string[] = [];
  let frontier: AuditSinkConformanceResult['frontier'] = 'unsupported';
  for (const fixture of auditSinkConformanceFixturesFor(adapter)) {
    const fail = (): never => {
      throw new AuditSinkConformanceError(fixture.name);
    };
    const assertConformance = (ok: boolean): void => {
      if (!ok) fail();
    };
    const bodies = new Map<string, string>();
    let position: AuditPositionV1 | null = null;
    let generation = 0;
    let probe = false;
    let probeCalls = 0;
    let probeIdentity: Pick<AuditBatchV1, 'chainId' | 'epoch' | 'orgId'> | null = null;
    let transportFailed = false;
    const contexts = new Map<AbortSignal, { step: AuditConformanceStep; calls: number }>();
    const fetch: AuditBoundFetch = async (request) => {
      try {
        assertConformance(request.contentType === 'application/json');
        const decoded = adapter.decode(request.body);
        if (probe) {
          probeCalls++;
          assertConformance(
            probeCalls === 1 &&
              decoded === null &&
              position !== null &&
              adapter.frontierResponse !== undefined,
          );
          const wire = JSON.parse(request.body) as Record<string, unknown>;
          assertConformance(
            probeIdentity !== null &&
              wire['chain_id'] === probeIdentity.chainId &&
              wire['org_id'] === probeIdentity.orgId,
          );
          return adapter.frontierResponse!(position!);
        }
        const pending = contexts.get(request.signal);
        assertConformance(pending !== undefined);
        const { step } = pending!;
        const normalize = (value: AuditBatchV1 | null) => {
          if (value === null) return null;
          // Frozen time need not appear as a batch field in the protocol envelope.
          const input = { ...value, frozenAt: 0 };
          return adapter.wireFormat !== 'otlp'
            ? input
            : {
                ...input,
                records: input.records.map((record) =>
                  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)),
                ) as unknown as AuditBatchV1['records'],
              };
        };
        pending!.calls++;
        assertConformance(
          pending!.calls === 1 && stable(normalize(decoded)) === stable(normalize(step.batch)),
        );
        let expectedWire: readonly Readonly<Record<string, unknown>>[] | undefined;
        if (fixture.name === 'canonical-vectors') {
          const vector = auditCanonicalVectors.find(
            ({ record }) => record.seq === step.batch.throughSeq,
          )!;
          expectedWire = [vector.wire];
        } else if (fixture.name === 'marker-only-batches') {
          expectedWire = [
            auditMarkerFixtures.find(
              ({ marker }) => marker.markerId === (step.batch.records[0] as AuditMarkerV1).markerId,
            )!.wire,
          ];
        } else if (fixture.name === 'additive-fields-and-marker-kind') {
          expectedWire = [
            { ...auditCanonicalVectors[0]!.wire, future_field: 'preserved' },
            futureMarkerFixture.wire,
          ];
        }
        if (expectedWire !== undefined) {
          const expected = expectedWire.map((record) =>
            adapter.wireFormat === 'otlp'
              ? Object.fromEntries([
                  ...Object.entries(record)
                    .filter(([, value]) => value !== null)
                    .map(([key, value]) => [key, String(value)]),
                  ...(record['source_ip'] != null ? [['source_ip.hashed', 'false']] : []),
                ])
              : record,
          );
          assertConformance(stable(adapter.wireRecords(request.body)) === stable(expected));
        }
        const key = stable(step.batch);
        assertConformance(!bodies.has(key) || bodies.get(key) === request.body);
        bodies.set(key, request.body);
        if (step.crashBeforeCommit) throw new Error('Simulated transport failure');
        if (step.reply === 'accepted' || step.reply === 'wrong_epoch') {
          if (position === null || step.batch.throughSeq > position.seq) {
            position = {
              chainId: step.batch.chainId,
              epoch: step.batch.epoch,
              seq: step.batch.throughSeq,
              hash: step.batch.throughHash,
            };
          }
        }
        if (step.loseAck) throw new Error('Simulated transport failure');
        return adapter.respond(step.reply, step.batch, step);
      } catch (error) {
        if (error instanceof AuditSinkConformanceError) transportFailed = true;
        throw error;
      }
    };
    const create = (): AuditSink =>
      adapter.create(
        {
          runtime: 'docker',
          deploymentId: 'conformance',
          fetch,
          env: () => undefined,
          clock: {
            now: () => new Date(Date.parse('2026-10-28T00:00:02.000Z') + generation * 60_000),
          },
        },
        generation,
      );
    try {
      let sink = create();
      const deliver = async (step: AuditConformanceStep, worker = sink): Promise<void> => {
        if (step.restart) {
          generation++;
          sink = create();
          worker = sink;
        }
        const controller = new AbortController();
        const pending = { step, calls: 0 };
        contexts.set(controller.signal, pending);
        let result: AuditDelivery;
        try {
          result = await worker.deliver(step.batch, controller.signal);
        } catch {
          result = { outcome: 'retry', code: 'network' };
        }
        contexts.delete(controller.signal);
        assertConformance(!transportFailed && pending.calls === 1);
        assertConformance(
          adapter.partialOutcome !== 'unsupported' ||
            !(result.outcome === 'accepted_with_warning' && result.code === 'partial_success'),
        );
        if (step.loseAck || step.crashBeforeCommit) {
          assertConformance(
            result.outcome === 'retry' && (result.code === 'network' || result.code === 'timeout'),
          );
        } else if (step.reply === 'wrong_epoch') {
          if (adapter.acknowledgement === 'transport') {
            assertConformance(result.outcome === 'accepted' && ackMatches(result, step.batch));
            return;
          }
          // Core rejects any ACK that fails the complete identity comparison.
          assertConformance(!ackMatches(result, step.batch));
          assertConformance(
            (result.outcome === 'retry' && result.code === 'bad_response') ||
              ((result.outcome === 'accepted' || result.outcome === 'accepted_with_warning') &&
                result.chainId === step.batch.chainId &&
                result.epoch !== step.batch.epoch &&
                result.throughSeq === step.batch.throughSeq &&
                result.throughHash === step.batch.throughHash),
          );
        } else if (step.reply === 'partial') {
          if (adapter.partialOutcome === 'unsupported') {
            assertConformance(
              result.outcome === 'retry' ||
                result.outcome === 'rejected' ||
                (result.outcome === 'accepted' && ackMatches(result, step.batch)),
            );
            return;
          }
          assertConformance(result.outcome === adapter.partialOutcome);
          if (result.outcome === 'uncertain')
            assertConformance(
              result.code === 'partial_rejected' && result.rejectedCount === step.rejectedCount,
            );
          else
            assertConformance(
              ackMatches(result, step.batch) &&
                result.outcome === 'accepted_with_warning' &&
                result.code === 'partial_success',
            );
        } else if (step.reply === 'retry') {
          assertConformance(
            result.outcome === 'retry' &&
              result.code === 'http_status' &&
              result.retryAfterMs === step.retryAfterMs &&
              (step.retryAfterMs !== undefined || !('retryAfterMs' in result)),
          );
        } else if (step.reply === 'bad_response') {
          if (step.invalid === 'ack' && adapter.acknowledgement === 'transport')
            assertConformance(result.outcome === 'accepted' && ackMatches(result, step.batch));
          else assertConformance(result.outcome === 'retry' && result.code === 'bad_response');
        } else if (step.reply === 'rejected') {
          assertConformance(result.outcome === 'rejected' && result.code === 'http_status');
        } else assertConformance(result.outcome === 'accepted' && ackMatches(result, step.batch));
      };
      if (fixture.overlap) await Promise.all(fixture.steps.map((step) => deliver(step, create())));
      else for (const step of fixture.steps) await deliver(step);
      if (fixture.probeRestore && sink.frontier !== undefined) {
        assertConformance(adapter.frontierResponse !== undefined);
        probe = true;
        sink = create();
        assertConformance(sink.frontier !== undefined);
        const batch = fixture.steps[0]!.batch;
        for (const identity of [
          { chainId: batch.chainId, epoch: batch.epoch, orgId: batch.orgId },
          { chainId: 'f'.repeat(32), epoch: batch.epoch + 1, orgId: batch.orgId },
          { chainId: 'f'.repeat(32), epoch: batch.epoch + 1, orgId: 'frontier-other-org' },
        ]) {
          probeIdentity = identity;
          probeCalls = 0;
          position = { ...position!, chainId: identity.chainId, epoch: identity.epoch };
          const remote = await sink.frontier!(identity, new AbortController().signal);
          assertConformance(
            !transportFailed && probeCalls === 1 && stable(remote) === stable(position),
          );
          assertConformance(remote !== null && remote.seq > 0);
        }
        frontier = 'passed';
      }
      passed.push(fixture.name);
    } catch {
      fail();
    }
  }
  return freeze({
    passed,
    frontier,
    acknowledgement: adapter.acknowledgement,
    partialOutcome: adapter.partialOutcome,
  });
}
