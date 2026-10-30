import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogueWriteGuard } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  createBlobStore,
  createBlobUploadAdmission,
  parseSha256,
  type CoreBlobStore as BlobStore,
} from '@package-broker/core/platform/blob';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createBlobRepository } from './blob.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { distAttachStatements } from './catalogue-write-dist.js';
import { replaceBlobStatements } from './catalogue-reblob.js';

const DATA = new TextEncoder().encode('generation fence');
const SHA = parseSha256(createHash('sha256').update(DATA).digest('hex'));
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const statement = (sql: string, ...params: (string | number | null)[]): Statement => ({
  sql,
  params,
});

for (const writer of ['attach', 'replace'] as const) {
  describe(`${writer} purge generation fence`, () => {
    let database: MigratedDatabase;
    let org: OrgContext;
    let guard: CatalogueWriteGuard;
    let repository: ReturnType<typeof createBlobRepository>;
    let store: BlobStore;

    beforeEach(async () => {
      database = await openMigratedDatabase({ twoOrganizations: true });
      if (database.orgs === null) throw new Error('organizations were not seeded');
      org = database.orgs.a;
      repository = createBlobRepository(database.executor);
      await database.executor.batch([
        statement(
          `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
           VALUES ('J', ?, 'sync:v1', 'generation', 'running', 'owner', ?, 1)`,
          org.orgId,
          FUTURE,
        ),
        statement(
          `INSERT INTO source (id, org_id, name, ecosystem, type)
           VALUES ('S', ?, 'main', 'composer', 'composer_repository')`,
          org.orgId,
        ),
        statement(
          `INSERT INTO package (id, org_id, source_id, ecosystem, name)
           VALUES ('K', ?, 'S', 'composer', 'acme/widget')`,
          org.orgId,
        ),
        statement(
          `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key)
           VALUES ('OLD', ?, ?, 1, 'old')`,
          org.orgId,
          'a'.repeat(64),
        ),
        statement(
          `INSERT INTO version (id, org_id, package_id, version, version_normalized,
            published_at, published_at_basis, metadata_json, blob_id)
           VALUES ('V', ?, 'K', '1.0.0', '1.0.0.0', ?, 'broker', '{}', ?)`,
          org.orgId,
          PAST,
          writer === 'replace' ? 'OLD' : null,
        ),
      ]);
      guard = createCatalogueWriteGuard(org, { id: 'J', owner: 'owner', fence: 1 });
      store = createBlobStore(
        {
          async putStaged() {
            throw new Error('not_implemented');
          },
          async openStaged() {
            throw new Error('not_implemented');
          },
          async promote() {
            throw new Error('not_implemented');
          },
          async discardStaged() {
            throw new Error('not_implemented');
          },
          async listStaged() {
            throw new Error('not_implemented');
          },
          async putVerified(_key, body, input) {
            const chunks: number[] = [];
            for await (const chunk of body) chunks.push(...chunk);
            expect(new Uint8Array(chunks)).toEqual(DATA);
            return { size: input.size, mediaType: input.mediaType };
          },
          get: async () => null,
          head: async () => ({ size: DATA.length, mediaType: 'text/plain' }),
          remove: async () => {},
        },
        repository,
        { admission: createBlobUploadAdmission() },
      );
      await upload();
    });

    afterEach(async () => database.close());

    function upload() {
      return store.put(
        org,
        SHA,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(DATA);
            controller.close();
          },
        }),
        { size: DATA.length, mediaType: 'text/plain', refetchable: true },
      );
    }

    function plan(expectedGeneration?: string) {
      const expected = expectedGeneration === undefined ? {} : { expectedGeneration };
      return writer === 'attach'
        ? distAttachStatements(org, guard, {
            versionId: 'V',
            revision: 1,
            sha256: SHA,
            ...expected,
          })
        : replaceBlobStatements(org, guard, {
            versionId: 'V',
            expectedRevision: 1,
            oldBlobId: 'OLD',
            newSha256: SHA,
            reason: 'refetch_changed',
            ...expected,
          });
    }

    async function snapshot() {
      return Promise.all(
        ['blob', 'version', 'version_revision', 'package'].map((table) =>
          database.executor.all(statement(`SELECT * FROM ${table} ORDER BY id`)),
        ),
      );
    }

    async function claim() {
      await database.executor.batch([
        statement(
          'UPDATE blob SET purge_after = ?, published_at = ? WHERE org_id = ? AND sha256 = ?',
          PAST,
          PAST,
          org.orgId,
          SHA,
        ),
      ]);
      const generation = await repository.claimPurge(org, SHA);
      if (generation === null) throw new Error('purge claim missing');
      return generation;
    }

    async function expire() {
      await database.executor.batch([
        statement(
          'UPDATE blob SET purge_lease_until = ? WHERE org_id = ? AND sha256 = ?',
          PAST,
          org.orgId,
          SHA,
        ),
      ]);
    }

    it.each([false, true])(
      'refuses an expired claim even with its generation supplied: %s',
      async (supplied) => {
        const generation = await claim();
        await expire();
        const before = await snapshot();
        await expect(
          database.executor.batch(plan(supplied ? generation : undefined).statements),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      },
    );

    it('refuses a live claim even with its generation supplied', async () => {
      const generation = await claim();
      const before = await snapshot();
      await expect(database.executor.batch(plan(generation).statements)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });

    it('attaches a fresh put after expiry and fences the late purger out', async () => {
      const stale = await claim();
      await expire();
      const fresh = await upload();
      expect(fresh.generation).not.toBe(stale);
      expect((await store.head(org, SHA))?.generation).toBe(fresh.generation);
      const republished = await snapshot();
      await expect(database.executor.batch(plan(stale).statements)).rejects.toThrow();
      expect(await snapshot()).toEqual(republished);
      const write = plan(fresh.generation);
      for (const entry of write.statements) expect(entry.params.length).toBeLessThanOrEqual(100);
      expect(write.result(await database.executor.batch(write.statements)).changed).toBe(true);
      const before = await snapshot();
      expect(await repository.canStartRemove(org, SHA, stale, 1000)).toBe(false);
      expect(await repository.markDeleted(org, SHA, stale)).toBe(false);
      expect(await repository.cancelPurge(org, SHA, stale)).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(
        await database.executor.all(
          statement(
            `SELECT blob.deleted_at FROM blob
        JOIN version ON version.blob_id = blob.id WHERE version.org_id = ? AND version.id = 'V'`,
            org.orgId,
          ),
        ),
      ).toEqual([{ deleted_at: null }]);
    });

    it('checks the generation at execution, refusing a plan made before another put', async () => {
      const first = await upload();
      const stalePlan = plan(first.generation);
      const second = await upload();
      const before = await snapshot();
      await expect(database.executor.batch(stalePlan.statements)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      const freshPlan = plan(second.generation);
      expect(freshPlan.result(await database.executor.batch(freshPlan.statements)).changed).toBe(
        true,
      );
    });

    it.each(['', 'g', 'A'.repeat(32), null, 42])(
      'refuses malformed generation %s',
      (generation) => {
        expect(() => plan(generation as string)).toThrow(RangeError);
      },
    );
  });
}
