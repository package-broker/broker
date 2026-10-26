export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface MetricLabels {
  readonly [key: string]: string;
}

export interface Observability {
  log(record: LogRecord): void;
  counter(name: string, labels?: MetricLabels, value?: number): void;
  histogram(name: string, value: number, labels?: MetricLabels): void;
}

export type ObsRuntime = 'cloudflare' | 'node';

export interface SafeLogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly timestamp?: string;
  readonly service?: 'package-broker';
  readonly deployment_id?: string;
  readonly runtime?: ObsRuntime;
  readonly request_id?: string | null;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly plugin?: string;
  readonly route?: string;
  readonly method?: string;
  readonly status?: number;
  readonly duration_ms?: number;
  readonly project_id?: string | null;
  readonly token_id?: string | null;
  readonly user_id?: string | null;
  readonly session_id?: string | null;
  readonly job_id?: string;
  readonly attempt?: number;
  readonly error_name?: ErrorName;
  readonly reason_code?: string;
  readonly head_seq?: number;
  readonly seq?: number;
  readonly rows?: number;
  readonly head_hash?: string;
  readonly reason?: 'seq_gap' | 'prev_hash' | 'hash' | 'org_mismatch';
  readonly package_key?: string;
  readonly source_id?: string;
  readonly upstream_trace_id?: string;
  readonly upstream_parent_span_id?: string;
  readonly upstream_span_id?: string;
  readonly upstream_origin?: string;
  readonly upstream_method?: string;
  readonly redirects?: number;
  readonly cross_origin?: boolean;
  readonly outcome?: string;
  readonly requested_names?: number;
  readonly forwarded_names?: number;
  readonly advisories?: number;
  readonly unexpected_keys?: number;
  readonly dropped_advisories?: number;
}

export const LOG_FIELDS = [
  'level',
  'event',
  'timestamp',
  'service',
  'deployment_id',
  'runtime',
  'request_id',
  'trace_id',
  'span_id',
  'plugin',
  'route',
  'method',
  'status',
  'duration_ms',
  'project_id',
  'token_id',
  'user_id',
  'session_id',
  'job_id',
  'attempt',
  'error_name',
  'reason_code',
  'head_seq',
  'seq',
  'rows',
  'head_hash',
  'reason',
  'package_key',
  'source_id',
  'upstream_trace_id',
  'upstream_parent_span_id',
  'upstream_span_id',
  'upstream_origin',
  'upstream_method',
  'redirects',
  'cross_origin',
  'outcome',
  'requested_names',
  'forwarded_names',
  'advisories',
  'unexpected_keys',
  'dropped_advisories',
] as const satisfies readonly (keyof SafeLogRecord)[];

export type LogField = (typeof LOG_FIELDS)[number];

type AssertNever<T extends never> = T;
export type LogFieldsExhaustive = AssertNever<Exclude<keyof SafeLogRecord, LogField>>;

export function projectLogFields(record: object): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const out: Record<string, unknown> = {};
  for (const key of LOG_FIELDS) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== undefined) {
      out[key] = descriptor.value;
    }
  }
  return out;
}

export type ObsRecord =
  | { readonly kind: 'log'; readonly record: SafeLogRecord }
  | {
      readonly kind: 'counter';
      readonly name: string;
      readonly labels: MetricLabels;
      readonly value: number;
    }
  | {
      readonly kind: 'histogram';
      readonly name: string;
      readonly value: number;
      readonly labels: MetricLabels;
    };

export interface ObsRecordSink {
  emit(record: ObsRecord): void;
}

const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function filterLogLevel(sink: ObsRecordSink, level: LogLevel = 'info'): ObsRecordSink {
  return {
    emit(record): void {
      if (record.kind === 'log' && LOG_LEVEL_ORDER[record.record.level] < LOG_LEVEL_ORDER[level])
        return;
      sink.emit(record);
    },
  };
}

export interface ObservabilityScope {
  readonly deploymentId: string;
  readonly runtime: ObsRuntime;
  readonly requestId: string | null;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly plugin?: string;
  readonly route?: string;
  readonly method?: string;
  readonly projectId?: string | null;
  readonly tokenId?: string | null;
  readonly jobId?: string;
  readonly attempt?: number;
}

export const MAX_RECORD_BYTES = 8192;
export const DROPPED_COUNTER = 'pb.obs.dropped';
export const DROPPED_SIGNALS = [
  'log',
  'counter',
  'histogram',
  'unregistered',
  'cardinality',
  'kind_conflict',
  'export',
] as const;
export type DroppedSignal = (typeof DROPPED_SIGNALS)[number];
export const HTTP_REQUEST_EVENT = 'http.request';
export const UPSTREAM_FETCH_EVENT = 'upstream.fetch';
export const NPM_AUDIT_EVENT = 'registry.npm_audit';
export const NPM_AUDIT_REASON_CODES = [
  'ok',
  'empty',
  'unsupported',
  'disabled',
  'verify_overflow',
  'verify_failed',
  'upstream_unavailable',
  'upstream_rate_limited',
  'upstream_status',
  'upstream_protocol',
  'aborted',
] as const;

export function isUpstreamOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

export const APPROVED_ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'DbError',
  'SecretsConfigError',
  'KernelConfigError',
  'BlobRangeError',
  'BlobDigestMismatchError',
  'StaleFenceError',
  'PlatformUnavailableError',
  'UnknownJobType',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
  'NonError',
  'NotBootstrappedError',
  'CsrfError',
  'CredentialNotFoundError',
  'UnknownKeyVersionError',
  'SecretDecryptError',
  'HookTimeoutError',
  'EngineTimeoutError',
  'ProbeFailedError',
  'ReadinessTimeoutError',
  'BadBodyError',
  'OidcProviderError',
  'JwtError',
  'BoundedFetchError',
  'AlreadyBootstrappedError',
  'StartupConfigError',
  'SqlScanError',
  'MigrationSourceError',
  'MigrationLockedError',
  'MigrationSyntaxError',
  'MigrationChecksumError',
  'MigrationApplyError',
  'MigrationOrderError',
  'MigrationStateError',
  'BuiltManifestError',
  'JobError',
  'JsonStreamError',
  'JsonExtractError',
  'LeaseLostError',
  'CoalesceDoneCheckError',
  'SnapshotCorruptError',
  'SnapshotStagingRejectedError',
  'UpstreamUnstableError',
  'TwoPassLimitError',
  'NpmPackumentError',
  'ComposerRootError',
  'ComposerV2Error',
  'PackagistBusyError',
  'OsvError',
] as const;

export type ErrorName = (typeof APPROVED_ERROR_NAMES)[number];

const APPROVED = new Set<string>(APPROVED_ERROR_NAMES);
const LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const RUNTIMES = new Set<string>(['cloudflare', 'node']);

const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const PLUGIN_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROUTE = /^\/[A-Za-z0-9_\-./:{}*]{0,199}$/;
const LABEL_TOKEN = /^[a-z0-9_]{1,24}$/;
const LABEL_SLUG = /^[a-z0-9_-]{1,32}$/;
export const PACKAGE_KEY_MAX_LENGTH = 428;
// eslint-disable-next-line no-control-regex
const PACKAGE_KEY_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f:?#\\]/;
const STATUS_CLASS = /^[1-5]xx$/;
export const MAX_METRIC_LABELS = 8;
export const FINISH_FAILURE_DETAIL_LABELS = Object.freeze({
  invalid_grant: true,
  invalid_client: true,
  invalid_request: true,
  unauthorized_client: true,
  unsupported_grant_type: true,
  invalid_scope: true,
  token_endpoint_error: true,
} as const);
const LABEL_KEYS = new Set([
  'method',
  'route',
  'status_class',
  'runtime',
  'signal',
  'outcome',
  'kind',
  'adapter',
  'provider',
  'detail',
]);
const ENCODER = new TextEncoder();
const MAX_PROTOTYPE_STEPS = 32;

export interface ObsRegistry {
  readonly events: ReadonlySet<string>;
  readonly reasonCodes: ReadonlySet<string>;
  readonly routeTemplates: ReadonlySet<string>;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const matches =
  (re: RegExp) =>
  (v: unknown): boolean =>
    isString(v) && re.test(v);
const nullable =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === null || check(v);

type FieldCheck = (v: unknown) => boolean;

const packageKey: FieldCheck = (v) =>
  isString(v) &&
  v.length >= 1 &&
  v.length <= PACKAGE_KEY_MAX_LENGTH &&
  v === v.toLowerCase() &&
  !PACKAGE_KEY_FORBIDDEN.test(v);

const FIELD_CHECKS: Readonly<
  Record<Exclude<LogField, 'level' | 'event' | 'error_name'>, FieldCheck>
> = {
  timestamp: matches(TIMESTAMP),
  service: (v) => v === 'package-broker',
  deployment_id: matches(DEPLOYMENT_ID),
  runtime: (v) => isString(v) && RUNTIMES.has(v),
  request_id: nullable(matches(UUID)),
  trace_id: matches(TRACE_ID),
  span_id: matches(SPAN_ID),
  plugin: matches(PLUGIN_ID),
  route: matches(ROUTE),
  method: (v) => isString(v) && METHODS.has(v),
  status: (v) => isInt(v, 100, 599),
  duration_ms: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86_400_000,
  project_id: nullable(matches(ENTITY_ID)),
  token_id: nullable(matches(ENTITY_ID)),
  user_id: nullable(matches(ENTITY_ID)),
  session_id: nullable(matches(ENTITY_ID)),
  job_id: matches(ENTITY_ID),
  attempt: (v) => isInt(v, 0, 1000),
  reason_code: matches(CODE),
  head_seq: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  seq: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  rows: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  head_hash: matches(/^[0-9a-f]{64}$/),
  reason: (v) => v === 'seq_gap' || v === 'prev_hash' || v === 'hash' || v === 'org_mismatch',
  package_key: packageKey,
  source_id: matches(ENTITY_ID),
  upstream_trace_id: matches(TRACE_ID),
  upstream_parent_span_id: matches(SPAN_ID),
  upstream_span_id: matches(SPAN_ID),
  upstream_origin: isUpstreamOrigin,
  upstream_method: (v) => isString(v) && METHODS.has(v),
  redirects: (v) => isInt(v, 0, 5),
  cross_origin: (v) => typeof v === 'boolean',
  outcome: matches(CODE),
  requested_names: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  forwarded_names: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  advisories: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  unexpected_keys: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
  dropped_advisories: (v) => isInt(v, 0, Number.MAX_SAFE_INTEGER),
};

const CHECKS_BY_NAME: Readonly<Record<string, FieldCheck | undefined>> = FIELD_CHECKS;

const SCOPE_ONLY = [
  'timestamp',
  'service',
  'deployment_id',
  'runtime',
  'request_id',
  'trace_id',
  'span_id',
  'plugin',
  'project_id',
  'token_id',
  'job_id',
  'attempt',
] as const;

export function safeErrorName(error: unknown): ErrorName {
  try {
    if (!(error instanceof Error)) return 'Error';
    let current: object | null = error;
    for (let step = 0; step < MAX_PROTOTYPE_STEPS && current !== null; step += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
      if (descriptor !== undefined) {
        const name: unknown = 'value' in descriptor ? descriptor.value : undefined;
        return isString(name) && APPROVED.has(name) ? (name as ErrorName) : 'Error';
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return 'Error';
  }
  return 'Error';
}

export function safeRecord(record: unknown): SafeLogRecord | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    };
    const level = read('level');
    const event = read('event');
    if (!isString(level) || !LEVELS.has(level)) return null;
    if (!isString(event) || !CODE.test(event)) return null;

    let inputBytes = 0;
    for (const key of Object.keys(FIELD_CHECKS).concat('error_name')) {
      const value = read(key);
      if (isString(value)) inputBytes += value.length;
    }
    if (inputBytes > MAX_RECORD_BYTES) return null;

    const out: Record<string, unknown> = { level, event };
    for (const [key, check] of Object.entries(FIELD_CHECKS)) {
      const value = read(key);
      if (value !== undefined && check(value)) out[key] = value;
    }
    const errorName = read('error_name');
    if (isString(errorName)) out.error_name = APPROVED.has(errorName) ? errorName : 'Error';

    const serialized = JSON.stringify(out);
    if (ENCODER.encode(serialized).length > MAX_RECORD_BYTES) return null;
    return out as unknown as SafeLogRecord;
  } catch {
    return null;
  }
}

function safeLabels(labels: unknown, routeTemplates: ReadonlySet<string>): MetricLabels | null {
  if (labels === undefined) return {};
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(labels);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_METRIC_LABELS) return null;
    const out: Record<string, string> = {};
    for (const key of keys) {
      if (!isString(key) || !LABEL_KEYS.has(key)) return null;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor)) return null;
      const value: unknown = descriptor.value;
      if (!isString(value) || !metricLabelValueAllowed(key, value, routeTemplates)) return null;
      out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

export function metricLabelValueAllowed(
  key: string,
  value: string,
  routeTemplates: ReadonlySet<string>,
): boolean {
  switch (key) {
    case 'detail':
      return Object.hasOwn(FINISH_FAILURE_DETAIL_LABELS, value);
    case 'method':
      return METHODS.has(value);
    case 'route':
      return routeTemplates.has(value);
    case 'status_class':
      return STATUS_CLASS.test(value);
    case 'runtime':
      return RUNTIMES.has(value);
    case 'adapter':
    case 'provider':
      return LABEL_SLUG.test(value);
    default:
      return LABEL_TOKEN.test(value);
  }
}

function scopeFields(scope: ObservabilityScope): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    service: 'package-broker',
    deployment_id: scope.deploymentId,
    runtime: scope.runtime,
    request_id: scope.requestId,
  };
  const optional: Record<string, unknown> = {
    trace_id: scope.traceId,
    span_id: scope.spanId,
    plugin: scope.plugin,
    route: scope.route,
    method: scope.method,
    project_id: scope.projectId,
    token_id: scope.tokenId,
    job_id: scope.jobId,
    attempt: scope.attempt,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

function assertScope(scope: ObservabilityScope): void {
  if (typeof scope !== 'object' || scope === null)
    throw new RangeError('Invalid observability scope');
  const fields = scopeFields(scope);
  for (const [key, value] of Object.entries(fields)) {
    const check = CHECKS_BY_NAME[key];
    if (check === undefined || !check(value)) {
      throw new RangeError(`Invalid observability scope field: ${key}`);
    }
  }
  if (scope.plugin !== undefined && !PLUGIN_ID.test(scope.plugin)) {
    throw new RangeError('Invalid observability scope field: plugin');
  }
}

export function createObservability(
  backend: ObsRecordSink,
  scope: ObservabilityScope,
  registry: ObsRegistry,
): Observability {
  const snapshot: ObservabilityScope = Object.freeze({ ...scope });
  assertScope(snapshot);
  const frozen = scopeFields(snapshot);
  const events = new Set(registry.events);
  const reasonCodes = new Set(registry.reasonCodes);
  const routeTemplates = new Set(registry.routeTemplates);

  const emit = (record: ObsRecord): void => {
    try {
      backend.emit(record);
    } catch {
      return;
    }
  };
  const dropped = (signal: DroppedSignal): void =>
    emit({ kind: 'counter', name: DROPPED_COUNTER, labels: { signal }, value: 1 });
  const validName = (name: unknown): name is string => isString(name) && CODE.test(name);

  return Object.freeze({
    log(record: LogRecord): void {
      const caller = safeRecord(record);
      if (caller === null) return dropped('log');
      if (
        !events.has(caller.event) ||
        (caller.reason_code !== undefined && !reasonCodes.has(caller.reason_code))
      ) {
        return dropped('unregistered');
      }
      const merged: Record<string, unknown> = { ...caller };
      for (const key of [...SCOPE_ONLY, 'route']) delete merged[key];
      if (caller.event === UPSTREAM_FETCH_EVENT && snapshot.traceId !== undefined) {
        delete merged.upstream_trace_id;
        delete merged.upstream_parent_span_id;
        merged.upstream_trace_id = snapshot.traceId;
        if (snapshot.spanId !== undefined) merged.upstream_parent_span_id = snapshot.spanId;
      }
      Object.assign(merged, frozen, { timestamp: new Date().toISOString() });
      const safe = safeRecord(merged);
      if (safe === null) return dropped('log');
      emit({ kind: 'log', record: Object.freeze(safe) });
    },
    counter(name: string, labels?: MetricLabels, value = 1): void {
      const safe = safeLabels(labels, routeTemplates);
      if (!validName(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return dropped('counter');
      }
      if (safe === null) return dropped('counter');
      emit({ kind: 'counter', name, labels: safe, value });
    },
    histogram(name: string, value: number, labels?: MetricLabels): void {
      const safe = safeLabels(labels, routeTemplates);
      if (!validName(name) || typeof value !== 'number' || !Number.isFinite(value)) {
        return dropped('histogram');
      }
      if (safe === null) return dropped('histogram');
      emit({ kind: 'histogram', name, value, labels: safe });
    },
  });
}

// Plugins receive only the scoped port returned here, never the backend sink.
export function forPlugin(
  backend: ObsRecordSink,
  scope: ObservabilityScope,
  pluginId: string,
  registry: ObsRegistry,
): Observability {
  if (!isString(pluginId) || !PLUGIN_ID.test(pluginId)) {
    throw new RangeError('Invalid observability scope field: plugin');
  }
  return createObservability(backend, { ...scope, plugin: pluginId }, registry);
}

export const noopObservability: Observability = Object.freeze({
  log(): void {},
  counter(): void {},
  histogram(): void {},
});

export const VULNERABILITY_EVENT = 'vulnerability.sync';
export const VULNERABILITY_REASON_CODES = [
  'vulnerability.candidates',
  'vulnerability.authorized',
  'vulnerability.skipped',
  'vulnerability.affected',
  'vulnerability.checked',
  'vulnerability.pending',
  'vulnerability.detail',
  'vulnerability.unavailable',
  'vulnerability.protocol',
  'vulnerability.config',
  'vulnerability.limit',
] as const;
export const VULNERABILITY_METRICS = Object.freeze({
  versions: 'pb.vulnerability.versions',
  duration: 'pb.vulnerability.duration_ms',
  bytes: 'pb.vulnerability.bytes',
  backlogAge: 'pb.vulnerability.backlog_age_ms',
});

export type VulnerabilityOutcome =
  (typeof VULNERABILITY_REASON_CODES)[number] extends `vulnerability.${infer Outcome}`
    ? Outcome
    : never;
