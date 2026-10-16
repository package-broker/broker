import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoginPlan } from '@package-broker/core/db/users';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  SqlExecutor,
  Statement,
} from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLoginWriter } from './login.js';

const EVIDENCE = '2026-10-15T11:59:00.000Z';
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-10-16T00:00:00.000Z';
const OLD = '2026-10-14T08:00:00.000Z';
const PROVIDER = 'dex';
const OTHER_PROVIDER = 'access';
const ANCHOR = 'oidc:https://dex.example.test';
const OTHER_ANCHOR = 'oidc:https://dex-old.example.test';
const SUBJECT = 'sub-1';

const USER_X = '01J0USERX0000000000000000X';
const USER_NEW = '01J0USERN0000000000000000N';
const IDENTITY_X = '01J0IDENTX000000000000000X';
const IDENTITY_NEW = '01J0IDENTN000000000000000N';
const SESSION_NEW = '01J0SESSN000000000000000NN';
const SESSION_OLD = '01J0SESSO000000000000000OO';
const ROLE = '01J0ROLEVIEWER000000000000';
const GRANT = '01J0GRANTINV0000000000000';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

function stmt(sql: string, ...params: (string | null)[]): Statement {
  return { sql, params };
}

async function count(table: string, where = '1 = 1', ...params: string[]): Promise<number> {
  const found = await executor.all<{ n: number }>({
    sql: `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  });
  return Number(found[0]?.n ?? 0);
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  const read = (sql: string) => executor.all({ sql, params: [] });
  return {
    users: await read('SELECT * FROM user_account ORDER BY id'),
    identities: await read('SELECT * FROM identity ORDER BY id'),
    groups: await read('SELECT * FROM user_group ORDER BY user_id, provider, group_name'),
    sessions: await read('SELECT * FROM session ORDER BY id'),
  };
}

function block(
  ctx: OrgContext,
  options: { provider?: string; issuer?: string; subject?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_at) VALUES (?, ?, ?, ?, ?)',
    ctx.orgId,
    options.provider ?? PROVIDER,
    options.issuer ?? ANCHOR,
    options.subject ?? SUBJECT,
    OLD,
  );
}

function binding(ctx: OrgContext): Statement {
  return stmt(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    ctx.orgId,
    PROVIDER,
    ANCHOR,
  );
}

async function seedReturning(): Promise<void> {
  await executor.batch([
    stmt(
      "INSERT INTO user_account (id, org_id, email, display_name, status, last_login_at) VALUES (?, ?, ?, 'Old', 'active', ?)",
      USER_X,
      a.orgId,
      'x@example.test',
      OLD,
    ),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      IDENTITY_X,
      a.orgId,
      USER_X,
      PROVIDER,
      SUBJECT,
      'x@example.test',
      OLD,
    ),
    binding(a),
    stmt(
      'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
      a.orgId,
      USER_X,
      PROVIDER,
      'old-group',
      OLD,
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION_OLD,
      a.orgId,
      USER_X,
      IDENTITY_X,
      hash('old-secret'),
      hash('old-csrf'),
      OLD,
      EXPIRES,
    ),
  ]);
}

function plan(overrides: Partial<LoginPlan> = {}): LoginPlan {
  const userId = overrides.userId ?? USER_NEW;
  const identityId = overrides.identityId ?? IDENTITY_NEW;
  return {
    userId,
    createUser: true,
    autoJoin: true,
    email: 'ada@example.test',
    displayName: 'Ada',
    identityId,
    provider: PROVIDER,
    trustAnchor: ANCHOR,
    subject: SUBJECT,
    emailVerified: true,
    groups: ['admins'],
    evidenceTime: EVIDENCE,
    session: {
      id: SESSION_NEW,
      userId,
      identityId,
      secretHash: hash('new-secret'),
      csrfHash: hash('new-csrf'),
      expiresAt: EXPIRES,
      ip: null,
      userAgent: null,
      now: NOW,
    },
    previousSecretHash: null,
    now: NOW,
    ...overrides,
  };
}

function returningPlan(overrides: Partial<LoginPlan> = {}): LoginPlan {
  return plan({
    userId: USER_X,
    createUser: false,
    identityId: IDENTITY_X,
    email: 'x@example.test',
    displayName: null,
    ...overrides,
  });
}

/** Runs `barrier` after the plan is fixed and before the login batch reaches the database. */
function gated(barrier: () => Promise<void>): ScalarSqlExecutor {
  return {
    driver: executor.driver,
    all: <R>(statement: ScalarStatement) => executor.all<R>(statement),
    batch: async (statements: readonly ScalarStatement[]) => {
      await barrier();
      return executor.batch(statements);
    },
  };
}

async function committedUnlink(): Promise<void> {
  await executor.batch([
    block(a),
    stmt('DELETE FROM session WHERE org_id = ? AND identity_id = ?', a.orgId, IDENTITY_X),
    stmt(
      'DELETE FROM user_group WHERE org_id = ? AND user_id = ? AND provider = ?',
      a.orgId,
      USER_X,
      PROVIDER,
    ),
    stmt('DELETE FROM identity WHERE org_id = ? AND id = ?', a.orgId, IDENTITY_X),
  ]);
}

describe('login refuses a blocked provider subject', () => {
  it('creates no user, identity, group or session on the new-user path', async () => {
    await executor.batch([binding(a), block(a)]);
    const before = await snapshot();

    const result = await createLoginWriter(executor).commit(a, plan());

    expect(result).toBe('refused');
    expect(await snapshot()).toEqual(before);
  });

  it('does not pin the provider binding for a blocked subject', async () => {
    await executor.batch([block(a)]);

    const result = await createLoginWriter(executor).commit(a, plan());

    expect(result).toBe('refused');
    expect(await count('identity_provider_binding')).toBe(0);
  });

  it('still pins the provider binding for a subject that is not blocked', async () => {
    await executor.batch([block(a, { subject: 'sub-2' })]);

    const result = await createLoginWriter(executor).commit(a, plan());

    expect(result).toBe('created');
    expect(await count('identity_provider_binding', 'anchor = ?', ANCHOR)).toBe(1);
  });

  it('creates no user on the invitation path either', async () => {
    await executor.batch([
      binding(a),
      block(a),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'viewer', 'Viewer', 'organization')",
        ROLE,
        a.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, role_id, scope) VALUES (?, ?, 'email', 'ada@example.test', ?, 'organization')",
        GRANT,
        a.orgId,
        ROLE,
      ),
    ]);
    expect(await count('access_grant', 'subject_value = ?', 'ada@example.test')).toBe(1);
    const before = await snapshot();

    const result = await createLoginWriter(executor).commit(a, plan({ autoJoin: false }));

    expect(result).toBe('refused');
    expect(await snapshot()).toEqual(before);
  });

  it('does not link a blocked subject to an existing user', async () => {
    await seedReturning();
    await executor.batch([
      stmt('DELETE FROM session WHERE id = ?', SESSION_OLD),
      stmt('DELETE FROM identity WHERE id = ?', IDENTITY_X),
      block(a),
    ]);
    const before = await snapshot();

    const result = await createLoginWriter(executor).commit(
      a,
      returningPlan({ identityId: IDENTITY_NEW }),
    );

    expect(result).toBe('refused');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a returning login whose subject is blocked without touching the user', async () => {
    await seedReturning();
    await executor.batch([block(a)]);
    const before = await snapshot();

    const result = await createLoginWriter(executor).commit(a, returningPlan());

    expect(result).toBe('refused');
    expect(await snapshot()).toEqual(before);
  });
});

describe('login racing an unlink', () => {
  it('cannot recreate the unlinked identity when unlink commits after the plan', async () => {
    await seedReturning();
    const writer = createLoginWriter(gated(committedUnlink));

    const result = await writer.commit(a, returningPlan());

    expect(result).toBe('refused');
    expect(await count('identity')).toBe(0);
    expect(await count('session')).toBe(0);
    expect(await count('user_group')).toBe(0);
    const users = await executor.all<{ last_login_at: string }>({
      sql: 'SELECT last_login_at FROM user_account WHERE id = ?',
      params: [USER_X],
    });
    expect(users).toEqual([{ last_login_at: OLD }]);
  });

  it('cannot relink the old subject through the existing-user link path', async () => {
    await seedReturning();
    const writer = createLoginWriter(gated(committedUnlink));

    const result = await writer.commit(a, returningPlan({ identityId: IDENTITY_NEW }));

    expect(result).toBe('refused');
    expect(await count('identity')).toBe(0);
    expect(await count('session')).toBe(0);
  });

  it('cannot create a user when the block lands after a new-user plan', async () => {
    await executor.batch([binding(a)]);
    const writer = createLoginWriter(
      gated(async () => {
        await executor.batch([block(a)]);
      }),
    );

    const result = await writer.commit(a, plan());

    expect(result).toBe('refused');
    expect(await count('user_account', 'id = ?', USER_NEW)).toBe(0);
    expect(await count('identity')).toBe(0);
    expect(await count('session')).toBe(0);
    expect(await count('user_group')).toBe(0);
  });
});

describe('a block on another key leaves login alone', () => {
  const cases: [string, () => Statement][] = [
    ['another subject', () => block(a, { subject: 'sub-2' })],
    ['another issuer', () => block(a, { issuer: OTHER_ANCHOR })],
    ['another provider', () => block(a, { provider: OTHER_PROVIDER })],
    ['another organization', () => block(b)],
  ];

  it.each(cases)('logs in a new user despite a block on %s', async (_label, other) => {
    await executor.batch([binding(a), other()]);

    const result = await createLoginWriter(executor).commit(a, plan());

    expect(result).toBe('created');
    expect(await count('identity')).toBe(1);
    expect(await count('session')).toBe(1);
  });

  it.each(cases)('logs in a returning user despite a block on %s', async (_label, other) => {
    await seedReturning();
    await executor.batch([other()]);

    const result = await createLoginWriter(executor).commit(a, returningPlan());

    expect(result).toBe('created');
    expect(await count('session')).toBe(2);
  });
});
