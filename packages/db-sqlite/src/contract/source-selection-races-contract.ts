import { describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import type { Statement } from '@package-broker/core/db/port';
import { applyChunk } from '@package-broker/core/ingest/apply-description';
import { createSourceSyncJob } from '@package-broker/core/ingest/source-sync-job';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability } from '@package-broker/core/platform/observability';
import { createPackageDescription, snapshotRef } from '@package-broker/core/sources/provider';
import type { ProviderContext } from '@package-broker/core/sources/provider';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createExistingVersionsReader } from '../repositories/existing-versions.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { createSourceRepository } from '../repositories/source.js';
import { createSourceSyncCounts } from '../repositories/source-sync-counts.js';
import { createSourceSyncReads } from '../repositories/source-sync-reads.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';
import { seedTwoOrganizations } from './two-organizations.js';

const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const OLD = '2020-01-01T00:00:00.000Z';
const names = Array.from({ length: 50 }, (_, i) => `acme/p${String(i).padStart(2, '0')}`);
const wide = JSON.stringify({ selection: { packages: names, patterns: [] } });
const SNAPSHOT = '"snapshot"';

function barrier() {
  let release!: () => void;
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    reached,
    async wait() {
      arrive();
      await released;
    },
  };
}

async function fixture(open: () => Promise<OpenedCatalogueWriteDatabase>) {
  const database = await open();
  const { executor } = database;
  try {
    const { a: ctx } = await seedTwoOrganizations(executor);
    await executor.batch([
      st(
        "INSERT INTO source (id, org_id, name, ecosystem, type, config_json) VALUES ('S', ?, 'source', 'composer', 'composer_repository', ?)",
        ctx.orgId,
        wide,
      ),
      st(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
        ctx.orgId,
      ),
      st(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'sync:v1', 'poll', 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
        ctx.orgId,
      ),
      ...names.map((key, i) =>
        st(
          "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, 'S', 'composer', ?, ?)",
          `P${i}`,
          ctx.orgId,
          key,
          OLD,
        ),
      ),
      st(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES ('V', ?, 'P49', '1.0.0', '1.0.0.0', ?, 'release_date', '{}', ?)",
        ctx.orgId,
        OLD,
        OLD,
      ),
    ]);
    const snapshot = async () =>
      Promise.all(
        ['package', 'version', 'version_revision', 'cache_epoch', 'audit_pending'].map((table) =>
          executor.all(st(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1`, ctx.orgId)),
        ),
      );
    const narrow = (selection: 'packages' | 'patterns' | 'registered', count = 10) =>
      executor.batch([
        selection === 'registered'
          ? st(
              "UPDATE registered_name SET pattern = 'acme/p0*' WHERE org_id = ? AND id = 'R'",
              ctx.orgId,
            )
          : st(
              "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
              JSON.stringify({
                selection: {
                  packages: selection === 'packages' ? names.slice(0, count) : [],
                  patterns: selection === 'patterns' ? ['acme/p0*'] : [],
                },
              }),
              ctx.orgId,
            ),
      ]);
    return {
      database,
      executor,
      ctx,
      snapshot,
      narrow,
      sessions: createIngestSessions(executor),
      writer: createCatalogueWriter(executor),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

export function describeSourceSelectionRacesContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
): void {
  describe(`source selection races: ${name}`, () => {
    it('dispatches keys from the same snapshot as the pinned selection revision', async () => {
      const w = await fixture(open);
      const { executor, ctx, sessions, writer } = w;
      try {
        await w.narrow('packages', 4);
        let changed = false;
        const changeAfterRead = async (statements: readonly Statement[]) => {
          if (
            !changed &&
            statements.some((statement) => statement.sql.includes('json_array(source.config_json'))
          ) {
            changed = true;
            await executor.batch([
              st(
                "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
                JSON.stringify({ selection: { packages: names.slice(1, 5), patterns: [] } }),
                ctx.orgId,
              ),
            ]);
          }
        };
        const reads = createSourceSyncReads({
          ...executor,
          async all<R>(statement: Statement): Promise<R[]> {
            const rows = await executor.all<R>(statement);
            await changeAfterRead([statement]);
            return rows;
          },
          async batch(statements) {
            const results = await executor.batch(statements);
            await changeAfterRead(statements);
            return results;
          },
        });
        const dispatched: string[] = [];
        const job = createSourceSyncJob({
          sources: createSourceRepository(executor),
          sessions,
          writer,
          ...createSourceSyncCounts(executor),
          ...reads,
          async existingKeys(...args) {
            // Restore the original selection before the write guard checks it.
            await w.narrow('packages', 4);
            return reads.existingKeys(...args);
          },
          finalizer: createIngestFinalizer(executor),
          providers: {
            forSource: () => ({
              id: 'listing',
              sourceTypes: ['composer_repository'],
              ecosystems: ['composer'],
              async listPackages() {
                return {
                  names: names.slice(0, 5),
                  next: null,
                  last: true,
                  snapshot: snapshotRef(SNAPSHOT),
                };
              },
              async describe() {
                throw new Error('unused');
              },
              async openDist() {
                throw new Error('unused');
              },
            }),
          },
          toProviderSource: () => ({
            id: 'S',
            type: 'composer_repository',
            ecosystem: 'composer',
            url: 'https://example.test',
            config: {
              selection: { packages: [], patterns: [], expandPatterns: false },
              distHosts: [],
              mirrorsFallback: false,
            },
            providerId: 'listing',
          }),
          loadCredential: async () => null,
          providerContext: () => ({}) as ProviderContext,
          writeGuard: (org, held) => createIngestSessionWriteGuard(org, held),
          jobGuard: () => ({ id: 'J', owner: 'worker', fence: 1 }),
        });
        const outcome = await job
          .handler({ sourceId: 'S', reason: 'admin' }, {
            org: ctx,
            jobId: 'J',
            attempt: 1,
            signal: new AbortController().signal,
            observability: noopObservability,
            ports: {
              platform: {
                jobs: {
                  enqueue: async (_org: unknown, _type: string, payload: { key?: string }) => {
                    if (payload.key !== undefined) dispatched.push(payload.key);
                    return { id: 'unused', created: true };
                  },
                },
              },
            },
          } as unknown as JobContext)
          .then(
            () => 'complete',
            () => 'deferred',
          );
        expect(changed).toBe(true);
        expect(dispatched).toEqual(names.slice(0, 4));
        expect(outcome).toBe('complete');
      } finally {
        await w.database.close();
      }
    });

    it('rejects a count-only finalize pin after an equal-size selection replacement', async () => {
      const w = await fixture(open);
      const { executor, ctx, sessions, writer } = w;
      try {
        await w.narrow('packages', 4);
        const session = await sessions.acquire(
          ctx,
          { scope: 'source', sourceId: 'S' },
          'worker',
          60,
        );
        if (session === 'held') throw new Error('held');
        const guard = createIngestSessionWriteGuard(ctx, session);
        const scope = { kind: 'source', sourceId: 'S' } as const;
        const { stamp } = await writer.openListing(ctx, guard, scope);
        await sessions.start(ctx, session, { snapshot: { id: SNAPSHOT }, stamp });
        await writer.markListing(ctx, guard, { scope, stamp, present: names.slice(1, 3) });
        const unseen = await createSourceSyncCounts(executor).unseenExistingCount(ctx, 'S', stamp);
        const pin = createIngestSessionWriteGuard(ctx, {
          ...session,
          cursor: JSON.stringify({ s: 'S', u: unseen }),
        });
        await executor.batch([
          st(
            "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
            JSON.stringify({ selection: { packages: names.slice(1, 5), patterns: [] } }),
            ctx.orgId,
          ),
        ]);
        expect(await createSourceSyncCounts(executor).unseenExistingCount(ctx, 'S', stamp)).toBe(
          unseen,
        );
        const before = await w.snapshot();
        await expect(
          createIngestFinalizer(executor, { maxAbsenceShare: 1 }).finalize(
            ctx,
            session,
            {
              expectedCount: 2,
              attemptedCandidates: 4,
              successfulCandidates: 2,
              definitiveAbsent: unseen,
              upstreamComplete: true,
              validatorTtlSeconds: 0,
            },
            pin,
          ),
        ).resolves.toMatchObject({ status: 'refused', reason: 'superseded' });
        expect(await w.snapshot()).toEqual(before);
        expect(await sessions.latest(ctx, { scope: 'source', sourceId: 'S' })).toMatchObject({
          state: 'running',
        });
      } finally {
        await w.database.close();
      }
    });

    for (const selection of ['packages', 'patterns', 'registered', 'empty'] as const) {
      it(`finishes a completed cursor after 50 stamped packages narrow to ${selection}`, async () => {
        const w = await fixture(open);
        const { executor, ctx, sessions, writer } = w;
        try {
          const session = await sessions.acquire(
            ctx,
            { scope: 'source', sourceId: 'S' },
            'previous',
            60,
          );
          if (session === 'held') throw new Error('held');
          const guard = createIngestSessionWriteGuard(ctx, session);
          const scope = { kind: 'source', sourceId: 'S' } as const;
          const { stamp } = await writer.openListing(ctx, guard, scope);
          await sessions.start(ctx, session, { snapshot: { id: SNAPSHOT }, stamp });
          await writer.markListing(ctx, guard, { scope, stamp, present: names });
          await sessions.advance(
            ctx,
            session,
            { cursor: JSON.stringify({ c: null, o: 0, d: 1 }), addSeen: 50 },
            guard,
          );
          await sessions.release(ctx, session);
          await w.narrow(
            selection === 'empty' ? 'packages' : selection,
            selection === 'empty' ? 0 : 10,
          );
          const before = await w.snapshot();
          const counts = createSourceSyncCounts(executor);
          expect(await counts.markedCount(ctx, 'S', stamp)).toBe(selection === 'empty' ? 0 : 10);
          const job = createSourceSyncJob({
            sources: createSourceRepository(executor),
            sessions,
            writer,
            ...counts,
            ...createSourceSyncReads(executor),
            finalizer: createIngestFinalizer(executor),
            providers: {
              forSource: () => ({
                id: 'unused',
                sourceTypes: ['composer_repository'],
                ecosystems: ['composer'],
                async listPackages() {
                  throw new Error('completed cursor must not fetch');
                },
                async describe() {
                  throw new Error('unused');
                },
                async openDist() {
                  throw new Error('unused');
                },
              }),
            },
            toProviderSource: () => ({
              id: 'S',
              type: 'composer_repository',
              ecosystem: 'composer',
              url: 'https://example.test',
              config: {
                selection: { packages: [], patterns: [], expandPatterns: false },
                distHosts: [],
                mirrorsFallback: false,
              },
              providerId: 'unused',
            }),
            loadCredential: async () => null,
            providerContext: () => ({}) as ProviderContext,
            writeGuard: (org, held) => createIngestSessionWriteGuard(org, held),
            jobGuard: () => ({ id: 'J', owner: 'worker', fence: 1 }),
          });
          await job.handler({ sourceId: 'S', reason: 'admin' }, {
            org: ctx,
            jobId: 'J',
            attempt: 2,
            signal: new AbortController().signal,
            observability: noopObservability,
          } as JobContext);
          expect(await sessions.latest(ctx, { scope: 'source', sourceId: 'S' })).toMatchObject({
            id: session.id,
            state: 'complete',
            generation: 1,
          });
          expect(await w.snapshot()).toEqual(before);
        } finally {
          await w.database.close();
        }
      });
    }

    it('marks only currently selected packages when selection narrows before the mark', async () => {
      const w = await fixture(open);
      const { executor, ctx, sessions, writer } = w;
      try {
        const session = await sessions.acquire(
          ctx,
          { scope: 'source', sourceId: 'S' },
          'worker',
          60,
        );
        if (session === 'held') throw new Error('held');
        const guard = createIngestSessionWriteGuard(ctx, session);
        const scope = { kind: 'source', sourceId: 'S' } as const;
        const { stamp } = await writer.openListing(ctx, guard, scope);
        await sessions.start(ctx, session, { snapshot: { id: SNAPSHOT }, stamp });
        await w.narrow('packages', 10);
        const deselected = () =>
          executor.all(
            st(
              'SELECT * FROM package WHERE org_id = ? AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY id',
              ctx.orgId,
              JSON.stringify(names.slice(0, 10)),
            ),
          );
        const before = await deselected();
        const effect = await writer.markListing(ctx, guard, { scope, stamp, present: names });
        expect(effect.marked).toBe(10);
        expect(await deselected()).toEqual(before);
        expect(
          await executor.all(
            st(
              'SELECT count(*) AS n FROM package WHERE org_id = ? AND listing_seen_stamp = ?',
              ctx.orgId,
              stamp,
            ),
          ),
        ).toEqual([{ n: 10 }]);
      } finally {
        await w.database.close();
      }
    });

    for (const widenAt of ['before-preflight', 'before-finalize'] as const) {
      it(`restarts instead of removing a listed package when selection widens ${widenAt}`, async () => {
        const w = await fixture(open);
        const { executor, ctx, sessions, writer } = w;
        try {
          await w.narrow('packages', 4);
          const counts = createSourceSyncCounts(executor);
          const widen = () => w.narrow('packages', 5);
          const enqueued: unknown[] = [];
          const job = createSourceSyncJob({
            sources: createSourceRepository(executor),
            sessions,
            writer,
            ...counts,
            unseenExistingCount: async (org, sourceId, stamp) => {
              if (widenAt === 'before-preflight') await widen();
              const unseen = await counts.unseenExistingCount(org, sourceId, stamp);
              if (widenAt === 'before-finalize') await widen();
              return unseen;
            },
            ...createSourceSyncReads(executor),
            finalizer: createIngestFinalizer(executor),
            providers: {
              forSource: () => ({
                id: 'unused',
                sourceTypes: ['composer_repository'],
                ecosystems: ['composer'],
                async listPackages() {
                  return {
                    names: names.slice(0, 5),
                    next: null,
                    last: true,
                    snapshot: snapshotRef(SNAPSHOT),
                  };
                },
                async describe() {
                  throw new Error('unused');
                },
                async openDist() {
                  throw new Error('unused');
                },
              }),
            },
            toProviderSource: () => ({
              id: 'S',
              type: 'composer_repository',
              ecosystem: 'composer',
              url: 'https://example.test',
              config: {
                selection: { packages: [], patterns: [], expandPatterns: false },
                distHosts: [],
                mirrorsFallback: false,
              },
              providerId: 'unused',
            }),
            loadCredential: async () => null,
            providerContext: () => ({}) as ProviderContext,
            writeGuard: (org, held) => createIngestSessionWriteGuard(org, held),
            jobGuard: () => ({ id: 'J', owner: 'worker', fence: 1 }),
          });
          await expect(
            job.handler({ sourceId: 'S', reason: 'admin' }, {
              org: ctx,
              jobId: 'J',
              attempt: 1,
              signal: new AbortController().signal,
              observability: noopObservability,
              ports: {
                platform: { jobs: { enqueue: async (...args: unknown[]) => enqueued.push(args) } },
              },
            } as unknown as JobContext),
          ).rejects.toMatchObject({ name: 'JobError' });
          expect(
            await executor.all(
              st(
                "SELECT count(*) AS n FROM package WHERE org_id = ? AND status <> 'active'",
                ctx.orgId,
              ),
            ),
          ).toEqual([{ n: 0 }]);
        } finally {
          await w.database.close();
        }
      });
    }

    for (const direction of ['narrows', 'widens'] as const) {
      for (const phase of [
        'between-pages',
        'during-mark',
        'mark-batch',
        'before-finalize',
        'batch',
        'batch-same-count',
      ] as const) {
        it(`defers without removal when selection ${direction} ${phase} with no locally filtered names`, async () => {
          const w = await fixture(open);
          const { executor, ctx, sessions, writer } = w;
          try {
            const initialCount = direction === 'narrows' ? 5 : 4;
            const config = (count: number, extraPattern: boolean) =>
              JSON.stringify({
                selection: {
                  packages: names.slice(0, count),
                  patterns: extraPattern ? ['other/*'] : [],
                },
              });
            await executor.batch([
              st(
                "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
                config(initialCount, phase === 'batch-same-count' && direction === 'narrows'),
                ctx.orgId,
              ),
            ]);
            const change = () =>
              executor.batch([
                st(
                  "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
                  phase === 'batch-same-count'
                    ? config(initialCount, direction === 'widens')
                    : config(direction === 'narrows' ? 4 : 5, false),
                  ctx.orgId,
                ),
              ]);
            let markBatches = 0;
            const markingWriter = createCatalogueWriter({
              ...executor,
              async batch(statements) {
                markBatches += 1;
                if (phase === 'mark-batch' && markBatches === 2) await change();
                return executor.batch(statements);
              },
            });
            const counts = createSourceSyncCounts(executor);
            const job = createSourceSyncJob({
              sources: createSourceRepository(executor),
              sessions,
              writer: {
                ...writer,
                async markListing(...args) {
                  const result = await markingWriter.markListing(...args);
                  if (phase === 'during-mark') await change();
                  return result;
                },
              },
              ...counts,
              unseenExistingCount: async (...args) => {
                const unseen = await counts.unseenExistingCount(...args);
                if (phase === 'before-finalize') await change();
                return unseen;
              },
              ...createSourceSyncReads(executor),
              finalizer: createIngestFinalizer({
                ...executor,
                async batch(statements) {
                  if (phase === 'batch' || phase === 'batch-same-count') await change();
                  return executor.batch(statements);
                },
              }),
              providers: {
                forSource: () => ({
                  id: 'listing',
                  sourceTypes: ['composer_repository'],
                  ecosystems: ['composer'],
                  async listPackages(_context, _source, cursor) {
                    if (cursor !== null && phase === 'between-pages') await change();
                    return {
                      names: cursor === null ? names.slice(0, 2) : names.slice(2, 3),
                      next: cursor === null ? 'p2' : null,
                      last: cursor !== null,
                      snapshot: snapshotRef(SNAPSHOT),
                    };
                  },
                  async describe() {
                    throw new Error('unused');
                  },
                  async openDist() {
                    throw new Error('unused');
                  },
                }),
              },
              toProviderSource: () => ({
                id: 'S',
                type: 'composer_repository',
                ecosystem: 'composer',
                url: 'https://example.test',
                config: {
                  selection: { packages: [], patterns: [], expandPatterns: false },
                  distHosts: [],
                  mirrorsFallback: false,
                },
                providerId: 'listing',
              }),
              loadCredential: async () => null,
              providerContext: () => ({}) as ProviderContext,
              writeGuard: (org, held) => createIngestSessionWriteGuard(org, held),
              jobGuard: () => ({ id: 'J', owner: 'worker', fence: 1 }),
            });
            await expect(
              job.handler({ sourceId: 'S', reason: 'admin' }, {
                org: ctx,
                jobId: 'J',
                attempt: 1,
                signal: new AbortController().signal,
                observability: noopObservability,
                ports: {
                  platform: { jobs: { enqueue: async () => ({ id: 'unused', created: true }) } },
                },
              } as unknown as JobContext),
            ).rejects.toMatchObject({ name: 'JobError' });
            expect(
              await executor.all(
                st(
                  "SELECT count(*) AS n FROM package WHERE org_id = ? AND status <> 'active'",
                  ctx.orgId,
                ),
              ),
            ).toEqual([{ n: 0 }]);
            if (phase === 'mark-batch') {
              expect(markBatches).toBe(2);
              expect(
                await executor.all(
                  st(
                    'SELECT name FROM package WHERE org_id = ? AND listing_seen_stamp IS NOT NULL ORDER BY name',
                    ctx.orgId,
                  ),
                ),
              ).toEqual(names.slice(0, 2).map((name) => ({ name })));
              expect(
                await executor.all(
                  st('SELECT name, status FROM package WHERE org_id = ? ORDER BY name', ctx.orgId),
                ),
              ).toEqual(names.map((name) => ({ name, status: 'active' })));
            }
            expect(await sessions.latest(ctx, { scope: 'source', sourceId: 'S' })).toMatchObject({
              state: phase.startsWith('batch') || phase === 'mark-batch' ? 'running' : 'abandoned',
            });
          } finally {
            await w.database.close();
          }
        });
      }
    }

    for (const selection of ['packages', 'patterns', 'registered'] as const) {
      for (const phase of ['initial', 'resumed', 'batch'] as const) {
        it(`${selection}: blocks ${phase} ingest when selection narrows ${phase === 'batch' ? 'before the version batch' : 'while upstream is pending'}`, async () => {
          const w = await fixture(open);
          const { executor, ctx, sessions } = w;
          const upstream = barrier();
          let before: Awaited<ReturnType<typeof w.snapshot>> | undefined;
          const writer = createCatalogueWriter({
            ...executor,
            async batch(statements) {
              if (
                phase === 'batch' &&
                statements.some((statement) => /^insert into "version" /i.test(statement.sql))
              ) {
                await w.narrow(selection);
                before = await w.snapshot();
              }
              return executor.batch(statements);
            },
          });
          try {
            const session = await sessions.acquire(
              ctx,
              { scope: 'package', sourceId: 'S', packageKey: names[49]! },
              'worker',
              60,
            );
            if (session === 'held') throw new Error('held');
            const guard = createIngestSessionWriteGuard(ctx, session);
            if (phase === 'resumed') {
              const { stamp } = await writer.openListing(ctx, guard, {
                kind: 'package',
                packageId: 'P49',
              });
              await sessions.start(ctx, session, { snapshot: { id: SNAPSHOT }, stamp });
              await writer.markListing(ctx, guard, {
                scope: { kind: 'package', packageId: 'P49' },
                stamp,
                present: ['1.0.0.0'],
              });
              const cursor = JSON.stringify({
                packageId: 'P49',
                ordinal: 0,
                attempted: 1,
                tail: null,
              });
              await sessions.advance(ctx, session, { cursor, addSeen: 1 }, guard);
              Object.assign(session, { stamp, snapshotId: SNAPSHOT, cursor, seenCount: 1 });
            }
            const pending = applyChunk(
              ctx,
              {
                writer,
                sessions,
                existing: createExistingVersionsReader(executor),
                finalizer: createIngestFinalizer(executor),
              },
              {
                session,
                guard,
                source: {
                  id: 'S',
                  key: names[49]!,
                  type: 'composer_repository',
                  ecosystem: 'composer',
                  covered: true,
                },
                packageDescription: 'changed upstream metadata',
                validatorTtlSeconds: 0,
                description: createPackageDescription({
                  name: names[49]!,
                  snapshot: snapshotRef(SNAPSHOT),
                  validators: {},
                  documentsComplete: true,
                  members: (async function* () {
                    await upstream.wait();
                    yield { ordinal: 1, version: '2.0.0', form: 'composer-p2' as const, raw: '{}' };
                  })(),
                }),
                toVersion: () => ({
                  version: '2.0.0',
                  versionNormalized: '2.0.0.0',
                  license: null,
                  distType: null,
                  sourceRef: null,
                  upstreamReleasedAt: null,
                  metadata: normalizeVersionMetadata('composer', {
                    name: names[49],
                    version: '2.0.0',
                  }),
                  history: { basis: 'release_date', at: OLD },
                }),
              },
            );
            const rejected = expect(pending).rejects.toMatchObject({
              constraint: ACCESS_MUTATION_GUARD_CONSTRAINT,
            });
            await upstream.reached;
            if (phase !== 'batch') {
              await w.narrow(selection);
              before = await w.snapshot();
            }
            upstream.release();
            await rejected;
            expect(before).toBeDefined();
            expect(await w.snapshot()).toEqual(before);
          } finally {
            upstream.release();
            await w.database.close();
          }
        });
      }
    }
  });
}
