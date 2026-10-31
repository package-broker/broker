import { expect, it, vi } from 'vitest';
import * as failures from '@package-broker/core/audit/failure-events';
import type { SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid, systemClock } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import type { D1DatabaseLike, D1PreparedStatementLike } from './db/d1-executor.js';
import { createWorker } from './index.js';
import type { R2BucketLike } from './blob/r2.js';

it('keeps Worker staging alive through waitUntil and shares one recorder across cached applications', async () => {
  const database = await openMigratedDatabase();
  const org = await createOrganizationBootstrap(database.executor).bootstrap({
    id: ulid(),
    slug: 'test',
    name: 'Test',
    now: new Date().toISOString(),
  });
  let release!: () => void;
  let started!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stagingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  function prepare(statement: Statement): D1PreparedStatementLike {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await database.executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  }
  const db: D1DatabaseLike = {
    prepare: (sql) => prepare({ sql, params: [] }),
    async batch(batch) {
      const bound = batch.map((statement) => statements.get(statement)!);
      if (bound.some((statement) => /INSERT INTO audit_pending/i.test(statement.sql))) {
        started();
        await hold;
      }
      return (await database.executor.batch(bound)).map((result) => ({
        results: result.rows,
        meta: { changes: result.changes },
      }));
    },
  };
  const originalCreate = failures.createFailureEvents;
  const create = vi.spyOn(failures, 'createFailureEvents').mockImplementation((...args) => {
    const recorder = originalCreate(...args);
    vi.spyOn(recorder, 'record');
    return recorder;
  });
  const output = { log: vi.fn(), error: vi.fn() };
  const clock = vi.spyOn(systemClock, 'now').mockReturnValue(new Date('2026-10-30T10:00:12.000Z'));
  const worker = createWorker([], {
    audit: { acceptNoDurableAudit: true },
    log: () => undefined,
    console: output,
    platformPorts: {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
      cache: { adapter: 'cache-api', namespace: 'failure-test' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
      observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      }),
    },
  });
  const env = {
    DB: db,
    DEPLOYMENT_ID: 'first',
    STORAGE: {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      delete: async () => undefined,
    } as unknown as R2BucketLike,
    JOBS: { send: async () => undefined, sendBatch: async () => undefined },
    PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    PB_PUBLIC_URL: 'https://broker.test',
  };
  const work: Promise<unknown>[] = [];
  const request = (origin: string) =>
    new Request(`${origin}/_pb/auth/local/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'unknown@example.test',
        password: 'private password',
        code: '123456',
      }),
    });
  try {
    const response = await worker.fetch(request(env.PB_PUBLIC_URL), env, {
      waitUntil: (promise) => {
        work.push(promise);
      },
    });
    expect(response.status).toBe(401);
    await stagingStarted;
    expect(work.length).toBeGreaterThan(0);
    let settled = false;
    const draining = Promise.all(work).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await draining;
    // Eight new configurations evict the first application from the bounded cache.
    for (let index = 0; index < 8; index++) {
      const origin = `https://other-${index}.test`;
      await worker.services({ ...env, PB_PUBLIC_URL: origin });
    }
    clock.mockReturnValue(new Date('2026-10-30T10:01:12.000Z'));
    const secondEnv = { ...env, DEPLOYMENT_ID: 'second' };
    const otherOrigin = env.PB_PUBLIC_URL;
    expect(
      (
        await worker.fetch(
          request(otherOrigin),
          { ...secondEnv, PB_PUBLIC_URL: otherOrigin },
          {
            waitUntil: (promise) => {
              work.push(promise);
            },
          },
        )
      ).status,
    ).toBe(401);
    await Promise.all(work);
    expect(create).toHaveBeenCalledExactlyOnceWith();
    const recorder: ReturnType<typeof failures.createFailureEvents> = create.mock.results[0]!.value;
    const record = vi.mocked(recorder.record);
    expect(
      (
        await worker.fetch(
          request(otherOrigin),
          { ...secondEnv, PB_PUBLIC_URL: otherOrigin },
          {
            waitUntil: (promise) => {
              work.push(promise);
            },
          },
        )
      ).status,
    ).toBe(401);
    await Promise.all(work);
    const firstBinding = record.mock.calls[0]![2]!;
    const binding = record.mock.calls.at(-1)![2]!;
    expect(firstBinding.deploymentId).toBe('first');
    expect(binding.deploymentId).toBe('second');
    expect(binding).not.toBe(firstBinding);
    expect(output.log).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'pb.audit.failure_events_suppressed',
        deployment_id: 'second',
      }),
    );
    expect(binding.staging).not.toBe(firstBinding.staging);
    expect(binding.observability).not.toBe(firstBinding.observability);
    expect(binding.now).not.toBe(firstBinding.now);
    expect(binding.routeTemplates.has('/_pb/auth/local/login')).toBe(true);
    // Authorization failures use the same runtime recorder and compiled template registry.
    await recorder.record(
      record.mock.calls[0]![0],
      {
        action: 'access.denied',
        actor: { type: 'user', id: ulid() },
        routeTemplate: '/_pb/auth/local/login',
        permission: 'org:audit:read',
        boundary: 'organization',
        context: { sourceIp: null },
      },
      binding,
    );
    await recorder.drain(record.mock.calls[0]![0]);
    record.mockRestore();
    const rows = await database.executor.all({
      sql: "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'session.login_failed'",
      params: [org.id],
    });
    expect(rows).toHaveLength(2);
    expect(
      await database.executor.all({
        sql: "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'access.denied'",
        params: [org.id],
      }),
    ).toHaveLength(1);
  } finally {
    release();
    await Promise.all(work);
    clock.mockRestore();
    create.mockRestore();
    await database.close();
  }
});
