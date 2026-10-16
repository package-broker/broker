import { describe, expect, it } from 'vitest';
import { encodeLogs, encodeMetrics, encodeTraces } from '@package-broker/core/platform/otlp';
import type {
  ObsRecord,
  ObsRegistry,
  Observability,
  ObservabilityScope,
} from '@package-broker/core/platform/observability';

export interface ObservabilityContractFixture {
  readonly observability: Observability;
  readonly scope: ObservabilityScope;
  readonly records: () => readonly ObsRecord[];
}

export const CONTRACT_EVENT = 'contract.probe';
export const CONTRACT_REASON = 'contract_denied';
export const CONTRACT_ROUTE = '/contract/{id}';
export const CONTRACT_REGISTRY: ObsRegistry = {
  events: new Set([CONTRACT_EVENT]),
  reasonCodes: new Set([CONTRACT_REASON]),
  routeTemplates: new Set([CONTRACT_ROUTE]),
};

const SECRET = 'sk_live_CONTRACT-SECRET-4242';
const ALNUM_SECRET = 'SkLiveContractSecret4242';
const FORGED_ID = 'forged_id_9931';
const FORGED_UUID = '11111111-1111-4111-8111-111111111111';
const MAX_RECORD_BYTES = 8192;
const RESOURCE = { service: 'package-broker', deploymentId: 'dep-contract', runtime: 'node' };

type Make = () => Promise<ObservabilityContractFixture>;

function logsOf(records: readonly ObsRecord[]): Record<string, unknown>[] {
  return records.flatMap((r) => (r.kind === 'log' ? [{ ...r.record }] : []));
}

function serialized(records: readonly ObsRecord[]): string {
  return JSON.stringify(records);
}

function droppedSignals(records: readonly ObsRecord[]): string[] {
  return records.flatMap((r) =>
    r.kind === 'counter' && r.name === 'pb.obs.dropped' ? [r.labels.signal ?? ''] : [],
  );
}

export interface ObservabilityContractOptions {
  readonly unsupported?: readonly string[];
}

export function describeObservabilityContract(
  name: string,
  make: Make,
  options: ObservabilityContractOptions = {},
): void {
  const unsupported = new Set(options.unsupported);
  describe(`Observability contract: ${name}`, () => {
    it('1. drops an unknown field and keeps the allowlisted ones', async () => {
      const { observability, records } = await make();
      observability.log({
        level: 'info',
        event: CONTRACT_EVENT,
        status: 200,
        extra: SECRET,
        message: SECRET,
        headers: { authorization: SECRET },
      });

      const [record] = logsOf(records());
      expect(record).toMatchObject({ level: 'info', event: CONTRACT_EVENT, status: 200 });
      expect(record).not.toHaveProperty('extra');
      expect(record).not.toHaveProperty('message');
      expect(record).not.toHaveProperty('headers');
      expect(serialized(records())).not.toContain(SECRET);
    });

    it('2. never invokes a getter, on an allowlisted or an unknown field', async () => {
      const { observability, records } = await make();
      let calls = 0;
      const record: Record<string, unknown> = { level: 'info', event: CONTRACT_EVENT };
      for (const key of ['status', 'reason_code', 'extra']) {
        Object.defineProperty(record, key, {
          enumerable: true,
          get() {
            calls += 1;
            return SECRET;
          },
        });
      }
      observability.log(record as never);

      expect(calls).toBe(0);
      expect(serialized(records())).not.toContain(SECRET);
    });

    it('3. rejects a cyclic value without emitting it', async () => {
      const { observability, records } = await make();
      const cyclic: Record<string, unknown> = { secret: SECRET };
      cyclic.self = cyclic;
      expect(() =>
        observability.log({
          level: 'warn',
          event: CONTRACT_EVENT,
          status: 200,
          route: cyclic,
          extra: cyclic,
        } as never),
      ).not.toThrow();

      const [record] = logsOf(records());
      expect(record).not.toHaveProperty('route');
      expect(record).not.toHaveProperty('extra');
      expect(serialized(records())).not.toContain(SECRET);
    });

    it('4. drops a record whose inputs exceed 8 KiB instead of truncating it', async () => {
      const { observability, records } = await make();
      observability.log({
        level: 'info',
        event: CONTRACT_EVENT,
        route: `/${SECRET}${'a'.repeat(MAX_RECORD_BYTES + 1)}`,
      });

      expect(logsOf(records())).toHaveLength(0);
      expect(droppedSignals(records())).toContain('log');
      expect(serialized(records())).not.toContain(SECRET);
    });

    it('5. error_name is an approved name or Error, never a message or secret', async () => {
      const { observability, records } = await make();
      const named = new Error(SECRET, { cause: new Error(SECRET) });
      named.name = ALNUM_SECRET;
      observability.log({ level: 'error', event: CONTRACT_EVENT, error_name: ALNUM_SECRET });
      observability.log({
        level: 'error',
        event: CONTRACT_EVENT,
        error_name: named.name,
        error: named,
      });
      observability.log({ level: 'error', event: CONTRACT_EVENT, error_name: 'TypeError' });

      expect(logsOf(records()).map((r) => r.error_name)).toEqual(['Error', 'Error', 'TypeError']);
      expect(logsOf(records())).toHaveLength(3);
      expect(serialized(records())).not.toContain(ALNUM_SECRET);
      expect(serialized(records())).not.toContain(SECRET);
    });

    it('6. a secret-bearing thrown error does not reach the sink', async () => {
      const { observability, records } = await make();
      const error = new Error(SECRET, { cause: new Error(SECRET) });
      error.name = `Leaky${SECRET}`;
      observability.log({
        level: 'error',
        event: CONTRACT_EVENT,
        error_name: error.name,
        error,
        message: error.message,
        cause: error.cause,
        stack: error.stack,
      });

      expect(serialized(records())).not.toContain(SECRET);
      const [record] = logsOf(records());
      expect(record?.error_name).toBe('Error');
    });

    (unsupported.has('7') ? it.skip : it)(
      '7. plugin-scope and service fields cannot be replaced by attributes',
      async () => {
        const { observability, records, scope } = await make();
        observability.log({
          level: 'info',
          event: CONTRACT_EVENT,
          plugin: 'evil',
          service: 'evil',
          deployment_id: 'evil',
          runtime: scope.runtime === 'node' ? 'cloudflare' : 'node',
          request_id: FORGED_UUID,
          trace_id: 'f'.repeat(32),
          span_id: 'e'.repeat(16),
        });

        expect(records()).toHaveLength(1);
        const [record] = logsOf(records());
        expect(record?.service).toBe('package-broker');
        expect(record?.deployment_id).toBe(scope.deploymentId);
        expect(record?.runtime).toBe(scope.runtime);
        expect(record?.request_id).toBe(scope.requestId);
        expect(record?.plugin).toBe(scope.plugin);
        expect(record?.trace_id).toBe(scope.traceId);
        expect(record?.span_id).toBe(scope.spanId);
        const emitted = records()[0];
        expect(emitted?.kind === 'log' && Object.isFrozen(emitted.record)).toBe(true);
      },
    );

    it('8. project, token and job ids come only from validated context', async () => {
      const { observability, records, scope } = await make();
      observability.log({
        level: 'info',
        event: CONTRACT_EVENT,
        project_id: FORGED_ID,
        token_id: FORGED_ID,
        job_id: FORGED_ID,
        attempt: 999,
      });

      expect(records()).toHaveLength(1);
      const [record] = logsOf(records());
      expect(record?.project_id).toBe(scope.projectId);
      expect(record?.token_id).toBe(scope.tokenId);
      expect(record?.job_id).toBe(scope.jobId);
      expect(record?.attempt).toBe(scope.attempt);
      expect(serialized(records())).not.toContain(FORGED_ID);
    });

    it('9. unregistered events and reason codes are dropped and counted', async () => {
      const { observability, records } = await make();
      observability.log({ level: 'info', event: 'contract.unregistered', reason_code: SECRET });
      observability.log({
        level: 'info',
        event: CONTRACT_EVENT,
        reason_code: 'unregistered_reason',
      });

      expect(logsOf(records())).toHaveLength(0);
      expect(droppedSignals(records())).toEqual(['unregistered', 'unregistered']);
    });

    it('10. a metric with a disallowed label is dropped whole', async () => {
      const { observability, records } = await make();
      observability.counter('pb.contract.count', { token: FORGED_ID } as never);
      observability.counter('pb.contract.count', { route: `/raw/${FORGED_ID}` });
      observability.histogram('pb.contract.duration_ms', 3, { route: `/raw/${FORGED_ID}` });

      const kept = records().filter((r) => r.kind !== 'counter' || r.name !== 'pb.obs.dropped');
      expect(kept).toHaveLength(0);
      expect(droppedSignals(records())).toEqual(['counter', 'counter', 'histogram']);
      expect(serialized(records())).not.toContain(FORGED_ID);
    });

    it('11. a declared route template is accepted as a metric label', async () => {
      const { observability, records } = await make();
      observability.counter('pb.contract.count', { route: CONTRACT_ROUTE });

      expect(records()).toContainEqual({
        kind: 'counter',
        name: 'pb.contract.count',
        labels: { route: CONTRACT_ROUTE },
        value: 1,
      });
    });

    it('12. more than eight metric labels drop the whole metric', async () => {
      const { observability, records } = await make();
      const nine = {
        method: 'GET',
        route: CONTRACT_ROUTE,
        status_class: '2xx',
        runtime: 'node',
        signal: 'log',
        outcome: 'ok',
        kind: 'read',
        adapter: 'sqlite',
        provider: 'dex',
      };
      expect(Object.keys(nine)).toHaveLength(9);
      observability.counter('pb.contract.count', nine);
      observability.histogram('pb.contract.duration_ms', 1, nine);

      expect(droppedSignals(records())).toEqual(['counter', 'histogram']);
      expect(records()).toHaveLength(2);
    });

    it('13. a label object with a getter is dropped and the getter never runs', async () => {
      const { observability, records } = await make();
      let calls = 0;
      const labels = {};
      Object.defineProperty(labels, 'method', {
        enumerable: true,
        get() {
          calls += 1;
          return 'GET';
        },
      });
      observability.counter('pb.contract.count', labels as never);

      expect(calls).toBe(0);
      expect(droppedSignals(records())).toEqual(['counter']);
      expect(records()).toHaveLength(1);
    });

    it('14. the OTLP encoder never emits what the port dropped', async () => {
      const { observability, records } = await make();
      observability.log({
        level: 'info',
        event: CONTRACT_EVENT,
        status: 200,
        extra: SECRET,
        message: SECRET,
        token_id: FORGED_ID,
        error_name: SECRET,
      });
      observability.counter('pb.contract.count', { route: CONTRACT_ROUTE, token: SECRET } as never);
      observability.counter('pb.contract.count', { route: CONTRACT_ROUTE });

      const logRecords = records().flatMap((r) => (r.kind === 'log' ? [r.record] : []));
      const points = records().flatMap((r) => (r.kind === 'counter' ? [r] : []));
      expect(logRecords.length).toBeGreaterThan(0);

      const routes = new Set([CONTRACT_ROUTE]);
      const encodedLogs = JSON.stringify(encodeLogs(logRecords, RESOURCE, undefined, routes));
      const encodedMetrics = JSON.stringify(encodeMetrics(points, RESOURCE, undefined, routes));
      for (const encoded of [encodedLogs, encodedMetrics]) {
        expect(encoded).not.toContain(SECRET);
        expect(encoded).not.toContain(FORGED_ID);
      }
      expect(encodedLogs).toContain(CONTRACT_EVENT);
    });

    it('15. encodeMetrics drops forbidden keys, raw routes, over-eight labels and bad histograms', () => {
      const routes = new Set([CONTRACT_ROUTE]);
      const time = '2026-10-16T10:00:00.000Z';
      const counter = (labels: Record<string, string>) => ({
        kind: 'counter',
        name: 'pb.contract.count',
        value: 1,
        labels,
        time,
      });
      const histogram = (labels: Record<string, string>) => ({
        kind: 'histogram',
        name: 'pb.contract.duration_ms',
        bounds: [5],
        bucketCounts: [1, 0],
        count: 1,
        sum: 3,
        labels,
        time,
      });
      const nine = Object.fromEntries(
        [
          'method',
          'route',
          'status_class',
          'runtime',
          'signal',
          'outcome',
          'kind',
          'adapter',
          'provider',
        ].map((key) => [key, key === 'route' ? CONTRACT_ROUTE : key === 'method' ? 'GET' : 'x']),
      );
      const points = [
        counter({ token: SECRET }),
        counter({ route: `/raw?token=${SECRET}` }),
        counter(nine),
        histogram({ token: SECRET }),
        histogram({ route: `/raw?token=${SECRET}` }),
        histogram(nine),
      ];
      const body = encodeMetrics(points, RESOURCE, undefined, routes) as {
        resourceMetrics: { scopeMetrics: { metrics: unknown[] }[] }[];
      };

      expect(body.resourceMetrics[0]?.scopeMetrics[0]?.metrics).toHaveLength(0);
      const valid = encodeMetrics(
        [counter({ route: CONTRACT_ROUTE }), histogram({ method: 'GET' })],
        RESOURCE,
        undefined,
        routes,
      ) as typeof body;
      expect(valid.resourceMetrics[0]?.scopeMetrics[0]?.metrics).toHaveLength(2);
    });

    it('16. encodeLogs and encodeTraces drop allowlisted keys that carry secrets', () => {
      const routes = new Set([CONTRACT_ROUTE]);
      const logs = JSON.stringify(
        encodeLogs(
          [
            {
              level: 'info',
              event: CONTRACT_EVENT,
              error_name: 'SECRETX',
              token_id: `Bearer ${SECRET}`,
              project_id: `Bearer ${SECRET}`,
              request_id: `Bearer ${SECRET}`,
              route: `/raw?token=${SECRET}`,
            },
          ],
          RESOURCE,
          undefined,
          routes,
        ),
      );
      const traces = JSON.stringify(
        encodeTraces(
          [
            {
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              name: CONTRACT_ROUTE,
              startTime: '2026-10-16T10:00:00.000Z',
              endTime: '2026-10-16T10:00:01.000Z',
              attributes: {
                error_name: 'SECRETX',
                request_id: `Bearer ${SECRET}`,
                route: `/raw?token=${SECRET}`,
              },
            },
          ],
          RESOURCE,
          undefined,
          routes,
        ),
      );

      for (const encoded of [logs, traces]) {
        expect(encoded).not.toContain(SECRET);
        expect(encoded).not.toContain('SECRETX');
        expect(encoded).not.toContain('Bearer');
      }
      expect(logs).toContain(CONTRACT_EVENT);
    });
  });
}
