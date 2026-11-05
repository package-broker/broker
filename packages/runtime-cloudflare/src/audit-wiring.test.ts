import { noopObservability } from '@package-broker/core/platform/observability';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { orgContext } from '@package-broker/core/db/port';
import { createHash, randomBytes } from 'node:crypto';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import * as apiModule from '@package-broker/db-sqlite/repositories/api-services';
import * as auditModule from './audit.js';
import { hashRow, type AuditRow } from '@package-broker/core/audit/chain';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { ulid } from '@package-broker/core/ids';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import type { PluginDefinition } from '@package-broker/core/plugin';
import type { SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createWorker, type Env } from './index.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './db/d1-executor.js';
import type { R2BucketLike } from './blob/r2.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
  cache: { adapter: 'cache-api', namespace: 'audit-test' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/trail',
  apiVersion: 4,
  platforms: ['cloudflare'],
  binds: ['audit-trail'],
  auditTrail: {
    toggleEnv: 'PB_AUDIT_TRAIL',
    create: (context) => ({
      async handle(...args) {
        const [operation] = args;
        if (operation === 'auditHead') {
          const head = await context.journal.head();
          return {
            seq: head.headSeq,
            hash: head.headHash,
            pendingCount: head.pendingCount,
            lastVerifiedAt: null,
            verification: null,
          };
        }
        return { items: [], next: null };
      },
    }),
  },
};
function binding(executor: SqlExecutor): D1DatabaseLike {
  const statements = new WeakMap<D1PreparedStatementLike, Statement>();
  const prepare = (statement: Statement): D1PreparedStatementLike => {
    const bound: D1PreparedStatementLike = {
      bind: (...params) => prepare({ sql: statement.sql, params: params as SqlValue[] }),
      all: async () => ({ results: await executor.all(statement) }),
    };
    statements.set(bound, statement);
    return bound;
  };
  return {
    prepare: (sql) => prepare({ sql, params: [] }),
    batch: async (batch) =>
      (await executor.batch(batch.map((statement) => statements.get(statement)!))).map(
        (result) => ({ results: result.rows, meta: { changes: result.changes } }),
      ),
  };
}
function workerEnv(executor: SqlExecutor, variables: Record<string, string> = {}): Env {
  return {
    DB: binding(executor),
    STORAGE: {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      delete: async () => {},
    } as unknown as R2BucketLike,
    JOBS: { send: async () => {}, sendBatch: async () => {} },
    DEPLOYMENT_ID: 'audit-test',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: 'https://broker.test',
    ...variables,
  };
}
function workerOptions() {
  const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
  return {
    platformPorts,
    log: () => {},
    console: { log: () => {}, error: () => {} },
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => {},
        delete: async () => false,
      }),
    },
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: 'session', csrfHash: '0'.repeat(64) },
          user: { id: 'reader' },
          identity: null,
          protectedHolder: true,
          project: null,
          organizationPermissions: PERMISSIONS.map((permission) => permission.name),
          projectPermissions: [],
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: { keyring, nowMs: Date.now, dispatch: () => {}, log: () => {} },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    }),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Worker audit assembly on a Node SQLite D1 binding', () => {
  it.each(['on', 'off'] as const)(
    'uses the effective %s toggle for me, status and the composed journal',
    async (toggle) => {
      const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
      const worker = createWorker([trail], {
        ...workerOptions(),
        audit: { capacity, acceptNoDurableAudit: true },
      });
      const env = workerEnv(database.executor, { PB_AUDIT_TRAIL: toggle });
      const fetch = (path: string) =>
        worker.fetch(
          new Request(`https://broker.test/_pb/${path}`, {
            headers: { cookie: `__Host-pb_session=${'A'.repeat(43)}` },
          }),
          env,
        );
      try {
        const me = await fetch('me');
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ features: { auditTrail: toggle === 'on' } });
        const status = await fetch('audit/status');
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({
          mode: toggle === 'on' ? 'trail' : 'none',
          trailActive: toggle === 'on',
          capacity: { maxJournalBytes: capacity.maxJournalBytes },
        });
        if (toggle === 'on') {
          await database.executor.batch([
            auditPendingStatement(database.orgs!.a, {
              id: ulid(),
              occurredAt: new Date().toISOString(),
              actor: { type: 'system', id: null },
              tokenSelector: null,
              sourceIp: null,
              action: 'project.update',
              target: { type: 'project', id: null },
              projectId: null,
              payloadJson: '{}',
            }),
          ]);
          await createAuditSealRepository(database.executor, capacity).seal(database.orgs!.a);
        }
        const head = await fetch('audit/head');
        expect(head.status).toBe(toggle === 'on' ? 200 : 404);
        if (toggle === 'on') {
          const body = await head.json();
          expect(body).toMatchObject({ seq: 1, pendingCount: 0 });
          expect(body).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
          expect(body).not.toMatchObject({ hash: '0'.repeat(64) });
        }
        expect((await fetch('audit/health')).status).toBe(200);
      } finally {
        await database.close();
      }
    },
  );
  it('refuses ordinary writes after all paths of a stored required organization are removed', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const org = database.orgs!.a;
    await database.executor.batch([
      { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
    ]);
    const worker = createWorker([], { ...workerOptions(), audit: { capacity } });
    const env = workerEnv(database.executor);
    try {
      const response = await worker.fetch(
        new Request('https://broker.test/_pb/projects', {
          method: 'POST',
          headers: { origin: 'https://broker.test' },
        }),
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.has('retry-after')).toBe(false);
      expect(await response.json()).toMatchObject({ error: { code: 'durable_path_required' } });
      expect(
        (
          await worker.fetch(
            new Request('https://broker.test/_pb/auth/local/login', {
              method: 'POST',
              headers: { origin: 'https://broker.test' },
            }),
            env,
          )
        ).status,
      ).toBe(400);
    } finally {
      await database.close();
    }
  });
  it('maps transient organization audit failures to a retryable response', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const all = vi.fn(database.executor.all);
    const worker = createWorker([trail], { ...workerOptions(), audit: { capacity } });
    const env = workerEnv({ ...database.executor, all: all as SqlExecutor['all'] });
    try {
      expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
        200,
      );
      all.mockImplementation((query) => {
        if (query.sql.includes('FROM audit_chain')) throw new Error('unavailable');
        return database.executor.all(query);
      });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      const response = await worker.fetch(new Request('https://broker.test/_pb/me'), env);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.json()).toMatchObject({ error: { code: 'audit_unavailable' } });
    } finally {
      await database.close();
    }
  });
});

it('refuses a required organization at the production journal budget and restores ordinary writes through the maintain job', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const org = database.orgs!.a;
  const count = 16_000;
  const destination: PluginDefinition = {
    id: 'archive',
    package: '@test/archive',
    apiVersion: 4,
    platforms: ['cloudflare'],
    auditSinks: [
      {
        id: 'archive',
        kind: 'webhook',
        activation: 'build',
        custody: 'durable',
        sourceIp: 'omit',
        destination: {
          protocol: 'https-json',
          urlEnv: 'ARCHIVE_URL',
          headersEnv: 'ARCHIVE_HEADERS',
        },
        create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
      },
    ],
  };
  const writer: PluginDefinition = {
    id: 'writer',
    package: '@test/writer',
    apiVersion: 4,
    platforms: ['cloudflare'],
    register(registry) {
      registry.route({
        method: 'POST',
        path: '/fixture/write',
        permission: null,
        async handler() {
          await database.executor.batch([
            {
              sql: "INSERT INTO project (id, org_id, slug, name) VALUES ('ordinary', ?, 'ordinary', 'Ordinary')",
              params: [org.orgId],
            },
            auditPendingStatement(org, {
              id: ulid(),
              occurredAt: new Date().toISOString(),
              actor: { type: 'system', id: null },
              tokenSelector: null,
              sourceIp: null,
              action: 'project.update',
              target: { type: 'project', id: null },
              projectId: null,
              payloadJson: '{}',
            }),
          ]);
          return new Response(null, { status: 204 });
        },
      });
    },
  };
  const worker = createWorker([destination, writer], {
    ...workerOptions(),
    audit: { capacity, policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
  });
  const env = workerEnv(database.executor, {
    ARCHIVE_URL: 'https://archive.example.test',
    ARCHIVE_HEADERS: 'Authorization=fixture',
    ALERT_URL: 'https://alerts.example.test',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  const jobs = createJobRepository(database.executor);
  const run = async (name: string) => {
    const queued = await jobs.enqueue(org, {
      id: ulid(),
      type: `core:${name}:v1`,
      payloadJson: '{}',
      idempotencyKey: ulid(),
      maxAttempts: 3,
      resourceKey: name.startsWith('audit-export-')
        ? `audit-export:${name.slice('audit-export-'.length)}`
        : name,
      projectId: null,
      initiatorTokenId: null,
      runAt: new Date().toISOString(),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      { messages: [{ body: { v: 1, org: org.orgId, job: queued.id }, ack, retry }] },
      env,
    );
    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(await jobs.status(org, queued.id)).toMatchObject({ state: 'succeeded' });
  };
  try {
    expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
      200,
    );
    let prev = '0'.repeat(64);
    let bytes = 0;
    let statements: Statement[] = [];
    for (let seq = 1; seq <= count; seq++) {
      const row: AuditRow = {
        id: ulid(),
        org_id: org.orgId,
        seq,
        prev_hash: prev,
        hash: '',
        created_at: new Date().toISOString(),
        actor_type: 'system',
        actor_id: null,
        token_selector: null,
        source_ip: null,
        action: 'project.update',
        target_type: 'project',
        target_id: null,
        project_id: null,
        payload_json: JSON.stringify('x'.repeat(4000)),
      };
      row.hash = await hashRow(prev, row);
      prev = row.hash;
      bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
      const keys = Object.keys(row) as (keyof AuditRow)[];
      statements.push({
        sql: `INSERT INTO audit_event (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        params: keys.map((key) => row[key]),
      });
      if (statements.length === 100) {
        await database.executor.batch(statements);
        statements = [];
      }
    }
    expect(bytes).toBeGreaterThanOrEqual(capacity.maxJournalBytes);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = ?, head_hash = ?, journal_rows = ?, journal_bytes = ? WHERE org_id = ?',
        params: [count, prev, count, bytes, org.orgId],
      },
    ]);
    await run('audit-seal');
    const write = () =>
      worker.fetch(new Request('https://broker.test/fixture/write', { method: 'POST' }), env);
    const refused = await write();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: 'audit_backlog_full' } });
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM project WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([]);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_sink SET progress_seq = ?, custody_seq = ? WHERE org_id = ?',
        params: [count, count, org.orgId],
      },
    ]);
    for (let attempt = 0; attempt < 40; attempt++) {
      await run('audit-maintain');
      const [chain] = await database.executor.all<{ capacity_state: string }>({
        sql: 'SELECT capacity_state FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      });
      if (chain?.capacity_state === 'ok') break;
    }
    expect((await write()).status).toBe(204);
    expect(
      await database.executor.all({
        sql: 'SELECT capacity_state, journal_rows FROM audit_chain WHERE org_id = ?',
        params: [database.orgs!.b.orgId],
      }),
    ).toEqual([{ capacity_state: 'ok', journal_rows: 0 }]);
  } finally {
    await database.close();
  }
}, 60_000);

it('dispatches export and maintain through the Worker queue during a conflicting pending cutover', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const org = database.orgs!.a;
  const deliver = vi.fn(async (batch: import('@package-broker/core/plugin').AuditBatchV1) => ({
    outcome: 'accepted' as const,
    chainId: batch.chainId,
    epoch: batch.epoch,
    throughSeq: batch.throughSeq,
    throughHash: batch.throughHash,
  }));
  const sink: PluginDefinition = {
    id: 'archive',
    package: '@test/archive',
    apiVersion: 4,
    platforms: ['cloudflare'],
    auditSinks: [
      {
        id: 'archive',
        kind: 'webhook',
        activation: 'env',
        custody: 'durable',
        sourceIp: 'omit',
        destination: {
          protocol: 'https-json',
          urlEnv: 'ARCHIVE_URL',
          headersEnv: 'ARCHIVE_HEADERS',
        },
        create: () => ({ deliver }),
      },
    ],
  };
  const worker = createWorker([trail, sink], { ...workerOptions(), audit: { capacity } });
  const env = workerEnv(database.executor, {
    ARCHIVE_URL: 'https://archive.example.test',
    ARCHIVE_HEADERS: 'Authorization=fixture',
  });
  const jobs = createJobRepository(database.executor);
  const run = async (name: string) => {
    const queued = await jobs.enqueue(org, {
      id: ulid(),
      type: `core:${name}:v1`,
      payloadJson: '{}',
      idempotencyKey: ulid(),
      maxAttempts: 3,
      resourceKey: name.startsWith('audit-export-')
        ? `audit-export:${name.slice('audit-export-'.length)}`
        : name,
      projectId: null,
      initiatorTokenId: null,
      runAt: new Date().toISOString(),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      { messages: [{ body: { v: 1, org: org.orgId, job: queued.id }, ack, retry }] },
      env,
    );
    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(await jobs.status(org, queued.id)).toMatchObject({ state: 'succeeded' });
  };
  try {
    expect((await worker.fetch(new Request('https://broker.test/health/live'), env)).status).toBe(
      200,
    );
    await database.executor.batch([
      auditPendingStatement(org, {
        id: ulid(),
        occurredAt: new Date().toISOString(),
        actor: { type: 'system', id: null },
        tokenSelector: null,
        sourceIp: null,
        action: 'project.update',
        target: { type: 'project', id: null },
        projectId: null,
        payloadJson: '{}',
      }),
    ]);
    await run('audit-seal');
    await database.executor.batch([
      {
        sql: "UPDATE audit_chain SET pending_mode = 'export', cutover_seq = head_seq WHERE org_id = ?",
        params: [org.orgId],
      },
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    expect(
      await database.executor.all({
        sql: 'SELECT head_seq, journal_rows, restore_pending FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ head_seq: 1, journal_rows: 1, restore_pending: 0 }]);
    expect(
      await database.executor.all({
        sql: 'SELECT state, progress_seq, custody_seq FROM audit_sink WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ state: 'active', progress_seq: 0, custody_seq: 0 }]);
    await run('audit-export-archive');
    expect(
      await database.executor.all({
        sql: 'SELECT state, progress_seq, custody_seq, last_error_code FROM audit_sink WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ state: 'active', progress_seq: 1, custody_seq: 1, last_error_code: null }]);
    expect(deliver).toHaveBeenCalled();
    await run('audit-maintain');
    expect(
      await database.executor.all({
        sql: 'SELECT mode, pending_mode, journal_rows FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ mode: 'export', pending_mode: null, journal_rows: 0 }]);
  } finally {
    await database.close();
  }
});

it.each(['invalid', 'https://user:fixture@invalid.test'])(
  'refuses malformed effective configuration at Worker boot without exposing its value (%#)',
  async (value) => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const logs: unknown[] = [];
    const worker = createWorker([trail], {
      ...workerOptions(),
      audit: { capacity },
      log: (record) => {
        logs.push(record);
      },
    });
    try {
      const response = await worker.fetch(
        new Request('https://broker.test/health/live'),
        workerEnv(database.executor, { PB_AUDIT_TRAIL: value }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'misconfigured', message: 'Server is not configured' },
      });
      expect(JSON.stringify(logs)).not.toContain(value);
    } finally {
      await database.close();
    }
  },
);

it('defers ordinary queue and scheduled jobs on a definitive refusal and retries after reconfiguration', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const org = database.orgs!.a;
  await database.executor.batch([
    { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
  ]);
  const handler = vi.fn(async () => {});
  const ordinary: PluginDefinition = {
    id: 'ordinary',
    package: '@test/ordinary',
    apiVersion: 4,
    platforms: ['cloudflare'],
    register(registry) {
      for (const name of ['queued', 'scheduled'])
        registry.job({
          name,
          version: 1,
          validate: () => ({}),
          handler,
          ...(name === 'scheduled' ? { schedule: { everySeconds: 60 } } : {}),
        });
    },
  };
  const log = vi.fn();
  const worker = createWorker([ordinary], {
    ...workerOptions(),
    audit: { capacity },
    log,
    console: { log, error: log },
  });
  const env = workerEnv(database.executor);
  const jobs = createJobRepository(database.executor);
  try {
    await worker.services(env);
    const queued = await jobs.enqueue(org, {
      id: ulid(),
      type: 'ordinary:queued:v1',
      payloadJson: '{}',
      idempotencyKey: ulid(),
      maxAttempts: 1,
      resourceKey: null,
      projectId: null,
      initiatorTokenId: null,
      runAt: new Date().toISOString(),
    });
    await database.executor.batch([
      {
        sql: "INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled) VALUES (?, 'ordinary:scheduled:v1', 60, '2000-01-01T00:00:00.000Z', 1)",
        params: [org.orgId],
      },
    ]);
    await worker.scheduled({}, env);
    const rows = await database.executor.all<{ id: string }>({
      sql: "SELECT id FROM job WHERE org_id = ? AND type LIKE 'ordinary:%'",
      params: [org.orgId],
    });
    expect(rows).toHaveLength(2);
    expect(rows.some(({ id }) => id === queued.id)).toBe(true);
    const deliver = async (target: ReturnType<typeof createWorker>, targetEnv: Env) => {
      for (const { id } of rows) {
        const ack = vi.fn();
        const retry = vi.fn();
        await target.queue(
          { messages: [{ body: { v: 1, org: org.orgId, job: id }, ack, retry }] },
          targetEnv,
        );
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
      }
    };
    await deliver(worker, env);
    await deliver(worker, env);
    expect(handler).not.toHaveBeenCalled();
    for (const { id } of rows)
      expect(await jobs.status(org, id)).toMatchObject({ state: 'queued', attempts: 0 });
    expect(
      log.mock.calls.filter(([record]) => record.event === 'audit.effective_unavailable'),
    ).toHaveLength(1);
    const recovered = createWorker([ordinary, trail], {
      ...workerOptions(),
      audit: { capacity, alerts: { webhookEnv: 'ALERT_URL' } },
    });
    const recoveredEnv = workerEnv(database.executor, { ALERT_URL: 'https://alerts.example.test' });
    await recovered.services(recoveredEnv);
    await database.executor.batch([
      {
        sql: "UPDATE job SET run_at = ? WHERE org_id = ? AND type LIKE 'ordinary:%'",
        params: [new Date(Date.now() - 1000).toISOString(), org.orgId],
      },
    ]);
    await deliver(recovered, recoveredEnv);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const { id } of rows)
      expect(await jobs.status(org, id)).toMatchObject({ state: 'succeeded' });
  } finally {
    await database.close();
  }
});

it('resolves configuration at application build and probes only in the frontier job', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const frontier = vi.fn(async () => null);
  const sink: PluginDefinition = {
    id: 'archive',
    package: '@test/archive',
    apiVersion: 4,
    platforms: ['cloudflare'],
    auditSinks: [
      {
        id: 'archive',
        kind: 'webhook',
        activation: 'env',
        custody: 'durable',
        sourceIp: 'omit',
        destination: {
          protocol: 'https-json',
          urlEnv: 'ARCHIVE_URL',
          headersEnv: 'ARCHIVE_HEADERS',
        },
        create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }), frontier }),
      },
    ],
  };
  const worker = createWorker([sink], { ...workerOptions(), audit: { capacity } });
  const env = workerEnv(database.executor, {
    ARCHIVE_URL: 'https://archive.example.test',
    ARCHIVE_HEADERS: 'Authorization=fixture',
  });
  try {
    await worker.services(env);
    expect(frontier).not.toHaveBeenCalled();
    const [chain] = await database.executor.all({
      sql: 'SELECT mode FROM audit_chain WHERE org_id = ?',
      params: [database.orgs!.a.orgId],
    });
    expect(chain).toEqual({ mode: 'export' });
    const jobs = createJobRepository(database.executor);
    const queued = await jobs.enqueue(database.orgs!.a, {
      id: ulid(),
      type: 'core:audit-frontier:v1',
      payloadJson: '{}',
      idempotencyKey: ulid(),
      maxAttempts: 3,
      resourceKey: 'audit-frontier',
      projectId: null,
      initiatorTokenId: null,
      runAt: new Date().toISOString(),
    });
    await worker.queue(
      {
        messages: [
          {
            body: { v: 1, org: database.orgs!.a.orgId, job: queued.id },
            ack: () => {},
            retry: () => {},
          },
        ],
      },
      env,
    );
    expect(frontier).toHaveBeenCalledOnce();
  } finally {
    await database.close();
  }
});

it.each(['service', 'job'] as const)(
  'fails an audit schedule when its %s is unavailable',
  async (missing) => {
    const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const org = database.orgs!.a;
    const original = auditModule.createWorkerAudit;
    const spy = vi.spyOn(auditModule, 'createWorkerAudit').mockImplementation(async (input) => {
      if (missing === 'service') return undefined as never;
      return { ...(await original(input)), jobs: [] };
    });
    const kernelSpy = vi.spyOn(kernelModule, 'createKernel');
    const worker = createWorker([trail], { ...workerOptions(), audit: { capacity } });
    await worker.services(workerEnv(database.executor));
    const kernel: Awaited<ReturnType<typeof kernelModule.createKernel>> =
      await kernelSpy.mock.results.at(-1)!.value;
    try {
      const job = kernel.registration.jobs.find(
        (job) => job.qualifiedName === 'core:audit-frontier:v1',
      )!;
      await expect(
        job.definition.handler(
          {},
          {
            ...kernel.jobScope(job, { jobId: ulid(), attempt: 1 }),
            org,
            jobId: ulid(),
            idempotencyKey: ulid(),
            attempt: 1,
            fence: 1,
            signal: AbortSignal.timeout(1000),
          },
        ),
      ).rejects.toMatchObject({ name: 'PlatformUnavailableError' });
    } finally {
      spy.mockRestore();
      kernelSpy.mockRestore();
      await database.close();
    }
  },
);

it('keeps a withheld request alert alive through waitUntil', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const raise = vi.fn(async () => held);
  const original = auditModule.createWorkerAudit;
  vi.spyOn(auditModule, 'createWorkerAudit').mockImplementation(async (input) => ({
    ...(await original(input)),
    raise,
  }));
  const routes = apiModule.createApiRoutes;
  vi.spyOn(apiModule, 'createApiRoutes').mockImplementation((input) =>
    routes(input).map((route) =>
      route.path !== '/_pb/me'
        ? route
        : {
            ...route,
            handler: async (context) => {
              input.auditAlerts!.raise(database.orgs!.a, 'withheld');
              return route.handler(context);
            },
          },
    ),
  );
  const pending: Promise<unknown>[] = [];
  const worker = createWorker([trail], { ...workerOptions(), audit: { capacity } });
  try {
    const response = await worker.fetch(
      new Request('https://broker.test/_pb/me', {
        headers: { cookie: `__Host-pb_session=${'A'.repeat(43)}` },
      }),
      workerEnv(database.executor),
      {
        waitUntil: (work) => {
          pending.push(work);
        },
      },
    );
    expect(response.status).toBe(200);
    expect(pending.length).toBeGreaterThan(0);
    expect(raise).toHaveBeenCalledWith(database.orgs!.a, 'audit.withheld');
    release();
    await Promise.all(pending);
  } finally {
    release();
    await database.close();
  }
});

it.each(['none_not_accepted', 'durable_path_required'] as const)(
  'allows first-admin setup while %s fences other writes',
  async (code) => {
    const database = await openMigratedDatabase({ d1PatternLimit: true });
    const org = orgContext(ulid());
    await createOrganizationBootstrap(database.executor).bootstrap({
      id: org.orgId,
      slug: 'setup',
      name: 'Setup',
      now: new Date().toISOString(),
    });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    expect(
      await bootstrapAdmin(database.executor, org, {
        email: 'setup@example.test',
        userId: ulid(),
        setupHash: createHash('sha256').update(token).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])) as Record<
          DefaultRoleKey,
          string
        >,
        opId: ulid(),
        now: now.toISOString(),
      }),
    ).toBe('created');
    if (code === 'durable_path_required')
      await database.executor.batch([
        { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
      ]);
    const worker = createWorker([], { ...workerOptions(), audit: { capacity } });
    const env = workerEnv(database.executor);
    const send = (request: Request) => worker.fetch(request, env);
    const audit = await auditModule.createWorkerAudit({
      config: { platform: 'cloudflare', plugins: [], audit: { capacity } },
      env: () => undefined,
      executor: database.executor,
      observability: noopObservability,
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => collectRegistrations([]),
    });
    const post = (path: string, body: unknown = {}) =>
      send(
        new Request(`https://broker.test/_pb/${path}`, {
          method: 'POST',
          headers: { origin: 'https://broker.test', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    try {
      const assertFenced = async () => {
        for (const [method, path] of [
          ['POST', 'auth/local/setup/other'],
          ['POST', 'auth/sso/provider/callback'],
          ['PUT', 'auth/local/setup/start'],
          ['DELETE', 'auth/local/setup/finish'],
        ] as const) {
          await expect(
            audit.resolveRequest(org, new Request(`https://broker.test/_pb/${path}`, { method })),
          ).rejects.toMatchObject({ code });
        }
        for (const path of ['projects']) {
          const response = await post(path);
          expect(response.status, path).toBe(503);
          expect(response.headers.has('retry-after'), path).toBe(false);
          expect(await response.json()).toMatchObject({ error: { code } });
        }
      };
      await assertFenced();
      const started = await post('auth/local/setup/start', { token });
      expect(started.status).toBe(200);
      const { secret } = (await started.json()) as { secret: string };
      const finished = await post('auth/local/setup/finish', {
        token,
        password: 'correct horse battery staple 42',
        code: await totpCode(base32Decode(secret), Math.floor(Date.now() / 30_000)),
      });
      expect(finished.status).toBe(204);
      expect(
        finished.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-pb_session=')),
      ).toBe(true);
      await assertFenced();
    } finally {
      await database.close();
    }
  },
);

const inactiveSinks: PluginDefinition = {
  id: 'inactive-sinks',
  package: '@test/inactive-sinks',
  apiVersion: 4,
  platforms: ['cloudflare'],
  auditSinks: [
    {
      id: 'otlp',
      kind: 'otlp',
      activation: 'env',
      custody: 'delivery',
      sourceIp: 'omit',
      destination: { protocol: 'otlp-http-json' },
      create: () => {
        throw new Error('Inactive sink created');
      },
    },
    {
      id: 'webhook',
      kind: 'webhook',
      activation: 'env',
      custody: 'delivery',
      sourceIp: 'omit',
      destination: {
        protocol: 'https-json',
        urlEnv: 'PB_AUDIT_WEBHOOK_URL',
        headersEnv: 'PB_AUDIT_WEBHOOK_HEADERS',
      },
      create: () => {
        throw new Error('Inactive sink created');
      },
    },
  ],
};

it('registers no export schedules for either unresolved prebuilt sink protocol', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const kernelSpy = vi.spyOn(kernelModule, 'createKernel');
  const worker = createWorker([trail, inactiveSinks], { ...workerOptions(), audit: { capacity } });
  try {
    await worker.services(workerEnv(database.executor));
    const kernel: Awaited<ReturnType<typeof kernelModule.createKernel>> =
      await kernelSpy.mock.results.at(-1)!.value;
    expect(
      kernel.registration.jobs.filter((job) => job.qualifiedName.startsWith('core:audit-export-')),
    ).toEqual([]);
    expect(
      kernel.registration.jobs.find((job) => job.qualifiedName === 'core:audit-head:v1')?.definition
        .schedule,
    ).toEqual({ everySeconds: 86400, resourceKey: 'audit-head' });
  } finally {
    await database.close();
  }
});
