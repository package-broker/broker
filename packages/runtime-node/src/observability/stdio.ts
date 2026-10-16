import type { ObsRecord, ObsRecordSink } from '@package-broker/core/platform/observability';

const DEPLOYMENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

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

export interface StdioStream {
  write(chunk: string): unknown;
  on(event: 'error', listener: () => void): unknown;
}

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

function guarded(stream: StdioStream): (line: string) => void {
  let failed = false;
  stream.on('error', () => {
    failed = true;
  });
  return (line) => {
    if (failed) return;
    try {
      stream.write(line);
    } catch {
      failed = true;
    }
  };
}

export function createStdioSink(options: {
  deploymentId: string;
  stdout?: StdioStream;
  stderr?: StdioStream;
}): ObsRecordSink {
  const { deploymentId } = options;
  if (typeof deploymentId !== 'string' || !DEPLOYMENT_ID.test(deploymentId)) {
    throw new RangeError('Invalid deployment id');
  }
  const writeOut = guarded(options.stdout ?? process.stdout);
  const writeErr = guarded(options.stderr ?? process.stderr);
  return {
    emit(record: ObsRecord): void {
      if (record.kind === 'log') {
        const line = `${JSON.stringify(project(record.record))}\n`;
        const level = record.record.level;
        (level === 'warn' || level === 'error' ? writeErr : writeOut)(line);
        return;
      }
      const { kind, name, labels, value } = record;
      writeOut(
        `${JSON.stringify({
          kind,
          name,
          labels,
          value,
          timestamp: new Date().toISOString(),
          deployment_id: deploymentId,
          runtime: 'node',
        })}\n`,
      );
    },
  };
}
