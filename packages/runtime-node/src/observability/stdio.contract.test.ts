import { createObservability, forPlugin } from '@package-broker/core/platform/observability';
import type {
  ObsRecord,
  ObservabilityScope,
  SafeLogRecord,
} from '@package-broker/core/platform/observability';
import {
  CONTRACT_REGISTRY,
  describeObservabilityContract,
} from '@package-broker/db-sqlite/contract/observability-contract';
import type { ObservabilityContractFixture } from '@package-broker/db-sqlite/contract/observability-contract';
import { createStdioSink } from './stdio.js';

const SCOPE: ObservabilityScope = {
  deploymentId: 'dep-contract',
  runtime: 'node',
  requestId: '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11',
  projectId: 'proj_scoped',
  tokenId: 'tok_scoped',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  jobId: 'job_scoped',
  attempt: 2,
};

const UNSUPPORTED = { unsupported: ['7'] };

function parseLine(line: string): ObsRecord {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.kind === 'counter' || parsed.kind === 'histogram') {
    const { kind, name, labels, value } = parsed as {
      kind: 'counter' | 'histogram';
      name: string;
      labels: Record<string, string>;
      value: number;
    };
    return { kind, name, labels, value };
  }
  return { kind: 'log', record: parsed as unknown as SafeLogRecord };
}

function fixture(scoped: boolean): () => Promise<ObservabilityContractFixture> {
  return async () => {
    const lines: string[] = [];
    const stream = {
      write: (chunk: string) => void lines.push(chunk),
      on: () => undefined,
    };
    const sink = createStdioSink({
      deploymentId: SCOPE.deploymentId,
      stdout: stream,
      stderr: stream,
    });
    const scope = scoped ? { ...SCOPE, plugin: 'contract-plugin' } : SCOPE;
    return {
      observability: scoped
        ? forPlugin(sink, SCOPE, 'contract-plugin', CONTRACT_REGISTRY)
        : createObservability(sink, SCOPE, CONTRACT_REGISTRY),
      scope,
      records: () => lines.map((line) => parseLine(line.trimEnd())),
    };
  };
}

describeObservabilityContract('runtime-node stdio sink', fixture(false), UNSUPPORTED);
describeObservabilityContract('runtime-node stdio sink (forPlugin)', fixture(true), UNSUPPORTED);
