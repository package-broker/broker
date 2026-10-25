import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@package-broker/core/api/module';
import * as importCredentials from '@package-broker/core/import/credentials';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
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

  it('returns the genesis head for an empty organization and rejects a missing organization', async () => {
    const route = createApiRoutes(options).find((route) => route.path === '/_pb/audit/head')!;
    const response = await route.handler(apiContext(database.orgs!.a, route.path));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      seq: 0,
      hash: AUDIT_GENESIS_HASH,
      pendingCount: 0,
      lastVerifiedAt: null,
    });
    await expect(route.handler(apiContext(null, route.path))).rejects.toThrow(
      'route requires an organization context',
    );
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
