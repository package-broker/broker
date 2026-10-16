export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled?: boolean;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TracedFetchOptions {
  readonly propagate?: boolean;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

function randomHex(bytes: number): string {
  for (;;) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    if (buffer.some((byte) => byte !== 0)) {
      return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
}

function validSpan(span: SpanContext): boolean {
  return (
    typeof span === 'object' &&
    span !== null &&
    typeof span.traceId === 'string' &&
    typeof span.spanId === 'string' &&
    TRACE_ID.test(span.traceId) &&
    SPAN_ID.test(span.spanId) &&
    span.traceId !== ZERO_TRACE &&
    span.spanId !== ZERO_SPAN
  );
}

export function parseTraceparent(header: string | null): SpanContext | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT.exec(header);
  if (match === null) return null;
  const traceId = match[1];
  const spanId = match[2];
  if (traceId === undefined || spanId === undefined) return null;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  const flags = match[3];
  if (flags === undefined) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function childSpan(parent: SpanContext | null): SpanContext {
  if (parent === null) return { traceId: randomHex(16), spanId: randomHex(8), sampled: true };
  if (!validSpan(parent)) throw new RangeError('Invalid parent span context');
  return { traceId: parent.traceId, spanId: randomHex(8), sampled: parent.sampled !== false };
}

export function traceFromInbound(header: string | null, trustedProxy = false): SpanContext {
  return childSpan(trustedProxy ? parseTraceparent(header) : null);
}

const FOREIGN_TRACE_HEADERS = [
  'traceparent',
  'tracestate',
  'baggage',
  'b3',
  'uber-trace-id',
  'sentry-trace',
  'x-cloud-trace-context',
  'x-amzn-trace-id',
];

// Accepts a string, URL or native Request; any other Request-like object throws TypeError.
export function tracedFetch(
  fetchImpl: FetchLike,
  span: SpanContext,
  options: TracedFetchOptions = {},
): FetchLike {
  if (!validSpan(span)) throw new RangeError('Invalid span context');
  const parent: SpanContext = Object.freeze({ ...span });
  const propagate = options.propagate === true;

  return (input, init) => {
    const isRequest = input instanceof Request;
    if (typeof input === 'object' && !isRequest && !(input instanceof URL)) {
      throw new TypeError('tracedFetch requires a native Request');
    }
    const source = init?.headers ?? (isRequest ? input.headers : undefined);
    const headers = new Headers(source);
    for (const name of FOREIGN_TRACE_HEADERS) headers.delete(name);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('x-b3-')) headers.delete(name);
    }
    if (propagate) {
      const child = childSpan(parent);
      headers.set(
        'traceparent',
        `00-${child.traceId}-${child.spanId}-${child.sampled === false ? '00' : '01'}`,
      );
    }
    if (isRequest) return fetchImpl(new Request(input, { ...init, headers }));
    return fetchImpl(input, { ...init, headers });
  };
}
