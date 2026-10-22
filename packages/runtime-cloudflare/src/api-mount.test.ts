import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import type { KernelOptions } from '@package-broker/core/kernel/kernel';
import type { RouteDefinition } from '@package-broker/core/plugin';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';

const built = vi.hoisted(() => ({
  modules: [] as Array<readonly RouteDefinition[]>,
  kernels: [] as KernelOptions[],
  drop: undefined as string | undefined,
}));

vi.mock('@package-broker/core/api/module', async (original) => {
  const actual = await original<typeof import('@package-broker/core/api/module')>();
  return {
    ...actual,
    createApiModule: (...args: Parameters<typeof actual.createApiModule>) => {
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

const bindings = Array.from({ length: 4 }, (_, index) => `AMDB${index}`);
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

describe('Workers management API mount', () => {
  beforeEach(() => {
    built.modules.length = 0;
    built.kernels.length = 0;
    built.drop = undefined;
  });

  it('answers an anonymous GET /_pb/me with the standard 401 envelope', async () => {
    const env = await environment();
    const worker = createWorker([], { log: () => undefined });
    const response = await worker.fetch(new Request(`${PUBLIC_URL}/_pb/me`), env);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(typeof body.error?.code).toBe('string');
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
