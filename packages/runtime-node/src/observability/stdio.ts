import {
  projectLogFields,
  type ObsRecord,
  type ObsRecordSink,
} from '@package-broker/core/platform/observability';

const DEPLOYMENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export interface StdioStream {
  write(chunk: string): unknown;
  on(event: 'error', listener: () => void): unknown;
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
        const line = `${JSON.stringify(projectLogFields(record.record))}\n`;
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
