import { METRIC_LABEL_KEYS } from './metrics.js';
import { APPROVED_ERROR_NAMES, DROPPED_COUNTER, metricLabelValueAllowed } from './observability.js';
import type { FetchLike } from './tracing.js';

export type OtlpSignal = 'logs' | 'metrics' | 'traces';

export interface OtlpResource {
  readonly service?: string;
  readonly version?: string;
  readonly deploymentId?: string;
  readonly runtime?: string;
}

export interface OtlpCounterSink {
  counter(name: string, labels?: Record<string, string>, value?: number): void;
}

/** A sanitized log record (SafeLogRecord from observability.ts) as accepted by the encoder. */
export interface OtlpLogInput {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly timestamp?: string | Date | number;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly [field: string]: unknown;
}

/** A delta counter data point; the exporter rewrites its time window at flush. */
export interface OtlpCounterInput {
  readonly kind: 'counter';
  readonly name: string;
  readonly value: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly startTime?: string | Date | number;
  readonly time?: string | Date | number;
}

/** An aggregated explicit-bucket delta histogram; bucketCounts has bounds.length + 1 entries summing to count. */
export interface OtlpHistogramInput {
  readonly kind: 'histogram';
  readonly name: string;
  readonly bounds: readonly number[];
  readonly bucketCounts: readonly number[];
  readonly count: number;
  readonly sum: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly startTime?: string | Date | number;
  readonly time?: string | Date | number;
}

export type OtlpMetricInput = OtlpCounterInput | OtlpHistogramInput;

export type OtlpSpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/** A finished span; endTime must not precede startTime. */
export interface OtlpSpanInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind?: OtlpSpanKind;
  readonly startTime: string | Date | number;
  readonly endTime?: string | Date | number;
  readonly status?: 'ok' | 'error' | 'unset';
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface OtlpExporterInput {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly deadlineMs?: number;
  readonly resource?: OtlpResource;
  readonly allowInsecurePrivate?: boolean;
  readonly warn?: (message: string) => void;
  readonly metrics?: OtlpCounterSink;
  readonly routeTemplates?: ReadonlySet<string>;
}

export interface OtlpExporter {
  export(signal: OtlpSignal, body: unknown): void;
  flush(): Promise<void>;
}

export const EXPORT_FAILURES_COUNTER = 'pb.obs.export_failures';
export const DEFAULT_MAX_RECORDS = 500;
export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_DEADLINE_MS = 1500;
export const MAX_RESPONSE_BYTES = 64 * 1024;

type Json = Record<string, unknown>;
type NowFn = () => Date;
interface Ctx {
  readonly now: NowFn;
  readonly routes: ReadonlySet<string>;
}

const SIGNALS: readonly OtlpSignal[] = ['logs', 'metrics', 'traces'];
const PATHS: Readonly<Record<OtlpSignal, string>> = {
  logs: '/v1/logs',
  metrics: '/v1/metrics',
  traces: '/v1/traces',
};
const SEVERITY = new Map<string, number>([
  ['debug', 5],
  ['info', 9],
  ['warn', 13],
  ['error', 17],
]);
const SPAN_KIND = new Map<string, number>([
  ['internal', 1],
  ['server', 2],
  ['client', 3],
  ['producer', 4],
  ['consumer', 5],
]);
const MAX_UNIX_NANOS = 18446744073709551615n;
const NO_ROUTES: ReadonlySet<string> = new Set();
const ZEROS = /^0+$/;
const DELTA = 1;
const NANOS_PER_MS = 1_000_000n;

const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const SPAN_NAME = /^[A-Za-z0-9_\-./:{}* ]{1,100}$/;
const RESOURCE_TEXT = /^[A-Za-z0-9_.+-]{1,64}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,4096}$/;
const ENCODER = new TextEncoder();
const LABEL_KEYS = new Set<string>(METRIC_LABEL_KEYS);
const MAX_LABELS = 8;
const MAX_LABEL_VALUE = 200;
const MAX_BUCKETS = 256;

const LOG_ATTRIBUTES = [
  'request_id',
  'plugin',
  'route',
  'method',
  'status',
  'duration_ms',
  'project_id',
  'token_id',
  'job_id',
  'attempt',
  'error_name',
  'reason_code',
] as const;
const SPAN_ATTRIBUTES = new Set<string>([
  'request_id',
  'plugin',
  'route',
  'method',
  'status',
  'duration_ms',
  'error_name',
  'reason_code',
  'provider',
]);

const APPROVED_ERRORS: ReadonlySet<string> = new Set(APPROVED_ERROR_NAMES);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const PLUGIN_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_SLUG = /^[a-z0-9_-]{1,32}$/;
const matches =
  (re: RegExp) =>
  (v: unknown): boolean =>
    typeof v === 'string' && re.test(v);
const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const ATTRIBUTE_CHECKS: Readonly<
  Record<string, (v: unknown, routes: ReadonlySet<string>) => boolean>
> = {
  request_id: matches(UUID),
  plugin: matches(PLUGIN_ID),
  route: (v, routes) => typeof v === 'string' && routes.has(v),
  method: (v) => typeof v === 'string' && HTTP_METHODS.has(v),
  status: (v) => isInt(v, 100, 599),
  duration_ms: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  project_id: matches(ENTITY_ID),
  token_id: matches(ENTITY_ID),
  job_id: matches(ENTITY_ID),
  attempt: (v) => isInt(v, 0, 1000),
  error_name: (v) => typeof v === 'string' && APPROVED_ERRORS.has(v),
  reason_code: matches(CODE),
  provider: matches(PROVIDER_SLUG),
};

function validAttributes(
  entries: Iterable<readonly [string, unknown]>,
  routes: ReadonlySet<string>,
): Json[] {
  const kept: (readonly [string, unknown])[] = [];
  for (const [key, value] of entries) {
    if (value === null && (key === 'request_id' || key === 'project_id' || key === 'token_id')) {
      continue;
    }
    if (ATTRIBUTE_CHECKS[key]?.(value, routes) === true) kept.push([key, value]);
  }
  return attributes(kept);
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function read(source: Json, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function toNanos(value: unknown): string | null {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && ISO.test(value)) ms = Date.parse(value);
  else return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const whole = Math.floor(ms);
  const fraction = BigInt(Math.round((ms - whole) * 1e6));
  const nanos = BigInt(whole) * NANOS_PER_MS + fraction;
  return nanos > MAX_UNIX_NANOS ? null : nanos.toString();
}

function anyValue(value: unknown): Json | null {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return null;
}

function attributes(entries: Iterable<readonly [string, unknown]>): Json[] {
  const out: Json[] = [];
  for (const [key, raw] of entries) {
    const value = anyValue(raw);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

function encodeResource(resource: unknown): Json {
  const source = isRecord(resource) ? resource : {};
  const pick = (key: string, fallback?: string): string | undefined => {
    const value = read(source, key);
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !RESOURCE_TEXT.test(value)) {
      throw new RangeError(`Invalid OTLP resource field: ${key}`);
    }
    return value;
  };
  return {
    attributes: attributes([
      ['service.name', pick('service', 'package-broker')],
      ['service.version', pick('version')],
      ['deployment.id', pick('deploymentId')],
      ['process.runtime.name', pick('runtime')],
    ]),
  };
}

function metricAttributes(labels: unknown, routes: ReadonlySet<string>): Json[] | null {
  if (labels === undefined) return [];
  if (!isRecord(labels)) return null;
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABELS) return null;
  const entries: [string, string][] = [];
  for (const key of keys) {
    const value = read(labels, key);
    if (
      !LABEL_KEYS.has(key) ||
      typeof value !== 'string' ||
      value.length > MAX_LABEL_VALUE ||
      !metricLabelValueAllowed(key, value, routes)
    ) {
      return null;
    }
    entries.push([key, value]);
  }
  return attributes(entries);
}

function encodeLogRecord(input: unknown, { now, routes }: Ctx): Json | null {
  if (!isRecord(input)) return null;
  const level = read(input, 'level');
  const event = read(input, 'event');
  const severity = typeof level === 'string' ? SEVERITY.get(level) : undefined;
  if (typeof level !== 'string' || severity === undefined) return null;
  if (typeof event !== 'string' || !CODE.test(event)) return null;
  const time = toNanos(read(input, 'timestamp') ?? now());
  if (time === null) return null;
  const out: Json = {
    timeUnixNano: time,
    severityNumber: severity,
    severityText: level.toUpperCase(),
    body: { stringValue: event },
    attributes: validAttributes(
      LOG_ATTRIBUTES.map((key) => [key, read(input, key)] as const),
      routes,
    ),
  };
  const traceId = read(input, 'trace_id');
  const spanId = read(input, 'span_id');
  if (typeof traceId === 'string' && TRACE_ID.test(traceId) && !ZEROS.test(traceId)) {
    out.traceId = traceId;
  }
  if (typeof spanId === 'string' && SPAN_ID.test(spanId) && !ZEROS.test(spanId)) {
    out.spanId = spanId;
  }
  return out;
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function encodeMetric(input: unknown, { now, routes }: Ctx): Json | null {
  if (!isRecord(input)) return null;
  const kind = read(input, 'kind');
  const name = read(input, 'name');
  if (typeof name !== 'string' || !CODE.test(name)) return null;
  const attrs = metricAttributes(read(input, 'labels'), routes);
  const fallback = read(input, 'time') ?? now();
  const time = toNanos(fallback);
  const start = toNanos(read(input, 'startTime') ?? fallback);
  if (attrs === null || time === null || start === null || BigInt(start) > BigInt(time))
    return null;
  const unit = name.endsWith('_ms') ? 'ms' : '';
  const base = { attributes: attrs, startTimeUnixNano: start, timeUnixNano: time };

  if (kind === 'counter') {
    const value = read(input, 'value');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    const point = Number.isSafeInteger(value)
      ? { ...base, asInt: String(value) }
      : { ...base, asDouble: value };
    return {
      name,
      unit,
      sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: [point] },
    };
  }

  if (kind === 'histogram') {
    const bounds = read(input, 'bounds');
    const buckets = read(input, 'bucketCounts');
    const count = read(input, 'count');
    const sum = read(input, 'sum');
    if (!Array.isArray(bounds) || !Array.isArray(buckets)) return null;
    if (bounds.length > MAX_BUCKETS || buckets.length !== bounds.length + 1) return null;
    const finiteBounds = bounds.every((b, i) => {
      const previous: unknown = bounds[i - 1];
      return (
        typeof b === 'number' &&
        Number.isFinite(b) &&
        (i === 0 || (typeof previous === 'number' && b > previous))
      );
    });
    if (!finiteBounds || !buckets.every(nonNegativeInt)) return null;
    if (!nonNegativeInt(count) || typeof sum !== 'number' || !Number.isFinite(sum)) return null;
    if ((buckets as number[]).reduce((a, b) => a + b, 0) !== count) return null;
    return {
      name,
      unit,
      histogram: {
        aggregationTemporality: DELTA,
        dataPoints: [
          {
            ...base,
            count: String(count),
            sum,
            bucketCounts: (buckets as number[]).map(String),
            explicitBounds: bounds as number[],
          },
        ],
      },
    };
  }
  return null;
}

function encodeSpan(input: unknown, { now, routes }: Ctx): Json | null {
  if (!isRecord(input)) return null;
  const traceId = read(input, 'traceId');
  const spanId = read(input, 'spanId');
  const name = read(input, 'name');
  if (typeof traceId !== 'string' || !TRACE_ID.test(traceId) || ZEROS.test(traceId)) return null;
  if (typeof spanId !== 'string' || !SPAN_ID.test(spanId) || ZEROS.test(spanId)) return null;
  if (typeof name !== 'string' || !SPAN_NAME.test(name)) return null;
  const start = toNanos(read(input, 'startTime'));
  const end = toNanos(read(input, 'endTime') ?? now());
  if (start === null || end === null || BigInt(end) < BigInt(start)) return null;
  const kindName = read(input, 'kind');
  const kind = typeof kindName === 'string' ? SPAN_KIND.get(kindName) : undefined;
  const status = read(input, 'status');
  const spanAttrs = read(input, 'attributes');
  const entries: [string, unknown][] = [];
  if (isRecord(spanAttrs)) {
    for (const key of Object.keys(spanAttrs)) {
      if (SPAN_ATTRIBUTES.has(key)) entries.push([key, read(spanAttrs, key)]);
    }
  }
  const out: Json = {
    traceId,
    spanId,
    name,
    kind: kind ?? 1,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: validAttributes(entries, routes),
  };
  const parent = read(input, 'parentSpanId');
  if (typeof parent === 'string' && SPAN_ID.test(parent) && !ZEROS.test(parent)) {
    out.parentSpanId = parent;
  }
  if (status === 'ok') out.status = { code: 1 };
  else if (status === 'error') out.status = { code: 2 };
  return out;
}

const SCOPE = { name: 'package-broker' };

function logsEnvelope(resource: Json, items: readonly Json[]): Json {
  return { resourceLogs: [{ resource, scopeLogs: [{ scope: SCOPE, logRecords: items }] }] };
}
function metricsEnvelope(resource: Json, items: readonly Json[]): Json {
  return { resourceMetrics: [{ resource, scopeMetrics: [{ scope: SCOPE, metrics: items }] }] };
}
function tracesEnvelope(resource: Json, items: readonly Json[]): Json {
  return { resourceSpans: [{ resource, scopeSpans: [{ scope: SCOPE, spans: items }] }] };
}

interface SignalCodec {
  readonly item: (input: unknown, ctx: Ctx) => Json | null;
  readonly envelope: (resource: Json, items: readonly Json[]) => Json;
  readonly rejected: readonly string[];
}

const CODECS: Readonly<Record<OtlpSignal, SignalCodec>> = {
  logs: { item: encodeLogRecord, envelope: logsEnvelope, rejected: ['rejectedLogRecords'] },
  metrics: { item: encodeMetric, envelope: metricsEnvelope, rejected: ['rejectedDataPoints'] },
  traces: { item: encodeSpan, envelope: tracesEnvelope, rejected: ['rejectedSpans'] },
};

function encodeAll(signal: OtlpSignal, records: unknown, resource: unknown, ctx: Ctx): Json {
  const codec = CODECS[signal];
  const items: Json[] = [];
  if (Array.isArray(records)) {
    for (const record of records as unknown[]) {
      const encoded = codec.item(record, ctx);
      if (encoded !== null) items.push(encoded);
    }
  }
  return codec.envelope(encodeResource(resource), items);
}

const defaultNow: NowFn = () => new Date();

export function encodeLogs(
  records: unknown,
  resource: unknown,
  now: NowFn = defaultNow,
  routeTemplates: ReadonlySet<string> = NO_ROUTES,
): unknown {
  return encodeAll('logs', records, resource, { now, routes: routeTemplates });
}

export function encodeMetrics(
  points: unknown,
  resource: unknown,
  now: NowFn = defaultNow,
  routeTemplates: ReadonlySet<string> = NO_ROUTES,
): unknown {
  return encodeAll('metrics', points, resource, { now, routes: routeTemplates });
}

export function encodeTraces(
  spans: unknown,
  resource: unknown,
  now: NowFn = defaultNow,
  routeTemplates: ReadonlySet<string> = NO_ROUTES,
): unknown {
  return encodeAll('traces', spans, resource, { now, routes: routeTemplates });
}

function ipv4(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return ipv4(hostname)?.[0] === 127;
}

const PRIVATE_SUFFIXES = ['.internal', '.local', '.svc', '.cluster.local'];

function isPrivateHost(hostname: string): boolean {
  if (isLoopback(hostname)) return true;
  const octets = ipv4(hostname);
  if (octets !== null) {
    const [a, b] = octets as [number, number, number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (hostname.startsWith('[')) {
    return /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(hostname);
  }
  return PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function resolveEndpoint(input: OtlpExporterInput): string {
  const raw = input.endpoint;
  if (typeof raw !== 'string' || raw.includes('?') || raw.includes('#') || raw.includes('@')) {
    throw new RangeError('Invalid OTLP endpoint');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError('Invalid OTLP endpoint');
  }
  if (url.username !== '' || url.password !== '') throw new RangeError('Invalid OTLP endpoint');
  if (url.protocol === 'http:') {
    if (!isLoopback(url.hostname)) {
      if (input.allowInsecurePrivate !== true || !isPrivateHost(url.hostname)) {
        throw new RangeError('OTLP endpoint must use https');
      }
      input.warn?.('OTLP export uses an insecure http endpoint (allowInsecurePrivate is set)');
    }
  } else if (url.protocol !== 'https:') {
    throw new RangeError('Invalid OTLP endpoint');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const DENIED_HEADERS = new Set([
  'traceparent',
  'tracestate',
  'baggage',
  'host',
  'content-length',
  'content-type',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(headers)) throw new RangeError('Invalid OTLP headers');
  for (const key of Object.keys(headers)) {
    const value = read(headers, key);
    const lower = key.toLowerCase();
    if (
      !HEADER_NAME.test(key) ||
      typeof value !== 'string' ||
      !HEADER_VALUE.test(value) ||
      DENIED_HEADERS.has(lower) ||
      Object.hasOwn(out, lower)
    ) {
      throw new RangeError('Invalid OTLP headers');
    }
    out[lower] = value;
  }
  out['content-type'] = 'application/json';
  return out;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid OTLP ${name}`);
  return value;
}

const byteLength = (value: unknown): number => ENCODER.encode(JSON.stringify(value)).length;

async function readBounded(response: Response): Promise<string | null> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function hasRejections(text: string, fields: readonly string[]): boolean {
  if (text.trim() === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const partial = read(parsed, 'partialSuccess');
  if (!isRecord(partial)) return false;
  return fields.some((field) => {
    const rejected = Number(read(partial, field));
    return Number.isFinite(rejected) && rejected > 0;
  });
}

interface Buffered {
  item: Json;
  bytes: number;
}

const WINDOW_PLACEHOLDER = MAX_UNIX_NANOS.toString();

function aggregateOf(item: Json): { kind: 'sum' | 'histogram'; point: Json } | null {
  for (const kind of ['sum', 'histogram'] as const) {
    const aggregate = item[kind];
    if (isRecord(aggregate) && Array.isArray(aggregate.dataPoints)) {
      const point = (aggregate.dataPoints as unknown[])[0];
      if (isRecord(point)) return { kind, point };
    }
  }
  return null;
}

function seriesKey(item: Json): string | null {
  const found = aggregateOf(item);
  if (found === null || !Array.isArray(found.point.attributes)) return null;
  const labels = (found.point.attributes as Json[])
    .map((a): [string, unknown] => [String(a.key), isRecord(a.value) ? a.value.stringValue : null])
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify([item.name, found.kind, labels]);
}

function pointNumber(point: Json): number {
  return Number(point.asInt ?? point.asDouble);
}

function mergeSeries(existing: Json, incoming: Json): Json | null {
  const a = aggregateOf(existing);
  const b = aggregateOf(incoming);
  if (a === null || b === null || a.kind !== b.kind) return null;
  const replace = (point: Json): Json => {
    const aggregate = existing[a.kind] as Json;
    return { ...existing, [a.kind]: { ...aggregate, dataPoints: [point] } };
  };
  if (a.kind === 'sum') {
    const total = pointNumber(a.point) + pointNumber(b.point);
    if (!Number.isFinite(total)) return null;
    const rest: Json = { ...a.point };
    delete rest.asInt;
    delete rest.asDouble;
    return replace(
      Number.isSafeInteger(total)
        ? { ...rest, asInt: String(total) }
        : { ...rest, asDouble: total },
    );
  }
  if (JSON.stringify(a.point.explicitBounds) !== JSON.stringify(b.point.explicitBounds))
    return null;
  const left = a.point.bucketCounts as string[];
  const right = b.point.bucketCounts as string[];
  const buckets = left.map((value, i) => Number(value) + Number(right[i]));
  const count = Number(a.point.count) + Number(b.point.count);
  const sum = Number(a.point.sum) + Number(b.point.sum);
  if (
    !buckets.every(Number.isSafeInteger) ||
    !Number.isSafeInteger(count) ||
    !Number.isFinite(sum)
  ) {
    return null;
  }
  return replace({ ...a.point, count: String(count), sum, bucketCounts: buckets.map(String) });
}

function withWindow(item: Json, startNanos: string, endNanos: string): Json {
  const found = aggregateOf(item);
  if (found === null) return item;
  const aggregate = item[found.kind] as Json;
  return {
    ...item,
    [found.kind]: {
      ...aggregate,
      dataPoints: [{ ...found.point, startTimeUnixNano: startNanos, timeUnixNano: endNanos }],
    },
  };
}

export function createOtlpExporter(input: OtlpExporterInput): OtlpExporter {
  const base = resolveEndpoint(input);
  const headers = resolveHeaders(input.headers);
  const maxRecords = positive(input.maxRecords, DEFAULT_MAX_RECORDS, 'maxRecords');
  const maxBytes = positive(input.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const deadlineMs = positive(input.deadlineMs, DEFAULT_DEADLINE_MS, 'deadlineMs');
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const now: NowFn = input.now ?? defaultNow;
  const resource = encodeResource(input.resource);
  const ctx: Ctx = { now, routes: input.routeTemplates ?? NO_ROUTES };
  const overhead: Record<OtlpSignal, number> = {
    logs: byteLength(CODECS.logs.envelope(resource, [])),
    metrics: byteLength(CODECS.metrics.envelope(resource, [])),
    traces: byteLength(CODECS.traces.envelope(resource, [])),
  };
  const totals: Record<OtlpSignal, number> = { ...overhead };
  let windowEnd: bigint | null = null;
  const metricIndex = new Map<string, Buffered>();

  const buffers: Record<OtlpSignal, Buffered[]> = { logs: [], metrics: [], traces: [] };

  const count = (name: string, signal: string, value = 1): void => {
    try {
      input.metrics?.counter(name, { signal }, value);
    } catch {
      return;
    }
  };
  const drop = (signal: string, value = 1): void => count(DROPPED_COUNTER, signal, value);
  const fail = (signal: OtlpSignal): void => count(EXPORT_FAILURES_COUNTER, signal);

  const send = async (signal: OtlpSignal, body: string): Promise<void> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, deadlineMs);
    });
    const attempt = async (): Promise<boolean> => {
      const response = await fetchImpl(`${base}${PATHS[signal]}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      const text = await readBounded(response);
      return text !== null && !hasRejections(text, CODECS[signal].rejected);
    };
    try {
      const outcome = await Promise.race([attempt().catch(() => false), timeout]);
      if (outcome !== true) fail(signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const run = async (): Promise<void> => {
    const flushTime = now();
    let endNanos = BigInt(toNanos(flushTime) ?? '0');
    const startNanos = windowEnd ?? endNanos;
    if (endNanos <= startNanos) endNanos = startNanos + 1n;
    if (windowEnd !== null) windowEnd = endNanos;
    const jobs: Promise<void>[] = [];
    for (const signal of SIGNALS) {
      const taken = buffers[signal];
      if (taken.length === 0) continue;
      buffers[signal] = [];
      totals[signal] = overhead[signal];
      if (signal === 'metrics') metricIndex.clear();
      const items = taken.map((entry) =>
        signal === 'metrics'
          ? withWindow(entry.item, startNanos.toString(), endNanos.toString())
          : entry.item,
      );
      jobs.push(
        send(signal, JSON.stringify(CODECS[signal].envelope(resource, items))).catch(() =>
          fail(signal),
        ),
      );
    }
    await Promise.all(jobs);
  };

  let inflight: Promise<void> | null = null;
  let pending: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const current: Promise<void> = run()
      .catch(() => undefined)
      .finally(() => {
        if (inflight === current) inflight = null;
      });
    inflight = current;
    return current;
  };

  return {
    export(signal: OtlpSignal, body: unknown): void {
      try {
        if (!SIGNALS.includes(signal)) return drop('unknown');
        const encoded = CODECS[signal].item(body, ctx);
        if (encoded === null) return drop(signal);
        const item =
          signal === 'metrics'
            ? withWindow(encoded, WINDOW_PLACEHOLDER, WINDOW_PLACEHOLDER)
            : encoded;
        if (signal === 'metrics') {
          windowEnd ??= BigInt(toNanos(now()) ?? '0');
          const key = seriesKey(item);
          const existing = key === null ? undefined : metricIndex.get(key);
          if (existing !== undefined) {
            const merged = mergeSeries(existing.item, item);
            if (merged === null) return drop(signal);
            const mergedBytes = byteLength(merged);
            if (totals[signal] - existing.bytes + mergedBytes > maxBytes) return drop(signal);
            totals[signal] += mergedBytes - existing.bytes;
            existing.item = merged;
            existing.bytes = mergedBytes;
            return;
          }
        }
        const bytes = byteLength(item);
        const separator = buffers[signal].length > 0 ? 1 : 0;
        if (buffers[signal].length >= maxRecords || totals[signal] + bytes + separator > maxBytes) {
          return drop(signal);
        }
        totals[signal] += bytes + separator;
        const entry: Buffered = { item, bytes };
        buffers[signal].push(entry);
        if (signal === 'metrics') {
          const key = seriesKey(item);
          if (key !== null) metricIndex.set(key, entry);
        }
      } catch {
        drop('unknown');
      }
    },
    flush(): Promise<void> {
      if (inflight === null) return start();
      if (pending === null) {
        pending = inflight.then(() => {
          pending = null;
          return start();
        });
      }
      return pending;
    },
  };
}
