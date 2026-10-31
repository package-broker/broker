import { describe, expect, it, vi } from 'vitest';
import type { AuditBatchV1, AuditBoundFetch, AuditSinkContext } from '@package-broker/core/plugin';
import {
  auditCanonicalVectors,
  auditSinkConformanceFixturesFor,
  runAuditSinkConformance,
  type AuditSinkConformanceAdapter,
} from '@package-broker/core/plugin/testing';
import {
  AuditTransportError,
  parseAuditOtelEnvironment,
} from '@package-broker/core/audit/sinks/transport';
import {
  exportAuditBatch,
  type AuditExportPort,
  type AuditExportSnapshot,
} from '@package-broker/core/audit/export';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { orgContext } from '@package-broker/core/db/port';
import { encodeAuditBatch } from './encode.js';
import auditOtlp, { type AuditOtlpOptions } from './index.js';

const record = auditCanonicalVectors[0]!.record;
const batch: AuditBatchV1 = {
  v: 1,
  frozenAt: Date.parse('2026-10-30T12:34:56.789Z'),
  chainId: record.chainId,
  epoch: record.epoch,
  orgId: record.orgId,
  records: [record],
  throughSeq: record.seq,
  throughHash: record.hash,
};
const observed = new Date('2026-10-30T12:34:56.789Z');
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200, contentType = 'application/json') => ({
  body: JSON.stringify(body),
  status,
  contentType,
  retryAfterMs: null,
});
function sink(fetch: AuditBoundFetch, now: () => Date = () => observed) {
  return auditOtlp({ id: 'archive' }).auditSinks[0]!.create({
    deploymentId: 'deployment-test',
    runtime: 'docker',
    fetch,
    env: () => {
      throw new Error('No environment access');
    },
    clock: { now },
  });
}
interface Attribute {
  key: string;
  value: { stringValue: string };
}
interface Resource {
  resource: { attributes: Attribute[] };
  scopeLogs: { logRecords: { attributes: Attribute[]; observedTimeUnixNano: string }[] }[];
}
function resource(body: string): Resource {
  return (JSON.parse(body) as { resourceLogs: Resource[] }).resourceLogs[0]!;
}
function fields(attributes: Attribute[]): Record<string, string> {
  return Object.fromEntries(
    attributes.map(({ key, value }) => [key.slice('pb.audit.'.length), value.stringValue]),
  );
}
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const numeric = new Set([
  'v',
  'epoch',
  'seq',
  'from_seq',
  'to_seq',
  'count',
  'boundary_seq',
  'last_common_seq',
  'policy_generation',
  'through_seq',
]);
function decodeFields(input: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== 'source_ip.hashed' && key !== 'deployment_id')
      .map(([key, value]) => [camel(key), numeric.has(key) ? Number(value) : value]),
  );
}
const conformance: AuditSinkConformanceAdapter = {
  acknowledgement: 'transport',
  retryableStatuses: [429, 502, 503, 504],
  terminalStatuses: [408, 500],
  partialOutcome: 'uncertain',
  wireFormat: 'otlp',
  create: (ctx) => auditOtlp({ id: 'archive' }).auditSinks[0]!.create(ctx),
  wireRecords: (body) =>
    resource(body).scopeLogs[0]!.logRecords.map((log) => fields(log.attributes)),
  decode: (body) => {
    const value = resource(body);
    expect(fields(value.resource.attributes)['deployment_id']).toBe('conformance');
    return {
      ...decodeFields(fields(value.resource.attributes)),
      records: value.scopeLogs[0]!.logRecords.map((log) => decodeFields(fields(log.attributes))),
    } as unknown as AuditBatchV1;
  },
  respond(reply, _batch, options) {
    if (reply === 'partial')
      return response({ partialSuccess: { rejectedLogRecords: options.rejectedCount } });
    if (reply === 'rejected') return response({}, options.status ?? 400);
    if (reply === 'retry')
      return { ...response({}, options.status), retryAfterMs: options.retryAfterMs ?? null };
    if (reply === 'bad_response' && options.invalid !== 'ack')
      return {
        ...response(
          {},
          200,
          options.invalid === 'content_type' ? 'text/plain' : 'application/json',
        ),
        body: options.invalid === 'body' ? '{' : '{}',
      };
    return response({});
  },
};

describe('OTLP audit sink', () => {
  it('passes every conformance fixture with transport acknowledgements', async () => {
    expect(await runAuditSinkConformance(conformance)).toEqual({
      passed: auditSinkConformanceFixturesFor(conformance).map(({ name }) => name),
      acknowledgement: 'transport',
      partialOutcome: 'uncertain',
      frontier: 'unsupported',
    });
  });

  it('declares defaults and operator options without exposing destination variables', () => {
    const definition = auditOtlp({ id: 'archive' });
    expect(definition).toMatchObject({
      id: 'audit-otlp-archive',
      apiVersion: 4,
      platforms: ['node', 'cloudflare'],
    });
    expect(definition.auditSinks[0]).toMatchObject({
      id: 'archive',
      kind: 'otlp',
      activation: 'build',
      custody: 'delivery',
      sourceIp: 'include',
      maxBatchEvents: 100,
      destination: { protocol: 'otlp-http-json' },
    });
    expect(definition.auditSinks[0]).not.toHaveProperty('envNames');
    expect(
      auditOtlp({
        id: 'archive',
        activation: 'env',
        durableAck: true,
        sourceIp: 'omit',
        maxBatchEvents: 5,
        endpointEnv: 'ARCHIVE_ENDPOINT',
        headersEnv: 'ARCHIVE_HEADERS',
      }).auditSinks[0],
    ).toMatchObject({
      activation: 'env',
      custody: 'durable',
      sourceIp: 'omit',
      maxBatchEvents: 5,
      destination: {
        protocol: 'otlp-http-json',
        endpointEnv: 'ARCHIVE_ENDPOINT',
        headersEnv: 'ARCHIVE_HEADERS',
      },
    });
    expect(sink(async () => response({}))).not.toHaveProperty('frontier');
  });

  it.each([
    null,
    [],
    {},
    { id: 'bad\n' },
    { id: 'archive', endpointEnv: 'bad-name' },
    { id: 'archive', headersEnv: 'HEADER\n' },
    { id: 'archive', durableAck: 'true' },
    { id: 'archive', sourceIp: 'hash' },
    { id: 'archive', activation: 'auto' },
    { id: 'archive', maxBatchEvents: 0 },
    { id: 'archive', maxBatchEvents: 101 },
    { id: 'archive', maxBatchEvents: 1.5 },
    { id: 'archive', maxBatchEvents: NaN },
    { id: 'archive', maxBatchEvents: '10' },
    { id: 'archive', skipAfter: 3 },
    { id: 'archive', url: 'ignored' },
  ])('rejects invalid options with a fixed error', (options) => {
    expect(() => auditOtlp(options as AuditOtlpOptions)).toThrowError(
      expect.objectContaining({
        name: 'AuditSinkConfigError',
        code: 'invalid_option',
        message: 'Invalid audit sink configuration',
      }),
    );
  });

  it('uses core endpoint precedence and isolates PB credentials', () => {
    const destination = auditOtlp({ id: 'archive' }).auditSinks[0]!.destination;
    if (destination.protocol !== 'otlp-http-json') throw new Error('Unexpected protocol');
    const values: Record<string, string> = {
      PB_AUDIT_OTLP_ENDPOINT: 'https://archive.example/logs',
      PB_AUDIT_OTLP_HEADERS: 'x-client=audit',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example/logs',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-client=logs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-client=generic',
    };
    const resolve = () => parseAuditOtelEnvironment((name) => values[name], destination);
    expect(resolve()).toMatchObject({
      endpoint: values['PB_AUDIT_OTLP_ENDPOINT'],
      activationSource: 'PB_AUDIT_OTLP_ENDPOINT',
      headers: { 'x-client': 'audit' },
    });
    delete values['PB_AUDIT_OTLP_HEADERS'];
    expect(resolve()?.headers).toEqual({});
    delete values['PB_AUDIT_OTLP_ENDPOINT'];
    expect(resolve()).toMatchObject({
      endpoint: values['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'],
      activationSource: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      headers: { 'x-client': 'logs' },
    });
    delete values['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'];
    expect(resolve()).toMatchObject({
      endpoint: 'https://generic.example/v1/logs',
      activationSource: 'OTEL_EXPORTER_OTLP_ENDPOINT',
      headers: { 'x-client': 'logs' },
    });
    delete values['OTEL_EXPORTER_OTLP_LOGS_HEADERS'];
    expect(resolve()?.headers).toEqual({ 'x-client': 'generic' });
  });

  it('sends deployment identity, exact payload, delivery time and caller signal through bound fetch', async () => {
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({}));
    const abort = signal();
    expect(await sink(fetch).deliver(batch, abort)).toEqual({
      outcome: 'accepted',
      chainId: batch.chainId,
      epoch: batch.epoch,
      throughSeq: batch.throughSeq,
      throughHash: batch.throughHash,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]![0];
    expect(Object.keys(request).sort()).toEqual(['body', 'contentType', 'signal']);
    expect(request.signal).toBe(abort);
    expect(request.contentType).toBe('application/json');
    expect(fields(resource(request.body).resource.attributes)['deployment_id']).toBe(
      'deployment-test',
    );
    expect(
      fields(resource(request.body).scopeLogs[0]!.logRecords[0]!.attributes)['payload_json'],
    ).toBe(record.payloadJson);
    expect(resource(request.body).scopeLogs[0]!.logRecords[0]!.observedTimeUnixNano).toBe(
      String(BigInt(batch.frozenAt) * 1_000_000n),
    );
  });

  it('encodes the upper frozenAt boundary as uint64 nanoseconds', async () => {
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({}));
    expect(
      await sink(fetch).deliver({ ...batch, frozenAt: 18446744073709 }, signal()),
    ).toMatchObject({ outcome: 'accepted' });
    expect(
      resource(fetch.mock.calls[0]![0].body).scopeLogs[0]!.logRecords[0]!.observedTimeUnixNano,
    ).toBe('18446744073709000000');
  });

  it('preserves request bytes when a frozen batch is retried after restart', async () => {
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({}));
    await sink(fetch).deliver(batch, signal());
    await sink(fetch, () => new Date(observed.getTime() + 60_000)).deliver(batch, signal());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0].body).toBe(fetch.mock.calls[0]![0].body);
  });

  it.each([
    400, 401, 403, 404, 408, 413, 422, 429, 500, 501, 502, 503, 504, 505, 599, 201, 204, 301,
  ])('classifies HTTP %s with one request', async (status) => {
    const fetch = vi
      .fn<AuditBoundFetch>()
      .mockResolvedValue({ ...response({}, status), retryAfterMs: 1_000_000 });
    expect(await sink(fetch).deliver(batch, signal())).toEqual(
      [429, 502, 503, 504].includes(status)
        ? { outcome: 'retry', code: 'http_status', retryAfterMs: 1_000_000 }
        : status >= 200 && status < 300
          ? { outcome: 'retry', code: 'bad_response' }
          : { outcome: 'rejected', code: status === 413 ? 'too_large' : 'http_status' },
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { partialSuccess: {} },
    { partialSuccess: { rejectedLogRecords: 0 } },
    { partialSuccess: { rejectedLogRecords: '0', errorMessage: '' } },
  ])('accepts full OTLP responses', async (body) => {
    expect(
      (
        await sink(async () => response(body, 200, 'Application/JSON; charset=utf-8')).deliver(
          batch,
          signal(),
        )
      ).outcome,
    ).toBe('accepted');
  });
  it('returns a fixed warning code without receiver text', async () => {
    const result = await sink(async () =>
      response({
        partialSuccess: { rejectedLogRecords: '0', errorMessage: 'receiver diagnostic' },
      }),
    ).deliver(batch, signal());
    expect(result).toEqual({
      outcome: 'accepted_with_warning',
      chainId: batch.chainId,
      epoch: batch.epoch,
      throughSeq: batch.throughSeq,
      throughHash: batch.throughHash,
      code: 'partial_success',
    });
  });
  it.each([1, '1', 100])('never retries partial rejection %s', async (count) => {
    expect(
      await sink(async () =>
        response({
          partialSuccess: { rejectedLogRecords: count, errorMessage: 'receiver diagnostic' },
        }),
      ).deliver(batch, signal()),
    ).toEqual({ outcome: 'uncertain', code: 'partial_rejected', rejectedCount: Number(count) });
  });
  it.each([-1, 1.5, 'invalid', null, true, {}, '9007199254740992'])(
    'preserves invalid partial counts as unknown uncertainty',
    async (count) => {
      expect(
        await sink(async () => response({ partialSuccess: { rejectedLogRecords: count } })).deliver(
          batch,
          signal(),
        ),
      ).toEqual({ outcome: 'uncertain', code: 'partial_rejected', rejectedCount: NaN });
    },
  );
  it.each([
    null,
    [],
    'invalid',
    { partialSuccess: null },
    { partialSuccess: [] },
    { partialSuccess: { errorMessage: 1 } },
  ])('retries malformed success responses', async (body) => {
    expect(await sink(async () => response(body)).deliver(batch, signal())).toEqual({
      outcome: 'retry',
      code: 'bad_response',
    });
  });

  it.each([undefined, ''])('refuses missing or empty deployment identity', (deploymentId) => {
    expect(() =>
      auditOtlp({ id: 'archive' }).auditSinks[0]!.create({
        deploymentId,
        runtime: 'docker',
        fetch: vi.fn(),
        env: () => undefined,
        clock: { now: () => observed },
      } as unknown as AuditSinkContext),
    ).toThrowError(
      expect.objectContaining({
        name: 'AuditSinkConfigError',
        code: 'invalid_option',
        message: 'Invalid audit sink configuration',
      }),
    );
  });

  it.each([1, 100])('accepts maxBatchEvents boundary %s', (maxBatchEvents) => {
    expect(auditOtlp({ id: 'archive', maxBatchEvents }).auditSinks[0]!.maxBatchEvents).toBe(
      maxBatchEvents,
    );
  });

  it('refuses PB headers when the endpoint falls back to OTEL', () => {
    const destination = auditOtlp({ id: 'archive' }).auditSinks[0]!.destination;
    if (destination.protocol !== 'otlp-http-json') throw new Error('Unexpected protocol');
    const values: Record<string, string> = {
      PB_AUDIT_OTLP_HEADERS: 'x-client=audit',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example',
    };
    expect(() => parseAuditOtelEnvironment((name) => values[name], destination)).toThrowError(
      expect.objectContaining({
        code: 'invalid_endpoint',
        message: 'Invalid audit sink configuration',
      }),
    );
  });

  it('uses custom endpoint and headers variables with PB precedence and isolation', () => {
    const destination = auditOtlp({
      id: 'archive',
      endpointEnv: 'ARCHIVE_ENDPOINT',
      headersEnv: 'ARCHIVE_HEADERS',
    }).auditSinks[0]!.destination;
    if (destination.protocol !== 'otlp-http-json') throw new Error('Unexpected protocol');
    const values: Record<string, string> = {
      ARCHIVE_ENDPOINT: 'https://archive.example/logs',
      ARCHIVE_HEADERS: 'x-client=custom',
      PB_AUDIT_OTLP_ENDPOINT: 'https://pb.example/logs',
      PB_AUDIT_OTLP_HEADERS: 'x-client=pb',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-client=otel',
    };
    const resolve = () => parseAuditOtelEnvironment((name) => values[name], destination);
    expect(resolve()).toMatchObject({
      endpoint: values['ARCHIVE_ENDPOINT'],
      activationSource: 'ARCHIVE_ENDPOINT',
      headers: { 'x-client': 'custom' },
    });
    delete values['ARCHIVE_HEADERS'];
    expect(resolve()?.headers).toEqual({});
    delete values['ARCHIVE_ENDPOINT'];
    expect(resolve()).toMatchObject({
      endpoint: 'https://generic.example/v1/logs',
      headers: { 'x-client': 'otel' },
    });
  });

  it('maps transport too_large to terminal rejection', async () => {
    expect(
      await sink(async () => {
        throw new AuditTransportError('too_large');
      }).deliver(batch, signal()),
    ).toEqual({ outcome: 'rejected', code: 'too_large' });
  });

  it.each([1, 2])('lets core resolve an oversized OTLP encoding of %s records', async (count) => {
    const limit = 512 * 1024;
    const records = Array.from({ length: count }, (_, i) => ({
      ...record,
      seq: i + 1,
      prevHash: i === 0 ? record.prevHash : record.hash,
      payloadJson: '',
    }));
    const input = { ...batch, records, throughSeq: count };
    const overhead = new TextEncoder().encode(encodeAuditBatch(input, 'deployment-test')).length;
    const payloadLength = Math.floor((limit - overhead) / count) + 1;
    input.records = records.map((r) => ({ ...r, payloadJson: 'x'.repeat(payloadLength) }));
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(limit);
    expect(() => encodeAuditBatch(input, 'deployment-test')).toThrow(RangeError);
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({}));
    const deliver = vi.fn(sink(fetch).deliver);
    const org = orgContext(batch.orgId);
    const fence = systemMutationFence('audit-export', { id: 'job', owner: 'owner', fence: 1 }, {});
    let snapshot: AuditExportSnapshot = {
      chainId: batch.chainId,
      epoch: batch.epoch,
      incarnation: 0,
      modeGeneration: 0,
      boundarySeq: 1,
      boundaryPrevHash: record.prevHash,
      policy: 'availability',
      highestGeneration: 1,
      restorePending: false,
      sink: {
        id: 'archive',
        pluginId: 'audit-otlp-archive',
        kind: 'otlp',
        generation: 1,
        receiverFingerprint: 'a'.repeat(64),
        activationSource: 'build',
        state: 'active',
        blockedReason: null,
        durableAck: false,
        progressSeq: 0,
        progressHash: record.prevHash,
        custodySeq: 0,
        inflightFrom: 1,
        inflightTo: count,
        inflightBody: JSON.stringify(input),
        inflightRepr: JSON.stringify({ purpose: 'events', custodyFromSeq: 1 }),
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
      },
    };
    const port: AuditExportPort = {
      read: async () => structuredClone(snapshot),
      page: async () => [],
      capacityGap: async () => null,
      save: async (ctx, _fence, expected, next) => {
        expect(ctx).toEqual(org);
        expect(expected).toEqual(snapshot);
        snapshot = { ...snapshot, sink: structuredClone(next) };
        return true;
      },
      hold: async () => {
        throw new Error('Unexpected hold');
      },
    };
    const run = () =>
      exportAuditBatch(
        port,
        org,
        fence,
        {
          id: 'archive',
          generation: 1,
          pluginVersion: 'test',
          sourceIp: 'include',
          rejectionRetries: 'terminal',
          sink: { deliver },
          now: () => observed,
        },
        signal(),
      );
    expect(await run()).toBe('resolved');
    expect(snapshot.sink.lastErrorCode).toBe('too_large');
    expect(snapshot.sink.retryCountForSeq).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const next = JSON.parse(snapshot.sink.inflightBody!) as AuditBatchV1;
    if (count === 2) {
      expect(next.records).toEqual(input.records.slice(0, 1));
      expect(JSON.parse(snapshot.sink.inflightRepr!).rejectionTail[0].records).toEqual(
        input.records.slice(1),
      );
      expect(await run()).toBe('accepted');
      expect(await run()).toBe('accepted');
    } else {
      expect(next.records[0]).toMatchObject({ kind: 'tombstone', reasonCode: 'too_large' });
      expect(await run()).toBe('accepted');
      expect(deliver.mock.calls.map(([b]) => b.records[0]!.kind)).toEqual(['event', 'tombstone']);
    }
    expect(snapshot.sink.progressSeq).toBe(count);
  });

  it('propagates transport failure without replay', async () => {
    const failure = new Error('Transport failed');
    const fetch = vi.fn<AuditBoundFetch>().mockRejectedValue(failure);
    await expect(sink(fetch).deliver(batch, signal())).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
