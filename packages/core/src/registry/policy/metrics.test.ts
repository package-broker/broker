import { describe, expect, it, vi } from 'vitest';
import { COLLECTION_FILTERED_METRIC, createCollectionMetrics } from './metrics.js';

describe('collection filter metrics', () => {
  it('counts each hidden candidate once across preflight, tag lookup and body', () => {
    const metrics = createCollectionMetrics('npm');
    for (const phase of ['preflight', 'tags', 'body']) {
      void phase;
      metrics.hidden('K|S|V1|1', 'blocked');
      metrics.hidden('K|S|V2|1', 'min_age');
    }
    metrics.hidden('K|S|V1|2', 'blocked');
    expect([...metrics.counts()]).toEqual([
      ['blocked', 2],
      ['min_age', 1],
    ]);
  });

  it('emits one counter per reason and clears, without double counting later repeats', () => {
    const counter = vi.fn();
    const metrics = createCollectionMetrics('composer');
    metrics.hidden('a', 'quarantined');
    metrics.hidden('b', 'quarantined');
    metrics.flush({ counter });
    metrics.hidden('a', 'quarantined');
    metrics.flush({ counter });
    expect(counter.mock.calls).toEqual([
      [COLLECTION_FILTERED_METRIC, { kind: 'composer', outcome: 'quarantined' }, 2],
    ]);
  });

  it('a failing or absent telemetry sink never throws', () => {
    const metrics = createCollectionMetrics('npm');
    metrics.hidden('a', 'restricted');
    expect(() => metrics.flush(undefined)).not.toThrow();
    expect(() =>
      metrics.flush({
        counter: () => {
          throw new Error('exporter down');
        },
      }),
    ).not.toThrow();
  });
});
