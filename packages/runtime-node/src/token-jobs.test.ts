import * as personalTokens from '@package-broker/core/authz/pat-service';
import * as serviceTokens from '@package-broker/core/authz/service-token-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { Statement } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { Jobs } from '@package-broker/core/platform/jobs';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
} from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { projectGrantKey } from '@package-broker/db-sqlite/repositories/project-grant';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { createNodeServer, type NodeBroker } from './index.js';
import { createJobLoop } from './jobs/loop.js';
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

const plugin: PluginDefinition = {
  id: 'probe',
  package: '@test/probe',
  apiVersion: SUPPORTED_PLUGIN_API[0],
  platforms: ['node'],
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
};

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

const logs: Record<string, unknown>[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function boot(): Promise<{ database: MigratedDatabase; broker: NodeBroker }> {
  logs.length = 0;
  const database = await openMigratedDatabase({ twoOrganizations: true });
  cleanup.push(() => database.close());
  const { executor } = database;
  const org = database.orgs!.a;
  const user = (id: string, email: string) =>
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      id,
      org.orgId,
      email,
      'active',
    );
  const grant = (id: string, email: string) =>
    stmt(
      'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)',
      id,
      org.orgId,
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
      org.orgId,
      'owner',
      'owner',
      'project',
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      OWNER,
      'project:grants:write',
    ),
    user(ACTOR, 'actor@example.test'),
    user(TARGET, 'target@example.test'),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      PROJECT,
      org.orgId,
      'one',
      'one',
      'active',
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      org.orgId,
      ACTOR,
      'a'.repeat(64),
      'a'.repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
      '2999-01-01T00:00:00.000Z',
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      'oidc',
      ANCHOR,
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      '01J0IDENT0000000000000I1',
      org.orgId,
      ACTOR,
      'oidc',
      'subject-I1',
      'actor@example.test',
      1,
      new Date(Date.now() - 60_000).toISOString(),
    ),
    grant(G_ACTOR, 'actor@example.test'),
    grant(G_TARGET, 'target@example.test'),
    stmt(
      "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, 'ci', ?)",
      '01J0PRINCIPAL00000000000001',
      org.orgId,
      TARGET,
    ),
  ]);
  const broker = createNodeServer([plugin], {
    executor,
    log: (entry) => void logs.push(entry),
    platformServices: {
      jobStore: createJobRepository(executor),
      blob: {
        head: async () => null,
        get: async () => null,
        put: async () => {
          throw new Error('unused');
        },
      },
      cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    },
    auth: {
      keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
      publicOrigin: 'http://127.0.0.1',
      env: {},
    },
  });
  cleanup.push(() => broker.close());
  return { database, broker };
}

describe('Node personal-token offboarding wiring', () => {
  it('exposes the same resolved lifetime policy used by both token services', async () => {
    const personal = vi.spyOn(personalTokens, 'createPersonalTokenService');
    const service = vi.spyOn(serviceTokens, 'createServiceTokenService');
    try {
      const { broker } = await boot();
      const access = (await broker.services()).access!;
      expect(access.lifetime).toEqual({ personal: { maxDays: 365 }, service: { maxDays: 365 } });
      expect(personal.mock.calls.at(-1)?.[0].lifetime).toBe(access.lifetime);
      expect(service.mock.calls.at(-1)?.[0].lifetime).toBe(access.lifetime);
    } finally {
      personal.mockRestore();
      service.mockRestore();
    }
  }, 60_000);

  it.each(['suspend', 'revoke'] as const)(
    'offboards the creator and queues PAT cleanup after organization %s',
    async (action) => {
      const { database, broker } = await boot();
      const { executor } = database;
      const org = database.orgs!.a;
      const access = (await broker.services()).access!;
      const roleId = '01J0ORGROLE000000000000001';
      await executor.batch([
        stmt(
          "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'manager', 'Manager', 'organization')",
          roleId,
          org.orgId,
        ),
        ...['org:users:write', 'org:grants:write'].map((permission) =>
          stmt(
            'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
            org.orgId,
            roleId,
            permission,
          ),
        ),
        stmt(
          "UPDATE access_grant SET scope = 'organization', project_id = NULL, role_id = ? WHERE org_id = ? AND id IN (?, ?)",
          roleId,
          org.orgId,
          G_ACTOR,
          G_TARGET,
        ),
      ]);
      const actor = {
        kind: 'organization' as const,
        userId: ACTOR,
        permissions: new Set(['org:users:write', 'org:grants:write']),
        isOrganizationAdmin: false,
      };
      const fence = mutationFence(
        { userId: ACTOR, sessionId: SESSION } as unknown as AuthenticatedActor,
        { grant: 1 },
      );
      const call = {
        audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      };
      const result =
        action === 'suspend'
          ? await access.administration.suspendUser(org, actor, fence, TARGET, call)
          : await access.administration.revokeOrganizationGrant(org, actor, fence, G_TARGET, call);
      expect(result).toEqual({ ok: true, value: null });
      const cause = action === 'suspend' ? 'suspended' : 'membership_removed';
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'service_principal.creator_offboarded',
          orgId: org.orgId,
          userId: TARGET,
          cause,
        }),
      );
      const queued = await executor.all<{ org_id: string; payload_json: string }>(
        stmt(
          "SELECT org_id, payload_json FROM job WHERE org_id = ? AND type = 'core:pat-offboarding:v1'",
          org.orgId,
        ),
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]?.org_id).toBe(org.orgId);
      expect(JSON.parse(queued[0]!.payload_json)).toEqual({
        userId: TARGET,
        cause,
        cutoff: expect.any(String),
      });
      expect(logs).not.toContainEqual(
        expect.objectContaining({ event: 'user.pat_offboarding_enqueue_failed' }),
      );
    },
    60_000,
  );

  it('registers the offboarding and the sweep job as core jobs', async () => {
    const { broker } = await boot();
    const kernel = await broker.ready();
    const names = kernel.registration.jobs.map((job) => job.qualifiedName);
    expect(names).toContain('core:pat-offboarding:v1');
    expect(names).toContain('core:pat-offboarding-sweep:v1');
  });

  it('schedules the sweep daily', async () => {
    const { broker } = await boot();
    const kernel = await broker.ready();
    const sweep = kernel.registration.jobs.find(
      (job) => job.qualifiedName === 'core:pat-offboarding-sweep:v1',
    );
    expect(sweep?.definition.schedule).toEqual({ everySeconds: 86_400 });
  });

  it('queues one membership_removed and one project_removed job when a project revoke removes the last access', async () => {
    const { database, broker } = await boot();
    const access = (await broker.services()).access!;
    const result = await access.projectGrants.revoke(
      database.orgs!.a,
      {
        kind: 'project',
        userId: ACTOR,
        orgId: database.orgs!.a.orgId,
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
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'service_principal.creator_offboarded',
        userId: TARGET,
        cause: 'membership_removed',
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({ event: 'user.pat_offboarding_enqueue_failed' }),
    );
    const queued = await database.executor.all<{ type: string; payload_json: string }>({
      sql: "SELECT type, payload_json FROM job WHERE type = 'core:pat-offboarding:v1' ORDER BY payload_json",
      params: [],
    });
    expect(
      queued.map((row) => (JSON.parse(row.payload_json) as { cause: string }).cause).sort(),
    ).toEqual(['membership_removed', 'project_removed']);
  });
});

describe('personal-token job holder', () => {
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
    const queued = await createJobRepository(executor).enqueue(org, {
      id: ulid(),
      type: 'core:pat-offboarding-sweep:v1',
      payloadJson: '{}',
      idempotencyKey: 'sweep-early',
      resourceKey: null,
      runAt: null,
      maxAttempts: 3,
      projectId: null,
      initiatorTokenId: null,
    });
    const observability = {
      log: () => undefined,
      counter: () => undefined,
      histogram: () => undefined,
    };
    const loop = createJobLoop({
      executor,
      jobs: patOffboardingRegistrations(executor, createPatJobHolder(), () => undefined),
      scope: () => ({
        ports: {
          organizations: { get: async () => null },
          clock: systemClock,
          ids: { ulid },
        } as unknown as PluginPorts,
        observability,
      }),
      observability,
    });
    cleanup.push(async () => {
      await loop.stop();
    });
    loop.start();
    await vi.waitFor(
      async () => {
        expect(await createJobRepository(executor).status(org, queued.id)).toMatchObject({
          state: 'queued',
          lastErrorCode: 'handler_error',
        });
      },
      { timeout: 15_000, interval: 50 },
    );
  });
});
