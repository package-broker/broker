import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { Statement } from '@package-broker/core/db/port';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import {
  definePlugin,
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
} from '@package-broker/core/plugin';
import * as kernelModule from '@package-broker/core/kernel/kernel';
import { projectGrantKey } from '@package-broker/db-sqlite/repositories/project-grant';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import type { JobClaim } from '@package-broker/core/platform/job-repository';
import type { Jobs } from '@package-broker/core/platform/jobs';
import { systemClock, ulid } from '@package-broker/core/ids';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import {
  discoveredMigrations,
  openMigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';
import type { R2BucketLike } from './blob/r2.js';
import { createQueueHandler, jobNotification } from './jobs/consumer.js';
import { createPatJobHolder, patOffboardingRegistrations } from './token-jobs.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ANCHOR = 'oidc:https://idp.example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const OWNER = '01J0ROLEOWNER0000000000AA';
const PROJECT = '01J0PROJECT00000000000000A1';
const ACTOR = '01J0AAAAAAAAAAAAAAAAAAAAA1';
const TARGET = '01J0AAAAAAAAAAAAAAAAAAAAA2';
const SESSION = '01J0SESSION000000000000001';
const G_ACTOR = '01J0GRANT000000000000000A1';
const G_TARGET = '01J0GRANT000000000000000A2';

const plugin: PluginDefinition = definePlugin({
  id: 'probe',
  package: '@test/probe',
  apiVersion: SUPPORTED_PLUGIN_API[0],
  platforms: ['cloudflare'],
  binds: ['identity'],
  identityProviders: () => [
    {
      id: 'oidc',
      kind: 'oidc',
      displayName: 'Example',
      trustAnchor: ANCHOR,
      policy: {
        verifiedDomains: ['example.test'],
        emailAuthoritativeDomains: ['example.test'],
        autoJoin: false,
      },
      supportsReauth: true,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
    },
  ],
  register() {},
});

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

const platformPorts: PlatformPortConfig = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
  cache: { adapter: 'cache-api', namespace: 'token-jobs-test' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

const logs: Record<string, unknown>[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function boot() {
  logs.length = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
    }),
  );
  cleanup.push(() => mf.dispose());
  const db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'token-jobs-test' });
  const { a } = await seedTwoOrganizations(executor);
  const user = (id: string, email: string) =>
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      id,
      a.orgId,
      email,
      'active',
    );
  const grant = (id: string, email: string) =>
    stmt(
      'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)',
      id,
      a.orgId,
      'email',
      email,
      'project',
      PROJECT,
      OWNER,
      NOW,
      NOW,
    );
  await executor.batch([
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
      OWNER,
      a.orgId,
      'owner',
      'owner',
      'project',
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      a.orgId,
      OWNER,
      'project:grants:write',
    ),
    user(ACTOR, 'actor@example.test'),
    user(TARGET, 'target@example.test'),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      PROJECT,
      a.orgId,
      'one',
      'one',
      'active',
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      ACTOR,
      'a'.repeat(64),
      'a'.repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
      '2999-01-01T00:00:00.000Z',
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      ANCHOR,
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      '01J0IDENT0000000000000I1',
      a.orgId,
      ACTOR,
      'oidc',
      'subject-I1',
      'actor@example.test',
      1,
      new Date(Date.now() - 60_000).toISOString(),
    ),
    grant(G_ACTOR, 'actor@example.test'),
    grant(G_TARGET, 'target@example.test'),
  ]);
  const env: Env = {
    DB: db,
    STORAGE: {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      delete: async () => undefined,
    } as unknown as R2BucketLike,
    JOBS: { send: async () => undefined, sendBatch: async () => undefined },
    DEPLOYMENT_ID: 'token-jobs-test',
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: 'https://broker.test',
  };
  const worker = createWorker([plugin], {
    platformPorts,
    log: (entry) => void logs.push(entry),
    console: { log: () => undefined, error: () => undefined },
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      }),
    },
  });
  return { executor, org: a, env, worker };
}

describe('Worker personal-token offboarding wiring', () => {
  it('registers the offboarding and the sweep job as core jobs', async () => {
    const spy = vi.spyOn(kernelModule, 'createKernel');
    try {
      const { env, worker } = await boot();
      await worker.services(env);
      const registration = spy.mock.calls.at(-1)![0].registration!;
      const names = registration.jobs.map((job) => job.qualifiedName);
      expect(names).toContain('core:pat-offboarding:v1');
      expect(names).toContain('core:pat-offboarding-sweep:v1');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('queues one membership_removed and one project_removed job when a project revoke removes the last access', async () => {
    const { executor, org, env, worker } = await boot();
    const access = (await worker.services(env)).access!;
    const result = await access.projectGrants.revoke(
      org,
      {
        kind: 'project',
        userId: ACTOR,
        orgId: org.orgId,
        projectId: PROJECT,
        permissions: new Set(['project:grants:write']),
      },
      mutationFence({ userId: ACTOR, sessionId: SESSION } as unknown as AuthenticatedActor, {
        [projectGrantKey(G_TARGET)]: 1,
      }),
      PROJECT,
      G_TARGET,
      {
        audit: {
          opId: '01K00000000000000000000001',
          requestId: '01K00000000000000000000002',
          sourceIp: null,
          tokenSelector: null,
        },
      },
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(logs).not.toContainEqual(
      expect.objectContaining({ event: 'user.pat_offboarding_enqueue_failed' }),
    );
    const queued = await executor.all<{ payload_json: string }>({
      sql: "SELECT payload_json FROM job WHERE type = 'core:pat-offboarding:v1'",
      params: [],
    });
    expect(
      queued.map((row) => (JSON.parse(row.payload_json) as { cause: string }).cause).sort(),
    ).toEqual(['membership_removed', 'project_removed']);
  }, 60_000);
});

describe('Worker personal-token job holder', () => {
  const jobs: Jobs = {
    enqueue: async () => ({ id: ulid(), created: true }),
    get: async () => null,
  };

  it('accepts exactly one set', () => {
    const holder = createPatJobHolder();
    holder.set(jobs);
    expect(() => holder.set(jobs)).toThrow();
  });

  it('fails a sweep claim made before the holder is set as a retryable handler_error', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    cleanup.push(() => database.close());
    const { executor } = database;
    const org = database.orgs!.a;
    const userId = ulid();
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
        userId,
        org.orgId,
        'gone@example.test',
      ),
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
           user_id, created_by_user_id, expires_at, project_mode, created_at)
         VALUES (?, ?, 'pat', 'sweepselect1', ?, 1, 'pat', '["write"]', 0, ?, ?, ?, 'all', ?)`,
        ulid(),
        org.orgId,
        'a'.repeat(64),
        userId,
        userId,
        '2999-01-01T00:00:00.000Z',
        NOW,
      ),
    ]);
    const claim: JobClaim = {
      id: ulid(),
      owner: ulid(),
      fence: 1,
      type: 'core:pat-offboarding-sweep:v1',
      payloadJson: '{}',
      idempotencyKey: 'k',
      resourceKey: null,
      projectId: null,
      initiatorTokenId: null,
      attempt: 1,
      maxAttempts: 3,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const settle = vi.fn(() => Promise.resolve());
    const fail = () => Promise.reject(new Error('unexpected call'));
    const observability = {
      log: () => undefined,
      counter: () => undefined,
      histogram: () => undefined,
    };
    const handle = createQueueHandler({
      repository: {
        enqueue: fail,
        status: fail,
        claim: () => Promise.resolve(claim),
        heartbeat: () => Promise.resolve(),
        settle,
        reap: fail,
      },
      jobs: { jobs: patOffboardingRegistrations(executor, createPatJobHolder(), () => undefined) },
      observability,
      scope: () => ({
        ports: {
          organizations: { get: () => Promise.resolve(null) },
          clock: systemClock,
          ids: { ulid },
        } as unknown as PluginPorts,
        observability,
      }),
    });
    await handle(
      {
        messages: [
          {
            body: jobNotification(org, claim.id),
            ack: () => undefined,
            retry: () => undefined,
          },
        ],
      },
      {},
    );
    expect(settle).toHaveBeenCalledWith(
      org,
      expect.anything(),
      expect.objectContaining({ outcome: 'failed', errorCode: 'handler_error', permanent: false }),
    );
  });
});
