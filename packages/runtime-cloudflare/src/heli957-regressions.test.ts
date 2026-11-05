import { queueAuditHead } from '@package-broker/db-sqlite/repositories/audit-head';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { auditEvent } from '@package-broker/core/audit/actions';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { afterEach, expect, it, vi } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { AuditBatchV1, AuditDelivery, PluginDefinition } from '@package-broker/core/plugin';
import { noopObservability } from '@package-broker/core/platform/observability';
import { jobFences } from '@package-broker/core/platform/job-fences';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { systemClock, ulid } from '@package-broker/core/ids';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorkerAudit, auditExportSchedules } from './audit.js';

const alertFetch = vi.hoisted(() => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
});

const budget = MIN_AUDIT_JOURNAL_BYTES;
afterEach(() => {
  vi.restoreAllMocks();
  alertFetch.mockClear();
});
async function fixture(
  options: {
    active?: boolean;
    policy?: 'availability' | 'required';
    budget?: boolean;
    alert?: boolean;
    accepted?: boolean;
  } = {},
) {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const deliver = vi.fn(async (batch: AuditBatchV1): Promise<AuditDelivery> => ({
    outcome: 'accepted' as const,
    chainId: batch.chainId,
    epoch: batch.epoch,
    throughSeq: batch.throughSeq,
    throughHash: batch.throughHash,
  }));
  const plugins: PluginDefinition[] = [
    {
      id: 'trail',
      package: '@test/trail',
      apiVersion: 4,
      platforms: ['cloudflare'],
      binds: ['audit-trail'],
      auditTrail: { create: () => ({ handle: async () => ({ items: [], next: null }) }) },
    },
    {
      id: 'archive',
      package: '@test/archive',
      apiVersion: 4,
      platforms: ['cloudflare'],
      auditSinks: [
        {
          id: 'archive',
          kind: 'custom',
          activation: 'env',
          custody: 'durable',
          sourceIp: 'omit',
          destination: {
            protocol: 'https-json',
            urlEnv: 'ARCHIVE_URL',
            headersEnv: 'ARCHIVE_HEADERS',
          },
          create: () => ({ deliver }),
        },
      ],
    },
  ];
  const env = (name: string) =>
    ({
      ...(options.active
        ? { ARCHIVE_URL: 'https://archive.example.test', ARCHIVE_HEADERS: 'Authorization=fixture' }
        : {}),
      ...(options.alert ? { ALERT_URL: 'https://alerts.example.test' } : {}),
    })[name];
  const config = {
    platform: 'cloudflare' as const,
    plugins,
    audit: {
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.accepted ? { acceptNoDurableAudit: true as const } : {}),
      ...(options.budget ? { capacity: { maxJournalBytes: budget } } : {}),
      ...(options.alert ? { alerts: { webhookEnv: 'ALERT_URL' } } : {}),
    },
  };
  const registration = collectRegistrations(plugins);
  const histogram = vi.fn();
  const observability = { ...noopObservability, histogram };
  const audit = await createWorkerAudit({
    config,
    env,
    executor: database.executor,
    observability,
    generation: 1,
    maxJournalBytes: options.budget ? budget : null,
    deploymentId: 'test',
    telemetryActive: true,
    registration: () => registration,
  });
  const run = async (name: string, org = database.orgs!.a, expired = false) => {
    const job = audit.jobs.find((job) => job.name === name)!;
    expect(job).toBeDefined();
    const id = ulid();
    await database.executor.batch([
      {
        sql: "INSERT INTO job (id, org_id, type, state, resource_key, lease_owner, lease_until, fence) VALUES (?, ?, ?, 'running', ?, 'worker', ?, 1)",
        params: [
          id,
          org.orgId,
          `core:${name}:v1`,
          job.schedule?.resourceKey ?? null,
          expired ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
        ],
      },
    ]);
    const context = {
      org,
      jobId: id,
      idempotencyKey: id,
      attempt: 1,
      fence: 1,
      ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
      signal: new AbortController().signal,
      observability,
      fences: jobFences({ id, owner: 'worker', fence: 1 }),
    } as JobContext;
    await job.handler(job.validate({}), context);
    await database.executor.batch([
      {
        sql: "UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL WHERE org_id = ? AND id = ?",
        params: [org.orgId, id],
      },
    ]);
  };
  return { database, audit, run, deliver, histogram, config, registration, env };
}
it('schedules no export for an unresolved destination in a default no-sink deployment', async () => {
  const f = await fixture();
  try {
    expect(await auditExportSchedules(f.registration, f.config.audit, f.env)).toEqual([]);
    expect(f.audit.jobs.some((job) => job.name.startsWith('audit-export-'))).toBe(false);
    await f.audit.effective(f.database.orgs!.a);
    expect(await f.audit.health.read(f.database.orgs!.a)).toEqual({ status: 'ok', codes: [] });
  } finally {
    await f.database.close();
  }
});
it('keeps an unresolved sink inactive when a fenced maintenance view sees a changed provider', async () => {
  const options = { active: false };
  const f = await fixture(options);
  const { a, b } = f.database.orgs!;
  try {
    await f.audit.effective(a);
    expect(f.audit.jobs.some((job) => job.name === 'audit-export-archive')).toBe(false);
    options.active = true;
    await f.run('audit-maintain');
    expect((await f.audit.status.reader.read(a)).sinks).toEqual([
      expect.objectContaining({ id: 'archive', state: 'inactive', activationSource: 'none' }),
    ]);
    expect((await f.audit.status.reader.read(b)).sinks).toEqual([]);
    expect(f.audit.jobs.some((job) => job.name === 'audit-export-archive')).toBe(false);
    expect(f.deliver).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});
it('keeps an installed export handler bound to the assembled destination during maintenance', async () => {
  const options = { active: true };
  const f = await fixture(options);
  const org = f.database.orgs!.a;
  try {
    await f.audit.effective(org);
    options.active = false;
    await f.run('audit-maintain');
    expect((await f.audit.status.reader.read(org)).sinks).toEqual([
      expect.objectContaining({ id: 'archive', state: 'active', activationSource: 'ARCHIVE_URL' }),
    ]);
    await f.run('audit-head');
    await f.run('audit-export-archive');
    expect(f.deliver).toHaveBeenCalledOnce();
  } finally {
    await f.database.close();
  }
});
it.each(['accepted', 'rejected', 'uncertain', 'legacy'] as const)(
  'preserves the next daily head after a frozen cross-day retry: %s',
  async (outcome) => {
    const f = await fixture({ active: true });
    const { a, b } = f.database.orgs!;
    let now = new Date('2026-11-05T12:00:00.000Z');
    vi.spyOn(systemClock, 'now').mockImplementation(() => now);
    try {
      await f.audit.effective(a);
      await f.audit.effective(b);
      await f.run('audit-head');
      if (outcome === 'legacy') {
        await f.database.executor.batch([
          {
            sql: "UPDATE audit_sink SET inflight_repr = json_remove(inflight_repr, '$.registryMarkers[0].queueId') WHERE org_id = ?",
            params: [a.orgId],
          },
        ]);
      }
      f.deliver.mockResolvedValueOnce({ outcome: 'retry', code: 'network' });
      await f.run('audit-export-archive');
      const frozen = f.deliver.mock.calls[0]![0];
      if (outcome === 'legacy') {
        await f.database.executor.batch([
          {
            sql: "UPDATE audit_sink SET inflight_repr = json_remove(inflight_repr, '$.registryMarkerOccurrences') WHERE org_id = ?",
            params: [a.orgId],
          },
        ]);
      }
      now = new Date('2026-11-06T12:00:00.000Z');
      await f.run('audit-head');
      await f.run('audit-head');
      const [queued] = await f.database.executor.all<{ repr: string }>({
        sql: 'SELECT inflight_repr AS repr FROM audit_sink WHERE org_id = ?',
        params: [a.orgId],
      });
      const markers = JSON.parse(queued!.repr).registryMarkers;
      expect(markers).toHaveLength(2);
      expect(markers[0].markerId).toBe(markers[1].markerId);
      if (outcome === 'rejected') f.deliver.mockResolvedValueOnce({ outcome, code: 'refused' });
      if (outcome === 'uncertain')
        f.deliver.mockResolvedValueOnce({ outcome, code: 'partial_rejected', rejectedCount: 1 });
      await f.run('audit-export-archive');
      expect(f.deliver.mock.calls[1]![0]).toEqual(frozen);
      expect(f.deliver).toHaveBeenCalledTimes(3);
      if (outcome !== 'legacy') expect(markers[0].queueId).not.toBe(markers[1].queueId);
      const nextDay = f.deliver.mock.calls[2]![0];
      expect(nextDay.frozenAt).toBe(now.getTime());
      expect(nextDay.records).toEqual(frozen.records);
      expect(nextDay.records[0]).not.toHaveProperty('queueId');
      expect((await f.audit.status.reader.read(a)).sinks[0]).toMatchObject({
        progressSeq: 0,
        custodySeq: 0,
      });
      expect((await f.audit.status.reader.read(b)).sinks[0]).toMatchObject({
        progressSeq: 0,
        custodySeq: 0,
      });
      await f.run('audit-head');
      await f.run('audit-export-archive');
      expect(f.deliver).toHaveBeenCalledTimes(3);
    } finally {
      await f.database.close();
    }
  },
);
it('persists configuration refusal and sends the fixed alert webhook code', async () => {
  const f = await fixture({ alert: true, accepted: true });
  const { a, b } = f.database.orgs!;
  try {
    await f.database.executor.batch([
      { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [a.orgId] },
    ]);
    await expect(f.audit.effective(a)).rejects.toMatchObject({ code: 'required_acceptance' });
    expect(await f.audit.health.read(a)).toMatchObject({
      status: 'degraded',
      codes: expect.arrayContaining(['audit.config_invalid']),
    });
    expect(await f.audit.health.read(b)).toEqual({ status: 'ok', codes: [] });
    await vi.waitFor(() =>
      expect(alertFetch).toHaveBeenCalledWith(
        'https://alerts.example.test',
        expect.objectContaining({ body: JSON.stringify({ code: 'audit.config_invalid' }) }),
      ),
    );
  } finally {
    await f.database.close();
  }
});
it.each(['availability', 'required'] as const)(
  'warns at 80 percent under %s even without sealing',
  async (policy) => {
    const f = await fixture({ policy, budget: true, alert: true });
    const { a, b } = f.database.orgs!;
    try {
      await f.audit.effective(a);
      await f.database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET journal_bytes = ? WHERE org_id = ?',
          params: [Math.ceil(budget * 0.8), a.orgId],
        },
      ]);
      await f.run('audit-health-observe');
      expect((await f.audit.status.reader.read(a)).capacity.state).toBe('warning');
      expect((await f.audit.status.reader.read(b)).capacity.state).toBe('ok');
      expect(await f.audit.health.read(a)).toMatchObject({
        status: 'degraded',
        codes: expect.arrayContaining(['audit.capacity']),
      });
      expect(f.histogram).toHaveBeenCalledWith('pb.audit.journal_bytes', Math.ceil(budget * 0.8));
      expect(f.histogram).toHaveBeenCalledWith('pb.audit.journal_rows', 0);
      await vi.waitFor(() =>
        expect(alertFetch).toHaveBeenCalledWith(
          'https://alerts.example.test',
          expect.objectContaining({ body: JSON.stringify({ code: 'audit.capacity' }) }),
        ),
      );
      await f.database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET journal_bytes = ? WHERE org_id = ?',
          params: [Math.floor(budget * 0.75), a.orgId],
        },
      ]);
      await f.run('audit-health-observe');
      expect((await f.audit.status.reader.read(a)).capacity.state).toBe('ok');
    } finally {
      await f.database.close();
    }
  },
);
it('delivers one non-advancing daily head per organization through the exporter', async () => {
  const f = await fixture({ active: true });
  const { a, b } = f.database.orgs!;
  let now = new Date();
  vi.spyOn(systemClock, 'now').mockImplementation(() => now);
  try {
    expect(f.audit.jobs.find((job) => job.name === 'audit-head')?.schedule).toEqual({
      everySeconds: 86400,
      resourceKey: 'audit-head',
    });
    expect(await auditExportSchedules(f.registration, f.config.audit, f.env)).toEqual([
      { name: 'audit-export-archive', everySeconds: 60, resourceKey: 'audit-export:archive' },
    ]);
    for (const org of [a, b]) {
      await f.audit.effective(org);
      await f.run('audit-head', org);
      await f.run('audit-head', org);
      await f.run('audit-export-archive', org);
      await f.run('audit-head', org);
      await f.run('audit-export-archive', org);
    }
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls.map(([batch]) => batch.orgId).sort()).toEqual(
      [a.orgId, b.orgId].sort(),
    );
    for (const [batch] of f.deliver.mock.calls) {
      expect(batch.records).toEqual([
        expect.objectContaining({ kind: 'head', seq: 0, hash: '0'.repeat(64), boundarySeq: 1 }),
      ]);
      expect(batch.throughSeq).toBe(0);
    }
    now = new Date(now.getTime() + 86400_000);
    await f.run('audit-head', a);
    await f.run('audit-export-archive', a);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    expect(f.histogram).toHaveBeenCalledWith('pb.audit.sink_backlog', 0, { sink: 'archive' });
    expect(f.histogram).toHaveBeenCalledWith('pb.audit.sink_drain_rate', 0, { sink: 'archive' });
    expect((await f.audit.status.reader.read(a)).sinks[0]).toMatchObject({
      progressSeq: 0,
      custodySeq: 0,
    });
  } finally {
    await f.database.close();
  }
});
it.each([
  'audit-maintain',
  'audit-health-observe',
  'audit-frontier',
  'audit-head',
  'audit-export-archive',
])('refuses an expired %s worker before any audit write', async (name) => {
  const f = await fixture({ active: true, budget: true });
  const org = f.database.orgs!.a;
  try {
    await f.audit.effective(org);
    const before = await f.audit.status.reader.read(org);
    await expect(f.run(name, org, true)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await f.audit.status.reader.read(org)).toEqual(before);
    expect(f.deliver).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});

it('exports the actual head without advancing its marker frontier and measures a nonzero backlog and drain', async () => {
  const f = await fixture({ active: true });
  const org = f.database.orgs!.a;
  try {
    await f.audit.effective(org);
    const event = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      action: 'project.update',
      actor: { type: 'system', id: null },
      target: { type: 'project', id: null },
      context: { sourceIp: null, tokenSelector: null, requestId: null, opId: null },
    });
    if (!event.ok) throw new Error('Invalid fixture');
    await f.database.executor.batch([auditPendingStatement(org, event.event)]);
    await createAuditSealRepository(f.database.executor).seal(org);
    const head = await f.audit.status.reader.read(org);
    await f.run('audit-health-observe');
    expect(f.histogram).toHaveBeenCalledWith('pb.audit.sink_backlog', 1, { sink: 'archive' });
    await f.run('audit-head');
    await f.run('audit-export-archive');
    const markerBatch = f.deliver.mock.calls[0]![0];
    expect(markerBatch.records).toEqual([
      expect.objectContaining({ kind: 'head', seq: 1, hash: head.headHash, boundarySeq: 1 }),
    ]);
    expect(markerBatch.throughSeq).toBe(0);
    expect(f.deliver.mock.calls[1]![0].records[0]?.kind).toBe('event');
    const drain = f.histogram.mock.calls.find(([name]) => name === 'pb.audit.sink_drain_rate');
    expect(drain?.[1]).toBeGreaterThan(0);
    expect(f.histogram).toHaveBeenCalledWith('pb.audit.sink_backlog', 0, { sink: 'archive' });
  } finally {
    await f.database.close();
  }
});

it('queues a daily snapshot even if a sealer appends before its update commits', async () => {
  const f = await fixture({ active: true });
  const org = f.database.orgs!.a;
  try {
    await f.audit.effective(org);
    const event = auditEvent({
      id: ulid(),
      now: new Date().toISOString(),
      action: 'project.update',
      actor: { type: 'system', id: null },
      target: { type: 'project', id: null },
      context: { sourceIp: null, tokenSelector: null, requestId: null, opId: null },
    });
    if (!event.ok) throw new Error('Invalid fixture');
    await f.database.executor.batch([auditPendingStatement(org, event.event)]);
    const racing: SqlExecutor = {
      ...f.database.executor,
      async batch(statements) {
        await createAuditSealRepository(f.database.executor).seal(org);
        return f.database.executor.batch(statements);
      },
    };
    await queueAuditHead(racing, org, 1, new Date());
    const [sink] = await f.database.executor.all<{ inflight_repr: string }>({
      sql: 'SELECT inflight_repr FROM audit_sink WHERE org_id = ? AND sink_id = ?',
      params: [org.orgId, 'archive'],
    });
    expect(JSON.parse(sink!.inflight_repr).registryMarkers).toEqual([
      expect.objectContaining({ kind: 'head', seq: 0 }),
    ]);
    expect((await f.audit.status.reader.read(org)).headSeq).toBe(1);
  } finally {
    await f.database.close();
  }
});
it.each(['audit-maintain', 'audit-health-observe', 'audit-head'])(
  'rolls back %s when its lease expires immediately before its write batch',
  async (name) => {
    const f = await fixture({ active: true, budget: true });
    const org = f.database.orgs!.a;
    try {
      await f.audit.effective(org);
      const before = await f.audit.status.reader.read(org);
      const original = f.database.executor.batch.bind(f.database.executor);
      let expired = false;
      vi.spyOn(f.database.executor, 'batch').mockImplementation(async (statements) => {
        if (
          !expired &&
          statements.some((statement) =>
            statement.sql.startsWith(
              name === 'audit-head'
                ? 'UPDATE audit_sink SET inflight_repr = json_insert'
                : 'UPDATE audit_chain SET capacity_state',
            ),
          )
        ) {
          expired = true;
          await original([
            {
              sql: "UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND type = ? AND state = 'running'",
              params: [org.orgId, `core:${name}:v1`],
            },
          ]);
        }
        return original(statements);
      });
      await expect(f.run(name)).rejects.toMatchObject({ code: 'lease_lost' });
      expect(expired).toBe(true);
      expect(await f.audit.status.reader.read(org)).toEqual(before);
    } finally {
      await f.database.close();
    }
  },
);
