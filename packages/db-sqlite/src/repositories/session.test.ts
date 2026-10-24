import { expressionBuilder } from 'kysely';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { NewSession } from '@package-broker/core/db/sessions';
import { DbError } from '@package-broker/core/db/errors';
import { countCalls } from '../contract/count-calls.js';
import { adminEligibility, existsGuard, opGuard, ownsIdentity, type Database } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createSessionRepository,
  revokeAllForUserStatement,
  revokePreviousStatement,
  sessionInsertStatement,
} from './session.js';

const NOW = '2026-10-15T12:00:00.000Z';
const IDLE_SINCE = '2026-10-15T11:00:00.000Z';
const FUTURE = '2026-10-15T20:00:00.000Z';
const PAST = '2026-10-15T10:00:00.000Z';
const RECENT = '2026-10-15T11:30:00.000Z';
const CUTOFFS = { now: NOW, idleSince: IDLE_SINCE };
const userEb = expressionBuilder<Database, 'user_account'>();
const sessionEb = expressionBuilder<Database, 'session'>();

const USER_A = '01J0USERA0000000000000000A';
const USER_B = '01J0USERB0000000000000000B';
const SUSPENDED = '01J0USERS0000000000000000S';
const USER_OTHER = '01J0USERO0000000000000000O';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

function reauthAudit(): AuditEvent {
  return {
    id: ulid(),
    occurredAt: NOW,
    action: 'session.reauth',
    actor: { type: 'user', id: USER_A },
    target: { type: 'session', id: 's1' },
    tokenSelector: null,
    sourceIp: '203.0.113.7',
    projectId: null,
    payloadJson: '{}',
  };
}

async function pendingReauth(ctx: OrgContext = a) {
  return executor.all({
    sql: 'SELECT * FROM audit_pending WHERE org_id = ? AND action = ?',
    params: [ctx.orgId, 'session.reauth'],
  });
}

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await executor.batch([
    userStatement(a, USER_A, 'a@example.test', 'Ada', 'active'),
    userStatement(b, USER_B, 'b@example.test', null, 'active'),
    userStatement(a, SUSPENDED, 's@example.test', null, 'suspended'),
  ]);
});

afterEach(async () => {
  await database.close();
});

function userStatement(
  ctx: OrgContext,
  id: string,
  email: string,
  displayName: string | null,
  status: string,
): Statement {
  return {
    sql: 'INSERT INTO user_account (id, org_id, email, display_name, status) VALUES (?, ?, ?, ?, ?)',
    params: [id, ctx.orgId, email, displayName, status],
  };
}

interface Seed {
  readonly id: string;
  readonly org?: OrgContext;
  readonly userId?: string;
  readonly identityId?: string | null;
  readonly secret?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly lastSeenAt?: string | null;
  readonly reauthAt?: string | null;
  readonly revokedAt?: string | null;
}

async function seed(input: Seed): Promise<void> {
  const org = input.org ?? a;
  await executor.batch([
    {
      sql: `INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at,
              expires_at, last_seen_at, reauth_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.id,
        org.orgId,
        input.userId ?? USER_A,
        input.identityId ?? null,
        hash(input.secret ?? input.id),
        hash('csrf'),
        input.createdAt ?? '2026-10-15T09:00:00.000Z',
        input.expiresAt ?? FUTURE,
        input.lastSeenAt ?? null,
        input.reauthAt ?? null,
        input.revokedAt ?? null,
      ],
    },
  ]);
}

async function row(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await executor.all<Record<string, unknown>>({
    sql: 'SELECT * FROM session WHERE id = ?',
    params: [id],
  });
  return rows[0];
}

async function seedIdentity(id: string, userId: string, subject: string): Promise<void> {
  await executor.batch([
    {
      sql: `INSERT INTO identity (id, org_id, user_id, provider, subject, email)
            VALUES (?, ?, ?, 'oidc', ?, 'x@example.test')`,
      params: [id, a.orgId, userId, subject],
    },
  ]);
}

function newSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: 'new-session',
    userId: USER_A,
    identityId: null,
    secretHash: hash('new'),
    csrfHash: hash('newcsrf'),
    expiresAt: FUTURE,
    ip: '203.0.113.7',
    userAgent: 'agent/1.0',
    now: NOW,
    ...overrides,
  };
}

describe('findActive', () => {
  it('returns the session and the user for a live row with one executor call', async () => {
    await seed({ id: 's1', lastSeenAt: RECENT, reauthAt: RECENT, identityId: null });
    const counted = countCalls(executor);
    const repository = createSessionRepository(counted.executor);

    const found = await repository.findActive(a, hash('s1'), CUTOFFS);

    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    expect(found).toEqual({
      id: 's1',
      userId: USER_A,
      identityId: null,
      csrfHash: hash('csrf'),
      createdAt: '2026-10-15T09:00:00.000Z',
      expiresAt: FUTURE,
      lastSeenAt: RECENT,
      reauthAt: RECENT,
      user: { id: USER_A, email: 'a@example.test', displayName: 'Ada' },
    });
  });

  it('returns a freshly created session whose last_seen_at is still null', async () => {
    await seed({ id: 's1', createdAt: RECENT, lastSeenAt: null });
    const found = await createSessionRepository(executor).findActive(a, hash('s1'), CUTOFFS);
    expect(found?.lastSeenAt).toBeNull();
    expect(found?.user.displayName).toBe('Ada');
  });

  it.each([
    ['expired', { expiresAt: PAST, lastSeenAt: RECENT }],
    ['expiring exactly now', { expiresAt: NOW, lastSeenAt: RECENT }],
    ['idle by last_seen_at', { lastSeenAt: '2026-10-15T10:59:59.000Z' }],
    ['idle exactly at the cutoff', { lastSeenAt: IDLE_SINCE }],
    ['idle by created_at when never seen', { createdAt: '2026-10-15T10:00:00.000Z' }],
    ['revoked', { lastSeenAt: RECENT, revokedAt: PAST }],
    ['of a suspended user', { lastSeenAt: RECENT, userId: SUSPENDED }],
  ])('returns null for a session that is %s', async (_label, overrides: Partial<Seed>) => {
    await seed({ id: 's1', ...overrides });
    const found = await createSessionRepository(executor).findActive(a, hash('s1'), CUTOFFS);
    expect(found).toBeNull();
  });

  it('returns null for another organization and for an unknown hash', async () => {
    await seed({ id: 's1', lastSeenAt: RECENT });
    const repository = createSessionRepository(executor);
    expect(await repository.findActive(b, hash('s1'), CUTOFFS)).toBeNull();
    expect(await repository.findActive(a, hash('unknown'), CUTOFFS)).toBeNull();
  });

  it('returns null for a session of organization B whose user is in organization A', async () => {
    await seed({ id: 's1', org: b, userId: USER_A, lastSeenAt: RECENT });
    const repository = createSessionRepository(executor);
    expect(await repository.findActive(b, hash('s1'), CUTOFFS)).toBeNull();
  });
});

describe('touch', () => {
  it('changes nothing when last_seen_at is recent', async () => {
    await seed({ id: 's1', lastSeenAt: RECENT });
    await createSessionRepository(executor).touch(a, 's1', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('s1'))?.last_seen_at).toBe(RECENT);
  });

  it('writes now when last_seen_at is stale', async () => {
    await seed({ id: 's1', lastSeenAt: '2026-10-15T11:00:00.000Z' });
    await createSessionRepository(executor).touch(a, 's1', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('s1'))?.last_seen_at).toBe(NOW);
  });

  it('writes now when never seen and created before the stale mark', async () => {
    await seed({ id: 's1', createdAt: '2026-10-15T09:00:00.000Z', lastSeenAt: null });
    await createSessionRepository(executor).touch(a, 's1', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('s1'))?.last_seen_at).toBe(NOW);
  });

  it('leaves a never-seen session created after the stale mark alone', async () => {
    await seed({ id: 's1', createdAt: RECENT, lastSeenAt: null });
    await createSessionRepository(executor).touch(a, 's1', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('s1'))?.last_seen_at).toBeNull();
  });

  it('changes nothing on an absolutely expired session', async () => {
    await seed({ id: 's1', expiresAt: PAST, lastSeenAt: '2026-10-15T09:30:00.000Z' });
    await createSessionRepository(executor).touch(a, 's1', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('s1'))?.last_seen_at).toBe('2026-10-15T09:30:00.000Z');
  });

  it('does not touch a revoked session or another organization session', async () => {
    await seed({ id: 'revoked', lastSeenAt: PAST, revokedAt: PAST });
    await seed({ id: 'other', lastSeenAt: PAST });
    const repository = createSessionRepository(executor);
    await repository.touch(a, 'revoked', NOW, '2026-10-15T11:25:00.000Z');
    await repository.touch(b, 'other', NOW, '2026-10-15T11:25:00.000Z');
    expect((await row('revoked'))?.last_seen_at).toBe(PAST);
    expect((await row('other'))?.last_seen_at).toBe(PAST);
  });
});

describe('sessionInsertStatement', () => {
  it('inserts the row and returns its id when the guard holds', async () => {
    await executor.batch([
      {
        sql: 'INSERT INTO local_login (user_id, org_id, last_op_id) VALUES (?, ?, ?)',
        params: [USER_A, a.orgId, 'op-1'],
      },
    ]);
    const [result] = await executor.batch([
      sessionInsertStatement(a, newSession(), [
        opGuard(a, 'local_login', { userId: USER_A }, 'op-1'),
      ]),
    ]);
    expect(result?.rows).toEqual([{ id: 'new-session' }]);
    expect(result?.changes).toBe(1);
    expect(await row('new-session')).toMatchObject({
      org_id: a.orgId,
      user_id: USER_A,
      identity_id: null,
      secret_hash: hash('new'),
      csrf_hash: hash('newcsrf'),
      created_at: NOW,
      expires_at: FUTURE,
      last_seen_at: null,
      reauth_at: null,
      revoked_at: null,
      ip: '203.0.113.7',
      user_agent: 'agent/1.0',
    });
  });

  it('inserts with no guards for an active user', async () => {
    const [result] = await executor.batch([sessionInsertStatement(a, newSession(), [])]);
    expect(result?.rows).toHaveLength(1);
  });

  it('inserts nothing when a guard fails', async () => {
    await executor.batch([
      {
        sql: 'INSERT INTO local_login (user_id, org_id, last_op_id) VALUES (?, ?, ?)',
        params: [USER_A, a.orgId, 'op-1'],
      },
    ]);
    const [result] = await executor.batch([
      sessionInsertStatement(a, newSession(), [
        opGuard(a, 'local_login', { userId: USER_A }, 'op-2'),
      ]),
    ]);
    expect(result?.rows).toEqual([]);
    expect(result?.changes).toBe(0);
    expect(await row('new-session')).toBeUndefined();
  });

  it('inserts nothing when one of several guards fails', async () => {
    const holds = existsGuard((database) =>
      database.selectFrom('organization').select('id').where('id', '=', a.orgId),
    );
    const fails = existsGuard((database) =>
      database.selectFrom('organization').select('id').where('id', '=', 'nope'),
    );
    const [result] = await executor.batch([
      sessionInsertStatement(a, newSession(), [holds, fails]),
    ]);
    expect(result?.rows).toEqual([]);
  });

  it('inserts nothing for a suspended user', async () => {
    const [result] = await executor.batch([
      sessionInsertStatement(a, newSession({ userId: SUSPENDED }), []),
    ]);
    expect(result?.rows).toEqual([]);
    expect(await row('new-session')).toBeUndefined();
  });

  it('inserts nothing for a user of another organization or an unknown user', async () => {
    const [other, unknown] = await executor.batch([
      sessionInsertStatement(a, newSession({ userId: USER_B }), []),
      sessionInsertStatement(a, newSession({ id: 'ghost', userId: 'ghost' }), []),
    ]);
    expect(other?.rows).toEqual([]);
    expect(unknown?.rows).toEqual([]);
  });

  it('stores the identity id and truncates user_agent to 512 and ip to 64 characters', async () => {
    await seedIdentity('identity-1', USER_A, 'subject-1');
    await executor.batch([
      sessionInsertStatement(
        a,
        newSession({ identityId: 'identity-1', userAgent: 'u'.repeat(600), ip: '1'.repeat(100) }),
        [],
      ),
    ]);
    const stored = await row('new-session');
    expect(stored?.identity_id).toBe('identity-1');
    expect(stored?.user_agent).toBe('u'.repeat(512));
    expect(stored?.ip).toBe('1'.repeat(64));
  });

  it('does not split a surrogate pair when truncating', async () => {
    const agent = `${'u'.repeat(511)}\u{1F600}tail`;
    await executor.batch([sessionInsertStatement(a, newSession({ userAgent: agent }), [])]);
    expect((await row('new-session'))?.user_agent).toBe('u'.repeat(511));
  });

  it('stores null ip and user agent', async () => {
    await executor.batch([
      sessionInsertStatement(a, newSession({ ip: null, userAgent: null }), []),
    ]);
    const stored = await row('new-session');
    expect(stored?.ip).toBeNull();
    expect(stored?.user_agent).toBeNull();
  });
});

describe('revokePreviousStatement', () => {
  it('revokes the old session in the same batch when the new row was inserted', async () => {
    await seed({ id: 'old', lastSeenAt: RECENT });
    const [inserted, revoked] = await executor.batch([
      sessionInsertStatement(a, newSession(), []),
      revokePreviousStatement(a, hash('old'), 'new-session', NOW),
    ]);
    expect(inserted?.rows).toHaveLength(1);
    expect(revoked?.changes).toBe(1);
    expect((await row('old'))?.revoked_at).toBe(NOW);
    expect((await row('new-session'))?.revoked_at).toBeNull();
  });

  it('leaves the old session alive when the insert was guarded out', async () => {
    await seed({ id: 'old', lastSeenAt: RECENT });
    const fails = existsGuard((database) =>
      database.selectFrom('organization').select('id').where('id', '=', 'nope'),
    );
    const [inserted, revoked] = await executor.batch([
      sessionInsertStatement(a, newSession(), [fails]),
      revokePreviousStatement(a, hash('old'), 'new-session', NOW),
    ]);
    expect(inserted?.rows).toEqual([]);
    expect(revoked?.changes).toBe(0);
    expect((await row('old'))?.revoked_at).toBeNull();
  });

  it('does not revoke another organization session or touch an already revoked one', async () => {
    await seed({ id: 'old-b', org: b, userId: USER_B, secret: 'oldb' });
    await seed({ id: 'old-revoked', secret: 'oldr', revokedAt: PAST });
    await seed({ id: 'old', secret: 'old' });
    await executor.batch([sessionInsertStatement(a, newSession(), [])]);
    const results = await executor.batch([
      revokePreviousStatement(a, hash('oldb'), 'new-session', NOW),
      revokePreviousStatement(a, hash('oldr'), 'new-session', NOW),
    ]);
    expect(results.map((result) => result.changes)).toEqual([0, 0]);
    expect((await row('old-b'))?.revoked_at).toBeNull();
    expect((await row('old-revoked'))?.revoked_at).toBe(PAST);
  });

  it('leaves the previous session alive when a guard is false and revokes it when true', async () => {
    await seed({ id: 'old', secret: 'old' });
    await executor.batch([sessionInsertStatement(a, newSession(), [])]);
    const fails = existsGuard((db) =>
      db.selectFrom('organization').select('id').where('id', '=', 'nope'),
    );
    const passes = existsGuard((db) =>
      db.selectFrom('organization').select('id').where('id', '=', a.orgId),
    );

    const [blocked] = await executor.batch([
      revokePreviousStatement(a, hash('old'), 'new-session', NOW, [passes, fails]),
    ]);
    expect(blocked?.changes).toBe(0);
    expect((await row('old'))?.revoked_at).toBeNull();

    const [allowed] = await executor.batch([
      revokePreviousStatement(a, hash('old'), 'new-session', NOW, [passes]),
    ]);
    expect(allowed?.changes).toBe(1);
    expect((await row('old'))?.revoked_at).toBe(NOW);
  });

  it('never revokes the new session even when it carries the previous hash', async () => {
    await executor.batch([sessionInsertStatement(a, newSession({ secretHash: hash('old') }), [])]);
    const [result] = await executor.batch([
      revokePreviousStatement(a, hash('old'), 'new-session', NOW),
    ]);
    expect(result?.changes).toBe(0);
    expect((await row('new-session'))?.revoked_at).toBeNull();
  });

  it('leaves a session of another organization untouched when its hash is given', async () => {
    await seed({ id: 'old-b', org: b, userId: USER_B, secret: 'old' });
    await executor.batch([sessionInsertStatement(a, newSession(), [])]);
    const [result] = await executor.batch([
      revokePreviousStatement(a, hash('old'), 'new-session', NOW),
    ]);
    expect(result?.changes).toBe(0);
    expect((await row('old-b'))?.revoked_at).toBeNull();
  });

  it('revokes nothing when the new session id belongs to another organization', async () => {
    await seed({ id: 'old', secret: 'old' });
    await seed({ id: 'foreign', org: b, userId: USER_B, secret: 'foreign' });
    const [result] = await executor.batch([
      revokePreviousStatement(a, hash('old'), 'foreign', NOW),
    ]);
    expect(result?.changes).toBe(0);
    expect((await row('old'))?.revoked_at).toBeNull();
  });
});

describe('revokeAllForUserStatement', () => {
  it('revokes every live session of the user and no other', async () => {
    await seed({ id: 's1' });
    await seed({ id: 's2' });
    await seed({ id: 's3', revokedAt: PAST });
    await seed({ id: 'other-user', org: b, userId: USER_B });
    const [result] = await executor.batch([revokeAllForUserStatement(a, USER_A, NOW, [])]);
    expect(result?.changes).toBe(2);
    expect((await row('s1'))?.revoked_at).toBe(NOW);
    expect((await row('s2'))?.revoked_at).toBe(NOW);
    expect((await row('s3'))?.revoked_at).toBe(PAST);
    expect((await row('other-user'))?.revoked_at).toBeNull();
  });

  it('revokes nothing when a guard fails and everything when it holds', async () => {
    await seed({ id: 's1' });
    const fails = existsGuard((database) =>
      database.selectFrom('organization').select('id').where('id', '=', 'nope'),
    );
    const holds = existsGuard((database) =>
      database.selectFrom('organization').select('id').where('id', '=', a.orgId),
    );
    const [blocked] = await executor.batch([
      revokeAllForUserStatement(a, USER_A, NOW, [holds, fails]),
    ]);
    expect(blocked?.changes).toBe(0);
    expect((await row('s1'))?.revoked_at).toBeNull();
    const [allowed] = await executor.batch([revokeAllForUserStatement(a, USER_A, NOW, [holds])]);
    expect(allowed?.changes).toBe(1);
  });

  it('does not reach into another organization', async () => {
    await seed({ id: 's1' });
    const [result] = await executor.batch([revokeAllForUserStatement(b, USER_A, NOW, [])]);
    expect(result?.changes).toBe(0);
    expect((await row('s1'))?.revoked_at).toBeNull();
  });
});

describe('markReauthenticatedByIdentity', () => {
  const AUTH_TIME = '2026-10-15T11:55:00.000Z';

  beforeEach(async () => {
    await seedIdentity('identity-1', USER_A, 'subject-1');
    await seedIdentity('identity-2', USER_A, 'subject-2');
  });

  function mark(
    sessionId: string,
    identityId: string | null,
    authTime = AUTH_TIME,
    ctx: OrgContext = a,
  ): Promise<boolean> {
    return createSessionRepository(executor).markReauthenticatedByIdentity(ctx, {
      audit: reauthAudit(),
      sessionId,
      identityId,
      authTime,
      now: NOW,
    });
  }

  it('stages the session audit and update in one batch', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    const counted = countCalls(executor);
    expect(
      await createSessionRepository(counted.executor).markReauthenticatedByIdentity(a, {
        sessionId: 's1',
        identityId: 'identity-1',
        authTime: AUTH_TIME,
        now: NOW,
        audit: reauthAudit(),
      }),
    ).toBe(true);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    expect(await pendingReauth()).toEqual([
      expect.objectContaining({
        action: 'session.reauth',
        target_type: 'session',
        target_id: 's1',
        actor_type: 'user',
        actor_id: USER_A,
        token_selector: null,
      }),
    ]);
    expect((await row('s1'))?.reauth_at).toBe(AUTH_TIME);
  });

  it.each([
    ['equal', AUTH_TIME],
    ['older', RECENT],
  ])('stages nothing for an %s authentication time', async (_label, authTime) => {
    await seed({ id: 's1', identityId: 'identity-1', reauthAt: AUTH_TIME });
    expect(await mark('s1', 'identity-1', authTime)).toBe(false);
    expect(await pendingReauth()).toEqual([]);
    expect((await row('s1'))?.reauth_at).toBe(AUTH_TIME);
  });

  it.each([
    ['revoked', { revokedAt: PAST }],
    ['expired', { expiresAt: NOW }],
  ])('stages nothing for a %s session', async (_label, overrides) => {
    await seed({ id: 's1', identityId: 'identity-1', ...overrides });
    expect(await mark('s1', 'identity-1')).toBe(false);
    expect(await pendingReauth()).toEqual([]);
  });

  it('stages nothing for a different identity', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('s1', 'identity-2')).toBe(false);
    expect(await pendingReauth()).toEqual([]);
  });

  it('stages nothing across organizations', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('s1', 'identity-1', AUTH_TIME, b)).toBe(false);
    expect(await pendingReauth(a)).toEqual([]);
    expect(await pendingReauth(b)).toEqual([]);
  });

  it('does not move reauth_at when the audit insert fails', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    const audit = reauthAudit();
    const repository = createSessionRepository(executor);
    expect(
      await repository.markReauthenticatedByIdentity(a, {
        sessionId: 's1',
        identityId: 'identity-1',
        authTime: RECENT,
        now: NOW,
        audit,
      }),
    ).toBe(true);
    await expect(
      repository.markReauthenticatedByIdentity(a, {
        sessionId: 's1',
        identityId: 'identity-1',
        authTime: AUTH_TIME,
        now: NOW,
        audit,
      }),
    ).rejects.toThrow();
    expect((await row('s1'))?.reauth_at).toBe(RECENT);
    expect(await pendingReauth()).toHaveLength(1);
  });

  it('rolls back the staged audit when the update fails', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    await executor.batch([
      {
        sql: `CREATE TRIGGER refuse_reauth BEFORE UPDATE OF reauth_at ON session
        BEGIN SELECT RAISE(ABORT, 'refused'); END`,
        params: [],
      },
    ]);
    await expect(mark('s1', 'identity-1')).rejects.toThrow();
    expect(await pendingReauth()).toEqual([]);
    expect((await row('s1'))?.reauth_at).toBeNull();
  });

  it('stages two rows for increasing authentication times', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('s1', 'identity-1', RECENT)).toBe(true);
    expect(await mark('s1', 'identity-1')).toBe(true);
    expect(await pendingReauth()).toHaveLength(2);
  });

  it('stages only one row for a replayed authentication time', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('s1', 'identity-1')).toBe(true);
    expect(await mark('s1', 'identity-1')).toBe(false);
    expect(await pendingReauth()).toHaveLength(1);
  });

  it('is true for the matching identity and stores the authentication time', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('s1', 'identity-1')).toBe(true);
    expect((await row('s1'))?.reauth_at).toBe(AUTH_TIME);
  });

  it('is true for a later authentication time and moves reauth_at forward', async () => {
    await seed({ id: 's1', identityId: 'identity-1', reauthAt: '2026-10-15T11:50:00.000Z' });
    expect(await mark('s1', 'identity-1')).toBe(true);
    expect((await row('s1'))?.reauth_at).toBe(AUTH_TIME);
  });

  it('is true for a session without identity and a null identity id', async () => {
    await seed({ id: 's1', identityId: null });
    expect(await mark('s1', null)).toBe(true);
  });

  it('is false for another identity, a null identity on an SSO session and an identity on a local session', async () => {
    await seed({ id: 's1', identityId: 'identity-1' });
    await seed({ id: 'local', identityId: null });
    expect(await mark('s1', 'identity-2')).toBe(false);
    expect(await mark('s1', null)).toBe(false);
    expect(await mark('local', 'identity-1')).toBe(false);
    expect((await row('s1'))?.reauth_at).toBeNull();
    expect((await row('local'))?.reauth_at).toBeNull();
  });

  it('is false for an authentication time equal to or older than the stored reauth_at', async () => {
    await seed({ id: 's1', identityId: 'identity-1', reauthAt: AUTH_TIME });
    expect(await mark('s1', 'identity-1', AUTH_TIME)).toBe(false);
    expect(await mark('s1', 'identity-1', '2026-10-15T11:00:00.000Z')).toBe(false);
    expect((await row('s1'))?.reauth_at).toBe(AUTH_TIME);
  });

  it('is false for a revoked session, an expired session, an unknown session and another organization', async () => {
    await seed({ id: 'revoked', identityId: 'identity-1', revokedAt: PAST, secret: 'r' });
    await seed({ id: 'expired', identityId: 'identity-1', expiresAt: PAST, secret: 'e' });
    await seed({ id: 's1', identityId: 'identity-1' });
    expect(await mark('revoked', 'identity-1')).toBe(false);
    expect(await mark('expired', 'identity-1')).toBe(false);
    expect(await mark('unknown', 'identity-1')).toBe(false);
    expect(await mark('s1', 'identity-1', AUTH_TIME, b)).toBe(false);
    expect((await row('revoked'))?.reauth_at).toBeNull();
    expect((await row('s1'))?.reauth_at).toBeNull();
  });
});

describe('revoke and revokeBySecretHash', () => {
  it('revokes once and reports false afterwards', async () => {
    await seed({ id: 's1' });
    const repository = createSessionRepository(executor);
    expect(await repository.revoke(a, 's1', NOW)).toBe(true);
    expect(await repository.revoke(a, 's1', '2026-10-15T13:00:00.000Z')).toBe(false);
    expect((await row('s1'))?.revoked_at).toBe(NOW);
  });

  it('does not revoke across organizations or unknown ids', async () => {
    await seed({ id: 's1' });
    const repository = createSessionRepository(executor);
    expect(await repository.revoke(b, 's1', NOW)).toBe(false);
    expect(await repository.revoke(a, 'unknown', NOW)).toBe(false);
    expect((await row('s1'))?.revoked_at).toBeNull();
  });

  it('revokes by secret hash with the same rules', async () => {
    await seed({ id: 's1' });
    const repository = createSessionRepository(executor);
    expect(await repository.revokeBySecretHash(b, hash('s1'), NOW)).toBe(false);
    expect(await repository.revokeBySecretHash(a, hash('unknown'), NOW)).toBe(false);
    expect(await repository.revokeBySecretHash(a, hash('s1'), NOW)).toBe(true);
    expect(await repository.revokeBySecretHash(a, hash('s1'), NOW)).toBe(false);
    expect((await row('s1'))?.revoked_at).toBe(NOW);
  });

  it('uses one executor call per method', async () => {
    await seed({ id: 's1' });
    const counted = countCalls(executor);
    const repository = createSessionRepository(counted.executor);
    await repository.revoke(a, 's1', NOW);
    await repository.revokeBySecretHash(a, hash('s1'), NOW);
    await repository.touch(a, 's1', NOW, NOW);
    await repository.markReauthenticatedByIdentity(a, {
      audit: reauthAudit(),
      sessionId: 's1',
      identityId: null,
      authTime: NOW,
      now: NOW,
    });
    await repository.deleteExpired(a, NOW, 10);
    expect(counted.counts()).toEqual({ all: 4, batch: 1 });
  });
});

describe('deleteExpired', () => {
  it('removes only rows with expires_at before the cutoff', async () => {
    await seed({ id: 'old1', expiresAt: '2026-10-01T00:00:00.000Z', secret: 'o1' });
    await seed({ id: 'old2', expiresAt: '2026-10-02T00:00:00.000Z', secret: 'o2' });
    await seed({ id: 'edge', expiresAt: NOW, secret: 'edge' });
    await seed({ id: 'live', expiresAt: FUTURE, secret: 'live' });
    const removed = await createSessionRepository(executor).deleteExpired(a, NOW, 10);
    expect(removed).toBe(2);
    expect(await row('old1')).toBeUndefined();
    expect(await row('old2')).toBeUndefined();
    expect(await row('edge')).toBeDefined();
    expect(await row('live')).toBeDefined();
  });

  it('removes at most the limit, oldest first', async () => {
    for (let n = 1; n <= 5; n += 1) {
      await seed({ id: `old${n}`, expiresAt: `2026-10-0${n}T00:00:00.000Z`, secret: `o${n}` });
    }
    const repository = createSessionRepository(executor);
    expect(await repository.deleteExpired(a, NOW, 2)).toBe(2);
    expect(await row('old1')).toBeUndefined();
    expect(await row('old2')).toBeUndefined();
    expect(await row('old3')).toBeDefined();
    expect(await repository.deleteExpired(a, NOW, 10)).toBe(3);
    expect(await repository.deleteExpired(a, NOW, 10)).toBe(0);
  });

  it('does not delete another organization sessions', async () => {
    await seed({ id: 'old-b', org: b, userId: USER_B, expiresAt: PAST });
    expect(await createSessionRepository(executor).deleteExpired(a, NOW, 10)).toBe(0);
    expect(await row('old-b')).toBeDefined();
  });

  it.each([0, -1, 1.5, Number.NaN, 501])('rejects the limit %s', async (limit) => {
    await expect(createSessionRepository(executor).deleteExpired(a, NOW, limit)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('sessionInsertStatement identity ownership', () => {
  beforeEach(async () => {
    await executor.batch([userStatement(a, USER_OTHER, 'other@example.test', null, 'active')]);
    await seedIdentity('identity-own', USER_A, 'subject-own');
    await seedIdentity('identity-other', USER_OTHER, 'subject-other');
  });

  it('inserts a session bound to an identity of the same user', async () => {
    const [result] = await executor.batch([
      sessionInsertStatement(a, newSession({ identityId: 'identity-own' }), []),
    ]);
    expect(result?.rows).toHaveLength(1);
  });

  it('inserts nothing for another user identity, an unknown identity or another organization', async () => {
    await executor.batch([
      {
        sql: `INSERT INTO identity (id, org_id, user_id, provider, subject, email)
              VALUES ('identity-b', ?, ?, 'oidc', 'subject-b', 'b@example.test')`,
        params: [b.orgId, USER_B],
      },
    ]);
    const results = await executor.batch([
      sessionInsertStatement(a, newSession({ id: 'n1', identityId: 'identity-other' }), []),
      sessionInsertStatement(a, newSession({ id: 'n2', identityId: 'unknown' }), []),
      sessionInsertStatement(
        b,
        newSession({ id: 'n3', userId: USER_B, identityId: 'identity-own' }),
        [],
      ),
    ]);
    expect(results.map((result) => result.rows.length)).toEqual([0, 0, 0]);
    expect(await row('n1')).toBeUndefined();
    expect(await row('n3')).toBeUndefined();
  });
});

describe('guard composition', () => {
  const ADMIN_ROLE = '01J0ROLE0000000000000000AD';
  const VIEWER_ROLE = '01J0ROLE0000000000000000VW';

  async function seedRoles(): Promise<void> {
    await executor.batch([
      {
        sql: `INSERT INTO role (id, org_id, key, name, scope, protects_last_holder)
              VALUES (?, ?, 'admin', 'admin', 'organization', 1), (?, ?, 'viewer', 'viewer', 'organization', 0)`,
        params: [ADMIN_ROLE, a.orgId, VIEWER_ROLE, a.orgId],
      },
      {
        sql: `INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id)
              VALUES ('grant-admin', ?, 'email', 'a@example.test', 'organization', ?)`,
        params: [a.orgId, ADMIN_ROLE],
      },
    ]);
  }

  it('inserts for an admin-eligible user and nothing for a user without the grant', async () => {
    await seedRoles();
    await executor.batch([userStatement(a, USER_OTHER, 'other@example.test', null, 'active')]);
    const guard = adminEligibility(a, userEb.ref('user_account.id'));
    const [allowed, denied] = await executor.batch([
      sessionInsertStatement(a, newSession({ id: 'ok' }), [guard]),
      sessionInsertStatement(
        a,
        newSession({ id: 'no', userId: USER_OTHER, secretHash: hash('no') }),
        [guard],
      ),
    ]);
    expect(allowed?.rows).toEqual([{ id: 'ok' }]);
    expect(denied?.rows).toEqual([]);
    expect(await row('no')).toBeUndefined();
  });

  it('revokes all sessions of a user only while the identity belongs to that user', async () => {
    await seedIdentity('identity-1', USER_A, 'subject-1');
    await seed({ id: 's1' });
    const mine = ownsIdentity(a, {
      provider: 'oidc',
      subject: 'subject-1',
      userId: sessionEb.ref('session.user_id'),
    });
    const foreign = ownsIdentity(a, {
      provider: 'oidc',
      subject: 'subject-unknown',
      userId: sessionEb.ref('session.user_id'),
    });
    const [blocked] = await executor.batch([revokeAllForUserStatement(a, USER_A, NOW, [foreign])]);
    expect(blocked?.changes).toBe(0);
    expect((await row('s1'))?.revoked_at).toBeNull();
    const [allowed] = await executor.batch([revokeAllForUserStatement(a, USER_A, NOW, [mine])]);
    expect(allowed?.changes).toBe(1);
    expect((await row('s1'))?.revoked_at).toBe(NOW);
  });

  it('fails with DbError when an insert guard references session.user_id', async () => {
    await seedIdentity('identity-1', USER_A, 'subject-1');
    const guard = ownsIdentity(a, {
      provider: 'oidc',
      subject: 'subject-1',
      userId: sessionEb.ref('session.user_id'),
    });
    await expect(
      executor.batch([sessionInsertStatement(a, newSession(), [guard])]),
    ).rejects.toThrow(DbError);
    expect(await row('new-session')).toBeUndefined();
  });
});

describe('markReauthenticatedByIdentity authentication time', () => {
  it('refuses an authentication time later than now and writes nothing', async () => {
    await seed({ id: 's1', identityId: null });
    const repository = createSessionRepository(executor);
    const refused = await repository.markReauthenticatedByIdentity(a, {
      audit: reauthAudit(),
      sessionId: 's1',
      identityId: null,
      authTime: '2026-10-15T12:00:00.001Z',
      now: NOW,
    });
    expect(refused).toBe(false);
    expect((await row('s1'))?.reauth_at).toBeNull();
    expect(await pendingReauth()).toEqual([]);
    const accepted = await repository.markReauthenticatedByIdentity(a, {
      audit: reauthAudit(),
      sessionId: 's1',
      identityId: null,
      authTime: NOW,
      now: NOW,
    });
    expect(accepted).toBe(true);
  });
});

describe('input validation', () => {
  const BAD_TIMESTAMPS = [
    '2026-10-15T12:00:00Z',
    '2026-10-15 12:00:00.000',
    '2026-10-15T12:00:00.000+00:00',
    '2026-10-15T12:00:00.0000Z',
    '2026-99-99T99:99:99.999Z',
    '2026-02-30T12:00:00.000Z',
    '',
    "2026-10-15T12:00:00.000Z' OR '1'='1",
  ];
  const BAD_HASHES = [
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    '',
    `${'a'.repeat(63)}\n`,
  ];

  it.each(BAD_HASHES)(
    'findActive and revokeBySecretHash reject the secret hash %j',
    async (bad) => {
      const repository = createSessionRepository(executor);
      await expect(repository.findActive(a, bad, CUTOFFS)).rejects.toThrow(TypeError);
      await expect(repository.revokeBySecretHash(a, bad, NOW)).rejects.toThrow(TypeError);
    },
  );

  it.each(BAD_TIMESTAMPS)('every timestamp parameter rejects %j', async (bad) => {
    const repository = createSessionRepository(executor);
    const good = hash('s1');
    await expect(
      repository.findActive(a, good, { now: bad, idleSince: IDLE_SINCE }),
    ).rejects.toThrow(TypeError);
    await expect(repository.findActive(a, good, { now: NOW, idleSince: bad })).rejects.toThrow(
      TypeError,
    );
    await expect(repository.touch(a, 's1', bad, IDLE_SINCE)).rejects.toThrow(TypeError);
    await expect(repository.touch(a, 's1', NOW, bad)).rejects.toThrow(TypeError);
    await expect(
      repository.markReauthenticatedByIdentity(a, {
        audit: reauthAudit(),
        sessionId: 's1',
        identityId: null,
        authTime: bad,
        now: NOW,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.markReauthenticatedByIdentity(a, {
        audit: reauthAudit(),
        sessionId: 's1',
        identityId: null,
        authTime: NOW,
        now: bad,
      }),
    ).rejects.toThrow(TypeError);
    await expect(repository.revoke(a, 's1', bad)).rejects.toThrow(TypeError);
    await expect(repository.revokeBySecretHash(a, good, bad)).rejects.toThrow(TypeError);
    await expect(repository.deleteExpired(a, bad, 1)).rejects.toThrow(TypeError);
    expect(() => sessionInsertStatement(a, newSession({ now: bad }), [])).toThrow(TypeError);
    expect(() => sessionInsertStatement(a, newSession({ expiresAt: bad }), [])).toThrow(TypeError);
    expect(() => revokePreviousStatement(a, good, 'new-session', bad)).toThrow(TypeError);
    expect(() => revokeAllForUserStatement(a, USER_A, bad, [])).toThrow(TypeError);
  });

  it('rejects a malformed secret hash in the statement builders', () => {
    expect(() => sessionInsertStatement(a, newSession({ secretHash: 'raw-cookie' }), [])).toThrow(
      TypeError,
    );
    expect(() => revokePreviousStatement(a, 'raw-cookie', 'new-session', NOW)).toThrow(TypeError);
  });
});

describe('active session reads by hash and id', () => {
  it.each([
    ['exactly idle', { lastSeenAt: IDLE_SINCE }, false],
    ['one millisecond inside idle', { lastSeenAt: '2026-10-15T11:00:00.001Z' }, true],
    ['expired', { expiresAt: PAST }, false],
    ['exact expiry', { expiresAt: NOW }, false],
    ['one millisecond before expiry', { expiresAt: '2026-10-15T12:00:00.001Z' }, true],
    ['absolute cap reached', { createdAt: '2026-10-15T00:00:00.000Z' }, false],
    ['one second before absolute cap', { createdAt: '2026-10-15T00:00:01.000Z' }, true],
    ['revoked', { revokedAt: PAST }, false],
    ['inactive user', { userId: SUSPENDED }, false],
    ['malformed expiry', { expiresAt: 'z-invalid' }, false],
    ['malformed last seen', { lastSeenAt: 'z-invalid' }, false],
    ['malformed creation', { createdAt: 'z-invalid' }, false],
    ['offset expiry already elapsed', { expiresAt: '2026-10-15T13:00:00.000+02:00' }, false],
    ['space-formatted live last seen', { lastSeenAt: '2026-10-15 11:30:00.000' }, true],
  ] satisfies readonly (readonly [string, Partial<Seed>, boolean])[])(
    '%s has the same liveness through both keys',
    async (_label, overrides, live) => {
      await seed({ id: 's1', lastSeenAt: RECENT, ...overrides });
      const counted = countCalls(executor);
      const repository = createSessionRepository(counted.executor);
      const byHash = await repository.findActive(a, hash('s1'), CUTOFFS);
      const byId = await repository.findActiveById(a, 's1', CUTOFFS);
      expect(byId).toEqual(byHash);
      if (live) expect(byId?.id).toBe('s1');
      else expect(byId).toBeNull();
      expect(counted.counts()).toEqual({ all: 2, batch: 0 });
    },
  );

  it('returns null by id for an unknown session', async () => {
    expect(
      await createSessionRepository(executor).findActiveById(a, 'unknown', CUTOFFS),
    ).toBeNull();
  });

  it('returns null by id across organizations', async () => {
    await seed({ id: 's1', lastSeenAt: RECENT });
    expect(await createSessionRepository(executor).findActiveById(b, 's1', CUTOFFS)).toBeNull();
  });

  it.each(['', null, undefined, 123, {}])('rejects id %j before querying', async (id) => {
    const counted = countCalls(executor);
    await expect(
      createSessionRepository(counted.executor).findActiveById(a, id as string, CUTOFFS),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('session writer epoch comparisons', () => {
  it.each([
    ['malformed expiry', { expiresAt: 'z-invalid' }],
    ['malformed last seen', { lastSeenAt: '!invalid' }],
    ['malformed creation fallback', { createdAt: '!invalid', lastSeenAt: null }],
    ['offset expiry already elapsed', { expiresAt: '2026-10-15T13:00:00.000+02:00' }],
    ['space-formatted recent last seen', { lastSeenAt: '2026-10-15 11:59:00.000' }],
  ] satisfies readonly (readonly [string, Partial<Seed>])[])(
    'touch leaves %s unchanged',
    async (_label, overrides) => {
      await seed({ id: 's1', lastSeenAt: PAST, ...overrides });
      const before = await row('s1');
      await createSessionRepository(executor).touch(a, 's1', NOW, RECENT);
      expect(await row('s1')).toEqual(before);
    },
  );

  it.each(['z-invalid', '2026-10-15T13:00:00.000+02:00'])(
    'reauthentication refuses expiry %s',
    async (expiresAt) => {
      await seed({ id: 's1', expiresAt });
      expect(
        await createSessionRepository(executor).markReauthenticatedByIdentity(a, {
          audit: reauthAudit(),
          sessionId: 's1',
          identityId: null,
          authTime: RECENT,
          now: NOW,
        }),
      ).toBe(false);
      expect((await row('s1'))?.reauth_at).toBeNull();
    },
  );
});
