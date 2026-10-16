import { afterEach, describe, expect, it, vi } from 'vitest';
import { createObservability, type ObsRecord } from '@package-broker/core/platform/observability';
import { AE_BLOB_BUDGET_BYTES, createWorkersSink, type AnalyticsEngineLike } from './workers.js';

const logRecord = (level: 'info' | 'warn' | 'error'): ObsRecord => ({
  kind: 'log',
  record: { level, event: 'req.done', deployment_id: 'dep-1', runtime: 'node', request_id: null },
});

afterEach(() => vi.restoreAllMocks());

type Point = Parameters<AnalyticsEngineLike['writeDataPoint']>[0];

const setup = (withAnalytics = true, write?: (p: Point) => void) => {
  const points: Point[] = [];
  const logs: unknown[] = [];
  const errors: unknown[] = [];
  const sink = createWorkersSink({
    deploymentId: 'dep-1',
    ...(withAnalytics
      ? { analytics: { writeDataPoint: write ?? ((p: Point) => void points.push(p)) } }
      : {}),
    console: { log: (v) => void logs.push(v), error: (v) => void errors.push(v) },
  });
  return { sink, points, logs, errors };
};

describe('createWorkersSink', () => {
  it('writes counters to AE at fixed positions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const { sink, points, logs, errors } = setup();
    sink.emit({
      kind: 'counter',
      name: 'pb.http.requests',
      labels: { route: '/x', method: 'GET' },
      value: 3,
    });
    expect(points).toEqual([
      {
        indexes: ['dep-1'],
        blobs: ['pb.http.requests', 'cloudflare', 'counter', 'method=GET,route=/x'],
        doubles: [3, 1700000000000],
      },
    ]);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('writes histograms to AE with the kind in blob 2', () => {
    const { sink, points } = setup();
    sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', labels: {}, value: 9 });
    expect(points[0]!.blobs).toEqual(['pb.http.duration_ms', 'cloudflare', 'histogram', '']);
    expect(points[0]!.doubles![0]).toBe(9);
  });

  it('routes info to console.log and warn/error to console.error', () => {
    const { sink, logs, errors, points } = setup();
    sink.emit(logRecord('info'));
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(0);
    sink.emit(logRecord('warn'));
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    sink.emit(logRecord('error'));
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(points).toEqual([]);
  });

  it('never passes unknown fields to console', () => {
    const { sink, logs } = setup();
    sink.emit({
      kind: 'log',
      record: { level: 'info', event: 'req.done', password: 'x', nested: { a: 1 } },
    } as unknown as ObsRecord);
    expect(logs).toEqual([{ level: 'info', event: 'req.done' }]);
  });

  it('writes a point exactly at the blob budget and drops budget plus one', () => {
    const fixed = 'pb.x'.length + 'cloudflare'.length + 'counter'.length + 'route='.length;
    const label = (n: number) => ({ route: 'r'.repeat(n) });
    const exact = AE_BLOB_BUDGET_BYTES - fixed;
    const a = setup();
    a.sink.emit({ kind: 'counter', name: 'pb.x', labels: label(exact), value: 1 });
    expect(a.points).toHaveLength(1);
    expect(a.errors).toEqual([]);
    const b = setup();
    b.sink.emit({ kind: 'counter', name: 'pb.x', labels: label(exact + 1), value: 1 });
    expect(b.points).toEqual([]);
  });

  it('reports an over-budget drop with one fixed console.error line', () => {
    const { sink, points, errors } = setup();
    sink.emit({
      kind: 'counter',
      name: 'pb.http.requests',
      labels: { route: `/${'a'.repeat(AE_BLOB_BUDGET_BYTES)}` },
      value: 1,
    });
    expect(points).toEqual([]);
    expect(errors).toEqual([
      { event: 'pb.obs.export_failure', metric: 'pb.http.requests', reason: 'over_budget' },
    ]);
  });

  it('reports a writeDataPoint exception and does not throw', () => {
    const { sink, errors } = setup(true, () => {
      throw new Error('ae down');
    });
    expect(() =>
      sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 }),
    ).not.toThrow();
    expect(errors).toEqual([
      { event: 'pb.obs.export_failure', metric: 'pb.http.requests', reason: 'write_failed' },
    ]);
  });

  it('logs only, plus one startup configuration event, without ANALYTICS', () => {
    const { sink, points, logs, errors } = setup(false);
    expect(logs).toHaveLength(1);
    const startup = logs[0] as Record<string, unknown>;
    expect(Number.isNaN(Date.parse(String(startup.timestamp)))).toBe(false);
    delete startup.timestamp;
    expect(startup).toEqual({
      level: 'info',
      event: 'obs.analytics_unconfigured',
      request_id: null,
      service: 'package-broker',
      deployment_id: 'dep-1',
      runtime: 'cloudflare',
    });
    sink.emit(logRecord('info'));
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: { method: 'GET' }, value: 4 });
    expect(points).toEqual([]);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(3);
    const metric = logs[2] as Record<string, unknown>;
    expect(Number.isNaN(Date.parse(String(metric.timestamp)))).toBe(false);
    delete metric.timestamp;
    expect(metric).toEqual({
      kind: 'counter',
      name: 'pb.http.requests',
      labels: { method: 'GET' },
      value: 4,
      deployment_id: 'dep-1',
      runtime: 'cloudflare',
    });
  });

  it('emits no startup event when ANALYTICS exists', () => {
    const { logs, errors } = setup(true);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejects an invalid deployment id at construction', () => {
    for (const bad of ['', 'a b', 'x'.repeat(65), 'a/b']) {
      expect(() => createWorkersSink({ deploymentId: bad })).toThrow(RangeError);
    }
  });

  it('relies on core rejecting label text containing , or =', () => {
    const seen: ObsRecord[] = [];
    const scope = { deploymentId: 'dep-1', runtime: 'cloudflare' as const, requestId: null };
    const registry = {
      events: new Set<string>(),
      reasonCodes: new Set<string>(),
      routeTemplates: new Set<string>(),
    };
    const obs = createObservability({ emit: (r) => void seen.push(r) }, scope, registry);
    obs.counter('pb.x', { adapter: 'a,b' });
    obs.counter('pb.x', { adapter: 'a=b' });
    obs.counter('pb.x', { kind: 'a,b' });
    expect(seen.every((r) => r.kind === 'counter' && r.name === 'pb.obs.dropped')).toBe(true);
    expect(seen).toHaveLength(3);
    expect(() =>
      createObservability({ emit: () => undefined }, { ...scope, route: '/a,b' }, registry),
    ).toThrow(RangeError);
    expect(() =>
      createObservability({ emit: () => undefined }, { ...scope, route: '/a=b' }, registry),
    ).toThrow(RangeError);
  });
});
