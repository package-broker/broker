import { describe, expect, it } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import { ACCESS_MUTATION_GUARD_CONSTRAINT } from '@package-broker/core/db/errors';
import { createSourceSyncJob } from '@package-broker/core/ingest/source-sync-job';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability } from '@package-broker/core/platform/observability';
import type {
  ProviderContext,
  ProviderSource,
  SourceProvider,
} from '@package-broker/core/sources/provider';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { createSourceRepository } from '../repositories/source.js';
import { createSourceSyncCounts } from '../repositories/source-sync-counts.js';
import { createSourceSyncReads } from '../repositories/source-sync-reads.js';
import { seedTwoOrganizations } from './two-organizations.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';

const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const OLD = '2020-01-01T00:00:00.000Z';
const names = Array.from({ length: 50 }, (_, i) => `acme/p${String(i).padStart(2, '0')}`);

export function describeSourceSelectionContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
): void {
  describe(`source selection retention: ${name}`, () => {
    for (const selection of ['packages', 'patterns', 'registered'] as const) {
      it(`${selection}: narrows 50 to 10 without changing the other 40, widens, and removes only real selected absences`, async () => {
        const database = await open();
        const { executor } = database;
        try {
          const { a: ctx } = await seedTwoOrganizations(executor);
          const wide = { selection: { packages: names, patterns: [], expandPatterns: false } };
          await executor.batch([
            st(
              "INSERT INTO source (id, org_id, name, ecosystem, type, config_json, removal_policy) VALUES ('S', ?, 'source', 'composer', 'composer_repository', ?, 'exclude')",
              ctx.orgId,
              JSON.stringify(wide),
            ),
            st(
              "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
              ctx.orgId,
            ),
            st(
              "INSERT INTO job (id, org_id, type, idempotency_key, resource_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'sync:v1', 'poll', 'source:S', 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
              ctx.orgId,
            ),
            ...names.flatMap((key, i) => [
              st(
                "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES (?, ?, 'S', 'composer', ?, ?)",
                `P${i}`,
                ctx.orgId,
                key,
                OLD,
              ),
              st(
                "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at) VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'release_date', '{}', ?)",
                `V${i}`,
                ctx.orgId,
                `P${i}`,
                OLD,
                OLD,
              ),
            ]),
          ]);
          const sessions = createIngestSessions(executor);
          const writer = createCatalogueWriter(executor);
          const reads = createSourceSyncReads(executor);
          const sources = createSourceRepository(executor);
          let upstream = names;
          const enqueued: string[] = [];
          const provider: SourceProvider = {
            id: 'test',
            sourceTypes: ['composer_repository'],
            ecosystems: ['composer'],
            listPackages: async () => ({
              names: upstream,
              next: null,
              last: true,
              snapshot: { id: '"snapshot"' },
            }),
            describe: async () => ({ kind: 'not_found', definitive: false }),
            openDist: async () => {
              throw new Error('unused');
            },
          };
          const job = createSourceSyncJob({
            sources,
            sessions,
            writer,
            ...createSourceSyncCounts(executor),
            ...reads,
            finalizer: createIngestFinalizer(executor),
            providers: { forSource: () => provider },
            toProviderSource: (record) =>
              ({
                id: record.id,
                type: record.type,
                ecosystem: record.ecosystem,
                url: record.url,
                config: JSON.parse(record.configJson),
                providerId: 'test',
              }) as ProviderSource,
            loadCredential: async () => null,
            providerContext: (context) =>
              ({ org: context.org, signal: context.signal }) as ProviderContext,
            writeGuard: (org, session) => createIngestSessionWriteGuard(org, session),
            jobGuard: () => ({ id: 'J', owner: 'worker', fence: 1 }),
          });
          let generation = 0;
          const run = async () => {
            enqueued.length = 0;
            await job.handler({ sourceId: 'S', reason: 'admin' }, {
              org: ctx,
              jobId: 'J',
              attempt: ++generation,
              idempotencyKey: `run${generation}`,
              signal: new AbortController().signal,
              observability: noopObservability,
              ports: {
                platform: {
                  jobs: {
                    enqueue: async (_org: unknown, _type: string, payload: { key: string }) => {
                      enqueued.push(payload.key);
                    },
                  },
                },
              },
            } as unknown as JobContext);
          };
          await run();
          expect(enqueued).toEqual(names);
          const snapshot = () =>
            executor.all(st('SELECT * FROM package WHERE org_id = ? ORDER BY id', ctx.orgId));
          const before = await snapshot();
          const narrow =
            selection === 'patterns'
              ? { selection: { packages: [], patterns: ['acme/p0*'], expandPatterns: false } }
              : {
                  selection: { packages: names.slice(0, 10), patterns: [], expandPatterns: false },
                };
          await executor.batch(
            selection === 'registered'
              ? [
                  st(
                    "UPDATE registered_name SET pattern = 'acme/p0*' WHERE org_id = ? AND id = 'R'",
                    ctx.orgId,
                  ),
                ]
              : [
                  st(
                    "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
                    JSON.stringify(narrow),
                    ctx.orgId,
                  ),
                ],
          );
          await run();
          expect(enqueued).toEqual(names.slice(0, 10));
          const after = await snapshot();
          expect(after).toHaveLength(50);
          expect(after.every((row) => row['status'] === 'active')).toBe(true);
          expect(after.filter((row) => !names.slice(0, 10).includes(String(row['name'])))).toEqual(
            before.filter((row) => !names.slice(0, 10).includes(String(row['name']))),
          );
          expect(
            await executor.all(st('SELECT * FROM version_revision WHERE org_id = ?', ctx.orgId)),
          ).toEqual([]);
          expect(
            await executor.all(st('SELECT * FROM audit_pending WHERE org_id = ?', ctx.orgId)),
          ).toEqual([]);
          // Make the selected missing package older than the next sweep boundary.
          await executor.batch([
            st(
              "UPDATE package SET (updated_at) = (?) WHERE org_id = ? AND id = 'P0'",
              OLD,
              ctx.orgId,
            ),
          ]);
          upstream = names.slice(1);
          await run();
          expect(enqueued).toEqual(names.slice(1, 10));
          expect(
            (await snapshot())
              .filter((row) => row['status'] === 'removed_upstream')
              .map((row) => row['name']),
          ).toEqual([names[0]]);
          expect(
            (await snapshot()).filter((row) => !names.slice(0, 10).includes(String(row['name']))),
          ).toEqual(before.filter((row) => !names.slice(0, 10).includes(String(row['name']))));
          expect(
            await executor.all(
              st('SELECT reason FROM version_revision WHERE org_id = ?', ctx.orgId),
            ),
          ).toEqual([{ reason: 'status:active>removed_upstream:listing_absent' }]);
          await executor.batch([
            st(
              "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
              JSON.stringify(wide),
              ctx.orgId,
            ),
            st(
              "UPDATE registered_name SET pattern = 'acme/*' WHERE org_id = ? AND id = 'R'",
              ctx.orgId,
            ),
          ]);
          upstream = names;
          await run();
          expect(enqueued).toEqual(names);
          expect((await snapshot()).every((row) => row['status'] === 'active')).toBe(true);
          // A retained package cannot be removed by an old queued definitive-absence result.
          await executor.batch([
            st(
              "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
              JSON.stringify(narrow),
              ctx.orgId,
            ),
            st(
              "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count, first_not_found_at) VALUES (?, 'P49', 'composer-p2', ?, ?, 100, ?)",
              ctx.orgId,
              OLD,
              OLD,
              OLD,
            ),
          ]);
          const session = await sessions.acquire(
            ctx,
            { scope: 'package', sourceId: 'S', packageKey: names[49]! },
            'absence-worker',
            60,
          );
          if (session === 'held') throw new Error('held');
          await expect(
            writer.markPackageAbsent(ctx, createIngestSessionWriteGuard(ctx, session), {
              packageId: 'P49',
            }),
          ).rejects.toMatchObject({ constraint: ACCESS_MUTATION_GUARD_CONSTRAINT });
          const absenceGuard = createCatalogueWriteGuard(ctx, {
            id: 'J',
            owner: 'worker',
            fence: 1,
          });
          expect(
            await writer.markPackageAbsent(ctx, absenceGuard, {
              packageId: 'P49',
            }),
          ).toMatchObject({ changed: false });
          await executor.batch([
            st(
              "UPDATE source SET config_json = ? WHERE org_id = ? AND id = 'S'",
              JSON.stringify({ selection: { packages: [], patterns: [], expandPatterns: false } }),
              ctx.orgId,
            ),
          ]);
          const beforeEmpty = await snapshot();
          await run();
          expect(enqueued).toEqual([]);
          expect(await snapshot()).toEqual(beforeEmpty);
          // Removing the final registration pauses the source, including unconfigured sources.
          await executor.batch([
            st("DELETE FROM registered_name WHERE org_id = ? AND source_id = 'S'", ctx.orgId),
            st(
              "UPDATE source SET config_json = '{}', status = 'paused' WHERE org_id = ? AND id = 'S'",
              ctx.orgId,
            ),
          ]);
          expect(
            await writer.markPackageAbsent(ctx, absenceGuard, {
              packageId: 'P49',
            }),
          ).toMatchObject({ changed: false });
          expect(await snapshot()).toEqual(beforeEmpty);
        } finally {
          await database.close();
        }
      });
    }
  });
}
