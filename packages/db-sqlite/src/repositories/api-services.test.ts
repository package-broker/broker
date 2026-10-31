import { auditTrail } from '../testing/audit-trail-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@package-broker/core/api/module';
import * as importCredentials from '@package-broker/core/import/credentials';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import { validateAuditBuild, resolveOrgAudit } from '@package-broker/core/audit/effective';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { AuditTrail, PluginDefinition } from '@package-broker/core/plugin';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { seedAuditJournal } from '../testing/audit-journal-fixture.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { apiContext, apiOptions } from '../testing/api-services-fixture.js';
import { createApiRoutes, type ApiRoutesOptions } from './api-services.js';

describe('shared API assembly', () => {
  let database: MigratedDatabase;
  let options: ApiRoutesOptions;
  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    options = apiOptions(database.executor);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database.close();
  });

  it.each(['node', 'cloudflare'] as const)(
    'mounts %s routes with shared access repositories and the supplied IP resolver',
    (runtime) => {
      const assemble = vi.spyOn(api, 'createApiModule');
      const clientIp = () => '203.0.113.10';
      const routes = createApiRoutes({ ...options, runtime, clientIp });
      expect(routes.some((route) => route.path === '/_pb/audit/head')).toBe(true);
      expect(routes.some((route) => route.path === '/_pb/import-runs')).toBe(false);
      const deps = assemble.mock.calls[0]![0];
      expect(deps.organization.organizations).toBe(options.access.repositories.organizations);
      expect(deps.organization.users).toBe(options.access.repositories.users);
      expect(deps.projects.projects).toBe(options.access.repositories.projects);
      expect(deps.access.grants).toBe(options.access.repositories.grants);
      expect(deps.servicePrincipals.principals).toBe(options.access.repositories.principals);
      expect(deps.organization.clientIp).toBe(clientIp);
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    'mounts import routes with the %s credential policy when blob storage is configured',
    (runtime) => {
      const credentials = vi.spyOn(importCredentials, 'createImportCredentialService');
      const routes = createApiRoutes({
        ...options,
        runtime,
        blob: {
          put: async () => {
            throw new Error('unexpected blob write');
          },
          get: async () => null,
          head: async () => null,
        },
      });
      expect(
        routes.some((route) => route.path === '/_pb/import-runs' && route.method === 'POST'),
      ).toBe(true);
      expect(credentials.mock.calls[0]![0].runtime).toBe(runtime);
    },
  );

  it('routes withheld export alerts through observability and the configured alert service', () => {
    const assemble = vi.spyOn(api, 'createApiModule');
    const log = vi.fn();
    const raise = vi.fn();
    createApiRoutes({
      ...options,
      observability: { log, counter: vi.fn(), histogram: vi.fn() },
      auditAlerts: { raise },
    });
    const org = database.orgs!.a;
    assemble.mock.calls[0]![0].auditExport!.alert(org);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'error',
      event: 'audit.delivery_loss',
      reason_code: 'audit.withheld',
    });
    expect(raise).toHaveBeenCalledExactlyOnceWith(org, 'withheld');
  });
  it('uses the explicitly supplied client IP resolver', () => {
    const assemble = vi.spyOn(api, 'createApiModule');
    const explicitClientIp = (): string | null => '203.0.113.11';
    createApiRoutes({ ...options, clientIp: explicitClientIp });
    expect(assemble.mock.calls[0]![0].organization.clientIp).toBe(explicitClientIp);
    expect(
      assemble.mock.calls[0]![0].organization.clientIp(
        new Request('https://broker.test', {
          headers: { 'cf-connecting-ip': '203.0.113.11' },
        }),
      ),
    ).toBe('203.0.113.11');
  });

  it('returns unavailable without a composed trail, including a missing organization', async () => {
    const route = createApiRoutes(options).find((route) => route.path === '/_pb/audit/head')!;
    for (const org of [database.orgs!.a, null]) {
      const response = await route.handler(apiContext(org, route.path));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'audit_trail_unavailable' } });
    }
  });

  it.each(['node', 'cloudflare'] as const)(
    'dispatches a composed trail under %s only when effective activation is on',
    async (runtime) => {
      const handle = vi.fn<AuditTrail['handle']>(async (...args) =>
        args[0] === 'auditHead'
          ? { seq: 0, hash: AUDIT_GENESIS_HASH, pendingCount: 0, lastVerifiedAt: null }
          : { items: [], next: null },
      );
      const plugin: PluginDefinition = {
        id: 'trail',
        package: '@test/trail',
        apiVersion: 4,
        platforms: ['node', 'cloudflare'],
        binds: ['audit-trail'],
        auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create: () => ({ handle }) },
      };
      const registration = collectRegistrations([plugin]);
      for (const toggle of ['off', 'on']) {
        const build = validateAuditBuild(
          {
            platform: runtime,
            plugins: [plugin],
            audit: { acceptNoDurableAudit: true, capacity: { maxJournalBytes: 67108864 } },
          },
          (name) => (name === 'PB_AUDIT_TRAIL' ? toggle : undefined),
          runtime,
        );
        const result = resolveOrgAudit({
          build,
          storedPolicy: null,
          sinks: [],
          alertPathActive: false,
        });
        if (!result.ok) throw new Error('Expected effective audit');
        const routes = createApiRoutes({
          ...options,
          runtime,
          registration,
          auditTrail: {
            effective: async () => result.effective,
            services: { journal: { list: vi.fn(), head: vi.fn() }, requestVerification: vi.fn() },
          },
        });
        for (const path of ['/_pb/audit', '/_pb/audit/head', '/_pb/projects/:project/audit']) {
          const route = routes.find((route) => route.path === path)!;
          const response = await route.handler({
            ...apiContext(database.orgs!.a, path.replace(':project', 'demo')),
            projectId: 'project-a',
            params: { project: 'demo' },
          });
          expect(response.status).toBe(toggle === 'on' ? 200 : 404);
        }
        expect(handle).toHaveBeenCalledTimes(toggle === 'on' ? 3 : 0);
      }
    },
  );

  it('refuses verification without platform services with a fixed code', async () => {
    const assemble = vi.spyOn(api, 'createApiModule');
    const registration = collectRegistrations([
      {
        id: 'trail',
        package: '@test/trail',
        apiVersion: 4,
        platforms: ['node'],
        binds: ['audit-trail'],
        auditTrail: { create: () => ({ handle: async () => ({ items: [], next: null }) }) },
      },
    ]);
    createApiRoutes({ ...options, registration });
    await expect(
      assemble.mock.calls[0]![0].auditTrail!.services.requestVerification(database.orgs!.a),
    ).rejects.toMatchObject({
      code: 'audit_verification_unavailable',
      message: 'audit_verification_unavailable',
    });
  });

  it('keeps a composed trail fenced when effective configuration is unavailable', async () => {
    const create = vi.fn();
    const registration = collectRegistrations([
      {
        id: 'trail',
        package: '@test/trail',
        apiVersion: 4,
        platforms: ['node'],
        binds: ['audit-trail'],
        auditTrail: { create },
      },
    ]);
    const log = vi.fn();
    const route = createApiRoutes({ ...options, registration, log }).find(
      (route) => route.path === '/_pb/audit',
    )!;
    expect((await route.handler(apiContext(database.orgs!.a, route.path))).status).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect(
      log.mock.calls.filter(([record]) => record.event === 'audit.effective_unavailable'),
    ).toEqual([
      [
        {
          level: 'error',
          event: 'audit.effective_unavailable',
          reason_code: 'audit.effective_unavailable',
        },
      ],
    ]);
  });

  it('rejects malformed JSON before it can enter the journal', async () => {
    const org = database.orgs!.a;
    await seedAuditJournal(database.executor, org, 1);
    await expect(
      database.executor.batch([
        {
          sql: 'UPDATE audit_event SET payload_json = ? WHERE org_id = ? AND seq = 1',
          params: ['{', org.orgId],
        },
      ]),
    ).rejects.toMatchObject({ kind: 'check' });
  });

  it.each([
    'null',
    '[]',
    JSON.stringify({
      op_id: 'invalid',
      request_id: 'invalid',
      changes: { name: { new: 'private@example.test' } },
    }),
    JSON.stringify({ unexpected: 'private' }),
    JSON.stringify({ op_id: 'invalid', request_id: 'invalid', secret: 'private' }),
    JSON.stringify({
      op_id: 'invalid',
      request_id: 'invalid',
      changes: { password: { new: 'private' } },
    }),
    JSON.stringify({ op_id: 'invalid', request_id: 'invalid', extra: 'x'.repeat(4096) }),
  ])(
    'serves withheld trail items and decimal cursors for unsafe stored content (%#)',
    async (payload) => {
      const org = database.orgs!.a;
      await seedAuditJournal(database.executor, org, 3);
      await database.executor.batch([
        {
          sql: 'UPDATE audit_event SET payload_json = ? WHERE org_id = ? AND seq = 1',
          params: [payload, org.orgId],
        },
      ]);
      const routes = createApiRoutes({
        ...options,
        registration: collectRegistrations([auditTrail()]),
        auditTrail: { effective: async () => ({ policy: 'availability', trailActive: true }) },
      });
      for (const project of [false, true]) {
        const path = project ? '/_pb/projects/:project/audit' : '/_pb/audit';
        const route = routes.find((route) => route.path === path)!;
        const context = {
          ...apiContext(org, path.replace(':project', 'demo') + '?limit=1'),
          ...(project ? { projectId: 'project-a', params: { project: 'demo' } } : {}),
        };
        const response = await route.handler(context);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: unknown[]; next: string };
        expect(body).toEqual({
          items: [{ kind: 'withheld', id: expect.any(String), seq: 1, reason: 'content' }],
          next: '1',
        });
        const next = await route.handler({
          ...context,
          request: new Request(context.request.url + '&after=' + body.next),
        });
        expect(await next.json()).toMatchObject({ items: [{ seq: project ? 3 : 2 }] });
      }
    },
  );

  it('isolates the default composed trail journal services by organization', async () => {
    const { a, b } = database.orgs!;
    await seedAuditJournal(database.executor, a, 2);
    await seedAuditJournal(database.executor, b, 3);
    const seen: { orgId: string; ids: string[] }[] = [];
    const registration = collectRegistrations([
      {
        id: 'trail',
        package: '@test/trail',
        apiVersion: 4,
        platforms: ['node'],
        binds: ['audit-trail'],
        auditTrail: {
          create: (ctx) => ({
            async handle() {
              const page = await ctx.journal.list({ projectId: null, limit: 50 });
              seen.push({
                orgId: page.items[0]!.orgId,
                ids: page.items.map((item) => ('id' in item ? item.id : item.markerId)),
              });
              return { items: [], next: null };
            },
          }),
        },
      },
    ]);
    const route = createApiRoutes({
      ...options,
      registration,
      auditTrail: { effective: async () => ({ policy: 'availability', trailActive: true }) },
    }).find((route) => route.path === '/_pb/audit')!;
    for (const org of [a, b, a]) {
      expect((await route.handler(apiContext(org, route.path))).status).toBe(200);
      const expected = await database.executor.all<{ id: string }>({
        sql: 'SELECT id FROM audit_event WHERE org_id = ? ORDER BY seq',
        params: [org.orgId],
      });
      expect(seen.at(-1)).toEqual({ orgId: org.orgId, ids: expected.map((row) => row.id) });
    }
  });

  it.each([false, true])('counts unreadable records with composed trail %s', async (composed) => {
    const org = database.orgs!.a;
    await seedAuditJournal(database.executor, org, 1);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_event SET action = ? WHERE org_id = ? AND seq = 1',
        params: ['unknown.action', org.orgId],
      },
    ]);
    const counter = vi.fn();
    const registration = collectRegistrations([
      {
        id: 'trail',
        package: '@test/trail',
        apiVersion: 4,
        platforms: ['node'],
        binds: ['audit-trail'],
        auditTrail: {
          create: (ctx) => ({
            async handle() {
              const page = await ctx.journal.list({ projectId: null, limit: 50 });
              expect(page.items).toMatchObject([{ kind: 'withheld', reasonCode: 'unreadable' }]);
              return { items: [], next: null };
            },
          }),
        },
      },
    ]);
    const route = createApiRoutes({
      ...options,
      observability: { log: vi.fn(), counter, histogram: vi.fn() },
      ...(composed
        ? {
            registration,
            auditTrail: {
              effective: async () => ({ policy: 'availability' as const, trailActive: true }),
            },
          }
        : {}),
    }).find((route) => route.path === '/_pb/audit')!;
    const response = await route.handler(apiContext(org, route.path));
    expect(response.status).toBe(composed ? 200 : 404);
    if (composed) {
      expect(counter).toHaveBeenCalledExactlyOnceWith('pb.audit.journal_unreadable');
    } else {
      expect(await response.json()).toMatchObject({ error: { code: 'audit_trail_unavailable' } });
      expect(counter).not.toHaveBeenCalled();
    }
  });

  it('converts typed dependency failures to configuration errors', () => {
    vi.spyOn(api, 'createApiModule').mockImplementationOnce(() => {
      throw new api.ApiModuleDependencyError('dependencies.audit.head');
    });
    expect(() => createApiRoutes(options)).toThrow(KernelConfigError);
  });

  it('preserves unrelated TypeErrors even when they have the old dependency prefix', () => {
    const error = new TypeError('API module requires dependency: unrelated failure');
    vi.spyOn(api, 'createApiModule').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => createApiRoutes(options)).toThrow(error);
  });
});
