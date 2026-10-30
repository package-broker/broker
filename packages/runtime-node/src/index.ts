import { createUserRepository } from '@package-broker/db-sqlite/repositories/user';
import { createServicePrincipalRepository } from '@package-broker/db-sqlite/repositories/service-principal';
import { expireStagedCapabilities } from '@package-broker/core/platform/blob';
import { schemaMigrationsMatch } from '@package-broker/db-sqlite/migrations/runner';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createApiRoutes } from '@package-broker/db-sqlite/repositories/api-services';
import { createComposerRepositoryProvider } from '@package-broker/core/ingest/composer/composer-repository';
import { createMcpTools } from '@package-broker/core/mcp/tools';
import { createInProcessMcpLimiter } from '@package-broker/core/mcp/limit';
import { createMcpRoutes } from '@package-broker/core/mcp/transport';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import { openApiDocument } from '@package-broker/core/api/openapi-document';
import {
  createVulnerabilityRuntime,
  VULNERABILITY_EVENT,
  VULNERABILITY_REASON_CODES,
} from '@package-broker/core/runtime/vulnerability';
import { createVulnerabilityRepository } from '@package-broker/db-sqlite/repositories/vulnerability';
import {
  createAccessServices,
  type AccessAssembly,
} from '@package-broker/db-sqlite/repositories/access-services';
import { parseSourceConfig } from '@package-broker/core/sources/config';
import { sourceCredentialOrigins } from '@package-broker/core/sources/credential-origins';
import {
  createProviderRegistry,
  type ProviderContext,
  type ProviderSource,
} from '@package-broker/core/sources/provider';
import type { RegistryJobsDeps } from '@package-broker/core/registry/jobs';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createSourceSyncCounts } from '@package-broker/db-sqlite/repositories/source-sync-counts';
import { createSourceSyncReads } from '@package-broker/db-sqlite/repositories/source-sync-reads';
import { createWebhookDeliveryRepository } from '@package-broker/db-sqlite/repositories/webhook-delivery';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import {
  retentionScanJob,
  blobPurgeJob,
  createRetentionScanJob,
  createBlobPurgeJob,
  type RetentionLifecycle,
} from '@package-broker/core/ingest/retention-jobs';
import type { ByteStore } from '@package-broker/core/platform/blob';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import { jobLeaseOf } from '@package-broker/core/platform/job-fences';
import { JobError } from '@package-broker/core/platform/jobs';
import { createBlobReferenceReader } from '@package-broker/db-sqlite/repositories/blob-references';
import { jobLeaseGuard } from '@package-broker/db-sqlite/repositories/job-lease-guard';
import { AUDIT_EVENTS } from '@package-broker/core/kernel/obs-codes';
import { createObservability, filterLogLevel } from '@package-broker/core/platform/observability';
import type { JobDefinition } from '@package-broker/core/platform/jobs';
import { createImportJobHolder, importJobRegistrations } from './import-jobs.js';
import { createImportJournalStore } from '@package-broker/db-sqlite/repositories/import-journal';
import { createImportRollbackStore } from '@package-broker/db-sqlite/repositories/import-rollback';
import { createImportVerificationStore } from '@package-broker/db-sqlite/repositories/import-verification';
import type { RegisteredCoreJob } from '@package-broker/core/kernel/registry';
import { auditSealJob } from '@package-broker/core/audit/sealer';
import { auditVerifyJob } from '@package-broker/core/audit/verify';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { createAuditVerifyReader } from '@package-broker/db-sqlite/repositories/audit-verify';
import { createServer, type Server } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRequestListener } from '@hono/node-server';
import type { SessionService } from '@package-broker/core/auth/session';
import type { PersonalTokenService } from '@package-broker/core/authz/pat-service';
import type { ProjectAdministration } from '@package-broker/core/authz/project-administration';
import type { ProjectLister } from '@package-broker/core/authz/project-list';
import type { ProjectService } from '@package-broker/core/authz/project-service';
import type { ServicePrincipalService } from '@package-broker/core/authz/service-principal-service';
import type { ServiceTokenService } from '@package-broker/core/authz/service-token-service';
import type { TokenReader } from '@package-broker/core/authz/token-read';
import type { TokenRevokeService } from '@package-broker/core/authz/token-revoke';
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
import { type ActorContext, type Administration } from '@package-broker/core/authz/administration';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import {
  createRegistryModule,
  createNpmHandleOf,
  type RegistryModule,
  type RegistryModuleDeps,
  type SourceCredential,
} from '@package-broker/core/registry/module';
import { createAccessRecorder } from '@package-broker/core/registry/access-recorder';
import type { RegistryConfig } from '@package-broker/core/registry/registry-config';
import { createScopedAdmittingAccess } from '@package-broker/core/registry/scoped-access';
import { GITHUB_API } from '@package-broker/core/ingest/composer/packagist-proxy';
import { INGEST_EVENTS, INGEST_REASON_CODES } from '@package-broker/core/ingest/finalize-guard';
import { createRepositoryJobs, type JobsFactory } from '@package-broker/core/platform/jobs-port';
import {
  resolveTokenLifetimePolicy,
  TokenConfigError,
  type TokenLifetimePolicy,
} from '@package-broker/core/authz/token-lifetime';
import {
  createPatJobHolder,
  patOffboardingRegistrations,
  tokenWiring,
  type TokenWiring,
} from './token-jobs.js';
import type { CoreJobs as Jobs } from '@package-broker/core/platform/jobs';
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
import type {
  ConfiguredProviderAnchor,
  ProviderAnchorReader,
} from '@package-broker/core/identity/provider-anchors';
import { scopedEnv, buildIdentityProviders } from '@package-broker/core/identity/providers';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, envelopeResponse, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import {
  createSetupUiRoutes,
  createUiRoutes,
  rewriteSetupRequest,
} from '@package-broker/core/kernel/ui-routes';
import { fileURLToPath } from 'node:url';
import { createNodeAssets } from './assets.js';
import { nodeClientIp, type TrustedProxy } from './client-ip.js';
import { nodeCodecs } from './codec/node-codec.js';
import { reportedVcsProviders, type VcsProvider } from '@package-broker/core/sources/config';
import { createDnsGuard } from './sources/dns-guard.js';
import { nodeGitProviderFor } from './sources/git-provider.js';
import { createGuardedFetch } from './sources/guarded-fetch.js';
import { createFilesystemArchiveStore } from './sources/ssh-archive-store.js';
import { createSshGitProvider, type SshArchiveReader } from './sources/ssh-provider.js';
import type { Kernel, KernelObservability } from '@package-broker/core/kernel/kernel';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import { collectRegistrations, KernelConfigError } from '@package-broker/core/kernel/registry';
import { mcpEnabled, type BrokerConfig } from '@package-broker/core/config';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { Registration } from '@package-broker/core/kernel/registry';
import type {
  PluginDefinition,
  PluginPorts,
  SourceProviderContext,
} from '@package-broker/core/plugin';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import {
  KeyringMismatchError,
  KeyringPasswordHashUnreadableError,
  KeyringStoreUnavailableError,
  KeyringVerifierMissingError,
  KeyringVersionInUseError,
  RESEED_VARIABLE,
  verifyKeyring,
} from '@package-broker/core/secrets/keyring-verifier';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import type { UpstreamCredential } from '@package-broker/core/sources/policy-fetch';
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
import { createPackageIdReads } from '@package-broker/db-sqlite/repositories/package-id';
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

interface RetentionStorage {
  readonly store: ByteStore;
  readonly deleteTimeoutMs: number;
  readonly leaseMs: number;
}

function retentionRegistrations(
  executor: SqlExecutor,
  storage: () => RetentionStorage,
): readonly RegisteredCoreJob[] {
  return [retentionScanJob, blobPurgeJob].map((definition) =>
    registerCoreJob({
      ...definition,
      async handler(payload, context) {
        const lease = jobLeaseOf(context);
        if (lease === null) throw new JobError('lease_lost');
        const checkSignal = () => {
          if (context.signal.aborted) throw new JobError('aborted');
        };
        const guard = jobLeaseGuard(context.org, lease);
        const guarded: SqlExecutor = {
          driver: executor.driver,
          all: (statement) => executor.all(statement),
          async batch(statements) {
            checkSignal();
            // Guard assertions and metadata writes share one atomic batch.
            const results = await executor.batch([...guard, ...statements]);
            return results.slice(guard.length);
          },
        };
        const { store, deleteTimeoutMs, leaseMs } = storage();
        const metadata = createBlobRepository(guarded, { purgeLeaseSeconds: leaseMs / 1000 });
        const lifecycle: RetentionLifecycle = {
          ...metadata,
          async removeBytes(org, key, generation) {
            // A removal that starts after this deadline could outlive the purge lease the recheck saw.
            const deadline = performance.now() + deleteTimeoutMs;
            let leaseLost: unknown;
            const removal = createBlobLifecycle({
              metadata,
              store: {
                putStaged: (...args) => store.putStaged(...args),
                openStaged: (...args) => store.openStaged(...args),
                promote: (...args) => store.promote(...args),
                discardStaged: (...args) => store.discardStaged(...args),
                listStaged: (...args) => {
                  expireStagedCapabilities(store);
                  return store.listStaged(...args);
                },
                putVerified: (...args) => store.putVerified(...args),
                head: (...args) => store.head(...args),
                get: (...args) => store.get(...args),
                async remove(storageKey) {
                  checkSignal();
                  try {
                    await executor.batch(guard);
                  } catch (error) {
                    leaseLost = error;
                    throw error;
                  }
                  checkSignal();
                  if (performance.now() >= deadline) throw new JobError('aborted');
                  return store.remove(storageKey);
                },
              },
              deleteTimeoutMs,
              leaseMs,
              observability: context.observability,
            });
            const outcome = await removal.purgeBytes(org, key, generation);
            if (leaseLost !== undefined) throw leaseLost;
            return outcome;
          },
        };
        const bound =
          definition.name === retentionScanJob.name
            ? createRetentionScanJob({ reader: createBlobReferenceReader(guarded), lifecycle })
            : createBlobPurgeJob({
                lifecycle,
                staged: {
                  listStaged: (...args) => {
                    expireStagedCapabilities(store);
                    return store.listStaged(...args);
                  },
                  async discardStaged(handle) {
                    checkSignal();
                    await executor.batch(guard);
                    checkSignal();
                    await store.discardStaged(handle);
                  },
                },
              });
        await bound.handler(payload, context);
      },
    }),
  );
}

export interface NodeAuthOptions {
  readonly keyring: Keyring;
  readonly publicOrigin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface NodeServerOptions {
  readonly migrations?: readonly Pick<MigrationSource, 'id' | 'checksum'>[];
  /** Proxy header that carries the client address. `true` is the deprecated `PB_TRUSTED_PROXY=1`. */
  readonly trustedProxy?: TrustedProxy | boolean;
  readonly executor?: SqlExecutor;
  readonly auth?: NodeAuthOptions;
  readonly closeDatabase?: () => Promise<void>;
  readonly log?: KernelLog;
  readonly observability?: KernelObservability;
  readonly platformServices?: PlatformServices;
  readonly authorization?: AuthorizationEngine;
  /** Token lifetime maxima; an invalid value fails server creation. */
  readonly tokens?: BrokerConfig['tokens'];
  readonly vulnerability?: BrokerConfig['vulnerability'];
  readonly mcp?: BrokerConfig['mcp'];
  /** Resolves true once the broker may serve; a falsy answer refuses everything except liveness. */
  readonly servingGate?: () => Promise<boolean>;
  /** Registry routes need the database, auth, platform services and this input together. */
  readonly registry?: NodeRegistryOptions;
}

export interface NodeRegistryOptions {
  readonly config: RegistryConfig;
  /** Registers the SSH git provider with archives kept under this directory. */
  readonly sshArchiveRoot?: string;
  /** Registers the generic Git provider with archives staged under this directory. */
  readonly gitArchiveRoot?: string;
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
  readonly administration: Administration;
  readonly lifetime: TokenLifetimePolicy;
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

async function assembleAccess(
  registration: Registration,
  plugins: readonly PluginDefinition[],
  auth: NodeAuthOptions,
  executor: SqlExecutor,
  log: KernelLog,
  tokens: TokenWiring,
  clientIp: (request: Request) => string | null,
): Promise<AccessAssembly> {
  await auth.keyring.hmacKey('token-pepper', auth.keyring.currentVersion);
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) => fetch(request),
    clock: systemClock,
    env: scopedEnv(auth.env),
  });
  const built = createAccessServices({
    executor,
    keyring: auth.keyring,
    publicOrigin: auth.publicOrigin,
    providers,
    clock: systemClock,
    ids: { ulid },
    log,
    dispatch: deferredDispatch,
    clientIp,
    registration,
    tokens,
  });
  return built;
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

function lazyArchiveStore(root: string, maxZipBytes: number): SshArchiveReader {
  let opened: Promise<SshArchiveReader> | undefined;
  const open = (): Promise<SshArchiveReader> => {
    opened ??= createFilesystemArchiveStore(root, { maxZipBytes }).catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  return {
    find: async (...args) => (await open()).find(...args),
    readZip: async (...args) => (await open()).readZip(...args),
    store: async (...args) => (await open()).store(...args),
  };
}

export function credentialOrigins(
  record: SourceRecord,
  policy: Parameters<typeof parseSourceConfig>[4]['policy'],
): readonly string[] | null {
  return sourceCredentialOrigins(record, { runtime: 'node', policy });
}

function credentialAccess(
  executor: SqlExecutor,
  keyring: Keyring,
  policy: Parameters<typeof parseSourceConfig>[4]['policy'],
) {
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
      const origins = credentialOrigins(record, policy);
      if (record.credentialId === null || origins === null) {
        return null;
      }
      try {
        const opened = await material(ctx, record.credentialId);
        const probe = credentialEchoProbe(opened);
        return {
          credential:
            (opened.kind === 'ssh_key' && origins.length === 0) ||
            (opened.kind === 'github_app' && record.type === 'vcs' && origins[0] === GITHUB_API)
              ? INERT_CREDENTIAL
              : bindCredential(opened, origins),
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

    async githubApp(ctx: OrgContext, credentialId: string | null) {
      if (credentialId === null) return null;
      try {
        const row = await repository.get(ctx, credentialId);
        if (row === null || row.projectId !== null || row.kind !== 'github_app') return null;
        const opened = await material(ctx, credentialId);
        return opened.kind === 'github_app' ? opened : null;
      } catch (error) {
        if (
          error instanceof CredentialError ||
          error instanceof SecretDecryptError ||
          error instanceof CredentialNotFoundError
        )
          return null;
        throw error;
      }
    },
  };
}

function registryJobDependencies(input: {
  readonly executor: SqlExecutor;
  readonly providers: ReturnType<typeof createProviderRegistry>;
  readonly sourceProviders: readonly SourceProvider[];
  readonly policy: Parameters<typeof parseSourceConfig>[4]['policy'];
  readonly fetch: (record: SourceRecord) => ProviderContext['fetch'];
  readonly credential: (ctx: OrgContext, record: SourceRecord) => Promise<SourceCredential | null>;
  readonly webhook: Pick<RegistryJobsDeps['webhook'], 'loadCredential' | 'verifier'>;
}): RegistryJobsDeps {
  const { executor } = input;
  const sources = createSourceRepository(executor);
  const { providers } = input;
  const sourceFetches = new WeakMap<ProviderSource, ProviderContext['fetch']>();
  const guard = (job: JobContext) => {
    const lease = jobLeaseOf(job);
    if (lease === null) throw new JobError('lease_lost');
    return lease;
  };
  return {
    sourceSync: {
      sources,
      providers: {
        forSource: (source) => {
          const provider = providers.forSource(source);
          const fetch = sourceFetches.get(source);
          if (fetch === undefined) throw new JobError('invalid_payload');
          return {
            ...provider,
            ...(provider.listPackages === undefined
              ? {}
              : {
                  listPackages: (context, boundSource, cursor) =>
                    provider.listPackages!({ ...context, fetch }, boundSource, cursor),
                }),
          };
        },
      },
      toProviderSource: (record) => {
        const parsed = parseSourceConfig(
          record.type,
          record.ecosystem,
          record.url,
          record.configJson,
          {
            runtime: 'node',
            policy: input.policy,
            hasCredential: record.credentialId !== null,
          },
        );
        if (!parsed.ok) throw new JobError('invalid_payload');
        const base = {
          id: record.id,
          ecosystem: record.ecosystem,
          url: record.url,
          config: parsed.config,
        };
        const source = (
          record.type === 'vcs'
            ? { ...base, type: 'vcs' }
            : {
                ...base,
                type: record.type,
                providerId: providers.get(
                  record.type,
                  record.type === 'composer_repository'
                    ? (input.sourceProviders.find((provider) =>
                        provider.sourceTypes.includes('composer_repository'),
                      )?.id ?? 'composer-repository')
                    : undefined,
                ).id,
              }
        ) as ProviderSource;
        sourceFetches.set(source, input.fetch(record));
        return source;
      },
      loadCredential: async (ctx, record) =>
        (await input.credential(ctx, record))?.credential ?? null,
      providerContext: (job, credential) => ({
        org: job.org,
        // SourceSyncDeps supplies the source at provider dispatch, where fetch is bound.
        fetch: async () => {
          throw new JobError('invalid_payload');
        },
        credential,
        codecs: nodeCodecs,
        signal: job.signal,
        clock: systemClock,
        observability: job.observability,
      }),
      sessions: createIngestSessions(executor),
      writer: createCatalogueWriter(executor),
      finalizer: createIngestFinalizer(executor),
      writeGuard: (ctx, session, job) => createIngestSessionWriteGuard(ctx, session, guard(job)),
      jobGuard: guard,
      ...createSourceSyncCounts(executor),
      ...createSourceSyncReads(executor),
    },
    sourcePoll: { sources },
    webhook: {
      ...input.webhook,
      deliveries: createWebhookDeliveryRepository(executor),
    },
  };
}

interface RegistryAssembly {
  readonly module: RegistryModule;
  readonly services: NodeRegistryServices;
  readonly sourceProviderContext: SourceProviderContext;
  bindJobs(factory: JobsFactory): void;
  bindSourceProviders(providers: Iterable<SourceProvider>): Promise<void>;
  vcsProviders(): readonly VcsProvider[];
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
  readonly ingestScope: AsyncLocalStorage<Observability>;
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

  const credentials = credentialAccess(executor, auth.keyring, policy);
  const discoveryBindings = new WeakMap<
    UpstreamCredential,
    {
      orgId: string;
      credentialId: string;
      installationId: string;
    }
  >();
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
    enqueueStatements: (...args) => coreJobs().enqueueStatements(...args),
    enqueue: (ctx, type, payload, enqueueInput) =>
      coreJobs().enqueue(ctx, type, payload, enqueueInput),
    get: (ctx, id) => coreJobs().get(ctx, id),
  };

  const providers: SourceProvider[] = [];
  const gitStagingRoot = options.gitArchiveRoot;
  const providerRegistry = createProviderRegistry();
  providerRegistry.register(createComposerRepositoryProvider(policy));
  const bindSourceProviders = (sourceProviders: Iterable<SourceProvider>): void => {
    for (const provider of sourceProviders) {
      providerRegistry.register(provider);
      providers.push(providerRegistry.get(provider.sourceTypes[0]!, provider.id));
    }
  };
  if (options.sshArchiveRoot !== undefined) {
    bindSourceProviders([
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
    ]);
  }

  const recorder = createAccessRecorder({
    touch: (ctx, ids) => blobAccess.touch(ctx, ids),
    defer: background,
    now: () => Date.now(),
    onError: () => undefined,
  });

  const policyFetch: RegistryModuleDeps['policyFetch'] = (userAgent, context) =>
    createPolicyFetch({ fetchImpl: outboundFetch, policy, userAgent, observability, ...context });

  const module = createRegistryModule({
    runtime: 'node',
    handleOf: createNpmHandleOf(
      createUserRepository(executor),
      createServicePrincipalRepository(executor),
    ),
    registryJobs: registryJobDependencies({
      executor,
      providers: providerRegistry,
      sourceProviders: providers,
      policy,
      credential: credentials.forSource,
      webhook: {
        loadCredential: credentials.githubApp,
        verifier: {
          verify: async (...args) =>
            (await providers
              .find((provider) => provider.id === 'github')
              ?.webhookVerifier?.verify(...args)) ?? false,
        },
      },
      fetch: (record) =>
        policyFetch(
          record.userAgent ??
            (record.ecosystem === 'composer'
              ? config.userAgent.composerStyle
              : config.userAgent.default),
        ),
    }),
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
    policyFetch,
    deploymentId: input.deploymentId,
    providers,
    npmAudit: {
      sources,
      provenance: createVulnerabilityRepository(executor, systemClock),
    },
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
        observability: {
          log: (record) => (input.ingestScope.getStore() ?? observability).log(record),
        },
      },
      writeGuard: (ctx, session) => createIngestSessionWriteGuard(ctx, session),
      credential: credentials.forSource,
      credentialUnavailable: (ctx, id) => sources.markCredentialUnavailable(ctx, id),
    },
    sync: {
      packageId: createPackageIdReads(executor).packageId,
      upstreamState: createUpstreamStateRepository(executor),
      executor,
      writeGuard: (ctx, session, job) => createIngestSessionWriteGuard(ctx, session, job),
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
    sourceProviderContext: {
      runtime: 'docker',
      async discoveryCredential(org, credentialId, installationId) {
        if (!/^[1-9][0-9]{0,19}$/.test(installationId)) return null;
        if ((await credentials.githubApp(org, credentialId)) === null) return null;
        const credential = { ...INERT_CREDENTIAL };
        discoveryBindings.set(credential, { orgId: org.orgId, credentialId, installationId });
        return credential;
      },
      async tokensFor(org, source, create) {
        let credentialId: string;
        let installationId: string;
        if ('type' in source) {
          if (source.type !== 'vcs' || source.config.provider !== 'github') return null;
          const record = await sources.get(org, source.id);
          if (record === null || record.type !== 'vcs' || record.credentialId === null) return null;
          const parsed = parseSourceConfig(
            record.type,
            record.ecosystem,
            record.url,
            record.configJson,
            {
              runtime: 'node',
              policy,
              hasCredential: true,
            },
          );
          if (
            !parsed.ok ||
            !('provider' in parsed.config) ||
            parsed.config.provider !== 'github' ||
            parsed.config.installationId !== source.config.installationId ||
            parsed.config.repository !== source.config.repository ||
            !Number.isSafeInteger(parsed.config.installationId) ||
            (parsed.config.installationId ?? 0) <= 0
          )
            return null;
          credentialId = record.credentialId;
          installationId = String(parsed.config.installationId);
        } else {
          const binding = discoveryBindings.get(source);
          if (binding === undefined || binding.orgId !== org.orgId) return null;
          ({ credentialId, installationId } = binding);
        }
        const app = await credentials.githubApp(org, credentialId);
        return app === null
          ? null
          : create(
              { appId: app.appId, privateKeyPem: app.privateKeyPem },
              installationId,
              credentialId,
            );
      },
    },
    async bindSourceProviders(pluginProviders) {
      const bound = [...pluginProviders];
      bindSourceProviders(bound);
      if (
        gitStagingRoot === undefined ||
        bound.some((provider) => provider.id === 'git' && provider.sourceTypes.includes('vcs'))
      )
        return;
      const git = await nodeGitProviderFor(gitStagingRoot, (record) => observability.log(record));
      if (git !== null) bindSourceProviders([git]);
    },
    vcsProviders: () => reportedVcsProviders('node', providers),
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

function resolveTokenLifetime(input: BrokerConfig['tokens']): TokenLifetimePolicy {
  try {
    return resolveTokenLifetimePolicy(input);
  } catch (error) {
    if (error instanceof TokenConfigError) throw new KernelConfigError(error.problems);
    throw error;
  }
}

export function createNodeServer(
  plugins: readonly PluginDefinition[],
  options: NodeServerOptions = {},
): NodeBroker {
  const seams: RegistrySeams = (options as { [SEAMS_KEY]?: RegistrySeams })[SEAMS_KEY] ?? {};
  const shutdownMs = seams.shutdownDeadlineMs ?? SHUTDOWN_IDLE_MS;
  const log = options.log ?? defaultLog;
  const executor = options.executor ?? rejectingExecutor();
  const lifetime = resolveTokenLifetime(options.tokens);
  const remoteAddress = new AsyncLocalStorage<string | null>();
  const clientIp = (request: Request): string | null =>
    nodeClientIp(request, remoteAddress.getStore() ?? null, options.trustedProxy);

  const repository = createOrganizationRepository(executor);
  const bootstrap = createOrganizationBootstrap(executor);

  const ports: PluginPorts = Object.freeze({
    organizations: Object.freeze({ get: repository.get }),
    clock: systemClock,
    ids: { ulid },
  });

  const { auth } = options;
  const importJobs = createImportJobHolder();
  const patJobs = createPatJobHolder();
  let drainRegistry: (() => Promise<void>) | undefined;
  const ingestScope = new AsyncLocalStorage<Observability>();
  let keyringVerification: Promise<void> | undefined;
  const verify = async (): Promise<void> => {
    if (auth !== undefined && options.executor !== undefined) {
      try {
        await verifyKeyring(auth.keyring, createKeyringVerifierStore(executor), {
          reseed: auth.env[RESEED_VARIABLE] === '1',
        });
      } catch (error) {
        if (
          error instanceof KeyringMismatchError ||
          error instanceof KeyringPasswordHashUnreadableError ||
          error instanceof KeyringStoreUnavailableError ||
          error instanceof KeyringVerifierMissingError ||
          error instanceof KeyringVersionInUseError
        ) {
          throw new KernelConfigError(['PB_MASTER_KEY: keyring verification failed']);
        }
        throw error;
      }
    }
  };
  const verifyOnce = (): Promise<void> => (keyringVerification ??= verify());
  const application = (async () => {
    // A closed migration gate defers verification until the broker may serve.
    if (options.servingGate === undefined || (await options.servingGate())) await verifyOnce();
    const obsSink =
      options.observability?.sink ??
      filterLogLevel(
        {
          emit: (record: ObsRecord) => {
            if (record.kind === 'log') log({ ...record.record });
          },
        },
        options.observability?.level,
      );
    function registerAuditJob<P>(definition: JobDefinition<P>): RegisteredCoreJob {
      return registerCoreJob({
        ...definition,
        handler: (payload, context) =>
          definition.handler(definition.validate(payload), {
            ...context,
            observability: createObservability(
              obsSink,
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
    function registerIngestJob<P>(
      definition: JobDefinition<P>,
      registry = {
        events: new Set([...INGEST_EVENTS]),
        reasonCodes: INGEST_REASON_CODES,
        routeTemplates: new Set<string>(),
      },
    ): RegisteredCoreJob {
      return registerCoreJob({
        ...definition,
        handler: (payload, context) => {
          const observability = createObservability(
            obsSink,
            {
              deploymentId: options.observability?.deploymentId ?? 'unconfigured',
              runtime: 'node',
              requestId: null,
              plugin: 'core',
              jobId: context.jobId,
              attempt: context.attempt,
            },
            registry,
          );
          return ingestScope.run(observability, () =>
            definition.handler(definition.validate(payload), { ...context, observability }),
          );
        },
      });
    }
    const reads = options.executor === undefined ? undefined : buildPackageReads(executor);
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
            ingestScope,
          });
    const vulnerabilityPolicy = createOutboundPolicy({
      allowPrivateHosts: [],
      runtime: 'node',
      selfOrigins: auth === undefined ? [] : [auth.publicOrigin],
    });
    const vulnerability = createVulnerabilityRuntime({
      config: {
        platform: 'node',
        plugins,
        ...(options.vulnerability === undefined ? {} : { vulnerability: options.vulnerability }),
      },
      repository: createVulnerabilityRepository(executor, systemClock),
      policyFetch: createPolicyFetch({
        fetchImpl: seams.transport ?? createGuardedFetch(vulnerabilityPolicy),
        policy: vulnerabilityPolicy,
        userAgent: 'PackageBroker/2.0',
      }),
      clock: systemClock,
    });
    drainRegistry = registry?.drain;
    const packageResolver = registry?.module.visibilityPort ?? reads?.resolver;
    const retention = (
      options.platformServices as
        (PlatformServices & { readonly retention?: RetentionStorage }) | undefined
    )?.retention;
    const registration = collectRegistrations(plugins, {
      ...(registry === undefined ? {} : { sourceProviderContext: registry.sourceProviderContext }),
      ...(packageResolver === undefined ? {} : { packageResolver }),
      coreJobs:
        options.platformServices === undefined
          ? []
          : [
              ...vulnerability.jobs.map((job) =>
                registerIngestJob(job.definition, {
                  events: new Set([VULNERABILITY_EVENT]),
                  reasonCodes: new Set(VULNERABILITY_REASON_CODES),
                  routeTemplates: new Set<string>(),
                }),
              ),
              ...(retention === undefined ? [] : retentionRegistrations(executor, () => retention)),
              registerAuditJob(auditSealJob(createAuditSealRepository(executor))),
              registerAuditJob(auditVerifyJob(createAuditVerifyReader(executor))),
              ...(registry?.module.coreJobs ?? []).map((job) => registerIngestJob(job.definition)),
              ...(registry?.module.packageSyncJob === undefined
                ? []
                : [registerIngestJob(registry.module.packageSyncJob)]),
              ...(auth === undefined ? [] : importJobRegistrations(importJobs)),
              ...(auth === undefined ? [] : patOffboardingRegistrations(executor, patJobs, log)),
            ],
    });
    if (registry !== undefined && options.platformServices !== undefined) {
      await registry.bindSourceProviders(registration.sourceProviders.values());
      registry.bindJobs(
        createRepositoryJobs({
          store: options.platformServices.jobStore,
          jobs: registration.jobs,
          clock: systemClock,
          ids: { ulid },
        }),
      );
    }
    if (auth !== undefined && options.platformServices !== undefined) {
      patJobs.set(
        createRepositoryJobs({
          store: options.platformServices.jobStore,
          jobs: registration.jobs,
          clock: systemClock,
          ids: { ulid },
        })('core', { projectId: null, tokenId: null }),
      );
    }
    const access =
      auth === undefined
        ? undefined
        : await assembleAccess(
            registration,
            plugins,
            auth,
            executor,
            log,
            tokenWiring(lifetime, patJobs, options.platformServices !== undefined),
            clientIp,
          );
    if (access !== undefined && options.platformServices !== undefined) {
      importJobs.set({
        verificationStore: createImportVerificationStore({
          executor,
          providerAnchors: access.anchors,
        }),
        applyStore: createImportJournalStore({ executor, providerAnchors: access.anchors }),
        rollbackStore: createImportRollbackStore({ executor, providerAnchors: access.anchors }),
        blobs: options.platformServices.blob,
      });
    }
    const packages =
      access === undefined || reads === undefined
        ? null
        : buildCatalogue(executor, reads, access.anchors, log);
    const apiRoutes =
      auth === undefined || access === undefined || packages === null
        ? []
        : createApiRoutes({
            clientIp,
            executor,
            runtime: 'node',
            ...(registry?.module.probePackage === undefined
              ? {}
              : { sourcePackageProbe: registry?.module.probePackage }),
            keyring: auth.keyring,
            access,
            packages,
            vulnerability,
            policy: createOutboundPolicy({
              allowPrivateHosts: options.registry?.config.outbound.allowPrivateHosts ?? [],
              runtime: 'node',
              selfOrigins: options.registry?.config.outbound.selfOrigins ?? [auth.publicOrigin],
            }),
            lifetime,
            log,
            blob: options.platformServices?.blob,
            vcsProviders: () => registry?.vcsProviders() ?? [],
            refuseVcsProvider: (provider) =>
              provider === 'git' && !(registry?.vcsProviders() ?? []).includes('git'),
          });
    const authorization = options.authorization ?? access?.module.authorization;
    const assets = await createNodeAssets(
      fileURLToPath(new URL('./assets/', import.meta.url)),
    ).catch((error: unknown) => {
      if ((error as { code?: unknown }).code !== 'UI_ASSETS_ABSENT') throw error;
      log({ level: 'info', event: 'ui.assets_absent' });
      return null;
    });
    const uiRoutes = createUiRoutes(
      {
        manifest: async () => assets?.manifest() ?? null,
        read: async (name) => assets?.read(name) ?? null,
      },
      { publicOrigin: auth?.publicOrigin ?? 'http://localhost', log },
    );
    const setupRoutes = createSetupUiRoutes(
      {
        manifest: async () => assets?.manifest() ?? null,
        read: async (name) => assets?.read(name) ?? null,
      },
      { publicOrigin: auth?.publicOrigin ?? 'http://localhost', log },
    );
    const coreRoutes = [
      ...(access?.module.coreRoutes ?? []),
      ...apiRoutes,
      openApiRoute(openApiDocument),
      ...(registry?.module.coreRoutes ?? []).map((route) => ({
        ...route,
        async handler(context: Parameters<typeof route.handler>[0]) {
          const response = await route.handler(context);
          return response.status === 401 ? new Response(null, { status: 404 }) : response;
        },
      })),
      ...(assets === null ? [] : [...setupRoutes, ...uiRoutes]),
    ];
    if (
      mcpEnabled({
        platform: 'node',
        plugins,
        ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      })
    ) {
      const publicOrigin = auth?.publicOrigin ?? 'http://localhost';
      const handlers = createMcpTools({
        routes: [...coreRoutes, ...registration.routes],
        publicOrigin,
        kernel: { fetch: (request) => kernel.fetch(request) },
      });
      coreRoutes.push(
        ...createMcpRoutes({ handlers, publicOrigin, limiter: createInProcessMcpLimiter() }),
      );
    }
    const migrations = options.migrations;
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
      ...(migrations === undefined
        ? {}
        : { schemaMatches: () => schemaMigrationsMatch(executor, migrations) }),
      log,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
      ...(options.platformServices === undefined
        ? {}
        : { platformServices: options.platformServices }),
      coreRoutes,
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

  const listener = getRequestListener(async (request) =>
    !(await serving(request))
      ? refuse(request)
      : kernel
          .then(async (ready) => {
            if (new URL(request.url).pathname !== '/health/live') await verifyOnce();
            const setup = rewriteSetupRequest(request);
            if (setup !== null) return ready.fetch(setup);
            return ready.fetch(request);
          })
          .catch((error: unknown) => {
            const response = errorResponse(error, crypto.randomUUID(), log);
            return request.method === 'HEAD' ? new Response(null, response) : response;
          }),
  );
  const server = createServer((incoming, outgoing) =>
    remoteAddress.run(incoming.socket.remoteAddress ?? null, () => listener(incoming, outgoing)),
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
