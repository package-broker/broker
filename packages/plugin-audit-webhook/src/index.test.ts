import { describe, expect, it, vi } from 'vitest';
import type { AuditBatchV1, AuditBoundFetch, AuditSinkContext } from '@package-broker/core/plugin';
import {
  auditCanonicalVectors,
  auditSinkConformanceFixtures,
  runAuditSinkConformance,
  type AuditSinkConformanceAdapter,
} from '@package-broker/core/plugin/testing';
import {
  collectAuditDefinitions,
  snapshotPluginGate,
} from '@package-broker/core/kernel/registry-audit';
import { detectAuditFork, type AuditForkSnapshot } from '@package-broker/core/audit/fork';
import { orgContext } from '@package-broker/core/db/port';
import auditWebhook, { type AuditWebhookOptions } from './index.js';

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
const ack = {
  chain_id: batch.chainId,
  epoch: batch.epoch,
  seq: batch.throughSeq,
  hash: batch.throughHash,
};
const response = (body: unknown, status = 200, contentType = 'application/json') => ({
  body: JSON.stringify(body),
  status,
  contentType,
  retryAfterMs: null,
});
function sink(fetch: AuditBoundFetch) {
  return auditWebhook({ id: 'archive' }).auditSinks[0]!.create({
    deploymentId: 'deployment-test',
    runtime: 'docker',
    fetch,
    env: () => {
      throw new Error('No environment access');
    },
    clock: { now: () => new Date(0) },
  });
}
const signal = () => new AbortController().signal;

const conformance: AuditSinkConformanceAdapter = {
  acknowledgement: 'receiver',
  partialOutcome: 'unsupported',
  wireFormat: 'json',
  create: (ctx: AuditSinkContext) => auditWebhook({ id: 'archive' }).auditSinks[0]!.create(ctx),
  wireRecords: (body) => (JSON.parse(body) as { records: Record<string, unknown>[] }).records,
  decode(body) {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (value['probe'] === 'frontier') {
      expect(Object.keys(value).sort()).toEqual(['chain_id', 'org_id', 'probe', 'v']);
      return null;
    }
    expect(Object.keys(value).sort()).toEqual([
      'chain_id',
      'deployment_id',
      'epoch',
      'org_id',
      'records',
      'v',
    ]);
    expect(value['deployment_id']).toBe('conformance');
    const records = (value['records'] as Record<string, unknown>[]).map((item) =>
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          value,
        ]),
      ),
    );
    const advancing = [...records]
      .sort((a, b) => Number(b['seq'] ?? b['toSeq'] ?? 0) - Number(a['seq'] ?? a['toSeq'] ?? 0))
      .find((item) =>
        ['event', 'gap', 'tombstone', 'delivery_uncertain', 'withheld'].includes(
          item['kind'] as string,
        ),
      );
    return {
      v: 1,
      chainId: value['chain_id'],
      epoch: value['epoch'],
      orgId: value['org_id'],
      records,
      throughSeq: advancing?.['seq'] ?? advancing?.['toSeq'] ?? 0,
      throughHash: advancing?.['hash'] ?? '0'.repeat(64),
    } as unknown as AuditBatchV1;
  },
  respond(reply, input, options) {
    if (reply === 'partial')
      return response({ partial_success: { rejected_count: options.rejectedCount } });
    if (reply === 'rejected') return response({}, 400);
    if (reply === 'retry')
      return { ...response({}, options.status), retryAfterMs: options.retryAfterMs ?? null };
    if (reply === 'bad_response')
      return {
        ...response(
          {},
          200,
          options.invalid === 'content_type' ? 'text/plain' : 'application/json',
        ),
        body: options.invalid === 'body' ? '{' : '{}',
      };
    return response({
      acked: {
        chain_id: input.chainId,
        epoch: input.epoch + (reply === 'wrong_epoch' ? 1 : 0),
        seq: input.throughSeq,
        hash: input.throughHash,
      },
    });
  },
  frontierResponse: (position) =>
    response({
      frontier: {
        chain_id: position.chainId,
        epoch: position.epoch,
        seq: position.seq,
        hash: position.hash,
      },
    }),
};

describe('webhook audit sink', () => {
  it('passes every conformance fixture with receiver ACKs and a frontier', async () => {
    expect(await runAuditSinkConformance(conformance)).toEqual({
      passed: auditSinkConformanceFixtures.map(({ name }) => name),
      acknowledgement: 'receiver',
      partialOutcome: 'unsupported',
      frontier: 'passed',
    });
  });

  it('declares defaults and operator custody, destination and retry options', () => {
    expect(auditWebhook({ id: 'archive' }).auditSinks[0]).toMatchObject({
      id: 'archive',
      kind: 'webhook',
      activation: 'build',
      custody: 'delivery',
      sourceIp: 'include',
      skipAfter: 3,
      destination: {
        protocol: 'https-json',
        urlEnv: 'PB_AUDIT_WEBHOOK_URL',
        headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS',
      },
    });
    expect(
      auditWebhook({
        id: 'second',
        activation: 'env',
        durableAck: true,
        sourceIp: 'omit',
        skipAfter: 10,
        urlEnv: 'CUSTOM_URL',
        headersEnv: 'CUSTOM_HEADERS',
      }).auditSinks[0],
    ).toMatchObject({
      activation: 'env',
      custody: 'durable',
      sourceIp: 'omit',
      skipAfter: 10,
      destination: { protocol: 'https-json', urlEnv: 'CUSTOM_URL', headersEnv: 'CUSTOM_HEADERS' },
    });
  });

  it.each([
    [{ id: 'default' }],
    [{ id: 'custom', urlEnv: 'CUSTOM_URL' }],
    [{ id: 'custom', urlEnv: 'CUSTOM_URL', headersEnv: 'CUSTOM_HEADERS' }],
    [
      { id: 'first', urlEnv: 'FIRST_URL' },
      { id: 'second', urlEnv: 'SECOND_URL' },
    ],
  ])('registers the produced destination definitions for %j', (...options) => {
    const plugins = options.map(auditWebhook);
    const problems: string[] = [];
    const gates = plugins.map((plugin) => snapshotPluginGate(plugin, problems));
    const audit = collectAuditDefinitions(plugins, gates, problems);
    expect(problems).toEqual([]);
    expect(audit.sinks.map(({ definition }) => definition.destination)).toEqual(
      options.map((option: AuditWebhookOptions) => ({
        protocol: 'https-json',
        urlEnv: option.urlEnv ?? 'PB_AUDIT_WEBHOOK_URL',
        ...('headersEnv' in option
          ? { headersEnv: option.headersEnv }
          : option.urlEnv === undefined
            ? { headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS' }
            : {}),
      })),
    );
  });

  it.each([null, undefined, false, 1, 'options', [], { id: 'ok', unknown: true }])(
    'rejects non-object or unknown options with invalid_option: %j',
    (options) => {
      expect(() => auditWebhook(options as Parameters<typeof auditWebhook>[0])).toThrowError(
        expect.objectContaining({ name: 'AuditSinkConfigError', code: 'invalid_option' }),
      );
    },
  );

  it.each([
    { id: 'bad id' },
    { id: 'bad\n' },
    { id: 'ok', headersEnv: 'HEADER\n' },
    { id: 'ok', skipAfter: 0 },
    { id: 'ok', skipAfter: 11 },
    { id: 'ok', skipAfter: 1.5 },
    { id: 'ok', urlEnv: 'bad-name' },
    { id: 'ok', headersEnv: '' },
  ])('rejects invalid options with a fixed error', (options) => {
    expect(() => auditWebhook(options)).toThrow('Invalid audit sink configuration');
  });

  it('sends the deployment identity, exact payload bytes and the caller signal', async () => {
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({ acked: ack }));
    const abort = signal();
    expect((await sink(fetch).deliver(batch, abort)).outcome).toBe('accepted');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toEqual({
      body: JSON.stringify({
        v: 1,
        chain_id: batch.chainId,
        epoch: batch.epoch,
        org_id: batch.orgId,
        deployment_id: 'deployment-test',
        records: [auditCanonicalVectors[0]!.wire],
      }),
      contentType: 'application/json',
      signal: abort,
    });
  });

  it.each([400, 422, 413, 408, 429, 500, 599, 201, 204, 301, 401, 403, 404, 409, 418])(
    'classifies HTTP %s without its own retry',
    async (status) => {
      const fetch = vi
        .fn<AuditBoundFetch>()
        .mockResolvedValue({ ...response({ acked: ack }, status), retryAfterMs: 1_000_000 });
      const result = await sink(fetch).deliver(batch, signal());
      expect(result).toEqual(
        [400, 422].includes(status)
          ? { outcome: 'rejected', code: 'http_status' }
          : status === 413
            ? { outcome: 'rejected', code: 'too_large' }
            : { outcome: 'retry', code: 'http_status', retryAfterMs: 1_000_000 },
      );
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {},
    null,
    [],
    { acked: null },
    { acked: { ...ack, hash: ack.hash + '\n' } },
    { acked: { ...ack, epoch: ack.epoch + 1 } },
    { acked: { ...ack, chain_id: 'other' } },
    { acked: { ...ack, seq: ack.seq + 1 } },
    { acked: { ...ack, hash: 'f'.repeat(64) } },
    { acked: { ...ack, seq: String(ack.seq) } },
    { partial_success: { rejected_count: 1 } },
  ])('retries malformed, mismatched or partial acknowledgements', async (body) => {
    expect(await sink(async () => response(body)).deliver(batch, signal())).toEqual({
      outcome: 'retry',
      code: 'bad_response',
    });
  });

  it('accepts an epoch-zero ACK for a fresh chain', async () => {
    const fresh = { ...batch, epoch: 0, records: [{ ...record, epoch: 0 }] };
    expect(
      await sink(async () => response({ acked: { ...ack, epoch: 0 } })).deliver(fresh, signal()),
    ).toEqual({
      outcome: 'accepted',
      chainId: fresh.chainId,
      epoch: 0,
      throughSeq: fresh.throughSeq,
      throughHash: fresh.throughHash,
    });
  });

  it.each([-1, 0.5, '0', null, false, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid ACK epoch %j even when it matches the batch',
    async (epoch) => {
      expect(
        await sink(async () => response({ acked: { ...ack, epoch } })).deliver(
          { ...batch, epoch: epoch as number },
          signal(),
        ),
      ).toEqual({ outcome: 'retry', code: 'bad_response' });
    },
  );

  it('accepts JSON media type parameters and additive response fields', async () => {
    expect(
      (
        await sink(async () =>
          response({ acked: { ...ack, future: true } }, 200, 'Application/JSON; charset=utf-8'),
        ).deliver(batch, signal())
      ).outcome,
    ).toBe('accepted');
  });

  it('propagates transport failure for core classification without replay', async () => {
    const failure = new Error('transport failed');
    const fetch = vi.fn<AuditBoundFetch>().mockRejectedValue(failure);
    await expect(sink(fetch).deliver(batch, signal())).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sends the current core identity on each probe through the same sink', async () => {
    const fetch = vi.fn<AuditBoundFetch>().mockResolvedValue(response({ frontier: null }));
    const receiver = sink(fetch);
    const state: AuditForkSnapshot = {
      chainId: 'c'.repeat(32),
      epoch: 2,
      incarnation: 1,
      modeGeneration: 1,
      policy: 'availability',
      boundarySeq: 1,
      boundaryPrevHash: '0'.repeat(64),
      boundaryReason: null,
      restorePending: false,
      headSeq: 0,
      headHash: '0'.repeat(64),
      sinks: [
        {
          id: 'archive',
          pluginId: 'audit-webhook-archive',
          receiverFingerprint: 'a'.repeat(64),
          generation: 1,
          kind: 'webhook',
          state: 'active',
          durableAck: false,
          activationSource: 'ARCHIVE_URL',
          progressSeq: 0,
          progressHash: '0'.repeat(64),
          custodySeq: 0,
          blockedReason: null,
          inflightBody: null,
          inflightRepr: null,
          inflightFrom: null,
          inflightTo: null,
          attempt: 0,
          retryCountForSeq: 0,
          bodyVersion: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
        },
      ],
    };
    const read = vi.fn().mockResolvedValue(state);
    const save = vi.fn();
    const identities = [
      { chainId: state.chainId, epoch: state.epoch, orgId: 'organization-one' },
      { chainId: 'd'.repeat(32), epoch: 3, orgId: 'organization-two' },
    ];
    for (const identity of identities) {
      read.mockResolvedValue({ ...state, chainId: identity.chainId, epoch: identity.epoch });
      expect(
        await detectAuditFork({ read, save, hashAt: vi.fn() }, orgContext(identity.orgId), {
          generation: 1,
          now: new Date(0),
          signal: signal(),
          probes: [{ id: 'archive', sink: receiver }],
          alert: vi.fn(),
        }),
      ).toBe('clear');
      expect(JSON.parse(fetch.mock.calls.at(-1)![0].body)).toEqual({
        v: 1,
        probe: 'frontier',
        chain_id: identity.chainId,
        org_id: identity.orgId,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });

  it('returns an empty receiver frontier', async () => {
    expect(
      await sink(async () => response({ frontier: null })).frontier!(batch, signal()),
    ).toBeNull();
  });

  it('returns an epoch-zero receiver frontier', async () => {
    expect(
      await sink(async () => response({ frontier: { ...ack, epoch: 0 } })).frontier!(
        { ...batch, epoch: 0 },
        signal(),
      ),
    ).toEqual({ chainId: ack.chain_id, epoch: 0, seq: ack.seq, hash: ack.hash });
  });

  it.each([
    {},
    { frontier: {} },
    ...[-1, 0.5, '0', null, false, Number.MAX_SAFE_INTEGER + 1].map((epoch) => ({
      frontier: { ...ack, epoch },
    })),
    { frontier: { ...ack, seq: -1 } },
    { frontier: { ...ack, hash: 'invalid' } },
    { frontier: { ...ack, seq: Number.MAX_SAFE_INTEGER + 1 } },
  ])(
    'rejects invalid frontier responses without treating them as an empty receiver',
    async (body) => {
      await expect(sink(async () => response(body)).frontier!(batch, signal())).rejects.toThrow(
        'Invalid audit frontier response',
      );
    },
  );
});
