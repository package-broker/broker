import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createAuthModule } from '@package-broker/core/auth/module';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { scopedEnv, buildIdentityProviders } from '@package-broker/core/identity/providers';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import type { Kernel, KernelObservability } from '@package-broker/core/kernel/kernel';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, PluginPorts, RouteDefinition } from '@package-broker/core/plugin';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createAuthRepositories } from '@package-broker/db-sqlite/repositories/auth';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';

export interface NodeAuthOptions {
  readonly keyring: Keyring;
  readonly publicOrigin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface NodeServerOptions {
  readonly executor?: SqlExecutor;
  readonly auth?: NodeAuthOptions;
  readonly closeDatabase?: () => Promise<void>;
  readonly log?: KernelLog;
  readonly observability?: KernelObservability;
  readonly platformServices?: PlatformServices;
  readonly authorization?: AuthorizationEngine;
}

export interface NodeBroker {
  readonly plugins: readonly PluginDefinition[];
  readonly server: Server;
  ready(): Promise<Kernel>;
  close(): Promise<void>;
}

function rejectingExecutor(): SqlExecutor {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('no SQL executor configured for this runtime'));
  return { driver: 'node-sqlite', all: unavailable, batch: unavailable };
}

function authRoutes(
  registration: Registration,
  plugins: readonly PluginDefinition[],
  auth: NodeAuthOptions,
  executor: SqlExecutor,
  log: KernelLog,
): readonly RouteDefinition[] {
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) => fetch(request),
    clock: systemClock,
    env: scopedEnv(auth.env),
  });
  return createAuthModule({
    repositories: createAuthRepositories(executor),
    keyring: auth.keyring,
    clock: systemClock,
    ids: { ulid },
    publicOrigin: auth.publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
  }).coreRoutes;
}

export function createNodeServer(
  plugins: readonly PluginDefinition[],
  options: NodeServerOptions = {},
): NodeBroker {
  const log = options.log ?? defaultLog;
  const executor = options.executor ?? rejectingExecutor();

  const repository = createOrganizationRepository(executor);
  const bootstrap = createOrganizationBootstrap(executor);

  const ports: PluginPorts = Object.freeze({
    organizations: Object.freeze({ get: repository.get }),
    clock: systemClock,
    ids: { ulid },
  });

  const { auth } = options;
  const kernel = (async () => {
    const registration = collectRegistrations(plugins);
    return createKernel({
      platform: 'node',
      plugins,
      registration,
      ports,
      resolveOrg: createOrgResolver({ findSingleton: bootstrap.findSingleton }),
      health: async () => (await bootstrap.findSingleton()) !== null,
      log,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
      ...(options.platformServices === undefined
        ? {}
        : { platformServices: options.platformServices }),
      ...(auth === undefined
        ? {}
        : { coreRoutes: authRoutes(registration, plugins, auth, executor, log) }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    });
  })();
  kernel.catch(() => undefined);

  const server = createServer(
    getRequestListener((request) =>
      kernel.then(
        (ready) => ready.fetch(request),
        (error: unknown) => {
          const response = errorResponse(error, crypto.randomUUID(), log);
          return request.method === 'HEAD' ? new Response(null, response) : response;
        },
      ),
    ),
  );

  let closed = false;

  return {
    plugins,
    server,
    ready: () => kernel,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        if (server.listening) {
          const closing = new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          });
          server.closeIdleConnections();
          await closing;
        }
      } finally {
        await options.closeDatabase?.();
      }
    },
  };
}
