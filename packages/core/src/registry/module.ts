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
import type { OrgContext } from '../db/port.js';
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
import { PACKAGE_SYNC_JOB_TYPE, packageSyncEnqueueInput } from '../ingest/package-sync-job.js';
import { contextPackageActorOf } from '../internal/package-actor.js';
import { resolvedPackageOf } from '../internal/package-context.js';
import type { Codecs } from '../platform/codec.js';
import { createScopedCache, type EpochReader } from '../platform/cache.js';
import { PlatformUnavailableError } from '../platform/errors.js';
import type { PlatformPorts, Platform, RequestContext, RouteDefinition } from '../plugin.js';
import { parseSourceConfig } from '../sources/config.js';
import type { CredentialEchoProbe } from '../sources/credentials.js';
import type { PolicyFetch, UpstreamCredential } from '../sources/policy-fetch.js';
import {
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
  readonly policyFetch: (userAgent: string) => PolicyFetch;
  readonly deploymentId: string;
  readonly providers?: readonly SourceProvider[];
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
  readonly dist: {
    readonly leases: FetchLeases;
    readonly leaseKey: (parts: readonly string[]) => Promise<string>;
    readonly writeGuard: (ctx: OrgContext, handle: FetchLeaseHandle) => CatalogueWriteGuard;
    readonly writer: Pick<CatalogueWriter, 'attachDist' | 'quarantine'>;
    readonly blobReplacer: BlobReplacer;
    readonly recorder: Pick<AccessRecorder, 'record'>;
  };
}

export interface RegistryModule {
  readonly ecosystemRoutes: readonly RouteDefinition[];
  readonly visibilityPort: PackageVisibilityPort;
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
  const { catalogue, ingest, registry } = deps;

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

  function providerFor(ctx: OrgContext, source: ProviderSource): SourceProvider | null {
    switch (source.type) {
      case 'packagist_proxy':
        return packagistProxyProvider;
      case 'npmjs_proxy':
        return npmProvidersFor(ctx.orgId).proxy;
      case 'npm_registry':
        return npmProvidersFor(ctx.orgId).scoped;
      default:
        return (
          deps.providers?.find((provider) =>
            source.type === 'vcs'
              ? provider.id === source.config.provider
              : provider.sourceTypes.includes(source.type),
          ) ?? null
        );
    }
  }

  function userAgentOf(record: SourceRecord): string {
    if (record.userAgent !== null) return record.userAgent;
    return record.ecosystem === 'composer'
      ? registry.userAgent.composerStyle
      : registry.userAgent.default;
  }

  async function bind(ctx: OrgContext, record: SourceRecord) {
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
    return { provider, source, credential, fetch: deps.policyFetch(userAgentOf(record)) };
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
  ): Promise<PackageFillPlan | null> {
    const record = await catalogue.sources.get(ctx, sourceId);
    if (record === null) return null;
    const bound = await bind(ctx, record);
    if (bound === null) return null;
    const proxy = PROXY_TYPES.has(record.type);
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
        covered: proxy ? false : await catalogue.covers(ctx, record.id, key),
      },
      toVersion,
      packageDescription: null,
      validatorTtlSeconds: registry.timers.metadataTtlSeconds,
      publishedValidators: {},
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

  async function planFetch(ctx: OrgContext, target: DistTarget): Promise<DistFetchPlan | null> {
    const row = await catalogue.versionById(ctx, {
      packageId: target.packageId,
      versionId: target.versionId,
    });
    if (row === null) return null;
    const record = await catalogue.sources.get(ctx, target.sourceId);
    if (record === null) return null;
    const bound = await bind(ctx, record);
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

  const onDemand = createOnDemandFill({
    sessions: ingest.sessions,
    clock: deps.clock,
    cache: scopedCache,
    visibility: visibilityPort,
    upstreamState: catalogue.upstreamState,
    apply: ingest.apply,
    async sourceMetadata(ctx, sourceId) {
      const record = await catalogue.sources.get(ctx, sourceId);
      if (record === null) throw new SourceMissingError();
      return { type: record.type };
    },
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

  return Object.freeze({ ecosystemRoutes, visibilityPort });
}
