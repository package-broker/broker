import { parseTraceparent } from './tracing.js';
import type { OtlpSpanInput } from './otlp.js';
import { HTTP_REQUEST_EVENT, UPSTREAM_FETCH_EVENT, type SafeLogRecord } from './observability.js';

export function completionSpan(
  record: SafeLogRecord,
  routeTemplates: ReadonlySet<string>,
): OtlpSpanInput | null {
  if (record.event !== HTTP_REQUEST_EVENT) return null;
  const { trace_id: traceId, span_id: spanId, method, status, duration_ms } = record;
  const route =
    record.route !== undefined && routeTemplates.has(record.route) ? record.route : undefined;
  if (traceId === undefined || spanId === undefined || method === undefined) return null;
  if (record.timestamp === undefined) return null;
  const end = Date.parse(record.timestamp);
  if (Number.isNaN(end)) return null;

  const attributes: Record<string, string | number> = {};
  if (typeof record.request_id === 'string') attributes.request_id = record.request_id;
  if (route !== undefined) attributes.route = route;
  attributes.method = method;
  if (status !== undefined) attributes.status = status;
  if (duration_ms !== undefined) attributes.duration_ms = duration_ms;
  if (record.reason_code !== undefined) attributes.reason_code = record.reason_code;

  return {
    traceId,
    spanId,
    name: route === undefined ? method : `${method} ${route}`,
    kind: 'server',
    startTime: end - (duration_ms ?? 0),
    endTime: record.timestamp,
    status: status !== undefined && status >= 500 ? 'error' : 'unset',
    attributes,
  };
}

export function upstreamSpan(record: SafeLogRecord): OtlpSpanInput | null {
  if (record.event !== UPSTREAM_FETCH_EVENT) return null;
  const traceId = record.trace_id ?? record.upstream_trace_id;
  const parentSpanId =
    record.trace_id === undefined ? record.upstream_parent_span_id : record.span_id;
  const spanId = record.upstream_span_id;
  if (traceId === undefined || parentSpanId === undefined || spanId === undefined) return null;
  if (parseTraceparent(`00-${traceId}-${parentSpanId}-01`) === null) return null;
  if (spanId === parentSpanId || /^0+$/.test(spanId)) return null;
  const method = record.upstream_method;
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method ?? ''))
    return null;
  if (record.timestamp === undefined || method === undefined) return null;
  const end = Date.parse(record.timestamp);
  if (!Number.isFinite(end)) return null;
  const attributes: Record<string, string | number | boolean> = { method };
  if (record.upstream_origin !== undefined) attributes['upstream.origin'] = record.upstream_origin;
  for (const key of ['status', 'redirects', 'duration_ms', 'outcome', 'cross_origin'] as const) {
    const value = record[key];
    if (value !== undefined) attributes[key] = value;
  }
  return {
    traceId,
    spanId,
    parentSpanId,
    name: UPSTREAM_FETCH_EVENT,
    kind: 'client',
    startTime: end - (record.duration_ms ?? 0),
    endTime: record.timestamp,
    status: record.outcome !== undefined || (record.status ?? 0) >= 500 ? 'error' : 'unset',
    attributes,
  };
}
