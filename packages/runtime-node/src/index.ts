import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';

export interface NodeServerOptions {
  readonly executor?: SqlExecutor;
  readonly closeDatabase?: () => Promise<void>;
  readonly log?: KernelLog;
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

  const kernel = createKernel({
    platform: 'node',
    plugins,
    ports,
    resolveOrg: createOrgResolver({ findSingleton: bootstrap.findSingleton }),
    health: async () => (await bootstrap.findSingleton()) !== null,
    log,
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
  });
  kernel.catch(() => undefined);

  const server = createServer(
    getRequestListener((request) =>
      kernel.then(
        (ready) => ready.fetch(request),
        (error: unknown) => errorResponse(error, crypto.randomUUID(), log),
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
