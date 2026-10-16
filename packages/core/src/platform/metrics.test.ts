import { describe, expect, it } from 'vitest';
import {
  DROPPED_COUNTER,
  type ObsRecord,
  type Observability,
  createObservability,
} from './observability.js';
import { createMetricsRegistry } from './metrics.js';

interface Call {
  readonly kind: 'counter' | 'histogram';
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

function sink(): { sink: Pick<Observability, 'counter' | 'histogram'>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    sink: {
      counter: (name, labels, value = 1) =>
        void calls.push({ kind: 'counter', name, labels: labels ?? {}, value }),
      histogram: (name, value, labels) =>
        void calls.push({ kind: 'histogram', name, labels: labels ?? {}, value }),
    },
  };
}

const series = (calls: Call[]): Call[] => calls.filter((c) => c.name !== DROPPED_COUNTER);

describe('createMetricsRegistry', () => {
  it('forwards counter and histogram observations to the sink', () => {
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s, 1000, new Set(['/health']));
    registry.counter('pb.http.requests', { method: 'GET', status_class: '2xx' }).add();
    registry.counter('pb.http.requests', { method: 'GET', status_class: '2xx' }).add(3);
    registry.histogram('pb.http.duration_ms', { route: '/health' }).observe(12.5);
    expect(calls).toEqual([
      {
        kind: 'counter',
        name: 'pb.http.requests',
        labels: { method: 'GET', status_class: '2xx' },
        value: 1,
      },
      {
        kind: 'counter',
        name: 'pb.http.requests',
        labels: { method: 'GET', status_class: '2xx' },
        value: 3,
      },
      { kind: 'histogram', name: 'pb.http.duration_ms', labels: { route: '/health' }, value: 12.5 },
    ]);
    expect(registry.dropped()).toBe(0);
  });

  it('creates exactly 1000 series and counts the 1001st as dropped', () => {
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s);
    for (let i = 0; i < 1001; i += 1) {
      registry.counter('pb.http.requests', { kind: `k${String(i)}` }).add();
    }
    expect(series(calls)).toHaveLength(1000);
    expect(registry.dropped()).toBe(1);
    const dropped = calls.filter((c) => c.name === DROPPED_COUNTER);
    expect(dropped).toEqual([
      { kind: 'counter', name: DROPPED_COUNTER, labels: { signal: 'cardinality' }, value: 1 },
    ]);
  });

  it('keeps emitting for combinations that already exist after the cap is reached', () => {
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s, 2);
    registry.counter('pb.http.requests', { method: 'GET' }).add();
    registry.counter('pb.http.requests', { method: 'POST' }).add();
    registry.counter('pb.http.requests', { method: 'PUT' }).add();
    registry.counter('pb.http.requests', { method: 'GET' }).add();
    expect(series(calls)).toHaveLength(3);
    expect(registry.dropped()).toBe(1);
  });

  it('treats label order as the same combination and shares the cap across kinds', () => {
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s, 2);
    registry.counter('pb.http.requests', { method: 'GET', runtime: 'node' }).add();
    registry.counter('pb.http.requests', { runtime: 'node', method: 'GET' }).add();
    registry.histogram('pb.http.duration_ms').observe(1);
    registry.histogram('pb.upstream.duration_ms').observe(1);
    expect(series(calls)).toHaveLength(3);
    expect(registry.dropped()).toBe(1);
    expect(calls.at(-1)?.labels).toEqual({ signal: 'cardinality' });
  });

  it('throws on an unknown label key, including token and project ids', () => {
    const registry = createMetricsRegistry(sink().sink);
    expect(() =>
      // @ts-expect-error token_id is not an allowed label key
      registry.counter('pb.http.requests', { token_id: 'abc' }),
    ).toThrow(RangeError);
    expect(() =>
      // @ts-expect-error project_id is not an allowed label key
      registry.histogram('pb.http.duration_ms', { project_id: 'abc' }),
    ).toThrow(RangeError);
  });

  it('throws on an unregistered metric name', () => {
    const registry = createMetricsRegistry(sink().sink);
    expect(() => registry.counter('pb.made.up')).toThrow(RangeError);
    expect(() => registry.histogram('pb.http.requests/../x')).toThrow(RangeError);
  });

  it('throws on non-string, empty or unbounded label values', () => {
    const registry = createMetricsRegistry(sink().sink);
    // @ts-expect-error value must be a string
    expect(() => registry.counter('pb.http.requests', { method: 5 })).toThrow(RangeError);
    expect(() => registry.counter('pb.http.requests', { method: '' })).toThrow(RangeError);
    expect(() => registry.counter('pb.http.requests', { route: `/${'a'.repeat(300)}` })).toThrow(
      RangeError,
    );
    expect(() => registry.counter('pb.http.requests', { route: '/a?token=secret' })).toThrow(
      RangeError,
    );
  });

  it('rejects an invalid combination cap and negative counter values', () => {
    expect(() => createMetricsRegistry(sink().sink, 0)).toThrow(RangeError);
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s);
    registry.counter('pb.http.requests').add(-1);
    registry.histogram('pb.http.duration_ms').observe(Number.NaN);
    expect(series(calls)).toHaveLength(0);
  });
});

describe('createMetricsRegistry labels', () => {
  it('does not let a caller mutate labels after creation', () => {
    const { sink: s, calls } = sink();
    const registry = createMetricsRegistry(s);
    const labels = { method: 'GET' } as { method: string; token_id?: string };
    const counter = registry.counter('pb.http.requests', labels);
    labels.method = 'POST';
    labels.token_id = 'abc';
    counter.add();
    expect(calls[0]?.labels).toEqual({ method: 'GET' });
    expect(Object.isFrozen(calls[0]?.labels)).toBe(true);
  });
});

describe('label count', () => {
  it('throws above the port label limit instead of dropping downstream', () => {
    const registry = createMetricsRegistry(sink().sink, 1000, new Set(['/health']));
    expect(() =>
      registry.counter('pb.http.requests', {
        method: 'GET',
        route: '/health',
        status_class: '2xx',
        runtime: 'node',
        outcome: 'a',
        kind: 'b',
        signal: 'c',
        adapter: 'd',
        provider: 'e',
      }),
    ).toThrow(RangeError);
  });
});

describe('composition with the observability port', () => {
  it('delivers every registry-accepted series to the backend without downstream drops', () => {
    const records: ObsRecord[] = [];
    const templates = new Set(['/p/{id}']);
    const obs = createObservability(
      { emit: (r) => void records.push(r) },
      { deploymentId: 'dep-1', runtime: 'node', requestId: null },
      { events: new Set(), reasonCodes: new Set(), routeTemplates: templates },
    );
    const registry = createMetricsRegistry(obs, 1000, templates);
    registry
      .counter('pb.http.requests', {
        method: 'GET',
        route: '/p/{id}',
        status_class: '2xx',
        runtime: 'node',
        outcome: 'success',
        kind: 'npm_sync',
        adapter: 'cache-api',
      })
      .add(2);
    registry.histogram('pb.http.duration_ms', { route: '/p/{id}' }).observe(4);
    expect(records.map((r) => (r.kind === 'log' ? 'log' : r.name))).toEqual([
      'pb.http.requests',
      'pb.http.duration_ms',
    ]);
    expect(registry.dropped()).toBe(0);
  });

  it('delivers the cardinality overflow counter through the port', () => {
    const records: ObsRecord[] = [];
    const obs = createObservability(
      { emit: (r) => void records.push(r) },
      { deploymentId: 'dep-1', runtime: 'node', requestId: null },
      { events: new Set(), reasonCodes: new Set(), routeTemplates: new Set() },
    );
    const registry = createMetricsRegistry(obs, 1);
    registry.counter('pb.http.requests', { method: 'GET' }).add();
    registry.counter('pb.http.requests', { method: 'PUT' }).add();
    expect(records).toMatchObject([
      { name: 'pb.http.requests' },
      { name: 'pb.obs.dropped', labels: { signal: 'cardinality' }, value: 1 },
    ]);
  });
});

describe('pb.upstream.bytes', () => {
  it('is registered as a counter', () => {
    const { sink: s, calls } = sink();
    createMetricsRegistry(s).counter('pb.upstream.bytes', { provider: 'npm' }).add(42);
    expect(calls).toEqual([
      { kind: 'counter', name: 'pb.upstream.bytes', labels: { provider: 'npm' }, value: 42 },
    ]);
  });

  it('rejects an unregistered label key', () => {
    const registry = createMetricsRegistry(sink().sink);
    expect(() =>
      // @ts-expect-error package_name is not an allowed label key
      registry.counter('pb.upstream.bytes', { package_name: 'left-pad' }),
    ).toThrow(RangeError);
  });
});
