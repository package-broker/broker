import {
  createMetricsRegistry,
  type MetricLabels,
  type MetricsRegistry,
} from '../platform/metrics.js';
import {
  HTTP_REQUEST_EVENT,
  type ObsRecord,
  type LogLevel,
  type ObsRecordSink,
  type ObsRegistry,
  type ObsRuntime,
  type Observability,
  type ObservabilityScope,
  createObservability,
  noopObservability,
  safeRecord,
} from '../platform/observability.js';
import { traceFromInbound } from '../platform/tracing.js';
import { ENGINE_PLUGIN, INPUT_PLUGIN } from './authorize.js';
import type { KernelLog } from './errors.js';
import { type KernelReasonCode, mostSpecificReason } from './obs-codes.js';

export interface KernelObsContext {
  readonly sink: ObsRecordSink;
  readonly registry: ObsRegistry;
  readonly deploymentId: string;
  readonly runtime: ObsRuntime;
  readonly trustInboundTraceparent?: boolean;
}

export interface ScopeUpdate {
  readonly route?: string;
  readonly projectId?: string | null;
  readonly tokenId?: string | null;
}

export interface ObsExtra {
  readonly plugin?: string;
}

export interface RequestScope {
  readonly requestId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly startedAt: number;
  now(): number;
  fields(): Readonly<ObservabilityScope>;
  set(update: ScopeUpdate): void;
  obs(extra?: ObsExtra): Observability;
}

export type HttpOutcome = number | 'aborted' | 'invalid_status';

export interface HttpMetrics {
  record(fields: Readonly<ObservabilityScope>, outcome: HttpOutcome, durationMs: number): void;
}

export interface CompletionGuard {
  reason(code: KernelReasonCode): void;
  complete(status: number): void;
}

const FIELD_PROBE = { level: 'debug', event: 'probe' } as const;

function valid(field: string, value: unknown): boolean {
  if (value === undefined) return false;
  const probe = safeRecord({ ...FIELD_PROBE, [field]: value });
  return probe !== null && Object.hasOwn(probe, field);
}

function pluginLabel(plugin: string | undefined): string | undefined {
  if (plugin === undefined) return undefined;
  if (plugin === ENGINE_PLUGIN || plugin === INPUT_PLUGIN) return 'core';
  return valid('plugin', plugin) ? plugin : undefined;
}

export function createRequestScope(
  ctx: KernelObsContext,
  request: Request,
  now: () => number = Date.now,
): RequestScope {
  const startedAt = now();
  const span = traceFromInbound(
    ctx.trustInboundTraceparent === true ? request.headers.get('traceparent') : null,
    ctx.trustInboundTraceparent === true,
  );
  const requestId = crypto.randomUUID();
  const method = valid('method', request.method) ? request.method : undefined;
  let route: string | undefined;
  let projectId: string | null = null;
  let tokenId: string | null = null;
  let memo = new Map<string, Observability>();

  const compose = (): Readonly<ObservabilityScope> =>
    Object.freeze({
      deploymentId: ctx.deploymentId,
      runtime: ctx.runtime,
      requestId,
      traceId: span.traceId,
      spanId: span.spanId,
      ...(method === undefined ? {} : { method }),
      ...(route === undefined ? {} : { route }),
      projectId,
      tokenId,
    });
  let current = compose();

  const build = (scope: ObservabilityScope): Observability => {
    try {
      return createObservability(ctx.sink, scope, ctx.registry);
    } catch {
      return noopObservability;
    }
  };

  return Object.freeze({
    requestId,
    traceId: span.traceId,
    spanId: span.spanId,
    startedAt,
    now,
    fields: (): Readonly<ObservabilityScope> => current,
    set(update: ScopeUpdate): void {
      if (update.route !== undefined) {
        route =
          ctx.registry.routeTemplates.has(update.route) && valid('route', update.route)
            ? update.route
            : undefined;
      }
      if (update.projectId !== undefined) {
        projectId = valid('project_id', update.projectId) ? update.projectId : null;
      }
      if (update.tokenId !== undefined) {
        tokenId = valid('token_id', update.tokenId) ? update.tokenId : null;
      }
      current = compose();
      memo = new Map();
    },
    obs(extra?: ObsExtra): Observability {
      const plugin = pluginLabel(extra?.plugin);
      const key = plugin ?? '';
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const created = build(plugin === undefined ? current : { ...current, plugin });
      memo.set(key, created);
      return created;
    },
  });
}

export function createHttpMetrics(ctx: KernelObsContext): HttpMetrics {
  const templates = new Set(ctx.registry.routeTemplates);
  const kernelObs = createObservability(
    ctx.sink,
    { deploymentId: ctx.deploymentId, runtime: ctx.runtime, requestId: null },
    ctx.registry,
  );
  const registry: MetricsRegistry = createMetricsRegistry(kernelObs, 1000, templates);

  return Object.freeze({
    record(fields: Readonly<ObservabilityScope>, outcome: HttpOutcome, durationMs: number): void {
      const labels: MetricLabels = {
        ...(fields.method === undefined ? {} : { method: fields.method }),
        ...(fields.route !== undefined && templates.has(fields.route)
          ? { route: fields.route }
          : {}),
        ...(typeof outcome === 'number'
          ? { status_class: `${String(Math.trunc(outcome / 100))}xx` }
          : { outcome }),
      };
      try {
        registry.counter('pb.http.requests', labels).add(1);
        registry.histogram('pb.http.duration_ms', labels).observe(durationMs);
      } catch {
        return;
      }
    },
  });
}

function validStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
}

function levelFor(outcome: HttpOutcome): LogLevel {
  if (outcome === 'aborted') return 'warn';
  if (outcome === 'invalid_status') return 'error';
  return outcome >= 500 ? 'error' : 'info';
}

function reasonFor(
  outcome: HttpOutcome,
  reasonCode: KernelReasonCode | undefined,
): KernelReasonCode | undefined {
  if (outcome === 'aborted') return 'request.aborted';
  if (outcome === 'invalid_status' || outcome >= 400) return reasonCode;
  return undefined;
}

export function createCompletionGuard(
  scope: RequestScope,
  metrics: HttpMetrics,
  signal?: AbortSignal,
): CompletionGuard {
  let done = false;
  let reasonCode: KernelReasonCode | undefined;

  const finish = (outcome: HttpOutcome): void => {
    if (done) return;
    done = true;
    signal?.removeEventListener('abort', onAbort);
    const elapsed = scope.now() - scope.startedAt;
    const durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0;
    const code = reasonFor(outcome, reasonCode);
    scope.obs().log({
      level: levelFor(outcome),
      event: HTTP_REQUEST_EVENT,
      duration_ms: durationMs,
      ...(typeof outcome === 'number' ? { status: outcome } : {}),
      ...(code === undefined ? {} : { reason_code: code }),
    });
    metrics.record(scope.fields(), outcome, durationMs);
  };
  function onAbort(): void {
    finish('aborted');
  }

  if (signal !== undefined) {
    if (signal.aborted) finish('aborted');
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return Object.freeze({
    reason(code: KernelReasonCode): void {
      if (!done) reasonCode = mostSpecificReason(reasonCode, code);
    },
    complete(status: number): void {
      finish(validStatus(status) ? status : 'invalid_status');
    },
  });
}

export function logSink(log: KernelLog): ObsRecordSink {
  return Object.freeze({
    emit(record: ObsRecord): void {
      if (record.kind === 'log') log({ ...record.record });
    },
  });
}
