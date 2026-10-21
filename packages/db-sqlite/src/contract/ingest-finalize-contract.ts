import { describe, expect, it } from 'vitest';
import type { CatalogueWriter } from '@package-broker/core/db/catalogue';
import type { Statement } from '@package-broker/core/db/port';
import {
  completeSourceListing,
  completeVersionListing,
} from '@package-broker/core/catalogue/version-rules';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { seedTwoOrganizations } from './two-organizations.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';

const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const OLD = '2020-01-01T00:00:00.000Z';

export function describeIngestFinalizeContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
): void {
  describe(`held-back lease finalize contract: ${name}`, () => {
    for (const entry of ['port', 'ingest'] as const) {
      for (const scenario of ['held', 'none', 'source', 'empty'] as const) {
        if (entry === 'port' && scenario === 'empty') continue;
        it(`${entry}: reports ${scenario === 'held' ? 'two held-back leases' : `zero for ${scenario}`}`, async () => {
          const database = await open();
          const { executor } = database;
          try {
            const { a: ctx } = await seedTwoOrganizations(executor);
            await executor.batch([
              st(
                "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 's', 'composer', 'composer_repository')",
                ctx.orgId,
              ),
              st(
                "INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at) VALUES ('P', ?, 'S', 'composer', 'acme/p', ?)",
                ctx.orgId,
                OLD,
              ),
              ...[1, 2].flatMap((n) => [
                st(
                  'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, purge_lease_until) VALUES (?, ?, ?, 1, ?, ?)',
                  `B${n}`,
                  ctx.orgId,
                  String(n).repeat(64),
                  `b/${n}`,
                  scenario === 'held' ? '2099-01-01T00:00:00.000Z' : null,
                ),
                st(
                  `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at, blob_id, status, removed_upstream_at)
                  VALUES (?, ?, 'P', ?, ?, ?, 'release_date', '{}', ?, ?, 'removed_upstream', ?)`,
                  `V${n}`,
                  ctx.orgId,
                  `1.0.${n}`,
                  `1.0.${n}`,
                  OLD,
                  OLD,
                  `B${n}`,
                  OLD,
                ),
              ]),
            ]);
            const sessions = createIngestSessions(executor);
            const session = await sessions.acquire(
              ctx,
              scenario === 'source'
                ? { scope: 'source', sourceId: 'S' }
                : { scope: 'package', sourceId: 'S', packageKey: 'acme/p' },
              'worker',
              60,
            );
            if (session === 'held') throw new Error('session held');
            const guard = createIngestSessionWriteGuard(ctx, session);
            const writer: CatalogueWriter = createCatalogueWriter(executor);
            const scope =
              scenario === 'source'
                ? ({ kind: 'source', sourceId: 'S' } as const)
                : ({ kind: 'package', packageId: 'P' } as const);
            const { stamp } = await writer.openListing(ctx, guard, scope);
            await sessions.start(ctx, session, { snapshot: { id: 'snapshot' }, stamp });
            const present =
              scenario === 'source' ? ['acme/p'] : scenario === 'empty' ? [] : ['1.0.1', '1.0.2'];
            if (present.length > 0) await writer.markListing(ctx, guard, { scope, stamp, present });
            const evidence = {
              attemptedCandidates: present.length,
              successfulCandidates: present.length,
              definitiveAbsent: 0,
            };
            const result =
              entry === 'ingest'
                ? await createIngestFinalizer(executor).finalize(
                    ctx,
                    session,
                    {
                      ...evidence,
                      expectedCount: present.length,
                      upstreamComplete: true,
                      validatorTtlSeconds: 0,
                    },
                    guard,
                  )
                : await writer.finalizeListing(
                    ctx,
                    guard,
                    scenario === 'source'
                      ? completeSourceListing({ sourceId: 'S', stamp, count: 1 })
                      : completeVersionListing({ packageId: 'P', stamp, count: 2 }),
                    evidence,
                  );
            expect(result).toMatchObject({ leaseHeldBack: scenario === 'held' ? 2 : 0 });
            if (entry === 'ingest') expect(result).toMatchObject({ status: 'complete' });
            if (scenario === 'held' || scenario === 'none') {
              expect(
                await executor.all(
                  st('SELECT status FROM version WHERE org_id = ? ORDER BY id', ctx.orgId),
                ),
              ).toEqual([
                { status: scenario === 'held' ? 'removed_upstream' : 'active' },
                { status: scenario === 'held' ? 'removed_upstream' : 'active' },
              ]);
            }
          } finally {
            await database.close();
          }
        });
      }
    }
  });
}
