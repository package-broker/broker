import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import { createAuthModule } from '@package-broker/core/auth/module';
import type { AuthModule } from '@package-broker/core/auth/module';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { buildIdentityProviders, scopedEnv } from '@package-broker/core/identity/providers';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { SecretsConfigError, readMasterKeys } from '@package-broker/core/secrets/master-key';
import type { MasterKeyVariable } from '@package-broker/core/secrets/master-key';
import { createAuthRepositories } from '@package-broker/db-sqlite/repositories/auth';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor } from './db/d1-executor.js';
import type { D1DatabaseLike } from './db/d1-executor.js';

export type Env = {
  readonly DB?: D1DatabaseLike;
  readonly PB_MASTER_KEY?: string;
  readonly PB_MASTER_KEY_PREVIOUS?: string;
  readonly PB_PUBLIC_URL?: string;
  readonly [binding: `PB_IDP_${string}`]: string | undefined;
};

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

const PUBLIC_URL_VARIABLE = 'PB_PUBLIC_URL' as MasterKeyVariable;
const IDENTITY_FETCH_TIMEOUT_MS = 5000;

export function publicOriginOf(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw new SecretsConfigError('missing', PUBLIC_URL_VARIABLE);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecretsConfigError('malformed', PUBLIC_URL_VARIABLE);
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new SecretsConfigError('malformed', PUBLIC_URL_VARIABLE);
  }
  return url.origin;
}

async function buildAuth(
  executor: ScalarSqlExecutor,
  plugins: readonly PluginDefinition[],
  env: Env,
  log: KernelLog,
): Promise<{ auth: AuthModule; registration: Registration }> {
  const keyring = createKeyring(
    readMasterKeys({ current: env.PB_MASTER_KEY, previous: env.PB_MASTER_KEY_PREVIOUS }),
  );
  const publicOrigin = publicOriginOf(env.PB_PUBLIC_URL);
  await selfTestPasswordHashing(keyring);
  const registration = collectRegistrations(plugins);
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) =>
      fetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS)]),
      }),
    clock: systemClock,
    env: scopedEnv(env),
  });
  const auth = createAuthModule({
    repositories: createAuthRepositories(executor),
    keyring,
    clock: systemClock,
    ids: { ulid },
    publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
  });
  return { auth, registration };
}

function withoutBodyForHead(request: Request, response: Response): Response {
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

export function createWorker(
  plugins: readonly PluginDefinition[],
  options: WorkerOptions = {},
): Worker {
  const log = options.log ?? defaultLog;
  const kernels = new WeakMap<D1DatabaseLike, Promise<Kernel>>();
  let unbound: Promise<Kernel> | undefined;

  async function build(db: D1DatabaseLike | undefined, env: Env | undefined): Promise<Kernel> {
    const executor: ScalarSqlExecutor = db === undefined ? unboundExecutor() : createD1Executor(db);
    const bootstrap = createOrganizationBootstrap(executor);
    const repository = createOrganizationRepository(executor);
    const ports: PluginPorts = {
      organizations: Object.freeze({ get: (ctx: OrgContext) => repository.get(ctx) }),
      clock: systemClock,
      ids: { ulid },
    };

    const built = db === undefined ? undefined : await buildAuth(executor, plugins, env ?? {}, log);
    const registration = built?.registration ?? collectRegistrations(plugins);
    const auth = built?.auth;

    return createKernel({
      platform: 'cloudflare',
      plugins,
      registration,
      ports,
      resolveOrg: createOrgResolver(bootstrap),
      health: async () => (await bootstrap.findSingleton()) !== null,
      ...(auth === undefined ? {} : { coreRoutes: auth.coreRoutes }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      log,
    });
  }

  function kernelFor(db: D1DatabaseLike | undefined, env: Env | undefined): Promise<Kernel> {
    const cached = db === undefined ? unbound : kernels.get(db);
    if (cached !== undefined) return cached;

    const pending = build(db, env).catch((error: unknown) => {
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
        kernel = await kernelFor(env?.DB, env);
      } catch (error) {
        return withoutBodyForHead(request, errorResponse(error, requestId, log));
      }
      try {
        return await kernel.fetch(request);
      } catch (error) {
        return withoutBodyForHead(request, errorResponse(error, requestId, log));
      }
    },
  };
}
