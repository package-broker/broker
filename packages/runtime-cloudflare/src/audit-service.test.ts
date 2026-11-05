import * as effectiveRepository from '@package-broker/db-sqlite/repositories/audit-effective';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, AuditSinkContext } from '@package-broker/core/plugin';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { noopObservability } from '@package-broker/core/platform/observability';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorkerAudit } from './audit.js';
const native = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  return { fetch };
});
const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/trail',
  apiVersion: 4,
  platforms: ['cloudflare'],
  binds: ['audit-trail'],
  auditTrail: { create: () => ({ handle: async () => ({ items: [], next: null }) }) },
};
const sink: PluginDefinition = {
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
      destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
      create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
    },
  ],
};
const env = (name: string) =>
  ({
    ARCHIVE_URL: 'https://archive.example.test',
    ARCHIVE_HEADERS: 'Authorization=fixture',
    ALERT_URL: 'https://alerts.example.test',
  })[name];
async function fixture() {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  return { database, org: database.orgs!.a, foreign: database.orgs!.b };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Worker organization audit resolution', () => {
  it.each(['trail', 'none', 'required'] as const)(
    'records the first %s configuration without a change event or change alert',
    async (mode) => {
      const { database, org } = await fixture();
      const plugins = mode === 'none' ? [] : [trail];
      const log = vi.fn();
      const create = (definitions: readonly PluginDefinition[], accept = false) =>
        createWorkerAudit({
          config: {
            platform: 'cloudflare',
            plugins: definitions,
            audit: {
              capacity,
              ...(accept ? { acceptNoDurableAudit: true } : {}),
              ...(mode === 'required'
                ? { policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } }
                : {}),
            },
          },
          env,
          executor: database.executor,
          observability: { ...noopObservability, log },
          generation: 0,
          maxJournalBytes: capacity.maxJournalBytes,
          telemetryActive: true,
          registration: () => collectRegistrations(definitions),
        });
      try {
        const audit = await create(plugins, mode === 'none');
        const expected = {
          mode: mode === 'none' ? 'none' : 'trail',
          policy: mode === 'required' ? 'required' : 'availability',
        };
        expect(await audit.effective(org)).toMatchObject(expected);
        const restart = await create(plugins, mode === 'none');
        expect(await restart.effective(org)).toMatchObject(expected);
        expect(
          await database.executor.all({
            sql: 'SELECT mode, policy, mode_generation FROM audit_chain WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ ...expected, mode_generation: 1 }]);
        if (mode !== 'none')
          expect(await restart.health.read(org)).toEqual({ status: 'ok', codes: [] });
        for (const table of ['audit_pending', 'audit_ledger', 'audit_health'])
          expect(
            await database.executor.all({
              sql: `SELECT * FROM ${table} WHERE org_id = ?`,
              params: [org.orgId],
            }),
          ).toEqual([]);
        expect(log).not.toHaveBeenCalled();
        if (mode !== 'required') {
          const changed = await create(mode === 'none' ? [trail] : [], mode !== 'none');
          await changed.effective(org);
          expect(
            await database.executor.all({
              sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
              params: [org.orgId],
            }),
          ).toEqual([{ action: 'audit.mode_change' }]);
          expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'audit.alert', reason_code: 'audit.mode_change' }),
          );
        }
      } finally {
        await database.close();
      }
    },
  );

  it('caches repeated download org resolution for at most 30 seconds, with separate org entries', async () => {
    const { database, org, foreign } = await fixture();
    const all = vi.fn(database.executor.all);
    const audit = await createWorkerAudit({
      config: { platform: 'cloudflare', plugins: [trail], audit: { capacity } },
      env,
      executor: { ...database.executor, all: all as SqlExecutor['all'] },
      observability: noopObservability,
      generation: 9,
      maxJournalBytes: capacity.maxJournalBytes,
      telemetryActive: false,
      registration: () => collectRegistrations([trail]),
    });
    try {
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const download = new Request('https://broker.test/npm/example/-/example-1.0.0.tgz');
      await audit.resolveRequest(org, download);
      all.mockClear();
      for (let i = 0; i < 10; i++) await audit.resolveRequest(org, download);
      expect(all).not.toHaveBeenCalled();
      await audit.effective(foreign);
      expect(all).toHaveBeenCalled();
      all.mockClear();
      now += 30_001;
      await audit.resolveRequest(org, download);
      expect(all).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await database.close();
    }
  });

  it.each([false, true])(
    'fences trail to export and preserves a pending cutover (pending=%s)',
    async (pending) => {
      const { database, org } = await fixture();
      await database.executor.batch([
        {
          sql: 'UPDATE audit_chain SET head_seq = 7, pending_mode = ?, cutover_seq = ? WHERE org_id = ?',
          params: [pending ? 'none' : null, pending ? 5 : null, org.orgId],
        },
      ]);
      const audit = await createWorkerAudit({
        config: { platform: 'cloudflare', plugins: [sink], audit: { capacity } },
        env,
        executor: database.executor,
        observability: noopObservability,
        generation: 0,
        maxJournalBytes: capacity.maxJournalBytes,
        deploymentId: 'test',
        telemetryActive: true,
        registration: () => collectRegistrations([sink]),
      });
      try {
        if (pending)
          await expect(audit.effective(org)).rejects.toMatchObject({
            code: 'audit_cutover_refused',
            fenceWrites: false,
          });
        else expect(await audit.effective(org)).toMatchObject({ mode: 'export' });
        await expect(
          audit.resolveRequest(
            org,
            new Request('https://broker.test/_pb/projects', { method: 'POST' }),
          ),
        ).resolves.toBeUndefined();
        expect(
          await database.executor.all({
            sql: 'SELECT mode, pending_mode, cutover_seq FROM audit_chain WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([
          {
            mode: 'trail',
            pending_mode: pending ? 'none' : 'export',
            cutover_seq: pending ? 5 : 7,
          },
        ]);
        expect(
          await database.executor.all({
            sql: "SELECT kind FROM audit_ledger WHERE org_id = ? AND kind = 'cutover'",
            params: [org.orgId],
          }),
        ).toHaveLength(pending ? 0 : 1);
      } finally {
        await database.close();
      }
    },
  );

  it('caches definitive refusals per organization for 30 seconds and logs once per period', async () => {
    const { database, org, foreign } = await fixture();
    const all = vi.fn(database.executor.all);
    const log = vi.fn();
    const audit = await createWorkerAudit({
      config: { platform: 'cloudflare', plugins: [], audit: { capacity } },
      env,
      executor: { ...database.executor, all: all as SqlExecutor['all'] },
      observability: { ...noopObservability, log },
      generation: 4,
      maxJournalBytes: capacity.maxJournalBytes,
      telemetryActive: false,
      registration: () => collectRegistrations([]),
    });
    try {
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const get = () => new Request('https://broker.test/_pb/me');
      await audit.resolveRequest(org, get());
      all.mockClear();
      for (let i = 0; i < 5; i++) await audit.resolveRequest(org, get());
      expect(all).not.toHaveBeenCalled();
      expect(
        log.mock.calls.filter(([record]) => record.event === 'audit.effective_unavailable'),
      ).toHaveLength(1);
      expect(
        log.mock.calls.filter(
          ([record]) =>
            record.event === 'audit.alert' && record.reason_code === 'audit.config_invalid',
        ),
      ).toHaveLength(1);
      await expect(
        audit.resolveRequest(
          org,
          new Request('https://broker.test/_pb/projects', { method: 'POST' }),
        ),
      ).rejects.toMatchObject({ code: 'none_not_accepted', transient: false });
      await audit.resolveRequest(foreign, get());
      expect(all).toHaveBeenCalled();
      expect(
        log.mock.calls.filter(([record]) => record.event === 'audit.effective_unavailable'),
      ).toHaveLength(2);
      expect(
        log.mock.calls.filter(
          ([record]) =>
            record.event === 'audit.alert' && record.reason_code === 'audit.config_invalid',
        ),
      ).toHaveLength(2);
      all.mockClear();
      now += 30_001;
      await audit.resolveRequest(org, get());
      expect(all).toHaveBeenCalled();
      expect(
        log.mock.calls.filter(([record]) => record.event === 'audit.effective_unavailable'),
      ).toHaveLength(3);
      expect(
        log.mock.calls.filter(
          ([record]) =>
            record.event === 'audit.alert' && record.reason_code === 'audit.config_invalid',
        ),
      ).toHaveLength(3);
    } finally {
      await database.close();
    }
  });

  it('treats exhausted transition contention as transient and retries on the next request', async () => {
    const { database, org } = await fixture();
    const actual = effectiveRepository.createAuditEffectiveRepository;
    const save = vi.fn<ReturnType<typeof actual>['save']>(async () => false);
    vi.spyOn(effectiveRepository, 'createAuditEffectiveRepository').mockReturnValue({
      initialize: async () => false,
      save,
    });
    const audit = await createWorkerAudit({
      config: { platform: 'cloudflare', plugins: [trail], audit: { capacity } },
      env,
      executor: database.executor,
      observability: noopObservability,
      generation: 0,
      maxJournalBytes: capacity.maxJournalBytes,
      telemetryActive: false,
      registration: () => collectRegistrations([trail]),
    });
    try {
      await expect(audit.effective(org)).rejects.toMatchObject({
        code: 'audit_unavailable',
        transient: true,
      });
      expect(save).toHaveBeenCalledTimes(3);
      save.mockImplementation(actual(database.executor).save);
      await expect(audit.effective(org)).resolves.toMatchObject({ mode: 'trail' });
    } finally {
      await database.close();
    }
  });
});

it.each([
  'http://archive.example.test',
  'https://127.0.0.1',
  'https://169.254.170.2',
  'https://169.254.170.23',
  'https://[fe80::1]',
  'https://[fd00:ec2::23]',
  'https://metadata.google.internal',
  'https://user:fixture@archive.example.test/path',
])('refuses unsafe Worker sink endpoint %# with a fixed error', async (url) => {
  const { database } = await fixture();
  try {
    await expect(
      createWorkerAudit({
        config: { platform: 'cloudflare', plugins: [sink], audit: { capacity } },
        env: (name) => (name === 'ARCHIVE_URL' ? url : env(name)),
        executor: database.executor,
        observability: noopObservability,
        generation: 0,
        maxJournalBytes: capacity.maxJournalBytes,
        deploymentId: 'test',
        telemetryActive: false,
        registration: () => collectRegistrations([sink]),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_endpoint',
      message: 'Invalid audit sink configuration',
    });
  } finally {
    await database.close();
  }
});
it('refuses an active Worker sink without a deployment id before creating the sink', async () => {
  const { database } = await fixture();
  const create = vi.fn(sink.auditSinks![0]!.create);
  const definition: PluginDefinition = {
    ...sink,
    auditSinks: [{ ...sink.auditSinks![0]!, create }],
  };
  try {
    await expect(
      createWorkerAudit({
        config: { platform: 'cloudflare', plugins: [definition], audit: { capacity } },
        env,
        executor: database.executor,
        observability: noopObservability,
        generation: 0,
        maxJournalBytes: capacity.maxJournalBytes,
        telemetryActive: false,
        registration: () => collectRegistrations([definition]),
      }),
    ).rejects.toThrow('Audit sinks require a configured deployment id');
    expect(create).not.toHaveBeenCalled();
  } finally {
    await database.close();
  }
});
it('uses kernel-wrapped frozen sink contexts and a destination-bound fetch that refuses redirects', async () => {
  const { database, org } = await fixture();
  const fetch = native.fetch
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://169.254.170.2' } }),
    );
  const replacement = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', replacement);
  const create = vi.fn((ctx: AuditSinkContext) => ({
    deliver: async () => ({ outcome: 'retry' as const, code: 'network' as const }),
    async frontier() {
      const response = await ctx.fetch({
        body: '{}',
        contentType: 'application/json',
        signal: AbortSignal.timeout(1000),
      });
      expect(response.status).toBe(302);
      return null;
    },
  }));
  const definition: PluginDefinition = {
    ...sink,
    auditSinks: [{ ...sink.auditSinks![0]!, envNames: ['OPTION'], create }],
  };
  const kernel = await createKernel({
    platform: 'cloudflare',
    plugins: [definition],
    registration: collectRegistrations([definition]),
    ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
    resolveOrg: async () => org,
    health: async () => true,
    log: () => {},
    observability: { deploymentId: 'kernel-deployment', sink: { emit: () => {} } },
  });
  const audit = await createWorkerAudit({
    config: { platform: 'cloudflare', plugins: [definition], audit: { capacity } },
    env: (name) => (name === 'OPTION' ? 'safe' : env(name)),
    executor: database.executor,
    observability: noopObservability,
    generation: 0,
    maxJournalBytes: capacity.maxJournalBytes,
    deploymentId: 'runtime-copy',
    telemetryActive: false,
    registration: () => kernel.registration,
  });
  try {
    await audit.probe(org, AbortSignal.timeout(1000));
    expect(create).toHaveBeenCalledOnce();
    const context = create.mock.calls[0]![0];
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.deploymentId).toBe('kernel-deployment');
    expect(context.runtime).toBe('cloudflare');
    expect(context.env('OPTION')).toBe('safe');
    expect(context.env('ARCHIVE_HEADERS')).toBeUndefined();
    expect(context.env('PB_MASTER_KEY')).toBeUndefined();
    expect(replacement).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://archive.example.test/',
      expect.objectContaining({ redirect: 'manual', method: 'POST' }),
    );
  } finally {
    await database.close();
  }
});

it.each(['https-json', 'otlp-http-json'] as const)(
  'takes rejection retries from %s rather than the sink kind',
  async (protocol) => {
    const { database } = await fixture();
    const exportModule = await import('@package-broker/core/audit/export');
    const exportJob = vi.spyOn(exportModule, 'auditExportJob');
    const definition: PluginDefinition = {
      ...sink,
      auditSinks: [
        {
          ...sink.auditSinks![0]!,
          kind: protocol === 'https-json' ? 'otlp' : 'webhook',
          skipAfter: 2,
          destination:
            protocol === 'https-json'
              ? { protocol, urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' }
              : { protocol },
        },
      ],
    };
    try {
      await createWorkerAudit({
        config: { platform: 'cloudflare', plugins: [definition], audit: { capacity } },
        env: (name) =>
          ({
            PB_AUDIT_OTLP_ENDPOINT: 'https://archive.example.test',
            PB_AUDIT_OTLP_HEADERS: 'Authorization=fixture',
          })[name] ?? env(name),
        executor: database.executor,
        observability: noopObservability,
        generation: 0,
        maxJournalBytes: capacity.maxJournalBytes,
        deploymentId: 'test',
        telemetryActive: false,
        registration: () => collectRegistrations([definition]),
      });
      expect(exportJob).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rejectionRetries: protocol === 'https-json' ? 2 : 'terminal' }),
      );
    } finally {
      await database.close();
    }
  },
);

it('uses the captured native fetch for alerts after global fetch is replaced', async () => {
  const { database, org } = await fixture();
  native.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  const replacement = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', replacement);
  const pending: Promise<void>[] = [];
  const audit = await createWorkerAudit({
    config: {
      platform: 'cloudflare',
      plugins: [trail],
      audit: { capacity, policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
    },
    env,
    executor: database.executor,
    observability: noopObservability,
    generation: 0,
    maxJournalBytes: capacity.maxJournalBytes,
    telemetryActive: false,
    dispatch: (run) => {
      pending.push(run());
    },
    registration: () => collectRegistrations([trail]),
  });
  try {
    await audit.effective(org);
    await audit.raise(org, 'audit.withheld');
    await Promise.all(pending);
    expect(replacement).not.toHaveBeenCalled();
    expect(native.fetch).toHaveBeenCalledWith(
      'https://alerts.example.test',
      expect.objectContaining({
        redirect: 'manual',
        body: JSON.stringify({ code: 'audit.withheld' }),
      }),
    );
  } finally {
    await database.close();
  }
});
