import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiModuleDeps } from '@package-broker/core/api/module';
import type { RouteDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { ulid } from '@package-broker/core/ids';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createNodeServer, type NodeBroker } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const built = vi.hoisted(() => ({
  routes: [] as Array<readonly RouteDefinition[]>,
  dependencies: [] as ApiModuleDeps[],
  drop: undefined as string | undefined,
  policies: [] as unknown[],
}));

vi.mock('@package-broker/core/sources/source-service', async (original) => {
  const actual = await original<typeof import('@package-broker/core/sources/source-service')>();
  return {
    ...actual,
    createSourceService: (...args: Parameters<typeof actual.createSourceService>) => {
      built.policies.push(args[0].policy);
      return actual.createSourceService(...args);
    },
  };
});

vi.mock('@package-broker/core/api/module', async (original) => {
  const actual = await original<typeof import('@package-broker/core/api/module')>();
  return {
    ...actual,
    createApiModule: (...args: Parameters<typeof actual.createApiModule>) => {
      built.dependencies.push(args[0]);
      const module = actual.createApiModule(...args);
      built.routes.push(module.routes);
      return module;
    },
  };
});

vi.mock('@package-broker/db-sqlite/repositories/access-services', async (original) => {
  const actual =
    await original<typeof import('@package-broker/db-sqlite/repositories/access-services')>();
  return {
    ...actual,
    createAccessServices: (...args: Parameters<typeof actual.createAccessServices>) => {
      const assembly = actual.createAccessServices(...args);
      if (built.drop === undefined) return assembly;
      return { ...assembly, services: { ...assembly.services, [built.drop]: undefined } };
    },
  };
});

interface ManagementAssemblyEntry {
  readonly dependency: keyof ApiModuleDeps;
  readonly constructed: string;
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
  readonly ownerPacket: string;
}

const MANAGEMENT_ASSEMBLY: readonly ManagementAssemblyEntry[] = [
  {
    dependency: 'organization',
    constructed: 'organization and user repositories; access administration',
    routes: ['GET /_pb/me', 'GET /_pb/organization', 'GET /_pb/users', 'PATCH /_pb/users/:user'],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'projects',
    constructed: 'project repository, project list and project service; idempotency repository',
    routes: [
      'GET /_pb/projects',
      'POST /_pb/projects',
      'GET /_pb/projects/:project',
      'PATCH /_pb/projects/:project',
      'POST /_pb/projects/:project/archive',
      'POST /_pb/projects/:project/restore',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'access',
    constructed: 'access administration and grant repository; kernel authorization engine',
    routes: [
      'GET /_pb/grants',
      'POST /_pb/grants',
      'DELETE /_pb/grants/:grant',
      'PATCH /_pb/grants/:grant',
      'GET /_pb/roles',
      'POST /_pb/roles',
      'DELETE /_pb/roles/:role',
      'PATCH /_pb/roles/:role',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'projectAccess',
    constructed: 'project grant administration and reader; role reader',
    routes: [
      'GET /_pb/projects/:project/grants',
      'POST /_pb/projects/:project/grants',
      'DELETE /_pb/projects/:project/grants/:grant',
      'PATCH /_pb/projects/:project/grants/:grant',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'tokens',
    constructed:
      'personal/service token services, token revoke/list, sessions; idempotency repository',
    routes: [
      'GET /_pb/me/tokens',
      'POST /_pb/me/tokens',
      'DELETE /_pb/me/tokens/:token',
      'GET /_pb/me/tokens/:token',
      'GET /_pb/projects/:project/tokens',
      'POST /_pb/projects/:project/tokens',
      'DELETE /_pb/projects/:project/tokens/:token',
      'GET /_pb/projects/:project/tokens/:token',
      'POST /_pb/projects/:project/tokens/:token/rotate',
      'GET /_pb/tokens',
      'POST /_pb/tokens',
      'DELETE /_pb/tokens/:token',
      'GET /_pb/tokens/:token',
      'POST /_pb/tokens/:token/rotate',
    ],
    jobs: ['pat-offboarding', 'pat-offboarding-sweep'],
    ownerPacket: 'T531',
  },
  {
    dependency: 'servicePrincipals',
    constructed: 'service principal service and repository',
    routes: [
      'PUT /_pb/projects/:project/service-principals/:principal/permissions',
      'POST /_pb/projects/:project/service-principals/:principal/restore',
      'POST /_pb/projects/:project/service-principals/:principal/suspend',
      'GET /_pb/service-principals',
      'POST /_pb/service-principals',
      'GET /_pb/service-principals/:principal',
      'PUT /_pb/service-principals/:principal/permissions',
      'POST /_pb/service-principals/:principal/restore',
      'POST /_pb/service-principals/:principal/suspend',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'sources',
    constructed: 'source service and repository, project-source reader, projects and sessions',
    routes: [
      'GET /_pb/projects/:project/sources',
      'POST /_pb/projects/:project/sources',
      'PATCH /_pb/projects/:project/sources/:source',
      'PUT /_pb/projects/:project/sources/:source/credential',
      'POST /_pb/projects/:project/sources/:source/pause',
      'POST /_pb/projects/:project/sources/:source/resume',
      'GET /_pb/sources',
      'POST /_pb/sources',
      'PATCH /_pb/sources/:source',
      'POST /_pb/sources/:source/accept-removal',
      'PUT /_pb/sources/:source/credential',
      'POST /_pb/sources/:source/pause',
      'POST /_pb/sources/:source/resume',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'sourceNames',
    constructed: 'source service, registered-name repository and catalogue visibility',
    routes: [
      'GET /_pb/projects/:project/resolve',
      'PUT /_pb/projects/:project/sources/order',
      'POST /_pb/sources/:source/enable',
      'GET /_pb/sources/:source/names',
      'POST /_pb/sources/:source/names',
      'DELETE /_pb/sources/:source/names/:name',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'sourceAttachments',
    constructed: 'source repository, catalogue visibility, project-source reader and projects',
    routes: [
      'DELETE /_pb/projects/:project/sources/:source/attachment',
      'PUT /_pb/projects/:project/sources/:source/attachment',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'packages',
    constructed: 'package admin reader and vulnerability status reader',
    routes: [
      'GET /_pb/packages',
      'GET /_pb/packages/:package/versions',
      'GET /_pb/projects/:project/packages',
      'GET /_pb/projects/:project/packages/:package/versions',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'audit',
    constructed: 'audit query repository adapter',
    routes: ['GET /_pb/audit', 'GET /_pb/audit/head', 'GET /_pb/projects/:project/audit'],
    jobs: ['audit-seal', 'audit-verify'],
    ownerPacket: 'T531',
  },
  {
    dependency: 'packageManage',
    constructed: 'package manage service over admin reader, visibility store and sessions',
    routes: [
      'POST /_pb/packages/:package/versions/:version/quarantine',
      'POST /_pb/packages/:package/versions/:version/release',
      'POST /_pb/packages/:package/versions/:version/tombstone',
      'POST /_pb/projects/:project/packages/:package/versions/:version/quarantine',
      'POST /_pb/projects/:project/packages/:package/versions/:version/release',
      'POST /_pb/projects/:project/packages/:package/versions/:version/tombstone',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'imports',
    constructed: 'import run service/store, import credential service/repository and blob store',
    routes: [
      'GET /_pb/import-runs',
      'POST /_pb/import-runs',
      'GET /_pb/import-runs/:id',
      'POST /_pb/import-runs/:id/accept',
      'POST /_pb/import-runs/:id/apply',
      'POST /_pb/import-runs/:id/approve',
      'POST /_pb/import-runs/:id/cancel',
      'PUT /_pb/import-runs/:id/credentials/:externalRef',
      'POST /_pb/import-runs/:id/rollback',
      'POST /_pb/import-runs/:id/verify',
    ],
    jobs: ['import-verify', 'import-apply', 'import-rollback'],
    ownerPacket: 'T531',
  },
  {
    dependency: 'access',
    constructed: 'kernel authorization engine via access services',
    routes: ['GET /_pb/me/permissions', 'GET /_pb/projects/:project/permissions'],
    jobs: [],
    ownerPacket: 'T531',
  },
];

function assertManagementAssembly(mounted: readonly RouteDefinition[], jobs: readonly string[]) {
  expect(built.dependencies).toHaveLength(1);
  const deps = built.dependencies[0]!;
  const entries = MANAGEMENT_ASSEMBLY;
  const documented = entries.flatMap((entry) => entry.routes);
  const actual = built.routes[0]!.map((route) => `${route.method} ${route.path}`);
  expect(documented.sort()).toEqual(actual.sort());
  const mountedKeys = mounted.map((route) => `${route.method} ${route.path}`);
  for (const entry of entries) {
    expect(deps[entry.dependency], entry.constructed).toBeDefined();
    expect(entry.ownerPacket).toBe('T531');
    for (const key of entry.routes) {
      expect(
        mountedKeys.filter((candidate) => candidate === key),
        key,
      ).toHaveLength(1);
    }
    for (const job of entry.jobs) {
      expect(
        jobs.filter((candidate) => candidate === job),
        job,
      ).toHaveLength(1);
    }
  }
}

describe('Node management API mount', () => {
  let db: MigratedDatabase;
  let broker: NodeBroker | undefined;

  beforeEach(async () => {
    built.routes.length = 0;
    built.drop = undefined;
    built.dependencies.length = 0;
    built.policies.length = 0;
    db = await openMigratedDatabase();
    await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
    await db.close();
  });

  const create = (
    extra: {
      platformServices?: NonNullable<Parameters<typeof createNodeServer>[1]>['platformServices'];
      log?: KernelLog;
    } = {},
  ): NodeBroker =>
    (broker = createNodeServer([], {
      executor: db.executor,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      log: extra.log ?? (() => undefined),
      ...(extra.platformServices === undefined ? {} : { platformServices: extra.platformServices }),
    }));
  const platformServices = () => ({
    jobStore: createJobRepository(db.executor),
    blob: {
      head: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('unused');
      },
    },
    cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  });
  const mountedKeys = (kernel: Awaited<ReturnType<NodeBroker['ready']>>) =>
    kernel.coreRoutes.map((route) => `${route.method} ${route.path}`);

  it('refuses anonymous requests to every route in the API module table', async () => {
    const kernel = await create().ready();
    expect(built.routes).toHaveLength(1);
    const routes = built.routes[0]!;
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, '01J0A0000000000000000000000');
      const request = new Request(`https://broker.test${path}`, {
        method: route.method,
        headers: { origin: 'https://broker.test', 'content-type': 'application/json' },
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      });
      const response = await kernel.fetch(request);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: expect.any(String) } });
    }
  });

  it('mounts every management route exactly once', async () => {
    const kernel = await create().ready();
    expect(built.routes).toHaveLength(1);
    const expected = built.routes[0]!.map((route) => `${route.method} ${route.path}`);
    expect(expected.length).toBeGreaterThan(0);
    const mounted = kernel.coreRoutes.map((route) => `${route.method} ${route.path}`);
    for (const key of expected) {
      expect(
        mounted.filter((candidate) => candidate === key),
        key,
      ).toHaveLength(1);
    }
  });

  it('mounts the package manage routes without a rebuild route', async () => {
    const mounted = mountedKeys(await create().ready());
    for (const action of ['quarantine', 'tombstone', 'release']) {
      expect(mounted).toContain(`POST /_pb/packages/:package/versions/:version/${action}`);
      expect(mounted).toContain(
        `POST /_pb/projects/:project/packages/:package/versions/:version/${action}`,
      );
    }
    expect(mounted).not.toContain('POST /_pb/packages/:package/versions/:version/rebuild');
  });

  it('omits the import routes and logs the reason without a blob store', async () => {
    const records: unknown[] = [];
    const mounted = mountedKeys(await create({ log: (record) => records.push(record) }).ready());
    expect(mounted.filter((key) => key.includes('/_pb/import-runs'))).toEqual([]);
    expect(records).toContainEqual({
      level: 'info',
      event: 'api.import_routes_omitted',
      reason: 'blob_store_not_configured',
    });
  });

  it('mounts the import routes when a blob store is configured', async () => {
    const records: unknown[] = [];
    const mounted = mountedKeys(
      await create({
        platformServices: platformServices(),
        log: (record) => records.push(record),
      }).ready(),
    );
    const kernel = await broker!.ready();
    assertManagementAssembly(
      kernel.coreRoutes,
      kernel.registration.jobs.map((job) => job.definition.name),
    );
    expect(mounted).toContain('POST /_pb/import-runs');
    expect(mounted).toContain('PUT /_pb/import-runs/:id/credentials/:externalRef');
    expect(mounted.filter((key) => key.includes('/_pb/import-runs'))).toHaveLength(10);
    expect(records).not.toContainEqual(
      expect.objectContaining({ event: 'api.import_routes_omitted' }),
    );
  });

  it('fails before serving with a named error when a required dependency is missing', async () => {
    built.drop = 'tokenList';
    const error = await create()
      .ready()
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.name).toBe('KernelConfigError');
    expect(error?.message).toContain('API module requires dependency');
    expect(error?.message).not.toContain(KEY);
    expect(error?.message).not.toContain('broker.test');
  });

  it('builds the source service outbound policy from the registry config', async () => {
    const config = resolveRegistryConfig(
      { outbound: { allowPrivateHosts: ['mirror.internal'] } },
      'node',
      'https://broker.test',
    );
    broker = createNodeServer([], {
      executor: db.executor,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      registry: { config },
      log: () => undefined,
    });
    await broker.ready();
    expect(built.policies).toEqual([
      {
        allowPrivateHosts: config.outbound.allowPrivateHosts,
        runtime: 'node',
        selfOrigins: config.outbound.selfOrigins,
      },
    ]);
    expect(config.outbound.allowPrivateHosts).toEqual(['mirror.internal']);
  });
});
