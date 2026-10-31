import { describe, expect, it } from 'vitest';
import { orgContext, type Statement } from '@package-broker/core/db/port';
import {
  blobStorageKey,
  stagedStorageKey,
  type StagedBlobHandle,
  type Sha256,
} from '@package-broker/core/platform/blob';
import { createBlobRepository } from '../repositories/blob.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';

export function describeBlobSupersededContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
) {
  describe(`superseded blob keys on ${name}`, () => {
    it('Round 2 keeps the physical npm key when publication retries the same handle', async () => {
      const opened = await open();
      try {
        const ctx = orgContext('retry');
        const key = 'd'.repeat(64) as Sha256;
        const npmPublishHandle =
          'staging/7265747279/01J00000000000000000000001' as StagedBlobHandle;
        const storageKey = stagedStorageKey(npmPublishHandle, key);
        const objects = new Set([storageKey]);
        const removals: string[] = [];
        const outcomes: string[] = [];
        await opened.executor.batch([
          {
            sql: "INSERT INTO organization (id,slug,name) VALUES ('retry','retry','Retry')",
            params: [],
          },
        ]);
        const repo = createBlobRepository(opened.executor, {
          supersededObjects: {
            async remove(key) {
              removals.push(key);
              objects.delete(key);
            },
            counter(outcome) {
              outcomes.push(outcome);
            },
          },
        });
        const generation = await repo.reserve(ctx, key);
        const input = {
          sha256: key,
          size: 10,
          mediaType: 'application/gzip',
          refetchable: false,
          generation,
          npmPublishHandle,
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await repo.publish(ctx, input)).not.toBeNull();
          expect((await repo.find(ctx, key))?.storageKey).toBe(storageKey);
          expect(objects.has(storageKey)).toBe(true);
        }
        expect(removals).toEqual([]);
        expect(outcomes).toEqual([]);
      } finally {
        await opened.close();
      }
    });
    for (const refetchable of [true, false])
      for (const fails of [false, true]) {
        it(`removes superseded npm keys after ${refetchable ? 'refetchable put' : 'publish or promotion'} (remove fails: ${fails})`, async () => {
          const opened = await open();
          try {
            const ctx = orgContext('superseded');
            const key = 'c'.repeat(64) as Sha256;
            const obsolete = 'npm-publish/superseded/unique-generation';
            const objects = new Set([obsolete, blobStorageKey(ctx.orgId, key)]);
            const outcomes: string[] = [];
            const statements: Statement[] = [
              {
                sql: "INSERT INTO organization (id,slug,name) VALUES ('superseded','superseded','Superseded')",
                params: [],
              },
              {
                sql: "INSERT INTO blob (id,org_id,sha256,size_bytes,media_type,storage_key,refetchable) VALUES ('obsolete','superseded',?,10,'application/gzip',?,0)",
                params: [key, obsolete],
              },
            ];
            await opened.executor.batch(statements);
            const repo = createBlobRepository(opened.executor, {
              supersededObjects: {
                async remove(storageKey) {
                  const rows = await opened.executor.all({
                    sql: 'SELECT storage_key FROM blob WHERE org_id=? AND sha256=?',
                    params: [ctx.orgId, key],
                  });
                  expect(rows).toEqual([{ storage_key: blobStorageKey(ctx.orgId, key) }]);
                  if (fails) throw new Error('storage unavailable');
                  objects.delete(storageKey);
                },
                counter(outcome) {
                  outcomes.push(outcome);
                },
              },
            });
            const generation = await repo.reserve(ctx, key);
            expect(
              await repo.publish(ctx, {
                sha256: key,
                size: 10,
                mediaType: 'application/gzip',
                refetchable,
                generation,
              }),
            ).not.toBeNull();
            expect(objects.has(obsolete)).toBe(fails);
            expect(objects.has(blobStorageKey(ctx.orgId, key))).toBe(true);
            expect(outcomes).toEqual([fails ? 'error' : 'removed']);
            const next = await repo.reserve(ctx, key);
            await repo.publish(ctx, {
              sha256: key,
              size: 10,
              mediaType: 'application/gzip',
              refetchable,
              generation: next,
            });
            expect(outcomes).toHaveLength(1);
          } finally {
            await opened.close();
          }
        });
      }
  });
}
