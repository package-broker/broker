import { expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  createAuditHealthService,
  type AuditHealthSnapshot,
  type AuditHealthPort,
} from './health.js';

const base: AuditHealthSnapshot = {
  mode: 'trail',
  capacityState: 'ok',
  restorePending: false,
  oldestPendingAt: null,
  sinks: [],
  incidents: [],
};
async function read(snapshot: AuditHealthSnapshot) {
  const observe = vi.fn<AuditHealthPort['observe']>(async (_ctx, observations) => ({
    raised: observations.map((o) => o.code),
    alerts: observations.map((o) => ({
      code: o.code,
      revision: 1,
      acknowledgedRevision: 0,
      active: o.active !== false,
      failing: o.failing,
    })),
  }));
  const observability = { log: vi.fn(), counter: vi.fn(), histogram: vi.fn() };
  const service = createAuditHealthService({
    port: {
      raise: async () => {},
      snapshot: async () => snapshot,
      observe,
      acknowledge: async () => false,
    },
    clock: fixedClock('2026-10-30T01:00:00.000Z'),
    observability,
  });
  return { health: await service.read(orgContext('org-a')), observability, observe };
}
it('keeps an empty journal healthy without claiming verification', async () => {
  expect((await read(base)).health).toEqual({ status: 'ok', codes: [] });
});
it.each([
  ['2026-10-30T00:55:00.000Z', []],
  ['2026-10-30T00:54:59.999Z', ['audit.pending_old']],
  ['invalid', ['audit.pending_old']],
] as const)(
  'checks pending age at the five minute boundary: %s',
  async (oldestPendingAt, codes) => {
    expect((await read({ ...base, oldestPendingAt })).health.codes).toEqual(codes);
  },
);
it('uses sink state for blocks even when inactive sinks retain a fork reason', async () => {
  expect(
    (await read({ ...base, sinks: [{ id: 'sink', state: 'inactive', blockedReason: 'fork' }] }))
      .health,
  ).toEqual({ status: 'degraded', codes: ['audit.sink_inactive'] });
  expect(
    (await read({ ...base, sinks: [{ id: 'sink', state: 'blocked', blockedReason: 'fork' }] }))
      .health,
  ).toEqual({ status: 'failing', codes: ['audit.blocked', 'audit.fork'] });
});
it('alerts on none, restore and persisted incidents with fixed telemetry fields', async () => {
  const result = await read({
    ...base,
    mode: 'none',
    restorePending: true,
    incidents: [
      {
        code: 'audit.marker_rejected',
        fingerprint: 'private-reason',
        failing: false,
        active: false,
      },
    ],
  });
  expect(result.health).toEqual({
    status: 'failing',
    codes: ['audit.fork', 'audit.marker_rejected', 'audit.mode_none'],
  });
  expect(JSON.stringify(result.observability.log.mock.calls)).not.toContain('private-reason');
  expect(result.observability.log).toHaveBeenCalledWith({
    level: 'error',
    event: 'audit.alert',
    reason_code: 'audit.marker_rejected',
  });
});

it('distinguishes a newly blocked sink while another sink is still blocked', async () => {
  const first = await read({
    ...base,
    sinks: [{ id: 'first', state: 'blocked', blockedReason: 'rejected' }],
  });
  const next = await read({
    ...base,
    sinks: [
      { id: 'first', state: 'blocked', blockedReason: 'rejected' },
      { id: 'second', state: 'blocked', blockedReason: 'rejected' },
    ],
  });
  expect(next.observe.mock.calls[0]?.[1][0]?.fingerprint).not.toBe(
    first.observe.mock.calls[0]?.[1][0]?.fingerprint,
  );
  expect(next.health).toEqual({ status: 'failing', codes: ['audit.blocked'] });
  expect(JSON.stringify(next.observability.log.mock.calls)).not.toContain('second');
});

it('does not alert for deliberately disabled sinks', async () => {
  expect(
    (
      await read({
        ...base,
        sinks: [{ id: 'disabled', state: 'disabled', blockedReason: null }],
      })
    ).health,
  ).toEqual({ status: 'ok', codes: [] });
});

it('emits registered alert counters through production observability before a failed persist', async () => {
  const { createObservability } = await import('../platform/observability.js');
  const { AUDIT_EVENTS, KERNEL_REASON_CODES } = await import('../kernel/obs-codes.js');
  const emit = vi.fn();
  const observability = createObservability(
    { emit },
    { deploymentId: 'test', runtime: 'node', requestId: null },
    { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
  );
  const port: AuditHealthPort = {
    raise: async () => {
      expect(emit.mock.calls).toHaveLength(2);
      throw new Error('persist unavailable');
    },
    snapshot: async () => base,
    observe: async () => ({ raised: [], alerts: [] }),
    acknowledge: async () => false,
  };
  const service = createAuditHealthService({
    port,
    observability,
    clock: fixedClock('2026-10-30T01:00:00.000Z'),
  });
  await expect(service.raise(orgContext('org-a'), 'audit.capacity')).rejects.toThrow(
    'persist unavailable',
  );
  expect(emit).toHaveBeenLastCalledWith({
    kind: 'counter',
    name: 'pb.audit.alerts_total',
    labels: { code: 'audit.capacity' },
    value: 1,
  });
  observability.counter('pb.audit.alerts_total', { code: 'audit.secret' });
  expect(emit).toHaveBeenLastCalledWith({
    kind: 'counter',
    name: 'pb.obs.dropped',
    labels: { signal: 'counter' },
    value: 1,
  });
});
