import { describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '../catalogue/metadata.js';
import type {
  CatalogueWriteGuard,
  CatalogueWriter,
  ListingScope,
  SyncPackageInput,
  SyncResult,
  VersionInput,
} from '../db/catalogue.js';
import type { ExistingVersion, ExistingVersionsReader } from '../db/existing-versions.js';
import { orgContext } from '../db/port.js';
import type { LogRecord } from '../platform/observability.js';
import { normalizeVersion } from '../registry/composer/version-parser.js';
import {
  assertDescribeResult,
  createPackageDescription,
  snapshotRef,
  type PackageDescription,
  type SkippedMember,
  type VersionCandidate,
} from '../sources/provider.js';
import {
  APPLY_MEMBER_WINDOW,
  APPLY_WINDOW_BYTES,
  applyChunk,
  continuationOptions,
  type ApplyInput,
} from './apply-description.js';
import { JsonStreamError } from './json-tokenizer.js';
import { JsonExtractError } from './json-stream.js';
import { NpmPackumentError } from './npm/packument.js';
import { SnapshotCorruptError } from './snapshot.js';
import { INVOCATION_BUDGET } from './plan-chunk.js';
import type { IngestFinalizeInput, IngestFinalizeResult, IngestFinalizer } from './finalize.js';
import type { IngestSessionHandle, IngestSessions } from './session.js';

const ctx = orgContext('org-a');
const SNAPSHOT = '"snap-1"';
const STAMP = '2026-10-19T10:00:00.000Z';
const KEY = 'left-pad';
const INTEGRITY_A = `sha512-${'A'.repeat(86)}==`;
const INTEGRITY_B = `sha512-${'B'.repeat(86)}==`;
const guard = [{ sql: 'SELECT 1', params: [] }] as unknown as CatalogueWriteGuard;

function manifest(version: string, integrity = INTEGRITY_A): string {
  return JSON.stringify({
    name: KEY,
    version,
    dist: {
      tarball: `https://registry.example.test/${KEY}/-/${KEY}-${version}.tgz`,
      integrity,
    },
  });
}

function toVersion(candidate: VersionCandidate): VersionInput | null {
  const parsed = JSON.parse(candidate.raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') return null;
  return {
    version: parsed.version,
    versionNormalized: parsed.version,
    license: null,
    distType: 'tgz',
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('npm', parsed),
    history: { basis: 'release_date', at: '2026-10-01T00:00:00.000Z' },
  };
}

interface Fixture {
  readonly calls: string[];
  readonly syncInputs: SyncPackageInput[];
  readonly marked: string[];
  readonly finalized: IngestFinalizeInput[];
  readonly logs: LogRecord[];
  readonly advanced: { cursor: string | null; addSeen: number }[];
  abandoned: number;
  startResult: boolean;
  advanceResult: boolean;
  abandonResult: boolean;
  refuse: Set<string>;
  tombstone: Set<string>;
  skipTags: string[];
  advanceGuards: unknown[];
  existing: ExistingVersion[];
  finalizeResult: IngestFinalizeResult;
  deps: Parameters<typeof applyChunk>[1];
}

function fixture(): Fixture {
  const f: Fixture = {
    calls: [],
    syncInputs: [],
    marked: [],
    finalized: [],
    logs: [],
    advanced: [],
    abandoned: 0,
    startResult: true,
    advanceResult: true,
    abandonResult: true,
    refuse: new Set(),
    tombstone: new Set(),
    skipTags: [],
    advanceGuards: [],
    existing: [],
    finalizeResult: { status: 'complete', empty: false, validatorsPublished: 0, leaseHeldBack: 0 },
    deps: undefined as never,
  };
  const writer: CatalogueWriter = {
    async publishVersion() {
      throw new Error('not_implemented');
    },

    statementBudget: {
      publishVersion: 40,
      syncPackage: 500,
      attachDist: 4,
      openListing: 3,
      markListing: 5,
      finalizeListing: 13,
      quarantine: 5,
      markPackageAbsent: 8,
    },
    syncPackageCost: ({ versions, tags, guardStatements: g }) =>
      g * g + 11 * g + 8 + 4 * Math.max(versions, 1) + 99 * tags,
    syncPayloadLimit: 4 * 1024 * 1024,
    syncPayloadBytes: () => 1,
    syncPackage: (_ctx, _guard, input: SyncPackageInput): Promise<SyncResult> => {
      f.syncInputs.push(input);
      f.calls.push(`sync:${input.versions.map((v) => v.versionNormalized).join(',')}`);
      const refused = input.versions
        .filter((v) => f.refuse.has(v.versionNormalized) || f.tombstone.has(v.versionNormalized))
        .map((v) => ({
          version: v.version,
          reason: f.tombstone.has(v.versionNormalized)
            ? ('tombstoned' as const)
            : ('invalid' as const),
        }));
      return Promise.resolve({
        packageId: 'pkg-1',
        inserted: input.versions.length - refused.length,
        updated: 0,
        unchanged: 0,
        conflicts: [],
        refused,
        skippedTags: input.tags === undefined ? [] : f.skipTags,
        statements: 10,
      });
    },
    attachDist: () => Promise.reject(new Error('unused')),
    openListing: (_ctx, _guard, scope: ListingScope) => {
      f.calls.push(`open:${scope.kind}`);
      return Promise.resolve({ stamp: STAMP });
    },
    markListing: (_ctx, _guard, input) => {
      f.calls.push('mark');
      f.marked.push(...input.present);
      return Promise.resolve({ changed: true, marked: input.present.length, statements: 5 });
    },
    finalizeListing: () => Promise.reject(new Error('apply finalizes through the finalizer')),
    quarantine: (_ctx, _guard, input) => {
      f.calls.push(`quarantine:${input.versionId}:${input.reason}`);
      return Promise.resolve({ changed: true, statements: 5 });
    },
    markPackageAbsent: () => Promise.reject(new Error('unused')),
  };
  const sessions: IngestSessions = {
    acquire: () => Promise.reject(new Error('unused')),
    start: () => {
      f.calls.push('start');
      return Promise.resolve(f.startResult);
    },
    advance: (_ctx, held, input, writeGuard) => {
      f.advanced.push(input);
      f.advanceGuards.push(writeGuard);
      if (!f.advanceResult) return Promise.resolve(null);
      return Promise.resolve({
        seenCount: held.seenCount + input.addSeen,
        pagesSoFar: f.advanced.length,
      });
    },
    setPendingValidators: () => Promise.resolve(true),
    abandon: () => {
      f.abandoned += 1;
      return Promise.resolve(f.abandonResult);
    },
    latest: () => Promise.resolve(null),
  };
  const existing: ExistingVersionsReader = {
    existingVersions: () => Promise.resolve({ rows: f.existing, next: null }),
  };
  const finalizer: IngestFinalizer = {
    finalize: (_ctx, _session, input) => {
      f.finalized.push(input);
      return Promise.resolve(f.finalizeResult);
    },
  };
  f.deps = {
    writer,
    sessions,
    existing,
    finalizer,
    observability: { log: (record) => f.logs.push(record) },
  };
  return f;
}

function handle(overrides: Partial<IngestSessionHandle> = {}): IngestSessionHandle {
  return {
    id: 'session-1',
    scopeKey: 'k'.repeat(64),
    owner: 'owner-1',
    fence: 1,
    leaseSeconds: 60,
    generation: 1,
    stamp: null,
    snapshotId: null,
    snapshotBlobSha256: null,
    cursor: null,
    seenCount: 0,
    pagesSoFar: 0,
    pendingValidators: null,
    ...overrides,
  };
}

function description(
  versions: readonly string[],
  options: {
    snapshot?: string;
    skipped?: readonly SkippedMember[];
    raw?: (version: string) => string;
  } = {},
) {
  const raw = options.raw ?? manifest;
  return createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(options.snapshot ?? SNAPSHOT),
    validators: {},
    members: (async function* () {
      for (const [ordinal, version] of versions.entries()) {
        await Promise.resolve();
        yield { ordinal, version, form: 'npm-full', raw: raw(version) } as VersionCandidate;
      }
    })(),
    documentsComplete: true,
    ...(options.skipped === undefined ? {} : { skippedMembers: options.skipped }),
  });
}

function input(session: IngestSessionHandle, desc = description(['1.0.0'])): ApplyInput {
  return {
    session,
    guard,
    source: { id: 'source-1', key: KEY, type: 'npm_registry', ecosystem: 'npm', covered: true },
    description: desc,
    packageDescription: null,
    toVersion,
    validatorTtlSeconds: 300,
  };
}

const continued = (cursor: object, overrides: Partial<IngestSessionHandle> = {}) =>
  handle({
    stamp: STAMP,
    snapshotId: SNAPSHOT,
    cursor: JSON.stringify(cursor),
    ...overrides,
  });

describe('continuationOptions', () => {
  it('describes a running session by its snapshot, never by published validators', () => {
    const published = { 'npm-full': { etag: '"published"' } };
    const blob = 'c'.repeat(64);
    const options = continuationOptions(
      handle({ stamp: STAMP, snapshotId: SNAPSHOT, snapshotBlobSha256: blob }),
      published,
    );
    expect(options).toEqual({ snapshot: { id: SNAPSHOT, stagedBlob: blob } });
    expect(options.validators).toBeUndefined();
    expect(() => assertDescribeResult(options, { kind: 'not_modified' })).toThrow(TypeError);
  });

  it('sends the published validators only when no snapshot is recorded', () => {
    const published = { 'npm-full': { etag: '"published"' } };
    expect(continuationOptions(handle(), published)).toEqual({ validators: published });
  });
});

describe('applyChunk', () => {
  it('starts a generation: upsert, open, start, write, mark, advance and finalize', async () => {
    const f = fixture();
    const outcome = await applyChunk(ctx, f.deps, input(handle(), description(['1.0.0', '1.0.1'])));
    expect(f.calls).toEqual(['sync:', 'open:package', 'start', 'sync:1.0.0,1.0.1', 'mark']);
    expect(f.marked).toEqual(['1.0.0', '1.0.1']);
    expect(f.finalized).toEqual([
      {
        expectedCount: 2,
        attemptedCandidates: 2,
        successfulCandidates: 2,
        definitiveAbsent: 0,
        upstreamComplete: true,
        validatorTtlSeconds: 300,
      },
    ]);
    expect(outcome).toMatchObject({ done: true, status: 'complete' });
    expect(outcome.session).toMatchObject({ stamp: STAMP, snapshotId: SNAPSHOT, seenCount: 2 });
    expect(JSON.parse(outcome.cursor ?? 'null')).toEqual({
      packageId: 'pkg-1',
      ordinal: 1,
      attempted: 2,
      tail: 'finalize',
    });
  });

  it('abandons the session on a changed snapshot and removes nothing', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: null }),
        description(['1.0.0', '1.0.1'], { snapshot: '"snap-2"' }),
      ),
    );
    expect(outcome).toMatchObject({ done: true, status: 'abandoned' });
    expect(f.abandoned).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.finalized).toEqual([]);
    expect(f.advanced).toEqual([]);
  });

  it('continues after the cursor ordinal without upserting again', async () => {
    const f = fixture();
    await applyChunk(
      ctx,
      f.deps,
      input(
        continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: null }, { seenCount: 1 }),
        description(['1.0.0', '1.0.1']),
      ),
    );
    expect(f.calls).toEqual(['sync:1.0.1', 'mark']);
    expect(f.finalized[0]).toMatchObject({ attemptedCandidates: 2 });
  });

  it('never marks keys the writer refused or the converter could not read', async () => {
    const f = fixture();
    f.refuse.add('1.0.1');
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        handle(),
        description(['1.0.0', '1.0.1', 'broken', '1.0.2'], {
          raw: (v) => (v === 'broken' ? '{}' : manifest(v)),
        }),
      ),
    );
    expect(f.marked).toEqual(['1.0.0', '1.0.2']);
    expect(f.advanced.at(-1)?.addSeen).toBe(2);
    expect(f.finalized).toEqual([]);
    expect(f.abandoned).toBe(1);
    expect(outcome).toMatchObject({ done: true, status: 'incomplete' });
    expect(outcome.refused).toEqual([
      { version: '1.0.1', reason: 'invalid' },
      { version: 'broken', reason: 'unreadable' },
    ]);
  });

  it('quarantines an npm integrity conflict with digest_mismatch and marks it present', async () => {
    const f = fixture();
    f.existing = [
      {
        versionNormalized: '1.0.0',
        id: 'ver-1',
        revision: 1,
        status: 'active',
        npmIntegrity: INTEGRITY_B,
        composerShasum: null,
        metadataJson: manifest('1.0.0', INTEGRITY_B),
      },
    ];
    await applyChunk(ctx, f.deps, input(handle(), description(['1.0.0'])));
    expect(f.calls).toContain('quarantine:ver-1:digest_mismatch');
    expect(f.marked).toEqual(['1.0.0']);
  });

  it('refuses a name outside the registered names before any write', async () => {
    const f = fixture();
    const outcome = await applyChunk(ctx, f.deps, {
      ...input(handle()),
      source: { id: 'source-1', key: KEY, type: 'npm_registry', ecosystem: 'npm', covered: false },
    });
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'name_not_registered' });
    expect(f.calls).toEqual([]);
  });

  it('records skipped members, writes the rest and never finalizes', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        handle(),
        description(['1.0.0'], { skipped: [{ version: '2.0.0', reason: 'member_too_large' }] }),
      ),
    );
    expect(f.marked).toEqual(['1.0.0']);
    expect(f.finalized).toEqual([]);
    expect(f.abandoned).toBe(1);
    expect(outcome).toMatchObject({
      done: true,
      status: 'incomplete',
      skipped: [{ version: '2.0.0', reason: 'member_too_large' }],
    });
    expect(f.logs).toEqual([
      { level: 'info', event: 'ingest.version_skipped', reason_code: 'member_too_large' },
    ]);
    expect(JSON.stringify(f.logs)).not.toContain('2.0.0');
  });

  it('returns a finalize refusal and leaves the session running', async () => {
    const f = fixture();
    f.finalizeResult = { status: 'refused', reason: 'session_unavailable' };
    const outcome = await applyChunk(ctx, f.deps, input(handle()));
    expect(outcome).toMatchObject({
      done: false,
      status: 'refused',
      refusal: 'session_unavailable',
    });
    expect(f.abandoned).toBe(0);
  });

  it('retries finalize from a tail cursor without rewriting members', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        continued(
          { packageId: 'pkg-1', ordinal: 1, attempted: 2, tail: 'finalize' },
          { seenCount: 2 },
        ),
        description(['1.0.0', '1.0.1']),
      ),
    );
    expect(f.calls).toEqual([]);
    expect(f.finalized[0]).toMatchObject({ expectedCount: 2, attemptedCandidates: 2 });
    expect(outcome.status).toBe('complete');
  });

  it('writes dist-tags in their own zero-version call before finalize', async () => {
    const f = fixture();
    const desc = createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      distTags: { latest: '1.0.0' },
      members: (async function* () {
        await Promise.resolve();
        yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
      })(),
      documentsComplete: true,
    });
    await applyChunk(ctx, f.deps, input(handle(), desc));
    expect(f.calls.slice(-2)).toEqual(['mark', 'sync:']);
    expect(f.finalized).toHaveLength(1);
  });
});

function tagged(versions: readonly string[], tagCount: number) {
  return createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(SNAPSHOT),
    validators: {},
    distTags: Object.fromEntries(
      Array.from({ length: tagCount }, (_, n) => [`tag${n}`, versions[0] ?? '1.0.0']),
    ),
    members: (async function* () {
      for (const [ordinal, version] of versions.entries()) {
        await Promise.resolve();
        yield { ordinal, version, form: 'npm-full', raw: manifest(version) } as VersionCandidate;
      }
    })(),
    documentsComplete: true,
  });
}

const tail = (stage: 'tags' | 'finalize') =>
  continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: stage }, { seenCount: 1 });

describe('applyChunk fails closed', () => {
  it.each(['count_mismatch', 'mass_absence', 'no_package'] as const)(
    'abandons the session on the deterministic finalize refusal %s',
    async (reason) => {
      const f = fixture();
      f.finalizeResult = { status: 'refused', reason };
      const outcome = await applyChunk(ctx, f.deps, input(handle()));
      expect(f.abandoned).toBe(1);
      expect(outcome).toMatchObject({ done: true, status: 'refused', refusal: reason });
    },
  );

  it('abandons the session for a name outside the registered names', async () => {
    const f = fixture();
    const outcome = await applyChunk(ctx, f.deps, {
      ...input(handle()),
      source: { id: 'source-1', key: KEY, type: 'npm_registry', ecosystem: 'npm', covered: false },
    });
    expect(f.abandoned).toBe(1);
    expect(outcome).toMatchObject({ done: true, refusal: 'name_not_registered' });
  });

  it('reports superseded when the abandon finds the session gone', async () => {
    const f = fixture();
    f.abandonResult = false;
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: null }),
        description(['1.0.0'], { snapshot: '"snap-2"' }),
      ),
    );
    expect(outcome).toMatchObject({ done: true, status: 'superseded' });
  });

  it('never finalizes an incomplete upstream without skipped members', async () => {
    const f = fixture();
    const desc = createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      members: (async function* () {
        await Promise.resolve();
        yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
      })(),
      documentsComplete: false,
    });
    const outcome = await applyChunk(ctx, f.deps, input(handle(), desc));
    expect(f.marked).toEqual(['1.0.0']);
    expect(f.finalized).toEqual([]);
    expect(f.abandoned).toBe(1);
    expect(outcome).toMatchObject({ done: true, status: 'incomplete', skipped: [] });
  });

  it('ignores a later Composer duplicate by normalized version and still finalizes', async () => {
    const f = fixture();
    const composer = (candidate: VersionCandidate): VersionInput => ({
      ...(toVersion(candidate) as VersionInput),
      versionNormalized: normalizeVersion(candidate.version),
      metadata: normalizeVersionMetadata('composer', {
        name: 'acme/lib',
        version: candidate.version,
      }),
    });
    const outcome = await applyChunk(ctx, f.deps, {
      ...input(handle(), description(['v1.0.0', '1.0.0'])),
      source: {
        id: 'source-1',
        key: 'acme/lib',
        type: 'composer_repository',
        ecosystem: 'composer',
        covered: true,
      },
      toVersion: composer,
    });
    expect(f.calls).toContain('sync:1.0.0.0');
    expect(f.marked).toEqual(['1.0.0.0']);
    expect(f.advanced.at(-1)?.addSeen).toBe(1);
    expect(f.finalized[0]).toMatchObject({
      expectedCount: 1,
      attemptedCandidates: 1,
      successfulCandidates: 1,
    });
    expect(outcome).toMatchObject({
      status: 'complete',
      refused: [],
      duplicates: [{ version: '1.0.0', ordinal: 1 }],
    });
  });

  it('ignores a key applied by an earlier invocation as a duplicate', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: null }, { seenCount: 1 }),
        description(['1.0.0', '1.0.0']),
      ),
    );
    expect(f.calls).toEqual([]);
    expect(f.finalized[0]).toMatchObject({ expectedCount: 1, attemptedCandidates: 1 });
    expect(outcome).toMatchObject({
      status: 'complete',
      duplicates: [{ version: '1.0.0', ordinal: 1 }],
    });
  });

  it('abandons the session when member ordinals do not strictly increase', async () => {
    const f = fixture();
    const desc = {
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      upstreamComplete: true,
      skippedMembers: [],
      members: (async function* () {
        await Promise.resolve();
        yield { ordinal: 1, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
        yield { ordinal: 1, version: '1.0.1', form: 'npm-full', raw: manifest('1.0.1') } as const;
      })(),
    } as unknown as PackageDescription;
    await expect(applyChunk(ctx, f.deps, input(handle(), desc))).resolves.toMatchObject({
      done: true,
      status: 'refused',
      refusal: 'snapshot_corrupt',
    });
    expect(f.abandoned).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.advanced).toEqual([]);
    expect(f.finalized).toEqual([]);
  });
});

describe('apply failure classes and observability', () => {
  const failing = (error: Error) =>
    createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        await Promise.resolve();
        yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
        throw error;
      })(),
    });

  it.each([new Error('blob read failed'), new TypeError('converter bug')])(
    'rethrows %s without abandoning the generation or logging corruption',
    async (error) => {
      const f = fixture();
      await expect(applyChunk(ctx, f.deps, input(handle(), failing(error)))).rejects.toBe(error);
      expect(f.abandoned).toBe(0);
      expect(f.calls).toEqual([]);
      expect(f.logs.map((l) => l.event)).not.toContain('ingest.snapshot_corrupt');
    },
  );

  it('rethrows a converter failure without abandoning', async () => {
    const f = fixture();
    const error = new Error('converter bug');
    await expect(
      applyChunk(ctx, f.deps, {
        ...input(handle(), description(['1.0.0'])),
        toVersion: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(f.abandoned).toBe(0);
  });

  it('logs budget exhaustion with the package key, source id and ordinal', async () => {
    const f = fixture();
    const writer = {
      ...f.deps.writer,
      statementBudget: { ...f.deps.writer.statementBudget, markListing: 1000 },
    };
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, writer },
      input(handle(), description(['1.0.0'])),
    );
    expect(outcome).toMatchObject({ done: true, refusal: 'budget_exhausted' });
    expect(f.logs).toContainEqual(
      expect.objectContaining({
        event: 'ingest.budget_exhausted',
        reason_code: 'budget_exhausted',
        package_key: KEY,
        source_id: 'source-1',
        seq: 0,
      }),
    );
  });

  it('restarts tag publication when the cursor offset exceeds the tag count', async () => {
    const f = fixture();
    const session = continued(
      { packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: 'tags', tagOffset: 99 },
      { seenCount: 1 },
    );
    const outcome = await applyChunk(ctx, f.deps, input(session, tagged(['1.0.0'], 3)));
    expect(outcome).toMatchObject({ done: true, status: 'complete' });
    expect(f.finalized).toHaveLength(1);
    expect(f.syncInputs.map((i) => Object.keys(i.tags ?? {}))).toEqual([['tag0', 'tag1', 'tag2']]);
  });
});

describe('applyChunk tail and recovery', () => {
  it('defers dist-tags to the next invocation when they do not fit', async () => {
    const f = fixture();
    const outcome = await applyChunk(ctx, f.deps, input(handle(), tagged(['1.0.0'], 4)));
    expect(f.calls.at(-1)).toBe('mark');
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({ done: false, status: 'progress' });
    expect(JSON.parse(outcome.cursor ?? 'null')).toMatchObject({ tail: 'tags' });

    const next = fixture();
    const resumed = await applyChunk(ctx, next.deps, input(outcome.session, tagged(['1.0.0'], 4)));
    expect(next.calls).toEqual(['sync:']);
    expect(resumed).toMatchObject({ status: 'complete', tagsSkipped: false });
  });

  it('splits dist-tags that cannot fit an empty invocation', async () => {
    const f = fixture();
    const outcome = await applyChunk(ctx, f.deps, input(tail('tags'), tagged(['1.0.0'], 5)));
    expect(f.calls).toEqual(['sync:']);
    expect(outcome).toMatchObject({ done: false, status: 'progress', tagsSkipped: false });
    expect(JSON.parse(outcome.cursor ?? 'null')).toMatchObject({ tail: 'tags', tagOffset: 4 });
    expect(f.finalized).toEqual([]);
    expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);

    const next = fixture();
    const resumed = await applyChunk(ctx, next.deps, input(outcome.session, tagged(['1.0.0'], 5)));
    expect(next.calls).toEqual(['sync:']);
    expect(resumed).toMatchObject({ done: true, status: 'complete', tagsSkipped: false });
    expect(next.finalized).toHaveLength(1);
    expect(resumed.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
    const names = ['tag0', 'tag1', 'tag2', 'tag3', 'tag4'];
    expect(f.syncInputs.map((i) => Object.keys(i.tags ?? {}))).toEqual([names.slice(0, 4)]);
    expect(next.syncInputs.map((i) => Object.keys(i.tags ?? {}))).toEqual([['tag4']]);
    expect(f.syncInputs[0]?.tagNames).toEqual(names);
    expect(next.syncInputs[0]?.tagNames).toEqual(names);
  });

  it('leaves finalize for the next invocation when its cost does not fit', async () => {
    const f = fixture();
    const writer = {
      ...f.deps.writer,
      statementBudget: { ...f.deps.writer.statementBudget, finalizeListing: 40 },
    };
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, writer },
      input(tail('tags'), tagged(['1.0.0'], 4)),
    );
    expect(f.calls).toEqual(['sync:']);
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({ done: false, status: 'progress' });
    expect(JSON.parse(outcome.cursor ?? 'null')).toMatchObject({ tail: 'finalize' });
  });

  it('recovers the package after a crash between start and the first advance', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(handle({ stamp: STAMP, snapshotId: SNAPSHOT }), description(['1.0.0'])),
    );
    expect(f.calls).toEqual(['sync:', 'sync:1.0.0', 'mark']);
    expect(outcome.status).toBe('complete');
  });

  it('stops as superseded when start is refused', async () => {
    const f = fixture();
    f.startResult = false;
    const outcome = await applyChunk(ctx, f.deps, input(handle()));
    expect(f.calls).toEqual(['sync:', 'open:package', 'start']);
    expect(outcome).toMatchObject({ done: true, status: 'superseded' });
  });

  it('stops as superseded when advance finds the lease gone', async () => {
    const f = fixture();
    f.advanceResult = false;
    const outcome = await applyChunk(ctx, f.deps, input(handle()));
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({ done: true, status: 'superseded' });
  });
});

describe('applyChunk statement accounting', () => {
  it('keeps every invocation of an incomplete description within the budget, abandon included', async () => {
    for (let count = 1; count <= 160; count++) {
      const f = fixture();
      const versions = Array.from({ length: count }, (_, n) => `1.0.${n}`);
      const describeIncomplete = () =>
        createPackageDescription({
          name: KEY,
          snapshot: snapshotRef(SNAPSHOT),
          validators: {},
          members: (async function* () {
            for (const [ordinal, version] of versions.entries()) {
              await Promise.resolve();
              yield { ordinal, version, form: 'npm-full', raw: manifest(version) } as const;
            }
          })(),
          documentsComplete: false,
        });
      let session = handle();
      for (let invocation = 0; invocation < 20; invocation++) {
        const outcome = await applyChunk(ctx, f.deps, input(session, describeIncomplete()));
        expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
        if (outcome.done) {
          expect(outcome.status).toBe('incomplete');
          if (count === 1) expect(outcome.planned).toBe(47);
          break;
        }
        session = outcome.session;
      }
      expect(f.abandoned).toBe(1);
    }
  });
});

describe('applyChunk refusal accounting', () => {
  it('counts a tombstoned refusal as successful, marks it and finalizes', async () => {
    const f = fixture();
    f.tombstone.add('1.0.1');
    const outcome = await applyChunk(ctx, f.deps, input(handle(), description(['1.0.0', '1.0.1'])));
    expect(f.marked).toEqual(['1.0.0', '1.0.1']);
    expect(f.finalized[0]).toMatchObject({
      expectedCount: 2,
      attemptedCandidates: 2,
      successfulCandidates: 2,
    });
    expect(outcome).toMatchObject({
      status: 'complete',
      refused: [{ version: '1.0.1', reason: 'tombstoned' }],
    });
  });

  it('names refusals from earlier invocations when it abandons as incomplete', async () => {
    const f = fixture();
    const outcome = await applyChunk(
      ctx,
      f.deps,
      input(
        continued({ packageId: 'pkg-1', ordinal: 2, attempted: 3, tail: null }, { seenCount: 1 }),
        description(['1.0.0', '1.0.1', '1.0.2', '1.0.3']),
      ),
    );
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({
      done: true,
      status: 'incomplete',
      refused: [],
      refusal: 'refused_members',
      refusedMembers: 2,
    });
  });
});

describe('applyChunk bounds and guards', () => {
  it('drains beyond the member window before writing and discards the remaining payloads', async () => {
    const f = fixture();
    let drained = false;
    let converted = 0;
    const desc = createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        for (let ordinal = 0; ordinal < APPLY_MEMBER_WINDOW + 2; ordinal++) {
          expect(f.calls).toEqual([]);
          const version = `1.0.${ordinal}`;
          yield { ordinal, version, form: 'npm-full', raw: manifest(version) } as const;
        }
        drained = true;
      })(),
    });
    const outcome = await applyChunk(ctx, f.deps, {
      ...input(handle(), desc),
      toVersion: (candidate) => {
        converted++;
        return toVersion(candidate);
      },
    });
    expect(drained).toBe(true);
    expect(converted).toBe(APPLY_MEMBER_WINDOW);
    expect(outcome.status).toBe('progress');
  });

  it.each([
    handle(),
    handle({ stamp: STAMP, snapshotId: SNAPSHOT }),
    continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: null }),
    continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: 'tags' }),
    continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: 'finalize' }),
  ])('abandons a corrupt pass before any writes for session %j', async (session) => {
    const f = fixture();
    const desc = createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        for (let ordinal = 0; ordinal < APPLY_MEMBER_WINDOW + 2; ordinal++) {
          const version = `1.0.${ordinal}`;
          yield { ordinal, version, form: 'npm-full', raw: manifest(version) } as const;
        }
        throw new SnapshotCorruptError();
      })(),
    });
    expect(await applyChunk(ctx, f.deps, input(session, desc))).toMatchObject({
      done: true,
      status: 'refused',
      refusal: 'snapshot_corrupt',
      planned: 1,
    });
    expect(f.calls).toEqual([]);
    expect(f.advanced).toEqual([]);
    expect(f.finalized).toEqual([]);
    expect(f.abandoned).toBe(1);
  });

  it('still verifies EOF after exceeding the byte window', async () => {
    const f = fixture();
    let converted = 0;
    const large = 'x'.repeat(200 * 1024);
    const desc = createPackageDescription({
      name: KEY,
      snapshot: snapshotRef(SNAPSHOT),
      validators: {},
      documentsComplete: true,
      members: (async function* () {
        for (let ordinal = 0; ordinal < 100; ordinal++) {
          const version = `1.0.${ordinal}`;
          yield { ordinal, version, form: 'npm-full', raw: manifest(version) } as const;
        }
        throw new SnapshotCorruptError();
      })(),
    });
    const outcome = await applyChunk(ctx, f.deps, {
      ...input(handle(), desc),
      toVersion: (candidate) => {
        converted++;
        const version = toVersion(candidate) as VersionInput;
        return {
          ...version,
          metadata: normalizeVersionMetadata('npm', {
            version: candidate.version,
            description: large,
          }),
        };
      },
    });
    expect(converted).toBe(41);
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'snapshot_corrupt' });
    expect(f.calls).toEqual([]);
    expect(f.abandoned).toBe(1);
  });

  it('bounds the retained metadata of one window by bytes, admitting at least one member', async () => {
    const f = fixture();
    const big = 'x'.repeat(200 * 1024);
    const raw = (version: string) =>
      JSON.stringify({ ...JSON.parse(manifest(version)), description: big });
    const versions = Array.from({ length: 200 }, (_, n) => `1.0.${n}`);
    f.existing = versions.map((version, n) => ({
      versionNormalized: version,
      id: `ver-${n}`,
      revision: 1,
      status: 'active',
      npmIntegrity: INTEGRITY_A,
      composerShasum: null,
      metadataJson: (
        toVersion({
          ordinal: n,
          version,
          form: 'npm-full',
          raw: raw(version),
        }) as VersionInput
      ).metadata.json,
    }));
    const outcome = await applyChunk(ctx, f.deps, input(handle(), description(versions, { raw })));
    const attempted = (JSON.parse(outcome.cursor ?? 'null') as { attempted: number }).attempted;
    expect(attempted).toBeGreaterThanOrEqual(1);
    const retainedPerMember = 4 * big.length;
    expect(attempted * retainedPerMember).toBeLessThanOrEqual(
      APPLY_WINDOW_BYTES + retainedPerMember,
    );
    expect((attempted + 1) * retainedPerMember).toBeGreaterThan(APPLY_WINDOW_BYTES);
    expect(attempted).toBeLessThan(versions.length);
    expect(outcome.status).toBe('progress');

    const one = fixture();
    const huge = 'y'.repeat(APPLY_WINDOW_BYTES + 1);
    const single = await applyChunk(
      ctx,
      one.deps,
      input(
        handle(),
        description(['1.0.0'], {
          raw: (version) => JSON.stringify({ ...JSON.parse(manifest(version)), readme: huge }),
        }),
      ),
    );
    expect(one.marked).toEqual(['1.0.0']);
    expect(single.status).toBe('complete');
  });

  it('advances the session under the caller guard', async () => {
    const f = fixture();
    await applyChunk(ctx, f.deps, input(handle()));
    expect(f.advanceGuards).toEqual([guard]);
  });

  it('reports dist-tags the writer skipped', async () => {
    const f = fixture();
    f.skipTags = ['beta'];
    const outcome = await applyChunk(ctx, f.deps, input(handle(), tagged(['1.0.0'], 1)));
    expect(outcome).toMatchObject({ status: 'complete', skippedTags: ['beta'] });
  });
});

describe('applyChunk writer payload', () => {
  it('refuses a member whose own writer payload exceeds the limit and never finalizes', async () => {
    const f = fixture();
    const writer = {
      ...f.deps.writer,
      syncPayloadLimit: 1000,
      syncPayloadBytes: (_ctx: unknown, _guard: unknown, input: { version: VersionInput }) =>
        input.version.versionNormalized === '1.0.1' ? 1001 : 10,
    } as CatalogueWriter;
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, writer },
      input(handle(), description(['1.0.0', '1.0.1'])),
    );
    expect(f.calls).toContain('sync:1.0.0');
    expect(f.marked).toEqual(['1.0.0']);
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({
      done: true,
      status: 'incomplete',
      refused: [{ version: '1.0.1', reason: 'payload_too_large' }],
    });
  });
});

it('makes bounded progress when old manifests require one metadata read per row', async () => {
  const f = fixture();
  const versions = Array.from({ length: 1000 }, (_, n) => `1.0.${String(n).padStart(4, '0')}`);
  const stored = new Map(
    versions.map((version) => [
      version,
      {
        versionNormalized: version,
        id: `v-${version}`,
        revision: 1,
        status: 'active',
        npmIntegrity: INTEGRITY_A,
        composerShasum: null,
        metadataJson: manifest(version),
      },
    ]),
  );
  let reads = 0;
  const existing: ExistingVersionsReader = {
    existingVersions: async (_ctx, query) => {
      reads++;
      const keys = [...(query.keys ?? [])].sort();
      if (!query.withMetadata)
        return {
          rows: keys.map((key) => {
            const row: ExistingVersion = { ...stored.get(key)! };
            const keyOnly = {
              versionNormalized: row.versionNormalized,
              id: row.id,
              revision: row.revision,
              status: row.status,
              npmIntegrity: row.npmIntegrity,
              composerShasum: row.composerShasum,
            };
            return keyOnly;
          }),
          next: null,
        };
      return { rows: [stored.get(keys[0]!)!], next: keys.length > 1 ? keys[0]! : null };
    },
  };
  let session = handle();
  for (let invocation = 0; invocation < 10; invocation++) {
    reads = 0;
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, existing },
      input(session, description(versions)),
    );
    expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(reads).toBeLessThan(INVOCATION_BUDGET);
    expect(outcome.session.seenCount).toBeGreaterThan(session.seenCount);
    if (outcome.done) {
      expect(outcome.status).toBe('complete');
      expect(outcome.session.seenCount).toBe(1000);
      return;
    }
    session = outcome.session;
  }
  throw new Error('apply did not complete');
});

it('abandons when even one read and write cannot fit instead of retrying without progress', async () => {
  const f = fixture();
  const writer = { ...f.deps.writer, syncPackageCost: () => INVOCATION_BUDGET };
  const outcome = await applyChunk(ctx, { ...f.deps, writer }, input(handle()));
  expect(outcome).toMatchObject({ done: true, status: 'refused', refusal: 'budget_exhausted' });
  expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
  expect(f.abandoned).toBe(1);
  expect(f.marked).toEqual([]);
});

it('never writes tags when current or earlier refused members prevent finalization', async () => {
  for (const resumed of [false, true]) {
    const f = fixture();
    f.refuse.add('1.0.0');
    let tagCalls = 0;
    const writer = {
      ...f.deps.writer,
      syncPackage: (...args: Parameters<CatalogueWriter['syncPackage']>) => {
        if (args[2].tags !== undefined) tagCalls++;
        return f.deps.writer.syncPackage(...args);
      },
    };
    const session = resumed
      ? continued({ packageId: 'pkg-1', ordinal: 0, attempted: 1, tail: 'tags' })
      : handle();
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, writer },
      input(session, tagged(['1.0.0'], 2)),
    );
    expect(tagCalls).toBe(0);
    expect(f.finalized).toEqual([]);
    expect(outcome).toMatchObject({ done: true, refusal: 'refused_members' });
  }
});

it('does not forget a refusal from an earlier invocation when a later one is clean', async () => {
  const f = fixture();
  let tagCalls = 0;
  const writer = {
    ...f.deps.writer,
    syncPackage: (...args: Parameters<CatalogueWriter['syncPackage']>) => {
      if (args[2].tags !== undefined) tagCalls++;
      return f.deps.writer.syncPackage(...args);
    },
  };
  const session = continued(
    { packageId: 'pkg-1', ordinal: 0, attempted: 2, tail: 'tags' },
    { seenCount: 1 },
  );
  const outcome = await applyChunk(
    ctx,
    { ...f.deps, writer },
    input(session, tagged(['1.0.0', '1.0.1'], 2)),
  );
  expect(tagCalls).toBe(0);
  expect(f.finalized).toEqual([]);
  expect(outcome).toMatchObject({ done: true, refusal: 'refused_members', refusedMembers: 1 });
});

it('reports superseded when the fenced abandonment of a corrupt pass loses ownership', async () => {
  const f = fixture();
  f.abandonResult = false;
  const desc = createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(SNAPSHOT),
    validators: {},
    documentsComplete: true,
    members: (async function* () {
      await Promise.resolve();
      yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
      throw new SnapshotCorruptError();
    })(),
  });
  const outcome = await applyChunk(ctx, f.deps, input(handle(), desc));
  expect(outcome).toMatchObject({ done: true, status: 'superseded' });
  expect(f.calls).toEqual([]);
  expect(f.abandoned).toBe(1);
  expect(f.finalized).toEqual([]);
});

it('splits an oversized tag set across continuations without dropping tags', async () => {
  const f = fixture();
  const written: string[] = [];
  const writer = {
    ...f.deps.writer,
    syncPackage: (...args: Parameters<CatalogueWriter['syncPackage']>) => {
      if (args[2].tags !== undefined) written.push(...Object.keys(args[2].tags));
      return f.deps.writer.syncPackage(...args);
    },
  };
  let session = tail('tags');
  for (let invocation = 0; invocation < 5; invocation++) {
    const outcome = await applyChunk(
      ctx,
      { ...f.deps, writer },
      input(session, tagged(['1.0.0'], 9)),
    );
    expect(outcome.planned).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(outcome.tagsSkipped).toBe(false);
    if (outcome.done) {
      expect(outcome.status).toBe('complete');
      expect(written).toEqual(Array.from({ length: 9 }, (_, n) => `tag${n}`));
      return;
    }
    session = outcome.session;
  }
  throw new Error('tag apply did not complete');
});

it.each([
  new JsonStreamError('invalid_syntax', 10),
  new JsonExtractError('invalid_member', 10),
  new NpmPackumentError('invalid'),
  new NpmPackumentError('snapshot_gone'),
  new RangeError('member ordinals must be strictly increasing'),
])('abandons a staged pass on $name without logging request data', async (error) => {
  const f = fixture();
  const desc = createPackageDescription({
    name: KEY,
    snapshot: snapshotRef(SNAPSHOT),
    validators: {},
    documentsComplete: true,
    members: (async function* () {
      yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: manifest('1.0.0') } as const;
      throw error;
    })(),
  });
  const outcome = await applyChunk(ctx, f.deps, input(handle(), desc));
  expect(outcome).toMatchObject({ done: true, status: 'refused', refusal: 'snapshot_corrupt' });
  expect(f.calls).toEqual([]);
  expect(f.abandoned).toBe(1);
  expect(f.logs).toEqual([
    { level: 'warn', event: 'ingest.snapshot_corrupt', reason_code: 'snapshot_corrupt' },
  ]);
});

it('budgets incoming and stored metadata together when retaining a comparison window', async () => {
  const f = fixture();
  const versions = Array.from({ length: 40 }, (_, n) => `1.0.${n}`);
  const large = 'x'.repeat(200 * 1024);
  const raw = (version: string) =>
    JSON.stringify({ ...JSON.parse(manifest(version)), description: large });
  f.existing = versions.map((version, ordinal) => ({
    versionNormalized: version,
    id: `v-${ordinal}`,
    revision: 1,
    status: 'active',
    npmIntegrity: INTEGRITY_A,
    composerShasum: null,
    metadataJson: (
      toVersion({ ordinal, version, form: 'npm-full', raw: raw(version) }) as VersionInput
    ).metadata.json,
  }));
  const perMember = 4 * f.existing[0]!.metadataJson!.length;
  const outcome = await applyChunk(ctx, f.deps, input(handle(), description(versions, { raw })));
  const { attempted } = JSON.parse(outcome.cursor!) as { attempted: number };
  expect(attempted).toBe(Math.floor(APPLY_WINDOW_BYTES / perMember));
  expect(outcome.status).toBe('progress');
});

it('returns skipped candidates in a progress chunk and in its continuation', async () => {
  const f = fixture();
  const versions = Array.from({ length: 100 }, (_, i) => `1.0.${i}`);
  const skipped = [{ version: '0.1.0', reason: 'invalid_manifest' as const }];
  const first = await applyChunk(ctx, f.deps, input(handle(), description(versions, { skipped })));
  expect(first.status).toBe('progress');
  expect(first.skipped).toEqual(skipped);
  const second = await applyChunk(
    ctx,
    f.deps,
    input(first.session, description(versions, { skipped })),
  );
  expect(second.skipped).toEqual(skipped);
});
