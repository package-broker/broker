import { createOidcExchangeRoute, type OidcExchangeDependencies } from './npm/oidc/exchange.js';
import { createOidcVerifier } from './npm/oidc/verify.js';
import { createPublishService, type PublishDependencies } from './npm/publish-service.js';
export { createPublishService } from './npm/publish-service.js';
import { probeNpmClaim } from '../sources/claim-admission.js';
import type { SourcePackageProbe } from '../ingest/source-package.js';
import { isUpstreamRefusal } from '../ingest/fill-shared.js';
import { createComposerRepositoryProvider } from '../ingest/composer/composer-repository.js';
import { isSelected } from '../ingest/composer/v1-index.js';
import { displayName } from '../catalogue/names.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type {
  CatalogueReader,
  CatalogueWriteGuard,
  CatalogueWriter,
  DistTarget,
  PackageVisibility,
  PackageVisibilityPort,
} from '../db/catalogue.js';
import type { OrgContext, SqlExecutor } from '../db/port.js';
import type { PackageIdReads } from '../db/registry-reads.js';
import type { SourceRecord, SourceRepository } from '../db/source.js';
import type { UpstreamStateRepository } from '../db/upstream-state.js';
import type { NpmAuditAuthorizer } from '../db/vulnerability.js';
import type { Clock } from '../ids.js';
import type { ApplyDeps, ApplyInput } from '../ingest/apply-description.js';
import type { BlobReplacer } from '../ingest/dist-fetch.js';
import type { FetchLeaseHandle, FetchLeases } from '../ingest/coalesce.js';
import {
  describePackagist,
  PackagistBusyError,
  packagistProxyProvider,
} from '../ingest/composer/packagist-proxy.js';
import { createNpmjsProxyProvider } from '../ingest/npm/npmjs-proxy.js';
import { createNpmRegistryProvider } from '../ingest/npm/scoped-registry.js';
import {
  createOnDemandFill,
  type OnDemandDeps,
  type PackageFillPlan,
  type PackageSyncPayload,
} from '../ingest/on-demand.js';
import type { IngestSessionHandle } from '../ingest/session.js';
import { safeValidator } from '../ingest/fill-shared.js';
import {
  createPackageSyncJob,
  PACKAGE_SYNC_JOB_TYPE,
  packageSyncEnqueueInput,
} from '../ingest/package-sync-job.js';
import { contextPackageActorOf } from '../internal/package-actor.js';
import { resolvedPackageOf } from '../internal/package-context.js';
import type { Codecs } from '../platform/codec.js';
import { createScopedCache, type EpochReader } from '../platform/cache.js';
import { PlatformUnavailableError } from '../platform/errors.js';
import type { JobGuard } from '../platform/job-repository.js';
import type { JobDefinition, CoreJobs } from '../platform/jobs.js';
import type { CoreBlobStore } from '../platform/blob.js';
import type { PlatformPorts, Platform, RequestContext, RouteDefinition } from '../plugin.js';
import { sourceCredentialRequired } from '../sources/credential-origins.js';
import { parseSourceConfig } from '../sources/config.js';
import type { CredentialEchoProbe } from '../sources/credentials.js';
import {
  createCredentialUnavailableMark,
  SourceUnavailableError,
  type CredentialUnavailableWrite,
  type SourceUnavailableReason,
} from '../sources/source-unavailable.js';
import type { Observability } from '../platform/observability.js';
import type {
  PolicyFetchOptions,
  PolicyFetch,
  UpstreamCredential,
} from '../sources/policy-fetch.js';
import {
  type DocumentValidators,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '../sources/provider.js';
import { classifyUrl, type OutboundPolicy, type OutboundRefusal } from '../sources/url-policy.js';
import type { AccessRecorder } from './access-recorder.js';
import { composerVersionInput } from './composer/version-object.js';
import { composerRoutes } from './composer/routes.js';
import type { RepresentationClock } from './conditional.js';
import { createDistService, type DistFetchPlan } from './dist-service.js';
import { createRegistryJobs, type RegistryJobs, type RegistryJobsDeps } from './jobs.js';
import { npmVersionInput } from './npm/version-object.js';
import { npmRoutes } from './npm/routes.js';
import { forwardNpmAudit } from './npm/audit.js';
import type { RegistryConfig } from './registry-config.js';
import { createScopedAdmittingAccess } from './scoped-access.js';

export class SourceMissingError extends Error {
  override readonly name = 'SourceMissingError';
  constructor() {
    super('source not found');
  }
}

async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type ScopedAdmission = Parameters<typeof createScopedAdmittingAccess>[1];

export interface SourceCredential {
  readonly credential: UpstreamCredential;
  readonly probe: CredentialEchoProbe;
}

const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

export function createNpmHandleOf(
  users: {
    get(ctx: OrgContext, id: string): Promise<{ readonly displayName: string | null } | null>;
  },
  services: { get(ctx: OrgContext, id: string): Promise<{ readonly name: string | null } | null> },
): (ctx: RequestContext) => Promise<string | null> {
  return async (ctx) => {
    if (ctx.org === null || ctx.principal === null) return null;
    const { kind, id } = ctx.principal;
    let name: string | null;
    if (kind === 'user') {
      const user = await users.get(ctx.org, id);
      if (user === null) return null;
      name = user.displayName;
    } else if (kind === 'service') {
      const service = await services.get(ctx.org, id);
      if (service === null) return null;
      name = service.name;
    } else {
      return null;
    }
    return name !== null &&
      name !== '' &&
      name.length <= 214 &&
      !/[@\s]/u.test(name) &&
      !FORBIDDEN_NAME_CHARACTERS.test(name)
      ? name
      : `${kind}-${id.toLowerCase()}`;
  };
}

export interface RegistryModuleDeps {
  readonly npmOidc?: Omit<OidcExchangeDependencies, 'verify' | 'clock'>;
  readonly npmPublish?: PublishDependencies;
  readonly runtime: Platform;
  readonly ports: Partial<
    Omit<PlatformPorts, 'blob' | 'jobs'> & { blob: CoreBlobStore; jobs: CoreJobs }
  >;
  readonly clock: Clock;
  readonly codecs: Codecs;
  readonly publicUrl: string;
  readonly registry: RegistryConfig;
  readonly outboundPolicy: OutboundPolicy;
  readonly policyFetch: (
    userAgent: string,
    options?: Pick<PolicyFetchOptions, 'observability' | 'sourceId'>,
  ) => PolicyFetch;
  readonly deploymentId: string;
  readonly providers?: readonly SourceProvider[];
  readonly registryJobs?: RegistryJobsDeps;
  readonly npmAudit?: {
    readonly provenance: NpmAuditAuthorizer;
    readonly sources: Pick<SourceRepository, 'hasAttachedProxy'>;
  };
  readonly defer?: (thunk: () => Promise<void>) => void;
  readonly handleOf?: (ctx: RequestContext) => Promise<string | null>;
  readonly catalogue: {
    readonly reader: CatalogueReader;
    readonly scopedAdmission: ScopedAdmission;
    readonly epoch: EpochReader;
    readonly representationClock: RepresentationClock;
    readonly upstreamState: Pick<UpstreamStateRepository, 'get'>;
    readonly sources: Pick<SourceRepository, 'get'>;
    readonly covers: (ctx: OrgContext, sourceId: string, key: string) => Promise<boolean>;
    readonly versionById: (
      ctx: OrgContext,
      ref: { readonly packageId: string; readonly versionId: string },
    ) => Promise<{ readonly packageName: string; readonly version: string } | null>;
  };
  readonly ingest: {
    readonly sessions: OnDemandDeps['sessions'];
    readonly apply: ApplyDeps;
    readonly writeGuard: (ctx: OrgContext, session: IngestSessionHandle) => CatalogueWriteGuard;
    readonly credential: (
      ctx: OrgContext,
      source: SourceRecord,
    ) => Promise<SourceCredential | null>;
    readonly credentialUnavailable?: CredentialUnavailableWrite;
  };
  readonly sync?: {
    readonly packageId: PackageIdReads['packageId'];
    readonly upstreamState: Pick<
      UpstreamStateRepository,
      'touchStatements' | 'notFoundStatements' | 'resetNotFoundStatements'
    >;
    readonly executor: Pick<SqlExecutor, 'batch'>;
    readonly writeGuard: (
      ctx: OrgContext,
      session: IngestSessionHandle,
      job: JobGuard,
    ) => CatalogueWriteGuard;
  };
  readonly dist: {
    readonly leases: FetchLeases;
    readonly leaseKey: (parts: readonly string[]) => Promise<string>;
    readonly writeGuard: (ctx: OrgContext, handle: FetchLeaseHandle) => CatalogueWriteGuard;
    readonly writer: Pick<CatalogueWriter, 'attachDist' | 'quarantine'>;
    readonly blobReplacer: BlobReplacer;
    readonly recorder: Pick<AccessRecorder, 'record'>;
  };
}

export interface RegistryModule extends Partial<RegistryJobs> {
  readonly probePackage: SourcePackageProbe;
  readonly ecosystemRoutes: readonly RouteDefinition[];
  readonly visibilityPort: PackageVisibilityPort;
  readonly packageSyncJob?: JobDefinition;
}

const NO_PROBE: CredentialEchoProbe = { secrets: [], queryParams: [] };
const PROXY_TYPES: ReadonlySet<string> = new Set(['packagist_proxy', 'npmjs_proxy']);
const POLICY_REFUSALS: ReadonlySet<OutboundRefusal> = new Set<OutboundRefusal>([
  'self_origin',
  'blocked_address',
  'blocked_host',
  'port',
  'scheme',
]);

export function createRegistryModule(deps: RegistryModuleDeps): RegistryModule {
  const { jobs } = deps.ports;
  if (
    deps.ports.blob === undefined ||
    deps.ports.cache === undefined ||
    deps.ports.observability === undefined
  ) {
    throw new PlatformUnavailableError();
  }
  const { blob, cache, observability } = deps.ports;
  const { catalogue, ingest, registry, sync, npmAudit } = deps;

  const packageAccess = createPackageAccess(catalogue.reader);
  const visibilityPort = createScopedAdmittingAccess(packageAccess, catalogue.scopedAdmission);
  const scopedCache = createScopedCache(cache, catalogue.epoch, {
    deploymentId: deps.deploymentId,
    now: () => deps.clock.now(),
  });

  const npmProviders = new Map<string, { proxy: SourceProvider; scoped: SourceProvider }>();
  function npmProvidersFor(orgId: string) {
    let entry = npmProviders.get(orgId);
    if (entry === undefined) {
      const scope: OrgContext = Object.freeze({ orgId }) as OrgContext;
      const staging = { store: blob, orgOf: (): OrgContext => scope };
      entry = {
        proxy: createNpmjsProxyProvider(staging),
        scoped: createNpmRegistryProvider(staging),
      };
      npmProviders.set(orgId, entry);
    }
    return entry;
  }

  const composerRepositoryProvider = createComposerRepositoryProvider(deps.outboundPolicy);

  function providerFor(ctx: OrgContext, source: ProviderSource): SourceProvider | null {
    switch (source.type) {
      case 'composer_repository':
        return (
          deps.providers?.find((provider) => provider.sourceTypes.includes(source.type)) ??
          composerRepositoryProvider
        );
      case 'packagist_proxy':
        return packagistProxyProvider;
      case 'npmjs_proxy':
        return npmProvidersFor(ctx.orgId).proxy;
      case 'npm_registry':
        return npmProvidersFor(ctx.orgId).scoped;
      default:
        return deps.providers?.find((provider) => provider.id === source.config.provider) ?? null;
    }
  }

  function userAgentOf(record: SourceRecord): string {
    if (record.userAgent !== null) return record.userAgent;
    return record.ecosystem === 'composer'
      ? registry.userAgent.composerStyle
      : registry.userAgent.default;
  }

  const credentialMark = createCredentialUnavailableMark(ingest.credentialUnavailable);

  function policyDenied(url: string): boolean {
    const verdict = classifyUrl(url, deps.outboundPolicy);
    return !verdict.ok && POLICY_REFUSALS.has(verdict.reason);
  }

  async function unavailable(
    ctx: OrgContext,
    record: SourceRecord,
    reason: SourceUnavailableReason,
    requestObservability: Observability | undefined,
  ): Promise<SourceUnavailableReason> {
    (requestObservability ?? observability).log({
      level: 'warn',
      event: 'source.unavailable',
      reason_code: reason,
      source_id: record.id,
    });
    if (reason === 'credential_unavailable') await credentialMark.mark(ctx, record);
    return reason;
  }

  async function bind(ctx: OrgContext, record: SourceRecord, requestObservability?: Observability) {
    if (record.status === 'paused') return null;
    const parsed = parseSourceConfig(record.type, record.ecosystem, record.url, record.configJson, {
      runtime: deps.runtime,
      policy: deps.outboundPolicy,
      hasCredential: record.credentialId !== null,
    });
    if (!parsed.ok)
      return unavailable(
        ctx,
        record,
        record.url !== null && policyDenied(record.url) ? 'policy_denied' : 'config_invalid',
        requestObservability,
      );
    const base = { id: record.id, ecosystem: record.ecosystem, url: record.url };
    const draft = (
      record.type === 'vcs'
        ? { ...base, type: 'vcs', config: parsed.config }
        : { ...base, type: record.type, config: parsed.config, providerId: '' }
    ) as ProviderSource;
    const provider = providerFor(ctx, draft);
    if (provider === null)
      return unavailable(ctx, record, 'provider_unavailable', requestObservability);
    const source =
      draft.type === 'vcs' ? draft : ({ ...draft, providerId: provider.id } as ProviderSource);
    const needsCredential = record.credentialId !== null && sourceCredentialRequired(source);
    const credential = needsCredential ? await ingest.credential(ctx, record) : null;
    if (needsCredential && credential === null)
      return unavailable(ctx, record, 'credential_unavailable', requestObservability);
    const fetch = deps.policyFetch(userAgentOf(record), {
      sourceId: record.id,
      observability: requestObservability ?? observability,
    });
    const boundedFetch: PolicyFetch = (request) =>
      fetch({
        ...request,
        maxBytes:
          request.purpose === 'metadata'
            ? Math.min(request.maxBytes, registry.caps.metadataBytes)
            : request.maxBytes,
      });
    return { provider, source, credential, fetch: boundedFetch };
  }

  function providerContext(
    ctx: OrgContext,
    bound: Exclude<Awaited<ReturnType<typeof bind>>, SourceUnavailableReason | null>,
    signal: AbortSignal,
  ): ProviderContext {
    return {
      org: ctx,
      fetch: bound.fetch,
      credential: bound.credential?.credential ?? null,
      codecs: deps.codecs,
      signal,
      clock: deps.clock,
      observability,
    };
  }

  async function planFill(
    ctx: OrgContext,
    sourceId: string,
    key: string,
    requestObservability?: Observability,
  ): Promise<PackageFillPlan | null> {
    const plan = await planPackage(ctx, sourceId, key, requestObservability);
    return plan === 'unsupported_package' ? null : plan;
  }

  async function planPackage(
    ctx: OrgContext,
    sourceId: string,
    key: string,
    requestObservability?: Observability,
  ): Promise<PackageFillPlan | 'unsupported_package' | null> {
    const record = await catalogue.sources.get(ctx, sourceId);
    if (record === null) return null;
    const bound = await bind(ctx, record, requestObservability);
    if (typeof bound === 'string') throw new SourceUnavailableError(bound);
    if (bound === null) return null;
    if (
      bound.source.type === 'composer_repository' &&
      !isSelected(key, bound.source.config.selection)
    )
      return null;
    if (
      bound.source.type === 'npm_registry' &&
      !bound.source.config.scopes.some((scope) => key.startsWith(`${scope}/`))
    )
      return 'unsupported_package';
    const proxy = PROXY_TYPES.has(record.type);
    const covered = proxy ? false : await catalogue.covers(ctx, record.id, key);
    if (!proxy && !covered)
      return bound.source.type === 'npm_registry' ? 'unsupported_package' : null;
    const publishedValidators: DocumentValidators = {};
    if (sync !== undefined) {
      const packageId = await sync.packageId(ctx, record.id, key);
      if (packageId !== null) {
        const forms =
          record.ecosystem === 'composer'
            ? (['composer-p2', 'composer-p2-dev'] as const)
            : (['npm-packument'] as const);
        for (const form of forms) {
          const state = await catalogue.upstreamState.get(ctx, packageId, form);
          if (state === null) continue;
          const etag = safeValidator(state.etag ?? undefined);
          const lastModified = safeValidator(state.lastModified ?? undefined);
          if (etag === null && lastModified === null) continue;
          publishedValidators[form === 'npm-packument' ? 'npm-full' : form] = {
            ...(etag === null ? {} : { etag }),
            ...(lastModified === null ? {} : { lastModified }),
          };
        }
      }
    }
    const probe = bound.credential?.probe ?? NO_PROBE;
    const toVersion: ApplyInput['toVersion'] = (candidate) => {
      let object: unknown;
      try {
        object = JSON.parse(candidate.raw);
      } catch {
        return null;
      }
      const importedAt = deps.clock.now().toISOString();
      const result =
        record.ecosystem === 'composer'
          ? composerVersionInput(key, object, { probe, importedAt })
          : npmVersionInput(
              key,
              object,
              candidate.upstreamTime === undefined
                ? {}
                : { [candidate.version]: candidate.upstreamTime },
              { probe, importedAt },
            );
      return result.ok ? result.input : null;
    };
    return {
      source: {
        id: record.id,
        key,
        type: record.type,
        ecosystem: record.ecosystem,
        covered,
      },
      toVersion,
      packageDescription: null,
      validatorTtlSeconds: registry.timers.metadataTtlSeconds,
      publishedValidators,
      async describe(options, signal): Promise<Awaited<ReturnType<SourceProvider['describe']>>> {
        const context = providerContext(ctx, bound, signal);
        if (record.type === 'packagist_proxy') {
          const result = await describePackagist(bound.fetch, key, {
            path: 'request',
            clock: deps.clock,
            signal,
            ...(options.validators === undefined ? {} : { validators: options.validators }),
          });
          if (result.kind === 'busy') throw new PackagistBusyError(result.retryAfterSeconds);
          return result;
        }
        return bound.provider.describe(context, bound.source, key, options);
      },
    } satisfies PackageFillPlan;
  }

  async function planFetch(
    ctx: OrgContext,
    target: DistTarget,
    requestObservability?: Observability,
  ): Promise<DistFetchPlan | null> {
    const row = await catalogue.versionById(ctx, {
      packageId: target.packageId,
      versionId: target.versionId,
    });
    if (row === null) return null;
    const record = await catalogue.sources.get(ctx, target.sourceId);
    if (record === null) return null;
    const bound = await bind(ctx, record, requestObservability);
    if (typeof bound === 'string') throw new SourceUnavailableError(bound);
    if (bound === null) return null;
    return {
      packageName: row.packageName,
      version: row.version,
      deps: {
        provider: bound.provider,
        providerContext: providerContext(ctx, bound, new AbortController().signal),
        source: bound.source,
        store: blob,
        writer: deps.dist.writer,
        blobReplacer: deps.dist.blobReplacer,
        maxBytes: registry.caps.archiveBytes,
      },
    };
  }

  async function enqueueSync(ctx: OrgContext, payload: PackageSyncPayload): Promise<void> {
    if (jobs === undefined) throw new PlatformUnavailableError();
    const window = Math.floor(
      deps.clock.now().getTime() / (deps.registry.timers.metadataTtlSeconds * 1000),
    );
    const freshKey =
      payload.sessionId === undefined
        ? await sha256Hex(['stale', payload.sourceId, payload.key, window])
        : undefined;
    await jobs.enqueue(
      ctx,
      PACKAGE_SYNC_JOB_TYPE,
      payload,
      await packageSyncEnqueueInput(payload, freshKey),
    );
  }

  const sourceMetadata: OnDemandDeps['sourceMetadata'] = async (ctx, sourceId) => {
    const record = await catalogue.sources.get(ctx, sourceId);
    if (record === null) throw new SourceMissingError();
    return { type: record.type };
  };

  const packageSyncJob =
    sync === undefined || jobs === undefined
      ? undefined
      : createPackageSyncJob({
          sessions: ingest.sessions,
          apply: ingest.apply,
          jobs,
          upstreamState: sync.upstreamState,
          executor: sync.executor,
          sourceMetadata,
          planFill: async (ctx, sourceId, key) => {
            try {
              return await planFill(ctx, sourceId, key);
            } catch (error) {
              if (error instanceof SourceUnavailableError) return null;
              throw error;
            }
          },
          findPackageId: sync.packageId,
          writeGuard: sync.writeGuard,
          clock: deps.clock,
        });

  const onDemand = createOnDemandFill({
    sessions: ingest.sessions,
    clock: deps.clock,
    cache: scopedCache,
    visibility: visibilityPort,
    upstreamState: catalogue.upstreamState,
    apply: ingest.apply,
    sourceMetadata,
    writeGuard: ingest.writeGuard,
    planFill,
    enqueueSync,
  });

  const dist = createDistService({
    access: packageAccess,
    store: blob,
    leases: deps.dist.leases,
    clock: deps.clock,
    leaseKey: deps.dist.leaseKey,
    writeGuard: deps.dist.writeGuard,
    planFetch,
    recorder: deps.dist.recorder,
  });

  async function reresolve(ctx: RequestContext): Promise<PackageVisibility> {
    const actor = contextPackageActorOf(ctx);
    const resolved = resolvedPackageOf(ctx);
    if (actor === null || resolved === null) return { kind: 'absent' };
    const key = resolved.kind === 'visible' ? resolved.pkg.key : resolved.key;
    return visibilityPort.resolve(actor, 'npm', displayName(key));
  }

  const ecosystemRoutes: readonly RouteDefinition[] = Object.freeze([
    ...(deps.npmOidc === undefined
      ? []
      : [
          createOidcExchangeRoute({
            ...deps.npmOidc,
            clock: deps.clock,
            verify: createOidcVerifier({
              publicUrl: deps.publicUrl,
              policyFetch: deps.policyFetch(registry.userAgent.default),
            }),
          }),
        ]),
    ...composerRoutes({
      access: packageAccess,
      fill: onDemand,
      dist,
      clock: catalogue.representationClock,
      publicUrl: deps.publicUrl,
      cache: scopedCache,
    }),
    ...npmRoutes({
      access: packageAccess,
      ...(deps.npmPublish === undefined
        ? {}
        : {
            publish: createPublishService({
              ...deps.npmPublish,
              blob: blob as import('../platform/blob.js').CoreBlobStore,
              codecs: deps.codecs,
              registry,
              clock: deps.clock,
              publicUrl: deps.publicUrl,
            }),
          }),
      dist,
      onDemand,
      reresolve,
      handleOf: deps.handleOf ?? (async () => null),
      ...(deps.defer === undefined ? {} : { defer: deps.defer }),
      publicUrl: deps.publicUrl,
      codecs: deps.codecs,
      audit: {
        enabled: registry.npmAudit.enabled,
        ...(npmAudit === undefined
          ? {}
          : {
              forward: (entries, ctx) => {
                if (ctx.org === null || ctx.projectId === null) {
                  throw new PlatformUnavailableError();
                }
                return forwardNpmAudit(
                  entries,
                  ctx.request,
                  ctx.org,
                  ctx.projectId,
                  ctx.requestId,
                  {
                    classifyWinners: (org, query) => catalogue.reader.classifyWinners(org, query),
                    hasAttachedProxy: (org, project, ecosystem) =>
                      npmAudit.sources.hasAttachedProxy(org, project, ecosystem),
                    authorizeNpmAudit: (org, refs) =>
                      npmAudit.provenance.authorizeNpmAudit(org, refs),
                    policyFetch: deps.policyFetch(registry.userAgent.default, {
                      observability: ctx.ports.platform?.observability ?? observability,
                    }),
                    observability: ctx.ports.platform?.observability ?? observability,
                  },
                );
              },
            }),
      },
    }),
  ]);

  return Object.freeze({
    ecosystemRoutes,
    async probePackage(
      ctx: OrgContext,
      sourceId: string,
      key: string,
      signal: AbortSignal,
      mode?: 'claim',
    ) {
      try {
        if (mode === 'claim') {
          const source = await catalogue.sources.get(ctx, sourceId);
          if (source === null || source.type !== 'npmjs_proxy' || source.ecosystem !== 'npm')
            return 'unavailable';
          const answer = await probeNpmClaim(
            deps.policyFetch(userAgentOf(source), { sourceId }),
            key,
            signal,
          );
          return answer === null ? 'not_found' : answer === 'name_public' ? 'found' : 'unavailable';
        }
        const plan = await planPackage(ctx, sourceId, key);
        if (plan === 'unsupported_package') return plan;
        if (plan === null) return 'unavailable';
        const result = await plan.describe({}, signal);
        if (result.kind === 'not_found') return 'not_found';
        return result.kind === 'found' ? 'found' : 'bad_gateway';
      } catch (error) {
        if (isUpstreamRefusal(error)) return 'upstream_refused';
        return 'unavailable';
      }
    },
    visibilityPort,
    ...(packageSyncJob === undefined ? {} : { packageSyncJob }),
    ...(jobs === undefined || deps.registryJobs === undefined
      ? {}
      : createRegistryJobs(deps.registryJobs, jobs)),
  });
}
