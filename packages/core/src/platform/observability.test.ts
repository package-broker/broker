import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APPROVED_ERROR_NAMES,
  DROPPED_SIGNALS,
  metricLabelValueAllowed,
  HTTP_REQUEST_EVENT,
  LOG_FIELDS,
  type SafeLogRecord,
  projectLogFields,
  type ObsRecord,
  type ObsRecordSink,
  type ObservabilityScope,
  type ObsRegistry,
  createObservability,
  filterLogLevel,
  forPlugin,
  noopObservability,
  safeErrorName,
  safeRecord,
} from './observability.js';
import { upstreamSpan } from './completion-span.js';
import { encodeTraces } from './otlp.js';
import type { Observability } from './observability.js';

import { reportableErrorName } from '../kernel/error-name.js';
import { JsonExtractError } from '../ingest/json-stream.js';
import { LeaseLostError, CoalesceDoneCheckError } from '../ingest/coalesce.js';
import { SnapshotCorruptError, SnapshotStagingRejectedError } from '../ingest/snapshot.js';
import { UpstreamUnstableError, TwoPassLimitError } from '../ingest/two-pass-put.js';
import { NpmPackumentError } from '../ingest/npm/packument.js';
import { ComposerRootError } from '../ingest/composer/root.js';
import { ComposerV2Error } from '../ingest/composer/v2-package.js';
import { PackagistBusyError } from '../ingest/composer/packagist-proxy.js';

const SECRET = 'sk_live_TOP-SECRET-4242';
const REQUEST_ID = '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11';

function collector(): { sink: ObsRecordSink; records: ObsRecord[] } {
  const records: ObsRecord[] = [];
  return { sink: { emit: (record) => void records.push(record) }, records };
}

function scope(extra: Partial<ObservabilityScope> = {}): ObservabilityScope {
  return {
    deploymentId: 'dep-1',
    runtime: 'node',
    requestId: REQUEST_ID,
    ...extra,
  };
}

const REGISTRY: ObsRegistry = {
  events: new Set(['http.request', 'e', 'failed', 'startup']),
  reasonCodes: new Set(['denied', 'stale_fence']),
  routeTemplates: new Set(['/p/{id}']),
};

function logs(records: readonly ObsRecord[]): Record<string, unknown>[] {
  return records.flatMap((r) => (r.kind === 'log' ? [{ ...r.record }] : []));
}

describe('ingest error names', () => {
  it.each([
    [new JsonExtractError('invalid_member', 0), 'JsonExtractError'],
    [new LeaseLostError(), 'LeaseLostError'],
    [new CoalesceDoneCheckError(), 'CoalesceDoneCheckError'],
    [new SnapshotCorruptError(), 'SnapshotCorruptError'],
    [new SnapshotStagingRejectedError(), 'SnapshotStagingRejectedError'],
    [new UpstreamUnstableError(), 'UpstreamUnstableError'],
    [new TwoPassLimitError(1), 'TwoPassLimitError'],
    [new NpmPackumentError('invalid'), 'NpmPackumentError'],
    [new ComposerRootError('invalid'), 'ComposerRootError'],
    [new ComposerV2Error('unsupported'), 'ComposerV2Error'],
    [new PackagistBusyError(null), 'PackagistBusyError'],
  ] as const)('preserves %s as %s across reporting boundaries', (error, expectedName) => {
    expect(reportableErrorName(error)).toBe(expectedName);
    expect(safeErrorName(error)).toBe(expectedName);
    expect(
      safeRecord({ level: 'error', event: 'ingest.failed', error_name: error.name })?.error_name,
    ).toBe(expectedName);
  });
});

describe('safeRecord', () => {
  it('keeps an opaque source id unchanged', () => {
    const record = {
      level: 'warn',
      event: 'ingest.budget_exhausted',
      source_id: '01JA0000000000000000000000',
    };
    expect(safeRecord(record)).toEqual(record);
    expect(projectLogFields(record)).toEqual(record);
  });

  it.each(['', 'a'.repeat(65), 'opaque@id', 'https://user:secret@example.test', 42, null])(
    'drops an invalid source id %j',
    (source_id) => {
      const record = { level: 'warn', event: 'ingest.budget_exhausted' };
      expect(safeRecord({ ...record, source_id })).toEqual(record);
    },
  );

  it.each(['01J00000000000000000000000', 'a'.repeat(64), null])(
    'keeps opaque user and session ids: %s',
    (id) => {
      const record = { level: 'info', event: 'e', user_id: id, session_id: id };
      expect(safeRecord(record)).toEqual(record);
      expect(projectLogFields(record)).toEqual(record);
    },
  );

  it.each(['user_id', 'session_id'])('drops an email in %s', (field) => {
    const record = { level: 'info', event: 'e' };
    expect(safeRecord({ ...record, [field]: ['a', 'b.example'].join('@') })).toEqual(record);
  });

  it.each(['user_id', 'session_id'])('drops an at sign in %s', (field) => {
    const record = { level: 'info', event: 'e' };
    expect(safeRecord({ ...record, [field]: 'opaque@id' })).toEqual(record);
  });

  it.each(['user_id', 'session_id'])('drops a 65-character %s', (field) => {
    const record = { level: 'info', event: 'e' };
    expect(safeRecord({ ...record, [field]: 'a'.repeat(65) })).toEqual(record);
  });

  it('keeps allowlisted fields and drops unknown ones', () => {
    const out = safeRecord({ level: 'info', event: 'http.request', status: 200, extra: SECRET });
    expect(out).toEqual({ level: 'info', event: 'http.request', status: 200 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('returns null without a valid level or event', () => {
    expect(safeRecord({ event: 'x' })).toBeNull();
    expect(safeRecord({ level: 'loud', event: 'x' })).toBeNull();
    expect(safeRecord({ level: 'info', event: 'Has Spaces' })).toBeNull();
    expect(safeRecord({ level: 'info', event: `a${'b'.repeat(64)}` })).toBeNull();
    expect(safeRecord(null)).toBeNull();
    expect(safeRecord('text')).toBeNull();
    expect(safeRecord([1, 2])).toBeNull();
  });

  it('does not invoke getters and drops the field', () => {
    let called = 0;
    const record = { level: 'info', event: 'e' };
    Object.defineProperty(record, 'status', {
      enumerable: true,
      get() {
        called += 1;
        return 200;
      },
    });
    Object.defineProperty(record, 'reason_code', {
      enumerable: true,
      get() {
        called += 1;
        return SECRET;
      },
    });
    const out = safeRecord(record);
    expect(called).toBe(0);
    expect(out).toEqual({ level: 'info', event: 'e' });
  });

  it('drops cyclic values, symbols, functions and bigint', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = safeRecord({
      level: 'warn',
      event: 'e',
      status: 200,
      route: cyclic,
      method: () => 'GET',
      attempt: 10n,
      duration_ms: Symbol('x'),
      [Symbol('s')]: SECRET,
    });
    expect(out).toEqual({ level: 'warn', event: 'e', status: 200 });
  });

  it('survives a throwing proxy', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SECRET);
        },
      },
    );
    expect(safeRecord(proxy)).toBeNull();
  });

  it('drops an over-8-KiB record entirely', () => {
    const out = safeRecord({ level: 'info', event: 'e', route: `/${SECRET}${'a'.repeat(9000)}` });
    expect(out).toBeNull();
  });

  it('maps error_name to the approved set with Error fallback', () => {
    expect(safeRecord({ level: 'error', event: 'e', error_name: 'DbError' })?.error_name).toBe(
      'DbError',
    );
    expect(safeRecord({ level: 'error', event: 'e', error_name: SECRET })?.error_name).toBe(
      'Error',
    );
    expect(safeRecord({ level: 'error', event: 'e', error_name: new Error(SECRET) })).toEqual({
      level: 'error',
      event: 'e',
    });
  });

  it('rejects malformed typed fields', () => {
    const out = safeRecord({
      level: 'info',
      event: 'e',
      status: 99,
      duration_ms: -1,
      method: 'get /?token=1',
      request_id: 'not-a-uuid',
      runtime: 'deno',
      service: 'evil',
      trace_id: 'zz',
    });
    expect(out).toEqual({ level: 'info', event: 'e' });
  });
});

describe('safeErrorName', () => {
  it('never exposes message, cause or stack', () => {
    class DbError extends Error {
      override name = 'DbError';
    }
    expect(safeErrorName(new DbError(SECRET))).toBe('DbError');
    expect(safeErrorName(new TypeError(SECRET))).toBe('TypeError');
    const custom = new Error(SECRET);
    custom.name = SECRET;
    expect(safeErrorName(custom)).toBe('Error');
    expect(safeErrorName(SECRET)).toBe('Error');
    expect(safeErrorName(null)).toBe('Error');
  });

  it('never invokes getters on the error or its prototype chain', () => {
    const spy = { called: 0 };
    const own = new Error('x');
    Object.defineProperty(own, 'name', {
      get() {
        spy.called += 1;
        return 'DbError';
      },
    });
    class Proto extends Error {}
    Object.defineProperty(Proto.prototype, 'name', {
      get() {
        spy.called += 1;
        return 'DbError';
      },
    });
    expect(safeErrorName(own)).toBe('Error');
    expect(safeErrorName(new Proto('x'))).toBe('Error');
    expect(spy.called).toBe(0);
  });
});

describe('createObservability', () => {
  it.each(['user_id', 'session_id'])('refuses %s as a metric label', (field) => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope(), REGISTRY);
    obs.counter('pb.auth.events', { [field]: 'opaque_id' });
    expect(records).toEqual([
      { kind: 'counter', name: 'pb.obs.dropped', labels: { signal: 'counter' }, value: 1 },
    ]);
  });

  it('parents plugin upstream spans to the scope despite forged caller ids', () => {
    const { sink, records } = collector();
    const obs = forPlugin(
      sink,
      scope({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      'acme',
      { ...REGISTRY, events: new Set(['upstream.fetch']) },
    );
    obs.log({
      level: 'debug',
      event: 'upstream.fetch',
      upstream_trace_id: 'd'.repeat(32),
      upstream_parent_span_id: 'e'.repeat(16),
      upstream_span_id: 'c'.repeat(16),
      upstream_method: 'GET',
    });
    const entry = records[0];
    expect(entry?.kind).toBe('log');
    if (entry?.kind !== 'log') throw new Error('missing log');
    expect(entry.record).toMatchObject({
      upstream_trace_id: 'a'.repeat(32),
      upstream_parent_span_id: 'b'.repeat(16),
    });
    const span = upstreamSpan(entry.record);
    expect(span).toMatchObject({
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      spanId: 'c'.repeat(16),
    });
    expect(JSON.stringify(encodeTraces([span], {}))).toContain('"parentSpanId":"bbbbbbbbbbbbbbbb"');
  });

  it('keeps an upstream debug log without a trace and exports no span', () => {
    const { sink, records } = collector();
    createObservability(sink, scope(), {
      ...REGISTRY,
      events: new Set(['upstream.fetch']),
    }).log({
      level: 'debug',
      event: 'upstream.fetch',
      upstream_span_id: 'c'.repeat(16),
      upstream_method: 'GET',
    });
    expect(records).toHaveLength(1);
    const entry = records[0];
    expect(entry?.kind).toBe('log');
    if (entry?.kind !== 'log') throw new Error('missing log');
    expect(entry.record.level).toBe('debug');
    expect(upstreamSpan(entry.record)).toBeNull();
  });

  it('stamps scope fields and service', () => {
    const { sink, records } = collector();
    createObservability(sink, scope({ route: '/p/{id}', method: 'GET' }), REGISTRY).log({
      level: 'info',
      event: 'http.request',
      status: 200,
    });
    const [rec] = logs(records);
    expect(rec).toMatchObject({
      level: 'info',
      event: 'http.request',
      service: 'package-broker',
      deployment_id: 'dep-1',
      runtime: 'node',
      request_id: REQUEST_ID,
      route: '/p/{id}',
      method: 'GET',
      status: 200,
    });
    expect(typeof rec?.timestamp).toBe('string');
  });

  it('keeps request_id null for startup scope', () => {
    const { sink, records } = collector();
    createObservability(sink, scope({ requestId: null }), REGISTRY).log({
      level: 'info',
      event: 'startup',
    });
    expect(logs(records)[0]?.request_id).toBeNull();
  });

  it('keeps the scoped plugin and service fields against caller overrides', () => {
    const { sink, records } = collector();
    const obs = forPlugin(sink, scope({ projectId: 'proj_1' }), 'acme', REGISTRY);
    obs.log({
      level: 'info',
      event: 'e',
      plugin: 'evil',
      service: 'evil',
      deployment_id: 'evil',
      request_id: '11111111-1111-4111-8111-111111111111',
      project_id: 'other',
      token_id: 'tok',
      runtime: 'cloudflare',
    });
    const [rec] = logs(records);
    expect(rec).toMatchObject({
      plugin: 'acme',
      service: 'package-broker',
      deployment_id: 'dep-1',
      request_id: REQUEST_ID,
      project_id: 'proj_1',
      runtime: 'node',
    });
    expect(rec).not.toHaveProperty('token_id');
  });

  it('rejects an invalid plugin id at construction', () => {
    const { sink } = collector();
    expect(() => forPlugin(sink, scope(), 'Bad Id!', REGISTRY)).toThrow();
  });

  it('does not let a secret-bearing error reach the backend', () => {
    const { sink, records } = collector();
    const error = new Error(SECRET, { cause: new Error(SECRET) });
    createObservability(sink, scope(), REGISTRY).log({
      level: 'error',
      event: 'failed',
      error_name: safeErrorName(error),
      error,
      message: SECRET,
      stack: error.stack,
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(SECRET);
    expect(logs(records)[0]?.error_name).toBe('Error');
  });

  it('drops an over-cap record and emits pb.obs.dropped, never a truncation', () => {
    const { sink, records } = collector();
    createObservability(sink, scope(), REGISTRY).log({
      level: 'info',
      event: 'e',
      route: `/${SECRET}${'a'.repeat(9000)}`,
    });
    expect(logs(records)).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records).toContainEqual({
      kind: 'counter',
      name: 'pb.obs.dropped',
      labels: { signal: 'log' },
      value: 1,
    });
  });

  it('emits counters and histograms with allowlisted labels', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope({ route: '/p/{id}' }), REGISTRY);
    obs.counter('pb.http.requests', { method: 'GET', status_class: '2xx' });
    obs.counter('pb.jobs.executions', undefined, 3);
    obs.histogram('pb.http.duration_ms', 12.5, { route: '/p/{id}', outcome: 'ok_1' });
    expect(records).toEqual([
      {
        kind: 'counter',
        name: 'pb.http.requests',
        labels: { method: 'GET', status_class: '2xx' },
        value: 1,
      },
      { kind: 'counter', name: 'pb.jobs.executions', labels: {}, value: 3 },
      {
        kind: 'histogram',
        name: 'pb.http.duration_ms',
        value: 12.5,
        labels: { route: '/p/{id}', outcome: 'ok_1' },
      },
    ]);
  });

  it('drops the whole metric on any disallowed label key or value', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope({ route: '/p/{id}' }), REGISTRY);
    obs.counter('pb.ok', { token: SECRET });
    obs.counter('pb.ok', { outcome: 'a@b.example' });
    obs.counter('pb.ok', { outcome: SECRET });
    obs.counter('pb.ok', { fine: 'yes' });
    obs.counter('pb.ok', { route: '/pb_live_x/dist' });
    obs.counter('pb.ok', { method: 'get', outcome: 'ok' });
    obs.histogram('pb.ok', 1, { kind: 'ok', status_class: '2xx', extra: 'x' });
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
    obs.counter('pb.ok', nine);
    const getter = {};
    Object.defineProperty(getter, 'outcome', { enumerable: true, get: () => 'ok' });
    obs.counter('pb.ok', getter as never);
    expect(records.every((r) => r.kind === 'counter' && r.name === 'pb.obs.dropped')).toBe(true);
    expect(records).toHaveLength(9);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it('drops bad metric names and values', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope(), REGISTRY);
    obs.counter('Bad Name');
    obs.counter('pb.x', {}, Number.NaN);
    obs.counter('pb.x', {}, -1);
    obs.histogram('pb.x', Number.POSITIVE_INFINITY);
    expect(records).toHaveLength(4);
    expect(records.every((r) => r.kind === 'counter' && r.name === 'pb.obs.dropped')).toBe(true);
    obs.histogram('pb.x', -5);
    expect(records.at(-1)).toMatchObject({ kind: 'histogram', value: -5 });
  });

  it('never accepts a caller route', () => {
    const { sink, records } = collector();
    createObservability(sink, scope({ route: '/p/{id}' }), REGISTRY).log({
      level: 'info',
      event: 'e',
      route: '/pb_live_x/dist',
    });
    createObservability(sink, scope(), REGISTRY).log({
      level: 'info',
      event: 'e',
      route: '/pb_live_x/dist',
    });
    expect(JSON.stringify(records)).not.toContain('pb_live_x');
    expect(logs(records)[0]?.route).toBe('/p/{id}');
    expect(logs(records)[1]).not.toHaveProperty('route');
  });

  it('drops unregistered events and reason codes', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope(), REGISTRY);
    obs.log({ level: 'info', event: 'abc123secretlookingcode' });
    obs.log({ level: 'warn', event: 'e', reason_code: 'xk29alphanumericsecret' });
    obs.log({ level: 'warn', event: 'e', reason_code: 'denied' });
    expect(logs(records)).toHaveLength(1);
    expect(logs(records)[0]?.reason_code).toBe('denied');
    const unregistered = {
      kind: 'counter',
      name: 'pb.obs.dropped',
      labels: { signal: 'unregistered' },
      value: 1,
    };
    expect(records.filter((r) => r.kind === 'counter')).toEqual([unregistered, unregistered]);
    expect(JSON.stringify(records)).not.toContain('secretlooking');
    expect(JSON.stringify(records)).not.toContain('alphanumericsecret');
  });

  it('accepts adapter and provider labels with bounded values', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope(), REGISTRY);
    obs.counter('pb.cache.operations', { adapter: 'cache-api', provider: 'npm_js' });
    obs.counter('pb.cache.operations', { adapter: 'Has Space' });
    obs.counter('pb.cache.operations', { provider: 'x'.repeat(33) });
    expect(records[0]).toMatchObject({ labels: { adapter: 'cache-api', provider: 'npm_js' } });
    expect(records.slice(1).every((r) => r.kind === 'counter' && r.name === 'pb.obs.dropped')).toBe(
      true,
    );
  });

  it('accepts a metric route label only when it is a declared route template', () => {
    const { sink, records } = collector();
    const obs = createObservability(sink, scope({ route: '/other' }), REGISTRY);
    obs.counter('pb.ok', { route: '/other' });
    obs.counter('pb.ok', { route: '/p/{id}' });
    obs.counter('pb.ok', { outcome: '01arz3ndektsv4rrffq69g5fav' });
    expect(records.map((r) => (r.kind === 'counter' ? r.name : r.kind))).toEqual([
      'pb.obs.dropped',
      'pb.ok',
      'pb.obs.dropped',
    ]);
  });

  it('uses a frozen snapshot of the scope', () => {
    const { sink, records } = collector();
    const mutable = { ...scope({ route: '/p/{id}' }) } as {
      -readonly [K in keyof ObservabilityScope]: ObservabilityScope[K];
    };
    const obs = createObservability(sink, mutable, REGISTRY);
    mutable.route = '/other';
    mutable.deploymentId = 'evil';
    mutable.plugin = 'evil';
    obs.log({ level: 'info', event: 'e' });
    obs.counter('pb.ok', { route: '/other' });
    obs.counter('pb.ok', { route: '/p/{id}' });
    expect(logs(records)[0]).toMatchObject({ route: '/p/{id}', deployment_id: 'dep-1' });
    expect(logs(records)[0]).not.toHaveProperty('plugin');
    expect(records.filter((r) => r.kind === 'counter').map((r) => r.name)).toEqual([
      'pb.obs.dropped',
      'pb.ok',
    ]);
  });

  it('throws RangeError for an undefined plugin id', () => {
    const { sink } = collector();
    expect(() => forPlugin(sink, scope(), undefined as never, REGISTRY)).toThrow(RangeError);
  });

  it('throws RangeError on an invalid scope or plugin id', () => {
    const { sink } = collector();
    const bad = [
      scope({ deploymentId: 'bad id!' }),
      scope({ runtime: 'deno' as never }),
      scope({ requestId: 'nope' }),
      scope({ traceId: 'zz' }),
      scope({ plugin: null as never }),
      scope({ plugin: [] as never }),
    ];
    for (const s of bad) {
      expect(() => createObservability(sink, s, REGISTRY)).toThrow(RangeError);
    }
    let called = 0;
    const evil = {
      toString() {
        called += 1;
        return 'acme';
      },
    };
    expect(() => forPlugin(sink, scope(), evil as never, REGISTRY)).toThrow(RangeError);
    expect(called).toBe(0);
  });

  it('survives a throwing backend', () => {
    const obs = createObservability(
      {
        emit() {
          throw new Error(SECRET);
        },
      },
      scope(),
      REGISTRY,
    );
    expect(() => {
      obs.log({ level: 'info', event: 'e' });
      obs.counter('pb.x');
      obs.histogram('pb.x', 1);
    }).not.toThrow();
  });

  it('has no message method and no caller-supplied plugin id on the port', () => {
    const { sink } = collector();
    const obs: Observability = createObservability(sink, scope(), REGISTRY);
    // @ts-expect-error the port has no free-form message method
    expect(obs.message).toBeUndefined();
    expect('message' in obs).toBe(false);
    expect('forPlugin' in obs).toBe(false);
    expect(Object.isFrozen(obs)).toBe(true);
  });
});

describe('noopObservability', () => {
  it('accepts every call and does nothing', () => {
    expect(() => {
      noopObservability.log({ level: 'info', event: 'e' });
      noopObservability.counter('pb.x');
      noopObservability.histogram('pb.x', 1);
    }).not.toThrow();
  });
});

const KERNEL_ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
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
  'KernelConfigError',
  'SecretsConfigError',
  'DbError',
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
];

describe('approved error names', () => {
  it.each(KERNEL_ERROR_NAMES)('keeps the kernel name %s through safeRecord', (name) => {
    expect(safeRecord({ level: 'error', event: 'e', error_name: name })?.error_name).toBe(name);
  });

  it.each(['BlobRangeError', 'StaleFenceError', 'PlatformUnavailableError', 'UnknownJobType'])(
    'keeps the pre-existing name %s',
    (name) => {
      expect(APPROVED_ERROR_NAMES).toContain(name);
    },
  );

  it('maps a name in neither list to Error', () => {
    expect(
      safeRecord({ level: 'error', event: 'e', error_name: 'NotAKernelError' })?.error_name,
    ).toBe('Error');
  });

  it('has no duplicate names', () => {
    expect(new Set(APPROVED_ERROR_NAMES).size).toBe(APPROVED_ERROR_NAMES.length);
  });
});

describe('HTTP_REQUEST_EVENT', () => {
  it('is the http.request event and a valid code', () => {
    expect(HTTP_REQUEST_EVENT).toBe('http.request');
    expect(HTTP_REQUEST_EVENT).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
    expect(safeRecord({ level: 'info', event: HTTP_REQUEST_EVENT })?.event).toBe('http.request');
  });
});

describe('LOG_FIELDS', () => {
  it('covers exactly the keys of SafeLogRecord', () => {
    expectTypeOf<(typeof LOG_FIELDS)[number]>().toEqualTypeOf<keyof SafeLogRecord>();
    const missing: readonly (keyof SafeLogRecord)[] = LOG_FIELDS;
    expect(missing).toHaveLength(42);
    expect(new Set(LOG_FIELDS).size).toBe(LOG_FIELDS.length);
  });

  it('rejects a list that omits a key or adds an extra entry', () => {
    type Exhaustive<T extends readonly (keyof SafeLogRecord)[]> = [
      Exclude<keyof SafeLogRecord, T[number]>,
    ] extends [never]
      ? T
      : never;
    expectTypeOf<Exhaustive<typeof LOG_FIELDS>>().toEqualTypeOf<typeof LOG_FIELDS>();
    expectTypeOf<Exhaustive<readonly ['level']>>().toEqualTypeOf<never>();
    // @ts-expect-error an entry that is not a SafeLogRecord key
    const extra: readonly (keyof SafeLogRecord)[] = [...LOG_FIELDS, 'message'];
    expect(extra).toContain('message');
  });
});

describe('projectLogFields', () => {
  it('drops unknown keys and undefined values', () => {
    expect(
      projectLogFields({
        level: 'info',
        event: 'a.b',
        message: 'x',
        email: 'e',
        status: undefined,
      }),
    ).toEqual({ level: 'info', event: 'a.b' });
  });

  it('does not invoke getters', () => {
    let called = false;
    const record = {
      level: 'info',
      get event(): string {
        called = true;
        return 'a.b';
      },
    };
    expect(projectLogFields(record)).toEqual({ level: 'info' });
    expect(called).toBe(false);
  });

  it('ignores inherited properties', () => {
    const record = Object.create({ event: 'a.b' }, { level: { value: 'info', enumerable: true } });
    expect(projectLogFields(record as object)).toEqual({ level: 'info' });
  });

  it('orders keys by LOG_FIELDS', () => {
    const out = projectLogFields({ reason_code: 'r', event: 'a.b', level: 'info' });
    expect(Object.keys(out)).toEqual(['level', 'event', 'reason_code']);
  });
});

describe('dropped signal vocabulary', () => {
  it('accepts every dropped signal as a label value', () => {
    expect([...DROPPED_SIGNALS]).toEqual([
      'log',
      'counter',
      'histogram',
      'unregistered',
      'cardinality',
      'kind_conflict',
      'export',
    ]);
    for (const signal of DROPPED_SIGNALS) {
      expect(metricLabelValueAllowed('signal', signal, new Set())).toBe(true);
    }
    expect(metricLabelValueAllowed('signal', 'logs ', new Set())).toBe(false);
  });
});

describe('audit verifier fields', () => {
  it('preserves valid verifier fields', () => {
    const fields = {
      head_seq: 0,
      seq: Number.MAX_SAFE_INTEGER,
      rows: 1200,
      head_hash: 'a'.repeat(64),
      reason: 'hash',
    };
    expect(safeRecord({ level: 'info', event: 'audit.verified', ...fields })).toEqual({
      level: 'info',
      event: 'audit.verified',
      ...fields,
    });
    for (const reason of ['seq_gap', 'prev_hash', 'hash', 'org_mismatch']) {
      expect(safeRecord({ level: 'error', event: 'audit.chain_broken', reason })).toHaveProperty(
        'reason',
        reason,
      );
    }
  });

  it.each(['head_seq', 'seq', 'rows'])('drops invalid %s', (field) => {
    for (const value of [
      '1',
      -1,
      0.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      {},
    ]) {
      expect(safeRecord({ level: 'info', event: 'audit.verified', [field]: value })).toEqual({
        level: 'info',
        event: 'audit.verified',
      });
    }
  });

  it('drops invalid head_hash', () => {
    for (const head_hash of [
      1,
      null,
      {},
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
    ]) {
      expect(safeRecord({ level: 'info', event: 'audit.verified', head_hash })).toEqual({
        level: 'info',
        event: 'audit.verified',
      });
    }
  });

  it('drops invalid reason', () => {
    for (const reason of [1, null, {}, 'unregistered', 'HASH']) {
      expect(safeRecord({ level: 'error', event: 'audit.chain_broken', reason })).toEqual({
        level: 'error',
        event: 'audit.chain_broken',
      });
    }
  });
});

describe('fixed vulnerability observability registration', () => {
  it('accepts every registered outcome with bounded feature metrics', async () => {
    const { VULNERABILITY_EVENT, VULNERABILITY_REASON_CODES, VULNERABILITY_METRICS } =
      await import('./observability.js');
    const { sink, records } = collector();
    const obs = createObservability(sink, scope(), {
      events: new Set([VULNERABILITY_EVENT]),
      reasonCodes: new Set(VULNERABILITY_REASON_CODES),
      routeTemplates: new Set(),
    });
    for (const reason_code of VULNERABILITY_REASON_CODES) {
      obs.log({ level: 'info', event: VULNERABILITY_EVENT, reason_code });
      obs.counter(
        VULNERABILITY_METRICS.versions,
        { outcome: reason_code.slice('vulnerability.'.length) },
        1,
      );
    }
    obs.histogram(VULNERABILITY_METRICS.duration, 4000);
    obs.counter(VULNERABILITY_METRICS.bytes, undefined, 100);
    expect(records.filter((row) => row.kind === 'log')).toHaveLength(
      VULNERABILITY_REASON_CODES.length,
    );
    expect(records.some((row) => row.kind === 'counter' && row.name === 'pb.obs.dropped')).toBe(
      false,
    );
  });
});

describe('log level filtering', () => {
  it.each([
    [undefined, ['info', 'warn', 'error']],
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ] as const)('filters logs at %s while preserving metrics', (level, expected) => {
    const { sink, records } = collector();
    const filtered = filterLogLevel(sink, level);
    for (const entry of ['debug', 'info', 'warn', 'error'] as const)
      filtered.emit({ kind: 'log', record: { level: entry, event: 'upstream.refused' } });
    const counter: ObsRecord = {
      kind: 'counter',
      name: 'pb.upstream.requests',
      labels: { outcome: 'refused' },
      value: 1,
    };
    const histogram: ObsRecord = {
      kind: 'histogram',
      name: 'pb.upstream.duration_ms',
      labels: { outcome: 'refused' },
      value: 2,
    };
    filtered.emit(counter);
    filtered.emit(histogram);
    expect(logs(records).map((record) => record['level'])).toEqual(expected);
    expect(records.filter((record) => record.kind !== 'log')).toEqual([counter, histogram]);
  });
});
