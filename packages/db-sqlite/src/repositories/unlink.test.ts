import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { ProtectedHolderInput } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createGrantRepository } from './grant.js';
import { rebindProvider } from './provider-binding.js';
import { createUnlinkRepository, type UnlinkIdentityInput } from './unlink.js';

const OIDC = 'oidc';
const CF = 'cf';
const ANCHOR = 'oidc:https://idp.example.test';
const ANCHOR_NEW = 'oidc:https://idp-new.example.test';
const CF_ANCHOR = `access:team.example.test/${'a'.repeat(64)}`;
const NOW = '2026-10-15T12:00:00.000Z';

const ACTOR = '01J0USERACTOR0000000000000';
const ACTOR_IDENTITY = '01J0IDENTACTOR000000000000';
const ACTOR_SESSION = '01J0SESSACTOR0000000000000';
const SECOND_ADMIN = '01J0USERADMIN0000000000002';
const SECOND_IDENTITY = '01J0IDENTADMIN000000000002';
const TARGET = '01J0USERTARGET00000000000T';
const TARGET_OIDC = '01J0IDENTTARGETO0000000000T';
const TARGET_CF = '01J0IDENTTARGETC0000000000T';
const TARGET_SESSION_OIDC = '01J0SESSTARGETO0000000000T';
const TARGET_SESSION_CF = '01J0SESSTARGETC0000000000T';
const TARGET_SESSION_LOCAL = '01J0SESSTARGETL0000000000T';
const TOKEN_OIDC = '01J0TOKENOIDC0000000000000';
const TOKEN_CF = '01J0TOKENCF000000000000000';
const TOKEN_LOCAL = '01J0TOKENLOCAL00000000000';
const ROLE = '01J0ROLEADMIN0000000000000';
const GRANT_ACTOR = '01J0GRANTACTOR00000000000';
const GRANT_SECOND = '01J0GRANTSECOND0000000000';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let executor: SqlExecutor;
let directory: string;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

async function rows<R = Record<string, unknown>>(sql: string, ...params: string[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

async function count(table: string, where = '1 = 1', ...params: string[]): Promise<number> {
  const found = await rows<{ n: number }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    ...params,
  );
  return Number(found[0]?.n ?? 0);
}

function holders(): ProtectedHolderInput {
  return {
    kind: 'fresh',
    now: new Date().toISOString(),
    providers: [
      {
        provider: OIDC,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
      {
        provider: CF,
        anchor: CF_ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ],
  };
}

function unlinkIdentity(
  connection: SqlExecutor,
  ctx: OrgContext,
  fence: MutationFence,
  request: Omit<UnlinkIdentityInput, never>,
) {
  return createUnlinkRepository(connection, { holderInput: async () => holders() }).unlinkIdentity(
    ctx,
    fence,
    request,
  );
}

function fenceOf(userId: string, sessionId: string): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function userStatement(id: string, email: string): Statement {
  return stmt(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'active')",
    id,
    org.orgId,
    email,
  );
}

function identityStatement(
  id: string,
  userId: string,
  provider: string,
  subject: string,
  email: string,
): Statement {
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    id,
    org.orgId,
    userId,
    provider,
    subject,
    email,
    new Date().toISOString(),
  );
}

function sessionStatement(id: string, userId: string, identityId: string | null): Statement {
  return stmt(
    'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    identityId,
    hash(id),
    hash(`csrf-${id}`),
    new Date().toISOString(),
    new Date(Date.now() + 3_600_000).toISOString(),
  );
}

function tokenStatement(id: string, kind: 'sso' | 'local', identityId: string | null): Statement {
  return stmt(
    "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at, validation_kind, validation_identity_id) VALUES (?, ?, 'pat', ?, ?, 1, 'pat', '[]', ?, '2030-01-01T00:00:00.000Z', ?, ?)",
    id,
    org.orgId,
    createHash('sha256').update(id).digest('hex').slice(0, 12),
    hash(id),
    TARGET,
    kind,
    identityId,
  );
}

function grantStatement(id: string, email: string): Statement {
  return stmt(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?, NULL, ?, ?)",
    id,
    org.orgId,
    email,
    ROLE,
    NOW,
    NOW,
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pb-unlink-'));
  database = await openMigratedDatabase({
    file: join(directory, 'store.sqlite'),
    twoOrganizations: true,
  });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  executor = database.executor;
  await executor.batch([
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      OIDC,
      ANCHOR,
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      CF,
      CF_ANCHOR,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'admin', 'Admin', 'organization', 1)",
      ROLE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'org:users:write')",
      org.orgId,
      ROLE,
    ),
    userStatement(ACTOR, 'actor@example.test'),
    identityStatement(ACTOR_IDENTITY, ACTOR, OIDC, 'sub-actor', 'actor@example.test'),
    sessionStatement(ACTOR_SESSION, ACTOR, null),
    grantStatement(GRANT_ACTOR, 'actor@example.test'),
    userStatement(TARGET, 'target@example.test'),
    identityStatement(TARGET_OIDC, TARGET, OIDC, 'sub-target', 'target@example.test'),
    identityStatement(TARGET_CF, TARGET, CF, 'sub-target-cf', 'target@example.test'),
    sessionStatement(TARGET_SESSION_OIDC, TARGET, TARGET_OIDC),
    sessionStatement(TARGET_SESSION_CF, TARGET, TARGET_CF),
    sessionStatement(TARGET_SESSION_LOCAL, TARGET, null),
    tokenStatement(TOKEN_OIDC, 'sso', TARGET_OIDC),
    tokenStatement(TOKEN_CF, 'sso', TARGET_CF),
    tokenStatement(TOKEN_LOCAL, 'local', null),
    stmt(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'admins')",
      org.orgId,
      TARGET,
    ),
    stmt(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'cf', 'cf-admins')",
      org.orgId,
      TARGET,
    ),
  ]);
});

afterEach(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

function input(overrides: Partial<UnlinkIdentityInput> = {}): UnlinkIdentityInput {
  return {
    identityId: TARGET_OIDC,
    userId: TARGET,
    provider: OIDC,
    subject: 'sub-target',
    anchor: ANCHOR,
    now: NOW,
    ...overrides,
  };
}

async function untouched(): Promise<void> {
  expect(await count('identity_block')).toBe(0);
  expect(await count('identity', 'id = ?', TARGET_OIDC)).toBe(1);
  expect(await count('session', 'identity_id = ?', TARGET_OIDC)).toBe(1);
  expect(await count('user_group', "provider = 'oidc' AND user_id = ?", TARGET)).toBe(1);
  expect(await count('token', 'revoked_at IS NOT NULL')).toBe(0);
}

describe('unlinkIdentity', () => {
  it('blocks the subject, revokes bound tokens, deletes sessions and the identity, and keeps the rest', async () => {
    const outcome = await unlinkIdentity(executor, org, fenceOf(ACTOR, ACTOR_SESSION), input());

    expect(outcome).toBe('unlinked');
    expect(
      await rows(
        'SELECT provider, issuer, subject, blocked_at, blocked_by_user_id FROM identity_block',
      ),
    ).toEqual([
      {
        provider: OIDC,
        issuer: ANCHOR,
        subject: 'sub-target',
        blocked_at: NOW,
        blocked_by_user_id: ACTOR,
      },
    ]);
    expect(await rows('SELECT id, revoked_at FROM token ORDER BY id')).toEqual([
      { id: TOKEN_CF, revoked_at: null },
      { id: TOKEN_LOCAL, revoked_at: null },
      { id: TOKEN_OIDC, revoked_at: NOW },
    ]);
    expect(await count('session', 'identity_id = ?', TARGET_OIDC)).toBe(0);
    expect(await count('session', 'id = ?', TARGET_SESSION_OIDC)).toBe(0);
    expect(
      await rows('SELECT id, identity_id FROM session WHERE user_id = ? ORDER BY id', TARGET),
    ).toEqual([
      { id: TARGET_SESSION_CF, identity_id: TARGET_CF },
      { id: TARGET_SESSION_LOCAL, identity_id: null },
    ]);
    expect(await count('user_group', "provider = 'oidc' AND user_id = ?", TARGET)).toBe(0);
    expect(await count('user_group', "provider = 'cf' AND user_id = ?", TARGET)).toBe(1);
    expect(await count('identity', 'id = ?', TARGET_OIDC)).toBe(0);
    expect(await count('identity', 'id = ?', TARGET_CF)).toBe(1);
    expect(await count('user_account', 'id = ?', TARGET)).toBe(1);
    expect(
      await count(
        'token',
        "validation_kind = 'sso' AND validation_identity_id IS NULL AND revoked_at IS NULL",
      ),
    ).toBe(0);
  });

  it('refuses a stale expected subject as a conflict and changes nothing', async () => {
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(ACTOR, ACTOR_SESSION),
      input({ subject: 'sub-someone-else' }),
    );
    expect(outcome).toBe('conflict');
    await untouched();
  });

  it('refuses a stale expected user or anchor as a conflict', async () => {
    const fence = fenceOf(ACTOR, ACTOR_SESSION);
    expect(await unlinkIdentity(executor, org, fence, input({ userId: ACTOR }))).toBe('conflict');
    expect(await unlinkIdentity(executor, org, fence, input({ anchor: ANCHOR_NEW }))).toBe(
      'conflict',
    );
    await untouched();
  });

  it('refuses removing the last protected holder and rolls everything back', async () => {
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(ACTOR, ACTOR_SESSION),
      input({ identityId: ACTOR_IDENTITY, userId: ACTOR, subject: 'sub-actor' }),
    );
    expect(outcome).toBe('last_holder');
    expect(await count('identity_block')).toBe(0);
    expect(await count('identity', 'id = ?', ACTOR_IDENTITY)).toBe(1);
  });

  it('allows removing a protected holder while another remains', async () => {
    await executor.batch([
      userStatement(SECOND_ADMIN, 'second@example.test'),
      identityStatement(SECOND_IDENTITY, SECOND_ADMIN, OIDC, 'sub-second', 'second@example.test'),
      grantStatement(GRANT_SECOND, 'second@example.test'),
    ]);
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(ACTOR, ACTOR_SESSION),
      input({ identityId: SECOND_IDENTITY, userId: SECOND_ADMIN, subject: 'sub-second' }),
    );
    expect(outcome).toBe('unlinked');
    expect(await count('identity', 'id = ?', SECOND_IDENTITY)).toBe(0);
  });

  it('rolls back a false postcondition: no block row, no deleted identity, no revoked token', async () => {
    await executor.batch([
      stmt(
        'CREATE TRIGGER drop_block AFTER INSERT ON identity_block BEGIN DELETE FROM identity_block WHERE org_id = NEW.org_id AND provider = NEW.provider AND issuer = NEW.issuer AND subject = NEW.subject; END',
      ),
    ]);
    await expect(
      unlinkIdentity(executor, org, fenceOf(ACTOR, ACTOR_SESSION), input()),
    ).rejects.toThrow('identity unlink failed unclassified (unclassified)');
    await untouched();
  });

  it('refuses an actor without the permission and changes nothing', async () => {
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(TARGET, TARGET_SESSION_OIDC),
      input(),
    );
    expect(outcome).toBe('authority');
    await untouched();
  });

  it('refuses an actor whose session is revoked', async () => {
    await executor.batch([
      stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, ACTOR_SESSION),
    ]);
    const outcome = await unlinkIdentity(executor, org, fenceOf(ACTOR, ACTOR_SESSION), input());
    expect(outcome).toBe('authority');
    expect(await count('identity_block')).toBe(0);
  });

  it('does not reach into another organization', async () => {
    const outcome = await unlinkIdentity(executor, other, fenceOf(ACTOR, ACTOR_SESSION), input());
    expect(outcome).toBe('authority');
    await untouched();
  });

  it('keeps a blocked subject from being deleted twice', async () => {
    const fence = fenceOf(ACTOR, ACTOR_SESSION);
    expect(await unlinkIdentity(executor, org, fence, input())).toBe('unlinked');
    expect(await unlinkIdentity(executor, org, fence, input())).toBe('conflict');
    expect(await count('identity_block')).toBe(1);
  });

  it('rejects an anchor that is not a valid trust anchor', async () => {
    await expect(
      unlinkIdentity(
        executor,
        org,
        fenceOf(ACTOR, ACTOR_SESSION),
        input({ anchor: 'not-an-anchor' }),
      ),
    ).rejects.toThrow('anchor must be a valid trust anchor');
    await untouched();
  });

  it('refuses a target in another organization as a conflict and blocks nothing in either', async () => {
    const foreignUser = '01J0USERFOREIGN00000000000';
    const foreignIdentity = '01J0IDENTFOREIGN0000000000';
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'foreign@example.test', 'active')",
        foreignUser,
        other.orgId,
      ),
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        foreignIdentity,
        other.orgId,
        foreignUser,
        OIDC,
        'sub-foreign',
        'foreign@example.test',
        new Date().toISOString(),
      ),
    ]);
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(ACTOR, ACTOR_SESSION),
      input({ identityId: foreignIdentity, userId: foreignUser, subject: 'sub-foreign' }),
    );
    expect(outcome).toBe('conflict');
    expect(await count('identity_block')).toBe(0);
    expect(await count('identity', 'id = ?', foreignIdentity)).toBe(1);
  });

  it('counts the provider group deletion: a group-only holder with two identities on the provider is the last holder', async () => {
    const groupUser = '01J0USERGROUP00000000000G1';
    const groupSession = '01J0SESSGROUP00000000000G1';
    await executor.batch([
      stmt('DELETE FROM access_grant WHERE id = ?', GRANT_ACTOR),
      userStatement(groupUser, 'group@example.test'),
      identityStatement(
        '01J0IDENTGROUP1000000000G1',
        groupUser,
        OIDC,
        'sub-g1',
        'group@example.test',
      ),
      identityStatement(
        '01J0IDENTGROUP2000000000G2',
        groupUser,
        OIDC,
        'sub-g2',
        'group@example.test',
      ),
      sessionStatement(groupSession, groupUser, null),
      stmt(
        "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'root')",
        org.orgId,
        groupUser,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, 'group', 'root', 'oidc', 'organization', NULL, ?, NULL, ?, ?)",
        '01J0GRANTGROUP000000000G1',
        org.orgId,
        ROLE,
        NOW,
        NOW,
      ),
    ]);
    const outcome = await unlinkIdentity(
      executor,
      org,
      fenceOf(groupUser, groupSession),
      input({
        identityId: '01J0IDENTGROUP1000000000G1',
        userId: groupUser,
        subject: 'sub-g1',
      }),
    );
    expect(outcome).toBe('last_holder');
    expect(await count('identity_block')).toBe(0);
    expect(await count('identity', 'user_id = ?', groupUser)).toBe(2);
    expect(await count('user_group', 'user_id = ?', groupUser)).toBe(1);
  });
});

describe('rebindProvider', () => {
  it('revokes bound tokens and blocks the old subjects before the identities are deleted', async () => {
    const result = await rebindProvider(executor, org, OIDC, ANCHOR, ANCHOR_NEW, NOW);

    expect(result).toEqual({ swapped: true, identities: 2, sessions: 1 });
    expect(await rows('SELECT id, revoked_at FROM token ORDER BY id')).toEqual([
      { id: TOKEN_CF, revoked_at: null },
      { id: TOKEN_LOCAL, revoked_at: null },
      { id: TOKEN_OIDC, revoked_at: NOW },
    ]);
    expect(
      await count(
        'token',
        "validation_kind = 'sso' AND validation_identity_id IS NULL AND revoked_at IS NULL",
      ),
    ).toBe(0);
    expect(
      await rows('SELECT provider, issuer, subject FROM identity_block ORDER BY subject'),
    ).toEqual([
      { provider: OIDC, issuer: ANCHOR, subject: 'sub-actor' },
      { provider: OIDC, issuer: ANCHOR, subject: 'sub-target' },
    ]);
    expect(await count('identity', 'provider = ?', OIDC)).toBe(0);
  });

  it('leaves tokens and blocks alone when the expected anchor is stale', async () => {
    const result = await rebindProvider(
      executor,
      org,
      OIDC,
      ANCHOR_NEW,
      'oidc:https://other.example.test',
      NOW,
    );

    expect(result.swapped).toBe(false);
    expect(await count('identity_block')).toBe(0);
    expect(await count('token', 'revoked_at IS NOT NULL')).toBe(0);
    expect(await count('identity', 'provider = ?', OIDC)).toBe(2);
  });

  it('survives a second rebind that blocks the same subject under the same anchor', async () => {
    await rebindProvider(executor, org, OIDC, ANCHOR, ANCHOR_NEW, NOW);
    await executor.batch([
      identityStatement(
        '01J0IDENTAGAIN000000000000',
        TARGET,
        OIDC,
        'sub-target',
        'target@example.test',
      ),
    ]);
    await rebindProvider(executor, org, OIDC, ANCHOR_NEW, ANCHOR, NOW);
    await executor.batch([
      identityStatement(
        '01J0IDENTAGAIN000000000001',
        TARGET,
        OIDC,
        'sub-target',
        'target@example.test',
      ),
    ]);
    const third = await rebindProvider(executor, org, OIDC, ANCHOR, ANCHOR_NEW, NOW);
    expect(third.swapped).toBe(true);
    expect(await count('identity_block', 'subject = ?', 'sub-target')).toBe(2);
  });
});

describe('unlinkIdentity against concurrent holder changes', () => {
  const SECOND_SESSION = '01J0SESSADMIN0000000000002';

  function held(connection: SqlExecutor) {
    let release!: () => void;
    let arrive!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gated: SqlExecutor = {
      driver: connection.driver,
      all: (statement) => connection.all(statement),
      batch: async (statements) => {
        arrive();
        await open;
        return connection.batch(statements);
      },
    };
    return { executor: gated, reached, release };
  }

  async function twoHolders(): Promise<void> {
    await executor.batch([
      userStatement(SECOND_ADMIN, 'second@example.test'),
      identityStatement(SECOND_IDENTITY, SECOND_ADMIN, OIDC, 'sub-second', 'second@example.test'),
      sessionStatement(SECOND_SESSION, SECOND_ADMIN, null),
      grantStatement(GRANT_SECOND, 'second@example.test'),
    ]);
  }

  const unlinkActor = (connection: SqlExecutor) =>
    unlinkIdentity(
      connection,
      org,
      fenceOf(SECOND_ADMIN, SECOND_SESSION),
      input({ identityId: ACTOR_IDENTITY, userId: ACTOR, subject: 'sub-actor' }),
    );

  const unlinkSecond = (connection: SqlExecutor) =>
    unlinkIdentity(
      connection,
      org,
      fenceOf(ACTOR, ACTOR_SESSION),
      input({ identityId: SECOND_IDENTITY, userId: SECOND_ADMIN, subject: 'sub-second' }),
    );

  async function holderCount(): Promise<number> {
    const repository = createGrantRepository(executor, { holderInput: async () => holders() });
    return repository.countProtectedHolders(org);
  }

  for (const order of ['suspend first', 'unlink first'] as const) {
    it(`keeps a protected holder when one admin suspends the other while it is unlinked, ${order}`, async () => {
      await twoHolders();
      const second = await database.second();
      const suspendGate = held(second);
      const unlinkGate = held(executor);
      const suspending = createGrantRepository(suspendGate.executor, {
        holderInput: async () => holders(),
      }).suspendUser(org, fenceOf(SECOND_ADMIN, SECOND_SESSION), ACTOR, '2026-10-15T13:00:00.000Z');
      const unlinking = unlinkSecond(unlinkGate.executor);
      await Promise.all([suspendGate.reached, unlinkGate.reached]);
      const suspendFirst = order === 'suspend first';
      (suspendFirst ? suspendGate : unlinkGate).release();
      await (suspendFirst ? suspending : unlinking);
      (suspendFirst ? unlinkGate : suspendGate).release();
      const [suspended, unlinked] = await Promise.all([suspending, unlinking]);

      expect([suspended, unlinked]).toEqual(
        suspendFirst ? ['suspended', 'authority'] : ['authority', 'unlinked'],
      );
      expect(await holderCount()).toBe(1);
    });
  }

  for (const order of ['first holder', 'second holder'] as const) {
    it(`lets only one of two unlinks of the last holders' evidence commit, ${order} first`, async () => {
      await twoHolders();
      const second = await database.second();
      const left = held(executor);
      const right = held(second);
      const unlinkingSecond = unlinkSecond(left.executor);
      const unlinkingActor = unlinkActor(right.executor);
      await Promise.all([left.reached, right.reached]);
      const leftFirst = order === 'first holder';
      (leftFirst ? left : right).release();
      await (leftFirst ? unlinkingSecond : unlinkingActor);
      (leftFirst ? right : left).release();
      const outcomes = await Promise.all([unlinkingSecond, unlinkingActor]);

      expect(outcomes).toEqual(leftFirst ? ['unlinked', 'authority'] : ['authority', 'unlinked']);
      expect(await holderCount()).toBe(1);
      expect(await count('identity_block')).toBe(1);
    });
  }

  for (const order of ['first admin', 'second admin'] as const) {
    it(`lets only one admin unlink their own identity when both try at once, ${order} first`, async () => {
      await twoHolders();
      const second = await database.second();
      const left = held(executor);
      const right = held(second);
      const unlinkingFirst = unlinkIdentity(
        left.executor,
        org,
        fenceOf(ACTOR, ACTOR_SESSION),
        input({ identityId: ACTOR_IDENTITY, userId: ACTOR, subject: 'sub-actor' }),
      );
      const unlinkingSecond = unlinkIdentity(
        right.executor,
        org,
        fenceOf(SECOND_ADMIN, SECOND_SESSION),
        input({ identityId: SECOND_IDENTITY, userId: SECOND_ADMIN, subject: 'sub-second' }),
      );
      await Promise.all([left.reached, right.reached]);
      const leftFirst = order === 'first admin';
      (leftFirst ? left : right).release();
      await (leftFirst ? unlinkingFirst : unlinkingSecond);
      (leftFirst ? right : left).release();
      const outcomes = await Promise.all([unlinkingFirst, unlinkingSecond]);

      expect(outcomes).toEqual(
        leftFirst ? ['unlinked', 'last_holder'] : ['last_holder', 'unlinked'],
      );
      expect(await holderCount()).toBe(1);
      expect(await count('identity_block')).toBe(1);
    });
  }
});
