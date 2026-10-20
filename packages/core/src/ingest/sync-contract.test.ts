import { describe, expect, it } from 'vitest';
import type { CatalogueWriteGuard, CatalogueWriter, ListingScope } from '../db/catalogue.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '../db/errors.js';
import type { OrgContext, Statement } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { jobFences } from '../platform/job-fences.js';
import { JobError, jobErrorCode, type JobContext } from '../platform/jobs.js';
import { createPolicyFetch, UpstreamError } from '../sources/policy-fetch.js';
import {
  createPackageDescription,
  snapshotRef,
  type DescribeResult,
  type DocumentValidators,
  type ListingPage,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '../sources/provider.js';
import { createOutboundPolicy } from '../sources/url-policy.js';
import type { SourceRecord } from '../db/source.js';
import { applyChunk, type ApplyDeps } from './apply-description.js';
import { ComposerV1PackageError } from './composer/v1-package.js';
import {
  describeComposerV2,
  type ComposerV2Candidate,
  type ComposerV2Options,
} from './composer/v2-package.js';
import { assertFinalizeAllowed, FinalizeEvidenceError } from './finalize-guard.js';
import { MassAbsenceError } from './absence-guard.js';
import type { IngestFinalizeInput, IngestFinalizeResult, IngestFinalizer } from './finalize.js';
import { NpmPackumentError } from './npm/packument.js';
import { createPackageSyncJob, type PackageSyncDeps } from './package-sync-job.js';
import type { PackageSyncPayload } from './on-demand.js';
import type {
  IngestScopeRef,
  IngestSessionHandle,
  IngestSessionProgress,
  IngestSessions,
  IngestSessionRelease,
} from './session.js';
import { createSourceSyncJob, type SourceSyncDeps } from './source-sync-job.js';
import { parsePendingValidators } from './validators.js';

const ORG = { orgId: 'org' } as unknown as OrgContext;
const NAME = 'acme/widget';
const SRC = 'src';

type Status = 'active' | 'removed_upstream';
interface Row {
  name: string;
  status: Status;
  stamp: string | null;
  json: string;
}
interface Sess {
  id: string;
  scopeKey: string;
  generation: number;
  fence: number;
  stamp: string | null;
  snapshotId: string | null;
  cursor: string | null;
  seen: number;
  pages: number;
  pending: Record<string, unknown> | null;
  state: 'running' | 'complete' | 'abandoned';
  held: boolean;
}

/**
 * In-memory catalogue and session store with the guard, fence and finalize semantics the jobs
 * rely on: only a complete finalize moves a row to removed_upstream or back to active.
 */
class Model {
  packages = new Map<string, Row>();
  versions = new Map<string, Map<string, Row>>();
  sessions: Sess[] = [];
  published = new Map<string, DocumentValidators>();
  finalizes: IngestFinalizeInput[] = [];
  marks: { stamp: string; fence: number }[] = [];
  absent: string[] = [];
  touches: string[] = [];
  opens = 0;
  rejected = 0;
  polls: { outcome: string; error?: string }[] = [];
  jobFence = 1;
  private counter = 0;

  seedPackages(names: readonly string[]): void {
    for (const name of names) {
      this.packages.set(name, { name, status: 'active', stamp: 'seed', json: '' });
    }
  }

  statuses(): Record<string, Status> {
    return Object.fromEntries([...this.packages.values()].map((row) => [row.name, row.status]));
  }

  versionStatuses(key = NAME): Record<string, Status> {
    return Object.fromEntries(
      [...(this.versions.get(key)?.values() ?? [])].map((row) => [row.name, row.status]),
    );
  }

  newest(scope: IngestScopeRef): Sess | undefined {
    const key = JSON.stringify(scope);
    return this.sessions.filter((s) => s.scopeKey === key).at(-1);
  }

  expire(scope: IngestScopeRef): void {
    const found = this.newest(scope);
    if (found !== undefined) found.held = false;
  }

  private handle(s: Sess): IngestSessionHandle {
    return {
      id: s.id,
      scopeKey: s.scopeKey,
      owner: 'owner',
      fence: s.fence,
      leaseSeconds: 60,
      generation: s.generation,
      stamp: s.stamp,
      snapshotId: s.snapshotId,
      snapshotBlobSha256: null,
      cursor: s.cursor,
      seenCount: s.seen,
      pagesSoFar: s.pages,
      pendingValidators: s.pending,
    };
  }

  private live(h: { id: string; fence: number }): Sess | undefined {
    const found = this.sessions.find((s) => s.id === h.id);
    return found?.state === 'running' && found.fence === h.fence ? found : undefined;
  }

  guard(h: IngestSessionHandle): CatalogueWriteGuard {
    return [{ sql: 'guard', params: [h.id, h.fence] }] as unknown as CatalogueWriteGuard;
  }

  private check(guard: readonly Statement[]): Sess {
    const [id, fence] = guard[0]!.params as [string, number];
    const found = this.live({ id, fence });
    if (found === undefined) {
      this.rejected += 1;
      throw new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT });
    }
    return found;
  }

  rows(scope: ListingScope | IngestScopeRef): Map<string, Row> {
    if ('kind' in scope) {
      return scope.kind === 'source'
        ? this.packages
        : (this.versions.get(scope.packageId) ?? new Map());
    }
    return scope.scope === 'source'
      ? this.packages
      : (this.versions.get(scope.packageKey) ?? new Map());
  }

  readonly sessionPort: IngestSessions & IngestSessionRelease = {
    acquire: async (_ctx, scope) => {
      const key = JSON.stringify(scope);
      const current = this.newest(scope);
      if (current?.state === 'running') {
        if (current.held) return 'held';
        current.fence += 1;
        current.held = true;
        return this.handle(current);
      }
      const created: Sess = {
        id: `sess-${String((this.counter += 1))}`,
        scopeKey: key,
        generation: (current?.generation ?? 0) + 1,
        fence: 1,
        stamp: null,
        snapshotId: null,
        cursor: null,
        seen: 0,
        pages: 0,
        pending: null,
        state: 'running',
        held: true,
      };
      this.sessions.push(created);
      return this.handle(created);
    },
    start: async (_ctx, h, input) => {
      const s = this.live(h);
      if (s === undefined || s.stamp !== null) return false;
      s.stamp = input.stamp;
      s.snapshotId = input.snapshot.id;
      return true;
    },
    advance: async (_ctx, h, input, writeGuard): Promise<IngestSessionProgress | null> => {
      const s = this.live(h);
      if (s === undefined) return null;
      if (writeGuard !== undefined && this.live(this.idOf(writeGuard)) === undefined) return null;
      s.cursor = input.cursor;
      s.seen += input.addSeen;
      s.pages += 1;
      return { seenCount: s.seen, pagesSoFar: s.pages };
    },
    setPendingValidators: async (_ctx, h, validators) => {
      const s = this.live(h);
      if (s === undefined) return false;
      s.pending = validators as Record<string, unknown> | null;
      return true;
    },
    abandon: async (_ctx, h) => {
      const s = this.live(h);
      if (s === undefined) return false;
      s.state = 'abandoned';
      s.held = false;
      return true;
    },
    release: async (_ctx, h) => {
      const s = this.live(h);
      if (s === undefined) return false;
      s.held = false;
      return true;
    },
    discard: async () => false,
    latest: async (_ctx, scope) => {
      const s = this.newest(scope);
      return s === undefined
        ? null
        : {
            id: s.id,
            state: s.state,
            generation: s.generation,
            fence: s.fence,
            seenCount: s.seen,
            pagesSoFar: s.pages,
          };
    },
  };

  private idOf(guard: readonly Statement[]): { id: string; fence: number } {
    const [id, fence] = guard[0]!.params as [string, number];
    return { id, fence };
  }

  readonly writer = {
    statementBudget: {
      syncPackage: 500,
      attachDist: 4,
      openListing: 3,
      markListing: 5,
      finalizeListing: 13,
      quarantine: 5,
      markPackageAbsent: 8,
    },
    syncPackageCost: (shape: { versions: number; tags: number; guardStatements: number }) =>
      3 * shape.guardStatements + 13 + 4 * shape.versions + 2 * shape.tags,
    syncPayloadLimit: 10_000_000,
    syncPayloadBytes: () => 1,
    syncPackage: async (
      _ctx: OrgContext,
      guard: readonly Statement[],
      input: {
        key: string;
        versions: readonly {
          versionNormalized: string;
          version: string;
          metadata: { json: string };
        }[];
      },
    ) => {
      this.check(guard);
      if (!this.packages.has(input.key)) {
        this.packages.set(input.key, { name: input.key, status: 'active', stamp: null, json: '' });
      }
      const rows = this.versions.get(input.key) ?? new Map<string, Row>();
      this.versions.set(input.key, rows);
      for (const v of input.versions) {
        const held = rows.get(v.versionNormalized);
        rows.set(v.versionNormalized, {
          name: v.version,
          status: held?.status ?? 'active',
          stamp: held?.stamp ?? null,
          json: v.metadata.json,
        });
      }
      return {
        packageId: input.key,
        inserted: input.versions.length,
        updated: 0,
        unchanged: 0,
        conflicts: [],
        refused: [],
        skippedTags: [],
        statements: 1 + input.versions.length,
      };
    },
    openListing: async (_ctx: OrgContext, guard: readonly Statement[]) => {
      this.check(guard);
      this.opens += 1;
      return { stamp: `stamp-${String((this.counter += 1))}` };
    },
    markListing: async (
      _ctx: OrgContext,
      guard: readonly Statement[],
      input: { scope: ListingScope; stamp: string; present: readonly string[] },
    ) => {
      const s = this.check(guard);
      const rows = this.rows(input.scope);
      for (const key of input.present) {
        const row = rows.get(key);
        if (row !== undefined) row.stamp = input.stamp;
      }
      this.marks.push({ stamp: input.stamp, fence: s.fence });
      return { changed: true, marked: input.present.length, statements: 1 };
    },
    markPackageAbsent: async (
      _ctx: OrgContext,
      guard: readonly Statement[],
      input: { packageId: string },
    ) => {
      this.check(guard);
      this.absent.push(input.packageId);
      return { changed: true, statements: 1 };
    },
  } as unknown as CatalogueWriter;

  readonly finalizer: IngestFinalizer = {
    finalize: async (_ctx, h, input, guard): Promise<IngestFinalizeResult> => {
      if (guard !== undefined) this.check(guard);
      const s = this.live(h);
      if (s === undefined) return { status: 'refused', reason: 'superseded' };
      const scope = JSON.parse(s.scopeKey) as IngestScopeRef;
      const rows = this.rows(scope);
      const marked = [...rows.values()].filter((row) => row.stamp === s.stamp);
      if (marked.length !== input.expectedCount) {
        return { status: 'refused', reason: 'count_mismatch' };
      }
      try {
        assertFinalizeAllowed(input.expectedCount, input);
      } catch (error) {
        if (error instanceof MassAbsenceError) return { status: 'refused', reason: 'mass_absence' };
        if (error instanceof FinalizeEvidenceError)
          return { status: 'refused', reason: error.reason };
        throw error;
      }
      for (const row of rows.values()) {
        if (row.stamp === s.stamp) row.status = 'active';
        else if (row.status === 'active') row.status = 'removed_upstream';
      }
      if (scope.scope === 'package' && s.pending !== null) {
        const next: Record<string, { etag?: string; lastModified?: string }> = {};
        for (const [form, v] of Object.entries(parsePendingValidators(s.pending))) {
          next[form] = {
            ...(v.etag === null ? {} : { etag: v.etag }),
            ...(v.lastModified === null ? {} : { lastModified: v.lastModified }),
          };
        }
        this.published.set(scope.packageKey, next as DocumentValidators);
      }
      s.state = 'complete';
      s.held = false;
      this.finalizes.push(input);
      return { status: 'complete', empty: input.expectedCount === 0, validatorsPublished: 0 };
    },
  };
}

interface Enqueued {
  type: string;
  payload: Record<string, unknown>;
}

function jobContext(model: Model, queue: Enqueued[], fence: number, tag: string): JobContext {
  const seen = new Set<string>();
  model.jobFence = fence;
  return {
    org: ORG,
    jobId: `job-${tag}`,
    idempotencyKey: `key-${tag}`,
    attempt: 1,
    fence,
    fences: jobFences({ id: `job-${tag}`, owner: 'owner', fence }),
    signal: new AbortController().signal,
    ports: {
      clock: { now: () => new Date('2026-10-20T10:00:00.000Z') },
      platform: {
        jobs: {
          async enqueue(
            _c: OrgContext,
            type: string,
            payload: unknown,
            input: { idempotencyKey: string },
          ) {
            const key = `${type}:${input.idempotencyKey}`;
            const created = !seen.has(key);
            seen.add(key);
            if (created) queue.push({ type, payload: payload as Record<string, unknown> });
            return { id: 'job', created };
          },
        },
      },
    },
    observability: { log: () => {}, counter: () => {}, histogram: () => {} },
  } as unknown as JobContext;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}

async function attempt(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error ?? new Error('rejected');
  }
}

function sourceRecord(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: SRC,
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
    ...over,
  };
}

const names = (letters: string) => [...letters].map((letter) => `acme/${letter}`);
const page = (list: string[], next: string | null, snapshot = '"listing-1"'): ListingPage => ({
  names: list,
  next,
  last: next === null,
  snapshot: snapshotRef(snapshot),
});

type PageStep = ListingPage | Error | (() => Promise<ListingPage>);

function sourceRig(
  model: Model,
  pages: Record<string, PageStep>,
  over: Partial<SourceRecord> = {},
) {
  const queue: Enqueued[] = [];
  const listed: (string | null)[] = [];
  const provider: SourceProvider = {
    id: 'p',
    sourceTypes: ['composer_repository'],
    ecosystems: ['composer'],
    listPackages: async (_ctx: ProviderContext, _source: ProviderSource, cursor: string | null) => {
      listed.push(cursor);
      const step = pages[cursor ?? ''];
      if (step === undefined) throw new Error('no such page');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    },
    describe: async () => ({ kind: 'not_found', definitive: false }),
    openDist: async () => {
      throw new Error('unused');
    },
  };
  const deps: SourceSyncDeps = {
    sources: {
      get: async () => sourceRecord(over),
      pollState: async (_ctx, guard, input) => {
        if (guard.fence !== model.jobFence) return 'stale';
        model.polls.push({
          outcome: input.outcome,
          ...(input.outcome === 'failure' ? { error: input.error } : {}),
        });
        return 'written';
      },
    },
    providers: { forSource: () => provider },
    toProviderSource: (r) => ({ id: r.id, ecosystem: r.ecosystem, url: r.url }) as ProviderSource,
    loadCredential: async () => null,
    providerContext: (job) =>
      ({ org: job.org, credential: null, signal: job.signal }) as unknown as ProviderContext,
    sessions: model.sessionPort,
    writer: model.writer,
    finalizer: model.finalizer,
    writeGuard: (_ctx, session) => model.guard(session),
    jobGuard: (job) => ({ id: job.jobId, owner: 'owner', fence: job.fence }),
    markedCount: async (_c, _s, stamp) =>
      [...model.packages.values()].filter((row) => row.stamp === stamp).length,
    unseenExistingCount: async (_c, _s, stamp) =>
      [...model.packages.values()].filter((row) => row.status === 'active' && row.stamp !== stamp)
        .length,
    existingKeys: async (_c, _s, wanted) =>
      new Set(wanted.filter((key) => model.packages.has(key))),
    staleHeldKeys: async () => ({ keys: [], next: null }),
  };
  const definition = createSourceSyncJob(deps);
  let runs = 0;
  return {
    queue,
    listed,
    run: (payload: Record<string, unknown> = {}, fence = 1) =>
      definition.handler(
        definition.validate({ sourceId: SRC, reason: 'poll', ...payload }),
        jobContext(model, queue, fence, `src-${String((runs += 1))}`),
      ),
  };
}

const SCOPE: IngestScopeRef = { scope: 'source', sourceId: SRC };
const ALL = 'abcdefgh';

describe('source listing: faults never remove', () => {
  const faults: [string, () => Error, string | null][] = [
    ['timeout', () => new UpstreamError('timeout'), 'timeout'],
    ['500', () => new UpstreamError('http_status', 500), 'http_error'],
    ['451 repository', () => new UpstreamError('http_status', 451), 'http_error'],
    ['network drop', () => new UpstreamError('network'), 'network'],
    ['truncated JSON', () => new SyntaxError('Unexpected end of JSON input'), null],
    ['include hash mismatch', () => new ComposerV1PackageError('hash'), null],
  ];

  it.each(faults)(
    '%s on a later page leaves every row, retries and never finalizes',
    async (_n, fault, code) => {
      const model = new Model();
      model.seedPackages(names(ALL));
      const rig = sourceRig(model, {
        '': page(names('abc'), 'p2'),
        p2: page(names('def'), 'p3'),
        p3: fault(),
      });
      const error = await attempt(rig.run());
      expect(error).toBeInstanceOf(JobError);
      expect(model.statuses()).toEqual(Object.fromEntries(names(ALL).map((n) => [n, 'active'])));
      expect(model.finalizes).toEqual([]);
      expect(model.polls).toHaveLength(1);
      expect(model.polls[0]).toMatchObject({ outcome: 'failure' });
      if (code !== null) expect(model.polls[0]?.error).toBe(code);
      expect(model.newest(SCOPE)?.state).toBe('running');
    },
  );

  it('a snapshot change between pages abandons the session without removal', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    const rig = sourceRig(model, {
      '': page(names('abc'), 'p2'),
      p2: page(names('defg'), null, '"listing-2"'),
    });
    expect(await attempt(rig.run())).toBeInstanceOf(JobError);
    expect(Object.values(model.statuses()).every((s) => s === 'active')).toBe(true);
    expect(model.finalizes).toEqual([]);
    expect(model.newest(SCOPE)?.state).toBe('abandoned');
  });

  it('a retry after an abandoned session starts a new generation and can then remove', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    const first = sourceRig(model, {
      '': page(names('abc'), 'p2'),
      p2: page(names('defg'), null, '"listing-2"'),
    });
    await attempt(first.run());
    const second = sourceRig(model, { '': page(names('abcdefg'), null) });
    await second.run();
    expect(model.newest(SCOPE)).toMatchObject({ generation: 2, state: 'complete' });
    expect(model.statuses()['acme/h']).toBe('removed_upstream');
  });
});

describe('source listing: complete listings', () => {
  it('marks an absent package removed_upstream and restores it when it reappears', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    await sourceRig(model, { '': page(names('abc'), 'p2'), p2: page(names('defg'), null) }).run();
    expect(model.statuses()['acme/h']).toBe('removed_upstream');
    expect(Object.values(model.statuses()).filter((s) => s === 'active')).toHaveLength(7);
    expect(model.polls).toEqual([{ outcome: 'success' }]);

    await sourceRig(model, { '': page(names(ALL), null) }).run();
    expect(model.statuses()['acme/h']).toBe('active');
    expect(model.newest(SCOPE)).toMatchObject({ generation: 2, state: 'complete' });
  });

  it('refuses a listing that would remove more than a quarter of the source', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    const error = await attempt(sourceRig(model, { '': page(names('abcde'), null) }).run());
    expect(error).toBeUndefined();
    expect(Object.values(model.statuses()).every((s) => s === 'active')).toBe(true);
    expect(model.polls).toEqual([{ outcome: 'failure', error: 'mass_absence' }]);
    expect(model.newest(SCOPE)?.state).toBe('abandoned');
  });

  it('removes exactly a quarter of the source', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    await sourceRig(model, { '': page(names('abcdef'), null) }).run();
    expect(model.statuses()['acme/g']).toBe('removed_upstream');
    expect(model.statuses()['acme/h']).toBe('removed_upstream');
  });
});

describe('source listing: sessions', () => {
  it('resumes the cursor after an isolate restart', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    const pages: Record<string, PageStep> = {
      '': page(names('abcd'), 'p2'),
      p2: new UpstreamError('timeout'),
    };
    const first = sourceRig(model, pages);
    expect(await attempt(first.run())).toBeInstanceOf(JobError);
    const before = model.newest(SCOPE)!;
    expect(before.cursor).not.toBeNull();

    pages['p2'] = page(names('efg'), null);
    const second = sourceRig(model, pages);
    await second.run();
    expect(second.listed).toEqual(['p2']);
    expect(model.opens).toBe(1);
    expect(model.newest(SCOPE)).toMatchObject({ generation: 1, state: 'complete' });
    expect(model.statuses()['acme/h']).toBe('removed_upstream');
  });

  it('applies nothing from a holder that lost the session to a takeover', async () => {
    const model = new Model();
    model.seedPackages(names(ALL));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pages: Record<string, PageStep> = {
      '': page(names('abcd'), 'p2'),
      p2: async () => {
        await gate;
        return page(names('efg'), null);
      },
    };
    const stale = sourceRig(model, pages);
    const running = attempt(stale.run({}, 1));
    await until(() => stale.listed.length === 2);
    expect(stale.listed).toEqual([null, 'p2']);

    model.expire(SCOPE);
    pages['p2'] = page(names('efg'), null);
    const taker = sourceRig(model, pages);
    await taker.run({}, 2);
    expect(model.newest(SCOPE)).toMatchObject({ fence: 2, state: 'complete' });
    const applied = model.marks.length;
    const finalized = model.finalizes.length;

    release();
    expect(await running).toMatchObject({ code: 'handler_error' });
    expect(model.marks).toHaveLength(applied);
    expect(model.finalizes).toHaveLength(finalized);
    expect(model.rejected).toBeGreaterThan(0);
    expect(model.polls).toEqual([{ outcome: 'success' }]);
    expect(model.statuses()['acme/h']).toBe('removed_upstream');
  });
});

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const ORIGIN = 'https://repo.example.com';
const root = {
  mode: 'v2',
  packagesJsonUrl: `${ORIGIN}/packages.json`,
  metadataUrl: `${ORIGIN}/p2/%package%.json`,
  inlineProviders: false,
  partialPackages: false,
  inlinePackages: false,
  validator: { sha256: 'a'.repeat(64) },
  messages: [],
  mirrors: [],
} as const;

type Reply = { etag: string; body: string } | { status: number; body?: string } | 'hang';

const doc = (versions: string[], etag: string): { etag: string; body: string } => ({
  etag,
  body: JSON.stringify({
    packages: {
      [NAME]: versions.map((version) => ({
        name: NAME,
        version,
        dist: { type: 'zip', url: `https://dl.example.com/${NAME}/${version}.zip`, reference: 'r' },
      })),
    },
  }),
});
const range = (count: number, drop = 0) =>
  Array.from({ length: count - drop }, (_, i) => `1.0.${String(i + drop)}`);

class Server {
  stable: Reply = doc(['1.1.0', '1.0.0'], '"s1"');
  dev: Reply = doc(['dev-main'], '"d1"');
  calls: { form: 'stable' | 'dev'; conditional: boolean }[] = [];
  gated = 0;
  gate: Promise<void> = Promise.resolve();

  readonly fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = String(request?.url ?? input);
      const headers = new Headers(request?.headers ?? init?.headers);
      const form = url.includes('~dev') ? 'dev' : 'stable';
      const match = headers.get('if-none-match');
      this.calls.push({ form, conditional: match !== null });
      if (this.gated > 0) {
        this.gated -= 1;
        await this.gate;
      }
      const reply = form === 'dev' ? this.dev : this.stable;
      if (reply === 'hang') {
        const signal = request?.signal ?? init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if ('status' in reply) return new Response(reply.body ?? '', { status: reply.status });
      if (match === reply.etag) return new Response(null, { status: 304 });
      return new Response(reply.body, { status: 200, headers: { etag: reply.etag } });
    },
  });
}

type Describer = (
  options: Parameters<PackageSyncDepsPlan['describe']>[0],
  signal: AbortSignal,
) => Promise<DescribeResult>;
type PackageSyncDepsPlan = NonNullable<Awaited<ReturnType<PackageSyncDeps['planFill']>>>;

function pkgRig(model: Model, server: Server, override?: Describer, timeoutMs?: number) {
  const queue: Enqueued[] = [];
  const enqueued: Enqueued[] = [];
  const described: Parameters<Describer>[0][] = [];
  const touched: string[] = [];
  const composerDescribe: Describer = async (options, signal) => {
    const result = await describeComposerV2(
      server.fetch,
      { root, allowedOrigins: [], ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      NAME,
      {
        path: 'job',
        probe: { secrets: [], queryParams: [] },
        clock: fixedClock('2026-10-20T10:00:00.000Z'),
        dev: true,
        signal,
        ...(options.validators === undefined ? {} : { validators: options.validators }),
      } satisfies ComposerV2Options,
    );
    if (result.kind === 'busy') throw new UpstreamError('http_status', 429);
    return result;
  };
  const plan = (describe: Describer): PackageSyncDepsPlan => ({
    source: {
      id: SRC,
      key: NAME,
      type: 'composer_repository',
      ecosystem: 'composer',
      covered: true,
    },
    describe: async (options, signal) => {
      described.push(options);
      return describe(options, signal);
    },
    toVersion: (candidate) => (candidate as ComposerV2Candidate).input,
    packageDescription: null,
    validatorTtlSeconds: 300,
    publishedValidators: model.published.get(NAME) ?? {},
  });
  const apply: ApplyDeps = {
    writer: model.writer,
    sessions: model.sessionPort,
    finalizer: model.finalizer,
    existing: {
      existingVersions: async (_ctx, query) => ({
        rows: [...(model.versions.get(query.packageId)?.entries() ?? [])]
          .filter(([key]) => query.keys === undefined || query.keys.includes(key))
          .map(([key, row]) => ({
            versionNormalized: key,
            id: key,
            revision: 1,
            status: row.status,
            npmIntegrity: null,
            composerShasum: null,
            ...(query.withMetadata ? { metadataJson: row.json } : {}),
          })),
        next: null,
      }),
    },
  };
  const deps: PackageSyncDeps = {
    sessions: model.sessionPort,
    apply,
    jobs: {
      enqueue: async (_c: OrgContext, type: string, payload: unknown) => {
        const entry = { type, payload: payload as Record<string, unknown> };
        queue.push(entry);
        enqueued.push(entry);
        return { id: 'job', created: true };
      },
    },
    upstreamState: {
      touchStatements: (_c, id) => {
        touched.push(id);
        model.touches.push(id);
        return [];
      },
      notFoundStatements: () => [],
      resetNotFoundStatements: () => [],
    },
    executor: {
      batch: async (statements: readonly Statement[]) => {
        const [id, fence] = statements[0]!.params as [string, number];
        const found = model.sessions.find((s) => s.id === id);
        if (found?.state !== 'running' || found.fence !== fence) {
          model.rejected += 1;
          throw new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT });
        }
        return [];
      },
    },
    sourceMetadata: async () => ({ type: 'composer_repository' as const }),
    planFill: async () => plan(override ?? composerDescribe),
    findPackageId: async (_c, _s, key) => (model.packages.has(key) ? key : null),
    writeGuard: (_ctx, session) => model.guard(session),
    clock: { now: () => new Date('2026-10-20T10:00:00.000Z') },
  };
  const definition = createPackageSyncJob(deps);
  let runs = 0;
  const run = (payload: PackageSyncPayload = { sourceId: SRC, key: NAME }, fence = 1) =>
    definition.handler(
      definition.validate(payload),
      jobContext(model, queue, fence, `pkg-${String((runs += 1))}`),
    );
  const drive = async (limit = 80): Promise<unknown[]> => {
    const errors: unknown[] = [];
    const first = await attempt(run());
    if (first !== undefined) errors.push(first);
    for (let i = 0; i < limit && queue.length > 0; i += 1) {
      const next = queue.shift()!;
      const error = await attempt(run(next.payload as unknown as PackageSyncPayload));
      if (error !== undefined) errors.push(error);
    }
    return errors;
  };
  return { queue, enqueued, run, drive, described, touched, plan, apply, deps, composerDescribe };
}

const allActive = (model: Model) =>
  Object.values(model.versionStatuses()).every((status) => status === 'active');

async function seeded(over: { stable?: Reply; dev?: Reply } = {}) {
  const model = new Model();
  const server = new Server();
  if (over.stable !== undefined) server.stable = over.stable;
  if (over.dev !== undefined) server.dev = over.dev;
  const errors = await pkgRig(model, server).drive();
  expect(errors).toEqual([]);
  return { model, server };
}

describe('package sync: provider faults never remove and never drop the job', () => {
  const faults: [string, (s: Server) => void, (Describer | undefined)?, (number | undefined)?][] = [
    ['timeout mid-document', (s) => void (s.stable = 'hang'), undefined, 5],
    ['500 on the stable document', (s) => void (s.stable = { status: 500 })],
    ['500 on the dev document', (s) => void (s.dev = { status: 500 })],
    ['451 repository', (s) => void (s.stable = { status: 451 })],
    [
      'truncated JSON',
      (s) => {
        const reply = doc(['9.9.9', '1.1.0'], '"s9"');
        s.stable = { etag: '"s9"', body: reply.body.slice(0, 60) };
      },
    ],
    [
      'one version over the metadata cap',
      (s) => {
        s.stable = {
          etag: '"s9"',
          body: JSON.stringify({
            packages: {
              [NAME]: [
                {
                  name: NAME,
                  version: '1.1.0',
                  description: 'x'.repeat(2 * 1024 * 1024),
                  dist: { type: 'zip', url: 'https://dl.example.com/a.zip', reference: 'r' },
                },
              ],
            },
          }),
        };
      },
    ],
    [
      'include hash mismatch',
      () => {},
      async () => {
        throw new ComposerV1PackageError('hash');
      },
    ],
    [
      'ETag change between packument passes',
      () => {},
      async () => {
        throw new NpmPackumentError('unstable');
      },
    ],
    [
      'a version skipped as too large',
      () => {},
      async () => ({
        kind: 'found',
        description: createPackageDescription({
          name: NAME,
          snapshot: snapshotRef('"skip"'),
          members: (async function* () {})(),
          validators: {},
          documentsComplete: true,
          skippedMembers: [{ version: '2.0.0', reason: 'member_too_large' }],
        }),
      }),
    ],
  ];

  const run = async (fault: (typeof faults)[number]) => {
    const [, break_, describe_, timeout] = fault;
    const { model, server } = await seeded();
    const before = model.versionStatuses();
    const finalized = model.finalizes.length;
    break_(server);
    const rig = pkgRig(model, server, describe_, timeout);
    const error = await attempt(rig.run());
    const newest = model.newest(pkgScope);
    expect(model.versionStatuses()).toEqual(before);
    expect(model.finalizes).toHaveLength(finalized);
    expect(model.absent).toEqual([]);
    expect(newest?.generation).toBeGreaterThan(1);
    expect(newest?.state).not.toBe('complete');
    return {
      retried: error instanceof JobError && jobErrorCode(error) === 'handler_error',
      continued: rig.enqueued.some((e) => e.type === 'core:package-sync:v1'),
      code: jobErrorCode(error),
    };
  };
  const silent = new Set([
    'truncated JSON',
    'one version over the metadata cap',
    'a version skipped as too large',
  ]);

  it.each(faults)('%s leaves every version in place', async (...fault) => {
    const kept = await run(fault);
    if (!silent.has(fault[0])) {
      expect(kept.code).toBe('handler_error');
    }
  });

  it.each(faults.filter(([name]) => silent.has(name)))(
    '%s retries or continues instead of ending the job silently',
    async (...fault) => {
      const kept = await run(fault);
      expect(kept.retried || kept.continued).toBe(true);
    },
  );
});

const pkgScope: IngestScopeRef = { scope: 'package', sourceId: SRC, packageKey: NAME };
const noDev: Reply = { status: 404, body: '{"packages":[]}' };
const stamps = (model: Model) =>
  Object.fromEntries([...(model.versions.get(NAME)?.values() ?? [])].map((r) => [r.name, r.stamp]));

describe('package sync: complete listings', () => {
  it('moves an absent version to removed_upstream and restores it on reappearance', async () => {
    const { model, server } = await seeded();
    server.stable = doc(['1.1.0'], '"s2"');
    expect(await pkgRig(model, server).drive()).toEqual([]);
    expect(model.versionStatuses()).toEqual({
      '1.1.0': 'active',
      '1.0.0': 'removed_upstream',
      'dev-main': 'active',
    });

    server.stable = doc(['1.1.0', '1.0.0'], '"s3"');
    expect(await pkgRig(model, server).drive()).toEqual([]);
    expect(allActive(model)).toBe(true);
  });
});

describe('package sync: Composer forms', () => {
  it('stable 304 with dev 200 re-reads stable and applies both forms', async () => {
    const { model, server } = await seeded();
    server.dev = doc(['dev-next'], '"d2"');
    server.calls = [];
    expect(await pkgRig(model, server).drive()).toEqual([]);
    expect(server.calls.filter((c) => c.form === 'stable').map((c) => c.conditional)).toEqual([
      true,
      false,
    ]);
    expect(model.versionStatuses()).toEqual({
      '1.1.0': 'active',
      '1.0.0': 'active',
      'dev-main': 'removed_upstream',
      'dev-next': 'active',
    });
  });

  it('stable 200 with dev 304 re-reads dev and keeps its versions', async () => {
    const { model, server } = await seeded();
    server.stable = doc(['1.1.0'], '"s2"');
    server.calls = [];
    expect(await pkgRig(model, server).drive()).toEqual([]);
    expect(server.calls.filter((c) => c.form === 'dev').map((c) => c.conditional)).toEqual([
      true,
      false,
    ]);
    expect(model.versionStatuses()).toEqual({
      '1.1.0': 'active',
      '1.0.0': 'removed_upstream',
      'dev-main': 'active',
    });
  });

  it('both 304 touches the freshness clocks and changes nothing', async () => {
    const { model, server } = await seeded();
    const before = { statuses: model.versionStatuses(), stamps: stamps(model) };
    const finalized = model.finalizes.length;
    const rig = pkgRig(model, server);
    expect(await rig.drive()).toEqual([]);
    expect(rig.touched).toEqual([NAME, NAME]);
    expect(model.finalizes).toHaveLength(finalized);
    expect(model.versionStatuses()).toEqual(before.statuses);
    expect(stamps(model)).toEqual(before.stamps);
    expect(model.newest(pkgScope)?.state).not.toBe('complete');
  });

  it('a package without a dev file stays untouched while both documents are unchanged', async () => {
    const { model, server } = await seeded({ dev: noDev });
    expect(model.versionStatuses()).toEqual({ '1.1.0': 'active', '1.0.0': 'active' });
    const rig = pkgRig(model, server);
    expect(await rig.drive()).toEqual([]);
    expect(rig.touched).toHaveLength(2);
    expect(model.versionStatuses()).toEqual({ '1.1.0': 'active', '1.0.0': 'active' });
  });

  it('a dev file that disappears removes only the dev versions', async () => {
    const { model, server } = await seeded();
    server.dev = noDev;
    expect(await pkgRig(model, server).drive()).toEqual([]);
    expect(model.versionStatuses()).toEqual({
      '1.1.0': 'active',
      '1.0.0': 'active',
      'dev-main': 'removed_upstream',
    });
  });
});

describe('package sync: sessions and fences', () => {
  it('writes nothing from a job whose session was taken over', async () => {
    const { model, server } = await seeded();
    const finalized = model.finalizes.length;
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.gated = 2;
    server.stable = doc(['1.1.0'], '"s2"');
    const stale = pkgRig(model, server);
    const running = attempt(stale.run({ sourceId: SRC, key: NAME }, 1));
    await until(() => server.calls.length >= 2);

    model.expire(pkgScope);
    expect(await pkgRig(model, server).drive()).toEqual([]);
    const taken = model.newest(pkgScope)!;
    expect(taken).toMatchObject({ fence: 2, state: 'complete' });
    const marks = model.marks.length;
    const rejected = model.rejected;
    const after = { statuses: model.versionStatuses(), stamps: stamps(model) };

    release();
    expect(await running).toMatchObject({ code: 'lease_lost' });
    expect(model.rejected).toBeGreaterThan(rejected);
    expect(model.marks).toHaveLength(marks);
    expect(model.finalizes).toHaveLength(finalized + 1);
    expect(model.versionStatuses()).toEqual(after.statuses);
    expect(stamps(model)).toEqual(after.stamps);
  });

  describe('chunked ingest', () => {
    const big = (etag: string, drop = 0) => doc(range(1200, drop), etag);
    const started = async () => {
      const { model, server } = await seeded({ stable: big('"b1"'), dev: noDev });
      expect(Object.keys(model.versionStatuses())).toHaveLength(1200);
      server.stable = big('"b2"', 1);
      server.calls = [];
      const rig = pkgRig(model, server);
      await rig.run();
      return { model, server, rig };
    };

    it('resumes the cursor after an isolate restart and never lets a 304 end the session', async () => {
      const { model, server, rig } = await started();
      const opens = model.opens;
      const session = model.newest(pkgScope)!;
      expect(rig.queue).toHaveLength(1);
      expect(session.cursor).not.toBeNull();
      expect(Object.values(model.versionStatuses()).every((s) => s === 'active')).toBe(true);

      session.held = true;
      model.expire(pkgScope);
      server.calls = [];
      while (rig.queue.length > 0) {
        await rig.run(rig.queue.shift()!.payload as unknown as PackageSyncPayload, 2);
      }
      const done = model.newest(pkgScope)!;
      expect(done).toMatchObject({ generation: 2, state: 'complete' });
      expect(done.fence).toBeGreaterThan(1);
      expect(model.opens).toBe(opens);
      expect(server.calls.length).toBeGreaterThan(0);
      expect(server.calls.every((c) => !c.conditional)).toBe(true);
      expect(
        rig.described.slice(1).every((o) => o.snapshot !== undefined && o.validators === undefined),
      ).toBe(true);
      expect(model.versionStatuses()['1.0.0']).toBe('removed_upstream');
      expect(Object.values(model.versionStatuses()).filter((s) => s === 'active')).toHaveLength(
        1199,
      );
      expect(new Set(Object.values(stamps(model)).filter((s) => s !== null)).size).toBeGreaterThan(
        0,
      );
    });

    it('abandons without removal when upstream changes between chunks', async () => {
      const { model, server, rig } = await started();
      server.stable = big('"b3"', 2);
      await rig.run(rig.queue.shift()!.payload as unknown as PackageSyncPayload);
      expect(model.newest(pkgScope)?.state).toBe('abandoned');
      expect(Object.values(model.versionStatuses()).every((s) => s === 'active')).toBe(true);
      expect(model.absent).toEqual([]);
      expect(rig.queue).toHaveLength(1);
      expect(rig.queue[0]?.payload).toEqual({ sourceId: SRC, key: NAME });

      while (rig.queue.length > 0) {
        await rig.run(rig.queue.shift()!.payload as unknown as PackageSyncPayload);
      }
      expect(model.newest(pkgScope)).toMatchObject({ generation: 3, state: 'complete' });
      expect(model.versionStatuses()['1.0.0']).toBe('removed_upstream');
      expect(model.versionStatuses()['1.0.1']).toBe('removed_upstream');
      expect(model.versionStatuses()['1.0.2']).toBe('active');
    });

    it('leaves one consistent generation when an old request fill resumes after a job finished', async () => {
      const { model, server } = await seeded({ stable: big('"b1"'), dev: noDev });
      server.stable = big('"b2"', 1);
      const rig = pkgRig(model, server);
      const plan = rig.plan(rig.composerDescribe);
      const handle = await model.sessionPort.acquire(ORG, pkgScope, 'request', 60);
      if (handle === 'held') throw new Error('held');
      const stale = await plan.describe(
        { validators: plan.publishedValidators },
        new AbortController().signal,
      );
      if (stale.kind !== 'found') throw new Error(stale.kind);
      const input = (session: IngestSessionHandle, description: typeof stale.description) => ({
        session,
        guard: model.guard(session),
        source: plan.source,
        description,
        packageDescription: null,
        toVersion: plan.toVersion,
        validatorTtlSeconds: 300,
      });
      const again = await plan.describe(
        { validators: plan.publishedValidators },
        new AbortController().signal,
      );
      if (again.kind !== 'found') throw new Error(again.kind);
      const first = await applyChunk(ORG, rig.apply, input(handle, stale.description));
      expect(first.status).toBe('progress');

      server.stable = big('"b3"', 2);
      model.expire(pkgScope);
      const job = pkgRig(model, server);
      expect(await job.drive()).toEqual([]);
      const winner = model.newest(pkgScope)!;
      expect(winner.state).toBe('complete');
      expect(winner.generation).toBe(3);
      const settled = { statuses: model.versionStatuses(), stamps: stamps(model) };
      const finalized = model.finalizes.length;

      const resumed = await applyChunk(
        ORG,
        rig.apply,
        input(first.session, again.description),
      ).then(
        (outcome) => outcome.status,
        (error: unknown) => error,
      );
      expect(resumed === 'superseded' || resumed instanceof DbError).toBe(true);
      expect(model.finalizes).toHaveLength(finalized);
      expect(model.versionStatuses()).toEqual(settled.statuses);
      expect(stamps(model)).toEqual(settled.stamps);
      const live = Object.entries(settled.statuses)
        .filter(([, status]) => status === 'active')
        .map(([version]) => settled.stamps[version]);
      expect(live).toHaveLength(1198);
      expect(new Set(live)).toEqual(new Set([winner.stamp]));
    });
  });
});
