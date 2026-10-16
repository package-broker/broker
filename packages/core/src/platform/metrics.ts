import {
  DROPPED_COUNTER,
  MAX_METRIC_LABELS,
  type Observability,
  metricLabelValueAllowed,
} from './observability.js';

export const METRIC_LABEL_KEYS = [
  'method',
  'route',
  'status_class',
  'runtime',
  'outcome',
  'kind',
  'signal',
  'adapter',
  'provider',
] as const;

export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];

export type MetricLabels = { readonly [K in MetricLabelKey]?: string };

export const METRIC_NAMES = [
  'pb.http.requests',
  'pb.http.duration_ms',
  'pb.cache.operations',
  'pb.blob.bytes',
  'pb.blob.operations',
  'pb.jobs.executions',
  'pb.jobs.duration_ms',
  'pb.jobs.lease_lost',
  'pb.jobs.dead',
  'pb.jobs.queue_delay_ms',
  'pb.upstream.requests',
  'pb.upstream.duration_ms',
  'pb.obs.export_failures',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

type HistogramMetricName = Extract<MetricName, `${string}_ms`>;

const DURATION_BOUNDS_MS: readonly number[] = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
]);

export const HISTOGRAM_BOUNDS: Readonly<Record<HistogramMetricName, readonly number[]>> =
  Object.freeze({
    'pb.http.duration_ms': DURATION_BOUNDS_MS,
    'pb.jobs.duration_ms': DURATION_BOUNDS_MS,
    'pb.jobs.queue_delay_ms': DURATION_BOUNDS_MS,
    'pb.upstream.duration_ms': DURATION_BOUNDS_MS,
  });

export type MetricSink = Pick<Observability, 'counter' | 'histogram'>;

export interface Counter {
  add(value?: number): void;
}

export interface Histogram {
  observe(value: number): void;
}

export interface MetricsRegistry {
  counter(name: string, labels?: MetricLabels): Counter;
  histogram(name: string, labels?: MetricLabels): Histogram;
  dropped(): number;
}

export const DEFAULT_MAX_COMBINATIONS = 1000;

const NAMES = new Set<string>(METRIC_NAMES);
const KEYS = new Set<string>(METRIC_LABEL_KEYS);

const NOOP_COUNTER: Counter = Object.freeze({ add(): void {} });
const NOOP_HISTOGRAM: Histogram = Object.freeze({ observe(): void {} });

function validate(
  name: unknown,
  labels: unknown,
  routeTemplates: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (typeof name !== 'string' || !NAMES.has(name)) {
    throw new RangeError('Unregistered metric name');
  }
  if (labels === undefined) return {};
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    throw new RangeError('Invalid metric labels');
  }
  const keys = Reflect.ownKeys(labels);
  if (keys.length > MAX_METRIC_LABELS) throw new RangeError('Too many metric labels');
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !KEYS.has(key)) {
      throw new RangeError('Unknown metric label key');
    }
    const value: unknown = (labels as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !metricLabelValueAllowed(key, value, routeTemplates)) {
      throw new RangeError(`Invalid metric label value: ${key}`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function seriesKey(kind: string, name: string, labels: Readonly<Record<string, string>>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`);
  return JSON.stringify([kind, name, parts]);
}

export function createMetricsRegistry(
  sink: MetricSink,
  maxCombinations = DEFAULT_MAX_COMBINATIONS,
  routeTemplates: ReadonlySet<string> = new Set(),
): MetricsRegistry {
  if (!Number.isInteger(maxCombinations) || maxCombinations < 1) {
    throw new RangeError('maxCombinations must be a positive integer');
  }
  const templates = new Set(routeTemplates);
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  let droppedTotal = 0;

  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      return;
    }
  };

  const overflow = (): void => {
    droppedTotal += 1;
    safely(() => {
      sink.counter(DROPPED_COUNTER, { signal: 'cardinality' }, 1);
    });
  };

  const hasRoom = (): boolean => counters.size + histograms.size < maxCombinations;

  return Object.freeze({
    counter(name: string, labels?: MetricLabels): Counter {
      const safe = validate(name, labels, templates);
      const key = seriesKey('counter', name, safe);
      const existing = counters.get(key);
      if (existing !== undefined) return existing;
      if (!hasRoom()) {
        overflow();
        return NOOP_COUNTER;
      }
      const created: Counter = Object.freeze({
        add(value = 1): void {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
          safely(() => {
            sink.counter(name, safe, value);
          });
        },
      });
      counters.set(key, created);
      return created;
    },
    histogram(name: string, labels?: MetricLabels): Histogram {
      const safe = validate(name, labels, templates);
      const key = seriesKey('histogram', name, safe);
      const existing = histograms.get(key);
      if (existing !== undefined) return existing;
      if (!hasRoom()) {
        overflow();
        return NOOP_HISTOGRAM;
      }
      const created: Histogram = Object.freeze({
        observe(value: number): void {
          if (typeof value !== 'number' || !Number.isFinite(value)) return;
          safely(() => {
            sink.histogram(name, value, safe);
          });
        },
      });
      histograms.set(key, created);
      return created;
    },
    dropped(): number {
      return droppedTotal;
    },
  });
}
