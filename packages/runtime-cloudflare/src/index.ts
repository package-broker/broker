import { schemaMigrationsMatch } from '@package-broker/db-sqlite/migrations/runner';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createApiRoutes } from '@package-broker/db-sqlite/repositories/api-services';
import { createComposerRepositoryProvider } from '@package-broker/core/ingest/composer/composer-repository';
import { openApiRoute } from '@package-broker/core/api/openapi-route';
import { openApiDocument } from '@package-broker/core/api/openapi-document';
import {
  assertMcpRateLimit,
  createMcpLimiter,
  McpRateLimitConfigError,
  type McpRateLimitBinding,
} from '@package-broker/core/mcp/limit';
import { createMcpTools } from '@package-broker/core/mcp/tools';
import { createMcpRoutes } from '@package-broker/core/mcp/transport';
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
import type { OutboundPolicy } from '@package-broker/core/sources/url-policy';
import { parseSourceConfig, reportedVcsProviders } from '@package-broker/core/sources/config';
import { sourceCredentialOrigins } from '@package-broker/core/sources/credential-origins';
import {
  createProviderRegistry,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '@package-broker/core/sources/provider';
import type { RegistryJobsDeps } from '@package-broker/core/registry/jobs';
import { sourceSyncJob } from '@package-broker/core/ingest/source-sync-job';
import { sourcePollJob } from '@package-broker/core/ingest/retention-jobs';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createSourceSyncCounts } from '@package-broker/db-sqlite/repositories/source-sync-counts';
import { createSourceSyncReads } from '@package-broker/db-sqlite/repositories/source-sync-reads';
import { createWebhookDeliveryRepository } from '@package-broker/db-sqlite/repositories/webhook-delivery';
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
import { INGEST_EVENTS, INGEST_REASON_CODES } from '@package-broker/core/ingest/finalize-guard';
import { packageSyncJob } from '@package-broker/core/ingest/package-sync-job';
import { PlatformUnavailableError } from '@package-broker/core/platform/errors';
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
import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import type { AuthModule } from '@package-broker/core/auth/module';
import { type SessionService } from '@package-broker/core/auth/session';
import type { PersonalTokenService } from '@package-broker/core/authz/pat-service';
import type { ProjectAdministration } from '@package-broker/core/authz/project-administration';
import type { ProjectLister } from '@package-broker/core/authz/project-list';
import type { ProjectService } from '@package-broker/core/authz/project-service';
import type { ServicePrincipalService } from '@package-broker/core/authz/service-principal-service';
import type { ServiceTokenService } from '@package-broker/core/authz/service-token-service';
import type { TokenReader } from '@package-broker/core/authz/token-read';
import type { TokenRevokeService } from '@package-broker/core/authz/token-revoke';
import {
  buildClosureReport,
  type DependencyClosureReport,
} from '@package-broker/core/catalogue/closure-report';
import type { NameEcosystem } from '@package-broker/core/catalogue/names';
import {
  createPackageAccess,
  type PackageAccess,
} from '@package-broker/core/catalogue/package-access';
import {
  createVisibilityService,
  type VisibilityService,
} from '@package-broker/core/catalogue/visibility-service';
import { type ActorContext, type Administration } from '@package-broker/core/authz/administration';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import type {
  CatalogueReader,
  CatalogueWriter,
  PackageVisibilityPort,
} from '@package-broker/core/db/catalogue';
import { createScopedAdmittingAccess } from '@package-broker/core/registry/scoped-access';
import {
  createAccessRecorder,
  type AccessRecorder,
} from '@package-broker/core/registry/access-recorder';
import {
  createRegistryModule,
  type RegistryModule,
  type RegistryModuleDeps,
  type SourceCredential,
} from '@package-broker/core/registry/module';
import {
  RegistryConfigError,
  resolveRegistryConfig,
  type RegistryConfig,
  type RegistryConfigInput,
} from '@package-broker/core/registry/registry-config';
import type { SourceRecord } from '@package-broker/core/db/source';
import {
  bindCredential,
  CredentialError,
  credentialEchoProbe,
  parseCredentialMaterial,
  type CredentialKind,
} from '@package-broker/core/sources/credentials';
import { GITHUB_API } from '@package-broker/core/ingest/composer/packagist-proxy';
import {
  type UpstreamCredential,
  createPolicyFetch,
} from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { SecretDecryptError, createSecretCipher } from '@package-broker/core/secrets/cipher';
import {
  CredentialNotFoundError,
  createCredentialStore,
} from '@package-broker/core/secrets/credential-store';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor, SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import {
  createSetupUiRoutes,
  createUiRoutes,
  rewriteSetupRequest,
} from '@package-broker/core/kernel/ui-routes';
import { createWorkersAssets } from './assets.js';
import { clientIpOf } from './client-ip.js';
import {
  mcpEnabled,
  brokerObservabilityProblems,
  type BrokerConfig,
} from '@package-broker/core/config';
import { parsePublicOrigin, PublicOriginError } from '@package-broker/core/kernel/public-origin';
import {
  AUDIT_EVENTS,
  KERNEL_EVENTS,
  KERNEL_REASON_CODES,
} from '@package-broker/core/kernel/obs-codes';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import type {
  ConfiguredProviderAnchor,
  ProviderAnchorReader,
} from '@package-broker/core/identity/provider-anchors';
import { buildIdentityProviders, scopedEnv } from '@package-broker/core/identity/providers';
import { createOrgResolver, NotBootstrappedError } from '@package-broker/core/kernel/org';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
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
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';
import type { Registration } from '@package-broker/core/kernel/registry';
import type {
  PluginDefinition,
  PluginPorts,
  SourceProviderContext,
} from '@package-broker/core/plugin';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { completionSpan, upstreamSpan } from '@package-broker/core/platform/completion-span';
import {
  createObservability,
  filterLogLevel,
  safeErrorName,
} from '@package-broker/core/platform/observability';
import type {
  Observability,
  ObsRecord,
  ObsRecordSink,
  ObsRegistry,
} from '@package-broker/core/platform/observability';
import { createOtlpExporter } from '@package-broker/core/platform/otlp';
import type { OtlpExporter } from '@package-broker/core/platform/otlp';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createJobScheduleRepository } from '@package-broker/db-sqlite/repositories/job-schedule';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import {
  KeyringMismatchError,
  KeyringPasswordHashUnreadableError,
  KeyringStoreUnavailableError,
  KeyringVerifierMissingError,
  KeyringVersionInUseError,
  verifyKeyring,
} from '@package-broker/core/secrets/keyring-verifier';
import { SecretsConfigError, readMasterKeys } from '@package-broker/core/secrets/master-key';
import { createCatalogueReader } from '@package-broker/db-sqlite/repositories/catalogue';
import {
  createCatalogueWriter,
  createVisibilityStore,
} from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createScopedAdmission } from '@package-broker/db-sqlite/repositories/scoped-admission';
import { createBlobAccessRepository } from '@package-broker/db-sqlite/repositories/blob-access';
import { createBlobReplacer } from '@package-broker/db-sqlite/repositories/blob-replacer';
import { createCacheEpochRepository } from '@package-broker/db-sqlite/repositories/cache-epoch';
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
import { createPackageIdReads } from '@package-broker/db-sqlite/repositories/package-id';
import { createRepresentationClock } from '@package-broker/db-sqlite/repositories/representation-clock';
import { createSourceRepository } from '@package-broker/db-sqlite/repositories/source';
import { createUpstreamStateRepository } from '@package-broker/db-sqlite/repositories/upstream-state';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';
import { workersCodecs } from './codec/workers-codec.js';
import { createR2ByteStore } from './blob/r2.js';
import type { R2BucketLike } from './blob/r2.js';
import { createCacheApiAdapter, DEFAULT_CACHE_NAMESPACE } from './cache/cache-api.js';
import type { CacheStorageLike } from './cache/cache-api.js';
import { createD1Executor } from './db/d1-executor.js';
import type { D1DatabaseLike } from './db/d1-executor.js';
import {
  createJobBatchSender,
  createJobSender,
  createQueueHandler,
  enqueueAndNotify,
  JOB_EVENTS,
  JOB_REASON_CODES,
  QUEUE_RETRY_DELAY_SECONDS,
  reportJobEvent,
} from './jobs/consumer.js';
import type { JobEvent, QueueBatchLike, QueueLike, QueueMessageLike } from './jobs/consumer.js';
import { createScheduledHandler } from './jobs/cron.js';
import { createWorkersSink } from './observability/workers.js';
import { createRequestScopes } from './request-scope.js';
import type { RequestScope } from './request-scope.js';
import type { AnalyticsEngineLike } from './observability/workers.js';

export type Env = {
  readonly ASSETS?: { fetch(input: Request | string): Promise<Response> };
  readonly DB?: D1DatabaseLike;
  readonly MCP_RATE_LIMIT?: McpRateLimitBinding;
  readonly STORAGE?: R2BucketLike;
  readonly JOBS?: QueueLike;
  readonly ANALYTICS?: AnalyticsEngineLike;
  readonly DEPLOYMENT_ID?: string;
  readonly PB_MASTER_KEY?: string;
  readonly PB_MASTER_KEY_PREVIOUS?: string;
  readonly PB_KEYRING_RESEED?: string;
  readonly PB_PUBLIC_URL?: string;
  readonly [binding: `PB_IDP_${string}`]: string | undefined;
};

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** The step 5 domain services; PB-32 resolves each one from here. */
export interface WorkerAccessServices {
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

export interface WorkerCatalogueServices {
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

export interface WorkerServices {
  readonly providerAnchors: ProviderAnchorReader;
  /** Starts `run` off the request path; a request in flight keeps it alive through `waitUntil`. */
  readonly dispatch: (run: () => Promise<void>) => void;
  readonly catalogue: Pick<CatalogueReader, 'resolveVersions'>;
  /** Null without a DB binding. */
  readonly access: WorkerAccessServices | null;
  /** Null without a DB binding. */
  readonly packages: WorkerCatalogueServices | null;
}

export interface WorkerOptions {
  readonly migrations?: readonly Pick<MigrationSource, 'id' | 'checksum'>[];
  readonly log?: KernelLog;
  readonly authorization?: AuthorizationEngine;
  /** The cloudflare stanza of `platformPorts`; null or absent leaves platform services disabled. */
  readonly platformPorts?: PlatformPortConfig | null;
  /** Registry settings; an invalid value fails startup. Dist URLs use the origin of PB_PUBLIC_URL only, so a path-prefixed public URL is unsupported. */
  readonly registry?: RegistryConfigInput;
  readonly tokens?: BrokerConfig['tokens'];
  readonly vulnerability?: BrokerConfig['vulnerability'];
  readonly mcp?: BrokerConfig['mcp'];
  /** Default `globalThis.caches`; null means the Cache API is unavailable. */
  readonly cacheStorage?: CacheStorageLike | null;
  readonly otlpFetch?: FetchLike;
  readonly observability?: BrokerConfig['observability'];
  readonly console?: { log: (value: unknown) => void; error: (value: unknown) => void };
}

export interface Worker {
  readonly plugins: readonly PluginDefinition[];
  fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response>;
  queue(batch: unknown, env: Env, ctx?: ExecutionContextLike): Promise<void>;
  scheduled(event: unknown, env: Env, ctx?: ExecutionContextLike): Promise<void>;
  /** The services of the application that `fetch` uses for the same bindings. */
  services(env?: Env): Promise<WorkerServices>;
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

const PUBLIC_URL_VARIABLE = 'PB_PUBLIC_URL';
const IDENTITY_FETCH_TIMEOUT_MS = 5000;

export function publicOriginOf(raw: string | undefined): string {
  try {
    return parsePublicOrigin(raw, { http: 'loopback' });
  } catch (error) {
    if (!(error instanceof PublicOriginError)) throw error;
    throw new SecretsConfigError(
      error.problem === 'missing' ? 'missing' : 'malformed',
      PUBLIC_URL_VARIABLE,
    );
  }
}

async function verifyMasterKey(
  keyring: Keyring,
  executor: ScalarSqlExecutor,
  env: Env,
  log: KernelLog,
): Promise<void> {
  try {
    const result = await verifyKeyring(keyring, createKeyringVerifierStore(executor), {
      reseed: env.PB_KEYRING_RESEED === '1',
      onReseedIgnored: (keyVersion) =>
        log({ level: 'warn', event: 'keyring.reseed_ignored', key_version: keyVersion }),
    });
    if (result.reseeded) {
      log({ level: 'warn', event: 'keyring.reseeded', key_version: result.keyVersion });
    }
  } catch (error) {
    if (error instanceof KeyringStoreUnavailableError) {
      throw new KernelConfigError([
        'keyring_verifier: store is unavailable, migrations are not applied',
      ]);
    }
    if (
      error instanceof KeyringMismatchError ||
      error instanceof KeyringVerifierMissingError ||
      error instanceof KeyringVersionInUseError ||
      error instanceof KeyringPasswordHashUnreadableError
    ) {
      throw new KernelConfigError([`PB_MASTER_KEY: ${error.message}`]);
    }
    throw error;
  }
}

async function buildAuth(
  executor: SqlExecutor,
  plugins: readonly PluginDefinition[],
  env: Env,
  log: KernelLog,
  dispatch: (run: () => Promise<void>) => void,
  collectRegistration: () => Registration,
  tokens: TokenWiring,
): Promise<{
  assembly: AccessAssembly;
  auth: AuthModule;
  registration: Registration;
  providerAnchors: ProviderAnchorReader;
  anchors: readonly ConfiguredProviderAnchor[];
  access: WorkerAccessServices;
  keyring: Keyring;
}> {
  const keyring = createKeyring(
    readMasterKeys({ current: env.PB_MASTER_KEY, previous: env.PB_MASTER_KEY_PREVIOUS }),
  );
  const publicOrigin = publicOriginOf(env.PB_PUBLIC_URL);
  await selfTestPasswordHashing(keyring);
  await keyring.hmacKey('token-pepper', keyring.currentVersion);
  const registration = collectRegistration();
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) =>
      fetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS)]),
      }),
    clock: systemClock,
    env: scopedEnv(env),
  });
  await verifyMasterKey(keyring, executor, env, log);
  const built = createAccessServices({
    executor,
    keyring,
    publicOrigin,
    providers,
    clock: systemClock,
    ids: { ulid },
    log,
    dispatch,
    clientIp: clientIpOf,
    registration,
    tokens,
  });
  return {
    assembly: built,
    auth: built.module,
    registration,
    providerAnchors: built.providerAnchors,
    anchors: built.anchors,
    access: built.services,
    keyring,
  };
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

function buildCatalogue(
  executor: SqlExecutor,
  reads: ReturnType<typeof buildPackageReads>,
  anchors: readonly ConfiguredProviderAnchor[],
  log: KernelLog,
): WorkerCatalogueServices {
  return Object.freeze<WorkerCatalogueServices>({
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

export function credentialOrigins(
  source: SourceRecord,
  policy: Parameters<typeof parseSourceConfig>[4]['policy'],
): readonly string[] | null {
  return sourceCredentialOrigins(source, { runtime: 'cloudflare', policy });
}

function openSourceCredential(
  repository: ReturnType<typeof createCredentialRepository>,
  store: ReturnType<typeof createCredentialStore>,
  policy: Parameters<typeof parseSourceConfig>[4]['policy'],
) {
  return async (ctx: OrgContext, source: SourceRecord): Promise<SourceCredential | null> => {
    const origins = credentialOrigins(source, policy);
    if (source.credentialId === null || origins === null) return null;
    try {
      const row = await repository.get(ctx, source.credentialId);
      if (row === null) return null;
      const plaintext = await store.read(ctx, row.id);
      try {
        const material = parseCredentialMaterial(row.kind as CredentialKind, plaintext);
        return {
          credential:
            material.kind === 'github_app' && source.type === 'vcs' && origins[0] === GITHUB_API
              ? { origins: [], queryParams: [], apply: (headers, url) => ({ headers, url }) }
              : bindCredential(material, origins),
          probe: credentialEchoProbe(material),
        };
      } finally {
        plaintext.fill(0);
      }
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
  };
}

function resolveRegistry(
  input: RegistryConfigInput | undefined,
  publicUrl: string,
): RegistryConfig {
  try {
    return resolveRegistryConfig(input, 'cloudflare', publicUrl);
  } catch (error) {
    if (error instanceof RegistryConfigError) {
      throw new KernelConfigError(error.problems.map((problem) => `registry: ${problem}`));
    }
    throw error;
  }
}

function resolveTokenLifetime(input: BrokerConfig['tokens']): TokenLifetimePolicy {
  try {
    return resolveTokenLifetimePolicy(input);
  } catch (error) {
    if (error instanceof TokenConfigError) throw new KernelConfigError(error.problems);
    throw error;
  }
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
            runtime: 'cloudflare',
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
        codecs: workersCodecs,
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

function buildRegistryModule(input: {
  readonly executor: SqlExecutor;
  readonly reads: ReturnType<typeof buildPackageReads>;
  readonly keyring: Keyring;
  readonly platformServices: PlatformServices;
  readonly registration: Registration;
  readonly observability: Observability;
  readonly deploymentId: string;
  readonly registry: RegistryConfig;
  readonly publicUrl: string;
  readonly dispatch: (run: () => Promise<void>) => void;
}): {
  readonly policy: OutboundPolicy;
  readonly module: RegistryModule;
  readonly recorder: AccessRecorder;
  readonly sourceProviderContext: SourceProviderContext;
} {
  const { executor, reads, platformServices, observability, registry, dispatch } = input;
  const outboundPolicy = createOutboundPolicy({
    allowPrivateHosts: [],
    runtime: 'cloudflare',
    selfOrigins: registry.outbound.selfOrigins,
  });
  const writer = createCatalogueWriter(executor);
  const sessions = createIngestSessions(executor);
  const registryReads = createRegistryReads(executor);
  const registrySources = createSourceRepository(executor);
  const blobAccess = createBlobAccessRepository(executor);
  const recorder = createAccessRecorder({
    touch: (ctx, ids) => blobAccess.touch(ctx, ids),
    defer: dispatch,
    now: () => Date.now(),
    onError: () => undefined,
  });
  const credentialRepository = createCredentialRepository(executor);
  const credentialStore = createCredentialStore({
    repository: credentialRepository,
    cipher: createSecretCipher(input.keyring, 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  });
  const credential = openSourceCredential(credentialRepository, credentialStore, outboundPolicy);
  const providerRegistry = createProviderRegistry();
  providerRegistry.register(createComposerRepositoryProvider(outboundPolicy));
  const providers: SourceProvider[] = [];
  for (const provider of input.registration.sourceProviders.values()) {
    providerRegistry.register(provider);
    providers.push(providerRegistry.get(provider.sourceTypes[0]!, provider.id));
  }
  const policyFetch: RegistryModuleDeps['policyFetch'] = (userAgent, context) =>
    createPolicyFetch({
      fetchImpl: (...args) => globalThis.fetch(...args),
      policy: outboundPolicy,
      userAgent,
      observability,
      ...context,
    });
  const dependencies: RegistryModuleDeps = {
    runtime: 'cloudflare',
    registryJobs: registryJobDependencies({
      executor,
      providers: providerRegistry,
      sourceProviders: providers,
      policy: outboundPolicy,
      credential,
      webhook: {
        loadCredential: githubApp,
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
              ? registry.userAgent.composerStyle
              : registry.userAgent.default),
        ),
    }),
    ports: {
      blob: platformServices.blob,
      cache: platformServices.cache,
      observability,
      jobs: createRepositoryJobs({
        store: platformServices.jobStore,
        jobs: input.registration.jobs,
        clock: systemClock,
        ids: { ulid },
      })('core', { projectId: null, tokenId: null }),
    },
    clock: systemClock,
    codecs: workersCodecs,
    publicUrl: input.publicUrl,
    registry,
    outboundPolicy,
    policyFetch,
    deploymentId: input.deploymentId,
    providers,
    catalogue: {
      reader: reads.reader,
      scopedAdmission: createScopedAdmission(executor),
      epoch: createCacheEpochRepository(executor),
      representationClock: createRepresentationClock(executor),
      upstreamState: createUpstreamStateRepository(executor),
      sources: registrySources,
      covers: registryReads.covers,
      versionById: registryReads.versionById,
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
      credential,
      credentialUnavailable: (ctx, id) => registrySources.markCredentialUnavailable(ctx, id),
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
      writeGuard: createFetchLeaseWriteGuard,
      writer,
      blobReplacer: createBlobReplacer(executor),
      recorder,
    },
  };
  const module = createRegistryModule(dependencies);
  const job = module.packageSyncJob;
  const sources = createSourceRepository(executor);
  const discoveryBindings = new WeakMap<
    UpstreamCredential,
    {
      orgId: string;
      credentialId: string;
      installationId: string;
    }
  >();
  async function githubApp(org: OrgContext, credentialId: string) {
    try {
      const row = await credentialRepository.get(org, credentialId);
      if (row === null || row.projectId !== null || row.kind !== 'github_app') return null;
      const plaintext = await credentialStore.read(org, row.id);
      try {
        const material = parseCredentialMaterial('github_app', plaintext);
        return material.kind === 'github_app' ? material : null;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (
        error instanceof CredentialError ||
        error instanceof SecretDecryptError ||
        error instanceof CredentialNotFoundError
      )
        return null;
      throw error;
    }
  }
  return {
    policy: outboundPolicy,
    sourceProviderContext: {
      runtime: 'cloudflare',
      async discoveryCredential(org, credentialId, installationId) {
        if (!/^[1-9][0-9]{0,19}$/.test(installationId)) return null;
        if ((await githubApp(org, credentialId)) === null) return null;
        const credential: UpstreamCredential = {
          origins: [],
          queryParams: [],
          apply: (headers, url) => ({ headers, url }),
        };
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
              runtime: 'cloudflare',
              policy: outboundPolicy,
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
        const app = await githubApp(org, credentialId);
        return app === null
          ? null
          : create(
              { appId: app.appId, privateKeyPem: app.privateKeyPem },
              installationId,
              credentialId,
            );
      },
    },
    module:
      job === undefined
        ? module
        : Object.freeze({
            ...module,
            packageSyncJob: Object.freeze({
              ...job,
              handler: (payload, context) => {
                const scoped = createRegistryModule({
                  ...dependencies,
                  ports: { ...dependencies.ports, observability: context.observability },
                  ingest: {
                    ...dependencies.ingest,
                    apply: { ...dependencies.ingest.apply, observability: context.observability },
                  },
                }).packageSyncJob;
                if (scoped === undefined) throw new PlatformUnavailableError();
                return scoped.handler(payload, context);
              },
            } satisfies JobDefinition),
          }),
    recorder,
  };
}

const NO_ANCHORS: ProviderAnchorReader = Object.freeze({
  anchors: () => Promise.resolve(Object.freeze([])),
});

function withoutBodyForHead(request: Request, response: Response): Response {
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

const STARTUP_EVENTS = [
  'startup.failed',
  'obs.analytics_unconfigured',
  'cache.put_untracked',
  'deferred.untracked',
] as const;
const MAX_CACHED_APPLICATIONS = 8;
const FINGERPRINT_BINDINGS = [
  'ASSETS',
  'DB',
  'STORAGE',
  'JOBS',
  'ANALYTICS',
  'MCP_RATE_LIMIT',
] as const;
const HISTOGRAM_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

type Handler = (input: unknown) => Promise<void>;

interface Application {
  readonly kernel: Kernel;
  readonly services: WorkerServices;
  readonly queue?: Handler;
  readonly scheduled?: Handler;
  flush(): Promise<void>;
  fail(event: JobEvent, error: unknown): void;
}

interface Bound {
  readonly db: D1DatabaseLike;
  readonly bucket: R2BucketLike;
  readonly queue: QueueLike;
  readonly analytics: AnalyticsEngineLike | undefined;
  readonly deploymentId: string;
  readonly cacheStorage: CacheStorageLike;
  readonly otlp: { readonly endpoint: string; readonly headers: Record<string, string> } | null;
}

function read(env: Env, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === 'function');
}

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function stringRecord(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

function resolveBindings(
  stanza: PlatformPortConfig,
  env: Env,
  cacheStorage: CacheStorageLike | null | undefined,
): Bound {
  const problems: string[] = [];
  const db = read(env, 'DB');
  if (!hasMethods(db, ['prepare', 'batch'])) problems.push('DB: not bound');
  if (stanza.blob.adapter !== 'r2') problems.push('blob.adapter: must be r2');
  if (stanza.cache.adapter !== 'cache-api') problems.push('cache.adapter: must be cache-api');
  if (stanza.jobs.adapter !== 'queues') problems.push('jobs.adapter: must be queues');
  if (stanza.observability.adapter !== 'workers') {
    problems.push('observability.adapter: must be workers');
  }
  const bucketName = stanza.blob.binding;
  const bucket = bucketName === undefined ? undefined : read(env, bucketName);
  if (!hasMethods(bucket, ['head', 'get', 'put', 'delete'])) {
    problems.push(`blob.binding: ${bucketName ?? 'unnamed'} is not bound`);
  }
  const queueName = stanza.jobs.binding;
  const queue = queueName === undefined ? undefined : read(env, queueName);
  if (!hasMethods(queue, ['send', 'sendBatch'])) {
    problems.push(`jobs.binding: ${queueName ?? 'unnamed'} is not bound`);
  }
  const analyticsName = stanza.observability.analyticsBinding;
  const analytics = analyticsName === undefined ? undefined : read(env, analyticsName);
  if (analyticsName !== undefined && !hasMethods(analytics, ['writeDataPoint'])) {
    problems.push(`observability.analyticsBinding: ${analyticsName} is not bound`);
  }
  const deploymentId = read(env, 'DEPLOYMENT_ID');
  if (typeof deploymentId !== 'string' || !DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    problems.push('DEPLOYMENT_ID: missing or malformed');
  }
  if (cacheStorage === null || cacheStorage === undefined) {
    problems.push('cache: the Cache API is unavailable');
  }
  let otlp: Bound['otlp'] = null;
  const { endpointEnv, headersEnv } = stanza.observability;
  if (endpointEnv !== undefined) {
    const endpoint = read(env, endpointEnv);
    let headers: Record<string, string> | null = {};
    if (headersEnv !== undefined) {
      const raw = read(env, headersEnv);
      headers = typeof raw === 'string' ? stringRecord(raw) : null;
      if (headers === null) problems.push(`observability.headersEnv: ${headersEnv} is malformed`);
    }
    if (typeof endpoint !== 'string' || endpoint === '') {
      problems.push(`observability.endpointEnv: ${endpointEnv} is not set`);
    } else if (headers !== null) {
      otlp = { endpoint, headers };
    }
  }
  if (problems.length > 0) throw new KernelConfigError(problems);
  return {
    db: db as D1DatabaseLike,
    bucket: bucket as R2BucketLike,
    queue: queue as QueueLike,
    analytics: analytics as AnalyticsEngineLike | undefined,
    deploymentId: deploymentId as string,
    cacheStorage: cacheStorage as CacheStorageLike,
    otlp,
  };
}

function histogramPoint(value: number): { bucketCounts: number[] } {
  const bucketCounts = new Array<number>(HISTOGRAM_BOUNDS.length + 1).fill(0);
  const index = HISTOGRAM_BOUNDS.findIndex((bound) => value <= bound);
  bucketCounts[index === -1 ? HISTOGRAM_BOUNDS.length : index] = 1;
  return { bucketCounts };
}

function bridgeToOtlp(exporter: OtlpExporter, record: ObsRecord): void {
  if (record.kind === 'log') {
    exporter.export('logs', record.record);
    return;
  }
  const labels = { ...record.labels } as Record<string, string>;
  if (record.kind === 'counter') {
    exporter.export('metrics', { kind: 'counter', name: record.name, value: record.value, labels });
    return;
  }
  exporter.export('metrics', {
    kind: 'histogram',
    name: record.name,
    bounds: HISTOGRAM_BOUNDS,
    ...histogramPoint(record.value),
    count: 1,
    sum: record.value,
    labels,
  });
}

const NO_ENV: Env = Object.freeze({});
function scheduleDefinitions(jobs: Registration['jobs']) {
  return jobs.flatMap((job) =>
    job.definition.schedule === undefined
      ? []
      : [
          {
            name: job.qualifiedName,
            everySeconds: job.definition.schedule.everySeconds,
            ...(job.definition.maxAttempts === undefined
              ? {}
              : { maxAttempts: job.definition.maxAttempts }),
          },
        ],
  );
}

function delegatingObservability(target: () => Observability): Observability {
  const delegate: Observability = {
    log: (record) => target().log(record),
    counter: (name, labels, value) => target().counter(name, labels, value),
    histogram: (name, value, labels) => target().histogram(name, value, labels),
  };
  return Object.freeze(delegate);
}

function notificationOrg(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(body, 'org');
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function queueBatchOf(batch: unknown): QueueBatchLike {
  let messages: unknown;
  try {
    messages = (batch as { messages?: unknown } | null | undefined)?.messages;
  } catch {
    messages = undefined;
  }
  return { messages: Array.isArray(messages) ? (messages as QueueMessageLike[]) : [] };
}

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
            : createBlobPurgeJob({ lifecycle });
        await bound.handler(payload, context);
      },
    }),
  );
}

export const BLOB_PURGE_LEASE_SECONDS = 900;
export const BLOB_DELETE_TIMEOUT_MS = 30_000;

export function blobPurgeTiming(
  deleteTimeoutMs: number,
  purgeLeaseSeconds: number,
): { deleteTimeoutMs: number; leaseMs: number } {
  const leaseMs = purgeLeaseSeconds * 1000;
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isInteger(deleteTimeoutMs) ||
    deleteTimeoutMs < 1000 ||
    deleteTimeoutMs > leaseMs / 10
  ) {
    throw new KernelConfigError([
      'blob.deleteTimeoutMs: must be at least 1000 ms and at most a tenth of the purge lease',
    ]);
  }
  return { deleteTimeoutMs, leaseMs };
}

const uploadAdmission = createBlobUploadAdmission();

function retryAll(messages: readonly QueueMessageLike[], report: (error: unknown) => void): void {
  try {
    for (const message of messages) {
      try {
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
}

function logJobFailure(log: KernelLog, event: JobEvent, error: unknown): void {
  try {
    log({ level: 'error', event, error_name: safeErrorName(error) });
  } catch {
    return;
  }
}

function logBuildFailure(log: KernelLog, error: unknown): void {
  if (!(error instanceof KernelConfigError)) return;
  try {
    log({
      level: 'error',
      event: 'startup.misconfigured',
      error_name: safeErrorName(error),
      problems: error.problems,
    });
  } catch {
    return;
  }
}

async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function createWorker(
  plugins: readonly PluginDefinition[],
  options: WorkerOptions = {},
): Worker {
  const log = options.log ?? defaultLog;
  const stanza = options.platformPorts ?? null;
  const cacheStorage =
    options.cacheStorage === undefined
      ? (globalThis as { caches?: CacheStorageLike }).caches
      : options.cacheStorage;
  const applications = new Map<string, { pending: Promise<Application>; failedUntil?: number }>();
  const scopes = createRequestScopes();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;

  function identity(value: unknown): string {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return value === undefined ? '-' : `v:${typeof value}`;
    }
    let id = identities.get(value);
    if (id === undefined) {
      nextIdentity += 1;
      id = nextIdentity;
      identities.set(value, id);
    }
    return String(id);
  }

  const fingerprints = new WeakMap<object, Promise<string>>();

  function fingerprint(env: Env): Promise<string> {
    let cached = fingerprints.get(env);
    if (cached === undefined) {
      cached = computeFingerprint(env);
      fingerprints.set(env, cached);
    }
    return cached;
  }

  async function computeFingerprint(env: Env): Promise<string> {
    const names = new Set<string>(FINGERPRINT_BINDINGS);
    const variables = new Set<string>(Object.keys(env).filter((name) => name.startsWith('PB_')));
    if (stanza !== null) {
      for (const name of [
        stanza.blob.binding,
        stanza.jobs.binding,
        stanza.observability.analyticsBinding,
      ]) {
        if (name !== undefined) names.add(name);
      }
      for (const name of [
        stanza.observability.endpointEnv,
        stanza.observability.headersEnv,
        stanza.observability.deploymentIdEnv,
      ]) {
        if (name !== undefined) variables.add(name);
      }
    }
    const configuration = await digestOf(
      JSON.stringify(
        [...variables].sort().map((name) => {
          const value = read(env, name);
          return [name, typeof value === 'string' ? value : null];
        }),
      ),
    );
    const deploymentId = read(env, 'DEPLOYMENT_ID');
    return JSON.stringify([
      [...names].map((name) => identity(read(env, name))),
      typeof deploymentId === 'string' ? deploymentId : null,
      configuration,
    ]);
  }

  function buildPlatform(
    config: PlatformPortConfig,
    bound: Bound,
    executor: SqlExecutor,
    registration: Registration,
    resolveOrg: () => Promise<OrgContext>,
  ) {
    const repository = createJobRepository(executor);
    const schedule = createJobScheduleRepository(executor);
    const routeTemplates = new Set<string>();
    const workersSink = createWorkersSink({
      deploymentId: bound.deploymentId,
      ...(bound.analytics === undefined ? {} : { analytics: bound.analytics }),
      ...(options.console === undefined ? {} : { console: options.console }),
    });
    const newExporter = (): OtlpExporter | undefined =>
      bound.otlp === null
        ? undefined
        : createOtlpExporter({
            endpoint: bound.otlp.endpoint,
            headers: bound.otlp.headers,
            ...(options.otlpFetch === undefined ? {} : { fetchImpl: options.otlpFetch }),
            resource: {
              service: 'package-broker',
              deploymentId: bound.deploymentId,
              runtime: 'cloudflare',
            },
            routeTemplates,
            metrics: {
              counter: (name, labels = {}, value = 1) =>
                workersSink.emit({ kind: 'counter', name, labels, value }),
            },
          });
    let exporter = newExporter();
    const untrackedReported = new Set<string>();
    const flush = async (): Promise<void> => {
      const full = exporter;
      if (full === undefined) return;
      exporter = newExporter();
      await full.flush();
    };
    const track = (
      event: 'cache.put_untracked' | 'deferred.untracked',
      promise: Promise<unknown>,
    ) => {
      if (scopes.track(promise)) return;
      promise.catch(() => undefined);
      if (untrackedReported.has(event)) return;
      untrackedReported.add(event);
      try {
        observability.log({ level: 'warn', event });
      } catch {
        return;
      }
    };
    const outputs = filterLogLevel(
      {
        emit(record) {
          const httpMetric = record.kind !== 'log' && record.name.startsWith('pb.http.');
          if (!(httpMetric && bound.analytics === undefined)) workersSink.emit(record);
          if (exporter !== undefined) bridgeToOtlp(exporter, record);
        },
      },
      options.observability?.level,
    );
    const sink: ObsRecordSink = {
      emit(record) {
        outputs.emit(record);
        if (record.kind !== 'log' || exporter === undefined) return;
        const span = completionSpan(record.record, routeTemplates) ?? upstreamSpan(record.record);
        if (span !== null) exporter.export('traces', span);
      },
    };
    const registry = (templates: ReadonlySet<string>): ObsRegistry => ({
      events: new Set<string>([
        ...KERNEL_EVENTS,
        ...INGEST_EVENTS,
        ...AUDIT_EVENTS,
        ...JOB_EVENTS,
        ...STARTUP_EVENTS,
      ]),
      reasonCodes: new Set<string>([
        ...KERNEL_REASON_CODES,
        ...JOB_REASON_CODES,
        ...INGEST_REASON_CODES,
      ]),
      routeTemplates: templates,
    });
    const scope = {
      deploymentId: bound.deploymentId,
      runtime: 'cloudflare',
      requestId: null,
    } as const;
    let current = createObservability(sink, scope, registry(routeTemplates));
    const observability = delegatingObservability(() => current);

    const definitions = registration.jobs.map((job) => job.qualifiedName);
    blobPurgeTiming(BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS);
    const byteStore = createR2ByteStore(bound.bucket);
    const platformServices: PlatformServices = Object.freeze({
      blob: createBlobStore(
        byteStore,
        createBlobRepository(executor, { purgeLeaseSeconds: BLOB_PURGE_LEASE_SECONDS }),
        {
          admission: uploadAdmission,
          maxBytes: config.blob.maxBytes,
        },
      ),
      cache: createCacheApiAdapter(
        bound.cacheStorage,
        config.cache.namespace ?? DEFAULT_CACHE_NAMESPACE,
        { metrics: observability, waitUntil: (promise) => track('cache.put_untracked', promise) },
      ),
      jobStore: Object.freeze({
        enqueue: enqueueAndNotify({
          repository,
          send: createJobSender(bound.queue),
          observability,
        }),
        status: (ctx: OrgContext, id: string) => repository.status(ctx, id),
      }),
    });

    const org = async (): Promise<OrgContext | null> => {
      try {
        return await resolveOrg();
      } catch (error) {
        if (error instanceof NotBootstrappedError) return null;
        throw error;
      }
    };

    function attach(kernel: Kernel): Omit<Application, 'kernel' | 'services'> {
      for (const template of kernel.routeTemplates) routeTemplates.add(template);
      current = createObservability(sink, scope, registry(routeTemplates));
      const consume = createQueueHandler({
        repository,
        jobs: registration,
        observability,
        scope: kernel.jobScope,
        limits: { maxRunning: config.jobs.maxRunning },
        runnerObservability: ({ jobId, attempt }) =>
          createObservability(sink, { ...scope, jobId, attempt }, registry(routeTemplates)),
      });
      const tick = createScheduledHandler({
        repository,
        schedule,
        sendJobs: createJobBatchSender(bound.queue),
        org,
        definitions: scheduleDefinitions(registration.jobs),
        types: definitions,
        observability,
      });
      return {
        async queue(input) {
          const batch = queueBatchOf(input);
          let ctx: OrgContext | null;
          try {
            ctx = await org();
          } catch (error) {
            reportJobEvent(observability, 'error', 'job.batch_failed', error);
            retryAll(batch.messages, (failure) =>
              reportJobEvent(observability, 'error', 'job.retry_failed', failure),
            );
            return;
          }
          const accepted: QueueMessageLike[] = [];
          for (const message of batch.messages) {
            if (ctx !== null && notificationOrg(message?.body) === ctx.orgId) {
              accepted.push(message);
              continue;
            }
            reportJobEvent(observability, 'warn', 'job.notification_rejected');
            try {
              message.ack();
            } catch (error) {
              reportJobEvent(observability, 'error', 'job.ack_failed', error);
            }
          }
          if (accepted.length > 0) await consume({ messages: accepted }, undefined);
        },
        scheduled: (event) => tick(event, undefined),
        flush,
        fail: (event, error) => reportJobEvent(observability, 'error', event, error),
      };
    }

    function failed(error: unknown): void {
      try {
        observability.log({
          level: 'error',
          event: 'startup.failed',
          error_name: safeErrorName(error),
        });
      } catch {
        return;
      }
    }

    return {
      platformServices,
      retention: {
        store: byteStore,
        deleteTimeoutMs: BLOB_DELETE_TIMEOUT_MS,
        leaseMs: BLOB_PURGE_LEASE_SECONDS * 1000,
      },
      observability,
      sink,
      deploymentId: bound.deploymentId,
      attach,
      failed,
      track,
    };
  }

  async function build(env: Env | undefined): Promise<Application> {
    const enabled = mcpEnabled({
      platform: 'cloudflare',
      plugins,
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    });
    try {
      assertMcpRateLimit({ runtime: 'workers', mcpEnabled: enabled, binding: env?.MCP_RATE_LIMIT });
    } catch (error) {
      if (error instanceof McpRateLimitConfigError) throw new KernelConfigError([error.message]);
      throw error;
    }
    const observabilityProblems = brokerObservabilityProblems({
      platform: 'cloudflare',
      plugins,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
    });
    if (observabilityProblems.length > 0) throw new KernelConfigError(observabilityProblems);
    const lifetime = resolveTokenLifetime(options.tokens);
    const patJobs = createPatJobHolder();
    const config = stanza;
    const bound = config === null ? null : resolveBindings(config, env ?? {}, cacheStorage);
    const db = bound?.db ?? env?.DB;
    const publicUrl =
      config === null || db === undefined ? undefined : publicOriginOf(env?.PB_PUBLIC_URL);
    if (options.registry !== undefined && (config === null || db === undefined)) {
      throw new KernelConfigError(['registry: requires platformPorts and DB']);
    }
    const registryConfig =
      publicUrl === undefined ? undefined : resolveRegistry(options.registry, publicUrl);
    const executor: SqlExecutor | ScalarSqlExecutor =
      db === undefined ? unboundExecutor() : createD1Executor(db);
    const bootstrap = createOrganizationBootstrap(executor);
    const organizations = createOrganizationRepository(executor);
    const resolveOrg = createOrgResolver(bootstrap);

    let untrackedLogged = false;
    const dispatch = (run: () => Promise<void>): void => {
      const work = Promise.resolve().then(run);
      if (services !== undefined) services.track('deferred.untracked', work);
      else if (!scopes.track(work)) {
        work.catch(() => undefined);
        if (untrackedLogged) return;
        untrackedLogged = true;
        try {
          log({ level: 'warn', event: 'deferred.untracked' });
        } catch {
          return;
        }
      }
    };

    const coreJobBindings: {
      services: ReturnType<typeof buildPlatform> | undefined;
      registry: ReturnType<typeof buildRegistryModule> | undefined;
    } = { services: undefined, registry: undefined };

    function registerObservedJob<P>(
      definition: JobDefinition<P>,
      registry: ObsRegistry = {
        events: AUDIT_EVENTS,
        reasonCodes: new Set(),
        routeTemplates: new Set(),
      },
    ): RegisteredCoreJob {
      return registerCoreJob({
        ...definition,
        handler: async (payload, context) => {
          const services = coreJobBindings.services;
          if (services === undefined) throw new PlatformUnavailableError();
          return definition.handler(definition.validate(payload), {
            ...context,
            observability: createObservability(
              services.sink,
              {
                deploymentId: services.deploymentId,
                runtime: 'cloudflare',
                requestId: null,
                plugin: 'core',
                jobId: context.jobId,
                attempt: context.attempt,
              },
              registry,
            ),
          });
        },
      });
    }
    let vulnerabilityRuntime: ReturnType<typeof createVulnerabilityRuntime> | undefined;
    const vulnerability = (): ReturnType<typeof createVulnerabilityRuntime> =>
      (vulnerabilityRuntime ??= createVulnerabilityRuntime({
        config: {
          platform: 'cloudflare',
          plugins,
          ...(options.vulnerability === undefined ? {} : { vulnerability: options.vulnerability }),
        },
        repository: createVulnerabilityRepository(executor as SqlExecutor, systemClock),
        policyFetch: createPolicyFetch({
          fetchImpl: (...args) => globalThis.fetch(...args),
          policy: createOutboundPolicy({
            allowPrivateHosts: [],
            runtime: 'cloudflare',
            selfOrigins: publicUrl === undefined ? [] : [publicUrl],
          }),
          userAgent: 'PackageBroker/2.0',
        }),
        clock: systemClock,
      }));
    const importJobs = createImportJobHolder();
    const reads = db === undefined ? undefined : buildPackageReads(executor as SqlExecutor);
    const collectRegistration = (): Registration =>
      collectRegistrations(plugins, {
        sourceProviderContext: {
          runtime: 'cloudflare',
          discoveryCredential: async (org, credentialId, installationId) =>
            coreJobBindings.registry?.sourceProviderContext.discoveryCredential?.(
              org,
              credentialId,
              installationId,
            ) ?? null,
          tokensFor: async (org, source, create) =>
            coreJobBindings.registry?.sourceProviderContext.tokensFor(org, source, create) ?? null,
        },
        ...(reads === undefined ? {} : { packageResolver: reads.resolver }),
        coreJobs:
          config === null
            ? []
            : [
                ...(db === undefined
                  ? []
                  : vulnerability().jobs.map((job) =>
                      registerObservedJob(job.definition, {
                        events: new Set([VULNERABILITY_EVENT]),
                        reasonCodes: new Set(VULNERABILITY_REASON_CODES),
                        routeTemplates: new Set(),
                      }),
                    )),
                ...(db === undefined
                  ? []
                  : retentionRegistrations(executor as SqlExecutor, () => {
                      if (services === undefined) throw new JobError('handler_error');
                      return services.retention;
                    })),
                registerObservedJob(
                  auditSealJob(createAuditSealRepository(executor as SqlExecutor)),
                ),
                registerObservedJob(
                  auditVerifyJob(createAuditVerifyReader(executor as SqlExecutor)),
                ),
                ...(db === undefined ? [] : importJobRegistrations(importJobs)),
                ...(db === undefined
                  ? []
                  : patOffboardingRegistrations(executor as SqlExecutor, patJobs, log)),
                ...(db === undefined || registryConfig === undefined
                  ? []
                  : [
                      ...[sourceSyncJob, sourcePollJob].map((definition) =>
                        registerObservedJob(
                          {
                            ...definition,
                            handler: (payload, context) => {
                              const job = coreJobBindings.registry?.module.coreJobs?.find(
                                (job) => job.definition.name === definition.name,
                              );
                              if (job === undefined) throw new PlatformUnavailableError();
                              return job.definition.handler(payload, context);
                            },
                          },
                          {
                            events: INGEST_EVENTS,
                            reasonCodes: INGEST_REASON_CODES,
                            routeTemplates: new Set(),
                          },
                        ),
                      ),
                      registerObservedJob(
                        {
                          ...packageSyncJob,
                          handler: (payload, context) => {
                            const job = coreJobBindings.registry?.module.packageSyncJob;
                            if (job === undefined) throw new PlatformUnavailableError();
                            return job.handler(payload, context);
                          },
                        },
                        {
                          events: INGEST_EVENTS,
                          reasonCodes: INGEST_REASON_CODES,
                          routeTemplates: new Set(),
                        },
                      ),
                    ]),
              ],
      });
    const built =
      db === undefined
        ? undefined
        : await buildAuth(
            executor as SqlExecutor,
            plugins,
            env ?? {},
            log,
            dispatch,
            collectRegistration,
            tokenWiring(lifetime, patJobs, config !== null),
          );
    const registration = built?.registration ?? collectRegistration();
    const auth = built?.auth;
    const services =
      config === null || bound === null
        ? undefined
        : buildPlatform(config, bound, executor as SqlExecutor, registration, resolveOrg);
    coreJobBindings.services = services;
    if (built !== undefined && services !== undefined) {
      importJobs.set({
        verificationStore: createImportVerificationStore({
          executor: executor as SqlExecutor,
          providerAnchors: built.anchors,
        }),
        applyStore: createImportJournalStore({
          executor: executor as SqlExecutor,
          providerAnchors: built.anchors,
        }),
        rollbackStore: createImportRollbackStore({
          executor: executor as SqlExecutor,
          providerAnchors: built.anchors,
        }),
        blobs: services.platformServices.blob,
      });
    }
    if (services !== undefined && built !== undefined) {
      patJobs.set(
        createRepositoryJobs({
          store: services.platformServices.jobStore,
          jobs: registration.jobs,
          clock: systemClock,
          ids: { ulid },
        })('core', { projectId: null, tokenId: null }),
      );
    }

    const registryModule =
      built === undefined ||
      reads === undefined ||
      services === undefined ||
      registryConfig === undefined ||
      publicUrl === undefined
        ? undefined
        : buildRegistryModule({
            executor: executor as SqlExecutor,
            reads,
            keyring: built.keyring,
            platformServices: services.platformServices,
            registration,
            observability: services.observability,
            deploymentId: services.deploymentId,
            registry: registryConfig,
            publicUrl,
            dispatch,
          });
    coreJobBindings.registry = registryModule;

    const ports: PluginPorts = {
      organizations: Object.freeze({ get: (ctx: OrgContext) => organizations.get(ctx) }),
      clock: systemClock,
      ids: { ulid },
    };

    const packages =
      built === undefined || reads === undefined
        ? null
        : buildCatalogue(executor as SqlExecutor, reads, built.anchors, log);
    const applicationServices: WorkerServices = Object.freeze({
      providerAnchors: built?.providerAnchors ?? NO_ANCHORS,
      dispatch,
      catalogue: createCatalogueReader(executor as SqlExecutor),
      access: built?.access ?? null,
      packages,
    });
    const apiRoutes =
      built === undefined || packages === null
        ? []
        : createApiRoutes({
            clientIp: clientIpOf,
            executor: executor as SqlExecutor,
            keyring: built.keyring,
            runtime: 'cloudflare',
            access: built.assembly,
            packages,
            vulnerability: vulnerability(),
            policy:
              registryModule?.policy ??
              createOutboundPolicy({
                allowPrivateHosts: [],
                runtime: 'cloudflare',
                selfOrigins: [publicOriginOf(env?.PB_PUBLIC_URL)],
              }),
            lifetime,
            log,
            blob: services?.platformServices.blob,
            vcsProviders: () =>
              registryModule === undefined
                ? []
                : reportedVcsProviders('cloudflare', registration.sourceProviders.values()),
          });
    const authorization = options.authorization ?? auth?.authorization;

    type UiAssets = Awaited<ReturnType<typeof createWorkersAssets>>;
    let assets: Promise<UiAssets | null> | undefined;
    const uiAssets = () => {
      if (assets !== undefined) return assets;
      const pending: Promise<UiAssets | null> = createWorkersAssets(
        env?.ASSETS ?? { fetch: async () => new Response(null, { status: 404 }) },
      ).catch(() => {
        if (assets === pending) assets = undefined;
        log({ level: 'warn', event: 'ui.manifest_invalid' });
        return null;
      });
      return (assets = pending);
    };
    const uiRoutes = createUiRoutes(
      {
        manifest: async () => (await uiAssets())?.manifest() ?? null,
        read: async (name) => (await uiAssets())?.read(name) ?? null,
      },
      { publicOrigin: env?.PB_PUBLIC_URL ?? 'http://localhost', log },
    );
    const setupRoutes = createSetupUiRoutes(
      {
        manifest: async () => (await uiAssets())?.manifest() ?? null,
        read: async (name) => (await uiAssets())?.read(name) ?? null,
      },
      { publicOrigin: env?.PB_PUBLIC_URL ?? 'http://localhost', log },
    );
    try {
      const coreRoutes = [
        ...(auth?.coreRoutes ?? []),
        ...apiRoutes,
        openApiRoute(openApiDocument),
        ...(registryModule?.module.coreRoutes ?? []).map((route) => ({
          ...route,
          async handler(context: Parameters<typeof route.handler>[0]) {
            const response = await route.handler(context);
            return response.status === 401 ? new Response(null, { status: 404 }) : response;
          },
        })),
        ...(env?.ASSETS === undefined ? [] : [...setupRoutes, ...uiRoutes]),
      ];
      if (enabled) {
        const publicOrigin = publicOriginOf(env?.PB_PUBLIC_URL);
        const handlers = createMcpTools({
          routes: [...coreRoutes, ...registration.routes],
          publicOrigin,
          kernel: { fetch: (request) => kernel.fetch(request) },
        });
        coreRoutes.push(
          ...createMcpRoutes({
            handlers,
            publicOrigin,
            limiter: createMcpLimiter(env!.MCP_RATE_LIMIT!),
          }),
        );
      }
      const migrations = options.migrations;
      const kernel = await createKernel({
        platform: 'cloudflare',
        ...(env?.PB_PUBLIC_URL === undefined
          ? {}
          : { publicOrigin: publicOriginOf(env.PB_PUBLIC_URL) }),
        plugins,
        registration,
        ports,
        ...(services === undefined ? {} : { platformServices: services.platformServices }),
        resolveOrg,
        health: async () => (await bootstrap.findSingleton()) !== null,
        ...(migrations === undefined
          ? {}
          : { schemaMatches: () => schemaMigrationsMatch(executor, migrations) }),
        coreRoutes,
        ...(authorization === undefined ? {} : { authorization }),
        ...(registryModule === undefined
          ? reads === undefined
            ? {}
            : { packageResolver: reads.resolver }
          : {
              packageResolver: registryModule.module.visibilityPort,
              ecosystemRoutes: registryModule.module.ecosystemRoutes,
            }),
        ...(services === undefined
          ? { log }
          : {
              observability: {
                sink: services.sink,
                level: options.observability?.level ?? 'info',
                deploymentId: services.deploymentId,
                trustInboundTraceparent: options.observability?.trustInboundTraceparent === true,
              },
            }),
      });
      if (services === undefined)
        return {
          kernel,
          services: applicationServices,
          flush: () => Promise.resolve(),
          fail: (event, error) => logJobFailure(log, event, error),
        };
      const attached = services.attach(kernel);
      return {
        kernel,
        services: applicationServices,
        ...attached,
        flush: async () => {
          try {
            await registryModule?.recorder.flush();
          } finally {
            await attached.flush();
          }
        },
      };
    } catch (error) {
      services?.failed(error);
      throw error;
    }
  }

  async function applicationFor(env: Env | undefined): Promise<Application> {
    const key = await fingerprint(env ?? NO_ENV);
    const cached = applications.get(key);
    if (cached !== undefined) {
      applications.delete(key);
      if (cached.failedUntil === undefined || Date.now() < cached.failedUntil) {
        applications.set(key, cached);
        return cached.pending;
      }
    }

    const pending = build(env).catch((error: unknown) => {
      const entry = applications.get(key);
      if (entry?.pending === pending) {
        if (error instanceof KernelConfigError) entry.failedUntil = Date.now() + 30_000;
        else applications.delete(key);
      }
      logBuildFailure(log, error);
      throw error;
    });
    if (applications.size >= MAX_CACHED_APPLICATIONS) {
      const oldest = applications.keys().next();
      if (oldest.done !== true) applications.delete(oldest.value);
    }
    applications.set(key, { pending });
    return pending;
  }

  function defer(
    scope: RequestScope,
    application: Application,
    ctx: ExecutionContextLike | undefined,
  ): void {
    if (ctx === undefined) {
      void scope.settle();
      return;
    }
    const finish = async (): Promise<void> => {
      await scope.settle();
      try {
        await application.flush();
      } catch {
        return;
      }
    };
    try {
      ctx.waitUntil(finish());
    } catch {
      return;
    }
  }

  function inScope<T>(
    application: Application,
    ctx: ExecutionContextLike | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    return scopes.run(async (scope) => {
      try {
        return await work();
      } finally {
        defer(scope, application, ctx);
      }
    });
  }

  async function event(
    failure: 'job.batch_failed' | 'job.cron_failed',
    pick: (application: Application) => Handler | undefined,
    input: unknown,
    env: Env,
    ctx: ExecutionContextLike | undefined,
    onFailure: () => void,
  ): Promise<void> {
    let application: Application;
    try {
      application = await applicationFor(env);
    } catch (error) {
      logJobFailure(log, failure, error);
      onFailure();
      return;
    }
    await inScope(application, ctx, async () => {
      try {
        const handler = pick(application);
        if (handler === undefined) onFailure();
        else await handler(input);
      } catch (error) {
        application.fail(failure, error);
        onFailure();
      }
    });
  }

  function retryBatch(batch: unknown): void {
    retryAll(queueBatchOf(batch).messages, (error) =>
      logJobFailure(log, 'job.retry_failed', error),
    );
  }

  return {
    plugins,
    async fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response> {
      const requestId = crypto.randomUUID();
      let application: Application;
      try {
        application = await applicationFor(env);
      } catch (error) {
        return withoutBodyForHead(request, errorResponse(error, requestId, log));
      }
      return inScope(application, ctx, async () => {
        try {
          const setup = rewriteSetupRequest(request);
          if (setup !== null) return await application.kernel.fetch(setup, ctx);
          return await application.kernel.fetch(request, ctx);
        } catch (error) {
          return withoutBodyForHead(request, errorResponse(error, requestId, log));
        }
      });
    },
    async services(env?: Env): Promise<WorkerServices> {
      return (await applicationFor(env)).services;
    },
    queue: (batch, env, ctx) =>
      event(
        'job.batch_failed',
        (application) => application.queue,
        batch,
        env,
        ctx,
        () => retryBatch(batch),
      ),
    scheduled: (input, env, ctx) =>
      event(
        'job.cron_failed',
        (application) => application.scheduled,
        input,
        env,
        ctx,
        () => undefined,
      ),
  };
}
