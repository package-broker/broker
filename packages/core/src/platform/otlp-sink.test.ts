import { describe, expect, it } from 'vitest';
import { HISTOGRAM_BOUNDS } from './metrics.js';
import { createObservability, type ObsRecord } from './observability.js';
import { createOtlpExporter, type OtlpExporter } from './otlp.js';
import { createOtlpSink } from './otlp-sink.js';

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const BOUNDS = HISTOGRAM_BOUNDS['pb.http.duration_ms'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function clock(start = T0) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

function fakeExporter() {
  const exported: { signal: string; body: Json }[] = [];
  const exporter: OtlpExporter = {
    export(signal, body) {
      exported.push({ signal, body: body as Json });
    },
    flush: () => Promise.resolve(),
  };
  const metrics = () =>
    exported.filter((e) => e.signal === 'metrics' && e.body.value !== 0).map((e) => e.body);
  return { exporter, exported, metrics };
}

describe('createOtlpSink', () => {
  it('maps logs one to one', async () => {
    const { exporter, exported } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: clock().now });
    sink.emit({ kind: 'log', record: { level: 'info', event: 'http.request', status: 200 } });
    expect(exported.filter((e) => e.signal === 'logs')).toEqual([
      { signal: 'logs', body: { level: 'info', event: 'http.request', status: 200 } },
    ]);
  });

  it('sums three increments of one series into one point with a non-zero window', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    for (let i = 0; i < 3; i += 1) {
      sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: { method: 'GET' }, value: 1 });
    }
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: { method: 'POST' }, value: 1 });
    c.advance(10_000);
    await sink.flush();
    const points = metrics();
    expect(points).toHaveLength(2);
    const get = points.find((p) => p.labels.method === 'GET')!;
    expect(get).toMatchObject({ kind: 'counter', value: 3 });
    expect(Date.parse(get.time)).toBeGreaterThan(Date.parse(get.startTime));
    expect(get.startTime).toBe(new Date(T0).toISOString());
    expect(get.time).toBe(new Date(T0 + 10_000).toISOString());
  });

  it('uses the previous flush end as the next start and never emits a zero-width window', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    c.advance(5_000);
    await sink.flush();
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    await sink.flush();
    const [first, second] = metrics();
    expect(second!.startTime).toBe(first!.time);
    expect(Date.parse(second!.time)).toBeGreaterThan(Date.parse(second!.startTime));
  });

  it('buckets histogram observations with the registry bounds', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    const values = [1, 5, 6, 100, 99999];
    for (const value of values) {
      sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', value, labels: {} });
    }
    c.advance(1000);
    await sink.flush();
    const [point] = metrics();
    expect(point).toMatchObject({ kind: 'histogram', count: 5, sum: 1 + 5 + 6 + 100 + 99999 });
    expect(point!.bounds).toEqual([...BOUNDS]);
    expect(point!.bucketCounts).toHaveLength(BOUNDS.length + 1);
    expect(point!.bucketCounts.reduce((a: number, b: number) => a + b, 0)).toBe(5);
    expect(point!.bucketCounts[0]).toBe(2);
    expect(point!.bucketCounts[1]).toBe(1);
    expect(point!.bucketCounts[BOUNDS.indexOf(100)]).toBe(1);
    expect(point!.bucketCounts[BOUNDS.length]).toBe(1);
  });

  it('drops an unregistered histogram and counts it once per flush', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    for (let i = 0; i < 3; i += 1) {
      sink.emit({ kind: 'histogram', name: 'pb.nope', value: 1, labels: {} });
    }
    c.advance(1000);
    await sink.flush();
    const points = metrics();
    expect(points.some((p) => p.kind === 'histogram')).toBe(false);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      kind: 'counter',
      name: 'pb.obs.dropped',
      labels: { signal: 'unregistered' },
      value: 1,
    });
  });

  it('classifies a histogram against an existing counter as kind_conflict, counting every observation', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    for (let i = 0; i < 3; i += 1) {
      sink.emit({ kind: 'histogram', name: 'pb.http.requests', value: 1, labels: {} });
    }
    c.advance(1000);
    await sink.flush();
    const dropped = metrics().filter((p) => p.name === 'pb.obs.dropped');
    expect(dropped).toEqual([
      expect.objectContaining({ labels: { signal: 'kind_conflict' }, value: 3 }),
    ]);
  });

  it('treats inherited property names as unregistered histograms', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'histogram', name: 'constructor', value: 1, labels: {} });
    c.advance(1000);
    await sink.flush();
    expect(metrics().filter((p) => p.name === 'pb.obs.dropped')).toEqual([
      expect.objectContaining({ labels: { signal: 'unregistered' }, value: 1 }),
    ]);
  });

  it('keeps the first kind seen for a name and drops the other as kind_conflict', async () => {
    const c = clock();
    const { exporter, metrics } = fakeExporter();
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'counter', name: 'pb.http.duration_ms', labels: {}, value: 2 });
    sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', value: 5, labels: {} });
    c.advance(1000);
    await sink.flush();
    const points = metrics();
    expect(points.filter((p) => p.name === 'pb.http.duration_ms')).toEqual([
      expect.objectContaining({ kind: 'counter', value: 2 }),
    ]);
    expect(points).toContainEqual(
      expect.objectContaining({
        name: 'pb.obs.dropped',
        labels: { signal: 'kind_conflict' },
        value: 1,
      }),
    );
    sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', value: 5, labels: {} });
    c.advance(1000);
    await sink.flush();
    expect(metrics().filter((p) => p.kind === 'histogram')).toHaveLength(0);
  });

  it('keeps the sink window through the real exporter', async () => {
    const c = clock();
    const bodies: Json[] = [];
    const exporter = createOtlpExporter({
      endpoint: 'https://otlp.example.com',
      headers: {},
      now: c.now,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Json);
        return new Response('{}', { status: 200 });
      },
    });
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 3 });
    c.advance(10_000);
    await sink.flush();
    const metric = bodies[0]!.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m: Json) => m.name === 'pb.http.requests',
    );
    const point = metric.sum.dataPoints[0];
    expect(BigInt(point.startTimeUnixNano)).toBe(BigInt(T0) * 1_000_000n);
    expect(BigInt(point.timeUnixNano)).toBe(BigInt(T0 + 10_000) * 1_000_000n);
  });

  function failingSetup() {
    const c = clock();
    const sent: Json[] = [];
    let status = 500;
    const exporter = createOtlpExporter({
      endpoint: 'https://otlp.example.com',
      headers: {},
      now: c.now,
      fetchImpl: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as Json);
        return new Response('{}', { status });
      },
      metrics: {
        counter: (name, labels, value) => ref.sink!.internal.counter(name, labels, value),
      },
    });
    const ref: { sink?: ReturnType<typeof createOtlpSink> } = {};
    const sink = createOtlpSink(exporter, { now: c.now });
    ref.sink = sink;
    const scopeRecords: ObsRecord[] = [];
    const observed = createObservability(
      {
        emit(record) {
          scopeRecords.push(record);
          sink.emit(record);
        },
      },
      { deploymentId: 'dep-1', runtime: 'node', requestId: null },
      { events: new Set(['http.request']), reasonCodes: new Set(), routeTemplates: new Set() },
    );
    const exportedFailures = (): number[] =>
      sent.flatMap((body) =>
        (body.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics ?? [])
          .filter((m: Json) => m.name === 'pb.obs.export_failures')
          .flatMap((m: Json) => m.sum.dataPoints.map((p: Json) => Number(p.asInt ?? p.asDouble))),
      );
    return {
      c,
      sink,
      observed,
      scopeRecords,
      sent,
      exportedFailures,
      heal: () => {
        status = 200;
      },
    };
  }

  it('retains export failure counts across failed flushes and never feeds the scope', async () => {
    const { c, sink, observed, scopeRecords, exportedFailures, heal } = failingSetup();
    observed.counter('pb.http.requests', { method: 'GET' }, 1);
    const before = scopeRecords.length;
    for (let i = 0; i < 3; i += 1) {
      c.advance(1000);
      await sink.flush();
    }
    expect(scopeRecords).toHaveLength(before);
    expect(sink.pendingInternal()).toBeGreaterThan(0);

    heal();
    c.advance(1000);
    await sink.flush();
    expect(scopeRecords).toHaveLength(before);
    expect(exportedFailures().at(-1)).toBe(3);
    expect(sink.pendingInternal()).toBe(0);
  });

  it('counts a rejecting exporter repeatedly and reports the exact total after recovery', async () => {
    const c = clock();
    const exported: { name: string; value: number }[] = [];
    let reject = true;
    const exporter: OtlpExporter = {
      export(_signal, body) {
        const point = body as { name?: string; value?: number };
        if (point.name === 'pb.obs.export_failures') {
          exported.push({ name: point.name, value: point.value ?? 0 });
        }
      },
      flush: () => (reject ? Promise.reject(new Error('boom')) : Promise.resolve()),
    };
    const sink = createOtlpSink(exporter, { now: c.now });
    for (let i = 0; i < 4; i += 1) {
      c.advance(1000);
      await expect(sink.flush()).resolves.toBeUndefined();
    }
    reject = false;
    c.advance(1000);
    await sink.flush();
    expect(exported.at(-1)).toEqual({ name: 'pb.obs.export_failures', value: 4 });
    expect(sink.pendingInternal()).toBe(0);
  });

  it('counts an exporter that throws as an export drop without throwing', async () => {
    const c = clock();
    const exported: unknown[] = [];
    let fail = true;
    const exporter: OtlpExporter = {
      export(signal, body) {
        if (fail) throw new Error('boom');
        exported.push({ signal, body });
      },
      flush: () => Promise.reject(new Error('boom')),
    };
    const sink = createOtlpSink(exporter, { now: c.now });
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    c.advance(1000);
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.pendingInternal()).toBeGreaterThan(0);
    fail = false;
  });
});
