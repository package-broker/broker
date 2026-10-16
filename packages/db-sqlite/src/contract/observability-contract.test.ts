import { createObservability, forPlugin } from '@package-broker/core/platform/observability';
import type { ObsRecord, ObservabilityScope } from '@package-broker/core/platform/observability';
import { CONTRACT_REGISTRY, describeObservabilityContract } from './observability-contract.js';
import type { ObservabilityContractFixture } from './observability-contract.js';

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

function fixture(scoped: boolean): () => Promise<ObservabilityContractFixture> {
  return async () => {
    const records: ObsRecord[] = [];
    const sink = { emit: (record: ObsRecord) => void records.push(record) };
    const scope = scoped ? { ...SCOPE, plugin: 'contract-plugin' } : SCOPE;
    return {
      observability: scoped
        ? forPlugin(sink, SCOPE, 'contract-plugin', CONTRACT_REGISTRY)
        : createObservability(sink, SCOPE, CONTRACT_REGISTRY),
      scope,
      records: () => records,
    };
  };
}

describeObservabilityContract('core createObservability', fixture(false));
describeObservabilityContract('core forPlugin', fixture(true));
