import { describe, expect, it } from 'vitest';
import { childSpan, parseTraceparent, traceFromInbound, tracedFetch } from './tracing.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const VALID = `00-${TRACE}-${SPAN}-01`;

describe('parseTraceparent', () => {
  it('round-trips trace and span id of a valid header', () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['short', `00-${TRACE}-${SPAN}`],
    ['short trace', `00-${TRACE.slice(1)}-${SPAN}-01`],
    ['over-long', `${VALID}-extra`],
    ['over-long span', `00-${TRACE}-${SPAN}0-01`],
    ['trailing whitespace', `${VALID} `],
    ['uppercase hex', VALID.toUpperCase()],
    ['non-hex', `00-${'g'.repeat(32)}-${SPAN}-01`],
    ['version ff', `ff-${TRACE}-${SPAN}-01`],
    ['version 01', `01-${TRACE}-${SPAN}-01`],
    ['all-zero trace', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['all-zero span', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['bad flags', `00-${TRACE}-${SPAN}-zz`],
  ])('rejects %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe('childSpan', () => {
  it('keeps the parent trace and creates a new span id', () => {
    const parent = { traceId: TRACE, spanId: SPAN };
    const child = childSpan(parent);
    expect(child.traceId).toBe(TRACE);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(child.spanId).not.toBe(SPAN);
    expect(child.spanId).not.toBe('0'.repeat(16));
  });

  it('starts a new trace without a parent', () => {
    const a = childSpan(null);
    const b = childSpan(null);
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).not.toBe('0'.repeat(32));
    expect(a.traceId).not.toBe(b.traceId);
  });
});

describe('childSpan validation and sampling', () => {
  it('rejects an invalid or all-zero parent', () => {
    expect(() => childSpan({ traceId: '0'.repeat(32), spanId: SPAN })).toThrow(RangeError);
    expect(() => childSpan({ traceId: TRACE, spanId: '0'.repeat(16) })).toThrow(RangeError);
    expect(() => childSpan({ traceId: 'xyz', spanId: SPAN })).toThrow(RangeError);
  });

  it('carries the sampled flag from the parent', () => {
    const parsed = parseTraceparent(`00-${TRACE}-${SPAN}-00`);
    expect(parsed?.sampled).toBe(false);
    expect(childSpan(parsed).sampled).toBe(false);
  });
});

describe('traceFromInbound', () => {
  it('ignores the inbound header unless behind a trusted proxy', () => {
    expect(traceFromInbound(VALID).traceId).not.toBe(TRACE);
    expect(traceFromInbound(VALID, false).traceId).not.toBe(TRACE);
    expect(traceFromInbound(VALID, true).traceId).toBe(TRACE);
  });

  it('starts a new trace for an invalid header even behind a trusted proxy', () => {
    const span = traceFromInbound(`00-${'0'.repeat(32)}-${SPAN}-01`, true);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.traceId).not.toBe('0'.repeat(32));
  });
});

describe('tracedFetch', () => {
  const span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
  const OUTBOUND = new RegExp(`^00-${span.traceId}-(?!${span.spanId})[0-9a-f]{16}-01$`);

  function capture(): {
    calls: Request[];
    fetchImpl: (i: string | URL | Request, n?: RequestInit) => Promise<Response>;
  } {
    const calls: Request[] = [];
    return {
      calls,
      fetchImpl: (input, init) => {
        calls.push(new Request(input, init));
        return Promise.resolve(new Response('ok'));
      },
    };
  }

  it('does not propagate trace context to public upstreams by default and drops inbound values', async () => {
    const { calls, fetchImpl } = capture();
    await tracedFetch(fetchImpl, span)('https://example.test/x', {
      headers: { traceparent: VALID, tracestate: 'a=b', baggage: 'k=v', accept: 'text/plain' },
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.headers;
    expect(headers?.get('traceparent')).toBeNull();
    expect(headers?.get('tracestate')).toBeNull();
    expect(headers?.get('baggage')).toBeNull();
    expect(headers?.get('accept')).toBe('text/plain');
  });

  it('overwrites an inbound traceparent with the supplied context when propagation is enabled', async () => {
    const { calls, fetchImpl } = capture();
    const response = await tracedFetch(fetchImpl, span, { propagate: true })(
      'https://example.test/x',
      {
        method: 'POST',
        headers: { traceparent: VALID, tracestate: 'a=b', baggage: 'k=v', accept: 'text/plain' },
      },
    );
    expect(await response.text()).toBe('ok');
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.headers;
    expect(headers?.get('traceparent')).toMatch(OUTBOUND);
    expect(headers?.get('tracestate')).toBeNull();
    expect(headers?.get('baggage')).toBeNull();
    expect(headers?.get('accept')).toBe('text/plain');
    expect(calls[0]?.method).toBe('POST');
  });

  it('overwrites the traceparent carried by a Request input', async () => {
    const { calls, fetchImpl } = capture();
    const request = new Request('https://example.test/y', {
      headers: { traceparent: VALID, baggage: 'k=v' },
    });
    await tracedFetch(fetchImpl, span, { propagate: true })(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('traceparent')).toMatch(OUTBOUND);
    expect(calls[0]?.headers.get('baggage')).toBeNull();
    expect(calls[0]?.url).toBe('https://example.test/y');
  });

  it('strips all trace headers from a Request input with default options', async () => {
    const { calls, fetchImpl } = capture();
    const request = new Request('https://example.test/z', {
      headers: {
        traceparent: VALID,
        tracestate: 'a=b',
        baggage: 'k=v',
        b3: 'x',
        'x-b3-traceid': 'x',
        'uber-trace-id': 'x',
        'sentry-trace': 'x',
        'x-cloud-trace-context': 'x',
        'x-amzn-trace-id': 'x',
        accept: 'text/plain',
      },
    });
    await tracedFetch(fetchImpl, span)(request);
    expect(calls).toHaveLength(1);
    const names = [...(calls[0]?.headers.keys() ?? [])];
    expect(names).toEqual(['accept']);
  });

  it('creates a distinct child span per outbound request and carries the sampled flag', async () => {
    const { calls, fetchImpl } = capture();
    const fetchTraced = tracedFetch(fetchImpl, { ...span, sampled: false }, { propagate: true });
    await fetchTraced('https://example.test/a');
    await fetchTraced('https://example.test/b');
    const [a, b] = calls.map((c) => c.headers.get('traceparent') ?? '');
    expect(a).toMatch(/^00-a{32}-[0-9a-f]{16}-00$/);
    expect(b).toMatch(/^00-a{32}-[0-9a-f]{16}-00$/);
    expect(a).not.toBe(b);
  });

  it('throws TypeError for a Request-like object that is not a native Request', () => {
    const { calls, fetchImpl } = capture();
    const real = new Request('https://example.test/f');
    const foreign = {
      url: real.url,
      method: real.method,
      headers: real.headers,
    } as unknown as Request;
    expect(() => tracedFetch(fetchImpl, span)(foreign)).toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('accepts a URL input and lets init override a native Request', async () => {
    const { calls, fetchImpl } = capture();
    const fetchTraced = tracedFetch(fetchImpl, span);
    await fetchTraced(new URL('https://example.test/u'), {
      headers: { baggage: 'k=v', accept: 'a/b' },
    });
    const request = new Request('https://example.test/r', { method: 'POST', body: 'x' });
    await fetchTraced(request, { method: 'PUT' });
    expect(calls[0]?.headers.get('baggage')).toBeNull();
    expect(calls[0]?.headers.get('accept')).toBe('a/b');
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url).toBe('https://example.test/r');
  });

  it('rejects an invalid supplied span context without calling fetch', () => {
    const { calls, fetchImpl } = capture();
    expect(() =>
      tracedFetch(fetchImpl, { traceId: '0'.repeat(32), spanId: 'b'.repeat(16) }),
    ).toThrow(RangeError);
    expect(() => tracedFetch(fetchImpl, { traceId: 'a'.repeat(32), spanId: 'xyz' })).toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });
});
