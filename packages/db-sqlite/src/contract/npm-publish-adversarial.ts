import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import type { ByteStore } from '@package-broker/core/platform/blob';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { createBlobRepository } from '../repositories/blob.js';
import { createBlobReferenceReader } from '../repositories/blob-references.js';
import { describeNpmPublishWriterContract } from './npm-publish-writer-contract.js';
import { describeNpmLoginContract } from './npm-login-contract.js';
import { describeOidcContract } from './oidc-contract.js';

interface Database {
  executor: SqlExecutor;
  bytes?: ByteStore;
  close(): Promise<void>;
}

export function describeNpmPublishAdversarial(name: string, open: () => Promise<Database>) {
  describe(`npm adversarial integration gate: ${name}`, () => {
    // Keep the race proofs coupled to the complete real writer, scanner, login and OIDC flows.
    describeNpmPublishWriterContract(name, open);
    describeNpmLoginContract(name, open);
    describeOidcContract(name, open);

    async function blobs(body: (db: Database, directory: string) => Promise<void>) {
      const db = await open();
      const directory = await mkdtemp(join(await realpath(tmpdir()), 'npm21-'));
      try {
        await db.executor.all({
          sql: "INSERT INTO organization (id,slug,name) VALUES ('org','org','Organization')",
          params: [],
        });
        await body(db, directory);
      } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
      }
    }

    async function storage(db: Database, directory: string) {
      const runtime = '../../../runtime-node/src/blob/filesystem.ts';
      const { openFilesystemByteStore } = await import(new URL(runtime, import.meta.url).href);
      const bytes = db.bytes ?? (await openFilesystemByteStore({ root: directory }));
      return {
        bytes,
        store: createBlobStore(bytes, createBlobRepository(db.executor), {
          admission: createBlobUploadAdmission(),
        }),
      };
    }

    it('cancelled upload leaves no staging, blob, version or publication audit', () =>
      blobs(async (db, directory) => {
        const { bytes, store } = await storage(db, directory);
        let reads = 0;
        await expect(
          store.stage(
            orgContext('org'),
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
                else controller.error(new Error('upload_cancelled'));
              },
            }),
            { maxBytes: 1024, mediaType: 'application/gzip' },
          ),
        ).rejects.toThrow('upload_cancelled');
        expect(await bytes.listStaged('2099-01-01T00:00:00.000Z')).toEqual([]);
        for (const table of ['blob', 'version', 'audit_pending'])
          expect(await db.executor.all({ sql: `SELECT id FROM ${table}`, params: [] })).toEqual([]);
      }));

    it('promote then crash leaves an invisible non-refetchable orphan and a restart can retry', () =>
      blobs(async (db, directory) => {
        const ctx = orgContext('org');
        const first = await storage(db, directory);
        const input = { maxBytes: 1024, mediaType: 'application/gzip' };
        const staged = await first.store.stage(ctx, new Blob(['publish bytes']).stream(), input);
        const promoted = await first.store.promote(ctx, staged, { refetchable: false });
        expect(promoted.sha256).toBe(staged.sha256);
        expect(await first.bytes.listStaged('2099-01-01T00:00:00.000Z')).toEqual([]);
        // The process dies here, before the catalogue transaction attaches the promoted bytes.
        for (const table of ['package', 'version', 'audit_pending'])
          expect(await db.executor.all({ sql: `SELECT id FROM ${table}`, params: [] })).toEqual([]);
        expect(
          await db.executor.all({
            sql: 'SELECT refetchable FROM blob WHERE org_id=? AND sha256=?',
            params: [ctx.orgId, staged.sha256],
          }),
        ).toEqual([{ refetchable: 0 }]);
        const restarted = await storage(db, directory);
        const retry = await restarted.store.stage(ctx, new Blob(['publish bytes']).stream(), input);
        expect(await restarted.store.promote(ctx, retry, { refetchable: false })).toMatchObject({
          sha256: staged.sha256,
          size: staged.size,
        });
        expect(
          await db.executor.all({
            sql: 'SELECT count(*) AS n FROM blob WHERE org_id=? AND sha256=?',
            params: [ctx.orgId, staged.sha256],
          }),
        ).toEqual([{ n: 1 }]);
        const read = await restarted.store.get(ctx, staged.sha256);
        expect(await new Response(read!.body).text()).toBe('publish bytes');
        expect(await restarted.store.get(orgContext('foreign'), staged.sha256)).toBeNull();
        const lifecycle = createBlobRepository(db.executor);
        expect(await lifecycle.scheduleOrphan(ctx, staged.sha256)).toBe(false);
        await db.executor.all({
          sql: "UPDATE blob SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE org_id=? AND sha256=?",
          params: [ctx.orgId, staged.sha256],
        });
        expect(
          await createBlobReferenceReader(db.executor).candidates(ctx, { limit: 10 }),
        ).toMatchObject([{ sha256: staged.sha256, orphan: true }]);
        expect(await lifecycle.scheduleOrphan(ctx, staged.sha256)).toBe(true);
        expect(await lifecycle.claimPurge(ctx, staged.sha256)).not.toBeNull();
      }));
  });
}
