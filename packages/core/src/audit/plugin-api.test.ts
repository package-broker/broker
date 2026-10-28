import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  AuditSinkConfigError,
  definePlugin,
  type AuditBatchV1,
  type AuditBoundFetch,
  type AuditDelivery,
  type AuditDestinationSpec,
  type AuditHeadV1,
  type AuditJournalItemV1,
  type AuditJournalReader,
  type AuditMarkerV1,
  type AuditPositionV1,
  type AuditRecordV1,
  type AuditSink,
  type AuditSinkContext,
  type AuditSinkDefinition,
  type AuditTrail,
  type AuditTrailContext,
  type AuditTrailDefinition,
  type AuditWithheldMarkerV1,
  type OrgContext,
  type PluginDefinition,
} from '../plugin.js';

const record = {
  kind: 'event',
  chainId: 'chain',
  epoch: 1,
  id: 'event',
  orgId: 'org',
  seq: 1,
  prevHash: '0'.repeat(64),
  hash: 'a'.repeat(64),
  createdAt: '2026-10-28T00:00:00.000Z',
  actorType: 'system',
  actorId: null,
  tokenSelector: null,
  action: 'session.logout',
  targetType: 'session',
  targetId: null,
  projectId: null,
  payloadJson: '{}',
  sourceIp: null,
} as const satisfies AuditRecordV1;

const withheld = {
  kind: 'withheld',
  markerId: 'withheld-marker',
  chainId: record.chainId,
  epoch: record.epoch,
  id: record.id,
  orgId: record.orgId,
  seq: record.seq,
  prevHash: record.prevHash,
  hash: record.hash,
  createdAt: record.createdAt,
  actorType: record.actorType,
  actorId: record.actorId,
  action: record.action,
  targetType: record.targetType,
  targetId: record.targetId,
  projectId: record.projectId,
  reasonCode: 'sanitizer_mismatch',
} as const satisfies AuditWithheldMarkerV1;

const batch: AuditBatchV1 = {
  v: 1,
  chainId: record.chainId,
  epoch: record.epoch,
  orgId: record.orgId,
  records: [record],
  throughSeq: record.seq,
  throughHash: record.hash,
};

function removedCapabilities(
  journal: AuditJournalReader,
  org: OrgContext,
  trail: AuditTrailContext,
  input: AuditBatchV1,
  inputRecord: AuditRecordV1,
  marker: AuditWithheldMarkerV1,
): void {
  // @ts-expect-error org scope is bound by core
  void journal.head(org);
  // @ts-expect-error raw ids cannot supply authority
  void journal.head(org.orgId);
  // @ts-expect-error project scope is required
  void journal.list({ limit: 100 });
  // @ts-expect-error verification scope is bound by core
  void trail.requestVerification(org);
  // @ts-expect-error journal queries cannot select another organization
  void journal.list(org, { projectId: null, limit: 100 });
  // @ts-expect-error activity is resolved by core
  trail.active();
  // @ts-expect-error batch metadata is immutable
  input.throughSeq = 2;
  // @ts-expect-error batch contents are immutable
  input.records.push(record);
  // @ts-expect-error records are immutable
  inputRecord.payloadJson = 'changed';
  // @ts-expect-error markers are immutable
  marker.markerId = 'changed';
  // @ts-expect-error withheld bodies are never exposed
  void marker.payloadJson;
  // @ts-expect-error withheld selectors are never exposed
  void marker.tokenSelector;
  // @ts-expect-error withheld IPs are never exposed
  void marker.sourceIp;
  // @ts-expect-error wire casing is not public TypeScript casing
  void inputRecord.payload_json;
  // @ts-expect-error markers use camelCase too
  void marker.chain_id;
  // @ts-expect-error OrgContext is branded, even through the public entry
  const forgedOrg: OrgContext = { orgId: 'org' };
  void forgedOrg;
}

function invalidDefinitionsAndResults(): void {
  const ack = {
    outcome: 'accepted',
    chainId: 'chain',
    epoch: 1,
    throughSeq: 1,
    throughHash: record.hash,
  } as const;
  const { chainId, ...noChain } = ack;
  const { epoch, ...noEpoch } = ack;
  const { throughHash, ...noHash } = ack;
  const { throughSeq, ...noSeq } = ack;
  // @ts-expect-error ACK requires chain identity
  const missingChain: AuditDelivery = noChain;
  // @ts-expect-error ACK requires epoch
  const missingEpoch: AuditDelivery = noEpoch;
  // @ts-expect-error ACK requires hash
  const missingHash: AuditDelivery = noHash;
  // @ts-expect-error ACK requires sequence
  const missingSeq: AuditDelivery = noSeq;
  // @ts-expect-error warning ACK also requires full identity
  const missingWarningIdentity: AuditDelivery = {
    outcome: 'accepted_with_warning',
    throughSeq: 1,
    throughHash: record.hash,
    code: 'partial_success',
  };
  // @ts-expect-error arbitrary receiver text cannot be a diagnostic
  const unsafeCode: AuditDelivery = { outcome: 'retry', code: 'receiver response text' };
  // @ts-expect-error rejected count is required
  const missingCount: AuditDelivery = { outcome: 'uncertain', code: 'partial_rejected' };
  // @ts-expect-error schema is pinned
  const wrongVersion: AuditBatchV1 = { ...batch, v: 2 };
  // @ts-expect-error all records need the discriminator
  const missingKind: AuditRecordV1 = { ...record, kind: undefined };
  // @ts-expect-error marker identity is mandatory
  const missingMarkerId: AuditMarkerV1 = {
    kind: 'head',
    chainId: 'chain',
    epoch: 1,
    seq: 1,
    hash: record.hash,
    boundarySeq: 1,
  };
  const directUrl: AuditDestinationSpec = {
    protocol: 'https-json',
    urlEnv: 'URL',
    // @ts-expect-error destinations are declared, not supplied as URLs
    url: 'https://example.test',
  };
  const privateDestination: AuditDestinationSpec = {
    protocol: 'https-json',
    urlEnv: 'URL',
    // @ts-expect-error private egress is not a plugin declaration
    allowPrivate: true,
  };
  const directHeaders: AuditDestinationSpec = {
    protocol: 'https-json',
    urlEnv: 'URL',
    // @ts-expect-error headers must be resolved from declared env names
    headers: {},
  };
  // @ts-expect-error trail must be a static definition
  const trailFactory: NonNullable<PluginDefinition['auditTrail']> = () => ({});
  // @ts-expect-error sinks must be static definitions
  const sinkFactory: NonNullable<PluginDefinition['auditSinks']> = () => [];
  // @ts-expect-error sink factories return a single sink
  const multipleSinks: AuditSinkDefinition['create'] = () => [];
  // @ts-expect-error only fixed configuration diagnostics are accepted
  new AuditSinkConfigError('receiver response text');
  void [
    chainId,
    epoch,
    throughHash,
    throughSeq,
    missingChain,
    missingEpoch,
    missingHash,
    missingSeq,
    missingWarningIdentity,
    unsafeCode,
    missingCount,
    wrongVersion,
    missingKind,
    missingMarkerId,
    directUrl,
    privateDestination,
    directHeaders,
    trailFactory,
    sinkFactory,
    multipleSinks,
  ];
}

describe('public audit plugin contract', () => {
  it('exports static definitions and organization-scoped read capabilities', () => {
    expectTypeOf<PluginDefinition['auditTrail']>().toEqualTypeOf<
      AuditTrailDefinition | undefined
    >();
    expectTypeOf<PluginDefinition['auditSinks']>().toEqualTypeOf<
      readonly AuditSinkDefinition[] | undefined
    >();
    expectTypeOf<NonNullable<PluginDefinition['binds']>[number]>().toEqualTypeOf<
      'source' | 'identity' | 'audit-trail'
    >();
    expectTypeOf<keyof AuditTrailContext>().toEqualTypeOf<
      'active' | 'journal' | 'requestVerification'
    >();
    expectTypeOf<keyof AuditTrail>().toEqualTypeOf<never>();
    expectTypeOf<keyof AuditSink>().toEqualTypeOf<'deliver' | 'frontier'>();
    expectTypeOf<keyof AuditSinkContext>().toEqualTypeOf<'runtime' | 'env' | 'fetch' | 'clock'>();
    expectTypeOf<keyof Parameters<AuditBoundFetch>[0]>().toEqualTypeOf<
      'body' | 'contentType' | 'signal'
    >();
    expectTypeOf<keyof Awaited<ReturnType<AuditBoundFetch>>>().toEqualTypeOf<
      'status' | 'contentType' | 'retryAfterMs' | 'body'
    >();
    expectTypeOf<keyof AuditSinkDefinition>().toEqualTypeOf<
      | 'id'
      | 'kind'
      | 'destination'
      | 'envNames'
      | 'activation'
      | 'custody'
      | 'sourceIp'
      | 'maxBatchEvents'
      | 'skipAfter'
      | 'create'
    >();
    expectTypeOf<keyof AuditTrailDefinition>().toEqualTypeOf<'toggleEnv' | 'create'>();
    expectTypeOf<keyof AuditJournalReader>().toEqualTypeOf<'list' | 'head'>();
    expectTypeOf<Parameters<AuditJournalReader['head']>>().toEqualTypeOf<[]>();
    expectTypeOf<Awaited<ReturnType<AuditJournalReader['head']>>>().toEqualTypeOf<AuditHeadV1>();
    expectTypeOf<Awaited<ReturnType<AuditJournalReader['list']>>['items']>().toEqualTypeOf<
      readonly AuditJournalItemV1[]
    >();
    expectTypeOf<AuditJournalItemV1>().toEqualTypeOf<AuditRecordV1 | AuditWithheldMarkerV1>();
    expectTypeOf<Parameters<AuditTrailContext['requestVerification']>>().toEqualTypeOf<[]>();
    expectTypeOf<
      Awaited<ReturnType<NonNullable<AuditSink['frontier']>>>
    >().toEqualTypeOf<AuditPositionV1 | null>();
    expectTypeOf(removedCapabilities).toBeFunction();
    expectTypeOf(invalidDefinitionsAndResults).toBeFunction();
  });

  it('composes static trail and sink definitions with a bound transport', async () => {
    const journal: AuditJournalReader = {
      list: async () => ({ items: [record, withheld], next: null }),
      head: async () => ({
        chainId: record.chainId,
        epoch: 1,
        headSeq: 1,
        headHash: record.hash,
        boundarySeq: 1,
        boundaryPrevHash: record.prevHash,
        pendingCount: 0,
        verification: null,
      }),
    };
    const org = orgContext(record.orgId);
    let requestedOrg: OrgContext | undefined;
    const plugin = definePlugin({
      id: 'audit',
      package: '@test/audit',
      platforms: ['node', 'cloudflare'],
      apiVersion: 4,
      binds: ['audit-trail'],
      auditTrail: {
        toggleEnv: 'PB_AUDIT_TRAIL',
        create: (ctx) => {
          expect(ctx.active).toBe(false);
          void ctx.requestVerification();
          return {};
        },
      },
      auditSinks: [
        {
          id: 'archive',
          kind: 'webhook',
          destination: {
            protocol: 'https-json',
            urlEnv: 'PB_AUDIT_WEBHOOK_URL',
            headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS',
          },
          envNames: ['ARCHIVE_FORMAT'],
          activation: 'env',
          custody: 'durable',
          sourceIp: 'omit',
          create: (ctx) => ({
            deliver: async (input, signal) => {
              const response = await ctx.fetch({
                body: JSON.stringify(input),
                contentType: 'application/json',
                signal,
              });
              expect(response.status).toBe(200);
              return {
                outcome: 'accepted',
                chainId: input.chainId,
                epoch: input.epoch,
                throughSeq: input.throughSeq,
                throughHash: input.throughHash,
              };
            },
          }),
        },
      ],
    });
    plugin.auditTrail.create({
      active: false,
      journal,
      requestVerification: async () => {
        requestedOrg = org;
      },
    });
    expect(requestedOrg).toBe(org);
    const sink = plugin.auditSinks[0].create({
      runtime: 'docker',
      clock: fixedClock('2026-10-28T00:00:00Z'),
      env: () => undefined,
      fetch: async (request) => {
        expect(JSON.parse(request.body)).toEqual(batch);
        expect(request.contentType).toBe('application/json');
        return { status: 200, contentType: 'application/json', retryAfterMs: null, body: '{}' };
      },
    });
    expect(await sink.deliver(batch, new AbortController().signal)).toEqual({
      outcome: 'accepted',
      chainId: batch.chainId,
      epoch: batch.epoch,
      throughSeq: batch.throughSeq,
      throughHash: batch.throughHash,
    });
    const page = await journal.list({ projectId: null, limit: 100 });
    expect(
      page.items.map((item) => (item.kind === 'event' ? item.payloadJson : item.reasonCode)),
    ).toEqual(['{}', 'sanitizer_mismatch']);
    const otlp = { protocol: 'otlp-http-json' } as const satisfies AuditDestinationSpec;
    expect(otlp.protocol).toBe('otlp-http-json');
  });

  it('covers marker-only batches and all delivery outcomes', () => {
    const identity = { markerId: 'marker', chainId: record.chainId, epoch: record.epoch };
    const markers = [
      {
        ...identity,
        kind: 'boundary',
        boundarySeq: 1,
        boundaryPrevHash: record.prevHash,
        provenance: 'genesis',
      },
      { ...identity, kind: 'fork', lastCommonSeq: 0, lastCommonHash: record.prevHash },
      { ...identity, kind: 'receiver_changed', oldFingerprint: 'old', newFingerprint: 'new' },
      { ...identity, kind: 'head', seq: 1, hash: record.hash, boundarySeq: 1 },
      {
        ...identity,
        kind: 'gap',
        fromSeq: 1,
        toSeq: 1,
        count: 1,
        prevHash: record.prevHash,
        hash: record.hash,
        reason: 'capacity',
        policyGeneration: 1,
      },
      {
        ...identity,
        kind: 'tombstone',
        seq: 1,
        prevHash: record.prevHash,
        hash: record.hash,
        reasonCode: 'http_status',
      },
      {
        ...identity,
        kind: 'delivery_uncertain',
        fromSeq: 1,
        toSeq: 1,
        hash: record.hash,
        reasonCode: 'partial_rejected',
      },
      withheld,
    ] as const satisfies readonly AuditMarkerV1[];
    const initial: AuditBatchV1 = {
      ...batch,
      records: markers.slice(0, 4),
      throughSeq: 0,
      throughHash: record.prevHash,
    };
    const advancing: AuditBatchV1 = { ...batch, records: markers.slice(4) };
    expect(initial.throughSeq).toBe(0);
    expect(initial.throughHash).toBe(record.prevHash);
    expect(advancing.throughSeq).toBe(withheld.seq);
    expect(advancing.throughHash).toBe(withheld.hash);
    const ack = {
      chainId: batch.chainId,
      epoch: batch.epoch,
      throughSeq: batch.throughSeq,
      throughHash: batch.throughHash,
    };
    const results = [
      { outcome: 'accepted', ...ack },
      { outcome: 'accepted_with_warning', ...ack, code: 'partial_success' },
      { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: 1 },
      { outcome: 'retry', code: 'bad_response', retryAfterMs: 1_000_000 },
      { outcome: 'rejected', code: 'http_status' },
    ] as const satisfies readonly AuditDelivery[];
    expect(results).toHaveLength(5);
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
    expectTypeOf<keyof AuditWithheldMarkerV1>().toEqualTypeOf<keyof typeof withheld>();
    expectTypeOf<AuditRecordV1['sourceIp']>().toEqualTypeOf<string | null | undefined>();
  });

  it('uses a fixed configuration error message', () => {
    const error = new AuditSinkConfigError('invalid_endpoint');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuditSinkConfigError');
    expect(error.message).toBe('Invalid audit sink configuration');
    expect(error.code).toBe('invalid_endpoint');
  });
});
