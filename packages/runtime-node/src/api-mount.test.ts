import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createNodeServer, type NodeBroker } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const built = vi.hoisted(() => ({
  routes: [] as Array<readonly RouteDefinition[]>,
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

describe('Node management API mount', () => {
  let db: MigratedDatabase;
  let broker: NodeBroker | undefined;

  beforeEach(async () => {
    built.routes.length = 0;
    built.drop = undefined;
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

  const create = (): NodeBroker =>
    (broker = createNodeServer([], {
      executor: db.executor,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      log: () => undefined,
    }));

  it('answers an anonymous GET /_pb/me with the standard 401 envelope', async () => {
    const kernel = await create().ready();
    const response = await kernel.fetch(new Request('https://broker.test/_pb/me'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(typeof body.error?.code).toBe('string');
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
