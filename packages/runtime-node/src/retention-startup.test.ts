import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { createOrgResolver } from '@package-broker/core/kernel/org';
import { blobStorageKey, type Sha256 } from '@package-broker/core/platform/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import * as filesystem from './blob/filesystem.js';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { startNode } from './startup.js';

// Exercises the private startup carrier and the runner's core-job fence injection together.
describe('Node retention startup assembly', () => {
  it.each(['retention-scan', 'blob-purge'])(
    'runs %s against the one filesystem store opened at startup',
    async (name) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'T910-retention-')));
      const open = vi.spyOn(filesystem, 'openFilesystemByteStore');
      let broker: Awaited<ReturnType<typeof startNode>> | undefined;
      let database: ReturnType<typeof openBetterSqliteExecutor> | undefined;
      try {
        const path = join(directory, 'broker.sqlite');
        broker = await startNode({
          plugins: [],
          migrations: await discoveredMigrations(),
          env: {
            PB_SQLITE_PATH: path,
            PB_BLOB_ROOT: join(directory, 'blobs'),
            PB_ORG_SLUG: 'retention',
            PB_ORG_NAME: 'Retention',
            PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            PB_PUBLIC_URL: 'http://127.0.0.1',
            DEPLOYMENT_ID: 'retention-test',
          },
          platformPorts: {
            blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
            cache: { adapter: 'lru', maxBytes: 1024 },
            jobs: { adapter: 'database', maxRunning: 1 },
            observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
          },
          stdout: { write: () => true, on: () => undefined },
          stderr: { write: () => true, on: () => undefined },
        });
        database = openBetterSqliteExecutor(path);
        const { executor } = database;
        const org = await createOrgResolver(createOrganizationBootstrap(executor))();
        const kernel = await broker.ready();
        const job = kernel.registration.jobs.find(
          (job) => job.qualifiedName === `core:${name}:v1`,
        )!;
        expect(job).toBeDefined();
        const platform = kernel.jobScope(job, { jobId: 'upload', attempt: 1 }).ports.platform!;
        expect(platform).not.toHaveProperty('retention');
        const body = new TextEncoder().encode('retention bytes');
        const sha = createHash('sha256').update(body).digest('hex') as Sha256;
        await platform.blob.put(
          org,
          sha,
          new ReadableStream({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
          { size: body.byteLength, mediaType: 'application/zip', refetchable: true },
        );
        const store = await open.mock.results[0]!.value;
        expect(await store.head(blobStorageKey(org.orgId, sha))).not.toBeNull();
        await executor.batch([
          {
            sql: `UPDATE blob SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), purge_after = ? WHERE org_id = ? AND sha256 = ?`,
            params: [name === 'blob-purge' ? '2000-01-01T00:00:00.000Z' : null, org.orgId, sha],
          },
        ]);
        const repository = createJobRepository(executor);
        const { id } = await repository.enqueue(org, {
          id: ulid(),
          type: job.qualifiedName,
          payloadJson: '{}',
          idempotencyKey: ulid(),
          maxAttempts: 2,
          resourceKey: null,
          projectId: null,
          initiatorTokenId: null,
          runAt: null,
        });
        await vi.waitFor(
          async () => {
            expect(await repository.status(org, id)).toMatchObject({ state: 'succeeded' });
          },
          { timeout: 10_000, interval: 25 },
        );
        expect(await store.head(blobStorageKey(org.orgId, sha))).toBeNull();
        expect(
          await executor.all({
            sql: 'SELECT deleted_at FROM blob WHERE org_id = ? AND sha256 = ?',
            params: [org.orgId, sha],
          }),
        ).toEqual([{ deleted_at: expect.any(String) }]);
        expect(open).toHaveBeenCalledOnce();
      } finally {
        await broker?.close();
        await database?.close();
        open.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
