import { HISTOGRAM_BOUNDS } from './metrics.js';
import { DROPPED_COUNTER } from './observability.js';
import { EXPORT_FAILURES_COUNTER } from './otlp.js';
import type { DroppedSignal, ObsRecord, ObsRecordSink } from './observability.js';
import type {
  OtlpCounterInput,
  OtlpCounterSink,
  OtlpExporter,
  OtlpHistogramInput,
  OtlpLogInput,
} from './otlp.js';

export interface OtlpSinkOptions {
  readonly now?: () => Date;
}

export interface OtlpSink extends ObsRecordSink {
  flush(): Promise<void>;
  /** Counter path for the exporter's own drops and failures; never reaches the observability scope. */
  readonly internal: OtlpCounterSink;
  pendingInternal(): number;
}

type Labels = Readonly<Record<string, string>>;
type Kind = 'counter' | 'histogram';

interface CounterSeries {
  readonly name: string;
  readonly labels: Labels;
  value: number;
}

interface HistogramSeries {
  readonly name: string;
  readonly labels: Labels;
  readonly bounds: readonly number[];
  readonly bucketCounts: number[];
  count: number;
  sum: number;
}

const seriesKey = (name: string, labels: Labels): string =>
  JSON.stringify([
    name,
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  ]);

function bucketIndex(bounds: readonly number[], value: number): number {
  const index = bounds.findIndex((bound) => value <= bound);
  return index === -1 ? bounds.length : index;
}

function boundsFor(name: string): readonly number[] | undefined {
  return Object.hasOwn(HISTOGRAM_BOUNDS, name)
    ? (HISTOGRAM_BOUNDS as Readonly<Record<string, readonly number[]>>)[name]
    : undefined;
}

export function createOtlpSink(exporter: OtlpExporter, options: OtlpSinkOptions = {}): OtlpSink {
  const now = options.now ?? ((): Date => new Date());
  const kinds = new Map<string, Kind>();
  let counters = new Map<string, CounterSeries>();
  let histograms = new Map<string, HistogramSeries>();
  let internal = new Map<string, CounterSeries>();
  let unregistered = new Set<string>();
  let conflicts = 0;
  let metricsFailed = false;
  let windowStart = now().getTime();
  let queue: Promise<void> = Promise.resolve();

  const add = (
    target: Map<string, CounterSeries>,
    name: string,
    labels: Labels,
    value: number,
  ): void => {
    const key = seriesKey(name, labels);
    const existing = target.get(key);
    if (existing === undefined) target.set(key, { name, labels, value });
    else existing.value += value;
  };
  const bump = (name: string, labels: Labels, value: number): void =>
    add(internal, name, labels, value);

  const safeExport = (signal: 'logs' | 'metrics', body: unknown): void => {
    try {
      exporter.export(signal, body);
    } catch {
      bump(DROPPED_COUNTER, { signal: 'export' satisfies DroppedSignal }, 1);
      if (signal === 'metrics') {
        metricsFailed = true;
        bump(EXPORT_FAILURES_COUNTER, { signal }, 1);
      }
    }
  };

  const emit = (record: ObsRecord): void => {
    try {
      if (record.kind === 'log') {
        const log: OtlpLogInput = { ...record.record };
        safeExport('logs', log);
        return;
      }
      const owner = kinds.get(record.name);
      if (owner !== undefined && owner !== record.kind) {
        conflicts += 1;
        return;
      }
      if (record.kind === 'counter') {
        kinds.set(record.name, 'counter');
        add(counters, record.name, record.labels, record.value);
        return;
      }
      const bounds = boundsFor(record.name);
      if (bounds === undefined) {
        unregistered.add(record.name);
        return;
      }
      kinds.set(record.name, 'histogram');
      const key = seriesKey(record.name, record.labels);
      let series = histograms.get(key);
      if (series === undefined) {
        series = {
          name: record.name,
          labels: record.labels,
          bounds,
          bucketCounts: new Array<number>(bounds.length + 1).fill(0),
          count: 0,
          sum: 0,
        };
        histograms.set(key, series);
      }
      const slot = bucketIndex(bounds, record.value);
      series.bucketCounts[slot] = (series.bucketCounts[slot] ?? 0) + 1;
      series.count += 1;
      series.sum += record.value;
    } catch {
      bump(DROPPED_COUNTER, { signal: 'export' satisfies DroppedSignal }, 1);
    }
  };

  const run = async (): Promise<void> => {
    const flushTime = now().getTime();
    const start = windowStart;
    const end = Number.isFinite(flushTime) && flushTime > start ? flushTime : start + 1;
    windowStart = end;
    const startTime = new Date(start).toISOString();
    const time = new Date(end).toISOString();

    if (unregistered.size > 0) {
      bump(DROPPED_COUNTER, { signal: 'unregistered' satisfies DroppedSignal }, unregistered.size);
    }
    if (conflicts > 0) {
      bump(DROPPED_COUNTER, { signal: 'kind_conflict' satisfies DroppedSignal }, conflicts);
    }
    const inFlight = [...internal.values()];
    const takenCounters = [...counters.values(), ...inFlight];
    const takenHistograms = [...histograms.values()];
    counters = new Map();
    histograms = new Map();
    internal = new Map();
    unregistered = new Set();
    conflicts = 0;
    metricsFailed = false;

    for (const series of takenCounters) {
      const point: OtlpCounterInput = {
        kind: 'counter',
        name: series.name,
        value: series.value,
        labels: series.labels,
        startTime,
        time,
      };
      safeExport('metrics', point);
    }
    for (const series of takenHistograms) {
      const point: OtlpHistogramInput = {
        kind: 'histogram',
        name: series.name,
        bounds: series.bounds,
        bucketCounts: series.bucketCounts,
        count: series.count,
        sum: series.sum,
        labels: series.labels,
        startTime,
        time,
      };
      safeExport('metrics', point);
    }
    try {
      await exporter.flush();
    } catch {
      metricsFailed = true;
      bump(DROPPED_COUNTER, { signal: 'export' satisfies DroppedSignal }, 1);
      bump(EXPORT_FAILURES_COUNTER, { signal: 'metrics' }, 1);
    }
    if (metricsFailed) {
      for (const series of inFlight) add(internal, series.name, series.labels, series.value);
    }
  };

  const flush = (): Promise<void> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };

  try {
    // Anchors the exporter's metric window at sink creation so the first flush spans the whole interval.
    exporter.export('metrics', {
      kind: 'counter',
      name: DROPPED_COUNTER,
      value: 0,
      labels: { signal: 'export' satisfies DroppedSignal },
      startTime: new Date(windowStart).toISOString(),
      time: new Date(windowStart).toISOString(),
    } satisfies OtlpCounterInput);
  } catch {
    metricsFailed = false;
  }

  return Object.freeze({
    emit,
    flush,
    internal: Object.freeze({
      counter(name: string, labels: Record<string, string> = {}, value = 1): void {
        if (name === EXPORT_FAILURES_COUNTER && labels.signal === 'metrics') metricsFailed = true;
        bump(name, labels, value);
      },
    }),
    pendingInternal(): number {
      return internal.size;
    },
  });
}
