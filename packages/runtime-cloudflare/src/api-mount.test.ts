import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import type { KernelOptions } from '@package-broker/core/kernel/kernel';
import type { ApiModuleDeps } from '@package-broker/core/api/module';
import type { RouteDefinition } from '@package-broker/core/plugin';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';

const built = vi.hoisted(() => ({
  modules: [] as Array<readonly RouteDefinition[]>,
  kernels: [] as KernelOptions[],
  dependencies: [] as ApiModuleDeps[],
  drop: undefined as string | undefined,
}));

vi.mock('@package-broker/core/api/module', async (original) => {
  const actual = await original<typeof import('@package-broker/core/api/module')>();
  return {
    ...actual,
    createApiModule: (...args: Parameters<typeof actual.createApiModule>) => {
      built.dependencies.push(args[0]);
      const module = actual.createApiModule(...args);
      built.modules.push(module.routes);
      return module;
    },
  };
});

vi.mock('@package-broker/core/kernel/kernel', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/kernel')>();
  return {
    ...actual,
    createKernel: (options: KernelOptions) => {
      built.kernels.push(options);
      return actual.createKernel(options);
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

const bindings = Array.from({ length: 8 }, (_, index) => `AMDB${index}`);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

async function environment(): Promise<Env> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(raw);
  await migrate(executor, await migrationSources(), { holder: 'api-mount-test' });
  await createOrganizationBootstrap(executor).bootstrap({
    id: ulid(),
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  return { DB: raw, PB_MASTER_KEY: KEY, PB_PUBLIC_URL: PUBLIC_URL } as unknown as Env;
}

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
  const actual = built.modules[0]!.map((route) => `${route.method} ${route.path}`);
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

describe('Workers management API mount', () => {
  beforeEach(() => {
    built.modules.length = 0;
    built.kernels.length = 0;
    built.drop = undefined;
    built.dependencies.length = 0;
  });

  it('refuses anonymous requests to every route in the API module table', async () => {
    const env = await environment();
    const worker = createWorker([], { log: () => undefined });
    await worker.services(env);
    expect(built.modules).toHaveLength(1);
    const routes = built.modules[0]!;
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, '01J0A0000000000000000000000');
      const request = new Request(`https://broker.test${path}`, {
        method: route.method,
        headers: { origin: 'https://broker.test', 'content-type': 'application/json' },
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      });
      const response = await worker.fetch(request, env);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: expect.any(String) } });
    }
  });

  it('mounts every management route exactly once', async () => {
    const env = await environment();
    const worker = createWorker([], { log: () => undefined });
    await worker.fetch(new Request(`${PUBLIC_URL}/_pb/me`), env);
    expect(built.modules).toHaveLength(1);
    const expected = built.modules[0]!.map((route) => `${route.method} ${route.path}`);
    expect(expected.length).toBeGreaterThan(0);
    const mounted = (built.kernels.at(-1)?.coreRoutes ?? []).map(
      (route) => `${route.method} ${route.path}`,
    );
    for (const key of expected) {
      expect(
        mounted.filter((candidate) => candidate === key),
        key,
      ).toHaveLength(1);
    }
  });

  const mountedAfter = async (worker: ReturnType<typeof createWorker>, env: Env) => {
    await worker.fetch(new Request(`${PUBLIC_URL}/_pb/me`), env);
    return (built.kernels.at(-1)?.coreRoutes ?? []).map((route) => `${route.method} ${route.path}`);
  };

  it('mounts the package manage routes without a rebuild route', async () => {
    const mounted = await mountedAfter(
      createWorker([], { log: () => undefined }),
      await environment(),
    );
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
    const worker = createWorker([], { log: (record) => records.push({ ...record }) });
    const mounted = await mountedAfter(worker, await environment());
    expect(mounted.filter((key) => key.includes('/_pb/import-runs'))).toEqual([]);
    expect(records).toContainEqual({
      level: 'info',
      event: 'api.import_routes_omitted',
      reason: 'blob_store_not_configured',
    });
  });

  it('mounts the import routes when a blob store is bound', async () => {
    const platformPorts: PlatformPortConfig = {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 4 * 1024 * 1024 },
      cache: { adapter: 'cache-api', namespace: 'api-mount' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
      observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
    };
    const unused = async () => {
      throw new Error('unused');
    };
    const env = {
      ...(await environment()),
      STORAGE: { head: unused, get: unused, put: unused, delete: unused },
      JOBS: { send: unused, sendBatch: unused },
      DEPLOYMENT_ID: 'api-mount',
    } as unknown as Env;
    const records: unknown[] = [];
    const worker = createWorker([], {
      platformPorts,
      cacheStorage: {
        open: async () => ({
          match: async () => undefined,
          put: async () => undefined,
          delete: async () => false,
        }),
      },
      log: (record) => records.push({ ...record }),
      console: { log: () => undefined, error: () => undefined },
    });
    const mounted = await mountedAfter(worker, env);
    const kernel = built.kernels.at(-1)!;
    assertManagementAssembly(
      kernel.coreRoutes ?? [],
      kernel.registration!.jobs.map((job) => job.definition.name),
    );
    expect(mounted.filter((key) => key.includes('/_pb/import-runs'))).toHaveLength(10);
    expect(records).not.toContainEqual(
      expect.objectContaining({ event: 'api.import_routes_omitted' }),
    );
  });

  it('fails before serving with a named error when a required dependency is missing', async () => {
    const env = await environment();
    built.drop = 'tokenList';
    const logged: Array<Record<string, unknown>> = [];
    const worker = createWorker([], { log: (entry) => logged.push({ ...entry }) });
    const failure = await worker.services(env).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(failure?.name).toBe('KernelConfigError');
    expect(failure?.message).toContain('API module requires dependency');
    expect(failure?.message).not.toContain(KEY);
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });
});
