import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DROPPED_COUNTER,
  HTTP_REQUEST_EVENT,
  type ObsRecord,
  type ObsRegistry,
  type SafeLogRecord,
} from '../platform/observability.js';
import { ENGINE_PLUGIN, INPUT_PLUGIN } from './authorize.js';
import { KERNEL_EVENTS, KERNEL_REASON_CODES, type KernelReasonCode } from './obs-codes.js';
import {
  type KernelObsContext,
  createCompletionGuard,
  createHttpMetrics,
  createRequestScope,
  logSink,
} from './request-scope.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT_SPAN}-01`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const registry: ObsRegistry = {
  events: KERNEL_EVENTS,
  reasonCodes: KERNEL_REASON_CODES,
  routeTemplates: new Set(['/p/{name}', '/health/live', '/health/ready']),
};

function setup(trust = false) {
  const records: ObsRecord[] = [];
  const ctx: KernelObsContext = {
    sink: { emit: (record) => records.push(record) },
    registry,
    deploymentId: 'dep-1',
    runtime: 'node',
    trustInboundTraceparent: trust,
  };
  const logs = (): SafeLogRecord[] => records.flatMap((r) => (r.kind === 'log' ? [r.record] : []));
  const metrics = (name: string): ObsRecord[] =>
    records.filter((r) => r.kind !== 'log' && r.name === name);
  return { ctx, records, logs, metrics, http: createHttpMetrics(ctx) };
}

function request(method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request('https://broker.test/p/x', { method, headers });
}

function counts(s: ReturnType<typeof setup>) {
  return {
    log: s.logs().filter((r) => r.event === HTTP_REQUEST_EVENT).length,
    counter: s.metrics('pb.http.requests').length,
    histogram: s.metrics('pb.http.duration_ms').length,
  };
}

describe('completion guard exactly once', () => {
  it('completing twice emits one record, one counter, one histogram', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    const guard = createCompletionGuard(scope, s.http);
    guard.complete(200);
    guard.complete(500);
    expect(counts(s)).toEqual({ log: 1, counter: 1, histogram: 1 });
    expect(s.logs()[0]).toMatchObject({ level: 'info', status: 200 });
  });

  it('completing after an abort does nothing more', () => {
    const s = setup();
    const controller = new AbortController();
    const scope = createRequestScope(s.ctx, request());
    const guard = createCompletionGuard(scope, s.http, controller.signal);
    controller.abort();
    guard.complete(200);
    expect(counts(s)).toEqual({ log: 1, counter: 1, histogram: 1 });
  });

  it('aborting after completion does nothing more', () => {
    const s = setup();
    const controller = new AbortController();
    const scope = createRequestScope(s.ctx, request());
    const guard = createCompletionGuard(scope, s.http, controller.signal);
    guard.complete(200);
    controller.abort();
    expect(counts(s)).toEqual({ log: 1, counter: 1, histogram: 1 });
    expect(s.logs()[0]).toMatchObject({ status: 200, level: 'info' });
  });

  it('an already aborted signal completes as aborted at once', () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    const guard = createCompletionGuard(
      createRequestScope(s.ctx, request()),
      s.http,
      controller.signal,
    );
    guard.complete(200);
    expect(counts(s)).toEqual({ log: 1, counter: 1, histogram: 1 });
    expect(s.logs()[0]?.reason_code).toBe('request.aborted');
  });
});

describe('abort', () => {
  it('emits warn, no status, request.aborted; listener added once and removed', () => {
    const s = setup();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const scope = createRequestScope(s.ctx, request());
    const guard = createCompletionGuard(scope, s.http, controller.signal);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toBe('abort');
    expect(add.mock.calls[0]?.[2]).toEqual({ once: true });
    controller.abort();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    guard.complete(200);
    const [record] = s.logs();
    expect(record).toMatchObject({
      level: 'warn',
      event: HTTP_REQUEST_EVENT,
      reason_code: 'request.aborted',
    });
    expect(record).not.toHaveProperty('status');
    expect(s.metrics('pb.http.requests')[0]).toMatchObject({
      labels: { method: 'GET', outcome: 'aborted' },
    });
  });

  it('removes the listener on normal completion', () => {
    const s = setup();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const guard = createCompletionGuard(
      createRequestScope(s.ctx, request()),
      s.http,
      controller.signal,
    );
    guard.complete(204);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });
});

describe('health completion levels', () => {
  it.each([
    ['/health/live', 200, 'debug'],
    ['/health/ready', 200, 'debug'],
    ['/health/ready', 204, 'debug'],
    ['/health/ready', 199, 'warn'],
    ['/health/ready', 302, 'warn'],
    ['/health/ready', 404, 'warn'],
    ['/health/ready', 503, 'warn'],
  ] as const)('%s status %d logs at %s', (route, status, level) => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    const guard = createCompletionGuard(scope, s.http);
    scope.set({ route });
    guard.complete(status);
    expect(s.logs()[0]).toMatchObject({ level, route, status });
    expect(s.metrics('pb.http.requests')[0]).toMatchObject({
      labels: { route, status_class: `${String(status)[0]}xx` },
    });
  });

  it('an aborted health request logs at warn with request.aborted', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    const controller = new AbortController();
    createCompletionGuard(scope, s.http, controller.signal);
    scope.set({ route: '/health/ready' });
    controller.abort();
    expect(s.logs()[0]).toMatchObject({ level: 'warn', reason_code: 'request.aborted' });
    expect(s.logs()[0]).not.toHaveProperty('status');
    expect(s.metrics('pb.http.requests')[0]).toMatchObject({
      labels: { route: '/health/ready', outcome: 'aborted' },
    });
  });

  it('an invalid health status stays at error', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    scope.set({ route: '/health/ready' });
    createCompletionGuard(scope, s.http).complete(600);
    expect(s.logs()[0]).toMatchObject({ level: 'error' });
    expect(s.logs()[0]).not.toHaveProperty('status');
  });
});

describe('level and duration', () => {
  it.each([
    [500, 'error'],
    [503, 'error'],
    [404, 'info'],
    [200, 'info'],
  ] as const)('status %d logs at %s', (status, level) => {
    const s = setup();
    createCompletionGuard(createRequestScope(s.ctx, request()), s.http).complete(status);
    expect(s.logs()[0]).toMatchObject({ level, status });
    expect(s.metrics('pb.http.requests')[0]).toMatchObject({
      labels: { status_class: `${String(status)[0]}xx` },
    });
  });

  it('duration is a non-negative integer from the clock', () => {
    const s = setup();
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1042);
    createCompletionGuard(createRequestScope(s.ctx, request(), now), s.http).complete(200);
    expect(s.logs()[0]?.duration_ms).toBe(42);
    expect(s.metrics('pb.http.duration_ms')[0]).toMatchObject({ value: 42 });
  });

  it('duration is floored at 0 when the clock goes backwards', () => {
    const s = setup();
    const now = vi.fn().mockReturnValueOnce(5000).mockReturnValueOnce(4000);
    createCompletionGuard(createRequestScope(s.ctx, request(), now), s.http).complete(200);
    expect(s.logs()[0]?.duration_ms).toBe(0);
  });

  it('duration is measured from scope creation, not guard creation', () => {
    const s = setup();
    let clock = 1000;
    const scope = createRequestScope(s.ctx, request(), () => clock);
    clock = 1030;
    const guard = createCompletionGuard(scope, s.http);
    clock = 1050;
    guard.complete(200);
    expect(s.logs()[0]?.duration_ms).toBe(50);
  });

  it.each([0, 99, 600, 200.5, Number.NaN])(
    'status %s logs at error with outcome invalid_status and no status',
    (status) => {
      const s = setup();
      const guard = createCompletionGuard(createRequestScope(s.ctx, request()), s.http);
      guard.complete(status);
      guard.complete(status);
      const [record] = s.logs();
      expect(record).toMatchObject({ level: 'error', event: HTTP_REQUEST_EVENT });
      expect(record).not.toHaveProperty('status');
      expect(counts(s)).toEqual({ log: 1, counter: 1, histogram: 1 });
      expect(s.metrics('pb.http.requests')[0]).toMatchObject({
        labels: { method: 'GET', outcome: 'invalid_status' },
      });
      expect(s.metrics('pb.http.requests')[0]).not.toHaveProperty('labels.status_class');
    },
  );

  it.each([200, 204, 302])('a %d completion carries no reason_code', (status) => {
    const s = setup();
    const guard = createCompletionGuard(createRequestScope(s.ctx, request()), s.http);
    guard.reason('hook.denied');
    guard.complete(status);
    expect(s.logs()[0]).not.toHaveProperty('reason_code');
    expect(s.logs()[0]).toMatchObject({ status });
  });

  it('carries the most specific reason code set before completion', () => {
    const s = setup();
    const guard = createCompletionGuard(createRequestScope(s.ctx, request()), s.http);
    guard.reason('hook.denied');
    guard.reason('authz.forbidden');
    guard.complete(403);
    expect(s.logs()[0]).toMatchObject({ reason_code: 'hook.denied', status: 403 });
  });

  it('includes scope fields in the completion record', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request('POST'));
    scope.set({ route: '/p/{name}', projectId: 'proj_1', tokenId: 'tok_1' });
    createCompletionGuard(scope, s.http).complete(201);
    const [record] = s.logs();
    expect(record).toMatchObject({
      request_id: scope.requestId,
      trace_id: scope.traceId,
      span_id: scope.spanId,
      method: 'POST',
      route: '/p/{name}',
      project_id: 'proj_1',
      token_id: 'tok_1',
      runtime: 'node',
      deployment_id: 'dep-1',
      service: 'package-broker',
    });
    expect(typeof record?.timestamp).toBe('string');
    expect(s.metrics('pb.http.requests')[0]).toMatchObject({
      labels: { method: 'POST', route: '/p/{name}', status_class: '2xx' },
    });
  });
});

describe('scope builder never throws', () => {
  it('leaves out a method outside the seven port methods', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request('PROPFIND'));
    createCompletionGuard(scope, s.http).complete(405);
    expect(s.logs()[0]).not.toHaveProperty('method');
    expect(s.logs()[0]).toMatchObject({ status: 405 });
    expect(s.metrics('pb.http.requests')[0]?.kind).toBe('counter');
  });

  it('leaves out a route outside the ROUTE pattern', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    expect(() => scope.set({ route: '/a~b' })).not.toThrow();
    createCompletionGuard(scope, s.http).complete(200);
    expect(s.logs()[0]).not.toHaveProperty('route');
    expect(s.metrics('pb.http.requests')[0]).not.toHaveProperty('labels.route');
  });

  it('drops a route that is not a registered template', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    scope.set({ route: '/other' });
    createCompletionGuard(scope, s.http).complete(200);
    expect(s.logs()[0]).not.toHaveProperty('route');
    expect(s.metrics('pb.http.requests')[0]).not.toHaveProperty('labels.route');
    expect(s.metrics(DROPPED_COUNTER)).toHaveLength(0);
  });

  it('nulls a projectId that fails ENTITY_ID and a bad tokenId', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    expect(() => scope.set({ projectId: 'bad id!', tokenId: 'x'.repeat(65) })).not.toThrow();
    createCompletionGuard(scope, s.http).complete(200);
    expect(s.logs()[0]).toMatchObject({ project_id: null, token_id: null });
  });

  it('maps plugin ids: invalid left out, kernel labels become core', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    const emit = (plugin: string): void => {
      scope
        .obs({ plugin })
        .log({ level: 'warn', event: 'authz.denied', reason_code: 'hook.denied' });
    };
    emit('Bad Plugin');
    emit(ENGINE_PLUGIN);
    emit(INPUT_PLUGIN);
    emit('acme.audit');
    const plugins = s.logs().map((r) => r.plugin);
    expect(plugins).toEqual([undefined, 'core', 'core', 'acme.audit']);
  });

  it('falls back to a no-op instance on a deployment id the port rejects', () => {
    const s = setup();
    const scope = createRequestScope({ ...s.ctx, deploymentId: 'bad id' }, request());
    expect(() => {
      scope.obs().log({ level: 'info', event: HTTP_REQUEST_EVENT });
      scope.obs().counter('pb.http.requests');
      scope.obs({ plugin: 'acme.audit' }).log({ level: 'warn', event: 'authz.denied' });
    }).not.toThrow();
    expect(s.records).toHaveLength(0);
  });
});

describe('scope.obs memoization', () => {
  it('returns the same instance until set and carries token_id only after set', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    const before = scope.obs();
    expect(scope.obs()).toBe(before);
    before.log({ level: 'warn', event: 'authz.denied', reason_code: 'authz.forbidden' });
    scope.set({ projectId: 'proj_1', tokenId: 'tok_1' });
    const after = scope.obs();
    expect(after).not.toBe(before);
    expect(scope.obs()).toBe(after);
    after.log({ level: 'warn', event: 'authz.denied', reason_code: 'hook.denied' });
    const [first, second] = s.logs();
    expect(first).toHaveProperty('token_id', null);
    expect(first).toHaveProperty('project_id', null);
    expect(second?.token_id).toBe('tok_1');
  });

  it('a request that never calls set logs token_id and project_id as null', () => {
    const s = setup();
    createCompletionGuard(createRequestScope(s.ctx, request()), s.http).complete(401);
    const [record] = s.logs();
    expect(record).toHaveProperty('token_id', null);
    expect(record).toHaveProperty('project_id', null);
  });

  it('mints a UUID request id and ignores an inbound x-request-id', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request('GET', { 'x-request-id': 'abc' }));
    expect(scope.requestId).toMatch(UUID);
    expect(createRequestScope(s.ctx, request()).requestId).not.toBe(scope.requestId);
  });
});

describe('traceparent', () => {
  it('with trust off never reads the inbound header', () => {
    const s = setup(false);
    const req = request('GET', { traceparent: TRACEPARENT });
    const get = vi.spyOn(req.headers, 'get');
    const scope = createRequestScope(s.ctx, req);
    expect(scope.traceId).not.toBe(TRACE);
    expect(get).not.toHaveBeenCalledWith('traceparent');
  });

  it('with trust on a valid header supplies the trace id and a new span id', () => {
    const s = setup(true);
    const scope = createRequestScope(s.ctx, request('GET', { traceparent: TRACEPARENT }));
    expect(scope.traceId).toBe(TRACE);
    expect(scope.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(scope.spanId).not.toBe(PARENT_SPAN);
  });

  it.each([
    `00-${'0'.repeat(32)}-${PARENT_SPAN}-01`,
    `00-${TRACE}-${'0'.repeat(16)}-01`,
    'garbage',
  ])('with trust on, %s starts a new trace', (header) => {
    const s = setup(true);
    const scope = createRequestScope(s.ctx, request('GET', { traceparent: header }));
    expect(scope.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(scope.traceId).not.toBe(TRACE);
    expect(scope.traceId).not.toBe('0'.repeat(32));
  });
});

describe('logSink', () => {
  it('forwards log records as SafeLogRecord and drops metrics', () => {
    const entries: Readonly<Record<string, unknown>>[] = [];
    const sink = logSink((entry) => entries.push(entry));
    const record: SafeLogRecord = { level: 'info', event: HTTP_REQUEST_EVENT, status: 200 };
    sink.emit({ kind: 'log', record });
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', labels: {}, value: 3 });
    expect(entries).toEqual([record]);
  });

  it('a kernel scope over logSink delivers sanitized records', () => {
    const entries: Readonly<Record<string, unknown>>[] = [];
    const ctx: KernelObsContext = {
      sink: logSink((entry) => entries.push(entry)),
      registry,
      deploymentId: 'dep-1',
      runtime: 'cloudflare',
    };
    const scope = createRequestScope(ctx, request());
    createCompletionGuard(scope, createHttpMetrics(ctx)).complete(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: HTTP_REQUEST_EVENT, request_id: scope.requestId });
  });

  it('kernel records produce no dropped counter', () => {
    const s = setup();
    const scope = createRequestScope(s.ctx, request());
    scope.set({ route: '/p/{name}', projectId: 'proj_1', tokenId: null });
    scope
      .obs()
      .log({ level: 'error', event: 'http.error', error_name: 'DbError', reason_code: 'db.busy' });
    scope.obs({ plugin: ENGINE_PLUGIN }).log({
      level: 'warn',
      event: 'authz.error',
      error_name: 'EngineTimeoutError',
      reason_code: 'authz.engine_error',
    });
    for (const code of KERNEL_REASON_CODES) {
      const guard = createCompletionGuard(scope, s.http);
      guard.reason(code as KernelReasonCode);
      guard.complete(code.startsWith('error.') || code.startsWith('db.') ? 500 : 403);
    }
    const controller = new AbortController();
    createCompletionGuard(scope, s.http, controller.signal);
    controller.abort();
    expect(s.metrics(DROPPED_COUNTER)).toHaveLength(0);
    const completions = s.logs().filter((r) => r.event === HTTP_REQUEST_EVENT);
    expect(completions.map((r) => r.reason_code)).toEqual([
      ...KERNEL_REASON_CODES,
      'request.aborted',
    ]);
    expect(s.logs()).toHaveLength(2 + KERNEL_REASON_CODES.size + 1);
  });
});

describe('module state', () => {
  it('two requests in sequence share no memo, reason or completion state', () => {
    const s = setup();
    const first = createRequestScope(s.ctx, request());
    first.set({ tokenId: 'tok_1' });
    const firstGuard = createCompletionGuard(first, s.http);
    firstGuard.reason('hook.denied');
    firstGuard.complete(403);

    const second = createRequestScope(s.ctx, request());
    expect(second.obs()).not.toBe(first.obs());
    const secondGuard = createCompletionGuard(second, s.http);
    secondGuard.complete(404);
    firstGuard.complete(500);

    const records = s.logs().filter((r) => r.event === HTTP_REQUEST_EVENT);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ request_id: first.requestId, token_id: 'tok_1' });
    expect(records[1]).toMatchObject({ request_id: second.requestId, token_id: null, status: 404 });
    expect(records[1]).not.toHaveProperty('reason_code');
  });

  it('does not use AsyncLocalStorage', () => {
    const source = readFileSync(new URL('./request-scope.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/AsyncLocalStorage/);
  });
});
