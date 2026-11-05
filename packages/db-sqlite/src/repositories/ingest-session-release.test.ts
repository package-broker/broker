import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOnDemandFill, type OnDemandDeps } from '@package-broker/core/ingest/on-demand';
import { createPackageDescription, snapshotRef } from '@package-broker/core/sources/provider';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { systemClock } from '@package-broker/core/ids';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import { createCatalogueWriter } from './catalogue-writer.js';
import { createExistingVersionsReader } from './existing-versions.js';
import { createIngestFinalizer } from './ingest-finalize.js';
import { createUpstreamStateRepository } from './upstream-state.js';
import type { OrgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createIngestSessionMaintenance,
  createIngestSessions,
  createIngestSessionWriteGuard,
} from './ingest-session.js';
import { packageUpsertStatements } from './catalogue-write-package.js';
import { createHash } from 'node:crypto';
import { parseSha256, type CoreBlobStore as BlobStore } from '@package-broker/core/platform/blob';
import type { Codecs } from '@package-broker/core/platform/codec';
import { describeNpmPackument, NpmPackumentError } from '@package-broker/core/ingest/npm/packument';
import { SnapshotCorruptError } from '@package-broker/core/ingest/snapshot';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
const scope = { scope: 'package' as const, sourceId: 'source', packageKey: 'name' };
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  other = database.orgs!.b;
  await database.executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', 'npm', 'npm_registry')",
      params: [org.orgId],
    },
  ]);
});
afterEach(async () => database.close());
async function acquired() {
  const sessions = createIngestSessions(database.executor);
  const handle = await sessions.acquire(org, scope, 'owner', 60);
  if (handle === 'held') throw new Error('unexpected holder');
  return { sessions, handle };
}
it('releases immediately and preserves resume state at the next fence', async () => {
  const { sessions, handle } = await acquired();
  await sessions.start(org, handle, {
    stamp: 'a'.repeat(64),
    snapshot: { id: 'snapshot', blobSha256: 'b'.repeat(64) },
  });
  await sessions.advance(org, handle, { cursor: 'cursor', addSeen: 7 });
  expect(await sessions.release(org, handle)).toBe(true);
  const next = await sessions.acquire(org, scope, 'next', 60);
  expect(next).toMatchObject({
    generation: handle.generation,
    fence: handle.fence + 1,
    stamp: 'a'.repeat(64),
    snapshotId: 'snapshot',
    snapshotBlobSha256: 'b'.repeat(64),
    cursor: 'cursor',
    seenCount: 7,
    pagesSoFar: 1,
  });
});
it.each(['fence', 'owner', 'org', 'complete', 'abandoned'] as const)(
  'does not release with %s mismatch',
  async (mismatch) => {
    const { sessions, handle } = await acquired();
    if (mismatch === 'complete' || mismatch === 'abandoned')
      await database.executor.batch([
        { sql: 'UPDATE ingest_session SET state = ? WHERE id = ?', params: [mismatch, handle.id] },
      ]);
    const before = await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] });
    expect(
      await sessions.release(mismatch === 'org' ? other : org, {
        ...handle,
        ...(mismatch === 'fence' ? { fence: handle.fence + 1 } : {}),
        ...(mismatch === 'owner' ? { owner: 'other' } : {}),
      }),
    ).toBe(false);
    expect(
      await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] }),
    ).toEqual(before);
  },
);
it('fences both advance and catalogue writes immediately after release', async () => {
  const { sessions, handle } = await acquired();
  const guard = createIngestSessionWriteGuard(org, handle);
  await sessions.release(org, handle);
  expect(await sessions.advance(org, handle, { cursor: 'late', addSeen: 1 })).toBeNull();
  await expect(
    database.executor.batch(
      packageUpsertStatements(org, guard, {
        sourceId: scope.sourceId,
        ecosystem: 'npm',
        key: 'name',
        description: null,
      }).statements,
    ),
  ).rejects.toThrow();
});

it('keeps the new holder lease unchanged when the old holder releases after takeover', async () => {
  const { sessions, handle } = await acquired();
  await sessions.release(org, handle);
  const next = await sessions.acquire(org, scope, 'next', 60);
  if (next === 'held') throw new Error('unexpected holder');
  const before = await database.executor.all({
    sql: 'SELECT lease_until FROM ingest_session WHERE id = ?',
    params: [next.id],
  });
  expect(await sessions.release(org, handle)).toBe(false);
  expect(
    await database.executor.all({
      sql: 'SELECT lease_until FROM ingest_session WHERE id = ?',
      params: [next.id],
    }),
  ).toEqual(before);
});

const sessionRows = () =>
  database.executor.all<{ id: string; owner: string; fence: number; stamp: string | null }>({
    sql: 'SELECT id, owner, fence, stamp FROM ingest_session ORDER BY id',
    params: [],
  });
it('discards a held generation that never started', async () => {
  const { sessions, handle } = await acquired();
  expect(await sessions.discard(org, handle)).toBe(true);
  expect(await sessionRows()).toEqual([]);
  expect(await sessions.latest(org, scope)).toBeNull();
});
it('never discards a started generation', async () => {
  const { sessions, handle } = await acquired();
  await sessions.start(org, handle, { stamp: 'a'.repeat(64), snapshot: { id: 'snapshot' } });
  const before = await sessionRows();
  expect(await sessions.discard(org, handle)).toBe(false);
  expect(await sessionRows()).toEqual(before);
});
it.each(['fence', 'owner', 'org', 'complete', 'abandoned', 'expired'] as const)(
  'does not discard with %s mismatch',
  async (mismatch) => {
    const { sessions, handle } = await acquired();
    if (mismatch === 'complete' || mismatch === 'abandoned')
      await database.executor.batch([
        { sql: 'UPDATE ingest_session SET state = ? WHERE id = ?', params: [mismatch, handle.id] },
      ]);
    if (mismatch === 'expired')
      await database.executor.batch([
        {
          sql: "UPDATE ingest_session SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          params: [handle.id],
        },
      ]);
    const before = await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] });
    expect(
      await sessions.discard(mismatch === 'org' ? other : org, {
        ...handle,
        ...(mismatch === 'fence' ? { fence: handle.fence + 1 } : {}),
        ...(mismatch === 'owner' ? { owner: 'other' } : {}),
      }),
    ).toBe(false);
    expect(
      await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] }),
    ).toEqual(before);
  },
);
it('leaves a takeover holder untouched when the old holder discards', async () => {
  const { sessions, handle } = await acquired();
  await sessions.release(org, handle);
  const next = await sessions.acquire(org, scope, 'next', 60);
  if (next === 'held') throw new Error('unexpected holder');
  const before = await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] });
  expect(await sessions.discard(org, handle)).toBe(false);
  expect(await database.executor.all({ sql: 'SELECT * FROM ingest_session', params: [] })).toEqual(
    before,
  );
  expect(await sessions.advance(org, next, { cursor: null, addSeen: 0 })).not.toBeNull();
});

function fillDeps(): { deps: OnDemandDeps; actor: ProjectActor } {
  const sessions = createIngestSessions(database.executor);
  return {
    actor: {
      kind: 'project',
      orgId: org.orgId,
      projectId: 'project',
      userId: 'user',
      permissions: new Set(['project:packages:read']),
    },
    deps: {
      sessions,
      clock: systemClock,
      sourceMetadata: async () => ({ type: 'npm_registry' }),
      cache: {
        get: async () => ({ hit: null, version: 'epoch' }),
        set: async () => 'stored',
        delete: async () => {},
        currentVersion: async () => 'epoch',
      },
      visibility: {
        resolve: async (_actor, ecosystem, key) => ({
          kind: 'proxy_admissible',
          projectId: 'project',
          sourceIds: ['source'],
          ecosystem,
          key,
        }),
      },
      upstreamState: createUpstreamStateRepository(database.executor),
      writeGuard: createIngestSessionWriteGuard,
      apply: {
        sessions,
        writer: createCatalogueWriter(database.executor),
        existing: createExistingVersionsReader(database.executor),
        finalizer: createIngestFinalizer(database.executor),
      },
      enqueueSync: async () => {},
      planFill: async (_ctx, sourceId, key) => ({
        source: { id: sourceId, key, type: 'npm_registry', ecosystem: 'npm', covered: true },
        publishedValidators: {},
        validatorTtlSeconds: 300,
        packageDescription: null,
        toVersion: (candidate) => ({
          version: candidate.version,
          versionNormalized: candidate.version,
          license: null,
          distType: 'tgz',
          sourceRef: null,
          upstreamReleasedAt: null,
          metadata: normalizeVersionMetadata('npm', { name: key, version: candidate.version }),
          history: { basis: 'release_date', at: '2026-10-01T00:00:00.000Z' },
        }),
        describe: async () => ({
          kind: 'found',
          description: createPackageDescription({
            name: key,
            snapshot: snapshotRef('"first"'),
            validators: { 'npm-full': { etag: '"first"' } },
            documentsComplete: true,
            members: (async function* () {
              yield { ordinal: 0, version: '1.0.0', form: 'npm-full', raw: '{}' } as const;
            })(),
          }),
        }),
      }),
    },
  };
}
it('publishes inline cold-fill validators and serves the next request fresh using real SQLite', async () => {
  const { deps, actor } = fillDeps();
  const writes = vi.spyOn(deps.sessions, 'setPendingValidators');
  const finalizations = vi.spyOn(deps.apply.finalizer, 'finalize');
  const service = createOnDemandFill(deps);
  expect(
    await service.ensure(actor, {
      ecosystem: 'npm',
      key: 'NaMe',
      outcome: {
        kind: 'proxy_admissible',
        projectId: 'project',
        ecosystem: 'npm',
        key: 'name',
        sourceIds: ['source'],
      },
    }),
  ).toEqual({ kind: 'filled' });
  expect(writes).toHaveBeenCalledWith(org, expect.anything(), {
    'npm-packument': { etag: '"first"', lastModified: null, contentSha256: null },
  });
  expect(writes.mock.invocationCallOrder[0]).toBeLessThan(
    finalizations.mock.invocationCallOrder[0]!,
  );
  const [pkg] = await database.executor.all<{ id: string }>({
    sql: 'SELECT id FROM package WHERE org_id = ? AND name = ?',
    params: [org.orgId, 'name'],
  });
  const row = await deps.upstreamState.get(org, pkg!.id, 'npm-packument');
  expect(row).toMatchObject({ etag: '"first"', notFoundCount: 0 });
  expect(Date.parse(row!.freshUntil)).toBeGreaterThan(Date.now());
  expect(
    await service.ensure(actor, {
      ecosystem: 'npm',
      key: 'NAME',
      outcome: {
        kind: 'visible',
        pkg: {
          packageId: pkg!.id,
          projectId: 'project',
          sourceId: 'source',
          ecosystem: 'npm',
          key: 'name',
          rev: 1,
          createdAt: '',
          modifiedAt: '',
          listingComplete: true,
          cacheEpoch: 'epoch',
        },
        cacheKey: () => {
          throw new Error('unused');
        },
        epochReader: { read: async () => 'epoch' },
      },
    }),
  ).toEqual({ kind: 'serve', stale: false });
});
it('leaves no running generations for random definitive-404 names', async () => {
  const { deps, actor } = fillDeps();
  const basePlan = deps.planFill;
  const service = createOnDemandFill({
    ...deps,
    planFill: async (...args) => {
      const plan = await basePlan(...args);
      return plan && { ...plan, describe: async () => ({ kind: 'not_found', definitive: true }) };
    },
  });
  for (let i = 0; i < 20; i++) {
    const key = `missing-${crypto.randomUUID()}`;
    expect(
      await service.ensure(actor, {
        ecosystem: 'npm',
        key,
        outcome: {
          kind: 'proxy_admissible',
          projectId: 'project',
          sourceIds: ['source'],
          ecosystem: 'npm',
          key,
        },
      }),
    ).toEqual({ kind: 'not_found' });
    expect(
      await database.executor.all({
        sql: "SELECT id FROM ingest_session WHERE org_id = ? AND state = 'running'",
        params: [org.orgId],
      }),
    ).toEqual([]);
  }
});

it.each(['describe', 'members'] as const)(
  'restarts a corrupt staged generation detected during %s',
  async (phase) => {
    const { deps, actor } = fillDeps();
    const old = await deps.sessions.acquire(org, scope, 'previous', 60);
    if (old === 'held') throw new Error('unexpected holder');
    expect(
      await deps.sessions.start(org, old, {
        stamp: 'a'.repeat(64),
        snapshot: { id: '"corrupt"', blobSha256: 'b'.repeat(64) },
      }),
    ).toBe(true);
    expect(await deps.sessions.release(org, old)).toBe(true);
    const basePlan = deps.planFill;
    const freshDescribe = vi.fn();
    const enqueueSync = vi.fn(deps.enqueueSync);
    const service = createOnDemandFill({
      ...deps,
      enqueueSync,
      planFill: async (...args) => {
        const plan = await basePlan(...args);
        return (
          plan && {
            ...plan,
            describe: async (options, signal) => {
              if (options.snapshot === undefined) {
                freshDescribe();
                return plan.describe(options, signal);
              }
              if (phase === 'describe') throw new SnapshotCorruptError();
              return {
                kind: 'found',
                description: createPackageDescription({
                  name: 'name',
                  snapshot: snapshotRef('"corrupt"', parseSha256('b'.repeat(64))),
                  validators: {},
                  documentsComplete: true,
                  members: (async function* () {
                    yield await Promise.reject(new SnapshotCorruptError());
                  })(),
                }),
              };
            },
          }
        );
      },
    });
    const request = {
      ecosystem: 'npm' as const,
      key: 'name',
      outcome: await deps.visibility.resolve(actor, 'npm', 'name'),
    };
    expect(await service.ensure(actor, request)).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
    expect(await deps.sessions.latest(org, scope)).toMatchObject({
      state: 'abandoned',
      generation: old.generation,
      fence: old.fence + 1,
    });
    expect(freshDescribe).not.toHaveBeenCalled();
    expect(enqueueSync).not.toHaveBeenCalled();
    expect(await service.ensure(actor, request)).toEqual({ kind: 'filled' });
    expect(freshDescribe).toHaveBeenCalledTimes(1);
    expect(await deps.sessions.latest(org, scope)).toMatchObject({
      state: 'complete',
      generation: old.generation + 1,
    });
  },
);

it('restarts a missing staged snapshot in a new generation before fetching again', async () => {
  const { deps, actor } = fillDeps();
  const old = await deps.sessions.acquire(org, scope, 'previous', 60);
  if (old === 'held') throw new Error('unexpected holder');
  expect(
    await deps.sessions.start(org, old, {
      stamp: 'a'.repeat(64),
      snapshot: { id: '"missing"', blobSha256: 'b'.repeat(64) },
    }),
  ).toBe(true);
  expect(await deps.sessions.release(org, old)).toBe(true);
  const store: BlobStore = {
    async stage() {
      throw new Error('not_implemented');
    },
    async openStaged() {
      throw new Error('not_implemented');
    },
    async promote() {
      throw new Error('not_implemented');
    },
    async discard() {
      throw new Error('not_implemented');
    },
    put: async () => {
      throw new Error('unexpected write');
    },
    head: async () => null,
    get: vi.fn(async () => null),
  };
  const codecs: Pick<Codecs, 'digestTap'> = {
    digestTap() {
      throw new Error('unexpected digest');
    },
  };
  const fetch = vi.fn(async () =>
    Response.json({ name: 'name', versions: { '1.0.0': { name: 'name', version: '1.0.0' } } }),
  );
  const enqueueSync = vi.fn(deps.enqueueSync);
  const basePlan = deps.planFill;
  const service = createOnDemandFill({
    ...deps,
    enqueueSync,
    planFill: async (...args) => {
      const plan = await basePlan(...args);
      return (
        plan && {
          ...plan,
          describe: async (options, signal) => {
            const result = await describeNpmPackument(
              { ctx: org, store, codecs, fetch, signal },
              { name: 'name', url: 'https://registry.npmjs.org/name' },
              options,
            );
            if (result.kind === 'restart') throw new NpmPackumentError('snapshot_gone');
            return result;
          },
        }
      );
    },
  });
  const request = {
    ecosystem: 'npm' as const,
    key: 'name',
    outcome: {
      kind: 'proxy_admissible' as const,
      projectId: 'project',
      ecosystem: 'npm' as const,
      key: 'name',
      sourceIds: ['source'],
    },
  };
  expect(await service.ensure(actor, request)).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
  expect(await deps.sessions.latest(org, scope)).toMatchObject({
    state: 'abandoned',
    generation: old.generation,
    fence: old.fence + 1,
  });
  expect(store.get).toHaveBeenCalledExactlyOnceWith(org, parseSha256('b'.repeat(64)));
  expect(fetch).not.toHaveBeenCalled();
  expect(enqueueSync).not.toHaveBeenCalled();

  expect(await service.ensure(actor, request)).toEqual({ kind: 'filled' });
  expect(await deps.sessions.latest(org, scope)).toMatchObject({
    state: 'complete',
    generation: old.generation + 1,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(store.get).toHaveBeenCalledTimes(1);
});

it('hands staged validators through a 400-version continuation within the statement budget', async () => {
  const { deps, actor } = fillDeps();
  const body = JSON.stringify({
    name: 'name',
    versions: Object.fromEntries(
      Array.from({ length: 400 }, (_, ordinal) => {
        const version = `${ordinal}.0.0`;
        return [version, { name: 'name', version }];
      }),
    ),
  });
  const bytes = new TextEncoder().encode(body);
  const sha256 = parseSha256(createHash('sha256').update(bytes).digest('hex'));
  const ref = snapshotRef('"first"', sha256);
  const initialSnapshot = { ...ref, validators: { etag: '"first"' } };
  const info = {
    generation: '1',
    sha256,
    size: bytes.length,
    mediaType: 'application/json',
    purgeAfter: null,
  };
  const store: BlobStore = {
    async stage() {
      throw new Error('not_implemented');
    },
    async openStaged() {
      throw new Error('not_implemented');
    },
    async promote() {
      throw new Error('not_implemented');
    },
    async discard() {
      throw new Error('not_implemented');
    },
    put: async () => {
      throw new Error('unexpected write');
    },
    head: async () => info,
    get: async () => ({ info, body: new Response(bytes).body! }),
  };
  const codecs: Pick<Codecs, 'digestTap'> = {
    digestTap(algorithms) {
      const hashes = algorithms.map((algorithm) => [algorithm, createHash(algorithm)] as const);
      let resolve!: (value: never) => void;
      const digests = new Promise<never>((settle) => {
        resolve = settle;
      });
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hashes.forEach(([, hash]) => hash.update(chunk));
          controller.enqueue(chunk);
        },
        flush() {
          resolve(
            Object.fromEntries(
              hashes.map(([algorithm, hash]) => [algorithm, new Uint8Array(hash.digest())]),
            ) as never,
          );
        },
      });
      return { transform, digests };
    },
  };
  const fetch = vi.fn(async () => {
    throw new Error('unexpected upstream request');
  });
  const basePlan = deps.planFill;
  const batch = vi.spyOn(database.executor, 'batch');
  const all = vi.spyOn(database.executor, 'all');
  const release = deps.sessions.release.bind(deps.sessions);
  let startBatch = 0;
  let startAll = 0;
  let countStatements = false;
  const statements: number[] = [];
  vi.spyOn(deps.sessions, 'release').mockImplementation(async (ctx, session) => {
    if (countStatements) {
      statements.push(
        batch.mock.calls.slice(startBatch).reduce((sum, [calls]) => sum + calls.length, 0) +
          all.mock.calls.length -
          startAll,
      );
      countStatements = false;
    }
    return release(ctx, session);
  });
  const service = createOnDemandFill({
    ...deps,
    writeGuard(ctx, session) {
      startBatch = batch.mock.calls.length;
      startAll = all.mock.calls.length;
      countStatements = true;
      return deps.writeGuard(ctx, session);
    },
    planFill: async (...args) => {
      const plan = await basePlan(...args);
      return (
        plan && {
          ...plan,
          describe: async (options) => {
            const result = await describeNpmPackument(
              { ctx: org, store, codecs, fetch },
              {
                name: 'name',
                url: 'https://registry.npmjs.org/name',
              },
              options.snapshot === undefined ? { snapshot: initialSnapshot } : options,
            );
            if (result.kind === 'restart') throw new Error('unexpected restart');
            return result;
          },
        }
      );
    },
  });
  const request = {
    ecosystem: 'npm' as const,
    key: 'name',
    outcome: {
      kind: 'proxy_admissible' as const,
      projectId: 'project',
      ecosystem: 'npm' as const,
      key: 'name',
      sourceIds: ['source'],
    },
  };
  expect(await service.ensure(actor, request)).toEqual({ kind: 'busy', retryAfterSeconds: 10 });
  const [session] = await database.executor.all<{ pending_validators: string }>({
    sql: 'SELECT pending_validators FROM ingest_session WHERE org_id = ?',
    params: [org.orgId],
  });
  expect(JSON.parse(session!.pending_validators)).toEqual({
    'npm-packument': { etag: '"first"', lastModified: null, contentSha256: null },
  });
  let result: Awaited<ReturnType<typeof service.ensure>> = { kind: 'busy', retryAfterSeconds: 10 };
  for (let attempt = 0; attempt < 10 && result.kind === 'busy'; attempt++)
    result = await service.ensure(actor, request);
  expect(result).toEqual({ kind: 'filled' });
  const [pkg] = await database.executor.all<{ id: string }>({
    sql: 'SELECT id FROM package WHERE org_id = ?',
    params: [org.orgId],
  });
  expect(await deps.upstreamState.get(org, pkg!.id, 'npm-packument')).toMatchObject({
    etag: '"first"',
    notFoundCount: 0,
  });
  expect(statements.length).toBeGreaterThan(1);
  for (const count of statements) expect(count).toBeLessThanOrEqual(450);
  expect(fetch).not.toHaveBeenCalled();
});
it('retains no ingest session rows after 1,000 distinct definitive-404 names and one maintenance run', async () => {
  const { deps, actor } = fillDeps();
  const basePlan = deps.planFill;
  const service = createOnDemandFill({
    ...deps,
    planFill: async (...args) => {
      const plan = await basePlan(...args);
      return plan && { ...plan, describe: async () => ({ kind: 'not_found', definitive: true }) };
    },
  });
  for (let i = 0; i < 1000; i++) {
    const key = `missing-${String(i)}`;
    expect(
      await service.ensure(actor, {
        ecosystem: 'npm',
        key,
        outcome: {
          kind: 'proxy_admissible',
          projectId: 'project',
          sourceIds: ['source'],
          ecosystem: 'npm',
          key,
        },
      }),
    ).toEqual({ kind: 'not_found' });
  }
  await createIngestSessionMaintenance(database.executor).sweep(100);
  expect(
    await database.executor.all({ sql: 'SELECT COUNT(*) AS rows FROM ingest_session', params: [] }),
  ).toEqual([{ rows: 0 }]);
}, 120_000);
