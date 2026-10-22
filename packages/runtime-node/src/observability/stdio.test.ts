import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObsRecord } from '@package-broker/core/platform/observability';
import { createStdioSink, type StdioStream } from './stdio.js';

const logRecord = (level: 'info' | 'warn' | 'error'): ObsRecord => ({
  kind: 'log',
  record: { level, event: 'req.done', deployment_id: 'dep-1', runtime: 'node', request_id: null },
});

const fakeStream = (): StdioStream & { lines: string[]; emitter: EventEmitter } => {
  const emitter = new EventEmitter();
  const lines: string[] = [];
  return {
    lines,
    emitter,
    write: (chunk) => void lines.push(chunk),
    on: (event, listener) => void emitter.on(event, listener),
  };
};

const expectMinifiedLine = (text: string): Record<string, unknown> => {
  expect(text.endsWith('\n')).toBe(true);
  expect(text.slice(0, -1)).not.toContain('\n');
  expect(text.slice(0, -1)).toBe(JSON.stringify(JSON.parse(text)));
  return JSON.parse(text) as Record<string, unknown>;
};

afterEach(() => vi.restoreAllMocks());

describe('createStdioSink', () => {
  it('writes info and metrics to stdout as one JSON line each', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sink = createStdioSink({ deploymentId: 'dep-1' });
    sink.emit(logRecord('info'));
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: { method: 'GET' }, value: 2 });
    sink.emit({ kind: 'histogram', name: 'pb.http.duration_ms', labels: {}, value: 1.5 });
    expect(err).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledTimes(3);
    for (const [chunk] of out.mock.calls) expectMinifiedLine(String(chunk));
    const metric = expectMinifiedLine(String(out.mock.calls[1]![0]));
    expect(typeof metric.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(String(metric.timestamp)))).toBe(false);
    delete metric.timestamp;
    expect(metric).toEqual({
      kind: 'counter',
      name: 'pb.http.requests',
      labels: { method: 'GET' },
      value: 2,
      deployment_id: 'dep-1',
      runtime: 'node',
    });
  });

  it('writes warn and error to stderr only, as minified projected lines', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sink = createStdioSink({ deploymentId: 'dep-1' });
    sink.emit(logRecord('warn'));
    sink.emit({
      kind: 'log',
      record: { level: 'error', event: 'req.done', password: 'x' },
    } as unknown as ObsRecord);
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    expect(expectMinifiedLine(String(err.mock.calls[0]![0]))).toEqual({
      level: 'warn',
      event: 'req.done',
      deployment_id: 'dep-1',
      runtime: 'node',
      request_id: null,
    });
    expect(expectMinifiedLine(String(err.mock.calls[1]![0]))).toEqual({
      level: 'error',
      event: 'req.done',
    });
  });

  it('never re-serializes unknown fields', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const sink = createStdioSink({ deploymentId: 'dep-1' });
    sink.emit({
      kind: 'log',
      record: { level: 'info', event: 'req.done', password: 'x', nested: { a: 1 } },
    } as unknown as ObsRecord);
    expect(expectMinifiedLine(String(out.mock.calls[0]![0]))).toEqual({
      level: 'info',
      event: 'req.done',
    });
  });

  it('ignores getter-backed fields', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const sink = createStdioSink({ deploymentId: 'dep-1' });
    const record = { level: 'info', event: 'req.done' };
    Object.defineProperty(record, 'route', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    sink.emit({ kind: 'log', record } as unknown as ObsRecord);
    expect(expectMinifiedLine(String(out.mock.calls[0]![0]))).toEqual({
      level: 'info',
      event: 'req.done',
    });
  });

  it('swallows a stream error and stops writing to that stream only', () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const sink = createStdioSink({ deploymentId: 'dep-1', stdout, stderr });
    sink.emit(logRecord('info'));
    expect(stdout.lines).toHaveLength(1);
    expect(stdout.emitter.listenerCount('error')).toBe(1);
    expect(() => stdout.emitter.emit('error', new Error('EPIPE'))).not.toThrow();
    sink.emit(logRecord('info'));
    sink.emit({ kind: 'counter', name: 'pb.http.requests', labels: {}, value: 1 });
    expect(stdout.lines).toHaveLength(1);
    sink.emit(logRecord('error'));
    expect(stderr.lines).toHaveLength(1);
  });

  it('stops writing when write throws', () => {
    const stdout = fakeStream();
    let calls = 0;
    stdout.write = () => {
      calls += 1;
      throw new Error('boom');
    };
    const sink = createStdioSink({ deploymentId: 'dep-1', stdout });
    expect(() => sink.emit(logRecord('info'))).not.toThrow();
    sink.emit(logRecord('info'));
    expect(calls).toBe(1);
  });

  it('rejects an invalid deployment id at construction', () => {
    for (const bad of ['', 'a b', 'x'.repeat(65), 'a/b', 'a\n']) {
      expect(() => createStdioSink({ deploymentId: bad })).toThrow(RangeError);
    }
    expect(() => createStdioSink({ deploymentId: 'dep_1.a-b' })).not.toThrow();
  });
});

describe('createStdioSink field allowlist', () => {
  it('keeps the package key and opaque source id', () => {
    const stderr = fakeStream();
    const sink = createStdioSink({ deploymentId: 'dep-1', stdout: fakeStream(), stderr });
    const record = {
      level: 'warn',
      event: 'ingest.budget_exhausted',
      package_key: 'vendor/name',
      source_id: '01JA0000000000000000000000',
    } as const;
    sink.emit({ kind: 'log', record });
    expect(JSON.parse(stderr.lines.join(''))).toEqual(record);
  });

  it('drops fields outside the shared allowlist', () => {
    const stdout = fakeStream();
    const sink = createStdioSink({ deploymentId: 'dep-1', stdout, stderr: fakeStream() });
    sink.emit({
      kind: 'log',
      record: { level: 'info', event: 'req.done', message: 'secret text', email: 'a@b.c' },
    } as ObsRecord);
    const line = stdout.lines.join('');
    expect(line).not.toContain('message');
    expect(line).not.toContain('email');
    expect(line).toContain('req.done');
  });
});
