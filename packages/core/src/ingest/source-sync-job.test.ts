import { repositoryListing } from '../internal/composer-repository-listing.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CatalogueWriteGuard } from '../db/catalogue.js';
import type { SourceRecord } from '../db/source.js';
import type { OrgContext } from '../db/port.js';
import { JobError, MAX_PAYLOAD_BYTES, jobErrorCode, type JobContext } from '../platform/jobs.js';
import type { LogRecord } from '../platform/observability.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import {
  snapshotRef,
  type ListingPage,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '../sources/provider.js';
import type { IngestFinalizeInput, IngestFinalizeResult } from './finalize.js';
import type { IngestSessionHandle } from './session.js';
import {
  createSourceSyncJob,
  FANOUT_PER_INVOCATION,
  sourceSyncJob,
  type SourceSyncDeps,
} from './source-sync-job.js';

const ORG = { orgId: 'org' } as unknown as OrgContext;
const SNAP = snapshotRef('"listing-1"');
const SECRET = 'S3cr3t-Credential-Value-9f2c';
const STAMP = '2026-10-20T10:00:00.000Z';

const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function record(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'src',
    projectId: null,
    name: 'source',
    ecosystem: 'composer',
    type: 'composer_repository',
    url: 'https://repo.example',
    credentialId: null,
    configJson: '{}',
    userAgent: null,
    defaultVisibleToNewProjects: false,
    removalPolicy: 'flag',
    retentionDaysOverride: null,
    status: 'active',
    pollIntervalSeconds: 3600,
    nextPollAt: null,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    rootHash: null,
    listingHash: null,
    pollEtag: null,
    pollLastModified: null,
    removalRefusal: null,
    removalAccepted: false,
    ...over,
  };
}

interface Enqueued {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly resourceKey?: string;
}

interface Pages {
  [cursor: string]: ListingPage | Error;
}

function page(names: string[], next: string | null, snapshot = SNAP): ListingPage {
  return { names, next, last: next === null, snapshot };
}

function setup(options: {
  pages?: Pages;
  source?: SourceRecord | null;
  existing?: (names: readonly string[]) => string[];
  finalize?: (input: IngestFinalizeInput) => IngestFinalizeResult;
  enqueueError?: (type: string, payload: Record<string, unknown>) => Error | undefined;
  held?: Record<string, { keys: string[]; next: string | null }>;
  credentialError?: boolean;
  credentialNull?: boolean;
  unseen?: number | Error;
  marked?: number;
  heldError?: boolean;
  signal?: AbortSignal;
  listPackages?: SourceProvider['listPackages'];
  noListing?: boolean;
  selectionRevision?: () => Promise<string>;
  onMark?: () => void;
}) {
  const source = options.source === undefined ? record() : options.source;
  const pages: Pages = options.pages ?? { '': page([], null) };
  const enqueued: Enqueued[] = [];
  const seenKeys = new Set<string>();
  const logs: LogRecord[] = [];
  const marks: { stamp: string; present: readonly string[] }[] = [];
  const finalizes: IngestFinalizeInput[] = [];
  const polls: unknown[] = [];
  const calls = { list: [] as (string | null)[], open: 0, abandon: 0, release: 0, held: 0 };
  const credentialSeen: unknown[] = [];

  const state = { session: null as IngestSessionHandle | null, generation: 0, lease: false };
  const makeHandle = (): IngestSessionHandle => ({
    id: `sess-${String(state.generation)}`,
    scopeKey: 'scope',
    owner: 'o',
    fence: 1,
    leaseSeconds: 60,
    generation: state.generation,
    stamp: null,
    snapshotId: null,
    snapshotBlobSha256: null,
    cursor: null,
    seenCount: 0,
    pagesSoFar: 0,
    pendingValidators: null,
  });

  const provider: SourceProvider = {
    id: 'p',
    sourceTypes: ['composer_repository', 'vcs', 'packagist_proxy'],
    ecosystems: ['composer', 'npm'],
    ...(options.noListing === true
      ? {}
      : {
          listPackages:
            options.listPackages ??
            (async (ctx: ProviderContext, _source: ProviderSource, cursor: string | null) => {
              calls.list.push(cursor);
              credentialSeen.push(ctx.credential);
              const found = pages[cursor ?? ''];
              if (found === undefined) throw new Error('no such page');
              if (found instanceof Error) throw found;
              return found;
            }),
        }),
    describe: async () => ({ kind: 'not_found', definitive: false }),
    openDist: async () => {
      throw new Error('unused');
    },
  };

  const deps: SourceSyncDeps = {
    sources: {
      get: async () => source,
      pollState: async (_ctx, _guard, input) => {
        polls.push(input);
        return 'written';
      },
    },
    providers: { forSource: () => provider },
    toProviderSource: (r) => ({ id: r.id, ecosystem: r.ecosystem, url: r.url }) as ProviderSource,
    loadCredential: async () => {
      if (options.credentialNull === true) return null;
      if (options.credentialError === true) throw new Error(`cannot open ${SECRET}`);
      return {
        origins: ['https://repo.example'],
        queryParams: [],
        apply: (headers, url) => {
          headers.set('authorization', `Bearer ${SECRET}`);
          return { headers, url };
        },
      };
    },
    providerContext: (job, credential) =>
      ({ org: job.org, credential, signal: job.signal }) as unknown as ProviderContext,
    sessions: {
      async acquire() {
        if (state.lease) return 'held';
        if (state.session === null || state.session.stamp === 'complete') {
          state.generation += 1;
          state.session = makeHandle();
        }
        state.lease = true;
        return state.session;
      },
      async start(_ctx, _guard, input) {
        state.session = {
          ...state.session!,
          stamp: input.stamp,
          snapshotId: input.snapshot.id,
        };
        return true;
      },
      async advance(_ctx, _guard, input) {
        const current = state.session!;
        state.session = {
          ...current,
          cursor: input.cursor,
          seenCount: current.seenCount + input.addSeen,
          pagesSoFar: current.pagesSoFar + 1,
        };
        return { seenCount: state.session.seenCount, pagesSoFar: state.session.pagesSoFar };
      },
      async abandon() {
        calls.abandon += 1;
        state.lease = false;
        state.session = null;
        return true;
      },
      async release() {
        calls.release += 1;
        state.lease = false;
        return true;
      },
    },
    writer: {
      async openListing() {
        calls.open += 1;
        return { stamp: STAMP };
      },
      async markListing(_ctx, _guard, input) {
        marks.push({ stamp: input.stamp, present: input.present });
        options.onMark?.();
        return { changed: true, marked: input.present.length, statements: 4 };
      },
    },
    finalizer: {
      async finalize(_ctx, _session, input) {
        finalizes.push(input);
        const result = options.finalize?.(input) ?? {
          status: 'complete' as const,
          empty: input.expectedCount === 0,
          validatorsPublished: 0,
          leaseHeldBack: 0,
        };
        if (result.status === 'complete') {
          state.session = { ...state.session!, stamp: 'complete' };
          state.lease = false;
        }
        return result;
      },
    },
    writeGuard: () => [] as unknown as CatalogueWriteGuard,
    jobGuard: (job) => ({ id: job.jobId, owner: 'owner', fence: job.fence }),
    markedCount: async () => options.marked ?? state.session?.seenCount ?? 0,
    unseenExistingCount: async () => {
      if (options.unseen instanceof Error) throw options.unseen;
      return options.unseen ?? 0;
    },
    existingKeys: async (_ctx, _sourceId, names) =>
      new Set(options.existing === undefined ? [] : options.existing(names)),
    ...(options.selectionRevision === undefined
      ? {}
      : { selectionRevision: options.selectionRevision }),
    staleHeldKeys: async (_ctx, _sourceId, query) => {
      calls.held += 1;
      if (options.heldError === true) throw new Error(`database said ${SECRET}`);
      return options.held?.[query.after ?? ''] ?? { keys: [], next: null };
    },
  };

  const jobs = {
    async enqueue(_ctx: OrgContext, type: string, payload: unknown, input: Enqueued) {
      const failure = options.enqueueError?.(type, payload as Record<string, unknown>);
      if (failure !== undefined) throw failure;
      const created = !seenKeys.has(`${type}:${input.idempotencyKey}`);
      seenKeys.add(`${type}:${input.idempotencyKey}`);
      if (created) {
        enqueued.push({
          type,
          payload: payload as Record<string, unknown>,
          idempotencyKey: input.idempotencyKey,
          ...(input.resourceKey === undefined ? {} : { resourceKey: input.resourceKey }),
        });
      }
      return { id: 'job', created };
    },
    async get() {
      return null;
    },
  };

  let attempt = 0;
  const run = async (payload: unknown, idempotencyKey = 'poll-key') => {
    attempt += 1;
    const job = {
      org: ORG,
      jobId: 'job-1',
      idempotencyKey,
      attempt,
      fence: 1,
      signal: options.signal ?? new AbortController().signal,
      ports: {
        clock: { now: () => new Date('2026-10-20T10:00:00.000Z') },
        platform: { jobs },
      },
      observability: {
        log: (r: LogRecord) => logs.push(r),
        counter: () => {},
        histogram: () => {},
      },
    } as unknown as JobContext;
    const definition = createSourceSyncJob(deps);
    return definition.handler(definition.validate(payload), job);
  };
  const fanout = () => enqueued.filter((e) => e.type === 'core:package-sync:v1');
  const continuations = () => enqueued.filter((e) => e.type === 'core:source-sync:v1');
  return {
    run,
    enqueued,
    fanout,
    continuations,
    logs,
    marks,
    finalizes,
    polls,
    calls,
    state,
    credentialSeen,
  };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  sourceId: 'src',
  reason: 'poll',
  ...extra,
});

describe('source sync job: payload', () => {
  it('accepts ids, reason and an optional cursor and rejects everything else', () => {
    const job = createSourceSyncJob({} as SourceSyncDeps);
    expect(job.name).toBe('source-sync');
    expect(job.version).toBe(1);
    expect(job.validate(payload())).toEqual({ sourceId: 'src', reason: 'poll' });
    expect(job.validate(payload({ cursor: 'abc' }))).toMatchObject({ cursor: 'abc' });
    for (const bad of [
      null,
      [],
      {},
      { sourceId: '', reason: 'poll' },
      { sourceId: 'src', reason: 'cron' },
      { sourceId: 'src', reason: 'poll', extra: 1 },
      { sourceId: 'src', reason: 'poll', cursor: 7 },
      { sourceId: 'src', reason: 'poll', cursor: 'x'.repeat(5000) },
      { sourceId: 'src', reason: 'poll', generation: 'nothex' },
      { sourceId: 'src', reason: 'poll', credential: SECRET },
    ]) {
      expect(() => job.validate(bad)).toThrow(JobError);
    }
  });

  it('keeps payloads far below the job payload limit', () => {
    expect(JSON.stringify(payload({ cursor: 'c'.repeat(512) })).length).toBeLessThan(
      MAX_PAYLOAD_BYTES,
    );
  });

  it('is unusable until bound to dependencies', async () => {
    await expect(
      sourceSyncJob.handler(payload() as never, { signal: new AbortController().signal } as never),
    ).rejects.toMatchObject({ code: 'invalid_definition' });
  });
});

describe('source sync job: listing and fan-out', () => {
  it.each(['between pages', 'during marks'])(
    'restarts when selection changes %s even without filtered names',
    async (phase) => {
      let revision = 'initial';
      const t = setup({
        existing: (names) => [...names],
        selectionRevision: async () => revision,
        listPackages: async (_ctx, _source, cursor) => {
          if (cursor === null) return page(['a/one'], 'p2');
          if (phase === 'between pages') revision = 'changed';
          return page(['a/two'], null);
        },
        onMark: () => {
          if (phase === 'during marks') revision = 'changed';
        },
      });
      await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
      expect(t.finalizes).toEqual([]);
      expect(t.calls.abandon).toBe(1);
      expect(t.polls).toEqual([]);
    },
  );

  const twoPages: Pages = {
    '': page(['a/one', 'a/two'], 'p2'),
    p2: page(['a/three'], null),
  };

  it('enqueues one package sync per name, marks present rows and finalizes after the last page', async () => {
    const t = setup({ pages: twoPages, existing: (names) => names.filter((n) => n !== 'a/two') });
    await t.run(payload());
    expect(t.fanout().map((e) => e.payload)).toEqual([
      { sourceId: 'src', key: 'a/one' },
      { sourceId: 'src', key: 'a/two' },
      { sourceId: 'src', key: 'a/three' },
    ]);
    expect(t.fanout().map((e) => e.idempotencyKey)).toEqual(
      ['a/one', 'a/two', 'a/three'].map((key) => sha(['v1', 'src', key, 'sess-1', 1])),
    );
    expect(t.calls.open).toBe(1);
    expect(t.marks.map((m) => [...m.present])).toEqual([['a/one'], ['a/three']]);
    expect(t.marks.every((m) => m.stamp === STAMP)).toBe(true);
    expect(t.finalizes).toEqual([
      {
        expectedCount: 2,
        attemptedCandidates: 2,
        successfulCandidates: 2,
        definitiveAbsent: 0,
        upstreamComplete: true,
        validatorTtlSeconds: 0,
      },
    ]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'success', listingHash: SNAP.id }]);
  });

  it('applies no removal when the second page errors, but keeps the first page enqueued', async () => {
    const t = setup({
      pages: { '': page(['a/one'], 'p2'), p2: new UpstreamError('http_status', 503) },
      existing: (names) => [...names],
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/one']);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'http_error' }]);
  });

  it('resumes a failed listing from the failed page and still finalizes only once', async () => {
    const pages: Pages = { '': page(['a/one'], 'p2'), p2: new UpstreamError('timeout') };
    const t = setup({ pages, existing: (names) => [...names] });
    await expect(t.run(payload())).rejects.toBeInstanceOf(JobError);
    pages['p2'] = page(['a/two'], null);
    await t.run(payload());
    expect(t.calls.list).toEqual([null, 'p2', 'p2']);
    expect(t.calls.open).toBe(1);
    expect(t.finalizes).toHaveLength(1);
    expect(t.finalizes[0]?.expectedCount).toBe(2);
  });

  it('enqueues two distinct package syncs per package for two polls with unchanged names', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) } });
    await t.run(payload());
    await t.run(payload());
    const keys = t.fanout().map((e) => e.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([
      sha(['v1', 'src', 'a/one', 'sess-1', 1]),
      sha(['v1', 'src', 'a/one', 'sess-2', 2]),
    ]);
  });

  it('does not duplicate a package sync when the same generation replays a page', async () => {
    const pages: Pages = { '': page(['a/one'], 'p2'), p2: new UpstreamError('network') };
    const t = setup({ pages });
    await expect(t.run(payload())).rejects.toBeInstanceOf(JobError);
    await expect(t.run(payload())).rejects.toBeInstanceOf(JobError);
    expect(t.fanout()).toHaveLength(1);
  });

  it('never starts a listing from a payload cursor', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) } });
    await t.run(payload({ cursor: 'p9' }));
    expect(t.calls.list).toEqual([null]);
  });

  it('caps fan-out per invocation, releases the session and continues under a session key', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `v/p${String(i).padStart(3, '0')}`);
    const t = setup({ pages: { '': page(names, null) }, existing: (batch) => [...batch] });
    expect(FANOUT_PER_INVOCATION).toBe(100);

    await t.run(payload());
    expect(t.fanout()).toHaveLength(100);
    expect(t.finalizes).toEqual([]);
    expect(t.calls.release).toBe(1);
    expect(t.continuations()).toHaveLength(1);
    const [first] = t.continuations();
    expect(first?.resourceKey).toBe('source:src');
    expect(first?.payload).toEqual({ sourceId: 'src', reason: 'poll' });
    expect(first?.idempotencyKey).toBe(sha(['sess-1', 1, t.state.session!.pagesSoFar]));

    await t.run(payload());
    expect(t.fanout()).toHaveLength(200);
    expect(t.finalizes).toEqual([]);
    expect(t.continuations()).toHaveLength(2);
    expect(t.continuations()[1]?.idempotencyKey).not.toBe(first?.idempotencyKey);

    await t.run(payload());
    expect(t.fanout()).toHaveLength(250);
    expect(new Set(t.fanout().map((e) => e.payload['key'])).size).toBe(250);
    expect(t.finalizes).toHaveLength(1);
    expect(t.finalizes[0]?.expectedCount).toBe(250);
    expect(t.calls.open).toBe(1);
    expect(t.polls).toHaveLength(1);
  });

  it('finalizes an empty complete listing with a zero count and never marks', async () => {
    const t = setup({ pages: { '': page([], null) } });
    await t.run(payload());
    expect(t.marks).toEqual([]);
    expect(t.finalizes[0]).toMatchObject({ expectedCount: 0, attemptedCandidates: 0 });
    expect(t.polls).toEqual([{ id: 'src', outcome: 'success', listingHash: SNAP.id }]);
  });

  it('keeps going when one package sync cannot be enqueued', async () => {
    const t = setup({
      pages: { '': page(['a/one', 'a/bad', 'a/three'], null) },
      existing: (names) => [...names],
      enqueueError: (_type, p) =>
        p['key'] === 'a/bad' ? new JobError('invalid_payload') : undefined,
    });
    await t.run(payload());
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/one', 'a/three']);
    expect(t.marks.flatMap((m) => [...m.present])).toEqual(['a/one', 'a/bad', 'a/three']);
    expect(t.finalizes).toHaveLength(1);
  });

  it('propagates an infrastructure failure from enqueue instead of finalizing', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      enqueueError: () => new Error('database unavailable'),
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.finalizes).toEqual([]);
  });
});

describe('source sync job: never removes on an incomplete or untrusted listing', () => {
  const cases: [string, Pages, string][] = [
    [
      'the snapshot changes between pages',
      { '': page(['a/one'], 'p2'), p2: page(['a/two'], null, snapshotRef('"listing-2"')) },
      'invalid_response',
    ],
    [
      'a page claims to be last yet links onward',
      { '': { names: ['a/one'], next: 'p2', last: true, snapshot: SNAP } },
      'invalid_response',
    ],
    [
      'a page is not last and has no next cursor',
      { '': { names: ['a/one'], next: null, last: false, snapshot: SNAP } },
      'invalid_response',
    ],
    [
      'a page links to itself',
      { '': page(['a/one'], 'p2'), p2: page(['a/two'], 'p2') },
      'invalid_response',
    ],
  ];
  for (const [title, pages, code] of cases) {
    it(`does not finalize when ${title}`, async () => {
      const t = setup({ pages, existing: (names) => [...names] });
      await t.run(payload()).catch(() => undefined);
      expect(t.finalizes).toEqual([]);
      expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: code }]);
      expect(t.calls.abandon).toBe(1);
    });
  }

  it('does not finalize when a listed name is not a valid package key, but still fans out the others', async () => {
    const t = setup({
      pages: { '': page(['a/one', 'Bad/Name', ''], null) },
      existing: (names) => [...names],
    });
    await t.run(payload());
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/one']);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('carries the invalid-name flag across invocations', async () => {
    const names = [
      'Bad/Name',
      ...Array.from({ length: 150 }, (_, i) => `v/p${String(i).padStart(3, '0')}`),
    ];
    const t = setup({ pages: { '': page(names, null) }, existing: (batch) => [...batch] });
    await t.run(payload());
    await t.run(payload());
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('abandons without removing when the finalizer reports a count mismatch', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      existing: (names) => [...names],
      finalize: () => ({ status: 'refused', reason: 'count_mismatch' }),
    });
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toHaveLength(1);
    expect(t.calls.abandon).toBe(1);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('does not report poll success when the finalizer refuses for mass absence', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      finalize: () => ({ status: 'refused', reason: 'mass_absence' }),
    });
    await t.run(payload()).catch(() => undefined);
    expect(t.polls.every((p) => (p as { outcome: string }).outcome === 'failure')).toBe(true);
  });

  it('records mass_absence as the poll error when the finalizer refuses for it', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      finalize: () => ({ status: 'refused', reason: 'mass_absence' }),
    });
    await t.run(payload()).catch(() => undefined);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'mass_absence' }]);
    expect(t.calls.abandon).toBe(1);
  });

  it('finalizes on the database count when a retry marked nothing new and the counter is short', async () => {
    const t = setup({
      pages: { '': page(['a/one', 'a/two'], null) },
      existing: (names) => [names[0] as string],
      marked: 2,
    });
    await t.run(payload());
    expect(t.finalizes[0]).toMatchObject({ expectedCount: 2, successfulCandidates: 2 });
    expect(t.state.session?.seenCount).toBe(1);
  });

  it('does not finalize and retries when the marked count cannot be read', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) }, marked: Number.NaN });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.finalizes).toEqual([]);
  });

  it('does not report poll success when the session was superseded', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      finalize: () => ({ status: 'refused', reason: 'superseded' }),
    });
    await expect(t.run(payload())).rejects.toBeInstanceOf(JobError);
    expect(t.polls).toEqual([]);
  });

  it('fails without a listing when the provider has no listPackages', async () => {
    const t = setup({ noListing: true });
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'internal' }]);
  });

  it('does nothing for a missing, paused or hosted source', async () => {
    for (const source of [
      null,
      record({ status: 'paused' }),
      record({ type: 'hosted', status: 'active' }),
    ]) {
      const t = setup({ source });
      await t.run(payload());
      expect(t.calls.list).toEqual([]);
      expect(t.enqueued).toEqual([]);
      expect(t.polls).toEqual([]);
    }
  });

  it('throws for a retry when another holder owns the listing and writes nothing', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) } });
    t.state.lease = true;
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.calls.list).toEqual([]);
    expect(t.enqueued).toEqual([]);
    expect(t.polls).toEqual([]);
  });

  it('finalizes a fully consumed resumed session without listing again', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) }, existing: (names) => [...names] });
    t.state.generation = 1;
    t.state.session = {
      id: 'sess-1',
      scopeKey: 'scope',
      owner: 'o',
      fence: 1,
      leaseSeconds: 60,
      generation: 1,
      stamp: STAMP,
      snapshotId: SNAP.id,
      snapshotBlobSha256: null,
      cursor: JSON.stringify({ c: null, o: 0, d: 1 }),
      seenCount: 5,
      pagesSoFar: 3,
      pendingValidators: null,
    };
    await t.run(payload());
    expect(t.calls.list).toEqual([]);
    expect(t.finalizes[0]?.expectedCount).toBe(5);
  });

  it('abandons a resumed session whose cursor cannot be read', async () => {
    const t = setup({ pages: { '': page(['a/one'], null) } });
    t.state.generation = 1;
    t.state.session = {
      id: 'sess-1',
      scopeKey: 'scope',
      owner: 'o',
      fence: 1,
      leaseSeconds: 60,
      generation: 1,
      stamp: STAMP,
      snapshotId: SNAP.id,
      snapshotBlobSha256: null,
      cursor: 'not json',
      seenCount: 1,
      pagesSoFar: 1,
      pendingValidators: null,
    };
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([]);
    expect(t.calls.abandon).toBe(1);
  });
});

describe('source sync job: non-enumerable Composer repositories', () => {
  it('continues held refreshes after selected candidates exhaust the invocation budget', async () => {
    const candidates = Array.from({ length: FANOUT_PER_INVOCATION }, (_, i) => `a/p${i}`);
    const t = setup({
      pages: { '': repositoryListing(page([], null), { candidates, enumerable: false }) },
      held: { '': { keys: ['a/held'], next: null } },
    });
    await t.run(payload());
    expect(t.fanout()).toHaveLength(FANOUT_PER_INVOCATION);
    expect(t.calls.held).toBe(0);
    expect(t.polls).toEqual([]);
    await t.run(t.continuations()[0]?.payload);
    expect(t.calls.list).toEqual([null]);
    expect(t.fanout().at(-1)?.payload['key']).toBe('a/held');
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'success' }]);
  });

  it('records held refresh failures without publishing a successful poll', async () => {
    const t = setup({
      pages: { '': repositoryListing(page([], null), { candidates: [], enumerable: false }) },
      heldError: true,
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'internal' }]);
  });

  it('refreshes selected candidates and stale held names, paging held names without relisting', async () => {
    const t = setup({
      pages: {
        '': repositoryListing(page([], null), { candidates: ['a/selected'], enumerable: false }),
      },
      held: {
        '': { keys: ['a/held'], next: 'a/held' },
        'a/held': { keys: ['a/last'], next: null },
      },
    });
    await t.run(payload(), 'poll-1');
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/selected', 'a/held']);
    expect(t.polls).toEqual([]);
    const next = t.continuations()[0];
    expect(next?.payload).toMatchObject({ cursor: 'a/held', generation: expect.any(String) });
    await t.run(next?.payload, 'continuation');
    expect(t.calls.list).toEqual([null]);
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/selected', 'a/held', 'a/last']);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'success' }]);
    await t.run(payload(), 'poll-2');
    expect(t.fanout().map((e) => e.payload['key'])).toEqual([
      'a/selected',
      'a/held',
      'a/last',
      'a/selected',
      'a/held',
    ]);
  });
});

describe('source sync job: proxy sources', () => {
  for (const type of ['packagist_proxy', 'npmjs_proxy', 'npm_registry'] as const) {
    it(`${type} refreshes only held packages and never lists or finalizes`, async () => {
      const t = setup({
        source: record({ type, ecosystem: type === 'packagist_proxy' ? 'composer' : 'npm' }),
        held: { '': { keys: ['a/one', 'a/two'], next: null } },
      });
      await t.run(payload());
      expect(t.calls.list).toEqual([]);
      expect(t.calls.open).toBe(0);
      expect(t.finalizes).toEqual([]);
      expect(t.fanout().map((e) => e.payload)).toEqual([
        { sourceId: 'src', key: 'a/one' },
        { sourceId: 'src', key: 'a/two' },
      ]);
      expect(t.polls).toEqual([{ id: 'src', outcome: 'success' }]);
    });
  }

  it('pages through held packages with a continuation that carries the generation', async () => {
    const t = setup({
      source: record({ type: 'packagist_proxy' }),
      held: {
        '': { keys: ['a/one'], next: 'a/one' },
        'a/one': { keys: ['a/two'], next: null },
      },
    });
    await t.run(payload(), 'poll-1');
    expect(t.polls).toEqual([]);
    const [next] = t.continuations();
    expect(next?.payload).toMatchObject({ sourceId: 'src', reason: 'poll', cursor: 'a/one' });
    expect(next?.payload['generation']).toMatch(/^[0-9a-f]{64}$/);
    expect(next?.resourceKey).toBe('source:src');
    await t.run(next?.payload, 'other-key');
    expect(t.fanout().map((e) => e.payload['key'])).toEqual(['a/one', 'a/two']);
    expect(new Set(t.fanout().map((e) => e.idempotencyKey)).size).toBe(2);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'success' }]);
  });

  it('uses a different generation for each poll so held packages refresh every time', async () => {
    const t = setup({
      source: record({ type: 'npmjs_proxy', ecosystem: 'npm' }),
      held: { '': { keys: ['a/one'], next: null } },
    });
    await t.run(payload(), 'poll-1');
    await t.run(payload(), 'poll-2');
    expect(new Set(t.fanout().map((e) => e.idempotencyKey)).size).toBe(2);
  });

  it('records a failure and no success when reading held packages fails', async () => {
    const t = setup({ source: record({ type: 'packagist_proxy' }), heldError: true });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'internal' }]);
    expect(JSON.stringify(t.polls)).not.toContain(SECRET);
  });
});

describe('source sync job: credentials and errors', () => {
  it('hands the credential to the provider only and keeps its plaintext out of everything captured', async () => {
    const t = setup({
      source: record({ credentialId: 'cred' }),
      pages: { '': page(['a/one'], 'p2'), p2: new Error(`upstream said ${SECRET}`) },
    });
    let thrown: unknown;
    try {
      await t.run(payload());
    } catch (error) {
      thrown = error;
    }
    expect(t.credentialSeen[0]).toBeDefined();
    expect(thrown).toBeInstanceOf(JobError);
    const text = JSON.stringify([
      t.enqueued,
      t.logs,
      t.polls,
      t.marks,
      t.finalizes,
      String(thrown),
      (thrown as Error).stack,
      (thrown as Error).message,
    ]);
    expect(text).not.toContain(SECRET);
    expect(jobErrorCode(thrown)).toBe('handler_error');
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'internal' }]);
  });

  it('reports credential_unavailable without echoing the failure', async () => {
    const t = setup({
      source: record({ credentialId: 'cred' }),
      credentialError: true,
      pages: { '': page(['a/one'], null) },
    });
    let thrown: unknown;
    try {
      await t.run(payload());
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify([t.polls, t.logs, String(thrown)])).not.toContain(SECRET);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'credential_unavailable' }]);
    expect(t.calls.list).toEqual([]);
  });

  const codes: [UpstreamError, string][] = [
    [new UpstreamError('http_status', 401), 'unauthorized'],
    [new UpstreamError('http_status', 403), 'unauthorized'],
    [new UpstreamError('http_status', 429), 'rate_limited'],
    [new UpstreamError('http_status', 404), 'not_found'],
    [new UpstreamError('http_status', 500), 'http_error'],
    [new UpstreamError('timeout'), 'timeout'],
    [new UpstreamError('network'), 'network'],
    [new UpstreamError('too_large'), 'too_large'],
    [new UpstreamError('refused'), 'policy_denied'],
  ];
  for (const [error, code] of codes) {
    it(`maps ${error.code} ${String(error.status ?? '')} to ${code}`, async () => {
      const t = setup({ pages: { '': error } });
      await expect(t.run(payload())).rejects.toBeInstanceOf(JobError);
      expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: code }]);
      expect(t.finalizes).toEqual([]);
    });
  }

  it('stops with an abort code and no poll failure when the job is aborted', async () => {
    const controller = new AbortController();
    const t = setup({
      signal: controller.signal,
      pages: { '': page(['a/one'], null) },
      listPackages: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'aborted' });
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([]);
  });
});

describe('source sync job: fix round 1', () => {
  it('refuses to finalize when most existing rows are unseen (mass removal) and reports the evidence', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      existing: (names) => [...names],
      unseen: 9,
      finalize: (input) =>
        input.definitiveAbsent / input.attemptedCandidates > 0.25
          ? { status: 'refused', reason: 'mass_absence' }
          : { status: 'complete', empty: false, validatorsPublished: 0, leaseHeldBack: 0 },
    });
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([
      {
        expectedCount: 1,
        attemptedCandidates: 10,
        successfulCandidates: 1,
        definitiveAbsent: 9,
        upstreamComplete: true,
        validatorTtlSeconds: 0,
      },
    ]);
    expect(t.polls.every((p) => (p as { outcome: string }).outcome === 'failure')).toBe(true);
    expect(t.calls.abandon).toBe(1);
  });

  it('does not finalize and retries when the unseen count cannot be read', async () => {
    const t = setup({
      pages: { '': page(['a/one'], null) },
      unseen: new Error(`db ${SECRET}`),
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.finalizes).toEqual([]);
    expect(JSON.stringify(t.polls)).not.toContain(SECRET);
    expect(t.calls.abandon).toBe(0);
  });

  it('never lists anonymously when a credentialed source yields no credential', async () => {
    const t = setup({
      source: record({ credentialId: 'cred' }),
      credentialNull: true,
      pages: { '': page(['a/one'], null) },
    });
    await expect(t.run(payload())).rejects.toMatchObject({ code: 'handler_error' });
    expect(t.calls.list).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'credential_unavailable' }]);
  });

  it('abandons without finalizing when a page that spans invocations changes between fetches', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `v/p${String(i).padStart(3, '0')}`);
    const pages: Pages = { '': page(names, null) };
    const t = setup({ pages, existing: (batch) => [...batch] });
    await t.run(payload());
    pages[''] = page([...names.slice(0, 149), 'v/changed'], null);
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([]);
    expect(t.calls.abandon).toBe(1);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('fails closed when the cursor would exceed its size cap', async () => {
    const t = setup({ pages: { '': page(['a/one'], 'n'.repeat(5000)) } });
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('fails closed at the session page cap', async () => {
    const t = setup({ pages: { '': page(['a/one'], 'p2'), p2: page(['a/two'], null) } });
    t.state.generation = 1;
    t.state.session = {
      id: 'sess-1',
      scopeKey: 'scope',
      owner: 'o',
      fence: 1,
      leaseSeconds: 60,
      generation: 1,
      stamp: STAMP,
      snapshotId: SNAP.id,
      snapshotBlobSha256: null,
      cursor: JSON.stringify({ c: 'p2', o: 0 }),
      seenCount: 1,
      pagesSoFar: 10_000,
      pendingValidators: null,
    };
    await t.run(payload()).catch(() => undefined);
    expect(t.calls.list).toEqual([]);
    expect(t.finalizes).toEqual([]);
    expect(t.polls).toEqual([{ id: 'src', outcome: 'failure', error: 'invalid_response' }]);
  });

  it('abandons when the listing snapshot changes on a resumed session', async () => {
    const t = setup({ pages: { p2: page(['a/two'], null, snapshotRef('"other"')) } });
    t.state.generation = 1;
    t.state.session = {
      id: 'sess-1',
      scopeKey: 'scope',
      owner: 'o',
      fence: 1,
      leaseSeconds: 60,
      generation: 1,
      stamp: STAMP,
      snapshotId: SNAP.id,
      snapshotBlobSha256: null,
      cursor: JSON.stringify({ c: 'p2', o: 0 }),
      seenCount: 1,
      pagesSoFar: 1,
      pendingValidators: null,
    };
    await t.run(payload()).catch(() => undefined);
    expect(t.finalizes).toEqual([]);
    expect(t.calls.abandon).toBe(1);
  });
});

describe('built-in Composer repository listing evidence', () => {
  it('keeps non-enumerable availability safe across fan-out continuations', async () => {
    const confirmed = 'acme/present';
    const candidates = Array.from({ length: FANOUT_PER_INVOCATION + 1 }, (_, i) => `acme/p${i}`);
    const listing = repositoryListing(page([confirmed], null), {
      candidates,
      enumerable: false,
    });
    const h = setup({ pages: { '': listing }, existing: (names) => [...names], unseen: 1 });
    await h.run(payload());
    expect(h.fanout()).toHaveLength(FANOUT_PER_INVOCATION);
    expect(h.finalizes).toEqual([]);
    expect(h.continuations()).toHaveLength(1);
    await h.run(h.continuations()[0]!.payload);
    expect(h.fanout()).toHaveLength(candidates.length + 1);
    expect(h.marks.flatMap((mark) => mark.present)).toEqual([confirmed]);
    expect(h.finalizes).toEqual([]);
    expect(h.calls.abandon).toBe(1);
    expect(h.polls).toEqual([{ id: 'src', outcome: 'success' }]);
  });

  it('dispatches unconfirmed candidates but stamps only upstream names for enumerable availability', async () => {
    const listing = repositoryListing(page(['acme/present'], null), {
      candidates: ['acme/missing'],
      enumerable: true,
    });
    const h = setup({ pages: { '': listing }, existing: (names) => [...names], unseen: 1 });
    await h.run(payload());
    expect(h.fanout().map((job) => job.payload.key)).toEqual(['acme/present', 'acme/missing']);
    expect(h.marks.flatMap((mark) => mark.present)).toEqual(['acme/present']);
    expect(h.finalizes).toEqual([
      expect.objectContaining({
        successfulCandidates: 1,
        definitiveAbsent: 1,
        upstreamComplete: true,
      }),
    ]);
  });
});
