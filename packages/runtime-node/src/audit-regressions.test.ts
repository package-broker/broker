import { auditTrail } from './audit-trail.test.support.js';
import * as effectiveRepository from '@package-broker/db-sqlite/repositories/audit-effective';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditSinkDefinition, PluginDefinition } from '@package-broker/core/plugin';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { noopObservability } from '@package-broker/core/platform/observability';
import { ulid } from '@package-broker/core/ids';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createNodeAudit } from './audit.js';
import { createNodeServer } from './index.js';

vi.mock('@package-broker/core/kernel/registry-audit', async (original) => ({
  ...(await original<typeof import('@package-broker/core/kernel/registry-audit')>()),
  AUDIT_SINKS_AVAILABLE: true,
}));
const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/trail',
  apiVersion: 4,
  platforms: ['node'],
  binds: ['audit-trail'],
  auditTrail: { create: () => ({ handle: async () => ({ items: [], next: null }) }) },
};
const sink: PluginDefinition = {
  id: 'archive',
  package: '@test/archive',
  apiVersion: 4,
  platforms: ['node'],
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
const auth = {
  keyring: createKeyring([
    parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
  ]),
  publicOrigin: 'https://broker.test',
  env: {},
};
async function fixture() {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  return { database, org: database.orgs!.a, foreign: database.orgs!.b };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Node audit resolution regressions', () => {
  it.each(['trail', 'none', 'required'] as const)(
    'records the first %s configuration without a change event or change alert',
    async (mode) => {
      const { database, org } = await fixture();
      const plugins = mode === 'none' ? [] : [trail];
      const log = vi.fn();
      const create = (definitions: readonly PluginDefinition[], accept = false) =>
        createNodeAudit({
          config: {
            platform: 'node',
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

  it('keeps the stored-required durable-path refusal when all configured audit paths are removed', async () => {
    const { database, org } = await fixture();
    const audit = await createNodeAudit({
      config: {
        platform: 'node',
        plugins: [trail],
        audit: { capacity, policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
      },
      env,
      executor: database.executor,
      observability: noopObservability,
      generation: 0,
      maxJournalBytes: capacity.maxJournalBytes,
      telemetryActive: false,
      registration: () => collectRegistrations([trail]),
    });
    await audit.effective(org);
    const log = vi.fn();
    const broker = createNodeServer([], {
      executor: database.executor,
      audit: { capacity },
      auditEnv: {},
      auth,
      log,
    });
    try {
      const kernel = await broker.ready();
      log.mockClear();
      const request = (path: string, method: string) =>
        kernel.fetch(
          new Request(`https://broker.test${path}`, {
            method,
            headers: { origin: auth.publicOrigin },
          }),
        );
      const write = await request('/_pb/projects', 'POST');
      expect(write.status).toBe(503);
      expect(write.headers.has('retry-after')).toBe(false);
      expect(await write.json()).toMatchObject({ error: { code: 'durable_path_required' } });
      expect((await request('/_pb/auth/local/login', 'POST')).status).toBe(400);
      expect((await request(`/_pb/me/tokens/${ulid()}`, 'DELETE')).status).toBe(401);
      log.mockClear();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      await request('/_pb/me', 'GET');
      expect(
        log.mock.calls.flat().filter((entry) => entry.event === 'audit.effective_unavailable'),
      ).toHaveLength(1);
    } finally {
      await broker.close();
      await database.close();
    }
  });

  it('logs only once when both org resolution and the composed trail refuse the same GET', async () => {
    const { database, org } = await fixture();
    await database.executor.batch([
      { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
    ]);
    const log = vi.fn();
    const broker = createNodeServer([trail], {
      executor: database.executor,
      audit: { capacity },
      auditEnv: {},
      auth,
      authorization: createAuthorizationEngine({
        access: {
          lookupSession: async () => ({
            session: { id: 'session', csrfHash: '0'.repeat(64) },
            user: { id: 'reader' },
            identity: null,
            protectedHolder: true,
            project: null,
            organizationPermissions: PERMISSIONS.map((permission) => permission.name),
            projectPermissions: [],
          }),
          lookupToken: async () => null,
          touchSession: async () => true,
          touchToken: async () => true,
        },
        tokenUse: { keyring: auth.keyring, nowMs: Date.now, dispatch: () => {}, log: () => {} },
        patValidation: patValidationGate,
        publicOrigin: auth.publicOrigin,
        providerAnchors: async () => [],
      }),
      log,
    });
    try {
      const kernel = await broker.ready();
      log.mockClear();
      const response = await kernel.fetch(
        new Request('https://broker.test/_pb/audit/head', {
          headers: { cookie: `__Host-pb_session=${'A'.repeat(43)}` },
        }),
      );
      expect(response.status).toBe(404);
      expect(
        log.mock.calls.flat().filter((entry) => entry.event === 'audit.effective_unavailable'),
      ).toHaveLength(1);
    } finally {
      await broker.close();
      await database.close();
    }
  });

  it('returns retryable audit_unavailable when org resolution fails transiently', async () => {
    const { database } = await fixture();
    const executor = { ...database.executor, all: vi.fn(database.executor.all) };
    const broker = createNodeServer([auditTrail()], {
      executor: executor as SqlExecutor,
      audit: { capacity },
      auditEnv: {},
      auth,
      log: () => {},
    });
    try {
      const kernel = await broker.ready();
      const original = database.executor.all;
      executor.all.mockImplementation((statement) => {
        if (statement.sql.includes('FROM audit_chain')) throw new Error('database unavailable');
        return original(statement);
      });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      const response = await kernel.fetch(new Request('https://broker.test/_pb/me'));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.json()).toMatchObject({ error: { code: 'audit_unavailable' } });
    } finally {
      vi.restoreAllMocks();
      await broker.close();
      await database.close();
    }
  });

  it('caches repeated download org resolution for at most 30 seconds, with separate org entries', async () => {
    const { database, org, foreign } = await fixture();
    const all = vi.fn(database.executor.all);
    const audit = await createNodeAudit({
      config: { platform: 'node', plugins: [trail], audit: { capacity } },
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

  it('serves a registered download route without rereading the audit chain on each request', async () => {
    const { database } = await fixture();
    const all = vi.fn(database.executor.all);
    const download: PluginDefinition = {
      id: 'download',
      package: '@test/download',
      apiVersion: 4,
      platforms: ['node'],
      register(registry) {
        registry.route({
          method: 'GET',
          path: '/fixture/archive.tgz',
          permission: null,
          handler: () => new Response('archive'),
        });
      },
    };
    const broker = createNodeServer([trail, download], {
      executor: { ...database.executor, all: all as SqlExecutor['all'] },
      audit: { capacity },
      auditGeneration: 7,
      auditEnv: {},
      log: () => {},
    });
    try {
      const kernel = await broker.ready();
      all.mockClear();
      for (let request = 0; request < 5; request++) {
        const response = await kernel.fetch(new Request('https://broker.test/fixture/archive.tgz'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('archive');
      }
      expect(
        all.mock.calls.filter(([query]) => query.sql.includes('FROM audit_chain')),
      ).toHaveLength(0);
    } finally {
      await broker.close();
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
      const audit = await createNodeAudit({
        config: { platform: 'node', plugins: [sink], audit: { capacity } },
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

  it.each(['availability', 'required'] as const)(
    'keeps a pending cutover under %s while fencing writes only for required',
    async (policy) => {
      const { database, org } = await fixture();
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = ?, head_seq = 7, pending_mode = 'none', cutover_seq = 5 WHERE org_id = ?",
          params: [policy, org.orgId],
        },
      ]);
      const write = vi.fn(() => new Response(null, { status: 204 }));
      const writer: PluginDefinition = {
        id: 'writer',
        package: '@test/writer',
        apiVersion: 4,
        platforms: ['node'],
        register(registry) {
          registry.route({
            method: 'POST',
            path: '/fixture/write',
            permission: null,
            handler: write,
          });
        },
      };
      const broker = createNodeServer([sink, writer], {
        executor: database.executor,
        audit: { capacity },
        auditEnv: { ARCHIVE_URL: env('ARCHIVE_URL'), ARCHIVE_HEADERS: env('ARCHIVE_HEADERS') },
        observability: { deploymentId: 'test', sink: { emit: () => {} } },
        auditPlatformPorts: {
          node: {
            blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
            cache: { adapter: 'lru', maxBytes: 33554432 },
            jobs: { adapter: 'database', maxRunning: 2 },
            observability: {
              adapter: 'stdio',
              deploymentIdEnv: 'DEPLOYMENT_ID',
              endpointEnv: 'ARCHIVE_URL',
            },
          },
        },
        log: () => {},
      });
      try {
        const kernel = await broker.ready();
        const response = await kernel.fetch(
          new Request('https://broker.test/fixture/write', { method: 'POST' }),
        );
        expect(response.status).toBe(policy === 'availability' ? 204 : 503);
        expect(write).toHaveBeenCalledTimes(policy === 'availability' ? 1 : 0);
        expect(
          await database.executor.all({
            sql: 'SELECT mode, pending_mode, cutover_seq FROM audit_chain WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([{ mode: 'trail', pending_mode: 'none', cutover_seq: 5 }]);
        expect(
          await database.executor.all({
            sql: 'SELECT kind FROM audit_ledger WHERE org_id = ?',
            params: [org.orgId],
          }),
        ).toEqual([]);
      } finally {
        await broker.close();
        await database.close();
      }
    },
  );

  it('caches definitive refusals per organization for 30 seconds and logs once per period', async () => {
    const { database, org, foreign } = await fixture();
    const all = vi.fn(database.executor.all);
    const log = vi.fn();
    const audit = await createNodeAudit({
      config: { platform: 'node', plugins: [], audit: { capacity } },
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
      expect(log).toHaveBeenCalledTimes(1);
      await expect(
        audit.resolveRequest(
          org,
          new Request('https://broker.test/_pb/projects', { method: 'POST' }),
        ),
      ).rejects.toMatchObject({ code: 'none_not_accepted', transient: false });
      await audit.resolveRequest(foreign, get());
      expect(all).toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(2);
      all.mockClear();
      now += 30_001;
      await audit.resolveRequest(org, get());
      expect(all).toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(3);
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
    const audit = await createNodeAudit({
      config: { platform: 'node', plugins: [trail], audit: { capacity } },
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

  it('keeps the process policy fallback when no audit environment is supplied', async () => {
    vi.stubEnv('PB_AUDIT_POLICY', 'required');
    expect(() => createNodeServer([], { log: () => {} })).toThrow(
      expect.objectContaining({ code: 'journal_budget_required' }),
    );
  });

  it('bounds the boot frontier probe even when the sink ignores its signal', async () => {
    const database = await openMigratedDatabase();
    await createOrganizationBootstrap(database.executor).bootstrap({
      id: ulid(),
      slug: 'audit',
      name: 'Audit',
      now: new Date().toISOString(),
    });
    const frontier = vi.fn<NonNullable<ReturnType<AuditSinkDefinition['create']>['frontier']>>(
      () => new Promise<null>(() => {}),
    );
    const definition: PluginDefinition = {
      ...sink,
      auditSinks: [
        {
          ...sink.auditSinks![0]!,
          create: () => ({
            deliver: async () => ({ outcome: 'retry', code: 'network' }),
            frontier,
          }),
        },
      ],
    };
    const broker = createNodeServer([definition], {
      executor: database.executor,
      audit: { capacity },
      auditEnv: { ARCHIVE_URL: env('ARCHIVE_URL'), ARCHIVE_HEADERS: env('ARCHIVE_HEADERS') },
      observability: { deploymentId: 'test', sink: { emit: () => {} } },
      log: () => {},
    });
    try {
      const started = Date.now();
      await broker.ready();
      expect(frontier).toHaveBeenCalledOnce();
      expect(frontier.mock.calls[0]![1].aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await broker.close();
      await database.close();
    }
  });
});
