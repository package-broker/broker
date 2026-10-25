import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdministration } from '@package-broker/core/authz/administration';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createProjectAdministration } from '@package-broker/core/authz/project-administration';
import {
  createPatOffboardingJob,
  enqueuePatOffboarding,
  enqueueProjectRemovedPatOffboarding,
} from '@package-broker/core/authz/pat-offboarding';
import type { OrgContext, SqlValue, Statement } from '@package-broker/core/db/port';
import type { LoginPlan } from '@package-broker/core/db/users';
import { fixedClock, ulid } from '@package-broker/core/ids';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuthRepositories } from './auth.js';
import { createGrantRepository } from './grant.js';
import { createJobRepository } from './job.js';
import { createPatOffboardingRepository } from './pat-offboarding.js';
import { createProjectGrantRepository, projectGrantKey } from './project-grant.js';
import { createRoleRepository } from './role.js';
import { createUserRepository } from './user.js';

const ACTOR = ulid();
const USER = ulid();
const SESSION = ulid();
const IDENTITY = ulid();
const ROLE = ulid();
const PROJECT_ROLE = ulid();
const P1 = ulid();
const P2 = ulid();
const REMOVED = ulid();
const BEFORE = '2026-01-01T00:00:00.000Z';
const NOW = new Date().toISOString();
const ANCHOR = 'oidc:https://idp.example.test';
const anchors = [
  {
    provider: 'oidc',
    anchor: ANCHOR,
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const clock = fixedClock(NOW);
const ids = { ulid };
const call = { audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null } };
const permissions = new Set(['org:grants:write', 'project:grants:write', 'project:read']);
let database: MigratedDatabase;
let org: OrgContext;
let onProjectAccessLost: ReturnType<typeof enqueueProjectRemovedPatOffboarding>;
let onUserOffboarded: ReturnType<typeof enqueuePatOffboarding>;
let job: ReturnType<typeof createPatOffboardingJob>;

async function sql(query: string, ...params: SqlValue[]): Promise<void> {
  await database.executor.batch([{ sql: query, params }]);
}

async function grant(
  id: string,
  project: string | null,
  subject: 'email' | 'group' = 'email',
  value = 'user@example.test',
): Promise<void> {
  await sql(
    `INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    org.orgId,
    subject,
    value,
    subject === 'group' ? 'oidc' : null,
    project === null ? 'organization' : 'project',
    project,
    project === null ? ROLE : PROJECT_ROLE,
    BEFORE,
  );
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  org = database.orgs!.a;
  for (const [id, email] of [
    [ACTOR, 'actor@example.test'],
    [USER, 'user@example.test'],
  ]) {
    await sql(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      id!,
      org.orgId,
      email!,
    );
  }
  for (const [id, scope] of [
    [ROLE, 'organization'],
    [PROJECT_ROLE, 'project'],
  ]) {
    await sql(
      'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
      id!,
      org.orgId,
      id!.toLowerCase(),
      id!,
      scope!,
    );
  }
  for (const permission of permissions) {
    await sql(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      ROLE,
      permission,
    );
  }
  for (const id of [P1, P2]) {
    await sql(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      id,
      org.orgId,
      id.toLowerCase(),
      id,
    );
  }
  await sql(
    `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')`,
    SESSION,
    org.orgId,
    ACTOR,
    'a'.repeat(64),
    'b'.repeat(64),
    NOW,
    NOW,
  );
  await sql(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    org.orgId,
    'oidc',
    ANCHOR,
  );
  await sql(
    `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at)
    VALUES (?, ?, ?, 'oidc', 'actor', 'actor@example.test', 1, ?)`,
    ulid(),
    org.orgId,
    ACTOR,
    NOW,
  );
  await grant(ulid(), null, 'email', 'actor@example.test');
  await grant(ulid(), P2);
  job = createPatOffboardingJob({
    store: createPatOffboardingRepository(database.executor),
    clock,
    ids,
    log: () => undefined,
  });
  const jobs = createRepositoryJobs({
    store: createJobRepository(database.executor),
    jobs: [job],
    clock,
    ids,
  })('core', { projectId: null, tokenId: null });
  onProjectAccessLost = enqueueProjectRemovedPatOffboarding(jobs);
  onUserOffboarded = enqueuePatOffboarding(jobs);
});

afterEach(async () => database.close());

function fence(expected: Record<string, number>) {
  return mutationFence(
    { userId: ACTOR, sessionId: SESSION } as unknown as AuthenticatedActor,
    expected,
  );
}

async function token(projects: readonly string[] | 'all', userId = USER): Promise<string> {
  const id = ulid();
  await sql(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at, project_mode, created_at)
    VALUES (?, ?, 'pat', ?, ?, 1, 'test', '["read"]', ?, '2999-01-01T00:00:00.000Z', ?, ?)`,
    id,
    org.orgId,
    id.slice(-12),
    'a'.repeat(64),
    userId,
    projects === 'all' ? 'all' : 'selected',
    BEFORE,
  );
  if (projects !== 'all') {
    for (const project of projects)
      await sql(
        'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
        org.orgId,
        id,
        project,
      );
  }
  return id;
}

async function runQueued(): Promise<void> {
  const rows = await database.executor.all<{ id: string; payload_json: string }>({
    sql: 'SELECT id, payload_json FROM job WHERE org_id = ?',
    params: [org.orgId],
  });
  expect(
    rows.some(
      (row) =>
        JSON.parse(row.payload_json).cause === 'project_removed' &&
        JSON.parse(row.payload_json).invalidatedTokenId === undefined,
    ),
  ).toBe(true);
  for (const row of rows) {
    await sql(
      "UPDATE job SET state = 'running', fence = 1, lease_owner = 'test', lease_until = '2999-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
      org.orgId,
      row.id,
    );
    await job.definition.handler(job.definition.validate(JSON.parse(row.payload_json)), {
      org,
      jobId: row.id,
      idempotencyKey: 'test',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      ports: {} as JobContext['ports'],
      observability: {} as JobContext['observability'],
    });
    await sql(
      "UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL WHERE org_id = ? AND id = ?",
      org.orgId,
      row.id,
    );
  }
}

async function expectTokens(lost: string, kept: string, all: string): Promise<void> {
  await runQueued();
  const rows = await database.executor.all<{ id: string; revoked_at: string | null }>({
    sql: 'SELECT id, revoked_at FROM token WHERE org_id = ?',
    params: [org.orgId],
  });
  const states = new Map(rows.map((row) => [row.id, row.revoked_at]));
  expect(states.get(lost)).toBe(NOW);
  expect(states.get(kept)).toBeNull();
  expect(states.get(all)).toBeNull();
}

async function membership(name = 'removed'): Promise<void> {
  await sql(
    "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'oidc', ?, ?)",
    org.orgId,
    USER,
    name,
    BEFORE,
  );
}

function loginPlan(groups: readonly string[], now = NOW): LoginPlan {
  return {
    audit: {
      id: ulid(),
      occurredAt: NOW,
      action: 'session.login',
      actor: { type: 'user', id: USER },
      target: { type: 'session', id: SESSION },
      tokenSelector: null,
      sourceIp: null,
      projectId: null,
      payloadJson: '{"op_id":"fixture","request_id":"fixture"}',
    },
    userId: USER,
    createUser: false,
    email: 'user@example.test',
    displayName: null,
    identityId: IDENTITY,
    provider: 'oidc',
    trustAnchor: ANCHOR,
    subject: 'user',
    emailVerified: true,
    groups,
    evidenceTime: now,
    now,
    autoJoin: false,
    previousSecretHash: null,
    session: {
      id: ulid(),
      userId: USER,
      identityId: IDENTITY,
      secretHash: 'd'.repeat(64),
      csrfHash: 'c'.repeat(64),
      now,
      expiresAt: '2999-01-01T00:00:00.000Z',
      ip: null,
      userAgent: null,
    },
  };
}

async function userIdentity(): Promise<void> {
  await sql(
    `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at)
    VALUES (?, ?, ?, 'oidc', 'user', 'user@example.test', 1, ?)`,
    IDENTITY,
    org.orgId,
    USER,
    BEFORE,
  );
}

describe('access-loss triggers revoke only selected PATs without a held bound project', () => {
  it('enqueues every stored member on a group project-grant revoke', async () => {
    await grant(REMOVED, P1, 'group', 'removed');
    await membership();
    const secondUser = ulid();
    await sql(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      secondUser,
      org.orgId,
      'second@example.test',
    );
    await sql(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'oidc', 'removed', ?)",
      org.orgId,
      secondUser,
      BEFORE,
    );
    const secondPat = await token([P1], secondUser);
    const lost = await token([P1]);
    const kept = await token([P1, P2]);
    const all = await token('all');
    const service = createProjectAdministration({
      grants: createProjectGrantRepository(database.executor, { onProjectAccessLost }),
      providers: new Map([['oidc', {}]]),
      providerAnchors: anchors,
      clock,
      ids,
      log: () => undefined,
    });
    expect(
      await service.revoke(
        org,
        { kind: 'project', orgId: org.orgId, userId: ACTOR, projectId: P1, permissions },
        fence({ [projectGrantKey(REMOVED)]: 1 }),
        P1,
        REMOVED,
        call,
      ),
    ).toEqual({ ok: true, value: null });
    const queued = await database.executor.all<{ payload_json: string }>({
      sql: 'SELECT payload_json FROM job WHERE org_id = ?',
      params: [org.orgId],
    });
    expect(
      queued
        .map((row) => JSON.parse(row.payload_json))
        .filter((payload) => payload.invalidatedTokenId === undefined)
        .map((payload) => payload.userId)
        .sort(),
    ).toEqual([USER, secondUser].sort());
    await expectTokens(lost, kept, all);
    expect(
      await database.executor.all({
        sql: 'SELECT revoked_at FROM token WHERE org_id = ? AND id = ?',
        params: [org.orgId, secondPat],
      }),
    ).toEqual([{ revoked_at: NOW }]);
  });

  it('enqueues selected-PAT checking after an organization grant revoke while a project grant remains', async () => {
    await grant(REMOVED, null);
    const lost = await token([P1]);
    const kept = await token([P1, P2]);
    const all = await token('all');
    const service = createAdministration({
      grants: createGrantRepository(database.executor, {
        providerAnchors: anchors,
        holderInput: () => ({ kind: 'fresh', providers: anchors }),
      }),
      roles: createRoleRepository(database.executor, { providerAnchors: anchors }),
      users: createUserRepository(database.executor),
      providers: new Map(),
      clock,
      ids,
      log: () => undefined,
      onUserOffboarded,
      onProjectAccessLost,
    });
    expect(
      await service.revokeOrganizationGrant(
        org,
        { kind: 'organization', userId: ACTOR, permissions, isOrganizationAdmin: true },
        fence({ grant: 1 }),
        REMOVED,
        call,
      ),
    ).toEqual({ ok: true, value: null });
    await expectTokens(lost, kept, all);
  });

  it('enqueues on membership sync removal', async () => {
    await grant(REMOVED, P1, 'group', 'removed');
    await membership();
    await userIdentity();
    const lost = await token([P1]);
    const kept = await token([P1, P2]);
    const all = await token('all');
    const writer = createAuthRepositories(database.executor, { onProjectAccessLost }).login;
    const plan = loginPlan([]);
    expect(await writer.commit(org, plan)).toBe('created');
    await expectTokens(lost, kept, all);
  });

  it('searches only the logging-in user for membership-sync invalidation', async () => {
    await grant(REMOVED, P1, 'group', 'removed');
    await membership();
    await userIdentity();
    await token([P1]);
    const statements: Statement[] = [];
    const writer = createAuthRepositories({
      ...database.executor,
      async batch(batch) {
        statements.push(...batch);
        return database.executor.batch(batch);
      },
    }).login;
    expect(await writer.commit(org, loginPlan([]))).toBe('created');
    const invalidation = statements.find((statement) =>
      statement.sql.includes('pat-invalidation:'),
    );
    expect(invalidation).toBeDefined();
    const rows = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${invalidation!.sql}`,
      params: invalidation!.params,
    });
    const details = rows.map((row) => row.detail);
    for (const [alias, key] of [
      ['owner', 'id'],
      ['token', 'user_id'],
      ['lost', 'user_id'],
    ]) {
      const accesses = details.filter((detail) =>
        new RegExp(`^(?:SCAN|SEARCH) ${alias}\\b`).test(detail),
      );
      expect(accesses, details.join('\n')).not.toEqual([]);
      for (const access of accesses) {
        expect(access, details.join('\n')).toMatch(new RegExp(`^SEARCH ${alias}\\b`));
        expect(access, details.join('\n')).toMatch(new RegExp(`(?:\\(| AND )${key}=\\?`));
      }
    }
  });

  it('revokes after a later group join through an old grant, even when the job is delayed', async () => {
    await grant(REMOVED, P1, 'group', 'removed');
    await grant(ulid(), P1, 'group', 'rescue');
    await membership();
    await userIdentity();
    const lost = await token([P1]);
    const kept = await token([P1, P2]);
    const all = await token('all');
    const writer = createAuthRepositories(database.executor, { onProjectAccessLost }).login;
    expect(await writer.commit(org, loginPlan([]))).toBe('created');
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const joined = loginPlan(['rescue'], later);
    expect(
      await writer.commit(org, {
        ...joined,
        session: { ...joined.session, secretHash: 'e'.repeat(64) },
      }),
    ).toBe('created');
    await expectTokens(lost, kept, all);
  });

  it('keeps continuous group access when membership evidence is refreshed before a delayed job', async () => {
    await grant(REMOVED, P1, 'group', 'retained');
    await membership('retained');
    await userIdentity();
    const kept = await token([P1]);
    const writer = createAuthRepositories(database.executor, { onProjectAccessLost }).login;
    expect(await writer.commit(org, loginPlan(['retained']))).toBe('created');
    const rows = await database.executor.all({
      sql: 'SELECT id FROM job WHERE org_id = ?',
      params: [org.orgId],
    });
    expect(rows).toEqual([]);
    expect(
      await createPatOffboardingRepository(database.executor).candidates(org, {
        userId: USER,
        cutoff: NOW,
        limit: 25,
        selectedOnly: true,
      }),
    ).toEqual([]);
    expect(
      await database.executor.all({
        sql: 'SELECT revoked_at FROM token WHERE org_id = ? AND id = ?',
        params: [org.orgId, kept],
      }),
    ).toEqual([{ revoked_at: null }]);
  });
  it('keeps access supplied by a group joined in the same membership sync', async () => {
    await grant(REMOVED, P1, 'group', 'removed');
    await grant(ulid(), P1, 'group', 'replacement');
    await membership();
    await userIdentity();
    const kept = await token([P1]);
    const writer = createAuthRepositories(database.executor, { onProjectAccessLost }).login;
    expect(await writer.commit(org, loginPlan(['replacement']))).toBe('created');
    await runQueued();
    expect(
      await database.executor.all({
        sql: 'SELECT revoked_at FROM token WHERE org_id = ? AND id = ?',
        params: [org.orgId, kept],
      }),
    ).toEqual([{ revoked_at: null }]);
  });

  it('keeps snapshot revocations scoped to the owner, organization, mode and cutoff', async () => {
    const held = await token([P1]);
    const all = await token('all');
    const store = createPatOffboardingRepository(database.executor);
    for (const invalidatedTokenId of [held, all]) {
      expect(
        await store.candidates(database.orgs!.b, {
          userId: USER,
          cutoff: NOW,
          limit: 25,
          selectedOnly: true,
          invalidatedTokenId,
        }),
      ).toEqual([]);
      expect(
        await store.candidates(org, {
          userId: ACTOR,
          cutoff: NOW,
          limit: 25,
          selectedOnly: true,
          invalidatedTokenId,
        }),
      ).toEqual([]);
      expect(
        await store.candidates(org, {
          userId: USER,
          cutoff: '2020-01-01T00:00:00.000Z',
          limit: 25,
          selectedOnly: true,
          invalidatedTokenId,
        }),
      ).toEqual([]);
    }
    expect(
      await store.candidates(org, {
        userId: USER,
        cutoff: NOW,
        limit: 25,
        selectedOnly: true,
        invalidatedTokenId: all,
      }),
    ).toEqual([]);
    expect(
      await store.candidates(org, {
        userId: USER,
        cutoff: NOW,
        limit: 25,
        selectedOnly: true,
        invalidatedTokenId: held,
      }),
    ).toEqual([held]);
  });
});
