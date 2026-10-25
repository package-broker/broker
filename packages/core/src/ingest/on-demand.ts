import type { Observability } from '../platform/observability.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { catalogueNegativeKey } from '../catalogue/cache-keys.js';
import type { NameEcosystem } from '../catalogue/names.js';
import type {
  CatalogueWriteGuard,
  PackageVisibility,
  PackageVisibilityPort,
} from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import type { UpstreamForm, UpstreamStateRepository } from '../db/upstream-state.js';
import type { Clock } from '../ids.js';
import { defaultEntry, type ScopedCache } from '../platform/cache.js';
import type { SourceType } from '../sources/config.js';
import type { DescribeOptions, DescribeResult, DocumentValidators } from '../sources/provider.js';
import {
  SOURCE_UNAVAILABLE_RETRY_SECONDS,
  SourceUnavailableError,
} from '../sources/source-unavailable.js';
import { applyChunk, type ApplyDeps, type ApplyInput } from './apply-description.js';
import { createCoalescer, type CoalesceFill, type DoneState } from './coalesce.js';
import { PackagistBusyError } from './composer/packagist-proxy.js';
import {
  describeOptions,
  isSnapshotGone,
  isUpstreamFailure,
  isUpstreamRefusal,
  pendingValidators,
  upstreamForm,
} from './fill-shared.js';
import { parsePendingValidators } from './validators.js';
import type {
  IngestScopeRef,
  IngestSessionHandle,
  IngestSessionRelease,
  IngestSessions,
} from './session.js';

export interface PackageFillPlan extends Pick<
  ApplyInput,
  'source' | 'toVersion' | 'packageDescription' | 'validatorTtlSeconds'
> {
  readonly publishedValidators: DocumentValidators;
  describe(options: DescribeOptions, signal: AbortSignal): Promise<DescribeResult>;
}
export interface PackageSyncPayload {
  readonly sourceId: string;
  readonly key: string;
  readonly sessionId?: string;
  readonly generation?: number;
  readonly step?: number;
}
export interface OnDemandDeps {
  readonly sessions: IngestSessions & IngestSessionRelease;
  readonly clock: Clock;
  readonly cache: ScopedCache;
  readonly visibility: PackageVisibilityPort;
  readonly upstreamState: Pick<UpstreamStateRepository, 'get'>;
  readonly apply: ApplyDeps;
  readonly sourceMetadata: (
    ctx: OrgContext,
    sourceId: string,
  ) => Promise<{
    readonly type: SourceType;
    readonly form?: Exclude<UpstreamForm, 'composer-p2-dev'>;
  }>;
  readonly writeGuard: (ctx: OrgContext, session: IngestSessionHandle) => CatalogueWriteGuard;
  readonly planFill: (
    ctx: OrgContext,
    sourceId: string,
    key: string,
    observability?: Observability,
  ) => Promise<PackageFillPlan | null>;
  readonly enqueueSync: (ctx: OrgContext, payload: PackageSyncPayload) => Promise<void>;
}
export interface OnDemandRequest {
  readonly observability?: Observability;
  readonly ecosystem: NameEcosystem;
  readonly key: string;
  readonly outcome: PackageVisibility;
  readonly signal?: AbortSignal;
}
export type OnDemandResult =
  | { readonly kind: 'not_found' | 'filled' | 'upstream_error' | 'upstream_refused' }
  | { readonly kind: 'busy'; readonly retryAfterSeconds: number }
  | { readonly kind: 'serve'; readonly stale: boolean; readonly background?: () => Promise<void> };
export interface OnDemandFill {
  ensure(actor: ProjectActor, request: OnDemandRequest): Promise<OnDemandResult>;
}
interface OnDemandService {
  ensure(
    actor: ProjectActor,
    request: OnDemandRequest,
    startedAt?: number,
  ): Promise<OnDemandResult>;
}
function busyRetryAfter(seconds: number | null): number {
  if (seconds === null || !Number.isFinite(seconds)) return 10;
  return Math.max(1, Math.min(60, Math.round(seconds)));
}
export class UpstreamFillError extends Error {
  override readonly name = 'UpstreamFillError';
  constructor() {
    super('upstream fill failed');
  }
}
const BUSY = { kind: 'busy', retryAfterSeconds: 10 } as const;
const INCOMPLETE_RETRY_MS = BUSY.retryAfterSeconds * 1000;
const mapped = (state: DoneState): OnDemandResult =>
  state === 'filled' ? { kind: 'filled' } : state === 'negative' ? { kind: 'not_found' } : BUSY;

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function abortableFill(fill: CoalesceFill): CoalesceFill {
  return (signal) => abortable(fill(signal), signal);
}

export function createOnDemandFill(deps: OnDemandDeps): OnDemandFill {
  const handles = new Map<string, IngestSessionHandle>();
  const resumable = new WeakSet<IngestSessionHandle>();
  const scoped = (ctx: OrgContext, key: string) => `${ctx.orgId}\u0000${key}`;
  interface FlightRecord {
    users: number;
    absentAt: string | null;
  }
  const flights = new Map<string, FlightRecord>();
  const incompleteUntil = new Map<string, number>();
  const incompleteSeen = (flightKey: string): boolean => {
    const until = incompleteUntil.get(flightKey);
    if (until === undefined) return false;
    if (until > deps.clock.now().getTime()) return true;
    incompleteUntil.delete(flightKey);
    return false;
  };
  const scopeOf = (key: string): IngestScopeRef => {
    const [, , sourceId, packageKey] = JSON.parse(key) as string[];
    return { scope: 'package', sourceId: sourceId!, packageKey: packageKey! };
  };
  const coalescer = createCoalescer(
    {
      async acquire(ctx, key, owner, seconds) {
        const handle = await deps.sessions.acquire(ctx, scopeOf(key), owner, seconds);
        if (handle === 'held') return handle;
        handles.set(scoped(ctx, key), handle);
        return { key, owner: handle.owner, fence: handle.fence };
      },
      async renew(ctx, lease) {
        const handle = handles.get(scoped(ctx, lease.key));
        const latest = await deps.sessions.latest(ctx, scopeOf(lease.key));
        return (
          handle?.owner === lease.owner &&
          handle.fence === lease.fence &&
          latest?.state === 'running' &&
          latest.id === handle.id &&
          latest.fence === lease.fence &&
          latest.generation === handle.generation
        );
      },
      async release(ctx, lease) {
        const key = scoped(ctx, lease.key);
        const handle = handles.get(key);
        if (handle?.owner !== lease.owner || handle.fence !== lease.fence) return;
        try {
          if (handle.stamp === null && !resumable.has(handle))
            await deps.sessions.discard(ctx, handle);
          else await deps.sessions.release(ctx, handle);
        } finally {
          if (handles.get(key) === handle) handles.delete(key);
        }
      },
    },
    deps.clock,
  );

  const service: OnDemandService = {
    async ensure(actor, request, startedAt = deps.clock.now().getTime()) {
      const { outcome, signal } = request;
      if (outcome.kind === 'absent') return { kind: 'not_found' };
      const ecosystem = outcome.kind === 'visible' ? outcome.pkg.ecosystem : outcome.ecosystem;
      const key = outcome.kind === 'visible' ? outcome.pkg.key : outcome.key;
      const sourceId = outcome.kind === 'visible' ? outcome.pkg.sourceId : outcome.sourceIds[0];
      if (sourceId === undefined) return { kind: 'not_found' };
      const ctx: OrgContext = { orgId: actor.orgId };
      const started = startedAt;
      const negativeKey = catalogueNegativeKey(actor.projectId, sourceId, ecosystem, key);
      let negativeVersion: string | null = null;
      let currentVisibility: PackageVisibility = outcome;
      const storeNegative = async (expectedVersion: string | null) => {
        if (expectedVersion === null) return 'bypassed' as const;
        return deps.cache.set(
          ctx,
          negativeKey,
          defaultEntry('negative', new Uint8Array(), deps.clock.now()),
          { expectedVersion, origin: { status: 404, authenticated: true, authorized: true } },
        );
      };
      const isDone = async (includeDenial = true): Promise<DoneState> => {
        const cached = await deps.cache.get(ctx, negativeKey);
        negativeVersion = cached.version;
        const current = await deps.visibility.resolve(actor, ecosystem, key);
        currentVisibility = current;
        if (current.kind === 'absent') return includeDenial ? 'negative' : 'pending';
        if (current.kind === 'visible') return current.pkg.listingComplete ? 'filled' : 'pending';
        if (!current.sourceIds.includes(sourceId)) return 'pending';
        return cached.hit?.entry.negative ? 'negative' : 'pending';
      };
      const hold = async (): Promise<OnDemandResult> => {
        if (ecosystem !== 'composer') return BUSY;
        while (!signal?.aborted) {
          const remaining = 25_000 - (deps.clock.now().getTime() - started);
          if (remaining <= 0) return BUSY;
          await pause(Math.min(250, remaining), signal);
          const state = await isDone();
          if (state !== 'pending') return mapped(state);
        }
        return BUSY;
      };
      const coalescerKey = JSON.stringify(['ingest', 'package', sourceId, key]);
      const flightKey = scoped(ctx, coalescerKey);
      const flight = flights.get(flightKey) ?? { users: 0, absentAt: null };
      flight.users += 1;
      flights.set(flightKey, flight);
      try {
        if (outcome.kind === 'visible' && outcome.pkg.listingComplete) {
          const stale = (): OnDemandResult => ({
            kind: 'serve',
            stale: true,
            background: async () => {
              try {
                await deps.enqueueSync(ctx, { sourceId, key });
              } catch {
                return;
              }
            },
          });
          try {
            const { type, form: configuredForm } = await deps.sourceMetadata(ctx, sourceId);
            if (
              type !== 'npmjs_proxy' &&
              type !== 'npm_registry' &&
              type !== 'packagist_proxy' &&
              !(type === 'composer_repository' && configuredForm === 'composer-v1-provider')
            )
              return { kind: 'serve', stale: false };
            const row = await deps.upstreamState.get(
              ctx,
              outcome.pkg.packageId,
              upstreamForm(type, configuredForm),
            );
            if (
              row !== null &&
              row.notFoundCount === 0 &&
              Date.parse(row.freshUntil) > deps.clock.now().getTime()
            )
              return { kind: 'serve', stale: false };
            return stale();
          } catch {
            return stale();
          }
        }
        const cached = await deps.cache.get(ctx, negativeKey);
        if (outcome.kind === 'proxy_admissible' && cached.hit?.entry.negative) {
          const current = await isDone();
          if (current !== 'pending') return mapped(current);
        }
        if (ecosystem === 'composer' && incompleteSeen(flightKey)) return BUSY;
        const result = await coalescer.run(
          ctx,
          coalescerKey,
          abortableFill(async (fillSignal) => {
            const session = handles.get(scoped(ctx, coalescerKey));
            if (session === undefined) return 'pending';
            flight.absentAt = null;
            const plan = await deps.planFill(
              ctx,
              sourceId,
              key,
              ...(request.observability === undefined ? [] : [request.observability]),
            );
            fillSignal.throwIfAborted();
            if (plan === null) return 'negative';
            let described: DescribeResult;
            try {
              described = await plan.describe(
                describeOptions(session, plan.publishedValidators),
                fillSignal,
              );
              if (described.kind === 'not_modified' && session.snapshotId === null)
                described = await plan.describe({}, fillSignal);
            } catch (error) {
              if (fillSignal.aborted) throw fillSignal.reason;
              if (error instanceof PackagistBusyError) throw error;
              if (isSnapshotGone(error)) {
                await deps.sessions.abandon(ctx, session);
                return 'pending';
              }
              if (isUpstreamRefusal(error)) throw error;
              if (isUpstreamFailure(error)) throw new UpstreamFillError();
              throw error;
            }
            fillSignal.throwIfAborted();
            if (described.kind === 'not_found' && described.definitive) {
              if (outcome.kind !== 'proxy_admissible') return 'pending';
              const current = await deps.visibility.resolve(actor, ecosystem, key);
              if (current.kind !== 'proxy_admissible' || !current.sourceIds.includes(sourceId))
                return 'pending';
              fillSignal.throwIfAborted();
              const stored = await storeNegative(negativeVersion);
              if (
                negativeVersion !== null &&
                stored !== 'discarded' &&
                !fillSignal.aborted &&
                flights.get(flightKey) === flight
              )
                flight.absentAt = negativeVersion;
              return 'negative';
            }
            if (described.kind === 'not_modified') return 'pending';
            if (described.kind !== 'found') throw new UpstreamFillError();
            const metadata = await deps.sourceMetadata(ctx, sourceId);
            fillSignal.throwIfAborted();
            const validators =
              session.snapshotBlobSha256 !== null &&
              session.snapshotId === described.description.snapshot.id &&
              session.pendingValidators !== null
                ? parsePendingValidators(session.pendingValidators)
                : pendingValidators(
                    described.description.validators,
                    upstreamForm(metadata.type, metadata.form),
                  );
            const apply: ApplyDeps = {
              ...deps.apply,
              sessions: {
                ...deps.apply.sessions,
                async start(startCtx, handle, input) {
                  const didStart = await deps.apply.sessions.start(startCtx, handle, input);
                  if (didStart) resumable.add(session);
                  return didStart;
                },
              },
              finalizer: {
                async finalize(finalizeCtx, handle, input, guard) {
                  // applyChunk reserves four validator statements: at most two publishes plus this write.
                  if (!(await deps.sessions.setPendingValidators(finalizeCtx, handle, validators)))
                    return { status: 'refused', reason: 'superseded' };
                  return deps.apply.finalizer.finalize(finalizeCtx, handle, input, guard);
                },
              },
            };
            let applied;
            try {
              applied = await applyChunk(ctx, apply, {
                ...plan,
                description: described.description,
                session,
                guard: deps.writeGuard(ctx, session),
              });
            } catch (error) {
              if (fillSignal.aborted) throw fillSignal.reason;
              if (isSnapshotGone(error)) {
                await deps.sessions.abandon(ctx, session);
                return 'pending';
              }
              if (isUpstreamRefusal(error)) throw error;
              if (isUpstreamFailure(error)) throw new UpstreamFillError();
              throw error;
            }
            fillSignal.throwIfAborted();
            if (applied.done && applied.status === 'complete') return 'filled';
            if (applied.status === 'incomplete' && ecosystem === 'composer') {
              const now = deps.clock.now().getTime();
              for (const [entry, until] of incompleteUntil)
                if (until <= now) incompleteUntil.delete(entry);
              incompleteUntil.set(flightKey, now + INCOMPLETE_RETRY_MS);
              return 'pending';
            }
            if (applied.status === 'progress' || applied.status === 'superseded') {
              resumable.add(session);
              // A progress result leaves the planner's reserved abandonment statement unused.
              if (
                applied.status === 'progress' &&
                !(await deps.sessions.setPendingValidators(ctx, applied.session, validators))
              )
                return 'pending';
              await deps.sessions.release(ctx, applied.session);
              await deps.enqueueSync(ctx, {
                sourceId,
                key,
                sessionId: applied.session.id,
                generation: applied.session.generation,
                step: applied.session.pagesSoFar,
              });
            }
            return 'pending';
          }),
          {
            isDone: () => isDone(false),
            ...(signal === undefined ? {} : { signal }),
            waitBudgetMs:
              ecosystem === 'composer'
                ? Math.max(0, 25_000 - (deps.clock.now().getTime() - started))
                : 8000,
          },
        );
        const sharedAbsence = result === 'negative' ? flight.absentAt : null;
        const current = await isDone();
        if (current !== 'pending') return mapped(current);
        if (
          sharedAbsence !== null &&
          outcome.kind === 'proxy_admissible' &&
          currentVisibility.kind === 'proxy_admissible' &&
          currentVisibility.sourceIds.includes(sourceId)
        ) {
          signal?.throwIfAborted();
          await storeNegative(sharedAbsence);
          return { kind: 'not_found' };
        }
        if (ecosystem === 'composer' && incompleteSeen(flightKey)) return BUSY;
        if (
          result === 'busy' ||
          currentVisibility.kind !== 'proxy_admissible' ||
          !currentVisibility.sourceIds.includes(sourceId)
        )
          return await hold();
        return mapped(result);
      } catch (error) {
        if (error instanceof SourceUnavailableError)
          return { kind: 'busy', retryAfterSeconds: SOURCE_UNAVAILABLE_RETRY_SECONDS };
        if (isUpstreamRefusal(error)) return { kind: 'upstream_refused' };
        if (error instanceof PackagistBusyError)
          return {
            kind: 'busy',
            retryAfterSeconds: busyRetryAfter(error.retryAfterSeconds),
          };
        return error instanceof UpstreamFillError ? { kind: 'upstream_error' } : BUSY;
      } finally {
        flight.users -= 1;
        if (flight.users === 0 && flights.get(flightKey) === flight) flights.delete(flightKey);
      }
    },
  };
  const fill: OnDemandFill & { pendingFlightMarkers(): number } = {
    pendingFlightMarkers: () => flights.size,
    async ensure(actor, request) {
      const { outcome } = request;
      const ecosystem =
        outcome.kind === 'visible'
          ? outcome.pkg.ecosystem
          : outcome.kind === 'proxy_admissible'
            ? outcome.ecosystem
            : request.ecosystem;
      if (ecosystem !== 'composer') return service.ensure(actor, request);
      const deadline = new AbortController();
      const signal =
        request.signal === undefined
          ? deadline.signal
          : AbortSignal.any([request.signal, deadline.signal]);
      const startedAt = deps.clock.now().getTime();
      const timer = setTimeout(() => deadline.abort(), 25_000);
      try {
        return await abortable(service.ensure(actor, { ...request, signal }, startedAt), signal);
      } catch {
        return BUSY;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return fill;
}
