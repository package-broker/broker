import type { ProjectActor } from '../authz/project-actor.js';
import type { NameEcosystem } from '../catalogue/names.js';
import type { PackageAccess } from '../catalogue/package-access.js';
import type { CatalogueWriteGuard, DistBlob, DistTarget, DistType } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import {
  createCoalescer,
  type CoalesceOptions,
  type DoneState,
  type FetchLeaseHandle,
  type FetchLeases,
} from '../ingest/coalesce.js';
import {
  fetchAndVerifyDist,
  type DistFetchDeps,
  type DistFetchOutcome,
} from '../ingest/dist-fetch.js';
import type { Clock } from '../ids.js';
import type { BlobRead, CoreBlobStore as BlobStore, Sha256 } from '../platform/blob.js';
import type { Observability } from '../platform/observability.js';
import { ProviderBusyError } from '../sources/provider.js';
import {
  SOURCE_UNAVAILABLE_RETRY_SECONDS,
  SourceUnavailableError,
} from '../sources/source-unavailable.js';
import type { AccessRecorder } from './access-recorder.js';

export const DIST_BUSY_RETRY_AFTER_SECONDS = 5;
export const DIST_CACHE_CONTROL = 'private, max-age=31536000, immutable';

const SEGMENT = /^[0-9A-Za-z]{1,64}$/;
const REVISION = /^[1-9][0-9]{0,15}$/;
const EXTENSIONS: Readonly<Record<DistType, string>> = { zip: 'zip', tar: 'tar', tgz: 'tgz' };

export interface DistServeRequest {
  readonly ecosystem: NameEcosystem;
  readonly key: string;
  readonly versionId: string;
  readonly revision: string | number;
}

export type DistServeResult =
  | {
      readonly kind: 'file';
      readonly headers: Headers;
      readonly size: number;
      readonly body: ReadableStream<Uint8Array>;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'busy'; readonly retryAfterSeconds: number };

export interface DistFetchPlan {
  readonly deps: DistFetchDeps;
  readonly packageName: string;
  readonly version: string;
}

export interface DistServiceDeps {
  readonly access: Pick<PackageAccess, 'dist'>;
  readonly store: Pick<BlobStore, 'get' | 'head'>;
  readonly leases: FetchLeases;
  readonly clock: Clock;
  readonly leaseKey: (parts: readonly string[]) => Promise<string>;
  readonly writeGuard: (ctx: OrgContext, handle: FetchLeaseHandle) => CatalogueWriteGuard;
  readonly planFetch: (
    ctx: OrgContext,
    target: DistTarget,
    observability?: Observability,
  ) => Promise<DistFetchPlan | null>;
  readonly recorder: Pick<AccessRecorder, 'record'>;
  readonly coalesce?: Pick<CoalesceOptions, 'waitBudgetMs' | 'pollMs'>;
}

export interface DistServeOptions {
  readonly observability?: Observability;
  /** Aborting cancels the coalesced wait and, for the lease holder, the upstream fetch. */
  readonly signal?: AbortSignal;
}

export interface DistService {
  serve(
    actor: ProjectActor,
    request: DistServeRequest,
    options?: DistServeOptions,
  ): Promise<DistServeResult>;
}

const NOT_FOUND: DistServeResult = Object.freeze({ kind: 'not_found' });
const REFUSED: DistServeResult = Object.freeze({ kind: 'refused' });
const GONE: DistServeResult = Object.freeze({ kind: 'gone' });
const BUSY: DistServeResult = Object.freeze({
  kind: 'busy',
  retryAfterSeconds: DIST_BUSY_RETRY_AFTER_SECONDS,
});

function parseRevision(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value !== 'string' || !REVISION.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type StoredRead = BlobRead | 'absent' | 'failed';

async function readStored(
  store: Pick<BlobStore, 'get'>,
  ctx: OrgContext,
  sha256: Sha256,
): Promise<StoredRead> {
  try {
    return (await store.get(ctx, sha256)) ?? 'absent';
  } catch {
    return 'failed';
  }
}

async function readable(
  store: Pick<BlobStore, 'get'>,
  ctx: OrgContext,
  sha256: Sha256,
): Promise<BlobRead | null> {
  const read = await readStored(store, ctx, sha256);
  return typeof read === 'string' ? null : read;
}

function hasUpstream(target: DistTarget): boolean {
  return target.fetch.upstreamDistUrl !== null || target.fetch.sourceRef !== null;
}

/** A lost blob that cannot be rebuilt from its upstream location. */
function unrefetchable(target: DistTarget): target is DistTarget & { blob: DistBlob } {
  return target.blob !== null && !target.blob.refetchable && hasUpstream(target);
}

function logGone(observability: Observability | undefined, target: DistTarget): void {
  observability?.log({
    level: 'error',
    event: 'dist.unrefetchable_blob_missing',
    version_id: target.versionId,
    revision: target.revision,
    sha256_prefix: target.blob?.sha256.slice(0, 12) ?? null,
  });
}

export function createDistService(deps: DistServiceDeps): DistService {
  const handles = new Map<string, FetchLeaseHandle>();
  const scoped = (ctx: OrgContext, key: string) => `${ctx.orgId}\u0000${key}`;
  const coalescer = createCoalescer(
    {
      async acquire(ctx, key, owner, leaseSeconds) {
        const handle = await deps.leases.acquire(ctx, key, owner, leaseSeconds);
        if (handle !== 'held') handles.set(scoped(ctx, key), handle);
        return handle;
      },
      renew: (ctx, handle, leaseSeconds) => deps.leases.renew(ctx, handle, leaseSeconds),
      async release(ctx, handle) {
        const key = scoped(ctx, handle.key);
        const remembered = handles.get(key);
        if (remembered?.owner === handle.owner && remembered.fence === handle.fence) {
          handles.delete(key);
        }
        await deps.leases.release(ctx, handle);
      },
    },
    deps.clock,
  );

  async function resolve(
    actor: ProjectActor,
    request: DistServeRequest,
    versionId: string,
    revision: number,
  ): Promise<DistTarget | null> {
    return deps.access.dist(actor, request.ecosystem, request.key, {
      by: 'id',
      versionId,
      revision,
    });
  }

  function file(ctx: OrgContext, target: DistTarget, read: BlobRead): DistServeResult {
    const blob = target.blob;
    if (blob === null) return NOT_FOUND;
    const extension = target.fetch.distType === null ? 'bin' : EXTENSIONS[target.fetch.distType];
    const headers = new Headers({
      'Content-Type': blob.mediaType,
      'Content-Length': String(read.info.size),
      'Content-Disposition': `attachment; filename="${target.versionId}.${String(target.revision)}.${extension}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': DIST_CACHE_CONTROL,
    });
    deps.recorder.record(ctx, blob.id);
    return { kind: 'file', headers, size: read.info.size, body: read.body };
  }

  async function serveStored(ctx: OrgContext, target: DistTarget | null): Promise<DistServeResult> {
    if (target?.blob == null) return NOT_FOUND;
    const read = await readable(deps.store, ctx, target.blob.sha256);
    return read === null ? NOT_FOUND : file(ctx, target, read);
  }

  async function fill(
    ctx: OrgContext,
    target: DistTarget,
    key: string,
    signal: AbortSignal,
    isDone: () => Promise<DoneState>,
    onRefused: () => void,
    onGone: () => void,
    packageKey: string,
    observability?: Observability,
  ): Promise<DoneState> {
    const handle = handles.get(scoped(ctx, key));
    if (handle === undefined) return 'pending';
    if (unrefetchable(target)) {
      try {
        if ((await deps.store.head(ctx, target.blob.sha256)) !== null) return 'filled';
      } catch {
        return 'pending';
      }
      logGone(observability, target);
      onGone();
      return 'negative';
    }
    const plan = await deps.planFetch(ctx, target, observability);
    if (plan === null) return 'negative';
    let outcome: DistFetchOutcome;
    try {
      outcome = await fetchAndVerifyDist(
        {
          ...plan.deps,
          providerContext: { ...plan.deps.providerContext, signal },
        },
        ctx,
        deps.writeGuard(ctx, handle),
        {
          versionId: target.versionId,
          revision: target.revision,
          packageName: plan.packageName,
          version: plan.version,
          fetch: target.fetch,
          previousBlob:
            target.blob === null ? null : { id: target.blob.id, sha256: target.blob.sha256 },
          packageKey,
        },
      );
    } catch (error) {
      if (error instanceof ProviderBusyError) return 'pending';
      throw error;
    }
    if (outcome === 'quarantined') {
      onRefused();
      return 'negative';
    }
    return outcome === 'stale' ? isDone() : 'filled';
  }

  return {
    async serve(actor, request, options) {
      const signal = options?.signal;
      signal?.throwIfAborted();
      const revision = parseRevision(request.revision);
      if (revision === null || typeof request.versionId !== 'string') return NOT_FOUND;
      if (!SEGMENT.test(request.versionId)) return NOT_FOUND;
      const { versionId } = request;
      const ctx: OrgContext = { orgId: actor.orgId };

      const target = await resolve(actor, request, versionId, revision);
      if (target === null) return NOT_FOUND;

      if (target.blob !== null) {
        const read = await readStored(deps.store, ctx, target.blob.sha256);
        if (typeof read !== 'string') return file(ctx, target, read);
        if (unrefetchable(target)) {
          if (read === 'failed') return BUSY;
          logGone(options?.observability, target);
          return GONE;
        }
      }
      if (!target.current || !hasUpstream(target)) return NOT_FOUND;

      const key = await deps.leaseKey([ctx.orgId, 'dist', versionId, String(revision)]);
      let refused = false;
      let gone = false;
      let latest: DistTarget | null = null;
      const isDone = async (): Promise<DoneState> => {
        latest = await resolve(actor, request, versionId, revision);
        if (latest === null) return 'negative';
        if (latest.blob !== null) {
          try {
            if ((await deps.store.head(ctx, latest.blob.sha256)) !== null) return 'filled';
          } catch {
            // Missing or unreadable bytes need a refill of the current revision.
          }
        }
        return latest.current ? 'pending' : 'negative';
      };
      let outcome;
      try {
        outcome = await coalescer.run(
          ctx,
          key,
          (signal) =>
            latest === null
              ? Promise.resolve('negative')
              : fill(
                  ctx,
                  latest,
                  key,
                  signal,
                  isDone,
                  () => {
                    refused = true;
                  },
                  () => {
                    gone = true;
                  },
                  request.key,
                  options?.observability,
                ),
          { ...deps.coalesce, isDone, ...(signal === undefined ? {} : { signal }) },
        );
      } catch (error) {
        if (error instanceof SourceUnavailableError)
          return { kind: 'busy', retryAfterSeconds: SOURCE_UNAVAILABLE_RETRY_SECONDS };
        throw error;
      }

      if (outcome === 'busy') return BUSY;
      if (outcome === 'negative') return refused ? REFUSED : gone ? GONE : NOT_FOUND;
      return serveStored(ctx, await resolve(actor, request, versionId, revision));
    },
  };
}
