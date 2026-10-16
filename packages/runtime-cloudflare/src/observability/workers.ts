import type { ObsRecord, ObsRecordSink } from '@package-broker/core/platform/observability';

export interface AnalyticsEngineLike {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

export const AE_BLOB_BUDGET_BYTES = 1024;

const LOG_FIELDS = [
  'level',
  'event',
  'timestamp',
  'service',
  'deployment_id',
  'runtime',
  'request_id',
  'trace_id',
  'span_id',
  'plugin',
  'route',
  'method',
  'status',
  'duration_ms',
  'project_id',
  'token_id',
  'job_id',
  'attempt',
  'error_name',
  'reason_code',
] as const;

const DEPLOYMENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ENCODER = new TextEncoder();

function project(record: object): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const out: Record<string, unknown> = {};
  for (const key of LOG_FIELDS) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== undefined) {
      out[key] = descriptor.value;
    }
  }
  return out;
}

export function createWorkersSink(options: {
  deploymentId: string;
  analytics?: AnalyticsEngineLike;
  console?: { log: (v: unknown) => void; error: (v: unknown) => void };
}): ObsRecordSink {
  const { deploymentId, analytics } = options;
  if (typeof deploymentId !== 'string' || !DEPLOYMENT_ID.test(deploymentId)) {
    throw new RangeError('Invalid deployment id');
  }
  const out = options.console ?? console;

  if (analytics === undefined) {
    out.log({
      level: 'info',
      event: 'obs.analytics_unconfigured',
      timestamp: new Date().toISOString(),
      request_id: null,
      service: 'package-broker',
      deployment_id: deploymentId,
      runtime: 'cloudflare',
    });
  }

  return {
    emit(record: ObsRecord): void {
      if (record.kind === 'log') {
        const level = record.record.level;
        const safe = project(record.record);
        if (level === 'warn' || level === 'error') out.error(safe);
        else out.log(safe);
        return;
      }
      const { kind, name, labels, value } = record;
      if (analytics === undefined) {
        out.log({
          kind,
          name,
          labels,
          value,
          timestamp: new Date().toISOString(),
          deployment_id: deploymentId,
          runtime: 'cloudflare',
        });
        return;
      }
      const tuple = Object.keys(labels)
        .sort()
        .map((key) => `${key}=${labels[key]}`)
        .join(',');
      const blobs = [name, 'cloudflare', kind, tuple];
      const bytes = blobs.reduce((sum, blob) => sum + ENCODER.encode(blob).length, 0);
      if (bytes > AE_BLOB_BUDGET_BYTES) {
        out.error({ event: 'pb.obs.export_failure', metric: name, reason: 'over_budget' });
        return;
      }
      /**
       * Analytics Engine layout, fixed:
       * indexes[0] = deployment_id
       * blobs[0] = metric name, blobs[1] = runtime, blobs[2] = kind (counter|histogram),
       * blobs[3] = label tuple as sorted `key=value` pairs joined by `,`
       * doubles[0] = value, doubles[1] = timestamp in epoch milliseconds
       */
      try {
        analytics.writeDataPoint({
          indexes: [deploymentId],
          blobs,
          doubles: [value, Date.now()],
        });
      } catch {
        out.error({ event: 'pb.obs.export_failure', metric: name, reason: 'write_failed' });
      }
    },
  };
}
