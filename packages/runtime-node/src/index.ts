import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createAuthModule } from '@package-broker/core/auth/module';
import { deferredDispatch } from '@package-broker/core/authz/token-use';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  createProviderAnchorReader,
  type ProviderAnchorReader,
} from '@package-broker/core/identity/provider-anchors';
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

export interface NodeServices {
  readonly providerAnchors: ProviderAnchorReader;
  readonly dispatch: (run: () => Promise<void>) => void;
}

export interface NodeBroker {
  readonly plugins: readonly PluginDefinition[];
  readonly server: Server;
  ready(): Promise<Kernel>;
  /** The services of the application the server was built with. */
  services(): Promise<NodeServices>;
  close(): Promise<void>;
}

const NO_ANCHORS: ProviderAnchorReader = Object.freeze({
  anchors: () => Promise.resolve(Object.freeze([])),
});

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
): { readonly routes: readonly RouteDefinition[]; readonly providerAnchors: ProviderAnchorReader } {
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) => fetch(request),
    clock: systemClock,
    env: scopedEnv(auth.env),
  });
  const routes = createAuthModule({
    repositories: createAuthRepositories(executor),
    keyring: auth.keyring,
    clock: systemClock,
    ids: { ulid },
    publicOrigin: auth.publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
  }).coreRoutes;
  return { routes, providerAnchors: createProviderAnchorReader(providers) };
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
  const application = (async () => {
    const registration = collectRegistrations(plugins);
    const built =
      auth === undefined ? undefined : authRoutes(registration, plugins, auth, executor, log);
    const kernel = await createKernel({
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
      ...(built === undefined ? {} : { coreRoutes: built.routes }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    });
    const services: NodeServices = Object.freeze({
      providerAnchors: built?.providerAnchors ?? NO_ANCHORS,
      dispatch: deferredDispatch,
    });
    return { kernel, services };
  })();
  const kernel = application.then((built) => built.kernel);
  const services = application.then((built) => built.services);
  kernel.catch(() => undefined);
  services.catch(() => undefined);

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
    services: () => services,
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
