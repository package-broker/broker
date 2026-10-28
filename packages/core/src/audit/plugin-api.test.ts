import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext, type OrgContext } from '../db/port.js';
import {
  AuditSinkConfigError,
  definePlugin,
  type AuditBatchV1,
  type AuditDelivery,
  type AuditFetch,
  type AuditHeadV1,
  type AuditJournalReader,
  type AuditMarkerV1,
  type AuditRecordV1,
  type AuditSink,
  type AuditSinkContext,
  type AuditSinkFactory,
  type AuditTrailContext,
  type AuditTrailFactory,
  type AuditVerificationScopeV1,
  type PluginDefinition,
} from '../plugin.js';

const record = {
  chainId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  epoch: 1,
  id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
  org_id: '01JZZZZZZZZZZZZZZZZZZZZZZX',
  seq: 1,
  prev_hash: '0'.repeat(64),
  hash: 'a'.repeat(64),
  created_at: '2026-10-28T00:00:00.000Z',
  actor_type: 'system',
  actor_id: null,
  token_selector: null,
  action: 'session.logout',
  target_type: 'session',
  target_id: null,
  project_id: null,
  payload_json: '{}',
} as const satisfies AuditRecordV1;

const batch: AuditBatchV1 = {
  v: 1,
  chainId: record.chainId,
  epoch: record.epoch,
  orgId: record.org_id,
  records: [record],
  throughSeq: record.seq,
  throughHash: record.hash,
};

function compileTimeFailures(
  journal: AuditJournalReader,
  org: OrgContext,
  scope: AuditVerificationScopeV1,
  input: AuditBatchV1,
  inputRecord: AuditRecordV1,
  marker: Extract<AuditMarkerV1, { kind: 'withheld' }>,
): void {
  // @ts-expect-error org scope cannot be omitted
  void journal.head();
  // @ts-expect-error a raw organization id is not an authority context
  void journal.page(org.orgId, 0, 100);
  // @ts-expect-error list requires a project scope
  void journal.list(org, { limit: 100 });
  // @ts-expect-error verification writes require org scope
  void journal.markVerified(scope);
  // @ts-expect-error plugins cannot append journal rows
  journal.append(record);
  // @ts-expect-error plugins cannot prune journal rows
  journal.prune(org, 1);
  // @ts-expect-error batch metadata is immutable
  input.throughSeq = 2;
  // @ts-expect-error batch contents are immutable
  input.records.push(record);
  // @ts-expect-error records are immutable
  inputRecord.payload_json = 'changed';
  // @ts-expect-error markers are immutable
  marker.marker_id = 'changed';
  // @ts-expect-error withheld markers never expose stored payloads
  void marker.payload_json;
  // @ts-expect-error withheld markers omit selectors
  void marker.token_selector;
  // @ts-expect-error withheld markers omit source IP
  void marker.sourceIp;
}

function invalidResults(): void {
  // @ts-expect-error ACK must include its hash
  const missingHash: AuditDelivery = { outcome: 'accepted', throughSeq: 1 };
  // @ts-expect-error arbitrary response text is not a diagnostic code
  const unsafeCode: AuditDelivery = { outcome: 'retry', code: 'receiver response text' };
  // @ts-expect-error uncertainty requires the rejected count
  const missingCount: AuditDelivery = { outcome: 'uncertain', code: 'partial_rejected' };
  // @ts-expect-error schema version is pinned
  const wrongVersion: AuditBatchV1 = { ...batch, v: 2 };
  // @ts-expect-error markers have a distinct identity
  const missingMarkerId: AuditMarkerV1 = {
    kind: 'head',
    v: 1,
    chain_id: record.chainId,
    epoch: 1,
    org_id: record.org_id,
    seq: 1,
    hash: record.hash,
    boundary_seq: 1,
  };
  const unsafeFetch: Parameters<AuditFetch>[0] = {
    url: 'https://example.test',
    headers: {},
    body: '{}',
    signal: new AbortController().signal,
    // @ts-expect-error transport does not expose redirect controls
    redirect: 'follow',
  };
  const invalidTrail: PluginDefinition = {
    id: 'x',
    package: '@test/x',
    apiVersion: 4,
    platforms: ['node'],
    // @ts-expect-error auditTrail must be a factory
    auditTrail: true,
  };
  // @ts-expect-error auditSinks must return sinks
  const invalidSinks: AuditSinkFactory = () => [{}];
  // @ts-expect-error only fixed configuration error codes are accepted
  new AuditSinkConfigError('receiver response text');
  void [
    missingHash,
    unsafeCode,
    missingCount,
    wrongVersion,
    missingMarkerId,
    unsafeFetch,
    invalidTrail,
    invalidSinks,
  ];
}

describe('public audit plugin contract', () => {
  it('exports factories through the plugin entry point without widening plugin ports', () => {
    expectTypeOf<PluginDefinition['auditTrail']>().toEqualTypeOf<AuditTrailFactory | undefined>();
    expectTypeOf<PluginDefinition['auditSinks']>().toEqualTypeOf<AuditSinkFactory | undefined>();
    expectTypeOf<keyof AuditTrailContext>().toEqualTypeOf<'journal' | 'env'>();
    expectTypeOf<keyof AuditSinkContext>().toEqualTypeOf<'runtime' | 'env' | 'fetch' | 'clock'>();
    expectTypeOf<Parameters<AuditJournalReader['head']>>().toEqualTypeOf<[OrgContext]>();
    expectTypeOf<Awaited<ReturnType<AuditJournalReader['head']>>>().toEqualTypeOf<AuditHeadV1>();
    expectTypeOf<Parameters<AuditJournalReader['markVerified']>>().toEqualTypeOf<
      [OrgContext, AuditVerificationScopeV1]
    >();
    expectTypeOf(compileTimeFailures).toBeFunction();
    expectTypeOf(invalidResults).toBeFunction();
  });

  it('supports a trail and sinks on the same API 4 plugin', async () => {
    const sink: AuditSink = {
      id: 'archive',
      kind: 'webhook',
      envNames: ['PB_AUDIT_WEBHOOK_URL'],
      custody: 'durable',
      sourceIp: 'omit',
      activate: () => null,
      deliver: async (input, signal) => {
        expect(signal.aborted).toBe(false);
        return {
          outcome: 'accepted',
          throughSeq: input.throughSeq,
          throughHash: input.throughHash,
        };
      },
    };
    const plugin = definePlugin({
      id: 'audit',
      package: '@test/audit',
      platforms: ['node', 'cloudflare'],
      apiVersion: 4,
      binds: ['audit-trail'],
      auditTrail: (ctx) => ({
        envNames: ['PB_AUDIT_TRAIL'],
        active: () => ctx.env('PB_AUDIT_TRAIL') !== 'off',
      }),
      auditSinks: () => [sink],
    });
    const journal: AuditJournalReader = {
      list: async () => ({ items: [record], next: null }),
      head: async () => ({
        chainId: record.chainId,
        epoch: 1,
        headSeq: 1,
        headHash: record.hash,
        boundarySeq: 1,
        boundaryPrevHash: record.prev_hash,
        pendingCount: 0,
        verification: null,
      }),
      page: async () => [record],
      markVerified: async () => undefined,
    };
    expect(plugin.auditTrail({ journal, env: () => 'off' }).active()).toBe(false);
    expect(plugin.auditSinks()).toEqual([sink]);
    expect(sink.activate()).toBeNull();
    expect(await sink.deliver(batch, new AbortController().signal)).toEqual({
      outcome: 'accepted',
      throughSeq: 1,
      throughHash: record.hash,
    });
    expect(await journal.list(orgContext(record.org_id), { projectId: null, limit: 100 })).toEqual({
      items: [record],
      next: null,
    });
  });

  it('covers all delivery outcomes with fixed codes', () => {
    const results = [
      { outcome: 'accepted', throughSeq: 1, throughHash: record.hash },
      {
        outcome: 'accepted_with_warning',
        throughSeq: 1,
        throughHash: record.hash,
        code: 'partial_success',
      },
      { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 },
      { outcome: 'retry', code: 'bad_response', retryAfterMs: 1_000_000 },
      { outcome: 'rejected', code: 'http_status' },
    ] as const satisfies readonly AuditDelivery[];
    expectTypeOf<AuditDelivery['outcome']>().toEqualTypeOf<
      'accepted' | 'accepted_with_warning' | 'uncertain' | 'retry' | 'rejected'
    >();
    expect(results).toHaveLength(5);
  });

  it('pins every marker kind and the withheld safe fields', () => {
    expectTypeOf<AuditMarkerV1['kind']>().toEqualTypeOf<
      | 'boundary'
      | 'gap'
      | 'tombstone'
      | 'delivery_uncertain'
      | 'withheld'
      | 'fork'
      | 'receiver_changed'
      | 'head'
    >();
    expectTypeOf<keyof Extract<AuditMarkerV1, { kind: 'withheld' }>>().toEqualTypeOf<
      | 'v'
      | 'chain_id'
      | 'epoch'
      | 'org_id'
      | 'marker_id'
      | 'kind'
      | 'reason'
      | 'id'
      | 'seq'
      | 'prev_hash'
      | 'hash'
      | 'created_at'
      | 'actor_type'
      | 'actor_id'
      | 'action'
      | 'target_type'
      | 'target_id'
      | 'project_id'
    >();
    expectTypeOf<AuditRecordV1['sourceIp']>().toEqualTypeOf<string | undefined>();
  });

  it('uses a fixed configuration error message', () => {
    const error = new AuditSinkConfigError('invalid_endpoint');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditSinkConfigError');
    expect(error.message).toBe('Invalid audit sink configuration');
    expect(error.code).toBe('invalid_endpoint');
  });
});
