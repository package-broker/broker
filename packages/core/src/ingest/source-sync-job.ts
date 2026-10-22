import { sha256Hex } from '../auth/primitives.js';
import {
  CATALOGUE_KEY_LIST_MAX,
  type CatalogueWriteGuard,
  type CatalogueWriter,
} from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import type { SourceErrorCode, SourceRecord, SourceRepository } from '../db/source.js';
import type { JobGuard } from '../platform/job-repository.js';
import {
  canonicalPayload,
  defineJob,
  JobError,
  type JobContext,
  type JobDefinition,
} from '../platform/jobs.js';
import { UpstreamError, type UpstreamCredential } from '../sources/policy-fetch.js';
import {
  collectListing,
  SESSION_PAGE_CAP,
  type ListingPage,
  type ProviderContext,
  type ProviderRegistry,
  type ProviderSource,
} from '../sources/provider.js';
import type { IngestFinalizer } from './finalize.js';
import type { IngestSessionHandle, IngestSessionRelease, IngestSessions } from './session.js';

export const FANOUT_PER_INVOCATION = 100;

const PACKAGE_SYNC = 'core:package-sync:v1';
const SOURCE_SYNC = 'core:source-sync:v1';
const LEASE_SECONDS = 300;
const MAX_KEY_BYTES = 512;
const MAX_CURSOR_BYTES = 4096;
const MAX_PAYLOAD_CURSOR = 512;
const HEX_64 = /^[0-9a-f]{64}$/;
const REASONS: ReadonlySet<unknown> = new Set(['poll', 'webhook', 'admin']);
const NO_LISTING: ReadonlySet<string> = new Set(['packagist_proxy', 'npmjs_proxy', 'npm_registry']);
const SKIPPABLE_ENQUEUE: ReadonlySet<string> = new Set([
  'invalid_payload',
  'payload_too_large',
  'invalid_idempotency_key',
]);

export interface SourceSyncPayload {
  readonly sourceId: string;
  readonly reason: 'poll' | 'webhook' | 'admin';
  readonly cursor?: string;
  readonly generation?: string;
}

export interface SourceSyncDeps {
  readonly sources: Pick<SourceRepository, 'get' | 'pollState'>;
  readonly providers: Pick<ProviderRegistry, 'forSource'>;
  readonly toProviderSource: (record: SourceRecord) => ProviderSource;
  /** Decrypts inside the handler; the plaintext never leaves the returned credential object. */
  readonly loadCredential: (
    ctx: OrgContext,
    record: SourceRecord,
  ) => Promise<UpstreamCredential | null>;
  readonly providerContext: (
    job: JobContext,
    credential: UpstreamCredential | null,
  ) => ProviderContext;
  readonly sessions: Pick<IngestSessions, 'acquire' | 'start' | 'advance' | 'abandon'> &
    Pick<IngestSessionRelease, 'release'>;
  readonly writer: Pick<CatalogueWriter, 'openListing' | 'markListing'>;
  readonly finalizer: IngestFinalizer;
  /** The session guard together with the job lease guard. */
  readonly writeGuard: (
    ctx: OrgContext,
    session: IngestSessionHandle,
    job: JobContext,
  ) => CatalogueWriteGuard;
  readonly jobGuard: (job: JobContext) => JobGuard;
  /** Rows of the source carrying this session's listing stamp; the finalize count never trusts a running counter. */
  readonly markedCount: (ctx: OrgContext, sourceId: string, stamp: string) => Promise<number>;
  /** Rows of the source the stamp sweep would remove: not marked in this session's listing. */
  readonly unseenExistingCount: (
    ctx: OrgContext,
    sourceId: string,
    stamp: string,
  ) => Promise<number>;
  /** Recheck the current refresh selection before marking or dispatching listed names. */
  readonly selectedKeys?: (
    ctx: OrgContext,
    sourceId: string,
    names: readonly string[],
  ) => Promise<readonly string[]>;
  /** Changes whenever the inputs of the refresh selection change. */
  readonly selectionRevision?: (ctx: OrgContext, sourceId: string) => Promise<string>;
  /** Read the selected names and their revision from one database snapshot. */
  readonly selectionSnapshot?: (
    ctx: OrgContext,
    sourceId: string,
    names: readonly string[],
  ) => Promise<{ readonly keys: readonly string[]; readonly revision: string }>;
  /** The subset of `names` that already has a package row in the source. */
  readonly existingKeys: (
    ctx: OrgContext,
    sourceId: string,
    names: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** Held packages whose upstream state is no longer fresh, in key order after `after`. */
  readonly staleHeldKeys: (
    ctx: OrgContext,
    sourceId: string,
    query: { readonly after: string | null; readonly limit: number },
  ) => Promise<{ readonly keys: readonly string[]; readonly next: string | null }>;
}

interface ListingCursor {
  readonly c: string | null;
  readonly o: number;
  readonly x?: 1;
  readonly d?: 1;
  readonly h?: string;
  readonly r?: string;
  readonly e?: 1;
}

class SyncFailure extends Error {
  constructor(
    readonly code: SourceErrorCode,
    readonly record: boolean,
    readonly retry: boolean,
    readonly abandon: boolean,
  ) {
    super(code);
    this.name = 'SyncFailure';
  }
}

const invalidListing = () => new SyncFailure('invalid_response', true, false, true);
const massAbsence = () => new SyncFailure('mass_absence', true, false, true);
const lostSession = () => new SyncFailure('internal', false, true, false);

function digest(parts: readonly unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

function validate(input: unknown): SourceSyncPayload {
  const value = JSON.parse(canonicalPayload(input)) as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError('invalid_payload');
  }
  const { sourceId, reason, cursor, generation } = value;
  if (
    Object.keys(value).some(
      (key) => !['sourceId', 'reason', 'cursor', 'generation'].includes(key),
    ) ||
    typeof sourceId !== 'string' ||
    sourceId.length === 0 ||
    sourceId.length > MAX_KEY_BYTES ||
    !REASONS.has(reason) ||
    (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > MAX_PAYLOAD_CURSOR)) ||
    (generation !== undefined && (typeof generation !== 'string' || !HEX_64.test(generation)))
  ) {
    throw new JobError('invalid_payload');
  }
  return {
    sourceId,
    reason: reason as SourceSyncPayload['reason'],
    ...(cursor === undefined ? {} : { cursor: cursor as string }),
    ...(generation === undefined ? {} : { generation: generation as string }),
  };
}

function classify(error: unknown): SourceErrorCode {
  if (!(error instanceof UpstreamError)) return 'internal';
  switch (error.code) {
    case 'refused':
      return 'policy_denied';
    case 'timeout':
      return 'timeout';
    case 'too_large':
      return 'too_large';
    case 'network':
      return 'network';
    case 'http_status':
      if (error.status === 401 || error.status === 403) return 'unauthorized';
      if (error.status === 429) return 'rate_limited';
      if (error.status === 404) return 'not_found';
      return 'http_error';
  }
}

function isKey(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.toLowerCase() &&
    ![...name].some((char) => char <= '\u001f' || char === '\u007f') &&
    new TextEncoder().encode(name).length <= MAX_KEY_BYTES
  );
}

function parseCursor(session: IngestSessionHandle): ListingCursor {
  if (session.stamp === null || session.cursor === null) return { c: null, o: 0 };
  try {
    const value = JSON.parse(session.cursor) as Partial<ListingCursor> | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      (value.c === null || typeof value.c === 'string') &&
      Number.isSafeInteger(value.o) &&
      (value.o as number) >= 0 &&
      (value.x === undefined || value.x === 1) &&
      (value.d === undefined || value.d === 1) &&
      (value.e === undefined || value.e === 1) &&
      (value.r === undefined || (typeof value.r === 'string' && HEX_64.test(value.r))) &&
      (value.h === undefined || (typeof value.h === 'string' && HEX_64.test(value.h)))
    ) {
      return value as ListingCursor;
    }
  } catch {
    throw invalidListing();
  }
  throw invalidListing();
}

function jobsOf(job: JobContext) {
  const jobs = job.ports.platform?.jobs;
  if (jobs === undefined) throw new JobError('handler_error');
  return jobs;
}

async function fanOut(
  job: JobContext,
  input: {
    readonly sourceId: string;
    readonly key: string;
    readonly generation: readonly unknown[];
  },
): Promise<void> {
  try {
    await jobsOf(job).enqueue(
      job.org,
      PACKAGE_SYNC,
      { sourceId: input.sourceId, key: input.key },
      {
        idempotencyKey: await digest(['v1', input.sourceId, input.key, ...input.generation]),
        resourceKey: `package:${await digest(['v1', input.sourceId, input.key])}`,
      },
    );
  } catch (error) {
    if (error instanceof JobError && SKIPPABLE_ENQUEUE.has(error.code)) return;
    throw error;
  }
}

interface Run {
  session: IngestSessionHandle | null;
}

async function recordSuccess(
  deps: SourceSyncDeps,
  job: JobContext,
  sourceId: string,
  listingHash?: string,
): Promise<void> {
  await deps.sources.pollState(job.org, deps.jobGuard(job), {
    id: sourceId,
    outcome: 'success',
    ...(listingHash === undefined ? {} : { listingHash }),
  });
}

async function refreshHeld(
  deps: SourceSyncDeps,
  payload: SourceSyncPayload,
  job: JobContext,
  record: SourceRecord,
): Promise<void> {
  const generation = payload.generation ?? (await digest(['v1', 'proxy', job.idempotencyKey]));
  const held = await deps.staleHeldKeys(job.org, record.id, {
    after: payload.cursor ?? null,
    limit: FANOUT_PER_INVOCATION,
  });
  for (const key of held.keys) {
    await fanOut(job, { sourceId: record.id, key, generation: ['proxy', generation] });
  }
  if (held.next === null) {
    await recordSuccess(deps, job, record.id);
    return;
  }
  await jobsOf(job).enqueue(
    job.org,
    SOURCE_SYNC,
    { sourceId: record.id, reason: payload.reason, cursor: held.next, generation },
    {
      idempotencyKey: await digest(['v1', 'proxy-next', record.id, generation, held.next]),
      resourceKey: `source:${record.id}`,
    },
  );
}

async function syncListing(
  deps: SourceSyncDeps,
  payload: SourceSyncPayload,
  job: JobContext,
  record: SourceRecord,
  run: Run,
  acquired: IngestSessionHandle,
): Promise<void> {
  const ctx = job.org;
  let session = acquired;
  run.session = session;

  let credential: UpstreamCredential | null = null;
  if (record.credentialId !== null) {
    try {
      credential = await deps.loadCredential(ctx, record);
    } catch {
      throw new SyncFailure('credential_unavailable', true, true, false);
    }
    if (credential === null) throw new SyncFailure('credential_unavailable', true, true, false);
  }
  const source = deps.toProviderSource(record);
  const provider = deps.providers.forSource(source);
  const list = provider.listPackages?.bind(provider);
  if (list === undefined) throw new SyncFailure('internal', true, false, true);
  const providerContext = deps.providerContext(job, credential);

  let cursor = parseCursor(session);
  const revisionOf = async (): Promise<string | undefined> =>
    deps.selectionRevision === undefined ? undefined : deps.selectionRevision(ctx, record.id);
  const revisionHash = async () => {
    const revision = await revisionOf();
    return revision === undefined ? undefined : digest([revision]);
  };
  const restartListing = () => new SyncFailure('internal', false, true, true);
  let budget = FANOUT_PER_INVOCATION;
  const adopt = (next: IngestSessionHandle) => {
    session = next;
    run.session = next;
  };

  while (cursor.d !== 1) {
    if (budget <= 0) {
      await deps.sessions.release(ctx, session);
      run.session = null;
      await jobsOf(job).enqueue(
        ctx,
        SOURCE_SYNC,
        { sourceId: record.id, reason: payload.reason },
        {
          idempotencyKey: await digest([session.id, session.generation, session.pagesSoFar]),
          resourceKey: `source:${record.id}`,
        },
      );
      return;
    }
    if (session.pagesSoFar >= SESSION_PAGE_CAP) throw invalidListing();

    const holder: { page?: ListingPage } = {};
    const outcome = await collectListing(
      async (at) => {
        holder.page = await list(providerContext, source, at);
        return holder.page;
      },
      async () => undefined,
      {
        cursor: cursor.c,
        snapshot: session.snapshotId === null ? null : { id: session.snapshotId },
        pageBudget: 1,
        pagesSoFar: session.pagesSoFar,
        signal: job.signal,
      },
    );
    const page = holder.page;
    if (outcome.stop === 'error') throw new SyncFailure(classify(outcome.error), true, true, false);
    if (outcome.abandoned) throw new SyncFailure('invalid_response', true, true, true);
    if (page === undefined || (outcome.next !== null && outcome.next === cursor.c)) {
      throw invalidListing();
    }
    if (!outcome.complete && outcome.stop !== 'budget') throw invalidListing();

    const guard = deps.writeGuard(ctx, session, job);
    if (session.stamp === null) {
      const { stamp } = await deps.writer.openListing(ctx, guard, {
        kind: 'source',
        sourceId: record.id,
      });
      const started = await deps.sessions.start(ctx, session, {
        snapshot: { id: page.snapshot.id },
        stamp,
      });
      if (!started) throw lostSession();
      adopt({ ...session, stamp, snapshotId: page.snapshot.id });
    }

    const names = [...new Set(page.names.filter(isKey))];
    const pageDigest = await digest(names);
    if (cursor.o > 0 && cursor.h !== pageDigest) throw invalidListing();
    const unreadable = cursor.x === 1 || names.length !== new Set(page.names).size;
    const slice = names.slice(cursor.o, cursor.o + budget);
    const selection = await deps.selectionSnapshot?.(ctx, record.id, slice);
    const rawRevision = selection === undefined ? await revisionOf() : selection.revision;
    const revision = rawRevision === undefined ? undefined : await digest([rawRevision]);
    if (cursor.r !== undefined && revision !== cursor.r) throw restartListing();
    const listingGuard =
      rawRevision === undefined
        ? guard
        : deps.writeGuard(
            ctx,
            { ...session, cursor: JSON.stringify({ ...cursor, s: record.id, v: rawRevision }) },
            job,
          );
    const selected =
      selection?.keys ??
      (deps.selectedKeys === undefined ? slice : await deps.selectedKeys(ctx, record.id, slice));
    const existing =
      selected.length === 0 ? new Set<string>() : await deps.existingKeys(ctx, record.id, selected);
    let filteredExisting = cursor.e === 1;
    if (!filteredExisting && selected.length < slice.length) {
      const kept = new Set(selected);
      const dropped = slice.filter((key) => !kept.has(key));
      filteredExisting = (await deps.existingKeys(ctx, record.id, dropped)).size > 0;
    }
    for (const key of selected) {
      await fanOut(job, {
        sourceId: record.id,
        key,
        generation: [session.id, session.generation],
      });
    }
    budget -= slice.length;

    const present = selected.filter((key) => existing.has(key));
    for (let offset = 0; offset < present.length; offset += CATALOGUE_KEY_LIST_MAX) {
      await deps.writer.markListing(ctx, listingGuard, {
        scope: { kind: 'source', sourceId: record.id },
        stamp: session.stamp as string,
        present: present.slice(offset, offset + CATALOGUE_KEY_LIST_MAX),
      });
    }
    if (revision !== undefined && (await revisionHash()) !== revision) throw restartListing();

    const consumed = cursor.o + slice.length >= names.length;
    const flags = {
      ...(unreadable ? ({ x: 1 } as const) : {}),
      ...(filteredExisting ? ({ e: 1 } as const) : {}),
      ...(revision === undefined ? {} : { r: revision }),
    };
    const next: ListingCursor = !consumed
      ? { c: cursor.c, o: cursor.o + slice.length, ...flags, h: pageDigest }
      : outcome.complete
        ? { c: null, o: 0, ...flags, d: 1 }
        : { c: outcome.next, o: 0, ...flags };
    const text = JSON.stringify(next);
    if (new TextEncoder().encode(text).length > MAX_CURSOR_BYTES) throw invalidListing();
    const progress = await deps.sessions.advance(
      ctx,
      session,
      { cursor: text, addSeen: present.length },
      listingGuard,
    );
    if (progress === null) throw lostSession();
    adopt({
      ...session,
      cursor: text,
      seenCount: progress.seenCount,
      pagesSoFar: progress.pagesSoFar,
    });
    cursor = next;
  }

  if (cursor.x === 1) throw invalidListing();
  let unseen: number;
  let marked: number;
  try {
    marked = await deps.markedCount(ctx, record.id, session.stamp as string);
    unseen = await deps.unseenExistingCount(ctx, record.id, session.stamp as string);
  } catch {
    throw new SyncFailure('internal', true, true, false);
  }
  if (!Number.isSafeInteger(unseen) || unseen < 0 || !Number.isSafeInteger(marked) || marked < 0) {
    throw new SyncFailure('internal', true, true, false);
  }
  const revision = await revisionOf();
  if (
    cursor.r !== undefined &&
    (revision === undefined || (await digest([revision])) !== cursor.r)
  ) {
    throw restartListing();
  }
  const result = await deps.finalizer.finalize(
    ctx,
    session,
    {
      expectedCount: marked,
      attemptedCandidates: marked + unseen,
      successfulCandidates: marked,
      definitiveAbsent: unseen,
      upstreamComplete: true,
      validatorTtlSeconds: 0,
    },
    deps.writeGuard(
      ctx,
      revision !== undefined
        ? {
            ...session,
            cursor: JSON.stringify({ ...cursor, s: record.id, v: revision }),
          }
        : session,
      job,
    ),
  );
  if (result.status !== 'complete') {
    if (result.reason === 'superseded' || result.reason === 'session_unavailable') {
      throw lostSession();
    }
    if (result.reason === 'mass_absence') throw massAbsence();
    throw invalidListing();
  }
  job.observability.counter('pb.ingest.lease_held_back', undefined, result.leaseHeldBack);
  run.session = null;
  await recordSuccess(deps, job, record.id, session.snapshotId ?? undefined);
}

async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    return;
  }
}

export const sourceSyncJob = defineJob<SourceSyncPayload>({
  name: 'source-sync',
  version: 1,
  validate,
  async handler(_payload, context) {
    if (context.signal.aborted) return;
    throw new JobError('invalid_definition');
  },
});

export function createSourceSyncJob(deps: SourceSyncDeps): JobDefinition<SourceSyncPayload> {
  return defineJob<SourceSyncPayload>({
    ...sourceSyncJob,
    validate,
    async handler(payload, job) {
      if (job.signal.aborted) return;
      const ctx = job.org;
      const record = await deps.sources.get(ctx, payload.sourceId);
      if (record === null || record.status === 'paused' || record.type === 'hosted') return;

      const run: Run = { session: null };
      let acquired: IngestSessionHandle | null = null;
      if (!NO_LISTING.has(record.type)) {
        const handle = await deps.sessions.acquire(
          ctx,
          { scope: 'source', sourceId: record.id },
          `${job.jobId}:${String(job.attempt)}`,
          LEASE_SECONDS,
        );
        if (handle === 'held') throw new JobError('handler_error');
        acquired = handle;
        run.session = handle;
      }
      try {
        if (acquired === null) await refreshHeld(deps, payload, job, record);
        else await syncListing(deps, payload, job, record, run, acquired);
      } catch (error) {
        if (job.signal.aborted) {
          if (run.session !== null) await quietly(deps.sessions.release(ctx, run.session));
          throw new JobError('aborted');
        }
        const failure =
          error instanceof SyncFailure
            ? error
            : new SyncFailure(classify(error), true, true, false);
        if (run.session !== null) {
          await quietly(
            failure.abandon
              ? deps.sessions.abandon(ctx, run.session)
              : deps.sessions.release(ctx, run.session),
          );
        }
        if (failure.record) {
          await quietly(
            (async () =>
              deps.sources.pollState(ctx, deps.jobGuard(job), {
                id: record.id,
                outcome: 'failure',
                error: failure.code,
              }))(),
          );
        }
        if (failure.retry) throw new JobError('handler_error');
      }
    },
  });
}
