import { DEFAULT_AUDIT_REJECTION_RETRIES } from '@package-broker/core';
import {
  AuditSinkConfigError,
  definePlugin,
  type AuditBoundFetch,
  type AuditPositionV1,
  type AuditSink,
  type AuditSinkContext,
} from '@package-broker/core/plugin';

export interface AuditWebhookOptions {
  readonly id: string;
  readonly activation?: 'build' | 'env';
  readonly urlEnv?: string;
  readonly headersEnv?: string;
  readonly durableAck?: boolean;
  readonly sourceIp?: 'include' | 'omit';
  readonly skipAfter?: number;
}

type Response = Awaited<ReturnType<AuditBoundFetch>>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function position(value: unknown): AuditPositionV1 | null {
  if (!object(value)) return null;
  const { chain_id: chainId, epoch, seq, hash } = value;
  if (
    typeof chainId !== 'string' ||
    chainId.length === 0 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof hash !== 'string' ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(hash)
  )
    return null;
  return { chainId, epoch, seq, hash };
}

function json(response: Response): Record<string, unknown> | null {
  if (
    response.status !== 200 ||
    response.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return null;
  try {
    const value: unknown = JSON.parse(response.body);
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

function wire(record: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
      value,
    ]),
  );
}

function createSink(ctx: AuditSinkContext): AuditSink {
  return {
    async deliver(batch, signal) {
      const response = await ctx.fetch({
        body: JSON.stringify({
          v: 1,
          chain_id: batch.chainId,
          epoch: batch.epoch,
          org_id: batch.orgId,
          deployment_id: ctx.deploymentId,
          records: batch.records.map(wire),
        }),
        contentType: 'application/json',
        signal,
      });
      if (response.status === 400 || response.status === 422)
        return { outcome: 'rejected', code: 'http_status' };
      if (response.status === 413) return { outcome: 'rejected', code: 'too_large' };
      if (response.status !== 200)
        return {
          outcome: 'retry',
          code: 'http_status',
          ...(response.retryAfterMs === null ? {} : { retryAfterMs: response.retryAfterMs }),
        };
      const ack = position(json(response)?.['acked']);
      if (
        ack === null ||
        ack.chainId !== batch.chainId ||
        ack.epoch !== batch.epoch ||
        ack.seq !== batch.throughSeq ||
        ack.hash !== batch.throughHash
      )
        return { outcome: 'retry', code: 'bad_response' };
      return {
        outcome: 'accepted',
        chainId: ack.chainId,
        epoch: ack.epoch,
        throughSeq: ack.seq,
        throughHash: ack.hash,
      };
    },
    async frontier(identity, signal) {
      const response = await ctx.fetch({
        body: JSON.stringify({
          v: 1,
          probe: 'frontier',
          chain_id: identity.chainId,
          org_id: identity.orgId,
        }),
        contentType: 'application/json',
        signal,
      });
      const body = json(response);
      if (body !== null && body['frontier'] === null) return null;
      const remote = position(body?.['frontier']);
      if (remote === null) throw new Error('Invalid audit frontier response');
      return remote;
    },
  };
}

export default function auditWebhook(options: AuditWebhookOptions) {
  if (
    !object(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'id',
          'activation',
          'urlEnv',
          'headersEnv',
          'durableAck',
          'sourceIp',
          'skipAfter',
        ].includes(key),
    ) ||
    typeof options.id !== 'string' ||
    !/^[a-z0-9-]{1,32}(?![\s\S])/.test(options.id) ||
    (options.activation !== undefined && !['build', 'env'].includes(options.activation)) ||
    (options.sourceIp !== undefined && !['include', 'omit'].includes(options.sourceIp)) ||
    (options.durableAck !== undefined && typeof options.durableAck !== 'boolean') ||
    (options.skipAfter !== undefined &&
      (!Number.isInteger(options.skipAfter) || options.skipAfter < 1 || options.skipAfter > 10)) ||
    [options.urlEnv, options.headersEnv].some(
      (name) =>
        name !== undefined &&
        (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(name)),
    )
  )
    throw new AuditSinkConfigError('invalid_option');
  return definePlugin({
    id: 'audit-webhook-' + options.id,
    package: '@package-broker/plugin-audit-webhook',
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    auditSinks: [
      {
        id: options.id,
        kind: 'webhook',
        destination: {
          protocol: 'https-json',
          urlEnv: options.urlEnv ?? 'PB_AUDIT_WEBHOOK_URL',
          ...(options.headersEnv !== undefined
            ? { headersEnv: options.headersEnv }
            : options.urlEnv === undefined
              ? { headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS' }
              : {}),
        },
        activation: options.activation ?? 'build',
        custody: options.durableAck === true ? 'durable' : 'delivery',
        sourceIp: options.sourceIp ?? 'include',
        skipAfter: options.skipAfter ?? DEFAULT_AUDIT_REJECTION_RETRIES,
        create: createSink,
      },
    ],
  });
}
