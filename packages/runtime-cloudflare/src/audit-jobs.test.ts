import { describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import type { SqlValue, Statement } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import * as registryModule from '@package-broker/core/kernel/registry';
import * as coreJobsModule from '@package-broker/core/runtime/core-jobs';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { definePlugin } from '@package-broker/core/plugin';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createAuditVerifyReader } from '@package-broker/db-sqlite/repositories/audit-verify';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';
import type { R2BucketLike } from './blob/r2.js';

const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
  cache: { adapter: 'cache-api', namespace: 'audit-test' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

describe('Worker audit job configuration gate', () => {
  it.each(['PB_MASTER_KEY', 'PB_PUBLIC_URL'] as const)(
    'rejects missing %s before registering core or plugin jobs',
    async (missing) => {
      const register = vi.fn();
      const plugin = definePlugin({
        id: 'audit-test',
        package: 'test/audit-test',
        platforms: ['cloudflare'],
        apiVersion: 3,
        register,
      });
      const prepare = vi.fn(() => {
        throw new Error('unexpected database query');
      });
      const batch = vi.fn(async () => []);
      const worker = createWorker([plugin], {
        platformPorts,
        log: () => undefined,
        cacheStorage: {
          open: async () => ({
            match: async () => undefined,
            put: async () => undefined,
            delete: async () => false,
          }),
        },
      });
      const env: Env = {
        DB: { prepare, batch },
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
        } as unknown as R2BucketLike,
        JOBS: { send: async () => undefined, sendBatch: async () => undefined },
        DEPLOYMENT_ID: 'audit-test',
        ...(missing === 'PB_MASTER_KEY'
          ? { PB_PUBLIC_URL: 'https://broker.test' }
          : { PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' }),
      };
      const coreRegistration = vi.spyOn(coreJobsModule, 'registerCoreJob');
      const collection = vi.spyOn(registryModule, 'collectRegistrations');
      try {
        const response = await worker.fetch(new Request('https://broker.test/health/live'), env);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: 'misconfigured' } });
        expect(coreRegistration).not.toHaveBeenCalled();
        expect(collection).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
      } finally {
        collection.mockRestore();
        coreRegistration.mockRestore();
      }
    },
  );
});

async function localBinding() {
  const opened = openNodeSqliteExecutor(undefined, { d1PatternLimit: true });
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  function prepare(statement: Statement): D1PreparedStatementLike {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await opened.executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  }
  const db: D1DatabaseLike = {
    prepare: (sql) => prepare({ sql, params: [] }),
    batch: async (batch) =>
      (await opened.executor.batch(batch.map((statement) => statements.get(statement)!))).map(
        (result) => ({ results: result.rows, meta: { changes: result.changes } }),
      ),
  };
  return { db, close: opened.close };
}

async function miniflareBinding() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
    }),
  );
  try {
    const db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
    return { db, close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

describe.each([
  ['node:sqlite D1 binding', localBinding],
  ['Miniflare D1', miniflareBinding],
] as const)('Worker audit jobs and verification contract: %s', (_name, open) => {
  it('registers both schedules and verifies bounded sealed pages, then detects tampering', async () => {
    const { db, close } = await open();
    const spy = vi.spyOn(kernelModule, 'createKernel');
    try {
      const executor = createD1Executor(db);
      await migrate(executor, await discoveredMigrations(), { holder: 'audit-jobs-test' });
      const { a, b } = await seedTwoOrganizations(executor);
      const records: unknown[] = [];
      const worker = createWorker([], {
        platformPorts,
        console: {
          log: (record) => void records.push(record),
          error: (record) => void records.push(record),
        },
        cacheStorage: {
          open: async () => ({
            match: async () => undefined,
            put: async () => undefined,
            delete: async () => false,
          }),
        },
      });
      const env: Env = {
        DB: db,
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => null,
          delete: async () => undefined,
        } as unknown as R2BucketLike,
        JOBS: { send: async () => undefined, sendBatch: async () => undefined },
        DEPLOYMENT_ID: 'audit-test',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
      };
      expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
        200,
      );
      const registration = spy.mock.calls.at(-1)![0].registration!;
      expect(
        registration.jobs.map(({ qualifiedName, definition }) => [
          qualifiedName,
          definition.schedule,
        ]),
      ).toEqual([
        ['core:audit-seal:v1', { everySeconds: 60 }],
        ['core:audit-verify:v1', { everySeconds: 86400 }],
        ['core:import-apply:v1', undefined],
        ['core:import-rollback:v1', undefined],
        ['core:pat-offboarding:v1', undefined],
        ['core:pat-offboarding-sweep:v1', { everySeconds: 86400 }],
      ]);
      await executor.batch(
        [a, b].map((org) => ({
          sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 502)
              INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
              SELECT ? || '-' || printf('%04d', i), ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization'
              FROM n`,
          params: [org.orgId, org.orgId],
        })),
      );
      const repository = createJobRepository(executor);
      const run = async (name: string) => {
        const job = await repository.enqueue(a, {
          id: ulid(),
          type: name,
          payloadJson: '{}',
          idempotencyKey: crypto.randomUUID(),
          maxAttempts: 2,
          resourceKey: null,
          projectId: null,
          initiatorTokenId: null,
          runAt: new Date().toISOString(),
        });
        const ack = vi.fn();
        const retry = vi.fn();
        await worker.queue(
          { messages: [{ body: { v: 1, org: a.orgId, job: job.id }, ack, retry }] },
          env,
        );
        expect(retry).not.toHaveBeenCalled();
        expect(ack).toHaveBeenCalledOnce();
        expect(await repository.status(a, job.id)).toMatchObject({ state: 'succeeded' });
      };
      await run('core:audit-seal:v1');
      const reader = createAuditVerifyReader(executor);
      expect((await reader.page(a, 0, 2)).map((row) => [row.org_id, row.seq])).toEqual([
        [a.orgId, 1],
        [a.orgId, 2],
      ]);
      expect((await reader.page(a, 500, 500)).map((row) => row.seq)).toEqual([501, 502, 503]);
      expect(await reader.page(a, 503, 500)).toEqual([]);
      while ((await createAuditSealRepository(executor).seal(b)).outcome === 'sealed') {
        /* drain foreign pending pages */
      }
      expect((await reader.page(b, 500, 500)).map((row) => [row.org_id, row.seq])).toEqual([
        [b.orgId, 501],
        [b.orgId, 502],
        [b.orgId, 503],
      ]);
      expect((await reader.page(a, 0, 500)).every((row) => row.org_id === a.orgId)).toBe(true);
      await run('core:audit-verify:v1');
      expect(records).toContainEqual(
        expect.objectContaining({ event: 'audit.verified', rows: 503, head_seq: 503 }),
      );
      records.length = 0;
      await executor.batch([
        {
          sql: "UPDATE audit_event SET action = 'org.delete' WHERE org_id = ? AND seq = 501",
          params: [a.orgId],
        },
      ]);
      await run('core:audit-verify:v1');
      expect(records).toContainEqual(
        expect.objectContaining({ event: 'audit.chain_broken', seq: 501, reason: 'hash' }),
      );
      expect(records).not.toContainEqual(expect.objectContaining({ event: 'audit.verified' }));
    } finally {
      spy.mockRestore();
      await close();
    }
  }, 60_000);
});
