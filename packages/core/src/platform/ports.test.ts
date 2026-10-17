import { describe, expect, expectTypeOf, it } from 'vitest';
import { PlatformUnavailableError, type PlatformPorts } from '@package-broker/core/plugin';
import { PlatformUnavailableError as PlatformError } from '@package-broker/core/platform/errors';
import type { MetricSink } from '@package-broker/core/platform/metrics';
import type { MetricLabels } from '@package-broker/core/platform/observability';
import type { BlobStore } from './blob.js';
import type { Cache } from './cache.js';
import type { Jobs } from './jobs.js';
import type { Observability } from './observability.js';
import { APPROVED_ERROR_NAMES } from './observability.js';

describe('platform ports surface', () => {
  it('preserves contextual metric callback types through package exports', () => {
    const options: { readonly metrics?: Pick<MetricSink, 'counter'> } = {
      metrics: {
        counter(name, labels) {
          expectTypeOf(name).toEqualTypeOf<string>();
          expectTypeOf(labels).toEqualTypeOf<MetricLabels | undefined>();
        },
      },
    };

    options.metrics?.counter('pb.cache.operations', { outcome: 'error', adapter: 'cache-api' });
  });

  it('pins the exact members and types of PlatformPorts', () => {
    expectTypeOf<keyof PlatformPorts>().toEqualTypeOf<
      'blob' | 'cache' | 'jobs' | 'observability'
    >();
    expectTypeOf<PlatformPorts>().toEqualTypeOf<{
      readonly blob: BlobStore;
      readonly cache: Cache;
      readonly jobs: Jobs;
      readonly observability: Observability;
    }>();
  });

  it('re-exports the same error class from the plugin API', () => {
    expect(PlatformUnavailableError).toBe(PlatformError);
    expect(new PlatformError()).toMatchObject({
      name: 'PlatformUnavailableError',
      message: 'Platform services are not enabled',
    });
    expect(APPROVED_ERROR_NAMES).toContain('PlatformUnavailableError');
  });
});
