import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createObservability, forPlugin } from '@package-broker/core/platform/observability';
import type {
  ObsRecord,
  ObsRecordSink,
  ObservabilityScope,
  SafeLogRecord,
} from '@package-broker/core/platform/observability';
import {
  CONTRACT_REGISTRY,
  describeObservabilityContract,
} from '@package-broker/db-sqlite/contract/observability-contract';
import type { ObservabilityContractFixture } from '@package-broker/db-sqlite/contract/observability-contract';
import { createWorkersSink } from './workers.js';
import type { AnalyticsEngineLike } from './workers.js';

const SCOPE: ObservabilityScope = {
  deploymentId: 'dep-contract',
  runtime: 'cloudflare',
  requestId: '0b8f3a3e-8d0c-4a52-9c1c-2f6f1b3a9e11',
  projectId: 'proj_scoped',
  tokenId: 'tok_scoped',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  jobId: 'job_scoped',
  attempt: 2,
};

function compiled(url: URL, rewrites: Record<string, string>): string {
  let code = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'));
  for (const [from, to] of Object.entries(rewrites)) code = code.replaceAll(from, to);
  return code;
}

const WORKER_ENTRY = `
import { createWorkersSink } from './workers.js';
export default {
  async fetch(request, env) {
    const { deploymentId, record } = await request.json();
    const events = [];
    const capture = (stream) => (value) =>
      void events.push({ type: 'console', stream, frozen: Object.isFrozen(value), value });
    const sink = createWorkersSink({
      deploymentId,
      analytics: {
        writeDataPoint(point) {
          env.PB_OBS.writeDataPoint(point);
          events.push({ type: 'point', point });
        },
      },
      console: { log: capture('log'), error: capture('error') },
    });
    sink.emit(record);
    return Response.json(events);
  },
};
`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'entry.js', contents: WORKER_ENTRY },
      {
        type: 'ESModule',
        path: 'workers.js',
        contents: compiled(new URL('./workers.ts', import.meta.url), {
          '@package-broker/core/platform/observability': './observability.js',
        }),
      },
      {
        type: 'ESModule',
        path: 'observability.js',
        contents: compiled(
          new URL('../../../core/src/platform/observability.ts', import.meta.url),
          {},
        ),
      },
    ],
    compatibilityDate: '2026-10-01',
    analyticsEngineDatasets: { PB_OBS: { dataset: 'pb_obs' } },
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

type WorkerEvent =
  | { type: 'console'; stream: 'log' | 'error'; frozen: boolean; value: unknown }
  | { type: 'point'; point: Point };

const FORWARD = `
let body = '';
process.stdin.on('data', (chunk) => (body += chunk)).on('end', async () => {
  const response = await fetch(process.argv[1], { method: 'POST', body });
  process.stdout.write(await response.text());
});
`;

function runInWorker(url: URL, deploymentId: string, record: ObsRecord): WorkerEvent[] {
  const result = spawnSync(process.execPath, ['-e', FORWARD, url.href], {
    input: JSON.stringify({ deploymentId, record }),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Miniflare forward failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as WorkerEvent[];
}

type Point = Parameters<AnalyticsEngineLike['writeDataPoint']>[0];

function logRecord(value: unknown): ObsRecord {
  return {
    kind: 'log',
    record: value as SafeLogRecord,
  };
}

it('preserves the captured console object and its actual frozen state', () => {
  for (const value of [{ level: 'info' }, Object.freeze({ level: 'info' })]) {
    const captured = logRecord(value);
    expect(captured.kind === 'log' && captured.record).toBe(value);
    expect(captured.kind === 'log' && Object.isFrozen(captured.record)).toBe(
      Object.isFrozen(value),
    );
  }
});

it('contract case 7: the Workers sink console output is frozen', () => {
  const records: ObsRecord[] = [];
  const capture = (value: unknown) => void records.push(logRecord(value));
  const sink = createWorkersSink({
    deploymentId: SCOPE.deploymentId,
    analytics: { writeDataPoint: () => undefined },
    console: { log: capture, error: capture },
  });
  createObservability(sink, SCOPE, CONTRACT_REGISTRY).log({
    level: 'info',
    event: 'contract.probe',
  });
  const emitted = records[0];
  expect(emitted?.kind === 'log' && Object.isFrozen(emitted.record)).toBe(true);
});

function pointRecord(point: Point): ObsRecord {
  const [name, , kind, tuple] = (point.blobs ?? []).map((blob) => blob ?? '');
  const labels: Record<string, string> = {};
  for (const pair of tuple === undefined || tuple === '' ? [] : tuple.split(',')) {
    const at = pair.indexOf('=');
    labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return {
    kind: kind === 'histogram' ? 'histogram' : 'counter',
    name: name ?? '',
    labels,
    value: point.doubles?.[0] ?? Number.NaN,
  };
}

function eventRecord(event: WorkerEvent): ObsRecord {
  if (event.type === 'point') return pointRecord(event.point);
  const value = event.frozen ? Object.freeze(event.value) : event.value;
  return logRecord(value);
}

function fixture(scoped: boolean): () => Promise<ObservabilityContractFixture> {
  return async () => {
    const url = await mf.ready;
    const records: ObsRecord[] = [];
    const sink: ObsRecordSink = {
      emit(record) {
        for (const event of runInWorker(url, SCOPE.deploymentId, record)) {
          records.push(eventRecord(event));
        }
      },
    };
    const scope = scoped ? { ...SCOPE, plugin: 'contract-plugin' } : SCOPE;
    return {
      observability: scoped
        ? forPlugin(sink, SCOPE, 'contract-plugin', CONTRACT_REGISTRY)
        : createObservability(sink, SCOPE, CONTRACT_REGISTRY),
      scope,
      records: () => records,
    };
  };
}

describeObservabilityContract('runtime-cloudflare Workers sink', fixture(false));
describeObservabilityContract('runtime-cloudflare Workers sink (forPlugin)', fixture(true));
