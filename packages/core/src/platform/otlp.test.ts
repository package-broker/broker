import { describe, expect, it, vi } from 'vitest';
import { createOtlpExporter, encodeLogs, encodeMetrics, encodeTraces } from './otlp.js';
import { tracedFetch } from './tracing.js';

const RESOURCE = {
  service: 'package-broker',
  version: '2.0.0',
  deploymentId: 'dep-1',
  runtime: 'node',
};
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const FIXED = new Date('2026-10-16T10:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function okResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeCollector(respond: (path: string) => Response = () => okResponse()) {
  const calls: { url: string; init: RequestInit; body: Json }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Json });
    return respond(new URL(url).pathname);
  });
  return { calls, fetchImpl };
}

function counters() {
  const seen: { name: string; labels: Record<string, string>; value: number }[] = [];
  return {
    seen,
    metrics: {
      counter: (name: string, labels: Record<string, string> = {}, value = 1) =>
        void seen.push({ name, labels, value }),
    },
  };
}

const logRecord = (extra: Record<string, unknown> = {}) => ({
  level: 'info',
  event: 'http.request',
  timestamp: '2026-10-16T10:00:00.123Z',
  service: 'package-broker',
  deployment_id: 'dep-1',
  runtime: 'node',
  request_id: '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11',
  trace_id: TRACE,
  span_id: SPAN,
  status: 200,
  duration_ms: 12.5,
  ...extra,
});

const counterPoint = {
  kind: 'counter',
  name: 'pb.http.requests',
  value: 3,
  labels: { method: 'GET', status_class: '2xx' },
  startTime: '2026-10-16T09:59:50.000Z',
  time: '2026-10-16T10:00:00.000Z',
};
const histogramPoint = {
  kind: 'histogram',
  name: 'pb.http.duration_ms',
  bounds: [5, 10, 100],
  bucketCounts: [1, 2, 0, 1],
  count: 4,
  sum: 130.5,
  labels: { method: 'GET' },
  startTime: '2026-10-16T09:59:50.000Z',
  time: '2026-10-16T10:00:00.000Z',
};
const span = {
  traceId: TRACE,
  spanId: SPAN,
  name: '/p/{id}',
  kind: 'server',
  startTime: '2026-10-16T10:00:00.000Z',
  endTime: '2026-10-16T10:00:00.250Z',
  status: 'error',
  attributes: { method: 'GET', status: 500 },
};

const attr = (list: Json[], key: string): Json | undefined =>
  list.find((a) => a.key === key)?.value;

describe('encodeLogs', () => {
  const body = encodeLogs([logRecord()], RESOURCE) as Json;
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0] as Json;

  it('writes nanosecond decimal strings, severity and trace ids', () => {
    expect(record.timeUnixNano).toBe('1792144800123000000');
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe('INFO');
    expect(record.traceId).toBe(TRACE);
    expect(record.spanId).toBe(SPAN);
    expect(record.body).toEqual({ stringValue: 'http.request' });
  });

  it.each([
    ['debug', 5],
    ['info', 9],
    ['warn', 13],
    ['error', 17],
  ])('maps %s to severity %i', (level, number) => {
    const out = encodeLogs([logRecord({ level })], RESOURCE) as Json;
    expect(out.resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber).toBe(number);
  });

  it('carries resource service, version, deployment and runtime', () => {
    const resource = body.resourceLogs[0].resource.attributes as Json[];
    expect(attr(resource, 'service.name')).toEqual({ stringValue: 'package-broker' });
    expect(attr(resource, 'service.version')).toEqual({ stringValue: '2.0.0' });
    expect(attr(resource, 'deployment.id')).toEqual({ stringValue: 'dep-1' });
    expect(attr(resource, 'process.runtime.name')).toEqual({ stringValue: 'node' });
  });

  it('encodes typed attributes and never copies unknown fields', () => {
    const out = encodeLogs(
      [logRecord({ message: 'secret-text', stack: 'at x', arbitrary: { a: 1 } })],
      RESOURCE,
    ) as Json;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('secret-text');
    expect(serialized).not.toContain('at x');
    expect(serialized).not.toContain('arbitrary');
    const attrs = out.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as Json[];
    expect(attr(attrs, 'status')).toEqual({ intValue: '200' });
    expect(attr(attrs, 'duration_ms')).toEqual({ doubleValue: 12.5 });
  });

  it('skips malformed records and tolerates a non-array input', () => {
    const out = encodeLogs([null, 5, { level: 'nope', event: 'x' }, logRecord()], RESOURCE) as Json;
    expect(out.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
    expect(
      (encodeLogs('x', RESOURCE) as Json).resourceLogs[0].scopeLogs[0].logRecords,
    ).toHaveLength(0);
  });
});

describe('encodeMetrics', () => {
  const out = encodeMetrics([counterPoint, histogramPoint], RESOURCE) as Json;
  const metrics = out.resourceMetrics[0].scopeMetrics[0].metrics as Json[];

  it('encodes a delta monotonic sum', () => {
    const sum = metrics[0]!.sum as Json;
    expect(metrics[0]!.name).toBe('pb.http.requests');
    expect(sum.aggregationTemporality).toBe(1);
    expect(sum.isMonotonic).toBe(true);
    expect(sum.dataPoints[0]).toMatchObject({
      asInt: '3',
      startTimeUnixNano: '1792144790000000000',
      timeUnixNano: '1792144800000000000',
    });
    expect(attr(sum.dataPoints[0].attributes, 'method')).toEqual({ stringValue: 'GET' });
  });

  it('encodes an explicit-bucket delta histogram', () => {
    const histogram = metrics[1]!.histogram as Json;
    expect(metrics[1]!.unit).toBe('ms');
    expect(histogram.aggregationTemporality).toBe(1);
    expect(histogram.dataPoints[0]).toMatchObject({
      count: '4',
      sum: 130.5,
      bucketCounts: ['1', '2', '0', '1'],
      explicitBounds: [5, 10, 100],
    });
  });

  it('rejects histograms whose buckets do not match the bounds and unknown label keys', () => {
    const bad = { ...histogramPoint, bucketCounts: [1, 2] };
    const unknown = { ...counterPoint, labels: { user: 'a@b.c' } };
    const result = encodeMetrics([bad, unknown], RESOURCE) as Json;
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(0);
  });
});

describe('encodeTraces', () => {
  const out = encodeTraces([span], RESOURCE) as Json;
  const encoded = out.resourceSpans[0].scopeSpans[0].spans[0] as Json;

  it('encodes ids, kind, status and nanosecond times', () => {
    expect(encoded).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      name: '/p/{id}',
      kind: 2,
      startTimeUnixNano: '1792144800000000000',
      endTimeUnixNano: '1792144800250000000',
      status: { code: 2 },
    });
  });

  it('adds a parent id only when valid and rejects spans with invalid ids', () => {
    const withParent = encodeTraces(
      [{ ...span, parentSpanId: '1111111111111111' }],
      RESOURCE,
    ) as Json;
    expect(withParent.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBe(
      '1111111111111111',
    );
    const bad = encodeTraces(
      [
        { ...span, traceId: '0'.repeat(32) },
        { ...span, spanId: 'zz' },
      ],
      RESOURCE,
    ) as Json;
    expect(bad.resourceSpans[0].scopeSpans[0].spans).toHaveLength(0);
  });
});

describe('exporter endpoint rules', () => {
  const make = (endpoint: string, extra: Record<string, unknown> = {}) =>
    createOtlpExporter({ endpoint, headers: {}, fetchImpl: fakeCollector().fetchImpl, ...extra });

  it('accepts https and loopback http', () => {
    expect(() => make('https://collector.example.com')).not.toThrow();
    expect(() => make('http://127.0.0.1:4318')).not.toThrow();
    expect(() => make('http://localhost:4318')).not.toThrow();
    expect(() => make('http://[::1]:4318')).not.toThrow();
  });

  it('refuses non-loopback http without the opt-in', () => {
    expect(() => make('http://collector.internal:4318')).toThrow(RangeError);
  });

  it('allows private http with allowInsecurePrivate and warns once at startup', () => {
    const warn = vi.fn();
    make('http://collector.internal:4318', { allowInsecurePrivate: true, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://user:pass@collector.example.com',
    'https://collector.example.com/?token=abc',
    'https://collector.example.com/?',
    'https://collector.example.com/#frag',
    'ftp://collector.example.com',
    'not a url',
  ])('refuses %s without echoing it', (endpoint) => {
    let message = '';
    try {
      make(endpoint, { allowInsecurePrivate: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('pass');
    expect(message).not.toContain('token');
  });
});

describe('exporter flush', () => {
  const setup = (respond?: (path: string) => Response, extra: Record<string, unknown> = {}) => {
    const collector = fakeCollector(respond);
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com/base/',
      headers: { authorization: 'Bearer hush-hush' },
      fetchImpl: collector.fetchImpl,
      now: () => FIXED,
      resource: RESOURCE,
      metrics: sink.metrics,
      ...extra,
    });
    return { collector, sink, exporter };
  };

  it('posts all three signals to their paths and a fake collector decodes them', async () => {
    const { collector, exporter } = setup();
    exporter.export('logs', logRecord());
    exporter.export('metrics', counterPoint);
    exporter.export('metrics', histogramPoint);
    exporter.export('traces', span);
    await exporter.flush();
    const byPath = new Map(collector.calls.map((c) => [new URL(c.url).pathname, c]));
    expect([...byPath.keys()].sort()).toEqual([
      '/base/v1/logs',
      '/base/v1/metrics',
      '/base/v1/traces',
    ]);
    expect(byPath.get('/base/v1/logs')!.body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(
      1,
    );
    expect(
      byPath.get('/base/v1/metrics')!.body.resourceMetrics[0].scopeMetrics[0].metrics,
    ).toHaveLength(2);
    expect(byPath.get('/base/v1/traces')!.body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(
      1,
    );
    const first = collector.calls[0]!;
    expect(first.init.method).toBe('POST');
    expect(first.init.redirect).toBe('manual');
    const headers = new Headers(first.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer hush-hush');
    expect(headers.has('traceparent')).toBe(false);
  });

  it('sends nothing when idle', async () => {
    const { collector, exporter } = setup();
    await exporter.flush();
    expect(collector.calls).toHaveLength(0);
  });

  it('treats non-2xx as a failure without throwing and counts it per signal', async () => {
    const { sink, exporter } = setup(() => okResponse({}, 503));
    exporter.export('logs', logRecord());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(sink.seen).toContainEqual({
      name: 'pb.obs.export_failures',
      labels: { signal: 'logs' },
      value: 1,
    });
  });

  it('treats a redirect as a failure and never follows it', async () => {
    const { collector, sink, exporter } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    exporter.export('traces', span);
    await exporter.flush();
    expect(collector.calls).toHaveLength(1);
    expect(sink.seen.filter((s) => s.name === 'pb.obs.export_failures')).toHaveLength(1);
  });

  it('treats OTLP partial success with rejected items as a failure', async () => {
    const { sink, exporter } = setup((path) =>
      path.endsWith('/logs')
        ? okResponse({ partialSuccess: { rejectedLogRecords: '2', errorMessage: 'bad' } })
        : okResponse({ partialSuccess: {} }),
    );
    exporter.export('logs', logRecord());
    exporter.export('traces', span);
    await exporter.flush();
    const failures = sink.seen.filter((s) => s.name === 'pb.obs.export_failures');
    expect(failures).toEqual([
      { name: 'pb.obs.export_failures', labels: { signal: 'logs' }, value: 1 },
    ]);
  });

  it('treats a rejected fetch as a failure', async () => {
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: () => Promise.reject(new Error('boom hush-hush')),
      metrics: sink.metrics,
    });
    exporter.export('logs', logRecord());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(JSON.stringify(sink.seen)).not.toContain('hush-hush');
    expect(sink.seen).toContainEqual({
      name: 'pb.obs.export_failures',
      labels: { signal: 'logs' },
      value: 1,
    });
  });

  it('bounds response reading', async () => {
    const huge = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      }),
      { status: 200 },
    );
    const { sink, exporter } = setup(() => huge);
    exporter.export('logs', logRecord());
    await exporter.flush();
    expect(sink.seen.filter((s) => s.name === 'pb.obs.export_failures')).toHaveLength(1);
  });

  it('enforces the deadline when the collector hangs', async () => {
    vi.useFakeTimers();
    try {
      const sink = counters();
      const exporter = createOtlpExporter({
        endpoint: 'https://collector.example.com',
        headers: {},
        fetchImpl: () => new Promise<Response>(() => {}),
        metrics: sink.metrics,
        deadlineMs: 1500,
      });
      exporter.export('logs', logRecord());
      const done = exporter.flush();
      await vi.advanceTimersByTimeAsync(1499);
      expect(sink.seen).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(sink.seen).toContainEqual({
        name: 'pb.obs.export_failures',
        labels: { signal: 'logs' },
        value: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops records over the per-signal cap and counts them', async () => {
    const { collector, sink, exporter } = setup();
    for (let i = 0; i < 503; i += 1) exporter.export('logs', logRecord());
    await exporter.flush();
    expect(collector.calls[0]!.body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(500);
    expect(
      sink.seen.filter((s) => s.name === 'pb.obs.dropped' && s.labels.signal === 'log'),
    ).toHaveLength(3);
  });

  it('discards an oversized record and keeps the batch under the byte cap', async () => {
    const { collector, sink, exporter } = setup(undefined, { maxBytes: 2048 });
    exporter.export('logs', logRecord({ request_id: 'x'.repeat(5000) }));
    for (let i = 0; i < 40; i += 1) exporter.export('logs', logRecord());
    await exporter.flush();
    for (const call of collector.calls) {
      expect(new TextEncoder().encode(String(call.init.body)).length).toBeLessThanOrEqual(2048);
    }
    expect(sink.seen.filter((s) => s.name === 'pb.obs.dropped').length).toBeGreaterThan(0);
    const sent = collector.calls[0]!.body.resourceLogs[0].scopeLogs[0].logRecords as unknown[];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(40);
  });

  it('allows one in-flight plus one pending flush and coalesces further calls', async () => {
    let release: (r: Response) => void = () => {};
    let n = 0;
    const calls: Json[] = [];
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: (_i, init) => {
        calls.push(JSON.parse(String(init?.body)) as Json);
        n += 1;
        if (n === 1) return new Promise<Response>((resolve) => (release = resolve));
        return Promise.resolve(okResponse());
      },
    });
    exporter.export('logs', logRecord({ event: 'a' }));
    const first = exporter.flush();
    exporter.export('logs', logRecord({ event: 'b' }));
    const second = exporter.flush();
    exporter.export('logs', logRecord({ event: 'c' }));
    const third = exporter.flush();
    expect(third).toBe(second);
    let secondDone = false;
    void second.then(() => (secondDone = true));
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release(okResponse());
    await first;
    await second;
    expect(secondDone).toBe(true);
    expect(calls).toHaveLength(2);
    const bodies = (calls[1]!.resourceLogs[0].scopeLogs[0].logRecords as Json[]).map(
      (r) => r.body.stringValue,
    );
    expect(bodies).toEqual(['b', 'c']);
  });

  it('resolves a waitUntil-style promise only after the pending flush completes', async () => {
    let release: (r: Response) => void = () => {};
    let n = 0;
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: () => {
        n += 1;
        if (n === 1) return new Promise<Response>((resolve) => (release = resolve));
        return Promise.resolve(okResponse());
      },
    });
    exporter.export('logs', logRecord());
    void exporter.flush();
    exporter.export('logs', logRecord());
    let settled = false;
    const deferred = exporter.flush().then(() => (settled = true));
    await Promise.resolve();
    release(okResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(n).toBeLessThanOrEqual(2);
    await deferred;
    expect(settled).toBe(true);
    expect(n).toBe(2);
  });

  it('does not log or fail the caller when the metrics sink throws', async () => {
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: async () => okResponse({}, 500),
      metrics: {
        counter: () => {
          throw new Error('sink down');
        },
      },
    });
    exporter.export('logs', logRecord());
    await expect(exporter.flush()).resolves.toBeUndefined();
  });

  it('ignores records that fail encoding and unknown signals', async () => {
    const { collector, sink, exporter } = setup();
    exporter.export('logs', { level: 'bogus' });
    (exporter as { export(s: string, b: unknown): void }).export('profiles', {});
    await exporter.flush();
    expect(collector.calls).toHaveLength(0);
    expect(sink.seen.filter((s) => s.name === 'pb.obs.dropped')).toHaveLength(2);
  });
});

describe('outbound traceparent default', () => {
  it('does not propagate traceparent unless explicitly enabled', async () => {
    const seen: Headers[] = [];
    const fetchImpl = async (_i: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return okResponse();
    };
    await tracedFetch(fetchImpl, { traceId: TRACE, spanId: SPAN })('https://upstream.example.com/');
    expect(seen[0]!.has('traceparent')).toBe(false);
  });
});

describe('round 2: endpoint hardening', () => {
  const make = (endpoint: string, extra: Record<string, unknown> = {}) =>
    createOtlpExporter({ endpoint, headers: {}, fetchImpl: fakeCollector().fetchImpl, ...extra });

  it.each([
    'http://10.1.2.3:4318',
    'http://172.16.0.9',
    'http://172.31.255.1',
    'http://192.168.1.10',
    'http://169.254.10.10',
    'http://[fd12:3456::1]:4318',
    'http://[fe80::1]:4318',
    'http://collector.monitoring.svc:4318',
    'http://collector.monitoring.svc.cluster.local:4318',
    'http://otel.corp.internal',
    'http://otel.lan.local',
  ])('accepts %s with the opt-in', (endpoint) => {
    const warn = vi.fn();
    expect(() => make(endpoint, { allowInsecurePrivate: true, warn })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://collector.example.com',
    'http://notinternal.example.com',
    'http://0.0.0.0:4318',
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'http://[2001:db8::1]',
  ])('refuses %s even with the opt-in', (endpoint) => {
    expect(() => make(endpoint, { allowInsecurePrivate: true })).toThrow(RangeError);
  });

  it.each(['http://collector.internal', 'http://10.0.0.1'])(
    'refuses %s with the opt-in explicitly false',
    (endpoint) => {
      expect(() => make(endpoint, { allowInsecurePrivate: false })).toThrow(RangeError);
    },
  );

  it.each([
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'http://0.0.0.0:4318',
    'https://@collector.example.com',
    'https://:@collector.example.com',
  ])('refuses %s', (endpoint) => {
    expect(() => make(endpoint)).toThrow(RangeError);
  });
});

describe('round 2: configured headers', () => {
  const make = (headers: Record<string, string>) =>
    createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers,
      fetchImpl: fakeCollector().fetchImpl,
    });

  it.each([
    ['CRLF value', { 'x-a': 'a\r\nx-evil: 1' }],
    ['LF value', { 'x-a': 'a\nb' }],
    ['bad name', { 'bad name': 'v' }],
    ['empty name', { '': 'v' }],
    ['non-string value', { 'x-a': 5 as unknown as string }],
    ['traceparent', { Traceparent: '00-a-b-01' }],
    ['host', { Host: 'evil' }],
    ['content-length', { 'Content-Length': '1' }],
    ['transfer-encoding', { 'transfer-encoding': 'chunked' }],
    ['connection', { Connection: 'close' }],
    ['proxy-authorization', { 'Proxy-Authorization': 'x' }],
    ['case-insensitive duplicate', { 'X-Key': 'a', 'x-key': 'b' }],
  ])('rejects %s', (_label, headers) => {
    expect(() => make(headers)).toThrow(RangeError);
  });

  it('keeps an authorization header', async () => {
    const collector = fakeCollector();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: { Authorization: 'Bearer t' },
      fetchImpl: collector.fetchImpl,
    });
    exporter.export('logs', logRecord());
    await exporter.flush();
    expect(new Headers(collector.calls[0]!.init.headers).get('authorization')).toBe('Bearer t');
  });
});

describe('round 2: encoder negatives', () => {
  const metricsOf = (point: unknown, routes?: ReadonlySet<string>): unknown[] =>
    (encodeMetrics([point], RESOURCE, () => FIXED, routes) as Json).resourceMetrics[0]
      .scopeMetrics[0].metrics;

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number])(
    'rejects counter value %s',
    (value) => {
      expect(metricsOf({ ...counterPoint, value })).toHaveLength(0);
    },
  );

  it.each([
    ['bounds not increasing', { bounds: [5, 5, 100] }],
    ['bounds decreasing', { bounds: [10, 5, 100] }],
    ['non-finite bound', { bounds: [5, Number.NaN, 100] }],
    ['negative bucket count', { bucketCounts: [1, -1, 3, 1] }],
    ['fractional bucket count', { bucketCounts: [1, 1.5, 0.5, 1] }],
    ['bucket sum differs from count', { count: 5 }],
    ['negative count', { count: -4, bucketCounts: [0, 0, 0, 0] }],
    ['non-finite sum', { sum: Number.POSITIVE_INFINITY }],
  ])('rejects a histogram with %s', (_label, patch) => {
    expect(metricsOf({ ...histogramPoint, ...patch })).toHaveLength(0);
  });

  it('rejects more than 8 labels and values over 200 chars', () => {
    const nine = Object.fromEntries(
      [
        'method',
        'route',
        'status_class',
        'runtime',
        'outcome',
        'kind',
        'signal',
        'adapter',
        'provider',
      ].map((k) => [k, 'a']),
    );
    expect(metricsOf({ ...counterPoint, labels: nine })).toHaveLength(0);
    expect(metricsOf({ ...counterPoint, labels: { adapter: 'a'.repeat(201) } })).toHaveLength(0);
  });

  it('validates label values and route templates', () => {
    expect(metricsOf({ ...counterPoint, labels: { method: 'BREW' } })).toHaveLength(0);
    expect(metricsOf({ ...counterPoint, labels: { status_class: '9xx' } })).toHaveLength(0);
    expect(metricsOf({ ...counterPoint, labels: { route: '/p/{id}' } })).toHaveLength(0);
    expect(
      metricsOf({ ...counterPoint, labels: { route: '/p/{id}' } }, new Set(['/p/{id}'])),
    ).toHaveLength(1);
    expect(
      metricsOf({ ...counterPoint, labels: { route: '/p/42' } }, new Set(['/p/{id}'])),
    ).toHaveLength(0);
  });

  it('rejects a counter whose start is after its time', () => {
    expect(metricsOf({ ...counterPoint, startTime: '2026-10-16T10:00:01.000Z' })).toHaveLength(0);
  });

  const spansOf = (s: unknown): unknown[] =>
    (encodeTraces([s], RESOURCE, () => FIXED) as Json).resourceSpans[0].scopeSpans[0].spans;

  it('rejects a span ending before it starts or without a start', () => {
    expect(spansOf({ ...span, endTime: '2026-10-16T09:59:59.000Z' })).toHaveLength(0);
    const noStart: Record<string, unknown> = { ...span };
    delete noStart.startTime;
    expect(spansOf(noStart)).toHaveLength(0);
  });

  it('encodes producer and consumer kinds and ignores inherited kind names', () => {
    const kind = (k: unknown) => (spansOf({ ...span, kind: k })[0] as Json).kind;
    expect(kind('producer')).toBe(4);
    expect(kind('consumer')).toBe(5);
    expect(kind('constructor')).toBe(1);
  });

  it('rejects inherited level names on logs', () => {
    const out = encodeLogs([logRecord({ level: 'constructor' })], RESOURCE) as Json;
    expect(out.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(0);
  });

  it('omits all-zero trace and span ids on logs', () => {
    const out = encodeLogs(
      [logRecord({ trace_id: '0'.repeat(32), span_id: '0'.repeat(16) })],
      RESOURCE,
    ) as Json;
    const encoded = out.resourceLogs[0].scopeLogs[0].logRecords[0] as Json;
    expect(encoded).not.toHaveProperty('traceId');
    expect(encoded).not.toHaveProperty('spanId');
  });

  it('carries nanoseconds for numeric and Date timestamps', () => {
    const at = (timestamp: unknown) =>
      (
        (encodeLogs([logRecord({ timestamp })], RESOURCE) as Json).resourceLogs[0].scopeLogs[0]
          .logRecords as Json[]
      )[0]?.timeUnixNano;
    expect(at(1792144800123)).toBe('1792144800123000000');
    expect(at(1792144800123.75)).toBe('1792144800123750000');
    expect(at(1792144800123.5)).toBe('1792144800123500000');
    expect(at(new Date(1792144800123))).toBe('1792144800123000000');
  });

  it('refuses timestamps above 2^64-1 ns and negative or invalid ones', () => {
    const count = (timestamp: unknown) =>
      (
        (encodeLogs([logRecord({ timestamp })], RESOURCE) as Json).resourceLogs[0].scopeLogs[0]
          .logRecords as Json[]
      ).length;
    expect(count(18446744073709)).toBe(1);
    expect(count(18446744073710)).toBe(0);
    expect(count(-1)).toBe(0);
    expect(count(new Date(Number.NaN))).toBe(0);
    expect(count('yesterday')).toBe(0);
  });

  it.each([
    { service: 'bad name' },
    { version: 5 },
    { deploymentId: 'x'.repeat(65) },
    { runtime: 'a\nb' },
  ])('throws on invalid resource %o', (resource) => {
    expect(() => encodeLogs([logRecord()], resource)).toThrow(RangeError);
    expect(() =>
      createOtlpExporter({
        endpoint: 'https://c.example.com',
        headers: {},
        resource: resource as never,
      }),
    ).toThrow(RangeError);
  });
});

describe('round 2: exporter behaviour', () => {
  it.each([
    ['metrics', counterPoint],
    ['traces', span],
  ] as const)('treats %s partial success as a failure', async (signal, record) => {
    const collector = fakeCollector(() =>
      okResponse({ partialSuccess: { rejectedDataPoints: 1, rejectedSpans: 1 } }),
    );
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      metrics: sink.metrics,
    });
    exporter.export(signal, record);
    await exporter.flush();
    expect(sink.seen).toEqual([{ name: 'pb.obs.export_failures', labels: { signal }, value: 1 }]);
  });

  it('enforces the byte cap at enqueue and counts every record it drops', async () => {
    const collector = fakeCollector();
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      metrics: sink.metrics,
      maxBytes: 3000,
    });
    for (let i = 0; i < 31; i += 1) exporter.export('logs', logRecord({ event: `kept.${i}` }));
    await exporter.flush();
    const raw = String(collector.calls[0]!.init.body);
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(3000);
    expect(raw).toContain('kept.0');
    const sent = collector.calls[0]!.body.resourceLogs[0].scopeLogs[0].logRecords.length as number;
    const drops = sink.seen.filter((s) => s.name === 'pb.obs.dropped').length;
    expect(sent + drops).toBe(31);
    expect(drops).toBeGreaterThan(0);
  });

  it('frees the byte budget after a flush', async () => {
    const collector = fakeCollector();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      maxBytes: 1500,
    });
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 3; i += 1) exporter.export('logs', logRecord());
      await exporter.flush();
    }
    expect(
      collector.calls.map((c) => c.body.resourceLogs[0].scopeLogs[0].logRecords.length),
    ).toEqual([3, 3]);
  });

  it('uses the previous flush end as the next window start with one now() call per flush', async () => {
    let tick = 0;
    const clock = vi.fn(() => new Date(Date.UTC(2026, 9, 16, 10, 0, tick++)));
    const collector = fakeCollector();
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      now: clock,
      metrics: sink.metrics,
    });
    exporter.export('metrics', { ...counterPoint, startTime: undefined, time: undefined });
    exporter.export('metrics', { ...histogramPoint, startTime: undefined, time: undefined });
    const afterExport = clock.mock.calls.length;
    await exporter.flush();
    expect(clock.mock.calls.length - afterExport).toBe(1);
    expect(collector.calls[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(2);
    expect(sink.seen.filter((s) => s.name === 'pb.obs.dropped')).toHaveLength(0);
    exporter.export('metrics', counterPoint);
    await exporter.flush();
    const windows = collector.calls.map((c) => {
      const metrics = c.body.resourceMetrics[0].scopeMetrics[0].metrics as Json[];
      return metrics.map((m) => {
        const point = (m.sum ?? m.histogram).dataPoints[0] as Json;
        return [BigInt(point.startTimeUnixNano), BigInt(point.timeUnixNano)] as const;
      });
    });
    for (const window of windows.flat()) expect(window[0]).toBeLessThan(window[1]);
    expect(windows[1]![0]![0]).toBe(windows[0]![0]![1]);
  });

  it('starts the first window at the first metric export, not at construction', async () => {
    let tick = 0;
    const collector = fakeCollector();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      now: () => new Date(Date.UTC(2026, 9, 16, 10, 0, tick++)),
    });
    tick = 100;
    exporter.export('metrics', counterPoint);
    await exporter.flush();
    const point =
      collector.calls[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    expect(BigInt(point.startTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(Date.UTC(2026, 9, 16, 10, 1, 40)) * 1_000_000n,
    );
  });

  it('encodes timestamp-less points with a ticking clock', () => {
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 9, 16, 10, 0, tick++));
    const bare = { ...counterPoint, startTime: undefined, time: undefined };
    const out = encodeMetrics([bare, bare], RESOURCE, clock) as Json;
    expect(out.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(2);
  });

  it('merges same-series points between flushes', async () => {
    const collector = fakeCollector();
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      metrics: sink.metrics,
    });
    exporter.export('metrics', { ...counterPoint, value: 2 });
    exporter.export('metrics', { ...counterPoint, value: 3 });
    exporter.export('metrics', { ...counterPoint, labels: { method: 'POST' } });
    exporter.export('metrics', { ...histogramPoint });
    exporter.export('metrics', {
      ...histogramPoint,
      bucketCounts: [0, 0, 1, 0],
      count: 1,
      sum: 50,
    });
    exporter.export('metrics', {
      ...histogramPoint,
      bounds: [1, 2, 3],
      bucketCounts: [1, 0, 0, 0],
      count: 1,
      sum: 1,
    });
    await exporter.flush();
    const metrics = collector.calls[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics as Json[];
    const sums = metrics.filter((m) => m.sum);
    expect(sums).toHaveLength(2);
    const merged = sums.find((m) => m.sum.dataPoints[0].attributes.length === 2)!;
    expect(merged.sum.dataPoints[0].asInt).toBe('5');
    const histograms = metrics.filter((m) => m.histogram);
    expect(histograms).toHaveLength(1);
    expect(histograms[0]!.histogram.dataPoints[0]).toMatchObject({
      count: '5',
      sum: 180.5,
      bucketCounts: ['1', '2', '1', '1'],
    });
    expect(sink.seen.filter((s) => s.name === 'pb.obs.dropped')).toHaveLength(1);
  });

  it('never exceeds maxBytes after the window rewrite', async () => {
    for (let maxBytes = 500; maxBytes < 1400; maxBytes += 13) {
      const collector = fakeCollector();
      const exporter = createOtlpExporter({
        endpoint: 'https://collector.example.com',
        headers: {},
        fetchImpl: collector.fetchImpl,
        maxBytes,
        now: () => new Date(Date.UTC(2026, 9, 16, 10, 0, 0)),
      });
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        exporter.export('metrics', { ...counterPoint, labels: { method } });
      }
      await exporter.flush();
      for (const call of collector.calls) {
        expect(new TextEncoder().encode(String(call.init.body)).length).toBeLessThanOrEqual(
          maxBytes,
        );
      }
    }
  });

  it('keeps start before time when the clock does not move', async () => {
    const collector = fakeCollector();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: collector.fetchImpl,
      now: () => FIXED,
    });
    exporter.export('metrics', counterPoint);
    await exporter.flush();
    const point =
      collector.calls[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    expect(BigInt(point.startTimeUnixNano)).toBeLessThan(BigInt(point.timeUnixNano));
  });

  it('aborts the request signal when the deadline fires', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const exporter = createOtlpExporter({
        endpoint: 'https://collector.example.com',
        headers: {},
        fetchImpl: (_i, init) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        },
        deadlineMs: 200,
      });
      exporter.export('logs', logRecord());
      const done = exporter.flush();
      await vi.advanceTimersByTimeAsync(199);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the pending flush when the in-flight flush fails', async () => {
    let release: (r: Response) => void = () => {};
    const bodies: string[] = [];
    const sink = counters();
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      metrics: sink.metrics,
      fetchImpl: (_i, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) return new Promise<Response>((resolve) => (release = resolve));
        return Promise.resolve(okResponse());
      },
    });
    exporter.export('logs', logRecord({ event: 'first.one' }));
    const first = exporter.flush();
    exporter.export('logs', logRecord({ event: 'second.one' }));
    const second = exporter.flush();
    release(okResponse({}, 500));
    await first;
    await second;
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('second.one');
    expect(sink.seen.filter((s) => s.name === 'pb.obs.export_failures')).toHaveLength(1);
  });

  it('keeps the deferred promise unsettled after the in-flight flush completes while the pending fetch is held', async () => {
    const releases: ((r: Response) => void)[] = [];
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example.com',
      headers: {},
      fetchImpl: () => new Promise<Response>((resolve) => releases.push(resolve)),
    });
    exporter.export('logs', logRecord({ event: 'a.one' }));
    const inflight = exporter.flush();
    exporter.export('logs', logRecord({ event: 'b.one' }));
    let settled = false;
    const deferred = exporter.flush().then(() => (settled = true));
    releases[0]!(okResponse());
    await inflight;
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(releases).toHaveLength(2);
    expect(settled).toBe(false);
    releases[1]!(okResponse());
    await deferred;
    expect(settled).toBe(true);
  });
});

describe('round 3: encoder re-validates allowlisted values', () => {
  const SECRETX = 'SECRETX';
  const BEARER = 'Bearer abc.def.ghi';
  const RAW_ROUTE = '/raw?token=SECRETX';
  const logAttrs = (records: unknown[], routes?: ReadonlySet<string>): Json[] => {
    const out = encodeLogs(records, RESOURCE, () => FIXED, routes) as Json;
    return out.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as Json[];
  };
  const base = { level: 'info', event: 'http.request' };

  it('drops log fields whose values fail the port rules', () => {
    const attrs = logAttrs([
      {
        ...base,
        error_name: SECRETX,
        token_id: BEARER,
        project_id: 'has space',
        request_id: 'not-a-uuid',
        route: RAW_ROUTE,
        method: 'GET /x',
        plugin: 'Bad Plugin',
        reason_code: 'Has Space',
        job_id: BEARER,
        status: 99,
        attempt: -1,
      },
    ]);
    expect(attrs).toEqual([]);
  });

  it('keeps valid log fields and a registered route only', () => {
    const record = {
      ...base,
      error_name: 'TypeError',
      token_id: 'tok_1',
      request_id: '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11',
      route: '/p/{id}',
    };
    const without = logAttrs([record]);
    expect(attr(without, 'error_name')).toEqual({ stringValue: 'TypeError' });
    expect(attr(without, 'token_id')).toEqual({ stringValue: 'tok_1' });
    expect(attr(without, 'route')).toBeUndefined();
    expect(attr(logAttrs([record], new Set(['/p/{id}'])), 'route')).toEqual({
      stringValue: '/p/{id}',
    });
  });

  it('drops span attributes whose values fail the port rules', () => {
    const out = encodeTraces(
      [
        {
          ...span,
          attributes: {
            error_name: SECRETX,
            request_id: BEARER,
            route: RAW_ROUTE,
            provider: 'Bad Provider!',
            method: 'GET',
          },
        },
      ],
      RESOURCE,
    ) as Json;
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes as Json[];
    expect(attrs.map((a) => a.key)).toEqual(['method']);
  });
});
