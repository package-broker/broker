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
import type { JobDefinition } from '../platform/jobs.js';
import type { PlatformPorts, Platform, RequestContext, RouteDefinition } from '../plugin.js';
import { parseSourceConfig } from '../sources/config.js';
import type { CredentialEchoProbe } from '../sources/credentials.js';
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
import type { OutboundPolicy } from '../sources/url-policy.js';
import type { AccessRecorder } from './access-recorder.js';
import { composerVersionInput } from './composer/version-object.js';
import { composerRoutes } from './composer/routes.js';
import type { RepresentationClock } from './conditional.js';
import { createDistService, type DistFetchPlan } from './dist-service.js';
import { createRegistryJobs, type RegistryJobs, type RegistryJobsDeps } from './jobs.js';
import { npmVersionInput } from './npm/version-object.js';
import { npmRoutes } from './npm/routes.js';
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

export interface RegistryModuleDeps {
  readonly runtime: Platform;
  readonly ports: Partial<PlatformPorts>;
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
  readonly defer?: (thunk: () => Promise<void>) => void;
  readonly handleOf?: (ctx: RequestContext) => string | null;
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
  readonly ecosystemRoutes: readonly RouteDefinition[];
  readonly visibilityPort: PackageVisibilityPort;
  readonly packageSyncJob?: JobDefinition;
}

const NO_PROBE: CredentialEchoProbe = { secrets: [], queryParams: [] };
const PROXY_TYPES: ReadonlySet<string> = new Set(['packagist_proxy', 'npmjs_proxy']);

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
  const { catalogue, ingest, registry, sync } = deps;

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

  async function bind(ctx: OrgContext, record: SourceRecord, requestObservability?: Observability) {
    if (record.status === 'paused') return null;
    const parsed = parseSourceConfig(record.type, record.ecosystem, record.url, record.configJson, {
      runtime: deps.runtime,
      policy: deps.outboundPolicy,
      hasCredential: record.credentialId !== null,
    });
    if (!parsed.ok) return null;
    const base = { id: record.id, ecosystem: record.ecosystem, url: record.url };
    const draft = (
      record.type === 'vcs'
        ? { ...base, type: 'vcs', config: parsed.config }
        : { ...base, type: record.type, config: parsed.config, providerId: '' }
    ) as ProviderSource;
    const provider = providerFor(ctx, draft);
    if (provider === null) return null;
    const source =
      draft.type === 'vcs' ? draft : ({ ...draft, providerId: provider.id } as ProviderSource);
    const credential = record.credentialId === null ? null : await ingest.credential(ctx, record);
    if (record.credentialId !== null && credential === null) return null;
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
    bound: NonNullable<Awaited<ReturnType<typeof bind>>>,
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
    const record = await catalogue.sources.get(ctx, sourceId);
    if (record === null) return null;
    const bound = await bind(ctx, record, requestObservability);
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
      return null;
    const proxy = PROXY_TYPES.has(record.type);
    const covered = proxy ? false : await catalogue.covers(ctx, record.id, key);
    if (!proxy && !covered) return null;
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
          planFill,
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
      dist,
      onDemand,
      reresolve,
      handleOf: deps.handleOf ?? (() => null),
      ...(deps.defer === undefined ? {} : { defer: deps.defer }),
      publicUrl: deps.publicUrl,
      codecs: deps.codecs,
    }),
  ]);

  return Object.freeze({
    ecosystemRoutes,
    visibilityPort,
    ...(packageSyncJob === undefined ? {} : { packageSyncJob }),
    ...(jobs === undefined || deps.registryJobs === undefined
      ? {}
      : createRegistryJobs(deps.registryJobs, jobs)),
  });
}
