import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import type { IdentityBlockStore } from '@package-broker/core/authz/unlink-service';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  SqlExecutor,
  Statement,
} from '@package-broker/core/db/port';
import type { ProtectedHolderInput } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createIdentityBlockRepository, type IdentityBlockKey } from './identity-block.js';
import type { LoginPlan } from '@package-broker/core/db/users';
import { createLoginWriter } from './login.js';

const OIDC = 'oidc';
const ANCHOR = 'oidc:https://idp.example.test';
const OLD_ANCHOR = 'oidc:https://idp-old.example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const OLD = '2026-10-14T08:00:00.000Z';

const ACTOR = '01J0USERACTOR0000000000000';
const ACTOR_IDENTITY = '01J0IDENTACTOR000000000000';
const ACTOR_SESSION = '01J0SESSACTOR0000000000000';
const PLAIN = '01J0USERPLAIN0000000000000';
const PLAIN_SESSION = '01J0SESSPLAIN0000000000000';
const READER = '01J0USERREADER000000000000';
const READER_SESSION = '01J0SESSREADER000000000000';
const ADMIN_ROLE = '01J0ROLEADMIN0000000000000';
const READER_ROLE = '01J0ROLEREADER000000000000';
const RETURNING_USER = '01J0USERBACK00000000000000';
const RETURNING_IDENTITY = '01J0IDENTBACK0000000000000';
const RETURNING_SESSION = '01J0SESSBACK00000000000000';

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;
let executor: SqlExecutor;

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
    ],
  };
}

function repository(connection: ScalarSqlExecutor = executor) {
  return createIdentityBlockRepository(connection, { holderInput: async () => holders() });
}

function fenceOf(userId: string, sessionId: string): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

const actorFence = () => fenceOf(ACTOR, ACTOR_SESSION);

function key(overrides: Partial<IdentityBlockKey> = {}): IdentityBlockKey {
  return { provider: OIDC, issuer: ANCHOR, subject: 'sub-blocked', ...overrides };
}

function blockStatement(ctx: OrgContext, entry: IdentityBlockKey = key()): Statement {
  return stmt(
    'INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_at, blocked_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    ctx.orgId,
    entry.provider,
    entry.issuer,
    entry.subject,
    OLD,
    ctx === org ? ACTOR : null,
  );
}

function userStatement(id: string, email: string): Statement {
  return stmt(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'active')",
    id,
    org.orgId,
    email,
  );
}

function localSession(id: string, userId: string): Statement {
  return stmt(
    'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, reauth_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    hash(id),
    hash(`csrf-${id}`),
    new Date().toISOString(),
    new Date(Date.now() + 3_600_000).toISOString(),
    new Date().toISOString(),
  );
}

function emailGrant(id: string, email: string, roleId: string): Statement {
  return stmt(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?, NULL, ?, ?)",
    id,
    org.orgId,
    email,
    roleId,
    NOW,
    NOW,
  );
}

async function blocks(): Promise<unknown[]> {
  return rows(
    'SELECT org_id, provider, issuer, subject FROM identity_block ORDER BY org_id, subject, issuer',
  );
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
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
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'admin', 'Admin', 'organization', 1)",
      ADMIN_ROLE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'org:users:write')",
      org.orgId,
      ADMIN_ROLE,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'reader', 'Reader', 'organization', 1)",
      READER_ROLE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'org:users:read')",
      org.orgId,
      READER_ROLE,
    ),
    userStatement(ACTOR, 'actor@example.test'),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ACTOR_IDENTITY,
      org.orgId,
      ACTOR,
      OIDC,
      'sub-actor',
      'actor@example.test',
      new Date().toISOString(),
    ),
    localSession(ACTOR_SESSION, ACTOR),
    emailGrant('01J0GRANTACTOR00000000000', 'actor@example.test', ADMIN_ROLE),
    userStatement(PLAIN, 'plain@example.test'),
    localSession(PLAIN_SESSION, PLAIN),
    userStatement(READER, 'reader@example.test'),
    localSession(READER_SESSION, READER),
    emailGrant('01J0GRANTREADER0000000000', 'reader@example.test', READER_ROLE),
    blockStatement(org),
    blockStatement(org, key({ subject: 'sub-kept' })),
    blockStatement(org, key({ issuer: OLD_ANCHOR })),
    blockStatement(other),
  ]);
});

afterEach(async () => {
  await database.close();
});

async function expectAllBlocks(): Promise<void> {
  expect(await blocks()).toEqual([
    { org_id: org.orgId, provider: OIDC, issuer: OLD_ANCHOR, subject: 'sub-blocked' },
    { org_id: org.orgId, provider: OIDC, issuer: ANCHOR, subject: 'sub-blocked' },
    { org_id: org.orgId, provider: OIDC, issuer: ANCHOR, subject: 'sub-kept' },
    { org_id: other.orgId, provider: OIDC, issuer: ANCHOR, subject: 'sub-blocked' },
  ]);
}

describe('unblock', () => {
  it('serves as the core identity block store', async () => {
    const store: IdentityBlockStore = repository();
    expect(await store.unblock(org, actorFence(), key())).toBe('unblocked');
  });

  it('deletes exactly the one block row, and a second call is not_found', async () => {
    const before = await count('identity_block');
    expect(await repository().unblock(org, actorFence(), key())).toBe('unblocked');
    expect(await count('identity_block')).toBe(before - 1);
    expect(
      await count(
        'identity_block',
        'org_id = ? AND provider = ? AND issuer = ? AND subject = ?',
        org.orgId,
        OIDC,
        ANCHOR,
        'sub-blocked',
      ),
    ).toBe(0);
    expect(await count('identity_block', 'org_id = ?', other.orgId)).toBe(1);
    expect(await count('identity_block', 'subject = ?', 'sub-kept')).toBe(1);
    expect(await count('identity_block', 'issuer = ?', OLD_ANCHOR)).toBe(1);

    expect(await repository().unblock(org, actorFence(), key())).toBe('not_found');
    expect(await count('identity_block')).toBe(before - 1);
  });

  it('is not_found for a key that matches only on another issuer, provider or subject', async () => {
    for (const miss of [
      key({ issuer: 'oidc:https://elsewhere.example.test' }),
      key({ provider: 'cf' }),
      key({ subject: 'sub-unknown' }),
    ]) {
      expect(await repository().unblock(org, actorFence(), miss)).toBe('not_found');
    }
    await expectAllBlocks();
  });

  it('treats another organization block as not_found and leaves it in place', async () => {
    await executor.batch([blockStatement(other, key({ subject: 'sub-only-b' }))]);
    expect(await repository().unblock(org, actorFence(), key({ subject: 'sub-only-b' }))).toBe(
      'not_found',
    );
    expect(
      await count('identity_block', 'org_id = ? AND subject = ?', other.orgId, 'sub-only-b'),
    ).toBe(1);
  });

  it('refuses the actor inside another organization context without touching either', async () => {
    expect(await repository().unblock(other, actorFence(), key())).toBe('authority');
    await expectAllBlocks();
  });

  it('refuses a user without any organization role', async () => {
    expect(await repository().unblock(org, fenceOf(PLAIN, PLAIN_SESSION), key())).toBe('authority');
    await expectAllBlocks();
  });

  it('refuses a protected holder without org:users:write', async () => {
    expect(await repository().unblock(org, fenceOf(READER, READER_SESSION), key())).toBe(
      'authority',
    );
    await expectAllBlocks();
  });

  it('refuses a holder of org:users:write whose role protects no holder', async () => {
    await executor.batch([
      stmt('UPDATE role SET protects_last_holder = 0 WHERE id = ?', ADMIN_ROLE),
    ]);
    expect(await repository().unblock(org, actorFence(), key())).toBe('authority');
    await expectAllBlocks();
  });

  it('refuses an actor whose session is revoked, expired or belongs to someone else', async () => {
    expect(await repository().unblock(org, fenceOf(ACTOR, PLAIN_SESSION), key())).toBe('authority');
    await executor.batch([
      stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, ACTOR_SESSION),
    ]);
    expect(await repository().unblock(org, actorFence(), key())).toBe('authority');
    await executor.batch([
      stmt('UPDATE session SET revoked_at = NULL, expires_at = ? WHERE id = ?', OLD, ACTOR_SESSION),
    ]);
    expect(await repository().unblock(org, actorFence(), key())).toBe('authority');
    await expectAllBlocks();
  });

  it('refuses an actor whose reauthentication is missing or outside the window', async () => {
    const stale = new Date(Date.now() - REAUTH_WINDOW_MS - 60_000).toISOString();
    for (const reauthAt of [null, stale]) {
      await executor.batch([
        stmt('UPDATE session SET reauth_at = ? WHERE id = ?', reauthAt, ACTOR_SESSION),
      ]);
      expect(await repository().unblock(org, actorFence(), key())).toBe('authority');
    }
    await expectAllBlocks();
  });

  it('refuses when the reauth window closes after the request was checked but before the batch runs', async () => {
    const stale = new Date(Date.now() - REAUTH_WINDOW_MS - 60_000).toISOString();
    const expiring: ScalarSqlExecutor = {
      driver: executor.driver,
      all: <R>(statement: ScalarStatement) => executor.all<R>(statement),
      batch: async (batch: readonly ScalarStatement[]) => {
        await executor.batch([
          stmt('UPDATE session SET reauth_at = ? WHERE id = ?', stale, ACTOR_SESSION),
        ]);
        return executor.batch(batch);
      },
    };
    expect(await repository(expiring).unblock(org, actorFence(), key())).toBe('authority');
    expect(
      await count(
        'identity_block',
        'org_id = ? AND provider = ? AND issuer = ? AND subject = ?',
        org.orgId,
        OIDC,
        ANCHOR,
        'sub-blocked',
      ),
    ).toBe(1);
    await expectAllBlocks();
  });

  it('refuses a suspended actor', async () => {
    await executor.batch([
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", ACTOR),
    ]);
    expect(await repository().unblock(org, actorFence(), key())).toBe('authority');
    await expectAllBlocks();
  });

  it('rolls back a false postcondition and reports it unclassified', async () => {
    await executor.batch([
      stmt(
        "CREATE TRIGGER keep_block BEFORE DELETE ON identity_block WHEN OLD.subject = 'sub-blocked' BEGIN SELECT RAISE(IGNORE); END",
      ),
    ]);
    await expect(repository().unblock(org, actorFence(), key())).rejects.toThrow(
      'identity unblock failed unclassified (unclassified)',
    );
    await expectAllBlocks();
  });

  it('rejects a malformed key before any statement runs', async () => {
    const statements: ScalarStatement[] = [];
    const spy: ScalarSqlExecutor = {
      driver: executor.driver,
      all: <R>(statement: ScalarStatement) => {
        statements.push(statement);
        return executor.all<R>(statement);
      },
      batch: (batch: readonly ScalarStatement[]) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    };
    for (const bad of [
      key({ provider: 'Bad Provider!' }),
      key({ issuer: 'not-an-anchor' }),
      key({ subject: '' }),
      key({ subject: 'a\u0000b' }),
      null as unknown as IdentityBlockKey,
    ]) {
      await expect(repository(spy).unblock(org, actorFence(), bad)).rejects.toThrow(TypeError);
    }
    expect(statements).toHaveLength(0);
    await expectAllBlocks();
  });

  it('rejects a malformed key before resolving the holder input', async () => {
    let resolved = 0;
    const counted = createIdentityBlockRepository(executor, {
      holderInput: () => {
        resolved += 1;
        return holders();
      },
    });
    await expect(counted.unblock(org, actorFence(), key({ subject: '' }))).rejects.toThrow(
      TypeError,
    );
    expect(resolved).toBe(0);
    expect(await counted.unblock(org, actorFence(), key())).toBe('unblocked');
    expect(resolved).toBe(1);
  });

  it('binds at most 100 parameters in every statement it sends', async () => {
    const statements: ScalarStatement[] = [];
    const spy: ScalarSqlExecutor = {
      driver: executor.driver,
      all: <R>(statement: ScalarStatement) => {
        statements.push(statement);
        return executor.all<R>(statement);
      },
      batch: (batch: readonly ScalarStatement[]) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    };
    expect(await repository(spy).unblock(org, actorFence(), key())).toBe('unblocked');
    expect(await repository(spy).unblock(org, actorFence(), key())).toBe('not_found');
    expect(await repository(spy).unblock(org, fenceOf(PLAIN, PLAIN_SESSION), key())).toBe(
      'authority',
    );
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
    }
  });
});

function loginPlan(overrides: Partial<LoginPlan> = {}): LoginPlan {
  const userId = overrides.userId ?? RETURNING_USER;
  const identityId = overrides.identityId ?? RETURNING_IDENTITY;
  return {
    userId,
    createUser: true,
    autoJoin: true,
    email: 'back@example.test',
    displayName: 'Back',
    identityId,
    provider: OIDC,
    trustAnchor: ANCHOR,
    subject: 'sub-blocked',
    emailVerified: true,
    groups: [],
    evidenceTime: NOW,
    session: {
      id: RETURNING_SESSION,
      userId,
      identityId,
      secretHash: hash('back-secret'),
      csrfHash: hash('back-csrf'),
      expiresAt: '2026-10-16T00:00:00.000Z',
      ip: null,
      userAgent: null,
      now: NOW,
    },
    previousSecretHash: null,
    now: NOW,
    ...overrides,
  };
}

describe('login after unblock', () => {
  it('refuses the blocked subject, then accepts it once the block is lifted', async () => {
    const writer = createLoginWriter(executor);
    expect(await writer.commit(org, loginPlan())).toBe('refused');
    expect(await count('identity', 'subject = ?', 'sub-blocked')).toBe(0);

    expect(await repository().unblock(org, actorFence(), key())).toBe('unblocked');

    expect(await writer.commit(org, loginPlan())).toBe('created');
    expect(
      await rows(
        'SELECT user_id, provider, subject FROM identity WHERE id = ?',
        RETURNING_IDENTITY,
      ),
    ).toEqual([{ user_id: RETURNING_USER, provider: OIDC, subject: 'sub-blocked' }]);
    expect(await count('session', 'id = ?', RETURNING_SESSION)).toBe(1);
  });

  it('keeps refusing the subject when only the block under another issuer is lifted', async () => {
    expect(await repository().unblock(org, actorFence(), key({ issuer: OLD_ANCHOR }))).toBe(
      'unblocked',
    );
    expect(await createLoginWriter(executor).commit(org, loginPlan())).toBe('refused');
    expect(await count('identity', 'subject = ?', 'sub-blocked')).toBe(0);
  });

  it('keeps refusing in the other organization after this one lifts its block', async () => {
    await executor.batch([
      stmt(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        other.orgId,
        OIDC,
        ANCHOR,
      ),
    ]);
    expect(await repository().unblock(org, actorFence(), key())).toBe('unblocked');
    expect(await createLoginWriter(executor).commit(other, loginPlan())).toBe('refused');
    expect(await count('identity', 'org_id = ?', other.orgId)).toBe(0);
  });
});
