import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';
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
import { createD1Executor } from './db/d1-executor.js';
import type { D1DatabaseLike } from './db/d1-executor.js';

export interface Env {
  readonly DB?: D1DatabaseLike;
}

export interface WorkerOptions {
  readonly log?: KernelLog;
  readonly authorization?: AuthorizationEngine;
}

export interface Worker {
  readonly plugins: readonly PluginDefinition[];
  fetch(request: Request, env?: Env): Promise<Response>;
}

export function unboundExecutor(): ScalarSqlExecutor {
  const reject = (): Promise<never> =>
    Promise.reject(new DbError('unknown', 'no DB binding', { cause: null }));

  return {
    driver: 'none',
    all: reject,
    batch: reject,
  };
}

export function createWorker(
  plugins: readonly PluginDefinition[],
  options: WorkerOptions = {},
): Worker {
  const log = options.log ?? defaultLog;
  const kernels = new WeakMap<D1DatabaseLike, Promise<Kernel>>();
  let unbound: Promise<Kernel> | undefined;

  async function build(db: D1DatabaseLike | undefined): Promise<Kernel> {
    const executor: ScalarSqlExecutor = db === undefined ? unboundExecutor() : createD1Executor(db);
    const bootstrap = createOrganizationBootstrap(executor);
    const repository = createOrganizationRepository(executor);
    const ports: PluginPorts = {
      organizations: Object.freeze({ get: (ctx: OrgContext) => repository.get(ctx) }),
      clock: systemClock,
      ids: { ulid },
    };

    return createKernel({
      platform: 'cloudflare',
      plugins,
      ports,
      resolveOrg: createOrgResolver(bootstrap),
      health: async () => (await bootstrap.findSingleton()) !== null,
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      log,
    });
  }

  function kernelFor(db: D1DatabaseLike | undefined): Promise<Kernel> {
    const cached = db === undefined ? unbound : kernels.get(db);
    if (cached !== undefined) return cached;

    const pending = build(db).catch((error: unknown) => {
      if (db === undefined) unbound = undefined;
      else kernels.delete(db);
      throw error;
    });

    if (db === undefined) unbound = pending;
    else kernels.set(db, pending);
    return pending;
  }

  return {
    plugins,
    async fetch(request: Request, env?: Env): Promise<Response> {
      const requestId = crypto.randomUUID();
      let kernel: Kernel;
      try {
        kernel = await kernelFor(env?.DB);
      } catch (error) {
        return errorResponse(error, requestId, log);
      }
      try {
        return await kernel.fetch(request);
      } catch (error) {
        return errorResponse(error, requestId, log);
      }
    },
  };
}
