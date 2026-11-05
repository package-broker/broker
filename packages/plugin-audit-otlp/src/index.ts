import {
  AuditSinkConfigError,
  definePlugin,
  type AuditSink,
  type AuditSinkContext,
} from '@package-broker/core/plugin';
import { encodeAuditBatch } from './encode.js';

export interface AuditOtlpOptions {
  readonly id: string;
  readonly activation?: 'build' | 'env';
  readonly endpointEnv?: string;
  readonly headersEnv?: string;
  readonly durableAck?: boolean;
  readonly sourceIp?: 'include' | 'omit';
  readonly maxBatchEvents?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSink(ctx: AuditSinkContext): AuditSink {
  if (typeof ctx.deploymentId !== 'string' || ctx.deploymentId.length === 0)
    throw new AuditSinkConfigError('invalid_option');
  const deploymentId = ctx.deploymentId;
  return {
    async deliver(batch, signal) {
      let requestBody: string;
      try {
        requestBody = encodeAuditBatch(batch, deploymentId);
      } catch (error) {
        if (error instanceof RangeError) return { outcome: 'rejected', code: 'too_large' };
        throw error;
      }
      const response = await ctx
        .fetch({ body: requestBody, contentType: 'application/json', signal })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.name === 'AuditTransportError' &&
            'code' in error &&
            error.code === 'too_large'
          )
            return null;
          throw error;
        });
      if (response === null) return { outcome: 'rejected', code: 'too_large' };
      if ([429, 502, 503, 504].includes(response.status))
        return {
          outcome: 'retry',
          code: 'http_status',
          ...(response.retryAfterMs === null ? {} : { retryAfterMs: response.retryAfterMs }),
        };
      if (response.status < 200 || response.status >= 300)
        return { outcome: 'rejected', code: response.status === 413 ? 'too_large' : 'http_status' };
      const bad = { outcome: 'retry', code: 'bad_response' } as const;
      if (response.status !== 200) return bad;
      if (response.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        return bad;
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        return bad;
      }
      if (!object(body)) return bad;
      const ack = {
        chainId: batch.chainId,
        epoch: batch.epoch,
        throughSeq: batch.throughSeq,
        throughHash: batch.throughHash,
      };
      const partial = body['partialSuccess'];
      if (partial === undefined) return { outcome: 'accepted', ...ack };
      if (!object(partial)) return bad;
      const raw = partial['rejectedLogRecords'] === undefined ? 0 : partial['rejectedLogRecords'];
      const count = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        return { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: NaN };
      if (count > 0)
        return { outcome: 'uncertain', code: 'partial_rejected', rejectedCount: count };
      const message = partial['errorMessage'];
      if (message !== undefined && typeof message !== 'string') return bad;
      return typeof message === 'string' && message.length > 0
        ? { outcome: 'accepted_with_warning', ...ack, code: 'partial_success' }
        : { outcome: 'accepted', ...ack };
    },
  };
}

export default function auditOtlp(options: AuditOtlpOptions) {
  if (
    !object(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'id',
          'activation',
          'endpointEnv',
          'headersEnv',
          'durableAck',
          'sourceIp',
          'maxBatchEvents',
        ].includes(key),
    ) ||
    typeof options.id !== 'string' ||
    !/^[a-z0-9-]{1,32}(?![\s\S])/.test(options.id) ||
    (options.activation !== undefined && !['build', 'env'].includes(options.activation)) ||
    (options.sourceIp !== undefined && !['include', 'omit'].includes(options.sourceIp)) ||
    (options.durableAck !== undefined && typeof options.durableAck !== 'boolean') ||
    (options.maxBatchEvents !== undefined &&
      (!Number.isInteger(options.maxBatchEvents) ||
        options.maxBatchEvents < 1 ||
        options.maxBatchEvents > 100)) ||
    [options.endpointEnv, options.headersEnv].some(
      (name) =>
        name !== undefined &&
        (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(name)),
    )
  )
    throw new AuditSinkConfigError('invalid_option');
  return definePlugin({
    id: 'audit-otlp-' + options.id,
    package: '@package-broker/plugin-audit-otlp',
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    auditSinks: [
      {
        id: options.id,
        kind: 'otlp',
        destination: {
          protocol: 'otlp-http-json',
          ...(options.endpointEnv === undefined ? {} : { endpointEnv: options.endpointEnv }),
          ...(options.headersEnv === undefined ? {} : { headersEnv: options.headersEnv }),
        },
        activation: options.activation ?? 'build',
        custody: options.durableAck === true ? 'durable' : 'delivery',
        sourceIp: options.sourceIp ?? 'include',
        maxBatchEvents: options.maxBatchEvents ?? 100,
        create: createSink,
      },
    ],
  });
}
