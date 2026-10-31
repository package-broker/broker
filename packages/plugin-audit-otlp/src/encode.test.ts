import { describe, expect, it } from 'vitest';
import type { AuditBatchV1 } from '@package-broker/core/plugin';
import {
  auditCanonicalVectors,
  auditMarkerFixtures,
  auditSinkConformanceFixtures,
} from '@package-broker/core/plugin/testing';
import { encodeAuditBatch as encode } from './encode.js';

const encodeAuditBatch = (batch: AuditBatchV1) => encode(batch, 'deployment-test');

interface Attribute {
  key: string;
  value: { stringValue: string };
}
interface LogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  eventName: string;
  body: { stringValue: string };
  attributes: Attribute[];
}
interface Envelope {
  resourceLogs: {
    resource: { attributes: Attribute[] };
    scopeLogs: {
      scope: { name: string; version: string };
      logRecords: LogRecord[];
    }[];
  }[];
}

const first = auditCanonicalVectors[0]!.record;
const observed = new Date('2026-10-30T12:34:56.789Z');
const observedNanos = '1793363696789000000';

function batch(records: AuditBatchV1['records'] = [first]): AuditBatchV1 {
  return {
    v: 1,
    frozenAt: observed.getTime(),
    chainId: first.chainId,
    epoch: first.epoch,
    orgId: first.orgId,
    records,
    throughSeq: first.seq,
    throughHash: first.hash,
  };
}

function decode(body: string) {
  const envelope = JSON.parse(body) as Envelope;
  expect(envelope.resourceLogs).toHaveLength(1);
  const resource = envelope.resourceLogs[0]!;
  expect(resource.scopeLogs).toHaveLength(1);
  expect(resource.scopeLogs[0]!.scope).toEqual({
    name: 'package-broker.audit',
    version: 'audit-otlp/1',
  });
  return {
    resource: fields(resource.resource.attributes),
    logs: resource.scopeLogs[0]!.logRecords,
  };
}

function fields(attributes: Attribute[]): Record<string, string> {
  expect(new Set(attributes.map(({ key }) => key)).size).toBe(attributes.length);
  return Object.fromEntries(
    attributes.map(({ key, value }) => {
      expect(key.startsWith('pb.audit.')).toBe(true);
      expect(Object.keys(value)).toEqual(['stringValue']);
      expect(typeof value.stringValue).toBe('string');
      return [key.slice('pb.audit.'.length), value.stringValue];
    }),
  );
}

function expectedFields(wire: Readonly<Record<string, string | number | null>>) {
  return Object.fromEntries(
    Object.entries(wire)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function archiveCanonical(wire: Record<string, string>): string {
  const keys = [
    'action',
    'actor_id',
    'actor_type',
    'created_at',
    'id',
    'org_id',
    'payload_json',
    'prev_hash',
    'project_id',
    'seq',
    'target_id',
    'target_type',
    'token_selector',
  ];
  return JSON.stringify(
    Object.fromEntries(
      keys.map((key) => [key, key === 'seq' ? Number(wire[key]) : (wire[key] ?? null)]),
    ),
  );
}

describe('audit OTLP encoding', () => {
  for (const vector of auditCanonicalVectors) {
    it(`independently decodes and verifies ${vector.name}`, async () => {
      const input = {
        ...batch([vector.record]),
        throughSeq: vector.record.seq,
        throughHash: vector.record.hash,
      };
      const { resource, logs } = decode(encodeAuditBatch(input));
      expect(resource).toEqual({
        deployment_id: 'deployment-test',
        v: '1',
        chain_id: input.chainId,
        epoch: '3',
        org_id: input.orgId,
        through_seq: String(input.throughSeq),
        through_hash: input.throughHash,
      });
      expect(logs).toHaveLength(1);
      const log = logs[0]!;
      const wire = fields(log.attributes);
      expect(wire).toEqual({
        ...expectedFields(vector.wire),
        ...(vector.record.sourceIp ? { 'source_ip.hashed': 'false' } : {}),
      });
      expect(log.timeUnixNano).toBe(
        vector.record.seq === 2 ? '1793145600000000000' : '1793145601000000000',
      );
      expect(log.observedTimeUnixNano).toBe(observedNanos);
      expect(log.eventName).toBe(`package_broker.audit.${vector.wire['action']}`);
      expect(log.body).toEqual({ stringValue: vector.wire['action'] });
      const canonical = archiveCanonical(wire);
      expect(canonical).toBe(vector.canonical);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(wire['prev_hash']! + canonical),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      expect(hash).toBe(vector.record.hash);
    });
  }

  for (const { marker, wire } of auditMarkerFixtures) {
    it(`preserves every ${marker.kind} marker field and its own identity`, () => {
      const { logs } = decode(encodeAuditBatch(batch([marker])));
      expect(logs).toHaveLength(1);
      const log = logs[0]!;
      expect(fields(log.attributes)).toEqual(expectedFields(wire));
      expect(log.eventName).toBe(`package_broker.audit.marker.${marker.kind}`);
      expect(log.body).toEqual({ stringValue: marker.kind });
      expect(log.observedTimeUnixNano).toBe(observedNanos);
      expect(log.timeUnixNano).toBe(
        marker.kind === 'withheld' ? '1793145601000000000' : observedNanos,
      );
    });
  }

  it('preserves order, additive fields and future marker kinds', () => {
    const input = auditSinkConformanceFixtures.find(
      ({ name }) => name === 'additive-fields-and-marker-kind',
    )!.steps[0]!.batch;
    const body = encodeAuditBatch(input);
    const { logs } = decode(body);
    expect(logs).toHaveLength(2);
    expect(fields(logs[0]!.attributes)['future_field']).toBe('preserved');
    expect(fields(logs[1]!.attributes)).toEqual({
      chain_id: first.chainId,
      epoch: '3',
      kind: 'future_marker',
      marker_id: '01JZZZZZZZZZZZZZZZZZZZZZ09',
      future_field: 'preserved',
    });
    expect(logs[1]!.eventName).toBe('package_broker.audit.marker.future_marker');
    expect(encodeAuditBatch(input)).toBe(body);
    for (const futureField of [{}, [], () => 'value', Symbol('value'), 1n, NaN, Infinity]) {
      expect(() => encodeAuditBatch(batch([{ ...first, futureField } as typeof first]))).toThrow(
        'Invalid audit attribute',
      );
      expect(() =>
        encodeAuditBatch({ ...batch(), orgId: futureField } as unknown as AuditBatchV1),
      ).toThrow('Invalid audit attribute');
    }
    const scalarFields = { futureString: 'value', futureNumber: 42, futureBoolean: false };
    expect(
      fields(decode(encodeAuditBatch(batch([{ ...first, ...scalarFields }]))).logs[0]!.attributes),
    ).toMatchObject({ future_string: 'value', future_number: '42', future_boolean: 'false' });
  });

  it('encodes unreadable withheld markers without inventing event metadata', () => {
    const marker = {
      kind: 'withheld',
      markerId: '01JZZZZZZZZZZZZZZZZZZZZZ10',
      chainId: first.chainId,
      epoch: first.epoch,
      orgId: first.orgId,
      seq: first.seq,
      prevHash: first.prevHash,
      hash: first.hash,
      reasonCode: 'unreadable',
    } as const;
    const { logs } = decode(encodeAuditBatch(batch([marker])));
    expect(fields(logs[0]!.attributes)).toEqual({
      kind: 'withheld',
      marker_id: marker.markerId,
      chain_id: first.chainId,
      epoch: '3',
      org_id: first.orgId,
      seq: '1',
      prev_hash: first.prevHash,
      hash: first.hash,
      reason_code: 'unreadable',
    });
    expect(logs[0]!.timeUnixNano).toBe(observedNanos);
  });

  it('omits absent and null IPs without claiming they are hashed', () => {
    for (const sourceIp of [undefined, null]) {
      const { logs } = decode(encodeAuditBatch(batch([{ ...first, sourceIp } as typeof first])));
      const wire = fields(logs[0]!.attributes);
      expect(wire).not.toHaveProperty('source_ip');
      expect(wire).not.toHaveProperty('source_ip.hashed');
    }
  });

  it('preserves millisecond precision without rounding nanoseconds', () => {
    const { logs } = decode(
      encodeAuditBatch(batch([{ ...first, createdAt: '2026-10-30T12:34:56.789Z' }])),
    );
    expect(logs[0]!.timeUnixNano).toBe(observedNanos);
  });

  it('encodes 100 records in order without truncating payloads', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({ ...first, seq: index + 1 }));
    const { logs } = decode(encodeAuditBatch(batch(records)));
    expect(logs).toHaveLength(100);
    expect(logs.map((log) => fields(log.attributes)['seq'])).toEqual(
      records.map(({ seq }) => String(seq)),
    );
    expect(logs.map((log) => fields(log.attributes)['payload_json'])).toEqual(
      records.map(({ payloadJson }) => payloadJson),
    );
  });

  it('enforces the exact UTF-8 byte limit after escaping without truncation', () => {
    const input = batch([{ ...first, payloadJson: '' }]);
    const overhead = new TextEncoder().encode(encodeAuditBatch(input)).length;
    const payloadJson = 'x'.repeat(512 * 1024 - overhead);
    const exact = batch([{ ...first, payloadJson }]);
    const body = encodeAuditBatch(exact);
    expect(new TextEncoder().encode(body).length).toBe(512 * 1024);
    expect(fields(decode(body).logs[0]!.attributes)['payload_json']).toBe(payloadJson);
    expect(() => encodeAuditBatch(batch([{ ...first, payloadJson: payloadJson + 'x' }]))).toThrow(
      'Audit OTLP body exceeds byte limit',
    );
    for (const character of ['界', '"', '\\', '\n']) {
      expect(() =>
        encodeAuditBatch(batch([{ ...first, payloadJson: character.repeat(270_000) }])),
      ).toThrow(RangeError);
    }
  });

  it('refuses invalid and out-of-range timestamps with a fixed error', () => {
    for (const date of [new Date(NaN), new Date(-1), new Date('9999-01-01')]) {
      expect(() => encodeAuditBatch({ ...batch(), frozenAt: date.getTime() })).toThrow(
        'Invalid audit timestamp',
      );
    }
    for (const createdAt of [
      'invalid',
      '2026-10-30',
      '2026-10-30T12:34:56Z',
      '2026-10-30T12:34:56.78Z',
      '2026-10-30T12:34:56.7890Z',
      '2026-10-30T12:34:56.789+00:00',
      '2026-10-30 12:34:56.789Z',
      '2026-13-30T12:34:56.789Z',
    ]) {
      expect(() => encodeAuditBatch(batch([{ ...first, createdAt }]))).toThrow(
        'Invalid audit timestamp',
      );
    }
  });
});
