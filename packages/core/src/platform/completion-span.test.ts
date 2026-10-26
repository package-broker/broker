import { describe, expect, it } from 'vitest';
import { completionSpan, upstreamSpan } from './completion-span.js';
import { encodeTraces } from './otlp.js';
import { safeRecord, type SafeLogRecord } from './observability.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const ROUTES: ReadonlySet<string> = new Set(['/health/live', '/p2/{org}/{pkg}.json']);
const REQUEST_ID = '3f2b8c1e-5a47-4d9e-9c1b-7e6d2a4f8b10';
const TIMESTAMP = '2026-10-17T10:00:00.500Z';

function record(overrides: Record<string, unknown> = {}): SafeLogRecord {
  return {
    level: 'info',
    event: 'http.request',
    timestamp: TIMESTAMP,
    request_id: REQUEST_ID,
    trace_id: TRACE,
    span_id: SPAN,
    route: '/health/live',
    method: 'GET',
    status: 200,
    duration_ms: 500,
    ...overrides,
  } as SafeLogRecord;
}

describe('completionSpan', () => {
  it('maps a 200 record to a server span', () => {
    const span = completionSpan(record({ reason_code: 'ok' }), ROUTES);
    expect(span).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      name: 'GET /health/live',
      kind: 'server',
      startTime: Date.parse(TIMESTAMP) - 500,
      endTime: TIMESTAMP,
      status: 'unset',
      attributes: {
        request_id: REQUEST_ID,
        route: '/health/live',
        method: 'GET',
        status: 200,
        duration_ms: 500,
        reason_code: 'ok',
      },
    });
  });

  it('names the span by method alone and omits route when none matched', () => {
    const span = completionSpan(record({ route: undefined }), ROUTES);
    expect(span?.name).toBe('GET');
    expect(span?.attributes).not.toHaveProperty('route');
  });

  it('marks 5xx as error and other statuses as unset', () => {
    expect(completionSpan(record({ status: 500 }), ROUTES)?.status).toBe('error');
    expect(completionSpan(record({ status: 503 }), ROUTES)?.status).toBe('error');
    expect(completionSpan(record({ status: 404 }), ROUTES)?.status).toBe('unset');
    expect(completionSpan(record({ status: 499 }), ROUTES)?.status).toBe('unset');
  });

  it('handles an aborted record without a status', () => {
    const span = completionSpan(
      record({ status: undefined, reason_code: 'request.aborted' }),
      ROUTES,
    );
    expect(span?.status).toBe('unset');
    expect(span?.attributes).not.toHaveProperty('status');
    expect(span?.attributes).toMatchObject({ reason_code: 'request.aborted' });
  });

  it('returns null for other events', () => {
    expect(completionSpan(record({ event: 'plugin.loaded' }), ROUTES)).toBeNull();
  });

  it('returns null when ids or timing are missing', () => {
    expect(completionSpan(record({ trace_id: undefined }), ROUTES)).toBeNull();
    expect(completionSpan(record({ span_id: undefined }), ROUTES)).toBeNull();
    expect(completionSpan(record({ timestamp: undefined }), ROUTES)).toBeNull();
    expect(completionSpan(record({ timestamp: 'not-a-date' }), ROUTES)).toBeNull();
    expect(completionSpan(record({ method: undefined }), ROUTES)).toBeNull();
  });

  it('treats a missing duration as zero and omits the attribute', () => {
    const span = completionSpan(record({ duration_ms: undefined }), ROUTES);
    expect(span?.startTime).toBe(Date.parse(TIMESTAMP));
    expect(span?.attributes).not.toHaveProperty('duration_ms');
  });

  it('is pure and does not mutate its input', () => {
    const input = Object.freeze(record());
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = completionSpan(input, ROUTES);
    const second = completionSpan(input, ROUTES);
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });

  it('keeps unrelated record fields out of the attributes', () => {
    const span = completionSpan(
      record({ project_id: 'p1', token_id: 't1', plugin: 'x', extra: 'secret', job_id: 'j' }),
      ROUTES,
    );
    expect(Object.keys(span?.attributes ?? {}).sort()).toEqual([
      'duration_ms',
      'method',
      'request_id',
      'route',
      'status',
    ]);
    expect(JSON.stringify(span)).not.toContain('secret');
  });

  it('keeps the fractional millisecond in startTime', () => {
    const span = completionSpan(record({ duration_ms: 12.75 }), ROUTES);
    expect(span?.startTime).toBe(Date.parse(TIMESTAMP) - 12.75);
  });

  it('drops a concrete path from the name and attributes', () => {
    const span = completionSpan(record({ route: '/p2/acme/private-pkg.json' }), ROUTES);
    expect(span?.name).toBe('GET');
    expect(span?.attributes).not.toHaveProperty('route');
    expect(JSON.stringify(span)).not.toContain('private-pkg');
  });

  it('omits request_id when it is null', () => {
    const span = completionSpan(record({ request_id: null }), ROUTES);
    expect(span?.attributes).not.toHaveProperty('request_id');
  });

  describe('through safeRecord and encodeTraces', () => {
    interface EncodedSpan {
      readonly kind: number;
      readonly status?: { readonly code: number };
      readonly attributes: readonly { readonly key: string }[];
    }
    interface Encoded {
      readonly resourceSpans: readonly {
        readonly scopeSpans: readonly { readonly spans: readonly EncodedSpan[] }[];
      }[];
    }
    const encode = (raw: Record<string, unknown>): EncodedSpan => {
      const safe = safeRecord(raw);
      const span = safe === null ? null : completionSpan(safe, ROUTES);
      const encoded = encodeTraces(
        [span],
        { service: 'package-broker' },
        undefined,
        ROUTES,
      ) as Encoded;
      return encoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    };
    const keysOf = (span: EncodedSpan): string[] => span.attributes.map((a) => a.key).sort();

    it('keeps all six attributes and maps a 500 to status code 2', () => {
      const span = encode({ ...record({ status: 500, reason_code: 'ok' }) });
      expect(keysOf(span)).toEqual([
        'duration_ms',
        'method',
        'reason_code',
        'request_id',
        'route',
        'status',
      ]);
      expect(span.status).toEqual({ code: 2 });
      expect(span.kind).toBe(2);
    });

    it('leaves status out for an aborted record', () => {
      const span = encode({ ...record({ status: undefined, reason_code: 'request.aborted' }) });
      expect(span).not.toHaveProperty('status');
      expect(keysOf(span)).not.toContain('status');
    });
  });
});

describe('upstreamSpan', () => {
  const upstream = (overrides: Record<string, unknown> = {}) =>
    safeRecord({
      ...record(),
      level: 'debug',
      event: 'upstream.fetch',
      upstream_span_id: 'c'.repeat(16),
      upstream_origin: 'https://upstream.test:8443',
      upstream_method: 'HEAD',
      redirects: 0,
      cross_origin: false,
      ...overrides,
    })!;

  it('requires a parent context, child id, method and valid timestamp', () => {
    for (const overrides of [
      { trace_id: undefined },
      { span_id: undefined },
      { trace_id: '0'.repeat(32) },
      { span_id: '0'.repeat(16) },
      { upstream_span_id: undefined },
      { upstream_span_id: SPAN },
      { upstream_span_id: '0'.repeat(16) },
      { upstream_method: undefined },
      { upstream_method: 'INVALID' },
      { timestamp: undefined },
      { timestamp: 'bad' },
      { event: 'http.request' },
    ])
      expect(upstreamSpan(upstream(overrides))).toBeNull();
  });

  it('caps duration at one day during field validation', () => {
    expect(upstream({ duration_ms: 86_400_000 }).duration_ms).toBe(86_400_000);
    const over = upstream({ duration_ms: 86_400_001 });
    expect(over).not.toHaveProperty('duration_ms');
    expect(upstreamSpan(over)?.attributes).not.toHaveProperty('duration_ms');
  });

  it.each([
    'https://user:secret@upstream.test',
    'https://upstream.test/private-segment',
    'https://upstream.test?secret=1',
    'https://upstream.test#secret',
    'file:///private-segment',
    'https://upstream.test/',
  ])('drops an unsafe origin at both sanitization boundaries: %s', (origin) => {
    const safe = upstream({ upstream_origin: origin });
    expect(safe).not.toHaveProperty('upstream_origin');
    const span = upstreamSpan(safe)!;
    expect(span.attributes).not.toHaveProperty('upstream.origin');
    const wire = JSON.stringify(
      encodeTraces([{ ...span, attributes: { 'upstream.origin': origin } }], {}),
    );
    expect(wire).not.toContain('upstream.origin');
    expect(wire).not.toMatch(/[?@]|private-segment|secret/);
  });

  it('prefers scoped parentage over explicit caller ids', () => {
    const scoped = upstream();
    const span = upstreamSpan(
      upstream({
        upstream_trace_id: 'd'.repeat(32),
        upstream_parent_span_id: 'e'.repeat(16),
      }),
    );
    expect(span).toMatchObject({ traceId: scoped.trace_id, parentSpanId: scoped.span_id });
    expect(
      upstreamSpan(
        upstream({
          span_id: undefined,
          upstream_parent_span_id: 'e'.repeat(16),
        }),
      ),
    ).toBeNull();
  });

  it('encodes explicit job parentage, safe origin, numeric and boolean attributes', () => {
    const span = upstreamSpan(
      upstream({
        trace_id: undefined,
        span_id: undefined,
        upstream_trace_id: 'd'.repeat(32),
        upstream_parent_span_id: 'e'.repeat(16),
      }),
    )!;
    expect(span).toMatchObject({
      traceId: 'd'.repeat(32),
      parentSpanId: 'e'.repeat(16),
      attributes: {
        'upstream.origin': 'https://upstream.test:8443',
        method: 'HEAD',
        redirects: 0,
        cross_origin: false,
      },
    });
    const encoded = encodeTraces([span], {}) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const wire = encoded.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(wire).toMatchObject({ traceId: 'd'.repeat(32), parentSpanId: 'e'.repeat(16), kind: 3 });
    expect(wire.attributes).toEqual(
      expect.arrayContaining([
        { key: 'upstream.origin', value: { stringValue: 'https://upstream.test:8443' } },
        { key: 'redirects', value: { intValue: '0' } },
        { key: 'cross_origin', value: { boolValue: false } },
      ]),
    );
  });
});
