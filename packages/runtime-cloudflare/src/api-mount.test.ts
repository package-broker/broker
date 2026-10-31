import { sha256Hex } from '@package-broker/core/auth/primitives';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
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
    dependency: 'packageDetail',
    constructed: 'SQLite package detail repository and idempotency repository',
    routes: [
      'GET /_pb/projects/:project/packages/:package/readme',
      'PATCH /_pb/packages/:package/access',
    ],
    jobs: [],
    ownerPacket: 'NPM13a',
  },
  {
    dependency: 'packageAccessRequests',
    constructed: 'SQLite access request repository with provider anchors',
    routes: [
      'POST /_pb/projects/:project/package-access-requests',
      'GET /_pb/package-access-requests',
      'POST /_pb/package-access-requests/:id/approve',
      'POST /_pb/package-access-requests/:id/reject',
      'GET /_pb/projects/:project/requestable-packages',
    ],
    jobs: ['package-access-expire'],
    ownerPacket: 'NPM12',
  },
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
    dependency: 'npmLogin',
    constructed: 'npm login repository and personal token service',
    routes: ['GET /_pb/me/npm-login/:selector', 'POST /_pb/me/npm-login/:selector'],
    jobs: ['npm-login-expire'],
    ownerPacket: 'NPM16',
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
      'POST /_pb/projects/:project/sources/:source/sync',
      'GET /_pb/sources',
      'POST /_pb/sources',
      'PATCH /_pb/sources/:source',
      'POST /_pb/sources/:source/accept-removal',
      'PUT /_pb/sources/:source/credential',
      'POST /_pb/sources/:source/pause',
      'POST /_pb/sources/:source/resume',
      'POST /_pb/sources/:source/sync',
    ],
    jobs: [],
    ownerPacket: 'T531',
  },
  {
    dependency: 'sourcePackages',
    constructed: 'source package request store, project-source reader and registry probe',
    routes: ['POST /_pb/projects/:project/sources/:source/packages'],
    jobs: [],
    ownerPacket: 'T1041',
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
      'PATCH /_pb/sources/:source/names/:name',
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
    dependency: 'publishes',
    constructed: 'publishes repository',
    routes: [
      'GET /_pb/publishes',
      'GET /_pb/publishes/:id',
      'POST /_pb/publishes/:id/approve',
      'POST /_pb/publishes/:id/reject',
    ],
    jobs: [],
    ownerPacket: 'NPM10',
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
    expect(entry.ownerPacket).toBe(
      entry.dependency === 'packageDetail'
        ? 'NPM13a'
        : entry.dependency === 'publishes'
          ? 'NPM10'
          : entry.dependency === 'sourcePackages'
            ? 'T1041'
            : entry.dependency === 'npmLogin'
              ? 'NPM16'
              : entry.dependency === 'packageAccessRequests'
                ? 'NPM12'
                : 'T531',
    );
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

  it('reads a README through the mounted package boundary', async () => {
    const env = await environment();
    const worker = createWorker([], { log: () => undefined });
    await worker.services(env);
    const request = await seedReadme(createD1Executor(env.DB as unknown as D1DatabaseLike));
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      filename: 'README.md',
      body: '# Mounted',
      contentType: 'text/markdown',
      sizeBytes: 9,
    });
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

  it('mounts public npm login routes without registry services', async () => {
    await mountedAfter(createWorker([], { log: () => undefined }), await environment());
    expect(
      built.kernels.at(-1)?.ecosystemRoutes?.map((route) => `${route.method} ${route.path}`),
    ).toEqual(
      expect.arrayContaining([
        'POST /:project/npm/-/v1/login',
        'GET /:project/npm/-/v1/done/:session',
      ]),
    );
  });

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

async function seedReadme(executor: import('@package-broker/core/db/port').SqlExecutor) {
  const [org] = await executor.all<{ id: string }>({
    sql: 'SELECT id FROM organization',
    params: [],
  });
  const orgId = org!.id;
  const packageId = ulid(),
    versionId = ulid(),
    projectId = ulid(),
    sourceId = ulid(),
    userId = ulid(),
    roleId = ulid(),
    credentialId = ulid();
  const secret = 'R'.repeat(43);
  const rows: Array<[string, ...import('@package-broker/core/db/port').Statement['params']]> = [
    ["INSERT INTO project (id,org_id,slug,name) VALUES (?,?,'readme','Readme')", projectId, orgId],
    [
      "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES (?,?,'Readme','npm','hosted')",
      sourceId,
      orgId,
    ],
    [
      "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES (?,?,?,'npm','readme-widget')",
      packageId,
      orgId,
      sourceId,
    ],
    [
      'INSERT INTO project_source (org_id,project_id,source_id) VALUES (?,?,?)',
      orgId,
      projectId,
      sourceId,
    ],
    [
      "INSERT INTO project_package (org_id,project_id,package_id,ecosystem,name,origin) VALUES (?,?,?,'npm','readme-widget','subscription')",
      orgId,
      projectId,
      packageId,
    ],
    [
      "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,status) VALUES (?,?,?,'1.0.0','1.0.0','2026-01-01T00:00:00Z','import_time','{}','active')",
      versionId,
      orgId,
      packageId,
    ],
    [
      "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,?,'latest',?)",
      orgId,
      packageId,
      versionId,
    ],
    [
      "INSERT INTO version_readme (org_id,version_id,filename,body) VALUES (?,?,'README.md','# Mounted')",
      orgId,
      versionId,
    ],
    [
      "INSERT INTO user_account (id,org_id,email) VALUES (?,?,'readme@example.test')",
      userId,
      orgId,
    ],
    [
      "INSERT INTO credential (id,org_id,kind,ciphertext,nonce,key_version,aad) VALUES (?,?,'totp',X'00',zeroblob(12),1,'test')",
      credentialId,
      orgId,
    ],
    [
      "INSERT INTO local_login (user_id,org_id,password_hash,totp_credential_id,totp_enabled_at) VALUES (?,?,'pbkdf2-sha256$test',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      userId,
      orgId,
      credentialId,
    ],
    [
      "INSERT INTO role (id,org_id,key,name,scope,protects_last_holder) VALUES (?,?,'readme_admin','Readme admin','organization',1)",
      roleId,
      orgId,
    ],
    ...['project:read', 'project:packages:read'].map(
      (permission) =>
        [
          'INSERT INTO role_permission (org_id,role_id,permission) VALUES (?,?,?)',
          orgId,
          roleId,
          permission,
        ] as [string, ...import('@package-broker/core/db/port').Statement['params']],
    ),
    [
      "INSERT INTO access_grant (id,org_id,role_id,scope,subject_type,subject_value) VALUES (?,?,?,'organization','email','readme@example.test')",
      ulid(),
      orgId,
      roleId,
    ],
    [
      "INSERT INTO session (id,org_id,user_id,secret_hash,csrf_hash,expires_at,last_seen_at) VALUES (?,?,?,?,?,'2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ulid(),
      orgId,
      userId,
      await sha256Hex(secret),
      'b'.repeat(64),
    ],
  ];
  await executor.batch(rows.map(([sql, ...params]) => ({ sql, params })));
  return new Request(`https://broker.test/_pb/projects/readme/packages/${packageId}/readme`, {
    headers: { cookie: `${SESSION_COOKIE}=${secret}` },
  });
}
