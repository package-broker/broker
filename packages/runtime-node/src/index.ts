import { AUDIT_EVENTS } from '@package-broker/core/kernel/obs-codes';
import { createObservability } from '@package-broker/core/platform/observability';
import type { JobDefinition } from '@package-broker/core/platform/jobs';
import type { RegisteredCoreJob } from '@package-broker/core/kernel/registry';
import { auditSealJob } from '@package-broker/core/audit/sealer';
import { auditVerifyJob } from '@package-broker/core/audit/verify';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { createAuditVerifyReader } from '@package-broker/db-sqlite/repositories/audit-verify';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createAuthModule, type AuthModule } from '@package-broker/core/auth/module';
import type { SessionService } from '@package-broker/core/auth/session';
import {
  createPersonalTokenService,
  type PersonalTokenService,
} from '@package-broker/core/authz/pat-service';
import {
  createProjectAdministration,
  type ProjectAdministration,
} from '@package-broker/core/authz/project-administration';
import { createProjectLister, type ProjectLister } from '@package-broker/core/authz/project-list';
import { reservedFirstSegments } from '@package-broker/core/authz/project-path';
import {
  createProjectService,
  type ProjectService,
} from '@package-broker/core/authz/project-service';
import {
  createServicePrincipalService,
  type ServicePrincipalService,
} from '@package-broker/core/authz/service-principal-service';
import {
  createServiceTokenService,
  type ServiceTokenService,
} from '@package-broker/core/authz/service-token-service';
import type { TokenReader } from '@package-broker/core/authz/token-read';
import {
  createTokenRevokeService,
  type TokenRevokeService,
} from '@package-broker/core/authz/token-revoke';
import { deferredDispatch } from '@package-broker/core/authz/token-use';
import type { CatalogueReader } from '@package-broker/core/db/catalogue';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  providerAnchorsOf,
  type ConfiguredProviderAnchor,
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
import { collectRegistrations, registerCoreJob } from '@package-broker/core/kernel/registry';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createAccessRepository } from '@package-broker/db-sqlite/repositories/access';
import { createAuthRepositories } from '@package-broker/db-sqlite/repositories/auth';
import { createCatalogueReader } from '@package-broker/db-sqlite/repositories/catalogue-read';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';
import { createProjectRepository } from '@package-broker/db-sqlite/repositories/project';
import { createProjectGrantRepository } from '@package-broker/db-sqlite/repositories/project-grant';
import { createReadableProjectRepository } from '@package-broker/db-sqlite/repositories/project-readable';
import { createServicePrincipalRepository } from '@package-broker/db-sqlite/repositories/service-principal';
import { createServicePrincipalAuthority } from '@package-broker/db-sqlite/repositories/service-principal-authority';
import { createTokenRepository } from '@package-broker/db-sqlite/repositories/token';
import { createTokenReader } from '@package-broker/db-sqlite/repositories/token-read';
import { createUnlinkRepository } from '@package-broker/db-sqlite/repositories/unlink';

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

/** The step 5 domain services; PB-32 resolves each one from here. */
export interface NodeAccessServices {
  readonly engine: AuthorizationEngine;
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly projectGrants: ProjectAdministration;
  readonly projectList: ProjectLister;
  readonly personalTokens: PersonalTokenService;
  readonly servicePrincipals: ServicePrincipalService;
  readonly serviceTokens: ServiceTokenService;
  readonly tokenRevoke: TokenRevokeService;
  readonly tokenList: TokenReader;
}

export interface NodeServices {
  readonly providerAnchors: ProviderAnchorReader;
  readonly dispatch: (run: () => Promise<void>) => void;
  readonly catalogue: Pick<CatalogueReader, 'resolveVersions'>;
  /** Null when the runtime has no auth options. */
  readonly access: NodeAccessServices | null;
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

function wired<T>(name: string, value: T | undefined): T {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${name} is not wired`);
  }
  return value;
}

function anchorReader(list: readonly ConfiguredProviderAnchor[]): ProviderAnchorReader {
  return Object.freeze({ anchors: () => Promise.resolve(list) });
}

interface AccessAssembly {
  readonly module: AuthModule;
  readonly providerAnchors: ProviderAnchorReader;
  readonly services: NodeAccessServices;
}

async function assembleAccess(
  registration: Registration,
  plugins: readonly PluginDefinition[],
  auth: NodeAuthOptions,
  executor: SqlExecutor,
  log: KernelLog,
): Promise<AccessAssembly> {
  await auth.keyring.hmacKey('token-pepper', auth.keyring.currentVersion);
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) => fetch(request),
    clock: systemClock,
    env: scopedEnv(auth.env),
  });
  const anchorList = providerAnchorsOf(providers);
  const providerAnchors = anchorReader(anchorList);
  const ids = { ulid };

  const module = createAuthModule({
    repositories: createAuthRepositories(executor),
    keyring: auth.keyring,
    clock: systemClock,
    ids,
    publicOrigin: auth.publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
    access: {
      access: wired('access repository', createAccessRepository(executor)),
      providerAnchors: providerAnchors.anchors,
      dispatch: deferredDispatch,
    },
    unlink: {
      unlinks: wired(
        'unlink repository',
        createUnlinkRepository(executor, {
          holderInput: () => ({
            kind: 'fresh',
            now: systemClock.now().toISOString(),
            providers: anchorList,
          }),
        }),
      ),
      providers: providerAnchors,
    },
  });

  const projectRepository = wired(
    'project repository',
    createProjectRepository(executor, {
      reservedSlugs: reservedFirstSegments([...registration.routes, ...module.coreRoutes]),
      providerAnchors: anchorList,
    }),
  );
  const tokenRepository = wired('token repository', createTokenRepository(executor));
  const principalRepository = wired(
    'service principal repository',
    createServicePrincipalRepository(executor),
  );
  const authority = wired(
    'service principal authority',
    createServicePrincipalAuthority({ executor, providerAnchors: anchorList }),
  );
  const organizations = wired('organization repository', createOrganizationRepository(executor));
  const common = { clock: systemClock, ids, log };

  const services: NodeAccessServices = Object.freeze({
    engine: module.authorization,
    sessions: module.sessions,
    projects: createProjectService({ projects: projectRepository, ...common }),
    projectGrants: createProjectAdministration({
      grants: wired('project grant repository', createProjectGrantRepository(executor)),
      providers,
      providerAnchors: anchorList,
      ...common,
    }),
    projectList: createProjectLister({
      source: projectRepository,
      readable: wired(
        'readable project repository',
        createReadableProjectRepository(executor, { providerAnchors: anchorList }),
      ),
    }),
    personalTokens: createPersonalTokenService({
      tokens: tokenRepository,
      sessions: module.sessions,
      organizations,
      providers: providerAnchors,
      keyring: auth.keyring,
      ...common,
    }),
    servicePrincipals: createServicePrincipalService({
      principals: principalRepository,
      authority,
      directory: principalRepository,
      ...common,
    }),
    serviceTokens: createServiceTokenService({
      tokens: tokenRepository,
      principals: principalRepository,
      authority,
      sessions: module.sessions,
      organizations,
      providers: providerAnchors,
      keyring: auth.keyring,
      ...common,
    }),
    tokenRevoke: createTokenRevokeService({
      tokens: tokenRepository,
      authority,
      ownership: tokenRepository,
      clock: systemClock,
      log,
    }),
    tokenList: wired('token reader', createTokenReader(executor)),
  });
  return { module, providerAnchors, services };
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
    function registerAuditJob<P>(definition: JobDefinition<P>): RegisteredCoreJob {
      return registerCoreJob({
        ...definition,
        handler: (payload, context) =>
          definition.handler(definition.validate(payload), {
            ...context,
            observability: createObservability(
              options.observability?.sink ?? {
                emit: (record) => {
                  if (record.kind === 'log') log({ ...record.record });
                },
              },
              {
                deploymentId: options.observability?.deploymentId ?? 'unconfigured',
                runtime: 'node',
                requestId: null,
                plugin: 'core',
                jobId: context.jobId,
                attempt: context.attempt,
              },
              {
                events: AUDIT_EVENTS,
                reasonCodes: new Set(),
                routeTemplates: new Set(),
              },
            ),
          }),
      });
    }
    const registration = collectRegistrations(plugins, {
      coreJobs:
        options.platformServices === undefined
          ? []
          : [
              registerAuditJob(auditSealJob(createAuditSealRepository(executor))),
              registerAuditJob(auditVerifyJob(createAuditVerifyReader(executor))),
            ],
    });
    const access =
      auth === undefined
        ? undefined
        : await assembleAccess(registration, plugins, auth, executor, log);
    const authorization = options.authorization ?? access?.module.authorization;
    const kernel = await createKernel({
      platform: 'node',
      plugins,
      publicOrigin: auth?.publicOrigin,
      registration,
      ports,
      resolveOrg: createOrgResolver({ findSingleton: bootstrap.findSingleton }),
      health: async () => (await bootstrap.findSingleton()) !== null,
      log,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
      ...(options.platformServices === undefined
        ? {}
        : { platformServices: options.platformServices }),
      ...(access === undefined ? {} : { coreRoutes: access.module.coreRoutes }),
      ...(authorization === undefined ? {} : { authorization }),
    });
    const services: NodeServices = Object.freeze({
      providerAnchors: access?.providerAnchors ?? NO_ANCHORS,
      dispatch: deferredDispatch,
      catalogue: createCatalogueReader(executor),
      access: access?.services ?? null,
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
