import type { OtlpSpanInput } from './otlp.js';
import { HTTP_REQUEST_EVENT, type SafeLogRecord } from './observability.js';

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
