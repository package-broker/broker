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
import type {
  CatalogueReader,
  CatalogueWriter,
  PackageVisibilityPort,
} from '@package-broker/core/db/catalogue';
import {
  createPackageAccess,
  type PackageAccess,
} from '@package-broker/core/catalogue/package-access';
import {
  createVisibilityService,
  type VisibilityService,
} from '@package-broker/core/catalogue/visibility-service';
import {
  buildClosureReport,
  type DependencyClosureReport,
} from '@package-broker/core/catalogue/closure-report';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import type { ActorContext } from '@package-broker/core/authz/administration';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import {
  createRegistryModule,
  type RegistryModule,
  type SourceCredential,
} from '@package-broker/core/registry/module';
import { createAccessRecorder } from '@package-broker/core/registry/access-recorder';
import type { RegistryConfig } from '@package-broker/core/registry/registry-config';
import { createScopedAdmittingAccess } from '@package-broker/core/registry/scoped-access';
import { INGEST_EVENTS, INGEST_REASON_CODES } from '@package-broker/core/ingest/finalize-guard';
import { createRepositoryJobs, type JobsFactory } from '@package-broker/core/platform/jobs-port';
import type { Jobs } from '@package-broker/core/platform/jobs';
import { SEAMS_KEY } from './internal/seams-key.js';
import type { RegistrySeams } from './testing/node-server.js';
import { PlatformUnavailableError } from '@package-broker/core/platform/errors';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import type { Observability, ObsRecord } from '@package-broker/core/platform/observability';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import {
  bindCredential,
  CredentialError,
  credentialEchoProbe,
  parseCredentialMaterial,
  type CredentialKind,
  type CredentialMaterial,
  type SshKeyMaterial,
} from '@package-broker/core/sources/credentials';
import type { SourceRecord } from '@package-broker/core/db/source';
import type { OrganizationIdentity } from '@package-broker/core/db/organization';
import type { SourceProvider } from '@package-broker/core/sources/provider';
import { orgContext, type OrgContext } from '@package-broker/core/db/port';
import { createSecretCipher, SecretDecryptError } from '@package-broker/core/secrets/cipher';
import {
  createCredentialStore,
  CredentialNotFoundError,
} from '@package-broker/core/secrets/credential-store';
import type { SqlExecutor } from '@package-broker/core/db/port';
import {
  providerAnchorsOf,
  type ConfiguredProviderAnchor,
  type ProviderAnchorReader,
} from '@package-broker/core/identity/provider-anchors';
import { scopedEnv, buildIdentityProviders } from '@package-broker/core/identity/providers';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, envelopeResponse, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createUiRoutes } from '@package-broker/core/kernel/ui-routes';
import { fileURLToPath } from 'node:url';
import { createNodeAssets } from './assets.js';
import { nodeCodecs } from './codec/node-codec.js';
import { createDnsGuard } from './sources/dns-guard.js';
import { createGuardedFetch } from './sources/guarded-fetch.js';
import { createFilesystemArchiveStore } from './sources/ssh-archive-store.js';
import { createSshGitProvider, type SshArchiveStore } from './sources/ssh-provider.js';
import type { Kernel, KernelObservability } from '@package-broker/core/kernel/kernel';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import type { UpstreamCredential } from '@package-broker/core/sources/policy-fetch';
import { createAccessRepository } from '@package-broker/db-sqlite/repositories/access';
import { createAuthRepositories } from '@package-broker/db-sqlite/repositories/auth';
import { createBlobAccessRepository } from '@package-broker/db-sqlite/repositories/blob-access';
import { createBlobReplacer } from '@package-broker/db-sqlite/repositories/blob-replacer';
import { createCacheEpochRepository } from '@package-broker/db-sqlite/repositories/cache-epoch';
import { createCatalogueReader } from '@package-broker/db-sqlite/repositories/catalogue';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createExistingVersionsReader } from '@package-broker/db-sqlite/repositories/existing-versions';
import {
  createFetchLeases,
  createFetchLeaseWriteGuard,
  leaseKey,
} from '@package-broker/db-sqlite/repositories/fetch-lease';
import { createIngestFinalizer } from '@package-broker/db-sqlite/repositories/ingest-finalize';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '@package-broker/db-sqlite/repositories/ingest-session';
import { createRegistryReads } from '@package-broker/db-sqlite/repositories/registry-reads';
import { createRepresentationClock } from '@package-broker/db-sqlite/repositories/representation-clock';
import { createSourceRepository } from '@package-broker/db-sqlite/repositories/source';
import { createUpstreamStateRepository } from '@package-broker/db-sqlite/repositories/upstream-state';
import {
  createCatalogueWriter,
  createVisibilityStore,
} from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createScopedAdmission } from '@package-broker/db-sqlite/repositories/scoped-admission';
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
  /** Resolves true once the broker may serve; a falsy answer refuses everything except liveness. */
  readonly servingGate?: () => Promise<boolean>;
  /** Registry routes need the database, auth, platform services and this input together. */
  readonly registry?: NodeRegistryOptions;
}

export interface NodeRegistryOptions {
  readonly config: RegistryConfig;
  /** Registers the SSH git provider with archives kept under this directory. */
  readonly sshArchiveRoot?: string;
}

export interface NodeRegistryServices {
  /** The transport every registry request leaves through. */
  readonly outboundFetch: FetchLike;
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

export interface NodeCatalogueServices {
  readonly reader: CatalogueReader;
  readonly writer: CatalogueWriter;
  readonly packageAccess: PackageAccess;
  readonly visibility: VisibilityService;
  readonly closureReport: (
    actor: ProjectActor,
    organizationPermissions: ActorContext['permissions'],
    ecosystem: NameEcosystem,
  ) => Promise<DependencyClosureReport>;
}

export interface NodeServices {
  readonly providerAnchors: ProviderAnchorReader;
  readonly dispatch: (run: () => Promise<void>) => void;
  readonly catalogue: Pick<CatalogueReader, 'resolveVersions'>;
  /** Null when the runtime has no auth options. */
  readonly access: NodeAccessServices | null;
  /** Null without a database or auth options. */
  readonly packages: NodeCatalogueServices | null;
  /** Present when the registry is wired. */
  readonly registry?: NodeRegistryServices;
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
  readonly anchors: readonly ConfiguredProviderAnchor[];
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
      sessions: module.sessions,
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
      ids,
      tokens: tokenRepository,
      authority,
      ownership: tokenRepository,
      clock: systemClock,
      log,
    }),
    tokenList: wired('token reader', createTokenReader(executor)),
  });
  return { module, providerAnchors, services, anchors: anchorList };
}

function buildPackageReads(executor: SqlExecutor) {
  const reader = createCatalogueReader(executor);
  const packageAccess = createPackageAccess(reader);
  const resolver: PackageVisibilityPort = createScopedAdmittingAccess(
    packageAccess,
    createScopedAdmission(executor),
  );
  return { reader, packageAccess, resolver };
}

const SHUTDOWN_IDLE_MS = 10_000;

async function settlesWithin(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const INERT_CREDENTIAL: UpstreamCredential = Object.freeze({
  origins: Object.freeze([]),
  queryParams: Object.freeze([]),
  apply: (headers: Headers, url: URL) => ({ headers, url }),
});

function lazyArchiveStore(root: string, maxZipBytes: number): SshArchiveStore {
  let opened: Promise<SshArchiveStore> | undefined;
  const open = (): Promise<SshArchiveStore> => {
    opened ??= createFilesystemArchiveStore(root, { maxZipBytes }).catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  return {
    find: async (...args) => (await open()).find(...args),
    store: async (...args) => (await open()).store(...args),
  };
}

function credentialAccess(executor: SqlExecutor, keyring: Keyring) {
  const repository = createCredentialRepository(executor);
  const store = createCredentialStore({
    repository,
    cipher: createSecretCipher(keyring, 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  });

  async function material(ctx: OrgContext, id: string): Promise<CredentialMaterial> {
    const row = await repository.get(ctx, id);
    if (row === null) throw new CredentialNotFoundError();
    const plaintext = await store.read(ctx, id);
    try {
      return parseCredentialMaterial(row.kind as CredentialKind, plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  return {
    async forSource(ctx: OrgContext, record: SourceRecord): Promise<SourceCredential | null> {
      if (record.credentialId === null || record.url === null || !URL.canParse(record.url)) {
        return null;
      }
      try {
        const opened = await material(ctx, record.credentialId);
        const probe = credentialEchoProbe(opened);
        return {
          credential:
            opened.kind === 'ssh_key'
              ? INERT_CREDENTIAL
              : bindCredential(opened, [new URL(record.url).origin]),
          probe,
        };
      } catch (error) {
        if (
          error instanceof CredentialError ||
          error instanceof SecretDecryptError ||
          error instanceof CredentialNotFoundError
        ) {
          return null;
        }
        throw error;
      }
    },

    async sshKey(ctx: OrgContext, credentialId: string | null): Promise<SshKeyMaterial> {
      if (credentialId === null) throw new CredentialNotFoundError();
      const opened = await material(ctx, credentialId);
      if (opened.kind !== 'ssh_key') throw new CredentialError('invalid', 'kind');
      return opened;
    },
  };
}

interface RegistryAssembly {
  readonly module: RegistryModule;
  readonly services: NodeRegistryServices;
  bindJobs(factory: JobsFactory): void;
  drain(): Promise<void>;
}

function assembleRegistry(input: {
  readonly options: NodeRegistryOptions;
  readonly seams: RegistrySeams;
  readonly executor: SqlExecutor;
  readonly auth: NodeAuthOptions;
  readonly platform: PlatformServices;
  readonly reader: CatalogueReader;
  readonly observability: Observability;
  readonly deploymentId: string;
  readonly findOrganization: () => Promise<OrganizationIdentity | null>;
}): RegistryAssembly {
  const { options, seams, executor, auth, platform, observability } = input;
  const { config } = options;
  const policy = createOutboundPolicy({
    allowPrivateHosts: config.outbound.allowPrivateHosts,
    runtime: 'node',
    selfOrigins: config.outbound.selfOrigins,
  });
  const guardOptions = seams.resolver === undefined ? {} : { resolver: seams.resolver };
  const outboundFetch = seams.transport ?? createGuardedFetch(policy, guardOptions);

  const credentials = credentialAccess(executor, auth.keyring);
  seams.observeCredentials?.(credentials);
  const sources = createSourceRepository(executor);
  const reads = createRegistryReads(executor);
  const writer = createCatalogueWriter(executor);
  const sessions = createIngestSessions(executor);
  const blobAccess = createBlobAccessRepository(executor);
  const inFlight = new Set<Promise<void>>();
  const background = (thunk: () => Promise<void>): void => {
    const run: Promise<void> = Promise.resolve()
      .then(thunk)
      .catch(() => undefined)
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
  };

  let jobsFactory: JobsFactory | undefined;
  const unattended = { projectId: null, tokenId: null };
  const coreJobs = (): Jobs => {
    if (jobsFactory === undefined) throw new PlatformUnavailableError();
    return jobsFactory('core', unattended);
  };
  const jobs: Jobs = seams.jobs ?? {
    enqueue: (ctx, type, payload, enqueueInput) =>
      coreJobs().enqueue(ctx, type, payload, enqueueInput),
    get: (ctx, id) => coreJobs().get(ctx, id),
  };

  const providers: SourceProvider[] = [];
  if (options.sshArchiveRoot !== undefined) {
    providers.push(
      createSshGitProvider({
        dnsGuard: createDnsGuard(policy, guardOptions),
        archives: lazyArchiveStore(options.sshArchiveRoot, config.caps.archiveBytes),
        sshKey: async (source) => {
          const organization = await input.findOrganization();
          if (organization === null) throw new CredentialNotFoundError();
          const ctx = orgContext(organization.id);
          const record = await sources.get(ctx, source.id);
          return credentials.sshKey(ctx, record?.credentialId ?? null);
        },
      }),
    );
  }

  const recorder = createAccessRecorder({
    touch: (ctx, ids) => blobAccess.touch(ctx, ids),
    defer: background,
    now: () => Date.now(),
    onError: () => undefined,
  });

  const module = createRegistryModule({
    runtime: 'node',
    ports: {
      blob: platform.blob,
      cache: platform.cache,
      jobs,
      observability,
    },
    clock: systemClock,
    codecs: nodeCodecs,
    publicUrl: auth.publicOrigin,
    registry: config,
    outboundPolicy: policy,
    policyFetch: (userAgent) =>
      createPolicyFetch({ fetchImpl: outboundFetch, policy, userAgent, observability }),
    deploymentId: input.deploymentId,
    providers,
    catalogue: {
      reader: input.reader,
      scopedAdmission: createScopedAdmission(executor),
      epoch: createCacheEpochRepository(executor),
      representationClock: createRepresentationClock(executor),
      upstreamState: createUpstreamStateRepository(executor),
      sources,
      covers: reads.covers,
      versionById: reads.versionById,
    },
    ingest: {
      sessions,
      apply: {
        writer,
        sessions,
        existing: createExistingVersionsReader(executor),
        finalizer: createIngestFinalizer(executor),
        observability,
      },
      writeGuard: (ctx, session) => createIngestSessionWriteGuard(ctx, session),
      credential: credentials.forSource,
    },
    dist: {
      leases: createFetchLeases(executor),
      leaseKey,
      writeGuard: (ctx, handle) => createFetchLeaseWriteGuard(ctx, handle),
      writer,
      blobReplacer: createBlobReplacer(executor),
      recorder,
    },
  });
  return {
    module,
    services: Object.freeze({ outboundFetch }),
    bindJobs: (factory) => {
      jobsFactory = factory;
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await recorder.flush();
    },
  };
}

function buildCatalogue(
  executor: SqlExecutor,
  reads: ReturnType<typeof buildPackageReads>,
  anchors: readonly ConfiguredProviderAnchor[],
  log: KernelLog,
): NodeCatalogueServices {
  return Object.freeze<NodeCatalogueServices>({
    reader: reads.reader,
    writer: createCatalogueWriter(executor),
    packageAccess: reads.packageAccess,
    visibility: createVisibilityService({
      store: createVisibilityStore(executor, { providerAnchors: anchors }),
      log,
    }),
    closureReport: (actor, organizationPermissions, ecosystem) =>
      buildClosureReport(reads.reader, actor, organizationPermissions, ecosystem, systemClock),
  });
}

export function createNodeServer(
  plugins: readonly PluginDefinition[],
  options: NodeServerOptions = {},
): NodeBroker {
  const seams: RegistrySeams = (options as { [SEAMS_KEY]?: RegistrySeams })[SEAMS_KEY] ?? {};
  const shutdownMs = seams.shutdownDeadlineMs ?? SHUTDOWN_IDLE_MS;
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
  let drainRegistry: (() => Promise<void>) | undefined;
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
    const reads = options.executor === undefined ? undefined : buildPackageReads(executor);
    const obsSink = options.observability?.sink ?? {
      emit: (record: ObsRecord) => {
        if (record.kind === 'log') log({ ...record.record });
      },
    };
    const deploymentId = options.observability?.deploymentId ?? 'unconfigured';
    const registry =
      options.registry === undefined ||
      reads === undefined ||
      auth === undefined ||
      options.platformServices === undefined
        ? undefined
        : assembleRegistry({
            options: options.registry,
            seams,
            executor,
            auth,
            platform: options.platformServices,
            reader: reads.reader,
            observability: createObservability(
              obsSink,
              { deploymentId, runtime: 'node', requestId: null, plugin: 'core' },
              {
                events: new Set([...AUDIT_EVENTS, ...INGEST_EVENTS]),
                reasonCodes: INGEST_REASON_CODES,
                routeTemplates: new Set(),
              },
            ),
            deploymentId,
            findOrganization: bootstrap.findSingleton,
          });
    drainRegistry = registry?.drain;
    const packageResolver = registry?.module.visibilityPort ?? reads?.resolver;
    const registration = collectRegistrations(plugins, {
      ...(packageResolver === undefined ? {} : { packageResolver }),
      coreJobs:
        options.platformServices === undefined
          ? []
          : [
              registerAuditJob(auditSealJob(createAuditSealRepository(executor))),
              registerAuditJob(auditVerifyJob(createAuditVerifyReader(executor))),
            ],
    });
    if (registry !== undefined && options.platformServices !== undefined) {
      registry.bindJobs(
        createRepositoryJobs({
          store: options.platformServices.jobStore,
          jobs: registration.jobs,
          clock: systemClock,
          ids: { ulid },
        }),
      );
    }
    const access =
      auth === undefined
        ? undefined
        : await assembleAccess(registration, plugins, auth, executor, log);
    const packages =
      access === undefined || reads === undefined
        ? null
        : buildCatalogue(executor, reads, access.anchors, log);
    const authorization = options.authorization ?? access?.module.authorization;
    const assets = await createNodeAssets(
      fileURLToPath(new URL('./assets/', import.meta.url)),
    ).catch(() => null);
    const ui = createUiRoutes(
      {
        manifest: async () => assets?.manifest() ?? null,
        read: async (name) => assets?.read(name) ?? null,
      },
      { publicOrigin: auth?.publicOrigin ?? 'http://localhost', log },
    );
    const uiRoutes = ui.map((route) => ({
      ...route,
      path: route.path.replace('/assets/:file', '/:file'),
      handler: async (context: Parameters<typeof route.handler>[0]) =>
        context.params['file'] === 'manifest.json'
          ? Response.json(await assets?.manifest(), {
              headers: { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
            })
          : route.handler(context),
      boundary: 'authenticated' as const,
      needsOrg: true,
    }));
    const kernel = await createKernel({
      platform: 'node',
      ...(packageResolver === undefined ? {} : { packageResolver }),
      ...(registry === undefined ? {} : { ecosystemRoutes: registry.module.ecosystemRoutes }),
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
      coreRoutes: [...(access?.module.coreRoutes ?? []), ...(assets === null ? [] : uiRoutes)],
      ...(authorization === undefined ? {} : { authorization }),
    });
    const services: NodeServices = Object.freeze({
      providerAnchors: access?.providerAnchors ?? NO_ANCHORS,
      dispatch: deferredDispatch,
      catalogue: createCatalogueReader(executor),
      packages,
      access: access?.services ?? null,
      ...(registry === undefined ? {} : { registry: registry.services }),
    });
    return { kernel, services };
  })();
  const kernel = application.then((built) => built.kernel);
  const services = application.then((built) => built.services);
  kernel.catch(() => undefined);
  services.catch(() => undefined);

  const gate = options.servingGate;
  const refuse = (request: Request): Response => {
    const response = envelopeResponse(503, 'not_ready', 'Not ready', crypto.randomUUID());
    return request.method === 'HEAD' ? new Response(null, response) : response;
  };
  const serving = async (request: Request): Promise<boolean> =>
    gate === undefined || new URL(request.url).pathname === '/health/live' || (await gate());

  const server = createServer(
    getRequestListener(async (request) =>
      !(await serving(request))
        ? refuse(request)
        : kernel.then(
            async (ready) => {
              const url = new URL(request.url);
              if (url.pathname === '/_pb/ui') {
                const response = await ready.fetch(request);
                if (response.status !== 200) return response;
                url.pathname = '/_pb/ui/';
                return new Response(null, {
                  status: 303,
                  headers: { location: url.pathname + url.search, 'cache-control': 'no-store' },
                });
              }
              if (url.pathname !== '/_pb/ui/') return ready.fetch(request);
              url.pathname = '/_pb/ui';
              return ready.fetch(new Request(url, request));
            },
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
        const deadline = Date.now() + shutdownMs;
        await kernel.then(
          (ready) => ready.idle(shutdownMs),
          () => undefined,
        );
        if (drainRegistry !== undefined) {
          const drained = await settlesWithin(drainRegistry(), Math.max(0, deadline - Date.now()));
          if (!drained) log({ level: 'warn', event: 'shutdown.registry_drain_timeout' });
        }
      } finally {
        await options.closeDatabase?.();
      }
    },
  };
}
